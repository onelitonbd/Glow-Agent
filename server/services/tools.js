import { validation } from '../lib/errors.js';
import { fetchUrl, listFiles, readFile, sqlQuery, webSearch, writeFile } from './workspace-tools.js';

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
    description: 'List files and folders inside the local workspace (the Glow Agent project directory). Use it to find files before reading them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root. Defaults to the root.' }
      }
    }
  }),
  read_file: Object.freeze({
    id: 'read_file',
    name: 'Read file',
    description: 'Read a text file from the local workspace as UTF-8 text. Use a path relative to the workspace root.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'File path relative to the workspace root, for example notes/todo.md.' } }
    }
  }),
  write_file: Object.freeze({
    id: 'write_file',
    name: 'Write file',
    description: 'Create or overwrite a text file in the local workspace. Parent folders are created automatically.',
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
    .map(({ id, name, description, parameters }) => ({ id, name, description, parameters }));
}

// read_skill is an internal mechanism that lets the model load skill instructions on demand,
// so it is not exposed as a user-selectable capability in the public tool list.
export function readSkillTool() {
  const tool = toolCatalog.read_skill;
  return { id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters };
}

export function selectedTools(rawToolIds) {
  if (rawToolIds === undefined) return [];
  if (!Array.isArray(rawToolIds) || rawToolIds.length > 5) throw validation('Tool selection must contain at most 5 tools.');
  const unique = [...new Set(rawToolIds)];
  if (!unique.every((id) => typeof id === 'string' && Object.hasOwn(toolCatalog, id))) {
    throw validation('One or more selected tools are not available.');
  }
  return unique.map((id) => toolCatalog[id]);
}

export function openAiToolDefinitions(tools) {
  return tools.map((tool) => ({ type: 'function', function: { name: tool.id, description: tool.description, parameters: tool.parameters } }));
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
  if (tool.id === 'sql_query') return `SQL query returned ${result.rowCount} rows`;
  if (tool.id === 'web_search') return `Web search: "${result.query}" (${result.results.length} results)`;
  if (tool.id === 'fetch_url') return `Fetched ${result.url}`;
  return tool.name;
}

export async function executeToolCall(call, allowedToolIds, { getSkill, db, rootDirectory } = {}) {
  const id = typeof call?.function?.name === 'string' ? call.function.name : '';
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
  let result;
  if (id === 'calculator') result = calculator(argumentsObject.expression);
  else if (id === 'current_time') result = currentTime(argumentsObject.timeZone);
  else if (id === 'list_files') result = listFiles(rootDirectory, argumentsObject.path);
  else if (id === 'read_file') result = readFile(rootDirectory, argumentsObject.path);
  else if (id === 'write_file') result = writeFile(rootDirectory, argumentsObject.path, argumentsObject.content);
  else if (id === 'sql_query') result = sqlQuery(db, argumentsObject.sql);
  else if (id === 'web_search') result = await webSearch(argumentsObject.query, argumentsObject.maxResults);
  else if (id === 'fetch_url') result = await fetchUrl(argumentsObject.url, argumentsObject.maxChars);
  else result = { error: 'This tool is not supported.' };
  return { toolId: id, result, summary: summary(tool, result) };
}
