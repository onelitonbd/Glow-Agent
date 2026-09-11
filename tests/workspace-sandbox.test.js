import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/app.js';

const listen = (server) => new Promise((resolve) => {
  const listening = server.listen(0, '127.0.0.1', () => resolve(listening));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

async function json(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, payload: await response.json() };
}

// First call asks the assistant's tools to write a file; after the tool result lands the
// provider answers with what the tool reported.
function fileToolUpstream() {
  return createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const toolMessages = body.messages.filter((message) => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (toolMessages.length === 0) {
      response.end(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/answer.txt', content: 'hello from the model' }) } }] } }]
      }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: `Done: ${String(toolMessages.at(-1).content).slice(0, 120)}` } }] }));
  });
}

test('the live chat loop writes through file tools into the assistant workspace, never the app root', async (t) => {
  const upstream = await listen(fileToolUpstream());
  const directory = await mkdtemp(join(tmpdir(), 'glow-sandbox-'));
  const workspaceDirectory = join(directory, 'data', 'workspace');
  const instance = createApp({
    rootDirectory: directory,
    databasePath: join(directory, 'glow.sqlite'),
    workspaceDirectory,
    providerFetchTimeoutMs: 3_000,
    chatTimeoutMs: 15_000,
    maxToolRounds: 4,
    maxProviderRetries: 0
  });
  const appServer = await listen(instance.app);
  t.after(async () => {
    await close(appServer);
    instance.close();
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;

  // The sandbox exists from boot, before any tool ever ran.
  assert.equal(existsSync(workspaceDirectory), true, 'the workspace folder is created when the app starts');

  const provider = (await json(`${base}/providers`, {
    method: 'POST',
    body: { name: 'P', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k' }
  })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;

  const { payload } = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Save a note for me.', providerId: provider.id, modelId: 'm' }
  });
  assert.match(payload.data.assistantMessage.content, /notes\/answer\.txt/u, 'the tool result is relayed');

  // The file lives in the assistant workspace, and nothing landed beside the app code.
  const written = join(workspaceDirectory, 'notes', 'answer.txt');
  assert.equal(existsSync(written), true);
  assert.equal(readFileSync(written, 'utf8'), 'hello from the model');
  assert.equal(existsSync(join(directory, 'notes')), false, 'the app root itself is untouched');
});
