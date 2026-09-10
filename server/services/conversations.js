import { randomUUID } from 'node:crypto';
import { notFound, validation, AppError } from '../lib/errors.js';
import { identifier, modelId, requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';
import { providerCredentials, providerFetch, upstreamUrl } from './providers.js';
import { executeToolCall, listTools, openAiToolDefinitions, readSkillTool } from './tools.js';
import { listSkills } from './skills.js';
import { githubToolDefinitions } from './github-tools.js';
import { activeMcpPlugins, clearWriteApproval, cloneGithubRepo, createMcpToolContext } from './plugins.js';
import { getSettings } from './settings.js';
import { THINKING_LEVELS, modelCapabilities } from './model-tests.js';

function toConversation(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0)
  };
}

function parseJsonArray(value, fallback) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoning: row.reasoning || '',
    toolEvents: parseJsonArray(row.tool_events, []),
    timeline: parseJsonArray(row.timeline, null),
    attachments: parseJsonArray(row.attachments, []),
    createdAt: row.created_at
  };
}

export function listConversations(db) {
  return db.prepare(`
    SELECT c.*, COUNT(m.id) AS message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
    LIMIT 50
  `).all().map(toConversation);
}

export function createConversation(db, body = {}) {
  const title = body.title === undefined || body.title === ''
    ? 'New conversation'
    : requiredString(body.title, 'Conversation title', { max: 120 });
  const id = randomUUID();
  const timestamp = now();
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title, timestamp, timestamp);
  return toConversation({ id, title, created_at: timestamp, updated_at: timestamp, message_count: 0 });
}

function existingConversation(db, rawConversationId) {
  const conversationId = identifier(rawConversationId, 'Conversation ID');
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!row) throw notFound('Conversation');
  return row;
}

export function getConversation(db, rawConversationId) {
  const conversation = existingConversation(db, rawConversationId);
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation.id).map(toMessage);
  return { ...toConversation(conversation), messages };
}

function systemMessage(skills, { plugin = null, mcp = null, customPrompt = '' } = {}) {
  const servers = mcp?.servers || [];
  const failures = mcp?.failures || [];
  const mcpGuide = servers.length
    ? [
      servers.length === 1
        ? 'An MCP (Model Context Protocol) server is connected and its tools are available to you with an \`mcp_\` prefix. Inspect first with read-only tools, then make changes with the tools that need them.'
        : `MCP (Model Context Protocol) servers are connected and their tools are available to you with an \`mcp_\` prefix. Inspect first with read-only tools, then make changes with the tools that need them.`,
      ...servers.map((server) => [
        // The key is the namespace the model sees in every tool id for this server, so naming it
        // here is what lets the model tell two servers of the same kind apart.
        `\n${server.key} — ${server.pluginName}, running "${server.serverName}"${server.version ? ` ${server.version}` : ''}: ${server.toolCount} tools${server.readOnly ? ' (read-only: no tool here can change data)' : ''}.`,
        server.selectedRepo ? `Work on the repository ${server.selectedRepo} unless the user names a different one.` : '',
        server.writesApproved
          ? 'The user has approved writes for this server in this message, so its tools that change data will run.'
          : 'Its tools that change data are blocked until the user approves them. If one is blocked, explain what you were about to do, ask the user to approve writes for that plugin, and stop — never retry a blocked tool and never claim the change happened.',
        server.instructions ? `The server says: ${server.instructions}` : ''
      ].filter(Boolean).join(' ')),
      "\nTool results are the server's own output. Report what they actually say; do not invent file contents, ids, or links."
    ].join('')
    : null;
  const mcpFailure = failures.length
    ? failures.map((failure) => `The MCP plugin "${failure.serverName}" is enabled but its server could not be reached (${failure.error}). Tell the user that plugin is unavailable instead of pretending its tools ran. Do not retry the connection yourself.`).join(' ')
    : null;
  return [
    'Format every answer as clear GitHub-flavored Markdown. Use concise headings, lists, emphasis, tables, and block quotes only when they improve readability. Put code in fenced blocks with a language tag and write mathematical notation as inline `$...$` or display `$$...$$` LaTeX. Never send raw HTML. Do not mention these formatting instructions unless asked.',
    ...(skills.length ? [
      'The following reusable skills are available for relevant tasks. The list gives each skill\'s id, name, and short description. To follow a skill, call the read_skill tool with its id to load the full instructions, then apply them to the user request. Do not mention these instructions unless asked.',
      skills.map((skill) => `- ${skill.id}: ${skill.name} — ${skill.description}`).join('\n')
    ] : []),
    // The MCP block stands on its own: the local clone below is an optional extra, so the model
    // must still be told about the server's tools when no clone is configured.
    ...(mcpFailure ? [mcpFailure] : []),
    ...(mcpGuide ? [mcpGuide] : []),
    ...(plugin ? [
      'A local clone of the selected repository is also available in the workspace. Use github_list_files / github_read_file to inspect it, github_write_file to edit or create files, github_rename_file and github_delete_file to move or remove files, then github_commit to stage and commit locally. Push to GitHub with github_push, but note that pushing always requires the user to confirm first — if push is blocked for confirmation, tell the user and stop rather than retrying. Although the plugin may not be cloned yet, call github_clone first if you need to refresh it. Prefer the MCP tools for GitHub itself and use the clone for bulk file work.'
    ] : []),
    // The user's own standing instructions go last, so they are the last thing the model reads.
    ...(customPrompt ? [
      `The user has set these standing instructions for every reply in this workspace. Follow them in addition to everything above:\n${customPrompt}`
    ] : [])
  ].join('\n');
}

