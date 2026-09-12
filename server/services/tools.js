import { fetchUrl, listFiles, readFile, sqlQuery, webSearch, writeFile } from './workspace-tools.js';
import { createFile, createFolder, deleteFile, deleteFolder, editFile, renameFile, renameFolder, runShell } from './developer-tools.js';
import { readConversation, searchConversations } from './chat-memory.js';
import { executeGithubTool } from './github-tools.js';
import { MCP_TOOL_PREFIX, executeMcpTool } from './mcp-tools.js';

// Tool ids grouped by the settings gate that controls them. listTools() always advertises the
// full catalog; conversations filter these sets out when the user has not enabled the group.
export const FILE_MANAGEMENT_TOOL_IDS = Object.freeze([
  'edit_file', 'create_file', 'create_folder', 'delete_file', 'delete_folder', 'rename_file', 'rename_folder'
]);
export const SHELL_TOOL_IDS = Object.freeze(['run_shell']);

const toolCatalog = Object.freeze({
  calculator: Object.freeze({
    id: 'calculator',
    name: 'Calculator',
    description: 'Evaluate a basic arithmetic expression safely. Use for any math. Example: expression "(12 * 5 + 3) / 2" returns 31.5. Only numbers, parentheses, decimals, +, -, *, / allowed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['expression'],
      properties: { expression: { type: 'string', description: 'Arithmetic expression, e.g. "12 * (5 + 1)" or "3.14 * 2"' } }
    }
  }),
  current_time: Object.freeze({
    id: 'current_time',
    name: 'Current time',
    description: 'Get current date and time for an IANA timezone. Use when user asks about time, date, timezone. Example timeZone "Asia/Dhaka" or "UTC". Defaults to UTC.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { timeZone: { type: 'string', description: 'IANA timezone like Asia/Dhaka, America/New_York, UTC. Defaults to UTC.' } }
    }
  }),
  read_skill: Object.freeze({
    id: 'read_skill',
    name: 'Read skill',
    description: 'Load full instructions of a reusable skill by its id. Skill ids, names, descriptions are in system prompt. ALWAYS call this when a skill seems relevant before answering.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['skillId'],
      properties: { skillId: { type: 'string', description: 'Skill id from available skills catalog in system prompt.' } }
    }
  }),
  list_files: Object.freeze({
    id: 'list_files',
    name: 'List files',
    description: 'List files and folders in workspace. ALWAYS use first to discover files before reading. Path is RELATIVE to workspace root ("" or "." for root, "notes" for subfolder). Set recursive true to walk full tree up to 400 entries. Example path "" lists root.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory path RELATIVE to workspace root. Use "" or "." for root, e.g. "notes".' },
        recursive: { type: 'boolean', description: 'When true, walk full subtree up to 400 entries. Default false.' }
      }
    }
  }),
  read_file: Object.freeze({
    id: 'read_file',
    name: 'Read file',
    description: 'Read a text file from workspace as UTF-8. Path MUST be relative to workspace root, e.g. "notes/todo.md". Use list_files first. For large files use offset/limit to page, e.g. offset 0 limit 10000 then offset 10000.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path RELATIVE to workspace root, e.g. "notes/todo.md". Never absolute like /home/...' },
        offset: { type: 'integer', description: 'Char position to start from (default 0).' },
        limit: { type: 'integer', description: 'Max chars to return (default 262144, max 262144).' }
      }
    }
  }),
  write_file: Object.freeze({
    id: 'write_file',
    name: 'Write file',
    description: 'Create or overwrite a text file in workspace. Path RELATIVE (e.g. "notes/todo.md"). Parent folders auto-created. Use to create new files or completely replace existing ones. For partial edits prefer edit_file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'File path RELATIVE to workspace root, e.g. "notes/todo.md".' },
        content: { type: 'string', description: 'Full text content to write.' }
      }
    }
  }),
  edit_file: Object.freeze({
    id: 'edit_file',
    name: 'Edit file',
    group: 'fileManagement',
    description: 'Make targeted search-and-replace edits to existing file. Path RELATIVE. Each edit needs exact search text that appears exactly once unless replaceAll true. Include 3-5 lines surrounding context to make search unique. Example search "function hello() {\\n  console.log(\\"old\\");\\n}" replace "function hello() {\\n  console.log(\\"new\\");\\n}". File only saved if ALL edits succeed. Read file first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'edits'],
      properties: {
        path: { type: 'string', description: 'File path RELATIVE to workspace root, e.g. "src/app.js".' },
        edits: {
          type: 'array',
          description: 'Ordered list of search/replace ops (max 25). Each needs unique search text.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['search', 'replace'],
            properties: {
              search: { type: 'string', description: 'Exact text to find, with 3-5 lines context.' },
              replace: { type: 'string', description: 'Replacement text (may be empty to delete).' }
            }
          }
        },
        replaceAll: { type: 'boolean', description: 'If true, replace ALL occurrences. Default false.' }
      }
    }
  }),
  create_folder: Object.freeze({
    id: 'create_folder',
    name: 'Create folder',
    group: 'fileManagement',
    description: 'Create new folder in workspace. Path RELATIVE e.g. "src/components". Creates parents automatically. Succeeds if exists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'Folder path RELATIVE to workspace root, e.g. "src/components".' } }
    }
  }),
  create_file: Object.freeze({
    id: 'create_file',
    name: 'Create file',
    group: 'fileManagement',
    description: 'Create NEW text file (fails if exists). Path RELATIVE. Use edit_file or write_file to modify existing. Example path "notes/ideas.md", content "# Ideas\\n..."',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'File path RELATIVE to workspace root. Must not exist yet.' },
        content: { type: 'string', description: 'Text content for new file.' }
      }
    }
  }),
  delete_folder: Object.freeze({
    id: 'delete_folder',
    name: 'Delete folder',
    group: 'fileManagement',
    description: 'Permanently delete folder from workspace. Path RELATIVE. Only empty unless recursive true. NEVER delete root "." or "". Example path "old_notes" or with recursive true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Folder path RELATIVE to workspace root.' },
        recursive: { type: 'boolean', description: 'If true, delete folder and all contents. Default false.' }
      }
    }
  }),
  delete_file: Object.freeze({
    id: 'delete_file',
    name: 'Delete file',
    group: 'fileManagement',
    description: 'Permanently delete single file from workspace. Path RELATIVE e.g. "notes/old.md". Irreversible.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'File path RELATIVE to workspace root, e.g. "notes/old.md".' } }
    }
  }),
  rename_folder: Object.freeze({
    id: 'rename_folder',
    name: 'Rename folder',
    group: 'fileManagement',
    description: 'Rename or move folder within workspace. Both from and to RELATIVE. Destination must not exist; parents auto-created. Example from "old" to "new".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'Current folder path RELATIVE to workspace root.' },
        to: { type: 'string', description: 'New folder path RELATIVE to workspace root.' }
      }
    }
  }),
  rename_file: Object.freeze({
    id: 'rename_file',
    name: 'Rename file',
    group: 'fileManagement',
    description: 'Rename or move file within workspace. Both from and to RELATIVE. Destination must not exist. Example from "notes/old.md" to "notes/new.md".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'Current file path RELATIVE to workspace root.' },
        to: { type: 'string', description: 'New file path RELATIVE to workspace root.' }
      }
    }
  }),
  run_shell: Object.freeze({
    id: 'run_shell',
    name: 'Shell command',
    group: 'shell',
    description: 'Run one-off shell command from app folder (unsandboxed, as local user). Use ONLY non-interactive commands (no editors). Run with sh -c. Timeout kills process group. Output truncated at 16KB per stream. Use head/tail for large output. NEVER reference *.sqlite files. Only when user enables shell in settings. Example command "ls -la" or "node -v".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Shell command line, e.g. "ls -la" or "cat package.json | head -20".' },
        timeoutMs: { type: 'integer', description: 'Kill after ms (default 30000, max 120000).' }
      }
    }
  }),
  sql_query: Object.freeze({
    id: 'sql_query',
    name: 'SQL query',
    description: 'Run read-only SELECT query against local Glow Agent DB. Only SELECT/WITH, single statement. Use to inspect conversations, providers, etc. Example "SELECT id, title FROM conversations ORDER BY updated_at DESC LIMIT 5"',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: { sql: { type: 'string', description: 'Read-only SELECT. Example "SELECT * FROM conversations LIMIT 10"' } }
    }
  }),
  web_search: Object.freeze({
    id: 'web_search',
    name: 'Web search',
    description: 'Search web via DuckDuckGo. Returns titles, URLs, snippets. Use for current info, docs, facts. Query concise 2-6 keywords. Example query "Node.js 22 release notes". Returns up to maxResults (default 5, max 8).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "React hooks tutorial"' },
        maxResults: { type: 'integer', description: 'Max results (default 5, max 8).' }
      }
    }
  }),
  fetch_url: Object.freeze({
    id: 'fetch_url',
    name: 'Fetch URL',
    description: 'Fetch web page and return readable text (HTML stripped). Use after web_search to read promising result. Only http/https public hosts. Example url "https://example.com/docs". maxChars controls length (default 4000, max 20000).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'http or https URL, e.g. "https://example.com"' },
        maxChars: { type: 'integer', description: 'Max chars (default 4000, max 20000).' }
      }
    }
  }),
  search_conversations: Object.freeze({
    id: 'search_conversations',
    name: 'Search conversations',
    description: 'Search past chats by keyword. Returns only titles and snippets, not full messages. Use when user references earlier work like "that termux setup". After finding match, use read_conversation. Example query "termux setup"',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "termux setup" or "api key".' },
        limit: { type: 'integer', description: 'Max conversations (default 5, max 10).' }
      }
    }
  }),
  read_conversation: Object.freeze({
    id: 'read_conversation',
    name: 'Read conversation',
    description: 'Page through one past conversation. Like read_file but for chat history. Use conversationId from search_conversations or URL /chat/<id>. Returns messageCount, hasMore, nextOffset. Example conversationId "abc-123", offset 0, limit 10.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['conversationId'],
      properties: {
        conversationId: { type: 'string', description: 'Id from search_conversations result.' },
        offset: { type: 'integer', description: 'Start index (default 0).' },
        limit: { type: 'integer', description: 'Messages per page (default 10, max 30).' },
        maxChars: { type: 'integer', description: 'Max chars per message (default 2000, max 8000).' }
      }
    }
  })
});

