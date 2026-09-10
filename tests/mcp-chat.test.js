import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, writeFileSync } from 'node:fs';
import { createApp } from '../server/app.js';
import { DIED_MARKER } from './fixtures/mcp-server.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
// Stands in for an MCP server that has gone away (see the fixture for how that is switched on).
const GONE_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server-exits.mjs', import.meta.url));

// `server.listen` returns the http.Server, which matters for the Express app instance: only the
// returned server has `address()`.
function listen(server) {
  return new Promise((resolve) => {
    const listening = server.listen(0, '127.0.0.1', () => resolve(listening));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function json(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

// Stands up the app with a fake model that always asks for one MCP tool first, then answers.
// Returns everything needed to assert on what the model was offered and what the tool returned.
// `script` may hold more than one tool call, which is how the two-server case is checked: the
// model asks for a tool on each server in turn.
async function setup({ calls, plugins = 1, binary = FIXTURE }) {
  const queue = [...calls];
  const seen = { requests: [] };
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    seen.requests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const toolMessages = body.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length < queue.length) {
      const next = queue[toolMessages.length];
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: `call_${toolMessages.length + 1}`, type: 'function', function: { name: next.toolName, arguments: JSON.stringify(next.toolArgs) } }]
          }
        }]
      }));
      return;
    }
    const last = toolMessages.at(-1);
    response.end(JSON.stringify({ choices: [{ message: { content: `Tool said: ${String(last.content).slice(0, 400)}` } }] }));
  });
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-mcp-chat-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(directory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 3_000,
    chatTimeoutMs: 5_000,
    maxToolRounds: 8,
    maxProviderRetries: 0
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const provider = (await json(`${base}/providers`, {
    method: 'POST',
    body: { name: 'P', baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/v1`, apiKey: 'k' }
  })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });

  // The Plugins page offers a fixed catalog, so a test adds the GitHub server from it. The
  // local-binary mode is what points that server at the fixture: the preset runs the configured
  // binary over stdio, exactly as it would run a real github-mcp-server.
  const installed = [];
  for (let index = 0; index < plugins; index += 1) {
    const plugin = (await json(`${base}/plugins`, { method: 'POST', body: { type: 'mcp', preset: 'github', name: `GitHub ${index + 1}` } })).payload.data;
    await json(`${base}/plugins/${plugin.id}/config`, {
      method: 'POST',
      body: { preset: 'github', github: { mode: 'local-binary', binary } }
    });
    const connect = await json(`${base}/plugins/${plugin.id}/connect`, { method: 'POST', body: {} });
    await json(`${base}/plugins/${plugin.id}`, { method: 'PUT', body: { enabled: true } });
    installed.push({ plugin, connect });
  }
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  return {
    base, provider, conversation, seen,
    plugin: installed[0].plugin,
    connect: installed[0].connect,
    installed,
    // The request no longer names a plugin: the server uses every enabled, connected one.
    respond: (conversationId, message) => json(`${base}/conversations/${conversationId}/respond`, {
      method: 'POST',
      body: { message, providerId: provider.id, modelId: 'm' }
    }),
    cleanup: async () => {
      await close(appServer);
      instance.close();
      await close(upstreamServer);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('an enabled MCP plugin gives the model that server\'s tools and runs them mid-conversation', async (t) => {
  const context = await setup({ calls: [{ toolName: 'mcp_github_read_thing', toolArgs: { id: 'chat-1' } }] });
  t.after(context.cleanup);
  assert.equal(context.connect.response.status, 200);

  const response = await context.respond(context.conversation.id, 'Read the thing.');
  assert.equal(response.response.status, 200);

  const firstRequest = context.seen.requests[0];
  const offered = firstRequest.tools.map((tool) => tool.function.name);
  assert.ok(offered.includes('mcp_github_read_thing'), `the server's tools reach the model: ${offered.join(', ')}`);
  assert.ok(offered.includes('calculator'), 'the built-in tools stay available alongside MCP tools');
  assert.deepEqual(firstRequest.tools.filter((tool) => tool.function.name.startsWith('mcp_')).length, 5, 'all five server tools are offered');
  const system = firstRequest.messages.find((message) => message.role === 'system').content;
  assert.match(system, /An MCP \(Model Context Protocol\) server is connected and its tools/u);
  assert.match(system, /fixture-mcp/u);
  assert.match(system, /blocked until the user approves/u);

  // The tool actually ran against the MCP server and its real output went back to the model.
  const toolMessage = context.seen.requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(JSON.parse(toolMessage.content).text).args.id, 'chat-1');
  assert.match(response.payload.data.assistantMessage.content, /chat-1/u);

  const timeline = response.payload.data.assistantMessage.timeline;
  assert.ok(timeline.some((entry) => entry.type === 'tool_call' && entry.name === 'mcp_github_read_thing'));
  assert.ok(timeline.some((entry) => entry.type === 'tool_result' && entry.summary.includes('read_thing')));
});

// The point of a catalog is that more than one server can be installed at once, so both must
// reach the model and each call must be routed to the server that owns the tool.
test('two installed MCP servers both reach the model and each tool runs on its own server', async (t) => {
  const context = await setup({
    plugins: 2,
    calls: [
      { toolName: 'mcp_github-1_describe_server', toolArgs: {} },
      { toolName: 'mcp_github-2_read_thing', toolArgs: { id: 'second' } }
    ]
  });
  t.after(context.cleanup);
  assert.deepEqual(context.installed.map((entry) => entry.connect.response.status), [200, 200]);

  const response = await context.respond(context.conversation.id, 'Ask both servers.');
  assert.equal(response.response.status, 200);

  const offered = context.seen.requests[0].tools.map((tool) => tool.function.name);
  assert.ok(offered.includes('mcp_github-1_read_thing'), `both servers' tools reach the model: ${offered.join(', ')}`);
  assert.ok(offered.includes('mcp_github-2_read_thing'));
  assert.equal(new Set(offered.filter((name) => name.startsWith('mcp_'))).size, 10, 'no id is shared between the two servers');

  // Each server is named in the system prompt so the model can tell them apart.
  const system = context.seen.requests[0].messages.find((message) => message.role === 'system').content;
  assert.match(system, /github-1/u);
  assert.match(system, /github-2/u);

  const toolMessages = context.seen.requests[2].messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.equal(JSON.parse(toolMessages[0].content).text, 'fixture-mcp 1.2.3');
  assert.equal(JSON.parse(JSON.parse(toolMessages[1].content).text).args.id, 'second');
  assert.match(response.payload.data.assistantMessage.content, /second/u);
});

test('a mutating MCP tool is blocked in chat until the user approves writes', async (t) => {
  const context = await setup({ calls: [{ toolName: 'mcp_github_write_thing', toolArgs: { id: 'w', value: 'v' } }] });
  t.after(context.cleanup);

  const blocked = await context.respond(context.conversation.id, 'Change the thing.');
  assert.equal(blocked.response.status, 200);
  const blockedTool = context.seen.requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(blockedTool.content).blocked, true);
  assert.match(JSON.parse(blockedTool.content).error, /needs the user's approval/u);

  // After the user approves, the same call goes through to the server.
  await json(`${context.base}/plugins/${context.plugin.id}/writes/approve`, { method: 'POST' });
  const second = await json(`${context.base}/conversations`, { method: 'POST' });
  const approved = await context.respond(second.payload.data.id, 'Change the thing.');
  assert.equal(approved.response.status, 200);
  // The last request the model made is the one carrying the tool result back.
  const approvedTool = context.seen.requests.at(-1).messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(approvedTool.content).text, 'wrote w');

  // The approval is one-shot: the next message needs it again.
  const third = await json(`${context.base}/conversations`, { method: 'POST' });
  await context.respond(third.payload.data.id, 'Change it again.');
  const thirdTool = context.seen.requests.at(-1).messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(thirdTool.content).blocked, true, 'write approval does not carry over to a later message');
});

