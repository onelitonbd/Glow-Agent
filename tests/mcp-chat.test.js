import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

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
async function setup({ toolName, toolArgs }) {
  const seen = { requests: [] };
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    seen.requests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const toolMessage = body.messages.find((message) => message.role === 'tool');
    if (!toolMessage) {
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }]
          }
        }]
      }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: `Tool said: ${toolMessage.content.slice(0, 400)}` } }] }));
  });
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-mcp-chat-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(directory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 3_000,
    chatTimeoutMs: 5_000,
    maxToolRounds: 5,
    maxProviderRetries: 0
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const provider = (await json(`${base}/providers`, {
    method: 'POST',
    body: { name: 'P', baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/v1`, apiKey: 'k' }
  })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });
  const plugin = (await json(`${base}/plugins`, { method: 'POST', body: { type: 'mcp', preset: 'custom', name: 'Fixture' } })).payload.data;
  await json(`${base}/plugins/${plugin.id}/config`, {
    method: 'POST',
    body: { preset: 'custom', transport: 'stdio', command: process.execPath, args: ['--no-warnings', FIXTURE] }
  });
  const connect = await json(`${base}/plugins/${plugin.id}/connect`, { method: 'POST', body: {} });
  await json(`${base}/plugins/${plugin.id}`, { method: 'PUT', body: { enabled: true } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  return {
    base, provider, plugin, conversation, seen, connect,
    cleanup: async () => {
      await close(appServer);
      instance.close();
      await close(upstreamServer);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('an enabled MCP plugin gives the model that server\'s tools and runs them mid-conversation', async (t) => {
  const context = await setup({ toolName: 'mcp_read_thing', toolArgs: { id: 'chat-1' } });
  t.after(context.cleanup);
  assert.equal(context.connect.response.status, 200);

  const response = await json(`${context.base}/conversations/${context.conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Read the thing.', providerId: context.provider.id, modelId: 'm', pluginId: context.plugin.id }
  });
  assert.equal(response.response.status, 200);

  const firstRequest = context.seen.requests[0];
  const offered = firstRequest.tools.map((tool) => tool.function.name);
  assert.ok(offered.includes('mcp_read_thing'), `the server's tools reach the model: ${offered.join(', ')}`);
  assert.ok(offered.includes('calculator'), 'the built-in tools stay available alongside MCP tools');
  const system = firstRequest.messages.find((message) => message.role === 'system').content;
  assert.match(system, /Model Context Protocol/u);
  assert.match(system, /fixture-mcp/u);
  assert.match(system, /blocked until the user approves/u);

  // The tool actually ran against the MCP server and its real output went back to the model.
  const toolMessage = context.seen.requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(JSON.parse(toolMessage.content).text).args.id, 'chat-1');
  assert.match(response.payload.data.assistantMessage.content, /chat-1/u);

  const timeline = response.payload.data.assistantMessage.timeline;
  assert.ok(timeline.some((entry) => entry.type === 'tool_call' && entry.name === 'mcp_read_thing'));
  assert.ok(timeline.some((entry) => entry.type === 'tool_result' && entry.summary.includes('read_thing')));
});

test('a mutating MCP tool is blocked in chat until the user approves writes', async (t) => {
  const context = await setup({ toolName: 'mcp_write_thing', toolArgs: { id: 'w', value: 'v' } });
  t.after(context.cleanup);

  const blocked = await json(`${context.base}/conversations/${context.conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Change the thing.', providerId: context.provider.id, modelId: 'm', pluginId: context.plugin.id }
  });
  assert.equal(blocked.response.status, 200);
  const blockedTool = context.seen.requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(blockedTool.content).blocked, true);
  assert.match(JSON.parse(blockedTool.content).error, /needs the user's approval/u);

  // After the user approves, the same call goes through to the server.
  await json(`${context.base}/plugins/${context.plugin.id}/writes/approve`, { method: 'POST' });
  const second = await json(`${context.base}/conversations`, { method: 'POST' });
  const approved = await json(`${context.base}/conversations/${second.payload.data.id}/respond`, {
    method: 'POST',
    body: { message: 'Change the thing.', providerId: context.provider.id, modelId: 'm', pluginId: context.plugin.id }
  });
  assert.equal(approved.response.status, 200);
  // The last request the model made is the one carrying the tool result back.
  const approvedTool = context.seen.requests.at(-1).messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(approvedTool.content).text, 'wrote w');

  // The approval is one-shot: the next message needs it again.
  const third = await json(`${context.base}/conversations`, { method: 'POST' });
  await json(`${context.base}/conversations/${third.payload.data.id}/respond`, {
    method: 'POST',
    body: { message: 'Change it again.', providerId: context.provider.id, modelId: 'm', pluginId: context.plugin.id }
  });
  const thirdTool = context.seen.requests.at(-1).messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(thirdTool.content).blocked, true, 'write approval does not carry over to a later message');
});

test('a disabled plugin leaves the model with only the built-in tools', async (t) => {
  const context = await setup({ toolName: 'mcp_read_thing', toolArgs: { id: 'x' } });
  t.after(context.cleanup);
  await json(`${context.base}/plugins/${context.plugin.id}`, { method: 'PUT', body: { enabled: false } });
  const response = await json(`${context.base}/conversations/${context.conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Read the thing.', providerId: context.provider.id, modelId: 'm', pluginId: context.plugin.id }
  });
  assert.equal(response.response.status, 200);
  const offered = context.seen.requests[0].tools.map((tool) => tool.function.name);
  assert.equal(offered.some((name) => name.startsWith('mcp_')), false);
  assert.equal(context.seen.requests.length, 2, 'the unavailable tool call is answered, not sent to a server');
  const toolMessage = context.seen.requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).error, 'This tool is not available.');
});
