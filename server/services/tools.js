import { fetchUrl, listFiles, readFile, sqlQuery, webSearch, writeFile } from './workspace-tools.js';
import { createFile, createFolder, deleteFile, deleteFolder, editFile, renameFile, renameFolder, runShell } from './developer-tools.js';
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
    description: 'Evaluate a basic arithmetic expression without using JavaScript eval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['expression'],
      properties: { expression: { type: 'string', description: 'Arithmetic using numbers, parentheses, +, -, *, and /.' } }
    }
  }),
  current_time: Object.freeze({
    id: 'current_time',
    name: 'Current time',
    description: 'Get the current date and time for an IANA time zone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { timeZone: { type: 'string', description: 'IANA time zone such as Asia/Dhaka. Defaults to UTC.' } }
    }
  }),
  read_skill: Object.freeze({
    id: 'read_skill',
    name: 'Read skill',
    description: 'Load the full instructions of a reusable skill by its id so you can follow them to answer the user request. Skill ids are listed in the available skills catalog.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['skillId'],
      properties: { skillId: { type: 'string', description: 'The id of the skill to read, as listed in the available skills catalog.' } }
    }
  }),
  list_files: Object.freeze({
    id: 'list_files',
    name: 'List files',
    description: 'List files and folders inside your workspace folder. Use it to find files before reading them. Lists one directory by default; set recursive to true to walk the whole tree.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root. Defaults to the root.' },
        recursive: { type: 'boolean', description: 'When true, walk the full subtree (up to 400 entries). Defaults to false (only the directory itself).' }
      }
    }
  }),
  read_file: Object.freeze({
    id: 'read_file',
    name: 'Read file',
    description: 'Read a text file from your workspace folder as UTF-8 text. Use a path relative to the workspace root. Large files are returned in pages: use offset and limit to continue reading.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root, for example notes/todo.md.' },
        offset: { type: 'integer', description: 'Character position to start reading from (default 0).' },
        limit: { type: 'integer', description: 'Maximum characters to return (default and maximum 262144).' }
      }
    }
  }),
  write_file: Object.freeze({
    id: 'write_file',
    name: 'Write file',
    description: 'Create or overwrite a text file in your workspace folder. Parent folders are created automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The text content to write.' }
      }
    }
  }),
  edit_file: Object.freeze({
    id: 'edit_file',
    name: 'Edit file',
    group: 'fileManagement',
    description: 'Make targeted search-and-replace edits to an existing text file in your workspace folder. Every search text must match exactly once unless replaceAll is true; the first failing edit stops the call so you know how far it got. Prefer this over write_file when changing part of a file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'edits'],
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        edits: {
          type: 'array',
          description: 'Ordered list of search/replace operations (max 25).',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['search', 'replace'],
            properties: {
              search: { type: 'string', description: 'Exact text to find, including surrounding context to make it unique.' },
              replace: { type: 'string', description: 'Replacement text (may be empty to delete).' }
            }
          }
        },
        replaceAll: { type: 'boolean', description: 'Allow each search text to match and replace multiple occurrences. Defaults to false.' }
      }
    }
  }),
  create_folder: Object.freeze({
    id: 'create_folder',
    name: 'Create folder',
    group: 'fileManagement',
    description: 'Create a new folder in your workspace folder, including any missing parent folders. Succeeds without changes if the folder already exists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'Folder path relative to the workspace root.' } }
    }
  }),
  create_file: Object.freeze({
    id: 'create_file',
    name: 'Create file',
    group: 'fileManagement',
    description: 'Create a new text file in your workspace folder. Fails if the file already exists: use edit_file to modify an existing file or write_file to replace it completely.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The text content for the new file.' }
      }
    }
  }),
  delete_folder: Object.freeze({
    id: 'delete_folder',
    name: 'Delete folder',
    group: 'fileManagement',
    description: 'Permanently delete a folder from your workspace folder. Only empty folders are deleted unless recursive is true. The workspace root itself can never be deleted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Folder path relative to the workspace root.' },
        recursive: { type: 'boolean', description: 'Delete the folder and everything inside it. Defaults to false.' }
      }
    }
  }),
  delete_file: Object.freeze({
    id: 'delete_file',
    name: 'Delete file',
    group: 'fileManagement',
    description: 'Permanently delete a single file from your workspace folder.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'File path relative to the workspace root.' } }
    }
  }),
  rename_folder: Object.freeze({
    id: 'rename_folder',
    name: 'Rename folder',
    group: 'fileManagement',
    description: 'Rename or move a folder within your workspace folder. The destination must not already exist; missing destination parents are created.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'Current folder path relative to the workspace root.' },
        to: { type: 'string', description: 'New folder path relative to the workspace root.' }
      }
    }
  }),
  rename_file: Object.freeze({
    id: 'rename_file',
    name: 'Rename file',
    group: 'fileManagement',
    description: 'Rename or move a file within your workspace folder. The destination must not already exist; missing destination parents are created.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'Current file path relative to the workspace root.' },
        to: { type: 'string', description: 'New file path relative to the workspace root.' }
      }
    }
  }),
  run_shell: Object.freeze({
    id: 'run_shell',
    name: 'Shell command',
    group: 'shell',
    description: 'Run a one-off shell command from the app folder (outside your workspace folder; unsandboxed, as the local user). Use non-interactive commands only; the process group is killed at the timeout. Pipe large output through head/tail — captured output is truncated at 16 KB per stream. Commands referencing *.sqlite database files are refused. Only available when the user enables shell access in settings.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The shell command line, run with sh -c from the workspace root.' },
        timeoutMs: { type: 'integer', description: 'Kill the command after this many milliseconds (default 30000, max 120000).' }
      }
    }
  }),
  sql_query: Object.freeze({
    id: 'sql_query',
    name: 'SQL query',
    description: 'Run a read-only SELECT query against the local Glow Agent database.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: { sql: { type: 'string', description: 'A read-only SELECT statement. Write statements are blocked.' } }
    }
  }),
  web_search: Object.freeze({
    id: 'web_search',
    name: 'Web search',
    description: 'Search the web with DuckDuckGo and return a list of result titles, URLs, and short snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: { type: 'integer', description: 'Maximum number of results to return (default 5).' }
      }
    }
  }),
  fetch_url: Object.freeze({
    id: 'fetch_url',
    name: 'Fetch URL',
    description: 'Fetch a web page and return its readable text content (HTML tags removed).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The http or https URL to fetch.' },
        maxChars: { type: 'integer', description: 'Maximum number of characters to return (default 4000).' }
      }
    }
  })
});

