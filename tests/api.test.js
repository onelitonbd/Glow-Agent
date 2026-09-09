import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { executeToolCall, selectedTools } from '../server/services/tools.js';

function listen(server) {
  return new Promise((resolve) => {
    const listeningServer = server.listen(0, '127.0.0.1', () => resolve(listeningServer));
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

test('local API persists safe providers, skills, models, and a provider-backed response', async (t) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-test-'));
  let sawCredential = false;
  let sawSkillInstruction = false;
  let sawMarkdownInstruction = false;
  let sawToolResult = false;
  const upstream = createServer(async (request, response) => {
    if (request.headers.authorization === 'Bearer local-test-key') sawCredential = true;
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-test-mini' }, { id: 'gpt-test' }] }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      sawSkillInstruction = body.messages.some((message) => message.role === 'system' && message.content.includes('Answer in a compact checklist.'));
      sawMarkdownInstruction = body.messages.some((message) => message.role === 'system' && message.content.includes('GitHub-flavored Markdown'));
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        response.write('data: {"choices":[{"delta":{"reasoning_content":"Checking the details. "}}]}\n\n');
        await new Promise((resolve) => setTimeout(resolve, 5));
        response.write('data: {"choices":[{"delta":{"content":"Streaming "}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"answer."}}]}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      const toolResult = body.messages.find((message) => message.role === 'tool');
      if (!toolResult) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_calculator', type: 'function', function: { name: 'calculator', arguments: '{"expression":"12 * (5 + 1)"}' } }] } }] }));
        return;
      }
      sawToolResult = JSON.parse(toolResult.content).result === 72;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'A real local provider response.' } }] }));
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamServer = await listen(upstream);
  const upstreamPort = upstreamServer.address().port;
  const config = {
    rootDirectory: process.cwd(),
    databasePath: join(tempDirectory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 2_000,
    chatTimeoutMs: 2_000
  };
  const instance = createApp(config);
  const appServer = await listen(instance.app);
  const appPort = appServer.address().port;
  const base = `http://127.0.0.1:${appPort}/api/v1`;
  t.after(async () => {
    await close(appServer);
    instance.close();
    await close(upstreamServer);
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const health = await json(`${base}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.data.status, 'ok');
  const tools = await json(`${base}/tools`);
  assert.deepEqual(tools.payload.data.map((tool) => tool.id), ['calculator', 'current_time']);

  const created = await json(`${base}/providers`, {
    method: 'POST',
    body: { name: 'Test provider', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'local-test-key', backupKeys: ['fallback-test-key'] }
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.data.name, 'Test provider');
  assert.deepEqual(created.payload.data.keyStatus, { primaryAvailable: true, backupKeyCount: 1 });
  assert.equal(JSON.stringify(created.payload).includes('local-test-key'), false);
  const provider = created.payload.data;

  const safeList = await json(`${base}/providers`);
  assert.equal(safeList.response.status, 200);
  assert.equal(JSON.stringify(safeList.payload).includes('fallback-test-key'), false);

  const discovered = await json(`${base}/providers/${provider.id}/fetch-models`, { method: 'POST' });
  assert.deepEqual(discovered.payload.data.models, ['gpt-test', 'gpt-test-mini']);
  assert.equal(sawCredential, true);

  const model = await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'gpt-test-mini' } });
  assert.equal(model.response.status, 201);
  const duplicateModel = await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'gpt-test-mini' } });
  assert.equal(duplicateModel.response.status, 409);

  const skill = await json(`${base}/skills`, {
    method: 'POST',
    body: { name: 'Checklist', description: 'Keep responses actionable.', instructions: 'Answer in a compact checklist.' }
  });
  assert.equal(skill.response.status, 201);
  const updatedSkill = await json(`${base}/skills/${skill.payload.data.id}`, {
    method: 'PUT',
    body: { name: 'Checklist', description: 'Keep responses compact and actionable.', instructions: 'Answer in a compact checklist.' }
  });
  assert.equal(updatedSkill.payload.data.description, 'Keep responses compact and actionable.');

  const conversation = await json(`${base}/conversations`, { method: 'POST' });
  const response = await json(`${base}/conversations/${conversation.payload.data.id}/respond`, {
    method: 'POST',
    body: { message: 'Help me plan today.', providerId: provider.id, modelId: 'gpt-test-mini', skillIds: [skill.payload.data.id], toolIds: ['calculator'] }
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.payload.data.assistantMessage.content, 'A real local provider response.');
  assert.equal(response.payload.data.conversation.messages.length, 2);
  assert.equal(response.payload.data.assistantMessage.toolEvents[0].summary, 'Calculator: 12 * (5 + 1) = 72');
  assert.equal(sawSkillInstruction, true);
  assert.equal(sawMarkdownInstruction, true);
  assert.equal(sawToolResult, true);

  const streamingConversation = await json(`${base}/conversations`, { method: 'POST' });
  const streamingResponse = await fetch(`${base}/conversations/${streamingConversation.payload.data.id}/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'Stream this answer.', providerId: provider.id, modelId: 'gpt-test-mini' })
  });
  assert.equal(streamingResponse.headers.get('content-type').startsWith('text/event-stream'), true);
  const streamBody = await streamingResponse.text();
  assert.match(streamBody, /event: started/u);
  assert.match(streamBody, /event: thinking/u);
  assert.match(streamBody, /event: token/u);
  assert.match(streamBody, /event: completed/u);
  assert.ok(streamBody.indexOf('event: thinking') < streamBody.indexOf('event: token'));
  const streamedConversation = await json(`${base}/conversations/${streamingConversation.payload.data.id}`);
  assert.equal(streamedConversation.payload.data.messages[1].content, 'Streaming answer.');
  assert.equal(streamedConversation.payload.data.messages[1].reasoning, 'Checking the details. ');
});

