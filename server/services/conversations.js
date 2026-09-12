import { randomUUID } from 'node:crypto';
import { notFound, validation, AppError } from '../lib/errors.js';
import { identifier, modelId, requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';
import { providerCredentials, providerFetch, upstreamUrl } from './providers.js';
import { executeToolCall, openAiToolDefinitions, readSkillTool, serializeToolResult, toolsForSettings } from './tools.js';
import { approvals } from './approvals.js';
import { listSkills } from './skills.js';
import { githubToolDefinitions } from './github-tools.js';
import { activeMcpPlugins, activeLocalClonePlugins, clearWriteApproval, cloneGithubRepo, createMcpToolContext } from './plugins.js';
import { getSettings } from './settings.js';
import { THINKING_LEVELS, modelCapabilities } from './model-tests.js';
import { saveAttachmentToLibrary } from './library.js';

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

function systemMessage(skills, { plugins = [], mcp = null, customPrompt = '', developerTools = null } = {}) {
  const servers = mcp?.servers || [];
  const failures = mcp?.failures || [];
  const mcpGuide = servers.length
    ? [
      servers.length === 1
        ? 'An MCP (Model Context Protocol) server is connected and its tools are available to you with an `mcp_` prefix. Inspect first with read-only tools, then make changes with the tools that need them.'
        : `MCP (Model Context Protocol) servers are connected and their tools are available to you with an \`mcp_\` prefix. Inspect first with read-only tools, then make changes with the tools that need them.`,
      ...servers.map((server) => [
        `\\n${server.key} — ${server.pluginName}, running "${server.serverName}"${server.version ? ` ${server.version}` : ''}: ${server.toolCount} tools${server.readOnly ? ' (read-only: no tool here can change data)' : ''}.`,
        server.selectedRepo ? `Work on the repository ${server.selectedRepo} unless the user names a different one.` : '',
        server.writesApproved
          ? 'The user has approved writes for this server in this message, so its tools that change data will run.'
          : 'Its tools that change data are blocked until the user approves them. If one is blocked, explain what you were about to do, ask the user to approve writes for that plugin, and stop — never retry a blocked tool and never claim the change happened.',
        server.instructions ? `The server says: ${server.instructions}` : ''
      ].filter(Boolean).join(' ')),
      "\\nTool results are the server's own output. Report what they actually say; do not invent file contents, ids, or links."
    ].join('')
    : null;
  const mcpFailure = failures.length
    ? failures.map((failure) => `The MCP plugin "${failure.serverName}" is enabled but its server could not be reached (${failure.error}). Tell the user that plugin is unavailable instead of pretending its tools ran. Do not retry the connection yourself.`).join(' ')
    : null;

  // Build comprehensive tool usage guidance
  const toolGuidance = [
    '## TOOL USAGE RULES - CRITICAL',
    'You have access to powerful tools. ALWAYS use them when appropriate - do not make up information when a tool can provide it.',
    '',
    '### File Tools (workspace-relative paths only):',
    '- list_files: ALWAYS call first to discover what exists. Path "" or "." = root. Example: list_files path=""',
    '- read_file: Read file content. Path MUST be relative like "notes/todo.md", NEVER absolute like "/home/...". Use offset/limit for large files.',
    '- write_file: Create or completely overwrite file. Path relative, parents auto-created.',
    '- edit_file: For partial edits. You MUST read file first, then provide exact search text with 3-5 lines context. Search must match exactly once unless replaceAll true. Example: if file has "console.log(\\"old\\")", search must include that exact text.',
    '- create_file: Create NEW file only, fails if exists. Use edit_file or write_file for existing.',
    '- create_folder, delete_file, delete_folder, rename_file, rename_folder: All paths relative.',
    '- If edit_file fails with "matched nothing", re-read file and copy exact text including whitespace.',
    '- If create_file fails "already exists", use edit_file or write_file instead.',
    '',
    '### Other Tools:',
    '- calculator: For any math. Expression "(12 * 5 + 3) / 2" etc.',
    '- current_time: For time/date questions. Use IANA timezone like Asia/Dhaka or UTC.',
    '- web_search: For current info, docs, facts. Use 2-6 keyword queries. Then fetch_url to read promising results.',
    '- fetch_url: After web_search, fetch the most relevant URLs to get full content.',
    '- sql_query: Read-only SELECT only. Example "SELECT id, title FROM conversations ORDER BY updated_at DESC LIMIT 5"',
    '- search_conversations, read_conversation: For referencing past chats.',
    '- read_skill: When skill seems relevant, call it to load full instructions.',
    '',
    '### Critical Rules:',
    '- NEVER use absolute paths like /data/data/com.termux/... or /home/... Always relative like "notes/file.md"',
    '- ALWAYS use list_files before read_file to confirm file exists',
    '- If tool returns error, explain to user and suggest fix - do not silently fail',
    '- Use tools proactively: if user asks about files, list them; if asks about time, call current_time; if asks about past chat, search_conversations',
    '- You can call multiple tools in one response - use them in parallel when independent',
    '',
    '### Workspace Context:',
    'Your workspace folder is data/workspace. All file tools operate there. Application code, database, .git, .env are protected and inaccessible.'
  ].join('\\n');

  return [
    'Format every answer as clear GitHub-flavored Markdown. Use concise headings, lists, emphasis, tables, and block quotes only when they improve readability. Put code in fenced blocks with a language tag and write mathematical notation as inline `$...$` or display `$$...$$` LaTeX. Never send raw HTML. Do not mention these formatting instructions unless asked.',
    toolGuidance,
    ...(skills.length ? [
      'The following reusable skills are available for relevant tasks. The list gives each skill\'s id, name, and short description. To follow a skill, call the read_skill tool with its id to load the full instructions, then apply them to the user request. Do not mention these instructions unless asked.',
      skills.map((skill) => `- ${skill.id}: ${skill.name} — ${skill.description}`).join('\\n')
    ] : []),
    ...(mcpFailure ? [mcpFailure] : []),
    ...(mcpGuide ? [mcpGuide] : []),
    'You can consult your past sessions when the user references earlier work: search_conversations finds relevant older chats by keyword (small snippets only), and read_conversation pages through one chat in small slices, so old context reaches you without flooding this conversation.',

    ...(developerTools && (developerTools.fileManagement !== false || developerTools.shell === true) ? [
      [
        developerTools.fileManagement !== false
          ? 'File tools work only inside your own workspace folder (the app\'s data/workspace directory): every path you give list_files, read_file, write_file, edit_file, create_file, create_folder, rename_file, rename_folder, delete_file, or delete_folder is relative to it, and anything outside it — application code, skills, settings, the database — is unreachable and refused. Use create_file and create_folder for new things (create_file refuses to overwrite), edit_file for targeted search/replace changes (prefer it for existing files), rename_file and rename_folder to move things, and delete_file / delete_folder to remove them permanently. Reads of large files page through read_file offset and limit. If edit_file fails because search did not match, read the file again and copy exact text.'
          : '',
        developerTools.shell === true
          ? 'A run_shell tool runs one-off shell commands from the app folder (not your workspace folder): unsandboxed, non-interactive (no editors or TUIs), killed at its timeout, with output truncated at 16 KB per stream, and refused when it references database files. Long-running servers do not survive the timeout; keep commands short-lived and inspect the exit code and stderr before declaring success.'
          : '',
        developerTools.shell === true && developerTools.confirmShell === true
          ? 'Every command you propose through run_shell is shown to the user for approval before it runs. Propose small, self-explanatory commands; a denied command did not run, and you must not retry it or a lightly rewritten version of it — ask the user how to proceed.'
          : ''
      ].filter(Boolean).join(' ')
    ] : []),
    ...(plugins.length ? [
      'A local clone of the selected GitHub repository is also available in the workspace. Use github_list_files / github_read_file to inspect it, github_write_file to edit or create files, github_rename_file and github_delete_file to move or remove files, then github_commit to stage and commit locally. Push to GitHub with github_push, but note that pushing always requires the user to confirm first — if push is blocked for confirmation, tell the user and stop rather than retrying. Although the plugin may not be cloned yet, call github_clone first if you need to refresh it. Prefer the MCP tools for GitHub itself and use the clone for bulk file work.'
    ] : []),
    ...(customPrompt ? [
      `The user has set these standing instructions for every reply in this workspace. Follow them in addition to everything above:\\n${customPrompt}`
    ] : [])
  ].join('\\n');
}

function skillResolver(db) {
  return (skillId) => {
    if (typeof skillId !== 'string' || !skillId) return null;
    const row = db.prepare('SELECT id, name, description, instructions FROM skills WHERE id = ?').get(skillId);
    return row || null;
  };
}

const APPROVAL_GATED_TOOLS = new Set(['run_shell']);

function needsApproval(context, toolId) {
  return APPROVAL_GATED_TOOLS.has(toolId)
    && context.developerTools?.shell === true
    && context.developerTools?.confirmShell === true;
}

function approvalCommand(call) {
  // Handle both string and object arguments
  try {
    let args = call.function?.arguments;
    if (typeof args === 'string') {
      args = JSON.parse(args || '{}');
    } else if (typeof args !== 'object') {
      args = {};
    }
    if (typeof args?.command === 'string' && args.command.trim()) return args.command.trim();
  } catch { }
  // Fallback to raw text
  const raw = call.function?.arguments;
  if (typeof raw === 'string') return raw.slice(0, 500);
  if (raw && typeof raw === 'object' && typeof raw.command === 'string') return raw.command;
  return '';
}

function compactCommand(command) {
  const firstLine = String(command).split('\n')[0];
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
}

async function executeWithApproval(context, db, call, emit, { rootDirectory, workspaceDirectory, fetchTimeoutMs, stopSignal = null, isStopped = null } = {}) {
  const toolId = typeof call.function?.name === 'string' ? call.function.name : (typeof call.name === 'string' ? call.name : '');
  const toolArgs = [
    call,
    new Set(context.tools.map((tool) => tool.id)),
    { 
      getSkill: skillResolver(db), 
      db, 
      rootDirectory, 
      workspaceDirectory, 
      fetchTimeoutMs, 
      plugin: context.plugin, 
      plugins: context.plugins,
      mcp: context.mcp, 
      developerTools: context.developerTools, 
      stopSignal 
    }
  ];
  if (isStopped?.()) {
    return {
      toolId,
      result: { error: 'The user stopped the response before this tool ran.' },
      summary: 'Tool not run — response stopped'
    };
  }
  if (!needsApproval(context, toolId)) return executeToolCall(...toolArgs);
  if (!emit) {
    return {
      toolId,
      result: { error: 'Shell commands need the user\'s approval, which only the live chat stream can collect. Ask the user to send the message in the chat window.' },
      summary: 'Shell command skipped — approval needs the live chat stream'
    };
  }
  const command = approvalCommand(call);
  const approval = approvals.create({ conversationId: context.conversation.id, toolId, command });
  emit('confirmation_required', { approvalId: approval.id, toolId, command });
  const outcome = await approval.wait;
  emit('confirmation_resolved', { approvalId: approval.id, outcome });
  if (outcome !== 'approved') {
    const error = outcome === 'expired'
      ? 'Approval timed out and the command was not run.'
      : outcome === 'aborted'
        ? 'The stream ended before the command was approved, so it was not run.'
        : 'The user denied this command. It did not run. Do not retry it or a lightly rewritten version of it; ask the user how they would like to proceed instead.';
    return {
      toolId,
      result: { error, approved: false },
      summary: outcome === 'denied' ? `Shell command denied by the user: ${compactCommand(command)}` : 'Shell command not run — no approval'
    };
  }
  const execution = await executeToolCall(...toolArgs);
  return { ...execution, summary: `Approved by user — ${execution.summary}` };
}

function normalizeAssistantContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
  }
  return '';
}

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