function skillResolver(db) {
  return (skillId) => {
    if (typeof skillId !== 'string' || !skillId) return null;
    const row = db.prepare('SELECT id, name, description, instructions FROM skills WHERE id = ?').get(skillId);
    return row || null;
  };
}

function normalizeAssistantContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
  }
  return '';
}

// A question that carried an attachment has to go back to the provider as content parts, exactly
// as it was first sent — a plain string would drop the image the model was asked about.
function toProviderContent(row) {
  const attachments = parseJsonArray(row.attachments, []);
  if (attachments.length === 0) return row.content;
  return [
    ...(row.content ? [{ type: 'text', text: row.content }] : []),
    ...attachments.map(attachmentPart)
  ];
}

function attachmentPart(attachment) {
  return attachment.kind === 'image'
    ? { type: 'image_url', image_url: { url: attachment.dataUrl } }
    : { type: 'file', file: { filename: attachment.name, file_data: attachment.dataUrl } };
}

function conversationMessages(db, conversationId) {
  return db.prepare(`
    SELECT role, content, attachments FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(conversationId).reverse().map((row) => ({ role: row.role, content: toProviderContent(row) }));
}

function persistMessage(db, { conversationId, role, content, providerId = null, selectedModelId = null, reasoning = '', toolEvents = [], timeline = null, attachments = [] }) {
  const id = randomUUID();
  const createdAt = now();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, provider_id, model_id, created_at, tool_events, reasoning, timeline, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, role, content, providerId, selectedModelId, createdAt, toolEvents.length ? JSON.stringify(toolEvents) : null, reasoning || null, timeline && timeline.length ? JSON.stringify(timeline) : null, attachments.length ? JSON.stringify(attachments) : null);
  return { id, role, content, providerId, modelId: selectedModelId, reasoning, toolEvents, timeline: timeline || null, attachments, createdAt };
}

// The rows behind a conversation in display order. `rowid` breaks ties when two messages land in
// the same millisecond, which is what makes "everything after this message" unambiguous.
function messageRows(db, conversationId) {
  return db.prepare('SELECT rowid, * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(conversationId);
}

function existingMessage(db, rawConversationId, rawMessageId) {
  const conversation = existingConversation(db, rawConversationId);
  const messageId = identifier(rawMessageId, 'Message ID');
  const message = db.prepare('SELECT rowid, * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversation.id);
  if (!message) throw notFound('Message');
  return { conversation, message };
}

function dropMessagesAfter(db, conversationId, message) {
  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
  `).run(conversationId, message.created_at, message.created_at, message.rowid);
}

function touchConversation(db, conversationId) {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), conversationId);
}