export function listTools() {
  return Object.values(toolCatalog)
    .filter((tool) => tool.id !== 'read_skill')
    .map((tool) => ({ id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters, group: tool.group || null }));
}

export function toolsForSettings(developerTools = {}) {
  const fileManagement = developerTools.fileManagement !== false;
  const shell = developerTools.shell === true;
  return listTools().filter((tool) => {
    if (FILE_MANAGEMENT_TOOL_IDS.includes(tool.id)) return fileManagement;
    if (SHELL_TOOL_IDS.includes(tool.id)) return shell;
    return true;
  });
}

export function readSkillTool() {
  const tool = toolCatalog.read_skill;
  return { id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters };
}

export function openAiToolDefinitions(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

export const TOOL_RESULT_LIMIT = 32_000;

export function serializeToolResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= TOOL_RESULT_LIMIT) return json;
  if (result && typeof result === 'object' && typeof result.content === 'string') {
    const keep = Math.max(1_000, TOOL_RESULT_LIMIT - 500);
    const shrunk = { ...result, content: `${result.content.slice(0, keep)}\n...[truncated - call tool again with offset to continue]`, truncated: true };
    const shrunkJson = JSON.stringify(shrunk);
    if (shrunkJson.length <= TOOL_RESULT_LIMIT * 1.25) return shrunkJson;
  }
  return JSON.stringify({ truncated: true, note: 'Tool result too large, preview follows.', preview: json.slice(0, TOOL_RESULT_LIMIT) });
}