export function listTools() {
  return Object.values(toolCatalog)
    .filter((tool) => tool.id !== 'read_skill')
    .map((tool) => ({ id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters, group: tool.group || null }));
}

// The tools actually offered to the model for a request: developer-tool groups drop out when
// the user has not enabled them in settings.
export function toolsForSettings(developerTools = {}) {
  const fileManagement = developerTools.fileManagement !== false;
  const shell = developerTools.shell === true;
  return listTools().filter((tool) => {
    if (FILE_MANAGEMENT_TOOL_IDS.includes(tool.id)) return fileManagement;
    if (SHELL_TOOL_IDS.includes(tool.id)) return shell;
    return true;
  });
}

// read_skill is an internal mechanism that lets the model load skill instructions on demand,
// so it is not exposed as a user-selectable capability in the public tool list.
export function readSkillTool() {
  const tool = toolCatalog.read_skill;
  return { id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters };
}

export function openAiToolDefinitions(tools) {
  return tools.map((tool) => ({ type: 'function', function: { name: tool.id, description: tool.description, parameters: tool.parameters } }));
}

// Tool results enter the provider context as JSON text. An uncapped result (a big file read, a
// long listing) could blow the context window, so oversized results shrink to a preview the
// model can page through with read_file instead.
export const TOOL_RESULT_LIMIT = 32_000;

