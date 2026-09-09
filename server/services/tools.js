import { validation } from '../lib/errors.js';

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
  return `Current time: ${result.localTime} (${result.timeZone})`;
}

export function executeToolCall(call, allowedToolIds, { getSkill } = {}) {
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
  const result = id === 'calculator' ? calculator(argumentsObject.expression) : currentTime(argumentsObject.timeZone);
  return { toolId: id, result, summary: summary(tool, result) };
}