export function editMessage(db, rawConversationId, rawMessageId, body = {}) {
  const { conversation, message } = existingMessage(db, rawConversationId, rawMessageId);
  if (message.role !== 'user') throw validation('Only your own messages can be edited.');
  const content = requiredString(body.content, 'Message', { max: 16_000 });
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, message.id);
  dropMessagesAfter(db, conversation.id, message);
  touchConversation(db, conversation.id);
  return getConversation(db, conversation.id);
}

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
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw validation(`Attachment ${index + 1} is not readable.`);
    const parsed = parseDataUrl(entry.dataUrl);
    if (!parsed) throw validation(`Attachment ${index + 1} must be a base64 data URL.`);
    if (parsed.bytes === 0) throw validation(`Attachment ${index + 1} is empty.`);
    if (parsed.bytes > MAX_ATTACHMENT_BYTES) {
      throw validation(`Attachment ${index + 1} is ${Math.round(parsed.bytes / 1024 / 1024)} MB. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    }
    const kind = attachmentKind(parsed.mimeType);
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

async function prepareResponse(db, rawConversationId, body, { workspaceDirectory, libraryDirectory, existingUserMessage = null } = {}) {
  const conversation = existingConversation(db, rawConversationId);
  const content = requiredString(body.message, 'Message', { max: 16_000 });
  const providerId = identifier(body.providerId, 'Provider ID');
  const selectedModelId = modelId(body.modelId);
  const selected = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, selectedModelId);
  if (!selected) throw validation('Select this model for the provider before starting a chat.');
  const thinkingLevel = body.thinkingLevel === undefined || body.thinkingLevel === null || body.thinkingLevel === ''
    ? null
    : String(body.thinkingLevel);
  const thinkingRung = thinkingLevel ? THINKING_LEVELS.find((level) => level.id === thinkingLevel) : null;
  if (thinkingLevel && !thinkingRung) throw validation('That thinking level is not one this workspace offers.');
  const attachments = existingUserMessage
    ? parseJsonArray(existingUserMessage.attachments, [])
    : parseAttachments(db, body, { providerId, selectedModelId });
  const skills = listSkills(db);
  const settings = getSettings(db);
  const baseTools = toolsForSettings(settings.developerTools);
  const tools = skills.length ? [...baseTools, readSkillTool()] : baseTools;
  
  // Auto-discover GitHub plugins with local clone enabled - FIXED: no longer requires explicit pluginId
  let githubPlugins = [];
  try {
    githubPlugins = activeLocalClonePlugins(db, workspaceDirectory);
  } catch {}
  // Also check explicit pluginId for backward compatibility
  if (body.pluginId) {
    const explicit = activeGithubPluginLegacy(db, body.pluginId, workspaceDirectory);
    if (explicit && !githubPlugins.find(p => p.pluginId === explicit.pluginId)) {
      githubPlugins.push(explicit);
    }
  }
  
  if (githubPlugins.length > 0) {
    tools.push(...githubToolDefinitions());
  }
  
  const mcp = await openMcpContexts(db);
  if (mcp?.definitions?.length) {
    tools.push(...mcp.definitions);
  }
  
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

  // Save every uploaded file to the Library (photos, PDFs, files)
  if (!existingUserMessage && libraryDirectory && attachments.length) {
    for (const att of attachments) {
      saveAttachmentToLibrary(db, libraryDirectory, att, {
        conversationId: conversation.id,
        messageId: userMessage.id
      });
    }
  }
  const messages = conversationMessages(db, conversation.id);
  const system = systemMessage(skills, { plugins: githubPlugins, mcp, customPrompt: settings.systemPrompt.text, developerTools: settings.developerTools });
  if (system) messages.unshift({ role: 'system', content: system });
  const otherQuestions = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'user' AND id <> ?`)
    .get(conversation.id, userMessage.id).count;
  return {
    conversation, content, providerId, selectedModelId, tools, 
    plugin: githubPlugins[0] || null, // For backward compat, first plugin
    plugins: githubPlugins, // New: array of all qualifying plugins
    mcp, userMessage, messages,
    attachments,
    developerTools: settings.developerTools,
    capabilities: modelCapabilities(db, providerId, selectedModelId),
    isFirstExchange: otherQuestions === 0,
    reasoningEffort: thinkingRung ? thinkingRung.value : null,
    thinkingLabel: thinkingRung ? thinkingRung.label : null
  };
}

