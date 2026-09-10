import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpClient, mcpResultToText, MCP_PROTOCOL_VERSION } from '../server/services/mcp.js';
import { MCP_TOOL_PREFIX, buildMcpToolset, executeMcpTool, isMutatingTool } from '../server/services/mcp-tools.js';
import { handleRequest, PROTOCOL_VERSION } from './fixtures/mcp-server.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('the MCP client completes the handshake and discovers tools over stdio', async () => {
  const client = new McpClient({ transport: 'stdio', command: process.execPath, args: ['--no-warnings', FIXTURE], fetchTimeoutMs: 10_000 });
  try {
    const info = await client.connect();
    assert.equal(info.name, 'fixture-mcp');
    assert.equal(info.version, '1.2.3');
    assert.equal(client.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(client.capabilities.tools, { listChanged: false });
    // tools/list is paginated; both pages must come back in one call.
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['read_thing', 'write_thing', 'delete_thing', 'describe_server', 'explode']);
    const result = await client.callTool('read_thing', { id: 'abc' });
    assert.equal(JSON.parse(mcpResultToText(result)).args.id, 'abc');
    const failure = await client.callTool('explode', {});
    assert.equal(failure.isError, true);
    assert.equal(mcpResultToText(failure), 'The thing exploded.');
  } finally {
    await client.close();
  }
  // The child process must not outlive the request.
  assert.equal(client.connected, false);
});

test('the MCP client speaks Streamable HTTP, sending the protocol version and session headers', async () => {
  const seen = { headers: [], sessions: [] };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      seen.headers.push({
        method: message.method,
        protocolVersion: request.headers['mcp-protocol-version'] || '',
        session: request.headers['mcp-session-id'] || '',
        accept: request.headers.accept || ''
      });
      if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== 'sess-1') {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Missing session id' } }));
        return;
      }
      const reply = handleRequest(message);
      if (!reply) { response.writeHead(202).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
      response.end(JSON.stringify(reply));
    });
  });
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new McpClient({ transport: 'http', url, headers: { Authorization: 'Bearer test-token' }, fetchTimeoutMs: 5_000 });
  try {
    await client.connect();
    assert.equal(client.protocolVersion, MCP_PROTOCOL_VERSION);
    const tools = await client.listTools();
    assert.equal(tools.length, 5);
    assert.equal((await client.callTool('describe_server', {})).content[0].text, 'fixture-mcp 1.2.3');
  } finally {
    await client.close();
    await close(server);
  }
  const initialize = seen.headers.find((entry) => entry.method === 'initialize');
  assert.equal(initialize.session, '', 'the session id does not exist before the handshake');
  assert.equal(initialize.accept, 'application/json, text/event-stream');
  const later = seen.headers.filter((entry) => entry.method === 'tools/list');
  assert.ok(later.length > 0);
  for (const entry of later) {
    assert.equal(entry.protocolVersion, MCP_PROTOCOL_VERSION, 'every request after the handshake declares the protocol version');
    assert.equal(entry.session, 'sess-1', 'the issued session id is echoed back');
  }
});

test('the MCP client reads a Server-Sent Events reply and skips the notifications on that stream', async () => {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      const reply = handleRequest(message);
      if (!reply) { response.writeHead(202).end(); return; }
      if (message.method !== 'tools/call') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
        return;
      }
      // Answer as a request-scoped SSE stream: one progress notification, then the response.
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
      response.write(`data: ${JSON.stringify(reply)}\n\n`);
      response.end();
    });
  });
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new McpClient({ transport: 'http', url, fetchTimeoutMs: 5_000 });
  try {
    await client.connect();
    const result = await client.callTool('write_thing', { id: 'x', value: 'y' });
    assert.equal(mcpResultToText(result), 'wrote x');
    assert.deepEqual(result.structuredContent, { id: 'x', value: 'y' });
  } finally {
    await client.close();
    await close(server);
  }
});

test('an MCP server that rejects the credentials surfaces a readable auth error', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Bad credentials' } }));
  });
  await listen(server);
  const client = new McpClient({ transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, fetchTimeoutMs: 5_000 });
  try {
    await assert.rejects(() => client.connect(), (error) => {
      assert.equal(error.code, 'MCP_UNAUTHORIZED');
      assert.match(error.message, /Bad credentials/u);
      return true;
    });
  } finally {
    await client.close();
    await close(server);
  }
});

test('a missing stdio command is reported instead of hanging', async () => {
  const client = new McpClient({ transport: 'stdio', command: 'definitely-not-installed-glow-agent', args: [], fetchTimeoutMs: 3_000 });
  try {
    await assert.rejects(() => client.connect(), (error) => {
      assert.match(error.message, /was not found|Could not start/u);
      return true;
    });
  } finally {
    await client.close();
  }
});

// executeMcpTool reads everything it needs from the map entry, which is how one merged map can
// serve tools from several servers. This mirrors what createMcpToolContext attaches.
function attach(tools, { serverKey = 'github', client = null, writesApproved = false, label } = {}) {
  const toolset = buildMcpToolset(tools, { serverKey });
  for (const entry of toolset.byName.values()) {
    entry.client = client;
    entry.writesApproved = writesApproved;
    entry.toolTimeoutMs = 5_000;
    entry.serverLabel = label || serverKey;
  }
  return toolset;
}

function recordingClient(tag, calls) {
  return {
    async callTool(name, args) {
      calls.push({ tag, name, args });
      return { content: [{ type: 'text', text: `${tag}:${name}` }] };
    }
  };
}

