import { randomUUID } from 'node:crypto';
import { notFound, validation, AppError } from '../lib/errors.js';
import { identifier, modelId, requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';
import { providerCredentials, providerFetch, upstreamUrl } from './providers.js';
import { executeToolCall, listTools, openAiToolDefinitions, readSkillTool } from './tools.js';
import { listSkills } from './skills.js';
import { githubToolDefinitions } from './github-tools.js';
import { activeMcpPlugin, clearWriteApproval, cloneGithubRepo, createMcpToolContext } from './plugins.js';

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

function systemMessage(skills, { plugin = null, mcp = null } = {}) {
  const mcpFailure = mcp?.failed
    ? `The MCP plugin "${mcp.serverName || 'mcp'}" is enabled but its server could not be reached (${mcp.error}). Tell the user the plugin is unavailable instead of pretending its tools ran. Do not retry the connection yourself.`
    : null;
  const mcpGuide = mcp && !mcp.failed
    ? [
      `An MCP (Model Context Protocol) server named "${mcp.serverName}" is connected. Its tools are exposed with an \`mcp_\` prefix and are how you act on that service — inspect first with read-only tools, then make changes with the tools that need them.`,
      mcp.selectedRepo ? `Work on the repository ${mcp.selectedRepo} unless the user names a different one.` : '',
      mcp.writesApproved
        ? 'The user has approved writes for this message, so tools that change data will run.'
        : 'Tools that change data are blocked until the user approves them. If one is blocked, explain what you were about to do, ask the user to approve writes, and stop — never retry a blocked tool and never claim the change happened.',
      "Tool results are the server's own output. Report what they actually say; do not invent file contents, ids, or links."
    ].filter(Boolean).join(' ')
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

function conversationMessages(db, conversationId) {
  return db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(conversationId).reverse();
}

function persistMessage(db, { conversationId, role, content, providerId = null, selectedModelId = null, reasoning = '', toolEvents = [], timeline = null }) {
  const id = randomUUID();
  const createdAt = now();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content, provider_id, model_id, created_at, tool_events, reasoning, timeline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, role, content, providerId, selectedModelId, createdAt, toolEvents.length ? JSON.stringify(toolEvents) : null, reasoning || null, timeline && timeline.length ? JSON.stringify(timeline) : null);
  return { id, role, content, providerId, modelId: selectedModelId, reasoning, toolEvents, timeline: timeline || null, createdAt };
}

async function prepareResponse(db, rawConversationId, body, { workspaceDirectory } = {}) {
  const conversation = existingConversation(db, rawConversationId);
  const content = requiredString(body.message, 'Message', { max: 16_000 });
  const providerId = identifier(body.providerId, 'Provider ID');
  const selectedModelId = modelId(body.modelId);
  const selected = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, selectedModelId);
  if (!selected) throw validation('Select this model for the provider before starting a chat.');
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
  const mcp = await openMcpContext(db, body.pluginId);
  if (mcp?.definitions) {
    tools.push(...mcp.definitions);
  }
  const userMessage = persistMessage(db, { conversationId: conversation.id, role: 'user', content, providerId, selectedModelId });
  const messages = conversationMessages(db, conversation.id).map((message) => ({ role: message.role, content: message.content }));
  const system = systemMessage(skills, { plugin, mcp });
  if (system) messages.unshift({ role: 'system', content: system });
  return { conversation, content, providerId, selectedModelId, tools, plugin, mcp, userMessage, messages };
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

// Opens the MCP session for this request. A server that cannot be reached must not block the
// message: the failure is recorded so the system prompt tells the model to say so.
async function openMcpContext(db, rawPluginId) {
  const active = activeMcpPlugin(db, rawPluginId);
  if (!active) return null;
  try {
    return await createMcpToolContext(db, active.pluginId);
  } catch (error) {
    return { pluginId: active.pluginId, failed: true, error: String(error?.message || 'The MCP server could not be reached.') };
  }
}

// Every MCP session is torn down when the request ends, and the one-shot write approval is
// consumed so the next message has to be approved again.
async function closeMcpContext(db, mcp) {
  if (!mcp) return;
  if (typeof mcp.dispose === 'function') await mcp.dispose();
  if (mcp.pluginId) clearWriteApproval(db, mcp.pluginId);
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

async function providerCompletionWithRetry({ provider, credentials, selectedModelId, messages, tools, timeoutMs, maxRetries }) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await providerCompletion(provider, credentials, selectedModelId, messages, tools, timeoutMs);
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * (attempt + 1), 2_500)));
      attempt += 1;
    }
  }
  throw failureError('PROVIDER_RETRY_EXHAUSTED', 'The provider could not be reached after repeated attempts.');
}

function finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline = null) {
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
async function streamProviderRoundWithRetry({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, maxRetries }) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit });
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const partial = error.partial;
      if (partial?.content) {
        messages.push({ role: 'assistant', content: partial.content });
        messages.push({ role: 'user', content: 'Continue your previous response exactly from where it stopped. Do not repeat any text you already wrote; continue with the next part of your answer.' });
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * (attempt + 1), 2_500)));
      attempt += 1;
    }
  }
  throw failureError('PROVIDER_RETRY_EXHAUSTED', 'The provider could not be reached after repeated attempts.');
}

async function streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit }) {
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
      const response = await providerCompletionWithRetry({ provider, credentials, selectedModelId: context.selectedModelId, messages: context.messages, tools: context.tools, timeoutMs, maxRetries: maxProviderRetries });
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
    return finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline);
  } finally {
    await closeMcpContext(db, context.mcp);
  }
}

export async function respondToConversationStream(db, rawConversationId, body, timeoutMs, emit, { rootDirectory, workspaceDirectory, fetchTimeoutMs, maxToolRounds = 500, maxProviderRetries = 20 } = {}) {
  const context = await prepareResponse(db, rawConversationId, body, { workspaceDirectory });
  const { provider, credentials } = providerCredentials(db, context.providerId);
  emit('started', { conversationId: context.conversation.id });
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
        maxRetries: maxProviderRetries
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
    const result = finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline);
    emit('completed', result);
    return result;
  } finally {
    await closeMcpContext(db, context.mcp);
  }
}