function activeGithubPluginLegacy(db, rawPluginId, workspaceDirectory) {
  if (!rawPluginId) return null;
  const pluginId = String(rawPluginId);
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(pluginId);
  if (!row || row.type !== 'mcp' || !Number(row.enabled)) return null;
  const config = (() => { try { return JSON.parse(row.config) || {}; } catch { return {}; } })();
  if (config.github?.localClone !== true || !config.selectedRepo) return null;
  return { pluginId, needsClone: !config.cloned, workspaceDirectory, selectedRepo: config.selectedRepo };
}

async function openMcpContexts(db) {
  const active = activeMcpPlugins(db);
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

async function closeMcpContexts(db, mcp) {
  if (!mcp) return;
  for (const context of mcp.contexts || []) {
    await context.dispose();
    clearWriteApproval(db, context.pluginId);
  }
  for (const failure of mcp.failures || []) clearWriteApproval(db, failure.pluginId);
}

async function ensureRepositoryCloned(db, plugin, workspaceDirectory) {
  if (plugin?.needsClone && workspaceDirectory) {
    try {
      await cloneGithubRepo(db, plugin.pluginId, workspaceDirectory);
    } catch {
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

function shortStatus(error) {
  return String(error?.message || 'connection failed').replace(/\s+/gu, ' ').trim().slice(0, 120);
}

const TITLE_SYSTEM_PROMPT = [
  'You name chat conversations.',
  'Read the first exchange below and write one title of 8 to 10 words that says what the conversation is about.',
  'Reply with the title only: no quotes, no leading or trailing punctuation, no explanation, no line breaks.'
].join(' ');

function normalizeTitle(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/gu, '')
    .replace(/\.$/u, '')
    .trim();
  return text ? text.slice(0, 120) : null;
}

async function generateConversationTitle(db, context, assistantContent, { emit, fetchTimeoutMs } = {}) {
  if (!context.isFirstExchange) return null;
  const settings = getSettings(db).titleGeneration;
  if (!settings.enabled || !settings.providerId || !settings.modelId) return null;
  emit?.('status', { tone: 'info', text: `Naming this chat with ${settings.modelId}...` });
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
    if (title) emit?.('status', { tone: 'info', text: `Chat named "${title}".` });
    return title;
  } catch {
    return null;
  }
}

async function finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline = null, { emit, fetchTimeoutMs, allowEmpty = false } = {}) {
  if (!assistantContent && !allowEmpty) {
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
    if (typeof partial.id === 'string' && partial.id) call.id = (call.id || '') + partial.id;
    else if (typeof partial.id === 'string') call.id += partial.id;
    if (typeof partial.type === 'string') call.type = partial.type;
    
    // Handle function name - can be string concatenation or full name
    if (typeof partial.function?.name === 'string' && partial.function.name) {
      call.function.name = (call.function.name || '') + partial.function.name;
    }
    
    // Handle arguments - can be string (needs concat) or object (merge)
    const args = partial.function?.arguments;
    if (typeof args === 'string') {
      call.function.arguments = (call.function.arguments || '') + args;
    } else if (args && typeof args === 'object' && !Array.isArray(args)) {
      // Some providers send arguments as object directly
      // Convert existing string args to object if needed, then merge
      try {
        let existing = {};
        if (call.function.arguments && typeof call.function.arguments === 'string' && call.function.arguments.trim()) {
          existing = JSON.parse(call.function.arguments);
        } else if (call.function.arguments && typeof call.function.arguments === 'object') {
          existing = call.function.arguments;
        }
        const merged = { ...existing, ...args };
        call.function.arguments = JSON.stringify(merged);
      } catch {
        // If parsing fails, just stringify the object args
        call.function.arguments = JSON.stringify(args);
      }
    }
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

export function createStreamStop() {
  const controller = new AbortController();
  return {
    stopped: false,
    signal: controller.signal,
    stop() {
      if (!this.stopped) {
        this.stopped = true;
        controller.abort();
      }
    }
  };
}

const stoppedResult = (content, reasoning) => ({ content, reasoning, toolCalls: [], stopped: true });

function streamFailure(shift, code, message) {
  const error = failureError(code, message);
  error.partial = shift();
  throw error;
}

async function streamProviderRoundWithRetry({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, maxRetries, reasoningEffort = null, stop = null }) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    emit('status', { tone: 'info', text: attempt === 0 ? 'Waiting for the model...' : `Waiting for the model — attempt ${attempt + 1}...` });
    try {
      return await streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, reasoningEffort, stop });
    } catch (error) {
      if (stop?.stopped) return stoppedResult(error.partial?.content || '', error.partial?.reasoning || '');
      if (attempt >= maxRetries) throw error;
      const partial = error.partial;
      if (partial?.content) {
        messages.push({ role: 'assistant', content: partial.content });
        messages.push({ role: 'user', content: 'Continue your previous response exactly from where it stopped. Do not repeat any text you already wrote; continue with the next part of your answer.' });
      }
      emit('status', { tone: 'warn', text: `The model failed (${shortStatus(error)}). Retrying ${attempt + 1} of ${maxRetries}...` });
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * (attempt + 1), 2_500)));
      if (stop?.stopped) return stoppedResult('', '');
      attempt += 1;
    }
  }
  throw failureError('PROVIDER_RETRY_EXHAUSTED', 'The provider could not be reached after repeated attempts.');
}

