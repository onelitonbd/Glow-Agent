import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { executeToolCall, selectedTools } from '../server/services/tools.js';
import { listFiles, readFile, sqlQuery, writeFile } from '../server/services/workspace-tools.js';
import { createDatabase } from '../server/db/database.js';

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
  let sawSkillCatalog = false;
  let sawMarkdownInstruction = false;
  let sawToolResult = false;
  let sawReadSkillTool = false;
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
      const systemContent = body.messages.find((message) => message.role === 'system')?.content || '';
      // Skills are advertised by id, name, and description; instructions are read on demand via read_skill.
      sawSkillCatalog = systemContent.includes('Checklist') && systemContent.includes('Keep responses compact and actionable.') && !systemContent.includes('Answer in a compact checklist.');
      sawMarkdownInstruction = systemContent.includes('GitHub-flavored Markdown');
      sawReadSkillTool = Array.isArray(body.tools) && body.tools.some((tool) => tool.function.name === 'read_skill');
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
  assert.deepEqual(tools.payload.data.map((tool) => tool.id), ['calculator', 'current_time', 'list_files', 'read_file', 'write_file', 'sql_query', 'web_search', 'fetch_url']);

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
  // The ordered timeline is persisted so the UI can replay thinks, response, tool calls, and results truthfully.
  const timeline = response.payload.data.assistantMessage.timeline || [];
  assert.equal(timeline.some((entry) => entry.type === 'tool_call' && entry.name === 'calculator'), true);
  assert.equal(timeline.some((entry) => entry.type === 'tool_result' && entry.summary.includes('= 72')), true);
  assert.equal(timeline.some((entry) => entry.type === 'content'), true);
  assert.equal(sawSkillCatalog, true);
  assert.equal(sawMarkdownInstruction, true);
  assert.equal(sawReadSkillTool, true);
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
  const streamTimeline = streamedConversation.payload.data.messages[1].timeline || [];
  // thinking precedes content in the recorded live timeline.
  const thinkingIndex = streamTimeline.findIndex((entry) => entry.type === 'thinking');
  const contentIndex = streamTimeline.findIndex((entry) => entry.type === 'content');
  assert.ok(thinkingIndex !== -1 && contentIndex !== -1 && thinkingIndex < contentIndex);
});

test('allowlisted tools use a bounded arithmetic parser and safe time-zone handling', async () => {
  const selected = selectedTools(['calculator', 'current_time']);
  const arithmetic = await executeToolCall({ function: { name: 'calculator', arguments: '{"expression":"(2 + 3) * 4"}' } }, new Set(selected.map((tool) => tool.id)));
  assert.equal(arithmetic.result.result, 20);
  const rejected = await executeToolCall({ function: { name: 'calculator', arguments: '{"expression":"process.exit()"}' } }, new Set(['calculator']));
  assert.match(rejected.result.error, /Expression must use/u);
  const clock = await executeToolCall({ function: { name: 'current_time', arguments: '{"timeZone":"Asia/Dhaka"}' } }, new Set(['current_time']));
  assert.equal(clock.result.timeZone, 'Asia/Dhaka');
  const blocked = await executeToolCall({ function: { name: 'shell', arguments: '{}' } }, new Set(['calculator']));
  assert.equal(blocked.result.error, 'This tool is not available.');
  const prototypeName = await executeToolCall({ function: { name: '__proto__', arguments: '{}' } }, new Set(['calculator']));
  assert.equal(prototypeName.result.error, 'This tool is not available.');
});

test('read_skill returns a skill\'s instructions on demand and blocks missing skills', async () => {
  const fakeSkill = { id: 'skill_id', name: 'Checklist', description: 'Keep responses actionable.', instructions: 'Answer in a compact checklist.' };
  const getSkill = (skillId) => skillId === fakeSkill.id ? fakeSkill : null;
  const loaded = await executeToolCall({ function: { name: 'read_skill', arguments: '{"skillId":"skill_id"}' } }, new Set(['read_skill']), { getSkill });
  assert.equal(loaded.result.instructions, 'Answer in a compact checklist.');
  assert.equal(loaded.summary, 'Read skill: Checklist');
  const missing = await executeToolCall({ function: { name: 'read_skill', arguments: '{"skillId":"nope"}' } }, new Set(['read_skill']), { getSkill });
  assert.match(missing.result.error, /Skill not found/u);
  const gated = await executeToolCall({ function: { name: 'read_skill', arguments: '{"skillId":"skill_id"}' } }, new Set([]), { getSkill });
  assert.equal(gated.summary, 'An unavailable tool call was blocked.');
});

test('workspace tools list, read, and write files safely within the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'glow-workspace-tool-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = writeFile(root, 'notes/demo.md', '# Hello\n\nWorld.\n');
  assert.equal(write.wrote, true);
  const read = readFile(root, 'notes/demo.md');
  assert.equal(read.content.includes('World'), true);
  const list = listFiles(root, '');
  assert.equal(list.entryCount >= 1, true);
  const escape = readFile(root, '../outside.txt');
  assert.match(escape.error, /outside the workspace/u);
});

test('sql_query runs only read-only SELECT statements', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'glow-sql-test-'));
  const dbPath = join(dir, 'tool-sql-test.sqlite');
  const db = createDatabase(dbPath);
  t.after(() => { db.close(); });
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER, name TEXT);');
  db.exec('DELETE FROM t; INSERT INTO t VALUES (1, \'a\'), (2, \'b\');');
  const query = sqlQuery(db, 'SELECT * FROM t');
  assert.equal(query.rowCount, 2);
  const blocked = sqlQuery(db, 'DROP TABLE t');
  assert.match(blocked.error, /Only read-only/u);
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

test('streaming emits live tool_call and tool_result events and persists an ordered timeline', async (t) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-stream-tool-'));
  const upstream = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (!hasToolResult) {
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calculator","arguments":"{\\"expression\\":\\"12 * 6\\"}"}}]}}]}\n\n');
    } else {
      response.write('data: {"choices":[{"delta":{"content":"The result is "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"72."}}]}\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  const upstreamServer = await listen(upstream);
  const config = {
    rootDirectory: process.cwd(),
    databasePath: join(tempDirectory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 2_000,
    chatTimeoutMs: 2_000
  };
  const instance = createApp(config);
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  t.after(async () => {
    await close(appServer);
    instance.close();
    await close(upstreamServer);
    await rm(tempDirectory, { recursive: true, force: true });
  });
  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'P', baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/v1`, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const streamingResponse = await fetch(`${base}/conversations/${conversation.id}/respond/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'Compute 12 * 6.', providerId: provider.id, modelId: 'm' })
  });
  const body = await streamingResponse.text();
  assert.match(body, /event: tool_call/u);
  assert.match(body, /event: tool_result/u);
  assert.ok(body.indexOf('event: tool_call') < body.indexOf('event: tool_result'));
  assert.ok(body.indexOf('event: tool_result') < body.indexOf('event: token'));
  const saved = (await json(`${base}/conversations/${conversation.id}`)).payload.data;
  const timeline = saved.messages[1].timeline || [];
  assert.ok(timeline.some((entry) => entry.type === 'tool_call' && entry.name === 'calculator'));
  assert.ok(timeline.some((entry) => entry.type === 'tool_result' && entry.summary.includes('= 72')));
  assert.ok(timeline.some((entry) => entry.type === 'content'));
});