export function serializeToolResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= TOOL_RESULT_LIMIT) return json;
  if (result && typeof result === 'object' && typeof result.content === 'string') {
    const keep = Math.max(1_000, TOOL_RESULT_LIMIT - 500);
    const shrunk = { ...result, content: `${result.content.slice(0, keep)}\n…[truncated — call the tool again with an offset to continue]`, truncated: true };
    const shrunkJson = JSON.stringify(shrunk);
    if (shrunkJson.length <= TOOL_RESULT_LIMIT * 1.25) return shrunkJson;
  }
  return JSON.stringify({ truncated: true, note: 'The tool result was too large to return in full; a JSON preview follows.', preview: json.slice(0, TOOL_RESULT_LIMIT) });
}

function calculator(expression) {
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > 200 || !/^[\d+\-*/().\s]+$/u.test(expression)) {
    return { error: 'Expression must use up to 200 characters of numbers, parentheses, decimals, and +, -, *, or /.' };
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
    if (!Number.isFinite(number) || Math.abs(number) > 1e15) throw new Error('Result is outside the calculator safety range.');
    return number;
  };
  const factor = () => {
    if (consume('+')) return factor();
    if (consume('-')) return safe(-factor());
    if (consume('(')) {
      const value = expressionRule();
      if (!consume(')')) throw new Error('A closing parenthesis is missing.');
      return value;
    }
    const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/u);
    if (!match) throw new Error('Expected a number or opening parenthesis.');
    index += match[0].length;
    return safe(Number(match[0]));
  };
  const term = () => {
    let value = factor();
    while (peek() === '*' || peek() === '/') {
      const operator = peek(); index += 1;
      const next = factor();
      if (operator === '/' && next === 0) throw new Error('Division by zero is not allowed.');
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
    if (index !== source.length) throw new Error('Expression contains an unexpected token.');
    return { expression, result: Number(result.toPrecision(15)) };
  } catch (error) {
    return { error: error.message };
  }
}

function currentTime(timeZone) {
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'UTC';
  if (zone.length > 100) return { error: 'Time zone is too long.' };
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full', timeStyle: 'long', timeZone: zone, hour12: false
    });
    const resolvedTimeZone = formatter.resolvedOptions().timeZone;
    return { timeZone: resolvedTimeZone, localTime: formatter.format(new Date()), isoTime: new Date().toISOString() };
  } catch {
    return { error: 'Use a valid IANA time zone, such as Asia/Dhaka or Europe/London.' };
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
    const compact = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    if (result.timedOut) return `Shell command timed out and was killed: ${compact}`;
    return `Shell command exited ${result.exitCode}: ${compact}`;
  }
  if (tool.id === 'sql_query') return `SQL query returned ${result.rowCount} rows`;
  if (tool.id === 'web_search') return `Web search: "${result.query}" (${result.results.length} results)`;
  if (tool.id === 'fetch_url') return `Fetched ${result.url}`;
  return tool.name;
}

