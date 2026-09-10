import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDom } from './fixtures/dom.mjs';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../client/other-settings.html', import.meta.url)), 'utf8');

// Loads the real Other Settings page against a seeded DOM and a stubbed API, so the provider and
// model boxes and the payload they save are the ones the browser would send.
async function loadPage({ settings = { titleGeneration: { enabled: false, providerId: null, modelId: null } } } = {}) {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  const modelsByProvider = {
    'prov-1': [{ modelId: 'alpha' }, { modelId: 'beta' }],
    'prov-2': [{ modelId: 'gamma' }]
  };

  globalThis.document = document;
  globalThis.window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/api/v1/settings') return { status: 200, ok: true, json: async () => ({ data: settings }) };
    if (method === 'PUT' && path === '/api/v1/settings') {
      settings = body;
      return { status: 200, ok: true, json: async () => ({ data: body }) };
    }
    if (method === 'GET' && path === '/api/v1/providers') {
      return { status: 200, ok: true, json: async () => ({ data: [{ id: 'prov-1', name: 'Local' }, { id: 'prov-2', name: 'Backup' }] }) };
    }
    const models = path.match(/^\/api\/v1\/providers\/([\w-]+)\/models$/u);
    if (method === 'GET' && models) return { status: 200, ok: true, json: async () => ({ data: modelsByProvider[models[1]] || [] }) };
    return { status: 404, ok: false, json: async () => ({ error: { message: `No stub for ${method} ${path}` } }) };
  };

  await import(`../client/assets/js/other-settings.js?load=${Date.now()}-${Math.random()}`);
  await waitFor(() => byId.get('titleProvider').children.length > 1);
  return { byId, requests };
}

async function waitFor(condition, ms = 2_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the page to catch up.');
}

function options(select) {
  return select.children.map((option) => ({ label: option.textContent, value: option.value, selected: option.selected === true }));
}

test('the saved provider and its models are preselected', async () => {
  const { byId } = await loadPage({ settings: { titleGeneration: { enabled: true, providerId: 'prov-1', modelId: 'alpha' } } });
  const provider = byId.get('titleProvider');
  const model = byId.get('titleModel');
  assert.deepEqual(options(provider), [
    { label: 'Choose a provider…', value: '', selected: false },
    { label: 'Local', value: 'prov-1', selected: true },
    { label: 'Backup', value: 'prov-2', selected: false }
  ]);
  assert.deepEqual(options(model).map((option) => option.label), ['Choose a model…', 'alpha', 'beta']);
  assert.equal(options(model)[1].selected, true, 'the stored model is highlighted');
  assert.equal(byId.get('titleEnabled').getAttribute('aria-checked'), 'true');
  assert.equal(model.disabled, false);
  assert.match(byId.get('titleStatus').textContent, /named by alpha on Local/u);
});

test('choosing another provider loads that provider\'s own models and clears the choice', async () => {
  const { byId, requests } = await loadPage({ settings: { titleGeneration: { enabled: true, providerId: 'prov-1', modelId: 'alpha' } } });
  const provider = byId.get('titleProvider');
  provider.value = 'prov-2';
  provider.dispatchEvent('change');
  await waitFor(() => byId.get('titleModel').children.length === 2);
  assert.ok(requests.some((request) => request.path === '/api/v1/providers/prov-2/models'), 'the new provider\'s models are fetched');
  assert.deepEqual(options(byId.get('titleModel')).map((option) => option.label), ['Choose a model…', 'gamma']);
  assert.equal(options(byId.get('titleModel')).some((option) => option.selected), false, 'the previous model is not carried over');

  // Switching back to nothing disables the model box rather than leaving a stale list.
  provider.value = '';
  provider.dispatchEvent('change');
  await waitFor(() => byId.get('titleModel').disabled === true);
  assert.deepEqual(options(byId.get('titleModel')).map((option) => option.label), ['Choose a provider first']);
});

test('saving sends the switch and both selections together', async () => {
  const { byId, requests } = await loadPage();
  byId.get('titleEnabled').dispatchEvent('click');
  assert.equal(byId.get('titleEnabled').getAttribute('aria-checked'), 'true');
  const provider = byId.get('titleProvider');
  provider.value = 'prov-1';
  provider.dispatchEvent('change');
  await waitFor(() => byId.get('titleModel').children.length === 3);
  const model = byId.get('titleModel');
  model.value = 'beta';
  model.dispatchEvent('change');
  byId.get('saveTitleSettings').dispatchEvent('click');
  // Wait on the rendered result, not on the request: the status line only updates once the
  // response has come back.
  await waitFor(() => /named by beta/u.test(byId.get('titleStatus').textContent));
  assert.deepEqual(requests.find((request) => request.method === 'PUT').body, {
    titleGeneration: { enabled: true, providerId: 'prov-1', modelId: 'beta' }
  });
  assert.equal(byId.get('titleEnabled').getAttribute('aria-checked'), 'true', 'the switch reflects what was saved');
});

test('the saved system prompt loads into the box and saves on its own', async () => {
  const { byId, requests } = await loadPage({
    settings: { titleGeneration: { enabled: false, providerId: null, modelId: null }, systemPrompt: { text: 'Always answer in Bengali.' } }
  });
  const box = byId.get('systemPromptText');
  assert.equal(box.value, 'Always answer in Bengali.');
  assert.equal(byId.get('promptCount').textContent, '25 / 8000', 'the counter matches the loaded text');

  box.value = 'Keep every answer under 150 words.';
  box.dispatchEvent('input');
  assert.equal(byId.get('promptCount').textContent, '34 / 8000', 'the counter follows typing');

  byId.get('saveSystemPrompt').dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.method === 'PUT'));
  // Only the prompt is sent, so saving it cannot disturb the title setting.
  assert.deepEqual(requests.find((request) => request.method === 'PUT').body, {
    systemPrompt: { text: 'Keep every answer under 150 words.' }
  });
});

test('with no providers the page says so instead of showing an empty box', async () => {
  const { document, byId } = createDom(PAGE_HTML);
  globalThis.document = document;
  globalThis.window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = async (url) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/v1/settings') return { status: 200, ok: true, json: async () => ({ data: { titleGeneration: { enabled: false, providerId: null, modelId: null } } }) };
    if (path === '/api/v1/providers') return { status: 200, ok: true, json: async () => ({ data: [] }) };
    return { status: 404, ok: false, json: async () => ({ error: { message: 'nope' } }) };
  };
  await import(`../client/assets/js/other-settings.js?load=${Date.now()}-${Math.random()}`);
  await waitFor(() => byId.get('titleProvider').children.length === 2);
  assert.deepEqual(options(byId.get('titleProvider')).map((option) => option.label), ['Choose a provider…', 'Add a provider first']);
  assert.equal(byId.get('titleModel').disabled, true);
});