async function streamProviderRound({ provider, credentials, selectedModelId, messages, tools, timeoutMs, emit, reasoningEffort = null, stop = null }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = stop ? AbortSignal.any([controller.signal, stop.signal]) : controller.signal;
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
        signal: fetchSignal,
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
      if (stop?.stopped) return stoppedResult(content, reasoning);
      if (fetchSignal.aborted) throw timedOut();
      throw streamFailure(shift, 'PROVIDER_UNAVAILABLE', error.message);
    }
    if (!response?.ok) {
      const status = response?.status ? ` (HTTP ${response.status})` : '';
      if (stop?.stopped) return stoppedResult(content, reasoning);
      throw streamFailure(shift, 'PROVIDER_RESPONSE_ERROR', `The provider could not complete this request${status}.`);
    }
    if (stop?.stopped) return stoppedResult(content, reasoning);
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        if (stop?.stopped) return stoppedResult(content, reasoning);
        if (fetchSignal.aborted) throw timedOut();
        throw streamFailure(shift, 'PROVIDER_INVALID_RESPONSE', 'The provider returned an invalid chat response.');
      }
      if (stop?.stopped) return stoppedResult(content, reasoning);
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
        if (stop?.stopped) break;
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
      if (stop?.stopped) return stoppedResult(content, reasoning);
      if (fetchSignal.aborted) throw timedOut();
      throw streamFailure(shift, 'PROVIDER_STREAM_INTERRUPTED', 'The provider streaming response was interrupted.');
    }
    if (stop?.stopped) return stoppedResult(content, reasoning);
    return { content, reasoning, toolCalls: toolCalls.filter((call) => call.function.name) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function respondToConversation(db, rawConversationId, body, timeoutMs, { rootDirectory, workspaceDirectory, libraryDirectory, fetchTimeoutMs, maxToolRounds = 500, maxProviderRetries = 20 } = {}) {
  const context = await prepareResponse(db, rawConversationId, body, { workspaceDirectory, libraryDirectory });
  const { provider, credentials } = providerCredentials(db, context.providerId);
  const toolEvents = [];
  const timeline = [];
  let assistantContent = '';
  let reasoning = '';
  if (context.plugin) await ensureRepositoryCloned(db, context.plugin, workspaceDirectory);
  // Also clone for all github plugins
  for (const p of context.plugins || []) {
    if (p.needsClone) await ensureRepositoryCloned(db, p, workspaceDirectory);
  }
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
        timeline.push({ type: 'tool_call', name: typeof call.function?.name === 'string' ? call.function.name : (typeof call.name === 'string' ? call.name : '') });
        const execution = await executeWithApproval(context, db, call, null, { rootDirectory, workspaceDirectory, fetchTimeoutMs });
        toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
        timeline.push({ type: 'tool_result', toolId: execution.toolId, summary: execution.summary });
        context.messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' ? call.id : randomUUID(), content: serializeToolResult(execution.result) });
      }
    }
    return await finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline, { fetchTimeoutMs });
  } finally {
    await closeMcpContexts(db, context.mcp);
  }
}