// Deleting a reply takes the question that produced it with it, so the log never keeps a question
// nobody answered. `withQuestion: false` keeps the question (used by Regenerate, which re-answers
// it instead).
export function deleteMessage(db, rawConversationId, rawMessageId, body = {}) {
  const { conversation, message } = existingMessage(db, rawConversationId, rawMessageId);
  let question = null;
  if (body.withQuestion !== false && message.role === 'assistant') {
    question = db.prepare(`
      SELECT id FROM messages
      WHERE conversation_id = ? AND role = 'user' AND (created_at < ? OR (created_at = ? AND rowid < ?))
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(conversation.id, message.created_at, message.created_at, message.rowid);
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  if (question) db.prepare('DELETE FROM messages WHERE id = ?').run(question.id);
  touchConversation(db, conversation.id);
  return getConversation(db, conversation.id);
}

// Correcting a question also drops the answer it produced; the caller re-answers the edited text.
export function editMessage(db, rawConversationId, rawMessageId, body = {}) {
  const { conversation, message } = existingMessage(db, rawConversationId, rawMessageId);
  if (message.role !== 'user') throw validation('Only your own messages can be edited.');
  const content = requiredString(body.content, 'Message', { max: 16_000 });
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, message.id);
  dropMessagesAfter(db, conversation.id, message);
  touchConversation(db, conversation.id);
  return getConversation(db, conversation.id);
}

// ---- Attachments ----
// The composer offers an image or a document only when the capability probe says this model takes
// one, so the check here is a backstop for a hand-built request rather than the main gate. An
// untested model is allowed through: no evidence yet is not a rejection.
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const DATA_URL = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu;

function parseDataUrl(value) {
  const match = typeof value === 'string' ? DATA_URL.exec(value.trim()) : null;
  if (!match) return null;
  const base64 = match[2].replace(/\s+/gu, '');
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  return { mimeType: match[1].toLowerCase(), base64, bytes, dataUrl: `data:${match[1].toLowerCase()};base64,${base64}` };
}

function attachmentKind(mimeType) {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

export function parseAttachments(db, body, { providerId, selectedModelId }) {
  const raw = body.attachments;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw validation('Attachments must be a list.');
  if (raw.length === 0) return [];
  if (raw.length > MAX_ATTACHMENTS) throw validation(`At most ${MAX_ATTACHMENTS} attachments per message.`);
  const capabilities = modelCapabilities(db, providerId, selectedModelId);
  const counts = { image: 0, file: 0 };
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw validation(`Attachment ${index + 1} is not readable.`);
    const parsed = parseDataUrl(entry.dataUrl);
    if (!parsed) throw validation(`Attachment ${index + 1} must be a base64 data URL.`);
    if (parsed.bytes === 0) throw validation(`Attachment ${index + 1} is empty.`);
    if (parsed.bytes > MAX_ATTACHMENT_BYTES) {
      throw validation(`Attachment ${index + 1} is ${Math.round(parsed.bytes / 1024 / 1024)} MB. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    }
    const kind = attachmentKind(parsed.mimeType);
    counts[kind] += 1;
    // A proved rejection is the only thing that blocks: `works` and `accepted` both mean the
    // provider took this part before, and an untested model has not been given the chance.
    const verdict = kind === 'image' ? capabilities.images : capabilities.files;
    if (capabilities.tested && !verdict.usable) {
      throw validation(`${selectedModelId} does not accept ${kind === 'image' ? 'images' : 'file attachments'} — the capability test was refused. Pick another model or send it as text.`);
    }
    const name = String(entry.name ?? '').trim().slice(0, 180) || (kind === 'image' ? `image-${index + 1}` : `file-${index + 1}`);
    return {
      kind,
      name,
      mimeType: parsed.mimeType,
      size: parsed.bytes,
      dataUrl: parsed.dataUrl
    };
  });
}

