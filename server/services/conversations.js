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
    reasoning: row.reasoning || '',
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
  return [
    'Format every answer as clear GitHub-flavored Markdown. Use concise headings, lists, emphasis, tables, and block quotes only when they improve readability. Put code in fenced blocks with a language tag and write mathematical notation as inline `$...$` or display `$$...$$` LaTeX. Never send raw HTML. Do not mention these formatting instructions unless asked.',
    ...(skills.length ? [
      'Apply the following user-selected reusable skills when relevant. Do not mention these instructions unless asked.',
      ...skills.map((skill) => `\n## ${skill.name}\n${skill.instructions}`)
    ] : [])
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

function persistMessage(db, { conversationId, role, content, providerId = null, selectedModelId = null, reasoning = '', toolEvents = [] }) {
  const id = randomUUID();
  const createdAt = now();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, provider_id, model_id, created_at, tool_events, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, role, content, providerId, selectedModelId, createdAt, toolEvents.length ? JSON.stringify(toolEvents) : null, reasoning || null);
  return { id, role, content, providerId, modelId: selectedModelId, reasoning, toolEvents, createdAt };
}

function prepareResponse(db, rawConversationId, body) {
  const conversation = existingConversation(db, rawConversationId);
  const content = requiredString(body.message, 'Message', { max: 16_000 });
  const providerId = identifier(body.providerId, 'Provider ID');
  const selectedModelId = modelId(body.modelId);
  const selected = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, selectedModelId);
  if (!selected) throw validation('Select this model for the provider before starting a chat.');
  const skills = selectedSkills(db, body.skillIds);
  const tools = selectedTools(body.toolIds);
  const userMessage = persistMessage(db, { conversationId: conversation.id, role: 'user', content, providerId, selectedModelId });
  const messages = conversationMessages(db, conversation.id).map((message) => ({ role: message.role, content: message.content }));
  const system = systemMessage(skills);
  if (system) messages.unshift({ role: 'system', content: system });
  return { conversation, content, providerId, selectedModelId, tools, userMessage, messages };
}

async function providerCompletion(provider, credentials, selectedModelId, messages, tools, timeoutMs) {
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
  return response;
}

function finishResponse(db, context, assistantContent, reasoning, toolEvents) {
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
    toolEvents
  });
  const title = context.conversation.title === 'New conversation' ? context.content.slice(0, 72) : context.conversation.title;
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

async function streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => new AppError(502, 'PROVIDER_TIMEOUT', 'The provider streaming request timed out.', { expose: true });
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
          ...(tools.length ? { tools: openAiToolDefinitions(tools), tool_choice: 'auto' } : {})
        })
      });
    } catch (error) {
      if (controller.signal.aborted) throw timedOut();
      throw new AppError(502, 'PROVIDER_UNAVAILABLE', error.message, { expose: true });
    }
    if (!response?.ok) {
      const status = response?.status ? ` (HTTP ${response.status})` : '';
      throw new AppError(502, 'PROVIDER_RESPONSE_ERROR', `The provider could not complete this request${status}.`, { expose: true });
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw timedOut();
        throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'The provider returned an invalid chat response.', { expose: true });
      }
      const message = payload?.choices?.[0]?.message;
      const content = normalizeAssistantContent(message?.content);
      if (content) emit('token', { text: content });
      return { content, reasoning: '', toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.slice(0, 5) : [] };
    }
    let content = '';
    let reasoning = '';
    const toolCalls = [];
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
      }
    } catch (error) {
      if (controller.signal.aborted) throw timedOut();
      throw error;
    }
    return { content, reasoning, toolCalls: toolCalls.filter((call) => call.function.name) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function respondToConversation(db, rawConversationId, body, timeoutMs) {
  const context = prepareResponse(db, rawConversationId, body);
  const { provider, credentials } = providerCredentials(db, context.providerId);
  const toolEvents = [];
  let assistantContent = '';
  let reasoning = '';
  for (let round = 0; round < 4; round += 1) {
    const response = await providerCompletion(provider, credentials, context.selectedModelId, context.messages, context.tools, timeoutMs);
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
    context.messages.push({ role: 'assistant', content: providerMessage.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const execution = executeToolCall(call, new Set(context.tools.map((tool) => tool.id)));
      toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
      context.messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' ? call.id : randomUUID(), content: JSON.stringify(execution.result) });
    }
  }
  return finishResponse(db, context, assistantContent, reasoning, toolEvents);
}

export async function respondToConversationStream(db, rawConversationId, body, timeoutMs, emit) {
  const context = prepareResponse(db, rawConversationId, body);
  const { provider, credentials } = providerCredentials(db, context.providerId);
  emit('started', { conversationId: context.conversation.id });
  const toolEvents = [];
  let assistantContent = '';
  let reasoning = '';
  for (let round = 0; round < 4; round += 1) {
    const result = await streamProviderRound({
      provider,
      credentials,
      selectedModelId: context.selectedModelId,
      messages: context.messages,
      tools: context.tools,
      timeoutMs,
      emit
    });
    reasoning += result.reasoning;
    if (result.toolCalls.length === 0) {
      assistantContent = result.content;
      break;
    }
    context.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const execution = executeToolCall(call, new Set(context.tools.map((tool) => tool.id)));
      toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
      context.messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' && call.id ? call.id : randomUUID(), content: JSON.stringify(execution.result) });
    }
  }
  const result = finishResponse(db, context, assistantContent, reasoning, toolEvents);
  emit('completed', result);
  return result;
}