test('MCP tools are exposed to the model with a per-server mcp_ prefix and a provider-safe schema', () => {
  const { definitions, byName } = buildMcpToolset([
    { name: 'read_thing', description: 'Read one thing.', inputSchema: { $schema: 'x', type: 'object', properties: { id: { type: 'string' } }, required: ['id', 'missing'] } },
    { name: 'write_thing', description: 'Write one thing.', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }
  ], { serverKey: 'github' });
  assert.deepEqual(definitions.map((tool) => tool.id), [`${MCP_TOOL_PREFIX}github_read_thing`, `${MCP_TOOL_PREFIX}github_write_thing`]);
  const read = definitions[0];
  assert.equal(read.parameters.$schema, undefined, 'the $schema keyword is dropped');
  assert.deepEqual(read.parameters.required, ['id'], 'required entries that are not properties are dropped');
  assert.equal(byName.get(`${MCP_TOOL_PREFIX}github_read_thing`).toolName, 'read_thing');
  // The name the model sends is prefixed; the name sent to the server is not.
  assert.equal(byName.get(`${MCP_TOOL_PREFIX}github_write_thing`).mutating, true);
});

test('read-only mode hides mutating tools and annotations beat the name heuristic', () => {
  assert.equal(isMutatingTool({ name: 'anything', annotations: { readOnlyHint: true } }), false);
  assert.equal(isMutatingTool({ name: 'delete_thing' }), true, 'the name heuristic catches servers without annotations');
  const { definitions } = buildMcpToolset([
    { name: 'read_thing', annotations: { readOnlyHint: true }, inputSchema: {} },
    { name: 'write_thing', annotations: { readOnlyHint: false }, inputSchema: {} },
    { name: 'delete_thing', inputSchema: {} }
  ], { serverKey: 'github', readOnly: true });
  assert.deepEqual(definitions.map((tool) => tool.id), [`${MCP_TOOL_PREFIX}github_read_thing`]);
});

test('mutating MCP tools are blocked until the user approves writes', async () => {
  const calls = [];
  const client = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ran ${name}` }] };
    }
  };
  const tools = [
    { name: 'read_thing', annotations: { readOnlyHint: true }, inputSchema: {} },
    { name: 'write_thing', annotations: { readOnlyHint: false }, inputSchema: {} }
  ];
  const closed = attach(tools, { client, writesApproved: false });
  const readId = closed.definitions[0].id;
  const writeId = closed.definitions[1].id;

  const allowed = await executeMcpTool({ function: { name: readId, arguments: '{"id":"1"}' } }, { byName: closed.byName });
  assert.equal(allowed.result.text, 'ran read_thing');
  assert.deepEqual(calls.at(-1), { name: 'read_thing', args: { id: '1' } });

  const blocked = await executeMcpTool({ function: { name: writeId, arguments: '{"id":"1"}' } }, { byName: closed.byName });
  assert.equal(blocked.result.blocked, true);
  assert.match(blocked.result.error, /needs the user's approval/u);
  assert.equal(blocked.summary.includes('needs your approval'), true);
  assert.equal(calls.length, 1, 'a blocked tool never reaches the server');

  const open = attach(tools, { client, writesApproved: true });
  const approved = await executeMcpTool({ function: { name: writeId, arguments: '{"id":"1"}' } }, { byName: open.byName });
  assert.equal(approved.result.text, 'ran write_thing');
  assert.equal(calls.length, 2);
});

// Two servers may expose a tool with the same name; the model must still reach the right one.
test('tools from two servers stay separate and route to their own server', async () => {
  const calls = [];
  const one = recordingClient('one', calls);
  const two = recordingClient('two', calls);
  const a = attach([{ name: 'search', annotations: { readOnlyHint: true }, inputSchema: {} }], { serverKey: 'github', client: one });
  const b = attach([{ name: 'search', annotations: { readOnlyHint: true }, inputSchema: {} }, { name: 'delete_thing', inputSchema: {} }], { serverKey: 'github-2', client: two });
  const byName = new Map([...a.byName, ...b.byName]);
  const ids = [...a.definitions, ...b.definitions].map((tool) => tool.id);
  assert.deepEqual(ids, ['mcp_github_search', 'mcp_github-2_search', 'mcp_github-2_delete_thing']);
  assert.equal(byName.size, 3, 'no id is shared between the two servers');

  const first = await executeMcpTool({ function: { name: 'mcp_github_search', arguments: '{}' } }, { byName });
  const second = await executeMcpTool({ function: { name: 'mcp_github-2_search', arguments: '{}' } }, { byName });
  assert.equal(first.result.text, 'one:search');
  assert.equal(second.result.text, 'two:search');
  // The write gate belongs to the server the tool is on, not to the merged context.
  const blocked = await executeMcpTool({ function: { name: 'mcp_github-2_delete_thing', arguments: '{}' } }, { byName });
  assert.equal(blocked.result.blocked, true);
  assert.deepEqual(calls.map((call) => [call.tag, call.name]), [['one', 'search'], ['two', 'search']]);
});

test('an unknown or malformed MCP tool call is rejected without reaching the server', async () => {
  let called = false;
  const { byName } = attach([{ name: 'read_thing', annotations: { readOnlyHint: true }, inputSchema: {} }], { client: { callTool: async () => { called = true; return {}; } } });
  const unknown = await executeMcpTool({ function: { name: 'mcp_github_nope', arguments: '{}' } }, { byName });
  assert.equal(unknown.result.error, 'That MCP tool is not available.');
  const badArgs = await executeMcpTool({ function: { name: 'mcp_github_read_thing', arguments: 'not-json' } }, { byName });
  assert.match(badArgs.result.error, /JSON object/u);
  assert.equal(called, false);
});