async function prepareResponse(db, rawConversationId, body, { workspaceDirectory, existingUserMessage = null } = {}) {
  const conversation = existingConversation(db, rawConversationId);
  const content = requiredString(body.message, 'Message', { max: 16_000 });
  const providerId = identifier(body.providerId, 'Provider ID');
  const selectedModelId = modelId(body.modelId);
  const selected = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, selectedModelId);
  if (!selected) throw validation('Select this model for the provider before starting a chat.');
  // Optional thinking level. It is sent as `reasoning_effort`; a model that ignores the parameter
  // simply answers as usual, which is why an untested level is allowed rather than blocked.
  const thinkingLevel = body.thinkingLevel === undefined || body.thinkingLevel === null || body.thinkingLevel === ''
    ? null
    : String(body.thinkingLevel);
  const thinkingRung = thinkingLevel ? THINKING_LEVELS.find((level) => level.id === thinkingLevel) : null;
  if (thinkingLevel && !thinkingRung) throw validation('That thinking level is not one this workspace offers.');
  // Attachments travel with the question. A regenerate re-sends the stored question, so it keeps
  // the files that were already saved with it instead of taking new ones from the body.
  const attachments = existingUserMessage
    ? parseJsonArray(existingUserMessage.attachments, [])
    : parseAttachments(db, body, { providerId, selectedModelId });
  const skills = listSkills(db);
  // Every available built-in tool is always offered to the model; no selection is needed.
  // read_skill is added only when skills exist so the model can load instructions on demand.
  const tools = skills.length ? [...listTools(), readSkillTool()] : listTools();
  // A connected, enabled GitHub plugin with a selected repo exposes GitHub tools and a repo
  // workspace. The model can list/clone/read/edit/commit files and (on confirmation) push.
  const plugin = activeGithubPlugin(db, body.pluginId, workspaceDirectory);
  if (plugin) {
    tools.push(...githubToolDefinitions());
  }
  // An enabled MCP plugin opens one live session per request; that server's tools/list result
  // becomes part of the model's tool set for this message.
  const mcp = await openMcpContexts(db);
  if (mcp?.definitions?.length) {
    tools.push(...mcp.definitions);
  }
  // Regenerate/Edit re-answer a message that is already stored, so no new user row is written.
  const userMessage = existingUserMessage
    ? {
      id: existingUserMessage.id,
      role: 'user',
      content,
      providerId,
      modelId: selectedModelId,
      reasoning: '',
      toolEvents: [],
      timeline: null,
      createdAt: existingUserMessage.created_at
    }
    : persistMessage(db, { conversationId: conversation.id, role: 'user', content, providerId, selectedModelId, attachments });
  const messages = conversationMessages(db, conversation.id);
  const system = systemMessage(skills, { plugin, mcp, customPrompt: getSettings(db).systemPrompt.text });
  if (system) messages.unshift({ role: 'system', content: system });
  // Only the first question of a chat names it. Counting the other questions (rather than the
  // rows) means a regenerate of that first question can still write the title.
  const otherQuestions = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'user' AND id <> ?`)
    .get(conversation.id, userMessage.id).count;
  return {
    conversation, content, providerId, selectedModelId, tools, plugin, mcp, userMessage, messages,
    attachments,
    capabilities: modelCapabilities(db, providerId, selectedModelId),
    isFirstExchange: otherQuestions === 0,
    reasoningEffort: thinkingRung ? thinkingRung.value : null,
    thinkingLabel: thinkingRung ? thinkingRung.label : null
  };
}

// The local clone is now optional: MCP tools work on GitHub directly, so this only returns a
// context when the plugin turns "Local clone" on. `needsClone` marks the first message.
function activeGithubPlugin(db, rawPluginId, workspaceDirectory) {
  if (!rawPluginId) return null;
  const pluginId = String(rawPluginId);
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row || row.type !== 'mcp' || !Number(row.enabled)) return null;
  const config = (() => { try { return JSON.parse(row.config) || {}; } catch { return {}; } })();
  if (config.github?.localClone !== true || !config.selectedRepo) return null;
  return { pluginId, needsClone: !config.cloned, workspaceDirectory };
}

// Opens one MCP session per enabled plugin and merges their tools into a single tool set and a
// single name map. A server that cannot be reached must not block the message: the failure is
// recorded so the system prompt tells the model to say so.
async function openMcpContexts(db) {
  const active = activeMcpPlugins(db);
  // A key is reserved in stored order, whether or not that server connects, so the tool ids the
  // model sees stay stable across messages. Duplicates only appear when the same preset is
  // installed twice, which keeps the common case a plain `mcp_github_...`.
  const totals = new Map();
  for (const entry of active) totals.set(entry.key, (totals.get(entry.key) || 0) + 1);
  const seen = new Map();
  for (const entry of active) {
    const count = totals.get(entry.key) || 1;
    const used = seen.get(entry.key) || 0;
    seen.set(entry.key, used + 1);
    entry.serverKey = count > 1 ? `${entry.key}-${used + 1}` : entry.key;
  }
  const contexts = [];
  const failures = [];
  for (const entry of active) {
    try {
      contexts.push(await createMcpToolContext(db, entry.pluginId, { serverKey: entry.serverKey }));
    } catch (error) {
      failures.push({
        pluginId: entry.pluginId,
        serverName: String(entry.config.serverName || entry.name || 'mcp'),
        error: String(error?.message || 'The MCP server could not be reached.')
      });
    }
  }
  if (contexts.length === 0 && failures.length === 0) return null;
  const byName = new Map();
  const definitions = [];
  for (const context of contexts) {
    for (const [id, entry] of context.byName) byName.set(id, entry);
    definitions.push(...context.definitions);
  }
  return {
    byName,
    definitions,
    contexts,
    failures,
    servers: contexts.map((context) => ({
      key: context.serverKey,
      pluginName: context.name,
      serverName: context.serverName,
      version: context.config.serverVersion || '',
      toolCount: context.definitions.length,
      selectedRepo: context.selectedRepo,
      writesApproved: context.writesApproved,
      readOnly: context.readOnly,
      instructions: context.serverInstructions
    }))
  };
}

// Every MCP session is torn down when the request ends, and each one-shot write approval is
// consumed so the next message has to be approved again.
async function closeMcpContexts(db, mcp) {
  if (!mcp) return;
  for (const context of mcp.contexts || []) {
    await context.dispose();
    clearWriteApproval(db, context.pluginId);
  }
  for (const failure of mcp.failures || []) clearWriteApproval(db, failure.pluginId);
}

// Clones the selected repo into the local workspace the first time a message is sent with the
// plugin enabled. After a successful clone the plugin's `cloned` flag is set so it is not
// re-cloned on every message; subsequent messages re-use (and auto-refresh) the local copy on
// demand (see the github tools). If clone fails we still let the model work; the clone tool
// remains available to retry.
async function ensureRepositoryCloned(db, plugin, workspaceDirectory) {
  if (plugin.needsClone && workspaceDirectory) {
    try {
      await cloneGithubRepo(db, plugin.pluginId, workspaceDirectory);
    } catch {
      // Cloning may fail offline or without a token; the model can retry via github_clone.
    }
  }
}

async function providerCompletion(provider, credentials, selectedModelId, messages, tools, timeoutMs, reasoningEffort = null) {
  let response;
  try {
    response = await providerFetch(upstreamUrl(provider.baseUrl, '/chat/completions'), credentials, {
      method: 'POST',
      timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModelId,
        messages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(tools.length ? { tools: openAiToolDefinitions(tools), tool_choice: 'auto' } : {})
      })
    });
  } catch (error) {
    throw new AppError(502, 'PROVIDER_UNAVAILABLE', error.message, { expose: true });
  }
  if (!response?.ok) {
    const status = response?.status ? ` (HTTP ${response.status})` : '';
    throw new AppError(502, 'PROVIDER_RESPONSE_ERROR', `The provider could not complete this request${status}.`, { expose: true });
  }
  return response;
}

async function providerCompletionWithRetry({ provider, credentials, selectedModelId, messages, tools, timeoutMs, maxRetries, reasoningEffort = null }) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await providerCompletion(provider, credentials, selectedModelId, messages, tools, timeoutMs, reasoningEffort);
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * (attempt + 1), 2_500)));
      attempt += 1;
    }
  }
  throw failureError('PROVIDER_RETRY_EXHAUSTED', 'The provider could not be reached after repeated attempts.');
}

// A one-line, safe-for-the-UI reason for a failed provider call.
function shortStatus(error) {
  return String(error?.message || 'connection failed').replace(/\s+/gu, ' ').trim().slice(0, 120);
}

// The prompt that names a chat. The model sees both sides of the first exchange, so the title can
// describe what the conversation is actually about instead of just echoing the question.
const TITLE_SYSTEM_PROMPT = [
  'You name chat conversations.',
  'Read the first exchange below and write one title of 8 to 10 words that says what the conversation is about.',
  'Reply with the title only: no quotes, no leading or trailing punctuation, no explanation, no line breaks.'
].join(' ');

// Models wrap titles in quotes and end them with a full stop even when told not to; both are
// stripped so the saved title reads like a title.
function normalizeTitle(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/gu, '')
    .replace(/\.$/u, '')
    .trim();
  return text ? text.slice(0, 120) : null;
}

// Asks the configured model for a title. A title is cosmetic, so any failure falls back to the
// first words of the question — it must never cost the user their answer.
async function generateConversationTitle(db, context, assistantContent, { emit, fetchTimeoutMs } = {}) {
  if (!context.isFirstExchange) return null;
  const settings = getSettings(db).titleGeneration;
  if (!settings.enabled || !settings.providerId || !settings.modelId) return null;
  emit?.('status', { tone: 'info', text: `Naming this chat with ${settings.modelId}…` });
  try {
    const { provider, credentials } = providerCredentials(db, settings.providerId);
    const response = await providerFetch(upstreamUrl(provider.baseUrl, '/chat/completions'), credentials, {
      method: 'POST',
      timeoutMs: Math.min(fetchTimeoutMs || 15_000, 20_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.modelId,
        temperature: 0.3,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: `User asked:\n${context.content.slice(0, 4_000)}\n\nAssistant answered:\n${String(assistantContent).slice(0, 4_000)}` }
        ]
      })
    });
    if (!response?.ok) return null;
    const payload = await response.json();
    const title = normalizeTitle(payload?.choices?.[0]?.message?.content);
    if (title) emit?.('status', { tone: 'info', text: `Chat named “${title}”.` });
    return title;
  } catch {
    return null;
  }
}

async function finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline = null, { emit, fetchTimeoutMs } = {}) {
  if (!assistantContent) {
    throw new AppError(502, 'PROVIDER_EMPTY_RESPONSE', 'The provider did not return a final chat response after tool use.', { expose: true });
  }
  const assistantMessage = persistMessage(db, {
    conversationId: context.conversation.id,
    role: 'assistant',
    content: assistantContent,
    providerId: context.providerId,
    selectedModelId: context.selectedModelId,
    reasoning,
    toolEvents,
    timeline
  });
  const generated = await generateConversationTitle(db, context, assistantContent, { emit, fetchTimeoutMs });
  const title = generated || (context.conversation.title === 'New conversation' ? context.content.slice(0, 72) : context.conversation.title);
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), context.conversation.id);
  return { conversation: getConversation(db, context.conversation.id), userMessage: context.userMessage, assistantMessage };
}

function collectToolCalls(target, delta) {
  if (!Array.isArray(delta?.tool_calls)) return;
  for (const partial of delta.tool_calls) {
    const index = Number.isInteger(partial.index) ? partial.index : target.length;
    target[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
    const call = target[index];
    if (typeof partial.id === 'string') call.id += partial.id;
    if (typeof partial.type === 'string') call.type = partial.type;
    if (typeof partial.function?.name === 'string') call.function.name += partial.function.name;
    if (typeof partial.function?.arguments === 'string') call.function.arguments += partial.function.arguments;
  }
}

function streamedReasoning(delta) {
  for (const value of [delta?.reasoning_content, delta?.reasoning, delta?.analysis_content]) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  }
  return '';
}

async function* upstreamSsePayloads(response) {
  if (!response.body) throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'The provider did not return a streaming response.', { expose: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = function* (final = false) {
    const normalized = buffer.replace(/\r\n/gu, '\n');
    const boundaries = normalized.split('\n\n');
    buffer = final ? '' : boundaries.pop();
    for (const block of boundaries) {
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* flush();
    }
    buffer += decoder.decode();
    yield* flush(true);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'PROVIDER_STREAM_INTERRUPTED', 'The provider streaming response was interrupted.', { expose: true });
  } finally {
    reader.releaseLock();
  }
}

function failureError(code, message) {
  return new AppError(502, code, message, { expose: true });
}

// Throws an AppError while carrying any content produced so far so a mid-stream interruption
// can be resumed instead of being thrown away and treated as a brand-new request.
function streamFailure(shift, code, message) {
  const error = failureError(code, message);
  error.partial = shift();
  throw error;
}

// A provider round is allowed to be retried. On a retry after a partial stream, the partial
// assistant text is pushed back into the conversation so the model continues from where it
// stopped instead of restarting. Incomplete tool calls are not resumed (they are regenerated).
async function streamProviderRoundWithRetry({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, maxRetries, reasoningEffort = null }) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    emit('status', { tone: 'info', text: attempt === 0 ? 'Waiting for the model…' : `Waiting for the model — attempt ${attempt + 1}…` });
    try {
      return await streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, reasoningEffort });
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const partial = error.partial;
      if (partial?.content) {
        messages.push({ role: 'assistant', content: partial.content });
        messages.push({ role: 'user', content: 'Continue your previous response exactly from where it stopped. Do not repeat any text you already wrote; continue with the next part of your answer.' });
      }
      emit('status', { tone: 'warn', text: `The model failed (${shortStatus(error)}). Retrying ${attempt + 1} of ${maxRetries}…` });
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * (attempt + 1), 2_500)));
      attempt += 1;
    }
  }
  throw failureError('PROVIDER_RETRY_EXHAUSTED', 'The provider could not be reached after repeated attempts.');
}

async function streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, reasoningEffort = null }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const shift = () => ({ content, reasoning, toolCalls: toolCalls.filter((call) => call.function.name) });
  const timedOut = () => streamFailure(shift, 'PROVIDER_TIMEOUT', 'The provider streaming request timed out.');
  try {
    let response;
    try {
      response = await providerFetch(upstreamUrl(provider.baseUrl, '/chat/completions'), credentials, {
        method: 'POST',
        timeoutMs,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModelId,
          messages,
          stream: true,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(tools.length ? { tools: openAiToolDefinitions(tools), tool_choice: 'auto' } : {})
        })
      });
    } catch (error) {
      if (controller.signal.aborted) throw timedOut();
      throw streamFailure(shift, 'PROVIDER_UNAVAILABLE', error.message);
    }
    if (!response?.ok) {
      const status = response?.status ? ` (HTTP ${response.status})` : '';
      throw streamFailure(shift, 'PROVIDER_RESPONSE_ERROR', `The provider could not complete this request${status}.`);
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw timedOut();
        throw streamFailure(shift, 'PROVIDER_INVALID_RESPONSE', 'The provider returned an invalid chat response.');
      }
      const message = payload?.choices?.[0]?.message;
      const finalContent = normalizeAssistantContent(message?.content);
      if (finalContent) {
        content += finalContent;
        emit('token', { text: finalContent });
      }
      return { content, reasoning: '', toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [] };
    }
    const emittedToolCalls = new Set();
    try {
      for await (const data of upstreamSsePayloads(response)) {
        if (data === '[DONE]') break;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = payload?.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          emit('token', { text: delta.content });
        }
        const reasoningChunk = streamedReasoning(delta);
        if (reasoningChunk) {
          reasoning += reasoningChunk;
          emit('thinking', { text: reasoningChunk });
        }
        collectToolCalls(toolCalls, delta);
        toolCalls.forEach((call, index) => {
          if (call.function.name && !emittedToolCalls.has(index)) {
            emittedToolCalls.add(index);
            emit('tool_call', { index, name: call.function.name });
          }
        });
      }
    } catch (error) {
      if (controller.signal.aborted) throw timedOut();
      throw streamFailure(shift, 'PROVIDER_STREAM_INTERRUPTED', 'The provider streaming response was interrupted.');
    }
    return { content, reasoning, toolCalls: toolCalls.filter((call) => call.function.name) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function respondToConversation(db, rawConversationId, body, timeoutMs, { rootDirectory, workspaceDirectory, fetchTimeoutMs, maxToolRounds = 500, maxProviderRetries = 20 } = {}) {
  const context = await prepareResponse(db, rawConversationId, body, { workspaceDirectory });
  const { provider, credentials } = providerCredentials(db, context.providerId);
  const toolEvents = [];
  const timeline = [];
  let assistantContent = '';
  let reasoning = '';
  if (context.plugin) await ensureRepositoryCloned(db, context.plugin, workspaceDirectory);
  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      const response = await providerCompletionWithRetry({ provider, credentials, selectedModelId: context.selectedModelId, messages: context.messages, tools: context.tools, timeoutMs, maxRetries: maxProviderRetries, reasoningEffort: context.reasoningEffort });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'The provider returned an invalid chat response.', { expose: true });
      }
      const providerMessage = payload?.choices?.[0]?.message;
      const toolCalls = Array.isArray(providerMessage?.tool_calls) ? providerMessage.tool_calls : [];
      if (toolCalls.length === 0) {
        assistantContent = normalizeAssistantContent(providerMessage?.content);
        const reasoningText = typeof providerMessage?.reasoning_content === 'string' ? providerMessage.reasoning_content : (typeof providerMessage?.reasoning === 'string' ? providerMessage.reasoning : '');
        if (reasoningText) timeline.push({ type: 'thinking', text: reasoningText });
        if (assistantContent) timeline.push({ type: 'content', text: assistantContent });
        break;
      }
      const reasoningText = typeof providerMessage?.reasoning_content === 'string' ? providerMessage.reasoning_content : (typeof providerMessage?.reasoning === 'string' ? providerMessage.reasoning : '');
      if (reasoningText) timeline.push({ type: 'thinking', text: reasoningText });
      if (providerMessage?.content) timeline.push({ type: 'content', text: normalizeAssistantContent(providerMessage.content) });
      context.messages.push({ role: 'assistant', content: providerMessage.content ?? null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        timeline.push({ type: 'tool_call', name: typeof call.function?.name === 'string' ? call.function.name : '' });
        const execution = await executeToolCall(call, new Set(context.tools.map((tool) => tool.id)), { getSkill: skillResolver(db), db, rootDirectory, fetchTimeoutMs, plugin: context.plugin, mcp: context.mcp });
        toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
        timeline.push({ type: 'tool_result', toolId: execution.toolId, summary: execution.summary });
        context.messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' ? call.id : randomUUID(), content: JSON.stringify(execution.result) });
      }
    }
    return await finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline, { fetchTimeoutMs });
  } finally {
    await closeMcpContexts(db, context.mcp);
  }
}

// Shared by "answer my new message" and "answer this stored message again": everything from the
// live status line through the tool rounds to persisting the reply.
async function streamConversation(db, context, timeoutMs, emit, { rootDirectory, workspaceDirectory, fetchTimeoutMs, maxToolRounds = 500, maxProviderRetries = 20 } = {}) {
  const { provider, credentials } = providerCredentials(db, context.providerId);
  for (const server of context.mcp?.servers || []) {
    emit('status', { tone: 'info', text: `MCP connected — ${server.pluginName || server.name}: ${server.toolCount} tools.` });
  }
  for (const failure of context.mcp?.failures || []) {
    emit('status', { tone: 'warn', text: `MCP unavailable — ${failure.serverName}: ${failure.error}` });
  }
  emit('started', { conversationId: context.conversation.id });
  emit('status', { tone: 'info', text: `Connecting to ${provider.name}…` });
  if (context.thinkingLabel) emit('status', { tone: 'info', text: `Thinking level: ${context.thinkingLabel}.` });
  if (context.plugin) await ensureRepositoryCloned(db, context.plugin, workspaceDirectory);
  const toolEvents = [];
  const timeline = [];
  const timelineEmit = (event, data) => {
    emit(event, data);
    if (event === 'thinking') timeline.push({ type: 'thinking', text: data.text });
    else if (event === 'token') timeline.push({ type: 'content', text: data.text });
    else if (event === 'tool_call') timeline.push({ type: 'tool_call', name: data.name });
    else if (event === 'tool_result') timeline.push({ type: 'tool_result', toolId: data.toolId, summary: data.summary });
  };
  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      const result = await streamProviderRoundWithRetry({
        provider,
        credentials,
        selectedModelId: context.selectedModelId,
        messages: context.messages,
        tools: context.tools,
        timeoutMs,
        emit: timelineEmit,
        maxRetries: maxProviderRetries,
        reasoningEffort: context.reasoningEffort
      });
      if (result.toolCalls.length === 0) break;
      context.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        const execution = await executeToolCall(call, new Set(context.tools.map((tool) => tool.id)), { getSkill: skillResolver(db), db, rootDirectory, fetchTimeoutMs, plugin: context.plugin, mcp: context.mcp });
        toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
        timelineEmit('tool_result', { toolId: execution.toolId, summary: execution.summary });
        context.messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' && call.id ? call.id : randomUUID(), content: JSON.stringify(execution.result) });
      }
    }
    // Derive the persisted content/reasoning from the emitted timeline so a resumed stream keeps
    // the partial text that was already shown live, rather than only the last retry's segment.
    const assistantContent = timeline.filter((entry) => entry.type === 'content').map((entry) => entry.text).join('');
    const reasoning = timeline.filter((entry) => entry.type === 'thinking').map((entry) => entry.text).join('');
    const result = await finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline, { emit, fetchTimeoutMs });
    emit('completed', result);
    return result;
  } finally {
    await closeMcpContexts(db, context.mcp);
  }
}

export async function respondToConversationStream(db, rawConversationId, body, timeoutMs, emit, options = {}) {
  const context = await prepareResponse(db, rawConversationId, body, { workspaceDirectory: options.workspaceDirectory });
  return streamConversation(db, context, timeoutMs, emit, options);
}

// Re-answers a stored user message — with the same model (Regenerate) or a different one (Try with
// another model). The reply it produced is removed first, so the question stays where it is and
// only the answer is replaced.
export async function regenerateMessageStream(db, rawConversationId, rawMessageId, body, timeoutMs, emit, options = {}) {
  const { conversation, message } = existingMessage(db, rawConversationId, rawMessageId);
  if (message.role !== 'user') throw validation('Choose one of your own messages to answer again.');
  dropMessagesAfter(db, conversation.id, message);
  touchConversation(db, conversation.id);
  const context = await prepareResponse(db, conversation.id, { ...body, message: message.content }, { workspaceDirectory: options.workspaceDirectory, existingUserMessage: message });
  return streamConversation(db, context, timeoutMs, emit, options);
}
