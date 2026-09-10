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

async function waitFor(condition, what, ms = 20_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

// A provider that answers slowly enough that "is it running right now?" is a real question, and
// that supports reasoning at `high` plus images but refuses file parts.
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
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (body.reasoning_effort) {
      if (body.reasoning_effort !== 'high') return send({ error: { message: 'unknown reasoning_effort' } }, 400);
      return send({ choices: [{ message: { reasoning_content: 'Working it out. ', content: '391' } }] });
    }
    const parts = Array.isArray(body.messages?.at(-1)?.content) ? body.messages.at(-1).content : null;
    if (parts?.some((part) => part.type === 'image_url')) return send({ choices: [{ message: { content: 'RED' } }] });
    if (parts?.some((part) => part.type === 'file')) return send({ error: { message: 'file parts are not supported' } }, 400);
    return send({ choices: [{ message: { content: 'READY' } }] });
  });
  return { calls, upstream };
}

async function start({ upstream }) {
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-auto-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(directory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 2_000,
    chatTimeoutMs: 5_000,
    autoTestIntervalMs: 60_000
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  return {
    base,
    instance,
    upstreamUrl,
    addProvider: (name) => json(`${base}/providers`, { method: 'POST', body: { name, baseUrl: upstreamUrl, apiKey: 'k' } }),
    cleanup: async () => {
      await close(appServer);
      instance.close();
      await close(upstreamServer);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('adding a model tests it by itself, and the report is ready without pressing anything', async (t) => {
  const { calls, upstream } = setup();
  const { base, instance, cleanup, addProvider } = await start({ upstream });
  t.after(cleanup);
  instance.autoTests.start();

  assert.deepEqual((await json(`${base}/tests/report`)).payload.data.entries, [], 'nothing is stored yet');

  const provider = (await addProvider('Auto')).payload.data;
  const added = await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'thinker' } });
  assert.equal(added.response.status, 201);

  // The status endpoint says what is happening while it happens.
  await waitFor(async () => {
    const status = (await json(`${base}/tests/auto`)).payload.data;
    return status.running === true || status.completedCount > 0;
  }, 'the automatic run to start');

  await waitFor(async () => {
    const status = (await json(`${base}/tests/auto`)).payload.data;
    return status.running === false && status.untested.length === 0;
  }, 'the automatic run to finish');

  const report = (await json(`${base}/tests/report`)).payload.data;
  assert.equal(report.entries.length, 1, 'the model was tested and the report saved');
  assert.equal(report.entries[0].modelId, 'thinker');
  assert.equal(report.entries[0].results.thinking.high.status, 'works');
  assert.equal(report.entries[0].results.vision.status, 'works');
  assert.equal(report.entries[0].results.files.status, 'rejected');
  assert.ok(calls.some((call) => call.reasoning_effort === 'high'), 'the probes really went to the provider');

  const status = (await json(`${base}/tests/auto`)).payload.data;
  assert.equal(status.completedCount, 1);
  assert.ok(status.lastFinishedAt, 'the run is stamped');
});

test('the capability report says what the composer may offer for each model', async (t) => {
  const { upstream } = setup();
  const { base, instance, cleanup, addProvider } = await start({ upstream });
  t.after(cleanup);
  instance.autoTests.start();

  const provider = (await addProvider('Caps')).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'thinker' } });
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'unprobed' } });

  // Before the run lands, the untested model is queued rather than declared incapable.
  const early = (await json(`${base}/tests/capabilities`)).payload.data;
  const queued = early.models.find((entry) => entry.modelId === 'unprobed' || entry.modelId === 'thinker');
  assert.ok(queued, 'both selected models are in the capability report');
  assert.equal(early.models.length, 2);

  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'both models to be tested');

  const after = (await json(`${base}/tests/capabilities`)).payload.data;
  const thinker = after.models.find((entry) => entry.modelId === 'thinker');
  assert.equal(thinker.tested, true);
  assert.equal(thinker.queued, false);
  assert.deepEqual(thinker.thinking.usable, ['high'], 'only the level the provider accepted is offered');
  assert.equal(thinker.thinking.best, 'high');
  assert.equal(thinker.images.usable, true, 'images are offered');
  assert.equal(thinker.files.usable, false, 'files are not');
  assert.match(thinker.files.reason, /file parts/u);

  const single = (await json(`${base}/tests/capabilities/${provider.id}/thinker`)).payload.data;
  assert.equal(single.tested, true);
  assert.deepEqual(single.thinking.usable, ['high']);
});