function calculator(expression) {
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > 200 || !/^[\d+\-*/().\s]+$/u.test(expression)) {
    return { error: 'Expression must use up to 200 chars of numbers, parentheses, decimals, and +, -, *, /.' };
  }
  let index = 0;
  const source = expression.replace(/\s+/gu, '');
  const peek = () => source[index];
  const consume = (character) => {
    if (peek() !== character) return false;
    index += 1;
    return true;
  };
  const safe = (number) => {
    if (!Number.isFinite(number) || Math.abs(number) > 1e15) throw new Error('Result outside safety range.');
    return number;
  };
  const factor = () => {
    if (consume('+')) return factor();
    if (consume('-')) return safe(-factor());
    if (consume('(')) {
      const value = expressionRule();
      if (!consume(')')) throw new Error('Missing closing parenthesis.');
      return value;
    }
    const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/u);
    if (!match) throw new Error('Expected number or opening parenthesis.');
    index += match[0].length;
    return safe(Number(match[0]));
  };
  const term = () => {
    let value = factor();
    while (peek() === '*' || peek() === '/') {
      const operator = peek(); index += 1;
      const next = factor();
      if (operator === '/' && next === 0) throw new Error('Division by zero not allowed.');
      value = safe(operator === '*' ? value * next : value / next);
    }
    return value;
  };
  const expressionRule = () => {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      const operator = peek(); index += 1;
      const next = term();
      value = safe(operator === '+' ? value + next : value - next);
    }
    return value;
  };
  try {
    const result = expressionRule();
    if (index !== source.length) throw new Error('Unexpected token in expression.');
    return { expression, result: Number(result.toPrecision(15)) };
  } catch (error) {
    return { error: error.message };
  }
}