export async function executeToolCall(call, allowedToolIds, { getSkill, db, rootDirectory, workspaceDirectory, plugin, mcp, developerTools = null } = {}) {
  // File tools live in the assistant's own workspace folder: the app directory itself — code,
  // skills, settings, the database — is unreachable through them. (Caller-side shortcuts that
  // only pass rootDirectory simply confine the tools to that root instead.)
  const workspaceRoot = workspaceDirectory || rootDirectory;
  const id = typeof call?.function?.name === 'string' ? call.function.name : '';
  // MCP tools come from the connected MCP server; the `mcp` context carries the live session
  // and the name map built from that server's tools/list response.
  if (mcp && id.startsWith(MCP_TOOL_PREFIX) && allowedToolIds.has(id)) {
    return executeMcpTool(call, mcp);
  }
  if (plugin && id.startsWith('github_') && allowedToolIds.has(id)) {
    return executeGithubTool(call, { db, pluginId: plugin.pluginId, workspaceDirectory: plugin.workspaceDirectory });
  }
  const tool = Object.hasOwn(toolCatalog, id) ? toolCatalog[id] : null;
  if (!tool || !allowedToolIds.has(id)) {
    return { toolId: id || 'unknown', result: { error: 'This tool is not available.' }, summary: 'An unavailable tool call was blocked.' };
  }
  let argumentsObject;
  try {
    argumentsObject = JSON.parse(call.function.arguments || '{}');
    if (!argumentsObject || Array.isArray(argumentsObject) || typeof argumentsObject !== 'object') throw new Error();
  } catch {
    const result = { error: 'Tool arguments must be a JSON object.' };
    return { toolId: id, result, summary: summary(tool, result) };
  }
  if (id === 'read_skill') {
    if (typeof getSkill !== 'function') {
      const result = { error: 'Skill loading is not available for this request.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    const skill = getSkill(argumentsObject.skillId);
    if (!skill) {
      const result = { error: 'Skill not found. Use an id listed in the available skills catalog.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    const result = { skillId: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions };
    return { toolId: id, result, summary: summary(tool, result) };
  }
  // Defense in depth: even a call that arrives when the tool is in the allowed set (for
  // example a replayed or stale conversation) is refused when the settings gate is off.
  if (developerTools) {
    if (FILE_MANAGEMENT_TOOL_IDS.includes(id) && developerTools.fileManagement === false) {
      const result = { error: 'File-management tools are disabled in settings.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
    if (SHELL_TOOL_IDS.includes(id) && developerTools.shell !== true) {
      const result = { error: 'Shell access is disabled in settings.' };
      return { toolId: id, result, summary: summary(tool, result) };
    }
  }
  let result;
  if (id === 'calculator') result = calculator(argumentsObject.expression);
  else if (id === 'current_time') result = currentTime(argumentsObject.timeZone);
  else if (id === 'list_files') result = listFiles(workspaceRoot, argumentsObject.path, { recursive: argumentsObject.recursive === true });
  else if (id === 'read_file') result = readFile(workspaceRoot, argumentsObject.path, { offset: argumentsObject.offset, limit: argumentsObject.limit });
  else if (id === 'write_file') result = writeFile(workspaceRoot, argumentsObject.path, argumentsObject.content);
  else if (id === 'edit_file') result = editFile(workspaceRoot, argumentsObject.path, argumentsObject.edits, { replaceAll: argumentsObject.replaceAll === true });
  else if (id === 'create_file') result = createFile(workspaceRoot, argumentsObject.path, argumentsObject.content);
  else if (id === 'create_folder') result = createFolder(workspaceRoot, argumentsObject.path);
  else if (id === 'delete_file') result = deleteFile(workspaceRoot, argumentsObject.path);
  else if (id === 'delete_folder') result = deleteFolder(workspaceRoot, argumentsObject.path, { recursive: argumentsObject.recursive === true });
  else if (id === 'rename_file') result = renameFile(workspaceRoot, argumentsObject.from, argumentsObject.to);
  else if (id === 'rename_folder') result = renameFolder(workspaceRoot, argumentsObject.from, argumentsObject.to);
  else if (id === 'run_shell') result = await runShell(rootDirectory, argumentsObject.command, { timeoutMs: argumentsObject.timeoutMs });
  else if (id === 'sql_query') result = sqlQuery(db, argumentsObject.sql);
  else if (id === 'web_search') result = await webSearch(argumentsObject.query, argumentsObject.maxResults);
  else if (id === 'fetch_url') result = await fetchUrl(argumentsObject.url, argumentsObject.maxChars);
  else result = { error: 'This tool is not supported.' };
  return { toolId: id, result, summary: summary(tool, result) };
}
