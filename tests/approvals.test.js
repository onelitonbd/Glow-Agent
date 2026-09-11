import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalStore, approvals as sharedApprovals, APPROVAL_TIMEOUT_MS } from '../server/services/approvals.js';
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
  return { response, payload: response.status === 204 ? null : await response.json() };
}

// ---- the store itself ----------------------------------------------------------------------

test('an approval settles exactly once: decision, then everything else is ignored', async () => {
  const store = createApprovalStore({ timeoutMs: 5_000 });
  const approval = store.create({ conversationId: 'c1', toolId: 'run_shell', command: 'echo hi' });
  assert.equal(store.size(), 1);
  assert.equal(store.decide(approval.id, 'approved'), true);
  assert.equal(await approval.wait, 'approved');
  assert.equal(store.decide(approval.id, 'denied'), false, 'second decision is refused');
  assert.equal(store.decide('no-such-id', 'denied'), false);
  assert.equal(store.decide(approval.id, 'maybe'), false, 'invalid outcomes are refused');
  assert.equal(store.size(), 0);
});

test('approvals expire on their own when nobody decides', async () => {
  const store = createApprovalStore({ timeoutMs: 40 });
  const approval = store.create({ conversationId: 'c1', toolId: 'run_shell', command: 'sleep 1' });
  assert.equal(await approval.wait, 'expired');
  assert.equal(store.size(), 0);
});

test('abortConversation settles only that conversation’s pending approvals', async () => {
  const store = createApprovalStore({ timeoutMs: 5_000 });
  const one = store.create({ conversationId: 'c1', toolId: 'run_shell', command: 'a' });
  const two = store.create({ conversationId: 'c2', toolId: 'run_shell', command: 'b' });
  assert.equal(store.abortConversation('c1'), 1);
  assert.equal(await one.wait, 'aborted');
  assert.equal(store.decide(two.id, 'denied'), true);
  assert.equal(await two.wait, 'denied');
});

// ---- full stack: provider asks for a gated shell call -------------------------------------

function sseUpstream({ markerFile }) {
  const seen = { requests: [] };
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    seen.requests.push(body);
    const toolMessages = body.messages.filter((message) => message.role === 'tool');
    if (body.stream === true) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (toolMessages.length === 0) {
        const command = markerFile ? `touch ${markerFile} && echo marked` : 'echo phase-three';
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command }) } }] } }] })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Stream answer.' } }] })}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (toolMessages.length === 0) {
      response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'echo phase-three' }) } }] } }] }));
      return;
    }
    const last = toolMessages.at(-1);
    response.end(JSON.stringify({ choices: [{ message: { content: `Tool said: ${String(last.content)}` } }] }));
  });
  return { upstream, seen };
}

async function setup(t, { markerFile } = {}) {
  const { upstream, seen } = sseUpstream({ markerFile });
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-approvals-'));
  const instance = createApp({
    rootDirectory: directory,
    databasePath: join(directory, 'glow.sqlite'),
    providerFetchTimeoutMs: 3_000,
    chatTimeoutMs: 15_000,
    maxToolRounds: 4,
    maxProviderRetries: 0
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'P', baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/v1`, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });
  await json(`${base}/settings`, { method: 'PUT', body: { developerTools: { fileManagement: true, shell: true, confirmShell: true } } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  t.after(async () => {
    await close(appServer);
    instance.close();
    await close(upstreamServer);
    await rm(directory, { recursive: true, force: true });
  });
  return { base, provider, conversation, seen, directory };
}

// Reads the chat stream incrementally; on each confirmation_required block it POSTs the given
// decision, exactly like a user tapping the card. Returns the full stream text.
async function chatStreamDeciding({ base, conversationId, providerId, decision, onApproval }) {
  const response = await fetch(`${base}/conversations/${conversationId}/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'run it', providerId, modelId: 'm' })
  });
  assert.equal(response.status, 200);
  let full = '';
  let sawApproval = false;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      full += `${block}\n\n`;
      const event = /^event: (.+)$/mu.exec(block)?.[1];
      if (event !== 'confirmation_required' || sawApproval) continue;
      sawApproval = true;
      const data = /^data: (.+)$/mu.exec(block)?.[1];
      const payload = JSON.parse(data);
      const result = await json(`${base}/approvals/${payload.approvalId}`, { method: 'POST', body: { decision } });
      onApproval?.({ payload, result });
    }
  }
  full += buffer;
  return { full, sawApproval };
}

test('an approved shell command runs and the stream narrates the whole exchange', async (t) => {
  const { base, provider, conversation, seen } = await setup(t);
  const { full, sawApproval } = await chatStreamDeciding({
    base, conversationId: conversation.id, providerId: provider.id, decision: 'approve',
    onApproval: ({ payload, result }) => {
      assert.equal(payload.toolId, 'run_shell');
      assert.match(payload.command, /echo phase-three/u, 'the card shows the exact command');
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.data.status, 'approved');
    }
  });
  assert.equal(sawApproval, true);
  assert.match(full, /event: confirmation_resolved/u);
  assert.match(full, /Approved by user — Shell command exited 0/u);
  assert.match(full, /Stream answer\./u);
  const toolRound = seen.requests.find((body) => body.messages.some((message) => message.role === 'tool'));
  const toolMessage = toolRound.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /phase-three/u, 'the real command output reached the model');
});

test('a denied shell command never executes and the model is told', async (t) => {
  const markerDir = await mkdtemp(join(tmpdir(), 'glow-deny-'));
  t.after(() => rm(markerDir, { recursive: true, force: true }));
  const markerFile = join(markerDir, 'should-not-exist');
  const { base, provider, conversation, seen } = await setup(t, { markerFile });
  const { full, sawApproval } = await chatStreamDeciding({
    base, conversationId: conversation.id, providerId: provider.id, decision: 'deny',
    onApproval: ({ result }) => assert.equal(result.payload.data.status, 'denied')
  });
  assert.equal(sawApproval, true);
  assert.match(full, /Shell command denied by the user/u);
  assert.equal(existsSync(markerFile), false, 'a denied command must not run');
  const toolRound = seen.requests.find((body) => body.messages.some((message) => message.role === 'tool'));
  assert.match(toolRound.messages.find((message) => message.role === 'tool').content, /denied this command/u, 'the model learns the denial and the do-not-retry rule');
});

test('the plain JSON endpoint refuses gated calls instead of hanging', async (t) => {
  const { base, provider, conversation } = await setup(t);
  const response = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'run it', providerId: provider.id, modelId: 'm' }
  });
  assert.equal(response.response.status, 200);
  const assistant = response.payload.data.assistantMessage;
  const toolSummary = (assistant.toolEvents || []).find((event) => event.toolId === 'run_shell')?.summary || '';
  assert.match(toolSummary, /live chat stream/u);
  assert.match(assistant.content, /Tool said:/u, 'the exchange still completes');
  assert.match(assistant.content, /live chat stream/u, 'the model relays the refusal reason');
});

test('the approvals route validates input and unknown ids', async (t) => {
  const { base } = await setup(t);
  const bad = await json(`${base}/approvals/${crypto.randomUUID()}`, { method: 'POST', body: { decision: 'approve' } });
  assert.equal(bad.response.status, 404);
  const invalid = await json(`${base}/approvals/${crypto.randomUUID()}`, { method: 'POST', body: { decision: 'shrug' } });
  assert.equal(invalid.response.status, 400);
  assert.equal(sharedApprovals.size(), 0, 'no pending approvals leak between flows');
  assert.ok(APPROVAL_TIMEOUT_MS >= 60_000, 'production expiry stays generous');
});