function currentTime(timeZone) {
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'UTC';
  if (zone.length > 100) return { error: 'Time zone too long.' };
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full', timeStyle: 'long', timeZone: zone, hour12: false
    });
    const resolvedTimeZone = formatter.resolvedOptions().timeZone;
    return { timeZone: resolvedTimeZone, localTime: formatter.format(new Date()), isoTime: new Date().toISOString() };
  } catch {
    return { error: 'Use valid IANA timezone, e.g. Asia/Dhaka or Europe/London.' };
  }
}

function summary(tool, result) {
  if (result.error) return `${tool.name} could not run: ${result.error}`;
  if (tool.id === 'calculator') return `Calculator: ${result.expression} = ${result.result}`;
  if (tool.id === 'read_skill') return `Read skill: ${result.name}`;
  if (tool.id === 'current_time') return `Current time: ${result.localTime} (${result.timeZone})`;
  if (tool.id === 'list_files') return `Listed files in ${result.directory} (${result.entryCount} entries)`;
  if (tool.id === 'read_file') return `Read file: ${result.path}`;
  if (tool.id === 'write_file') return `Wrote file: ${result.path} (${result.bytes} bytes)`;
  if (tool.id === 'edit_file') return `Edited file: ${result.path} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'})`;
  if (tool.id === 'create_file') return `Created file: ${result.path} (${result.bytes} bytes)`;
  if (tool.id === 'create_folder') return result.created ? `Created folder: ${result.path}` : `Folder already exists: ${result.path}`;
  if (tool.id === 'delete_file') return `Deleted file: ${result.path}`;
  if (tool.id === 'delete_folder') return `Deleted folder: ${result.path}${result.recursive ? ' and its contents' : ''}`;
  if (tool.id === 'rename_file') return `Renamed file: ${result.from} → ${result.to}`;
  if (tool.id === 'rename_folder') return `Renamed folder: ${result.from} → ${result.to}`;
  if (tool.id === 'run_shell') {
    const firstLine = String(result.command || '').split('\n')[0];
    const compact = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
    if (result.killedByStop) return `Shell command killed when the response was stopped: ${compact}`;
    if (result.timedOut) return `Shell command timed out and was killed: ${compact}`;
    return `Shell command exited ${result.exitCode}: ${compact}`;
  }
  if (tool.id === 'sql_query') return `SQL query returned ${result.rowCount} rows`;
  if (tool.id === 'web_search') return `Web search: "${result.query}" (${result.results.length} results)`;
  if (tool.id === 'fetch_url') return `Fetched ${result.url}`;
  if (tool.id === 'search_conversations') return `Searched chats: "${result.query}" (${result.matchCount} match${result.matchCount === 1 ? '' : 'es'})`;
  if (tool.id === 'read_conversation') return `Read ${result.returned} of ${result.messageCount} messages in "${result.title}"${result.hasMore ? ' — more available' : ''}`;
  return tool.name;
}

// Robust argument parser: handles stringified JSON, plain objects, and common model mistakes
function parseToolArguments(rawArgs, toolId) {
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') {
    return {};
  }
  // Already an object (some providers like Ollama, Groq, Anthropic via compat)
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs;
  }
  if (typeof rawArgs !== 'string') {
    throw new Error(`Arguments for ${toolId} must be JSON object, got ${typeof rawArgs}`);
  }
  const trimmed = rawArgs.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Not an object');
    }
    return parsed;
  } catch (e) {
    // Try to salvage common mistakes: single quotes, trailing commas, etc.
    // First try to fix single quotes to double (naive but helps)
    try {
      // Replace single-quoted keys/values with double quotes if it looks like JSON with single quotes
      const fixed = trimmed
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
    throw new Error(`Tool arguments must be valid JSON object. Parse error: ${e.message}. Received: ${trimmed.slice(0, 200)}`);
  }
}

