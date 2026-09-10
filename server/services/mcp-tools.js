import { mcpResultToText } from './mcp.js';

// Bridges MCP tools into the model's tool list.
//
// An MCP server advertises its tools with `tools/list`; each one has a name, a description and
// a JSON Schema input schema. Those are mapped 1:1 onto the function-calling tools the model
// already receives, with an `mcp_` prefix so they can never collide with a built-in tool. When
// the model calls one, `executeMcpTool` forwards it to the server with `tools/call`.
export const MCP_TOOL_PREFIX = 'mcp_';

// Tool ids are namespaced per server (mcp_<server>_<tool>) so two connected servers that both
// expose, say, a "search" tool cannot collide, and the model can tell which server a tool is on.
export function mcpToolId(serverKey, toolName) {
  const key = sanitizeToolName(serverKey).replace(/^mcp_/u, '') || 'server';
  return `${MCP_TOOL_PREFIX}${key}_${sanitizeToolName(toolName).replace(/^mcp_/u, '')}`.slice(0, 64);
}

// Verbs that indicate a tool changes something. Used only as a fallback when the server does
// not publish MCP tool annotations (`annotations.readOnlyHint`).
const MUTATING_NAME = /(create|update|delete|remove|push|pull|merge|close|reopen|edit|set|add|assign|unassign|apply|revert|rename|move|fork|release|submit|request|enable|disable|start|stop|cancel|rerun|retry|dismiss|resolve|lock|unlock|write|put|post|patch|save|sync|generate|install|deploy|publish|comment|review|star|unstar|follow|subscribe|unsubscribe)/u;

function sanitizeToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]+/gu, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '');
}

function clip(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Providers reject a `required` entry that is not a declared property, and they dislike
// `$schema`/`$id` on nested schemas, so the server schema is trimmed before it is forwarded.
function sanitizeSchema(rawSchema, depth = 0) {
  if (!rawSchema || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) {
    return { type: 'object', additionalProperties: false, properties: {} };
  }
  const schema = { ...rawSchema };
  delete schema.$schema;
  delete schema.$id;
  if (depth > 4) return { type: 'object', properties: {}, description: 'Nested schema omitted.' };
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      if (typeof key !== 'string') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        properties[key] = { ...sanitizeSchema(value, depth + 1), ...(typeof value.description === 'string' ? { description: clip(value.description, 600) } : {}) };
      } else {
        properties[key] = {};
      }
    }
    schema.properties = properties;
  } else {
    schema.properties = {};
  }
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((name) => typeof name === 'string' && Object.hasOwn(schema.properties, name));
    if (required.length) schema.required = required;
    else delete schema.required;
  } else {
    delete schema.required;
  }
  if (typeof schema.description === 'string') schema.description = clip(schema.description, 600);
  if (!schema.type) schema.type = 'object';
  return schema;
}

// MCP servers publish tool annotations (`readOnlyHint`, `destructiveHint`). Those are the
// authoritative signal; the name heuristic is only a fallback for servers that omit them.
export function isMutatingTool(tool) {
  const annotations = tool?.annotations;
  if (annotations && typeof annotations === 'object') {
    if (annotations.destructiveHint === true) return true;
    if (annotations.readOnlyHint === true) return false;
    if (annotations.readOnlyHint === false) return true;
  }
  return MUTATING_NAME.test(String(tool?.name || '').toLowerCase());
}

// Turns a server's tool list into { definitions, byName }. `definitions` are in the app's own
// tool shape so the existing openAiToolDefinitions() path works unchanged.
export function buildMcpToolset(tools, { serverKey = 'server', allowlist = [], readOnly = false } = {}) {
  const definitions = [];
  const byName = new Map();
  const allow = new Set(Array.isArray(allowlist) ? allowlist.filter((name) => typeof name === 'string') : []);
  for (const tool of Array.isArray(tools) ? tools : []) {
    const toolName = typeof tool?.name === 'string' ? tool.name : '';
    if (!toolName) continue;
    const mutating = isMutatingTool(tool);
    // In read-only mode mutating tools are never offered to the model at all.
    if (readOnly && mutating) continue;
    if (allow.size > 0 && !allow.has(toolName)) continue;
    const id = uniqueId(mcpToolId(serverKey, toolName), byName);
    const definition = {
      id,
      name: tool.title || toolName,
      description: clip(typeof tool.description === 'string' && tool.description.trim() ? tool.description : `MCP tool "${toolName}".`, 1500),
      parameters: sanitizeSchema(tool.inputSchema)
    };
    definitions.push(definition);
    byName.set(id, { id, toolName, mutating, description: definition.description });
  }
  return { definitions, byName };
}

function uniqueId(candidate, byName) {
  if (!byName.has(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    const attempt = `${candidate.slice(0, 60)}_${index}`;
    if (!byName.has(attempt)) return attempt;
  }
  return `${candidate.slice(0, 56)}_${Math.random().toString(36).slice(2, 8)}`;
}

function argumentObject(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarize(label, result) {
  // A blocked call carries an explanatory `error` too, so the blocked case is checked first.
  if (result && result.blocked) return `${label} needs your approval`;
  if (result && result.error) return `${label} failed: ${String(result.error).slice(0, 160)}`;
  const text = String(result?.text || '').trim();
  const firstLine = (text.split('\n')[0] || '').slice(0, 160);
  return firstLine ? `${label} → ${firstLine}` : `${label} completed`;
}

// Executes one MCP tool call. Mutating tools require the user's explicit approval first, which
// is the same "ask before writing to GitHub" rule the OAuth plugin used to enforce.
export async function executeMcpTool(call, ctx) {
  const id = typeof call?.function?.name === 'string' ? call.function.name : '';
  const entry = ctx?.byName?.get(id);
  if (!entry) {
    return { toolId: id || 'unknown', result: { error: 'That MCP tool is not available.' }, summary: 'An unavailable MCP tool call was blocked.' };
  }
  const label = `${entry.serverLabel || 'mcp'}:${entry.toolName}`;
  const args = argumentObject(call?.function?.arguments);
  if (args === null) {
    const result = { error: 'Tool arguments must be a JSON object.' };
    return { toolId: id, result, summary: summarize(label, result) };
  }
  // The approval belongs to the plugin that owns this tool, so approving one server never
  // silently unlocks another.
  if (entry.mutating && entry.writesApproved !== true) {
    const result = {
      blocked: true,
      error: `This tool changes data on the server and needs the user's approval. Ask the user to approve writes for this plugin, then call ${entry.toolName} again. Do not retry until they approve.`
    };
    return { toolId: id, result, summary: summarize(label, result) };
  }
  let result;
  try {
    const response = await entry.client.callTool(entry.toolName, args, { timeoutMs: entry.toolTimeoutMs });
    const text = mcpResultToText(response);
    result = response?.isError === true ? { ok: false, isError: true, error: text || 'The MCP tool reported an error.' } : { ok: true, text };
  } catch (error) {
    result = { error: error?.message || 'The MCP tool call failed.' };
  }
  return { toolId: id, result, summary: summarize(label, result) };
}