test('a file is refused for a model the test proved cannot take one, and accepted where it can', async (t) => {
  const { calls, upstream } = setup();
  const { base, instance, cleanup, addProvider } = await start({ upstream });
  t.after(cleanup);
  instance.autoTests.start();

  const provider = (await addProvider('Attach')).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'thinker' } });
  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'the model to be tested');

  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const tinyPdf = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4I6KBFTEMLQkAh11GAWmISxcAAAAASUVORK5CYII=';

  const refused = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: {
      message: 'Read this.',
      providerId: provider.id,
      modelId: 'thinker',
      attachments: [{ kind: 'file', name: 'notes.pdf', dataUrl: `data:application/pdf;base64,${tinyPdf}` }]
    }
  });
  assert.equal(refused.response.status, 400);
  assert.match(refused.payload.error.message, /does not accept file attachments/u);

  const accepted = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: {
      message: 'What colour is this?',
      providerId: provider.id,
      modelId: 'thinker',
      attachments: [{ kind: 'image', name: 'red.png', dataUrl: `data:image/png;base64,${tinyPng}` }]
    }
  });
  assert.equal(accepted.response.status, 200);

  // The image really travelled as a content part, and the question was stored with it.
  const asked = calls.find((call) => Array.isArray(call.messages?.at(-1)?.content)
    && call.messages.at(-1).content.some((part) => part.type === 'image_url' && String(part.image_url?.url).includes(tinyPng)));
  assert.ok(asked, 'the image reached the provider as an image_url part');

  const stored = (await json(`${base}/conversations/${conversation.id}`)).payload.data;
  const question = stored.messages.find((message) => message.role === 'user' && message.content === 'What colour is this?');
  assert.equal(question.attachments.length, 1);
  assert.equal(question.attachments[0].name, 'red.png');
  assert.equal(question.attachments[0].kind, 'image');

  // A follow-up still carries the image, so the model can be asked about it again.
  await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'And now?', providerId: provider.id, modelId: 'thinker' }
  });
  const replay = calls.find((call) => JSON.stringify(call.messages).includes('And now?')
    && JSON.stringify(call.messages).includes(tinyPng));
  assert.ok(replay, 'the earlier image is replayed to the provider with the next question');

  const oversized = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: {
      message: 'Too big.',
      providerId: provider.id,
      modelId: 'thinker',
      attachments: [{ kind: 'image', name: 'huge.png', dataUrl: `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}` }]
    }
  });
  assert.equal(oversized.response.status, 400);
  assert.match(oversized.payload.error.message, /limit is 5 MB/u);
});

test('turning automatic testing off stops the queue, and turning it back on clears the backlog', async (t) => {
  const { upstream } = setup();
  const { base, instance, cleanup, addProvider } = await start({ upstream });
  t.after(cleanup);
  instance.autoTests.start();

  const off = await json(`${base}/settings`, { method: 'PUT', body: { autoTesting: { enabled: false } } });
  assert.equal(off.response.status, 200);
  assert.deepEqual(off.payload.data.autoTesting, { enabled: false });

  const provider = (await addProvider('Paused')).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'waiting' } });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const paused = (await json(`${base}/tests/auto`)).payload.data;
  assert.equal(paused.enabled, false);
  assert.equal(paused.running, false, 'nothing runs while it is off');
  assert.deepEqual(paused.untested.map((entry) => entry.modelId), ['waiting'], 'the model is still listed as untested');
  assert.deepEqual((await json(`${base}/tests/report`)).payload.data.entries, [], 'and nothing was stored');

  await json(`${base}/settings`, { method: 'PUT', body: { autoTesting: { enabled: true } } });
  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'the backlog to clear');
  assert.equal((await json(`${base}/tests/report`)).payload.data.entries.length, 1, 'switching it on tested the waiting model');
});

test('replacing a provider key throws away its results so the models are measured again', async (t) => {
  const { upstream } = setup();
  const { base, instance, upstreamUrl, cleanup, addProvider } = await start({ upstream });
  t.after(cleanup);
  instance.autoTests.start();

  const provider = (await addProvider('Rekeyed')).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'thinker' } });
  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'the first test');
  assert.equal((await json(`${base}/tests/report`)).payload.data.entries.length, 1);

  const updated = await json(`${base}/providers/${provider.id}`, {
    method: 'PUT',
    body: { name: 'Rekeyed', baseUrl: upstreamUrl, apiKey: 'a-different-key' }
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual((await json(`${base}/tests/report`)).payload.data.entries, [], 'the old verdicts are gone');

  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'the re-test');
  const report = (await json(`${base}/tests/report`)).payload.data;
  assert.equal(report.entries.length, 1, 'and the model was measured again against the new key');
});

test('dropping a selected model drops its results, so re-adding it means testing it again', async (t) => {
  const { upstream } = setup();
  const { base, instance, cleanup, addProvider } = await start({ upstream });
  t.after(cleanup);
  instance.autoTests.start();

  const provider = (await addProvider('Dropped')).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'thinker' } });
  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'the first test');

  const selected = (await json(`${base}/providers/${provider.id}/models`)).payload.data;
  const removed = await json(`${base}/providers/${provider.id}/models/${selected[0].id}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 204);
  assert.deepEqual((await json(`${base}/tests/report`)).payload.data.entries, [], 'its results went with it');

  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'thinker' } });
  await waitFor(async () => (await json(`${base}/tests/auto`)).payload.data.untested.length === 0, 'the second test');
  assert.equal((await json(`${base}/tests/report`)).payload.data.entries.length, 1, 'it was tested again from scratch');
});