export async function executeToolCall(call, allowedToolIds, { getSkill, db, rootDirectory, workspaceDirectory, plugin, plugins, mcp, developerTools = null, stopSignal = null } = {}) {
  const workspaceRoot = workspaceDirectory || rootDirectory;
  const id = typeof call?.function?.name === 'string' ? call.function.name : (typeof call?.name === 'string' ? call.name : '');
  
  if (mcp && id.startsWith(MCP_TOOL_PREFIX) && allowedToolIds.has(id)) {
    return executeMcpTool(call, mcp);
  }
  
  // GitHub tools: support both single plugin and array of plugins (auto-discovery)
  if (id.startsWith('github_') && allowedToolIds.has(id)) {
    // If explicit plugin provided, use it
    if (plugin) {
      return executeGithubTool(call, { db, pluginId: plugin.pluginId, workspaceDirectory: plugin.workspaceDirectory });
    }
    // If plugins array provided (auto-discovered), use first available
    if (Array.isArray(plugins) && plugins.length > 0) {
      const first = plugins[0];
      return executeGithubTool(call, { db, pluginId: first.pluginId, workspaceDirectory: first.workspaceDirectory || workspaceRoot });
    }
    // Fallback: try to find any plugin with localClone via db if available
    if (db) {
      try {
        const { activeLocalClonePlugins } = await import('./plugins.js');
        const clones = activeLocalClonePlugins(db);
        if (clones.length > 0) {
          return executeGithubTool(call, { db, pluginId: clones[0].id, workspaceDirectory: workspaceRoot });
        }
      } catch {}
    }
    return { toolId: id || 'unknown', result: { error: 'GitHub plugin with local clone not configured. Enable it in Plugins settings.' }, summary: 'GitHub tool unavailable - no local clone' };
  }
  
  const tool = Object.hasOwn(toolCatalog, id) ? toolCatalog[id] : null;
  if (!tool || !allowedToolIds.has(id)) {
    return { toolId: id || 'unknown', result: { error: 'This tool is not available.' }, summary: 'An unavailable tool call was blocked.' };
  }
  
  let argumentsObject;
  try {
    argumentsObject = parseToolArguments(call.function?.arguments ?? call.arguments, id);
  } catch (error) {
    const result = { error: error.message };
    return { toolId: id, result, summary: summary(tool, result) };
  }
  
  if (id === 'read_skill') {
    if (typeof getSkill !== 'function') {
      const result = { error: 'Skill loading not available for this request.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    const skillId = argumentsObject.skillId || argumentsObject.id;
    if (!skillId || typeof skillId !== 'string') {
      const result = { error: 'skillId is required and must be string. Use id from skills catalog in system prompt.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    const skill = getSkill(skillId);
    if (!skill) {
      const result = { error: `Skill not found: ${skillId}. Use id listed in available skills catalog.` };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    const result = { skillId: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions };
    return { toolId: id, result, summary: summary(tool, result) };
  }
  
  if (developerTools) {
    if (FILE_MANAGEMENT_TOOL_IDS.includes(id) && developerTools.fileManagement === false) {
      const result = { error: 'File-management tools disabled in settings. Enable in Other settings -> Developer tools.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    if (SHELL_TOOL_IDS.includes(id) && developerTools.shell !== true) {
      const result = { error: 'Shell access disabled in settings. Enable in Other settings -> Developer tools -> Shell access.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
  }
  
  let result;
  try {
    if (id === 'calculator') {
      if (!argumentsObject.expression) {
        result = { error: 'expression is required, e.g. "12 * (5 + 1)"' };
      } else {
        result = calculator(argumentsObject.expression);
      }
    } else if (id === 'current_time') {
      result = currentTime(argumentsObject.timeZone);
    } else if (id === 'list_files') {
      result = listFiles(workspaceRoot, argumentsObject.path, { recursive: argumentsObject.recursive === true });
    } else if (id === 'read_file') {
      if (!argumentsObject.path) {
        result = { error: 'path is required, e.g. "notes/todo.md". Use list_files first to discover files.' };
      } else {
        result = readFile(workspaceRoot, argumentsObject.path, { offset: argumentsObject.offset, limit: argumentsObject.limit });
      }
    } else if (id === 'write_file') {
      if (!argumentsObject.path) {
        result = { error: 'path is required' };
      } else if (argumentsObject.content === undefined) {
        result = { error: 'content is required' };
      } else {
        result = writeFile(workspaceRoot, argumentsObject.path, argumentsObject.content);
      }
    } else if (id === 'edit_file') {
      if (!argumentsObject.path) {
        result = { error: 'path is required' };
      } else if (!Array.isArray(argumentsObject.edits) || argumentsObject.edits.length === 0) {
        result = { error: 'edits array is required with at least one {search, replace}. Read file first to get exact text.' };
      } else {
        result = editFile(workspaceRoot, argumentsObject.path, argumentsObject.edits, { replaceAll: argumentsObject.replaceAll === true });
      }
    } else if (id === 'create_file') {
      if (!argumentsObject.path || argumentsObject.content === undefined) {
        result = { error: 'path and content required' };
      } else {
        result = createFile(workspaceRoot, argumentsObject.path, argumentsObject.content);
      }
    } else if (id === 'create_folder') {
      if (!argumentsObject.path) {
        result = { error: 'path is required' };
      } else {
        result = createFolder(workspaceRoot, argumentsObject.path);
      }
    } else if (id === 'delete_file') {
      if (!argumentsObject.path) {
        result = { error: 'path is required' };
      } else {
        result = deleteFile(workspaceRoot, argumentsObject.path);
      }
    } else if (id === 'delete_folder') {
      if (!argumentsObject.path) {
        result = { error: 'path is required' };
      } else {
        result = deleteFolder(workspaceRoot, argumentsObject.path, { recursive: argumentsObject.recursive === true });
      }
    } else if (id === 'rename_file') {
      if (!argumentsObject.from || !argumentsObject.to) {
        result = { error: 'from and to paths required, both relative' };
      } else {
        result = renameFile(workspaceRoot, argumentsObject.from, argumentsObject.to);
      }
    } else if (id === 'rename_folder') {
      if (!argumentsObject.from || !argumentsObject.to) {
        result = { error: 'from and to required' };
      } else {
        result = renameFolder(workspaceRoot, argumentsObject.from, argumentsObject.to);
      }
    } else if (id === 'run_shell') {
      if (!argumentsObject.command) {
        result = { error: 'command is required, e.g. "ls -la"' };
      } else {
        result = await runShell(rootDirectory, argumentsObject.command, { timeoutMs: argumentsObject.timeoutMs, killSignal: stopSignal });
      }
    } else if (id === 'sql_query') {
      if (!argumentsObject.sql) {
        result = { error: 'sql is required, must be SELECT' };
      } else {
        result = sqlQuery(db, argumentsObject.sql);
      }
    } else if (id === 'web_search') {
      if (!argumentsObject.query) {
        result = { error: 'query is required, e.g. "Node.js 22 features"' };
      } else {
        result = await webSearch(argumentsObject.query, argumentsObject.maxResults);
      }
    } else if (id === 'fetch_url') {
      if (!argumentsObject.url) {
        result = { error: 'url is required, e.g. "https://example.com"' };
      } else {
        result = await fetchUrl(argumentsObject.url, argumentsObject.maxChars);
      }
    } else if (id === 'search_conversations') {
      if (!argumentsObject.query) {
        result = { error: 'query is required' };
      } else {
        result = searchConversations(db, argumentsObject.query, { limit: argumentsObject.limit });
      }
    } else if (id === 'read_conversation') {
      if (!argumentsObject.conversationId) {
        result = { error: 'conversationId is required from search_conversations' };
      } else {
        result = readConversation(db, argumentsObject.conversationId, { offset: argumentsObject.offset, limit: argumentsObject.limit, maxChars: argumentsObject.maxChars });
      }
    } else {
      result = { error: 'Tool not supported: ' + id };
    }
  } catch (error) {
    result = { error: `Tool ${id} execution failed: ${error.message}` };
  }
  
  return { toolId: id, result, summary: summary(tool, result) };
}