test('a disabled plugin leaves the model with only the built-in tools', async (t) => {
  const context = await setup({ calls: [{ toolName: 'mcp_github_read_thing', toolArgs: { id: 'x' } }] });
  t.after(context.cleanup);
  await json(`${context.base}/plugins/${context.plugin.id}`, { method: 'PUT', body: { enabled: false } });
  const response = await context.respond(context.conversation.id, 'Read the thing.');
  assert.equal(response.response.status, 200);
  const offered = context.seen.requests[0].tools.map((tool) => tool.function.name);
  assert.equal(offered.some((name) => name.startsWith('mcp_')), false);
  assert.equal(context.seen.requests.length, 2, 'the unavailable tool call is answered, not sent to a server');
  const toolMessage = context.seen.requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).error, 'This tool is not available.');
});

// A server that disappears between connecting and the next message must not stall the reply: the
// model is told the plugin is unavailable instead.
test('a plugin whose server cannot be reached is reported to the model instead of breaking the message', async (t) => {
  rmSync(DIED_MARKER, { force: true });
  t.after(() => rmSync(DIED_MARKER, { force: true }));
  const context = await setup({ calls: [{ toolName: 'calculator', toolArgs: { expression: '1+1' } }], binary: GONE_FIXTURE });
  t.after(context.cleanup);
  // Connected for real, with a full tool list, so the plugin counts as usable.
  assert.equal(context.connect.response.status, 200);
  assert.equal(context.connect.payload.data.server.toolCount, 5);
  assert.ok(context.seen.requests[0] === undefined, 'the model has not been called yet');

  // Now the server goes away; nothing about the stored settings changes.
  writeFileSync(DIED_MARKER, 'gone');

  const response = await context.respond(context.conversation.id, 'Read the thing.');
  assert.equal(response.response.status, 200, 'the reply still completes');
  const offered = context.seen.requests[0].tools.map((tool) => tool.function.name);
  assert.equal(offered.some((name) => name.startsWith('mcp_')), false, 'no tools are offered from a server that is gone');
  const system = context.seen.requests[0].messages.find((message) => message.role === 'system').content;
  assert.match(system, /could not be reached/u, 'the model is told the plugin is unavailable');
  assert.match(system, /Do not retry the connection yourself/u);
});
