import { randomUUID } from 'node:crypto';
import { notFound, validation, AppError } from '../lib/errors.js';
import { identifier, modelId, requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';
import { providerCredentials, providerFetch, upstreamUrl } from './providers.js';
import { executeToolCall, openAiToolDefinitions, selectedTools } from './tools.js';

function toConversation(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0)
  };
}

function toMessage(row) {
  let toolEvents = [];
  try {
    toolEvents = row.tool_events ? JSON.parse(row.tool_events) : [];
  } catch {
    toolEvents = [];
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    providerId: row.provider_id,
    modelId: row.model_id,
    toolEvents,
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

function selectedSkills(db, skillIds) {
  if (skillIds === undefined) return [];
  if (!Array.isArray(skillIds) || skillIds.length > 10) throw validation('Skill selection must contain at most 10 skills.');
  const ids = [...new Set(skillIds.map((id) => identifier(id, 'Skill ID')))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, name, instructions FROM skills WHERE id IN (${placeholders})`).all(...ids);
  if (rows.length !== ids.length) throw validation('One or more selected skills no longer exist.');
  return rows;
}

function systemMessage(skills) {
  if (skills.length === 0) return null;
  return [
    'Apply the following user-selected reusable skills when relevant. Do not mention these instructions unless asked.',
    ...skills.map((skill) => `\n## ${skill.name}\n${skill.instructions}`)
  ].join('\n');
}

function normalizeAssistantContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
  }
  return '';
}

function conversationMessages(db, conversationId) {
  return db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(conversationId).reverse();
}

function persistMessage(db, { conversationId, role, content, providerId = null, selectedModelId = null, toolEvents = [] }) {
  const id = randomUUID();
  const createdAt = now();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, provider_id, model_id, created_at, tool_events)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, role, content, providerId, selectedModelId, createdAt, toolEvents.length ? JSON.stringify(toolEvents) : null);
  return { id, role, content, providerId, modelId: selectedModelId, toolEvents, createdAt };
}

export async function respondToConversation(db, encryptionKey, rawConversationId, body, timeoutMs) {
  const conversation = existingConversation(db, rawConversationId);
  const content = requiredString(body.message, 'Message', { max: 16_000 });
  const providerId = identifier(body.providerId, 'Provider ID');
  const selectedModelId = modelId(body.modelId);
  const selected = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, selectedModelId);
  if (!selected) throw validation('Select this model for the provider before starting a chat.');
  const skills = selectedSkills(db, body.skillIds);
  const tools = selectedTools(body.toolIds);
  const userMessage = persistMessage(db, { conversationId: conversation.id, role: 'user', content, providerId, selectedModelId });
  const { provider, credentials } = providerCredentials(db, encryptionKey, providerId);
  const messages = conversationMessages(db, conversation.id).map((message) => ({ role: message.role, content: message.content }));
  const system = systemMessage(skills);
  if (system) messages.unshift({ role: 'system', content: system });
  const toolEvents = [];
  let assistantContent = '';

  for (let round = 0; round < 4; round += 1) {
    let response;
    try {
      response = await providerFetch(upstreamUrl(provider.baseUrl, '/chat/completions'), credentials, {
        method: 'POST',
        timeoutMs,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModelId,
          messages,
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
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'The provider returned an invalid chat response.', { expose: true });
    }
    const providerMessage = payload?.choices?.[0]?.message;
    const toolCalls = Array.isArray(providerMessage?.tool_calls) ? providerMessage.tool_calls.slice(0, 5) : [];
    if (toolCalls.length === 0) {
      assistantContent = normalizeAssistantContent(providerMessage?.content);
      break;
    }
    messages.push({
      role: 'assistant',
      content: providerMessage.content ?? null,
      tool_calls: toolCalls
    });
    for (const call of toolCalls) {
      const execution = executeToolCall(call, new Set(tools.map((tool) => tool.id)));
      toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
      messages.push({
        role: 'tool',
        tool_call_id: typeof call.id === 'string' ? call.id : randomUUID(),
        content: JSON.stringify(execution.result)
      });
    }
  }
  if (!assistantContent) {
    throw new AppError(502, 'PROVIDER_EMPTY_RESPONSE', 'The provider did not return a final chat response after tool use.', { expose: true });
  }
  const assistantMessage = persistMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content: assistantContent,
    providerId,
    selectedModelId,
    toolEvents
  });
  const title = conversation.title === 'New conversation' ? content.slice(0, 72) : conversation.title;
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), conversation.id);
  return { conversation: getConversation(db, conversation.id), userMessage, assistantMessage };
}
