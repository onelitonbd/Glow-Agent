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

// One upstream serves both jobs: `titler` writes titles, everything else answers the chat. Every
// request is recorded so the test can say exactly which model was asked for what.
async function setup({ failTitle = false } = {}) {
  const calls = [];
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    if (body.model === 'titler') {
      if (failTitle) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'title model is down' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '"Planning a weekend trip to the mountains."' } }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Sure — here is a plan for the trip.' } }] }));
  });
  const upstreamServer = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-settings-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(directory, 'glow-agent.sqlite'),
    providerFetchTimeoutMs: 2_000,
    chatTimeoutMs: 5_000
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  return {
    calls,
    base,
    // The upstream a provider must point at — not the app's own URL.
    upstream: `http://127.0.0.1:${upstreamServer.address().port}`,
    cleanup: async () => {
      await close(appServer);
      instance.close();
      await close(upstreamServer);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('settings default to off and are validated before they are stored', async (t) => {
  const { base, upstream, cleanup } = await setup();
  t.after(cleanup);

  const defaults = await json(`${base}/settings`);
  assert.equal(defaults.response.status, 200);
  assert.deepEqual(defaults.payload.data, {
    titleGeneration: { enabled: false, providerId: null, modelId: null },
    systemPrompt: { text: '' },
    // Automatic capability testing is on unless the user turns it off.
    autoTesting: { enabled: true },
    // File management on, shell off, until the user changes them deliberately.
    developerTools: { fileManagement: true, shell: false, confirmShell: false }
  });

  const missing = await json(`${base}/settings`, { method: 'PUT', body: {} });
  assert.equal(missing.response.status, 400);

  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'Titles', baseUrl: upstream, apiKey: 'k' } })).payload.data;
  const unknownProvider = await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: true, providerId: '00000000-0000-4000-8000-000000000000', modelId: 'titler' } } });
  assert.equal(unknownProvider.response.status, 404);

  // Enabling needs both a provider and one of its selected models.
  const noModel = await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: true, providerId: provider.id, modelId: null } } });
  assert.equal(noModel.response.status, 400);
  const unselected = await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: true, providerId: provider.id, modelId: 'never-selected' } } });
  assert.equal(unselected.response.status, 400);

  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'titler' } });
  const saved = await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: true, providerId: provider.id, modelId: 'titler' } } });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.payload.data.titleGeneration, { enabled: true, providerId: provider.id, modelId: 'titler' });
  assert.deepEqual(saved.payload.data.systemPrompt, { text: '' }, 'saving titles leaves the prompt untouched');
  // Turning it off keeps the saved choice, so switching back on is one tap.
  const off = await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: false, providerId: provider.id, modelId: 'titler' } } });
  assert.deepEqual(off.payload.data.titleGeneration, { enabled: false, providerId: provider.id, modelId: 'titler' });

  // Developer tools: default fileManagement on / shell off, and a roundtrip through the API
  // returns the whole settings object so one card's save cannot clobber the other sections.
  const dev = await json(`${base}/settings`, { method: 'PUT', body: { developerTools: { fileManagement: false, shell: true } } });
  assert.equal(dev.response.status, 200);
  assert.deepEqual(dev.payload.data.developerTools, { fileManagement: false, shell: true, confirmShell: false });
  assert.deepEqual(dev.payload.data.titleGeneration, { enabled: false, providerId: provider.id, modelId: 'titler' });
  const invalidDev = await json(`${base}/settings`, { method: 'PUT', body: { developerTools: 'yes' } });
  assert.equal(invalidDev.response.status, 400);
});

test('the first answer of a new chat is named by the configured model, and only that one', async (t) => {
  const { base, upstream, calls, cleanup } = await setup();
  t.after(cleanup);

  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'Titles', baseUrl: upstream, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'alpha' } });
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'titler' } });
  await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: true, providerId: provider.id, modelId: 'titler' } } });

  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const first = (await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Help me plan a trip to the mountains.', providerId: provider.id, modelId: 'alpha' }
  })).payload.data;
  assert.equal(first.conversation.title, 'Planning a weekend trip to the mountains', 'quotes and the trailing stop are stripped');

  const titleCall = calls.find((call) => call.model === 'titler');
  assert.ok(titleCall, 'the title model was called');
  assert.equal(titleCall.messages.length, 2, 'a system prompt plus the exchange');
  assert.match(titleCall.messages[0].content, /8 to 10 words/u);
  assert.match(titleCall.messages[1].content, /Help me plan a trip to the mountains\./u, 'the user input is analysed');
  assert.match(titleCall.messages[1].content, /Sure — here is a plan for the trip\./u, 'the AI response is analysed');
  assert.equal(titleCall.tools, undefined, 'the title model is not given tools');
  assert.equal(calls.filter((call) => call.model === 'titler').length, 1);

  // A later message in the same chat leaves the title alone and never calls the title model.
  const second = (await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'And what should I pack?', providerId: provider.id, modelId: 'alpha' }
  })).payload.data;
  assert.equal(second.conversation.title, 'Planning a weekend trip to the mountains');
  assert.equal(calls.filter((call) => call.model === 'titler').length, 1, 'only the first message is named');

  // A different chat gets its own title.
  const other = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const named = (await json(`${base}/conversations/${other.id}/respond`, {
    method: 'POST',
    body: { message: 'Second chat, different subject.', providerId: provider.id, modelId: 'alpha' }
  })).payload.data;
  assert.equal(named.conversation.title, 'Planning a weekend trip to the mountains');
  assert.equal(calls.filter((call) => call.model === 'titler').length, 2);
});