test('allowlisted tools use a bounded arithmetic parser and safe time-zone handling', () => {
  const selected = selectedTools(['calculator', 'current_time']);
  const arithmetic = executeToolCall({ function: { name: 'calculator', arguments: '{"expression":"(2 + 3) * 4"}' } }, new Set(selected.map((tool) => tool.id)));
  assert.equal(arithmetic.result.result, 20);
  const rejected = executeToolCall({ function: { name: 'calculator', arguments: '{"expression":"process.exit()"}' } }, new Set(['calculator']));
  assert.match(rejected.result.error, /Expression must use/u);
  const clock = executeToolCall({ function: { name: 'current_time', arguments: '{"timeZone":"Asia/Dhaka"}' } }, new Set(['current_time']));
  assert.equal(clock.result.timeZone, 'Asia/Dhaka');
  const blocked = executeToolCall({ function: { name: 'shell', arguments: '{}' } }, new Set(['calculator']));
  assert.equal(blocked.result.error, 'This tool was not selected for this request.');
  const prototypeName = executeToolCall({ function: { name: '__proto__', arguments: '{}' } }, new Set(['calculator']));
  assert.equal(prototypeName.result.error, 'This tool was not selected for this request.');
});

test('invalid provider input is rejected without creating a record', async (t) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-validation-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(tempDirectory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 2_000,
    chatTimeoutMs: 2_000
  });
  const appServer = await listen(instance.app);
  const port = appServer.address().port;
  t.after(async () => {
    await close(appServer);
    instance.close();
    await rm(tempDirectory, { recursive: true, force: true });
  });
  const result = await json(`http://127.0.0.1:${port}/api/v1/providers`, {
    method: 'POST',
    body: { name: 'Bad provider', baseUrl: 'file:///not-allowed', apiKey: 'key' }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.error.code, 'VALIDATION_ERROR');
  const providers = await json(`http://127.0.0.1:${port}/api/v1/providers`);
  assert.deepEqual(providers.payload.data, []);
});