async function streamConversation(db, context, timeoutMs, emit, { rootDirectory, workspaceDirectory, fetchTimeoutMs, maxToolRounds = 500, maxProviderRetries = 20, stop = null } = {}) {
  const { provider, credentials } = providerCredentials(db, context.providerId);
  for (const server of context.mcp?.servers || []) {
    emit('status', { tone: 'info', text: `MCP connected — ${server.pluginName || server.name}: ${server.toolCount} tools.` });
  }
  for (const failure of context.mcp?.failures || []) {
    emit('status', { tone: 'warn', text: `MCP unavailable — ${failure.serverName}: ${failure.error}` });
  }
  emit('started', { conversationId: context.conversation.id });
  emit('status', { tone: 'info', text: `Connecting to ${provider.name}...` });
  if (context.thinkingLabel) emit('status', { tone: 'info', text: `Thinking level: ${context.thinkingLabel}.` });
  if (context.plugin) await ensureRepositoryCloned(db, context.plugin, workspaceDirectory);
  for (const p of context.plugins || []) {
    if (p.needsClone) await ensureRepositoryCloned(db, p, workspaceDirectory);
  }
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
    let wasStopped = false;
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
        reasoningEffort: context.reasoningEffort,
        stop
      });
      if (result.stopped || stop?.stopped) { wasStopped = true; break; }
      if (result.toolCalls.length === 0) break;
      context.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        if (stop?.stopped) { wasStopped = true; break; }
        const execution = await executeWithApproval(context, db, call, emit, { rootDirectory, workspaceDirectory, fetchTimeoutMs, stopSignal: stop?.signal, isStopped: () => stop?.stopped === true });
        toolEvents.push({ toolId: execution.toolId, summary: execution.summary });
        timelineEmit('tool_result', { toolId: execution.toolId, summary: execution.summary });
        context.messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' && call.id ? call.id : randomUUID(), content: serializeToolResult(execution.result) });
        if (stop?.stopped) { wasStopped = true; break; }
      }
      if (wasStopped) break;
    }
    const assistantContent = timeline.filter((entry) => entry.type === 'content').map((entry) => entry.text).join('');
    const reasoning = timeline.filter((entry) => entry.type === 'thinking').map((entry) => entry.text).join('');
    if (wasStopped) {
      timeline.push({ type: 'stopped' });
      const result = await finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline, { emit, fetchTimeoutMs, allowEmpty: true });
      emit('aborted', result);
      return result;
    }
    const result = await finishResponse(db, context, assistantContent, reasoning, toolEvents, timeline, { emit, fetchTimeoutMs });
    emit('completed', result);
    return result;
  } finally {
    await closeMcpContexts(db, context.mcp);
  }
}

export async function respondToConversationStream(db, rawConversationId, body, timeoutMs, emit, options = {}) {
  const context = await prepareResponse(db, rawConversationId, body, { workspaceDirectory: options.workspaceDirectory, libraryDirectory: options.libraryDirectory });
  return streamConversation(db, context, timeoutMs, emit, options);
}

export async function regenerateMessageStream(db, rawConversationId, rawMessageId, body, timeoutMs, emit, options = {}) {
  const { conversation, message } = existingMessage(db, rawConversationId, rawMessageId);
  if (message.role !== 'user') throw validation('Choose one of your own messages to answer again.');
  dropMessagesAfter(db, conversation.id, message);
  touchConversation(db, conversation.id);
  const context = await prepareResponse(db, conversation.id, { ...body, message: message.content }, { workspaceDirectory: options.workspaceDirectory, libraryDirectory: options.libraryDirectory, existingUserMessage: message });
  return streamConversation(db, context, timeoutMs, emit, options);
}
