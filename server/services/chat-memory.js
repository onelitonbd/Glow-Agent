import { identifier } from '../lib/validate.js';

// Reading back past sessions. Two small tools — search and page — deliberately shaped so the
// model can consult old conversations without dragging them wholesale into the context window:
// search returns tiny snippets, and the reader pages a few messages at a time with hard caps,
// mirroring how read_file pages large files.
//
// Every failure returns `{ error }` (a tool result), never a throw, just like the other
// tool-facing services.

const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 10;
const SEARCH_SCAN_ROWS = 800;
const SEARCH_MAX_TERMS = 6;
const SNIPPET_CONTEXT = 80;
const SNIPPETS_PER_CHAT = 2;
const PAGE_DEFAULT_LIMIT = 10;
const PAGE_MAX_LIMIT = 30;
const MSG_DEFAULT_CHARS = 2_000;
const MSG_MAX_CHARS = 8_000;
// No single read may exceed this, no matter the requested page size or message lengths.
const TOTAL_CAP = 24_000;

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

// Search terms: lowercase alnum-ish words of at least two characters, capped, so a typo-ridden
// or very long query still behaves predictably.
function searchTerms(query) {
  if (typeof query !== 'string' || !query.trim()) return [];
  return query
    .toLowerCase()
    .split(/[\s,.;:!?]+/u)
    .filter((word) => word.length >= 2)
    .slice(0, SEARCH_MAX_TERMS);
}

const escapeLike = (text) => `%${text.replace(/[%_\\]/g, '\\$&')}%`;

// A short, whitespace-collapsed window of text centred on the first matching term.
function snippetFor(content, terms) {
  const flat = String(content).replace(/\s+/gu, ' ').trim();
  const lower = flat.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (hit === -1 || index < hit)) hit = index;
  }
  if (hit === -1) return flat.slice(0, SNIPPET_CONTEXT * 2) + (flat.length > SNIPPET_CONTEXT * 2 ? '…' : '');
  const start = Math.max(0, hit - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, hit + SNIPPET_CONTEXT);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export function searchConversations(db, query, { limit } = {}) {
  const terms = searchTerms(query);
  if (terms.length === 0) return { error: 'Provide a keyword to search for (a word of at least two letters).' };
  const cap = clampInteger(limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const termWhere = (column) => terms.map(() => `LOWER(${column}) LIKE ? ESCAPE '\\'`).join(' OR ');
  // Title hits first: if the user named the chat, that's the strongest signal.
  const conversationsById = new Map(
    db.prepare('SELECT id, title, updated_at FROM conversations').all().map((row) => [row.id, row])
  );
  const counts = new Map();
  const titleHits = new Set();
  const likeArgs = terms.map(escapeLike);
  for (const row of db.prepare(`SELECT id FROM conversations WHERE ${termWhere('title')} LIMIT 200`).all(...likeArgs)) {
    if (conversationsById.has(row.id)) titleHits.add(row.id);
  }
  const snippetsById = new Map();
  const rows = db.prepare(
    `SELECT conversation_id, content FROM messages WHERE ${termWhere('content')} LIMIT ?`
  ).all(...likeArgs, SEARCH_SCAN_ROWS);
  for (const row of rows) {
    const conversation = conversationsById.get(row.conversation_id);
    if (!conversation) continue;
    counts.set(row.conversation_id, (counts.get(row.conversation_id) || 0) + 1);
    const snippets = snippetsById.get(row.conversation_id) || [];
    if (snippets.length < SNIPPETS_PER_CHAT) {
      const snippet = snippetFor(row.content, terms);
      if (!snippets.includes(snippet)) snippets.push(snippet);
    }
    snippetsById.set(row.conversation_id, snippets);
  }
  const ranked = [...new Set([...titleHits, ...snippetsById.keys()])].sort((a, b) => {
    const titleA = titleHits.has(a) ? 1 : 0;
    const titleB = titleHits.has(b) ? 1 : 0;
    if (titleA !== titleB) return titleB - titleA;
    const countA = counts.get(a) || 0;
    const countB = counts.get(b) || 0;
    if (countA !== countB) return countB - countA;
    return String(conversationsById.get(b).updated_at).localeCompare(String(conversationsById.get(a).updated_at));
  }).slice(0, cap);
  return {
    query: String(query).slice(0, 200),
    matchCount: ranked.length,
    searchedMessages: rows.length,
    truncated: rows.length >= SEARCH_SCAN_ROWS,
    matches: ranked.map((id) => ({
      conversationId: id,
      title: conversationsById.get(id).title,
      updatedAt: conversationsById.get(id).updated_at,
      titleMatch: titleHits.has(id),
      snippets: snippetsById.get(id) || []
    }))
  };
}

export function readConversation(db, rawConversationId, { offset, limit, maxChars } = {}) {
  let conversationId;
  try {
    conversationId = identifier(rawConversationId, 'Conversation ID');
  } catch {
    return { error: 'Provide a valid conversationId (copy it from a search_conversations result).' };
  }
  const conversation = db.prepare('SELECT id, title FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) return { error: 'Conversation not found. Use search_conversations first to locate its id.' };
  const messageCount = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(conversationId).count;
  const start = clampInteger(offset, 0, 0, Math.max(0, messageCount));
  const cap = clampInteger(limit, PAGE_DEFAULT_LIMIT, 1, PAGE_MAX_LIMIT);
  const perMessageCap = clampInteger(maxChars, MSG_DEFAULT_CHARS, 200, MSG_MAX_CHARS);
  const rows = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?'
  ).all(conversationId, cap, start);
  const messages = [];
  let total = 0;
  let truncatedByCap = false;
  for (const [index, row] of rows.entries()) {
    const full = String(row.content);
    const clipped = full.length > perMessageCap ? `${full.slice(0, perMessageCap)}… [truncated: ${perMessageCap} of ${full.length} characters shown]` : full;
    if (total + clipped.length > TOTAL_CAP) { truncatedByCap = true; break; }
    total += clipped.length;
    messages.push({ index: start + index, role: row.role, createdAt: row.created_at, content: clipped, ...(full.length > perMessageCap ? { truncated: true } : {}) });
  }
  const nextOffset = start + messages.length;
  return {
    conversationId,
    title: conversation.title,
    messageCount,
    offset: start,
    returned: messages.length,
    hasMore: nextOffset < messageCount,
    nextOffset,
    ...(truncatedByCap ? { truncated: true } : {}),
    messages
  };
}
