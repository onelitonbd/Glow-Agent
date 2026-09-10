import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';

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

// A provider with two very different models. `capable` thinks at three levels, reads images, and
// calls tools but refuses file parts; `plain` only answers plain text. Every probe body is
// recorded so the test can check what was actually asked.
const CAPABLE_LEVELS = new Set(['low', 'medium', 'high']);

function setup() {
  const calls = [];
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const send = (payload, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (body.model === 'plain') {
      if (body.reasoning_effort) return send({ error: { message: 'reasoning_effort is not supported' } }, 400);
      const part = Array.isArray(body.messages?.[0]?.content) ? body.messages[0].content : null;
      if (part) return send({ error: { message: 'content parts are not supported' } }, 400);
      if (body.tools) return send({ error: { message: 'tools are not supported' } }, 400);
      return send({ choices: [{ message: { content: 'READY' } }] });
    }
    // capable
    if (body.reasoning_effort) {
      if (!CAPABLE_LEVELS.has(body.reasoning_effort)) return send({ error: { message: `unknown reasoning_effort ${body.reasoning_effort}` } }, 400);
      return send({ choices: [{ message: { reasoning_content: '17 * 23 = 17 * 20 + 17 * 3. ', content: '391' } }] });
    }
    const parts = Array.isArray(body.messages?.[0]?.content) ? body.messages[0].content : null;
    if (parts?.some((part) => part.type === 'image_url')) return send({ choices: [{ message: { content: 'RED' } }] });
    if (parts?.some((part) => part.type === 'file')) return send({ error: { message: 'file parts are not supported' } }, 400);
    // Only the probe asks for the tool. Answering every tool-enabled request with a call to a
    // tool this app does not have would send the chat into an endless tool loop.
    const lastText = typeof body.messages?.at(-1)?.content === 'string' ? body.messages.at(-1).content : '';
    if (body.tools && lastText.includes('Use the ping tool now')) {
      return send({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] });
    }
    return send({ choices: [{ message: { content: 'READY' } }] });
  });
  return { calls, upstream };
}

async function start({ upstream }) {
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-tests-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(directory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 2_000,
    chatTimeoutMs: 5_000
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'Probe', baseUrl: upstreamUrl, apiKey: 'k' } })).payload.data;
  for (const modelId of ['capable', 'plain']) {
    await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId } });
  }
  return {
    base,
    provider,
    cleanup: async () => {
      await close(appServer);
      instance.close();
      await close(upstreamServer);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('the testing page gathers every selected model and reports what each one really supports', async (t) => {
  const { calls, upstream } = setup();
  const { base, provider, cleanup } = await start({ upstream });
  t.after(cleanup);

  const models = (await json(`${base}/tests/models`)).payload.data;
  assert.deepEqual(models.map((entry) => entry.modelId), ['capable', 'plain'], 'both selected models are gathered');

  const runResponse = await fetch(`${base}/tests/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({})
  });
  const text = await runResponse.text();
  assert.match(text, /event: started/u, 'the run announces how many models it will test');
  assert.match(text, /Thinking level Extra High/u, 'each probe is reported as it runs');
  assert.match(text, /event: completed/u);

  const report = JSON.parse(text.split('\n\n').filter((block) => block.includes('event: completed'))
    .map((block) => block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join(''))[0]);
  assert.equal(report.entries.length, 2);
  assert.deepEqual(report.entries.map((entry) => entry.modelId), ['capable', 'plain'], 'the capable model ranks first');
  assert.deepEqual(report.entries.map((entry) => entry.rank), [1, 2]);

  const capable = report.entries[0];
  assert.deepEqual(
    ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => capable.results.thinking[id].status),
    ['works', 'works', 'works', 'rejected', 'rejected'],
    'a level is only "works" when reasoning actually came back'
  );
  assert.equal(capable.results.vision.status, 'works');
  assert.equal(capable.results.files.status, 'rejected');
  assert.equal(capable.results.tools.status, 'works');
  assert.match(capable.results.tools.reason, /ping/u);
  assert.ok(capable.score > report.entries[1].score, 'the ranking follows the score');

  const plain = report.entries[1];
  assert.equal(plain.results.baseline.status, 'works');
  assert.equal(plain.results.thinking.low.status, 'rejected');
  assert.equal(plain.results.vision.status, 'rejected');
  assert.equal(plain.results.tools.status, 'rejected');

  // Every probe really went to the provider.
  assert.ok(calls.some((call) => call.reasoning_effort === 'xhigh'), 'Extra High was probed');
  assert.ok(calls.some((call) => Array.isArray(call.messages?.[0]?.content) && call.messages[0].content.some((part) => part.type === 'image_url')), 'an image was sent');
  assert.ok(calls.some((call) => Array.isArray(call.messages?.[0]?.content) && call.messages[0].content.some((part) => part.type === 'file')), 'a file part was sent');
  assert.ok(calls.some((call) => Array.isArray(call.tools)), 'tools were offered');
});

test('results persist, and the chat only offers levels the model was proved to handle', async (t) => {
  const { upstream } = setup();
  const { base, provider, cleanup } = await start({ upstream });
  t.after(cleanup);

  assert.deepEqual((await json(`${base}/tests/report`)).payload.data.entries, [], 'nothing is stored before a run');

  // The body has to be read, otherwise the run has not finished when the report is fetched.
  const filtered = await (await fetch(`${base}/tests/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ models: [`${provider.id}:capable`] })
  })).text();
  assert.match(filtered, /event: completed/u);

  const stored = (await json(`${base}/tests/report`)).payload.data;
  assert.equal(stored.entries.length, 1, 'only the requested model was tested and stored');
  assert.equal(stored.entries[0].modelId, 'capable');

  const levels = (await json(`${base}/tests/levels/${provider.id}/capable`)).payload.data;
  assert.equal(levels.tested, true);
  assert.deepEqual(levels.levels.map((level) => [level.id, level.status]), [
    ['low', 'works'], ['medium', 'works'], ['high', 'works'], ['xhigh', 'rejected'], ['max', 'rejected']
  ]);

  const untested = (await json(`${base}/tests/levels/${provider.id}/plain`)).payload.data;
  assert.equal(untested.tested, false);
  assert.deepEqual(untested.levels.map((level) => level.status), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
});

test('a chosen thinking level is sent to the provider, and a made-up one is refused', async (t) => {
  const { calls, upstream } = setup();
  const { base, provider, cleanup } = await start({ upstream });
  t.after(cleanup);

  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const answered = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Why is the sky blue?', providerId: provider.id, modelId: 'capable', thinkingLevel: 'high' }
  });
  assert.equal(answered.response.status, 200);
  // messages[0] is the system prompt, so find the call carrying this question.
  const asked = calls.find((call) => JSON.stringify(call.messages).includes('Why is the sky blue?'));
  assert.ok(asked, 'the question reached the provider');
  assert.equal(asked.reasoning_effort, 'high', 'the level reached the provider as reasoning_effort');
  assert.equal(asked.model, 'capable');

  const withoutLevel = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'And at night?', providerId: provider.id, modelId: 'capable' }
  });
  assert.equal(withoutLevel.response.status, 200);
  assert.equal(calls.at(-1).reasoning_effort, undefined, 'no level means no parameter');

  const bogus = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Again.', providerId: provider.id, modelId: 'capable', thinkingLevel: 'ultra' }
  });
  assert.equal(bogus.response.status, 400);
  assert.equal(bogus.payload.error.code, 'VALIDATION_ERROR');
});
