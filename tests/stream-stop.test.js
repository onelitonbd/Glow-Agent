import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

// A chatty provider: a token every 25 ms, forever, until its own connection dies.
function slowStreamUpstream() {
  return createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let index = 0;
    const timer = setInterval(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `token-${index} ` } }] })}\n\n`);
      index += 1;
    }, 25);
    response.on('close', () => { clearInterval(timer); response.end(); });
  });
}

async function setup(t, { upstream }) {
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-stop-'));
  const instance = createApp({
    rootDirectory: directory,
    databasePath: join(directory, 'glow.sqlite'),
    providerFetchTimeoutMs: 3_000,
    chatTimeoutMs: 30_000,
    maxToolRounds: 4,
    maxProviderRetries: 0
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'P', baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/v1`, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  t.after(async () => {
    await close(appServer);
    instance.close();
    await close(upstreamServer);
    await rm(directory, { recursive: true, force: true });
  });
  return { base, provider, conversation, directory };
}

// The server saves the partial answer when the client disconnects; poll the conversation until
// the stopped message is visible (or give up after ~4 s).
async function waitForStoppedMessage(base, conversationId) {
  for (let attempt = 0; attempt < 28; attempt += 1) {
    const { payload } = await json(`${base}/conversations/${conversationId}`);
    const last = payload.data.messages.at(-1);
    if (last?.role === 'assistant' && Array.isArray(last.timeline) && last.timeline.some((entry) => entry?.type === 'stopped')) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

test('stopping mid-stream keeps the partial answer and marks it stopped', async (t) => {
  const { base, provider, conversation } = await setup(t, { upstream: slowStreamUpstream() });
  const controller = new AbortController();
  const response = await fetch(`${base}/conversations/${conversation.id}/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Count tokens for me.', providerId: provider.id, modelId: 'm' }),
    signal: controller.signal
  });
  assert.equal(response.status, 200);

  // Read a couple of tokens, then pull the plug exactly like the Stop button does.
  const decoder = new TextDecoder();
  let buffered = '';
  let received = 0;
  const reader = response.body.getReader();
  while (received < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    received = (buffered.match(/event: token/ug) || []).length;
  }
  assert.ok(received >= 2, 'the stream was really flowing before the stop');
  controller.abort();

  const stopped = await waitForStoppedMessage(base, conversation.id);
  assert.ok(stopped, 'a stopped assistant message was saved');
  assert.match(stopped.content, /token-0/u, 'early tokens survived');
  assert.doesNotMatch(stopped.content, /token-99/u, 'later tokens never were');
});

test('stopping while a command waits for approval settles the card and never runs it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glow-stop-approval-'));
  const marker = join(directory, 'marker.txt');
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const toolMessages = body.messages.filter((message) => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (toolMessages.length === 0) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: `touch ${marker} && echo done` }) } }] } }] })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Finished.' } }] })}\n\n`);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });
  const { base, provider, conversation } = await setup(t, { upstream });
  await json(`${base}/settings`, { method: 'PUT', body: { developerTools: { fileManagement: true, shell: true, confirmShell: true } } });

  const controller = new AbortController();
  const response = await fetch(`${base}/conversations/${conversation.id}/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Make my marker file.', providerId: provider.id, modelId: 'm' }),
    signal: controller.signal
  });
  assert.equal(response.status, 200);

  // Wait for the approval card to appear, then stop instead of deciding.
  const decoder = new TextDecoder();
  let buffered = '';
  let sawApproval = false;
  const reader = response.body.getReader();
  while (!sawApproval) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    sawApproval = buffered.includes('event: confirmation_required');
  }
  assert.ok(sawApproval, 'the approval card really appeared');
  controller.abort();

  const stopped = await waitForStoppedMessage(base, conversation.id);
  assert.ok(stopped, 'a stopped assistant message was saved');
  assert.equal(existsSync(marker), false, 'the gated command never ran');
  assert.ok(
    stopped.timeline.some((entry) => entry?.type === 'tool_result' && /not run|denied|stopped/iu.test(entry.summary || '')),
    'the tool result says the command did not run'
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(marker), false, 'and it still did not run after the stream settled');
});