test('a title failure never costs the answer: the chat falls back to the first words', async (t) => {
  const { base, upstream, calls, cleanup } = await setup({ failTitle: true });
  t.after(cleanup);

  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'Titles', baseUrl: upstream, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'alpha' } });
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'titler' } });
  await json(`${base}/settings`, { method: 'PUT', body: { titleGeneration: { enabled: true, providerId: provider.id, modelId: 'titler' } } });

  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const message = 'Help me plan a trip to the mountains and tell me what to pack for it.';
  const result = (await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message, providerId: provider.id, modelId: 'alpha' }
  })).payload.data;
  assert.equal(result.conversation.title, message.slice(0, 72), 'the fallback title is used');
  assert.equal(result.assistantMessage.content, 'Sure — here is a plan for the trip.', 'the answer still arrives');
  assert.equal(calls.filter((call) => call.model === 'titler').length, 1);
});

test('with the setting off nothing extra is asked of any model', async (t) => {
  const { base, upstream, calls, cleanup } = await setup();
  t.after(cleanup);

  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'Titles', baseUrl: upstream, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'alpha' } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const result = (await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'Help me plan a trip.', providerId: provider.id, modelId: 'alpha' }
  })).payload.data;
  assert.equal(result.conversation.title, 'Help me plan a trip.');
  assert.equal(calls.filter((call) => call.model === 'titler').length, 0);
});

test('a saved system prompt reaches the model on every message, and clearing it takes it away', async (t) => {
  const { base, upstream, calls, cleanup } = await setup();
  t.after(cleanup);

  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'Titles', baseUrl: upstream, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'alpha' } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  const ask = { providerId: provider.id, modelId: 'alpha' };
  const systemOf = (call) => call.messages.find((message) => message.role === 'system')?.content || '';

  // Nothing saved yet: the built-in instructions only.
  await json(`${base}/conversations/${conversation.id}/respond`, { method: 'POST', body: { message: 'First question.', ...ask } });
  assert.equal(systemOf(calls.at(-1)).includes('standing instructions'), false);
  assert.match(systemOf(calls.at(-1)), /GitHub-flavored Markdown/u, 'the built-in instructions are still there');

  // Validation.
  const tooLong = await json(`${base}/settings`, { method: 'PUT', body: { systemPrompt: { text: 'x'.repeat(8_001) } } });
  assert.equal(tooLong.response.status, 400);
  const notText = await json(`${base}/settings`, { method: 'PUT', body: { systemPrompt: { text: 42 } } });
  assert.equal(notText.response.status, 400);
  const nothing = await json(`${base}/settings`, { method: 'PUT', body: {} });
  assert.equal(nothing.response.status, 400);

  const saved = await json(`${base}/settings`, { method: 'PUT', body: { systemPrompt: { text: 'Always answer in Bengali.' } } });
  assert.equal(saved.payload.data.systemPrompt.text, 'Always answer in Bengali.');
  // Saving the prompt must not disturb the title setting, and vice versa.
  assert.deepEqual(saved.payload.data.titleGeneration, { enabled: false, providerId: null, modelId: null });

  await json(`${base}/conversations/${conversation.id}/respond`, { method: 'POST', body: { message: 'Second question.', ...ask } });
  assert.match(systemOf(calls.at(-1)), /standing instructions/u);
  assert.match(systemOf(calls.at(-1)), /Always answer in Bengali\./u);
  assert.match(systemOf(calls.at(-1)), /GitHub-flavored Markdown/u, 'the custom prompt is added, not substituted');

  // A new chat gets it too.
  const other = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  await json(`${base}/conversations/${other.id}/respond`, { method: 'POST', body: { message: 'Another chat.', ...ask } });
  assert.match(systemOf(calls.at(-1)), /Always answer in Bengali\./u);

  const cleared = await json(`${base}/settings`, { method: 'PUT', body: { systemPrompt: { text: '' } } });
  assert.equal(cleared.payload.data.systemPrompt.text, '');
  await json(`${base}/conversations/${other.id}/respond`, { method: 'POST', body: { message: 'After clearing.', ...ask } });
  assert.equal(systemOf(calls.at(-1)).includes('Always answer in Bengali.'), false);
});
