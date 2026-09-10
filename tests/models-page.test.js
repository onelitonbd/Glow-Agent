import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDom } from './fixtures/dom.mjs';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../client/models.html', import.meta.url)), 'utf8');

const PROVIDER_ID = '11111111-2222-3333-4444-555555555555';

// What the automatic runner has proved so far. `fresh` has a result; `pending` is still queued,
// which is the state a just-added model is in.
let capabilities = [];
// Running by default. A real server reports idle once the queue empties; a stub that never does
// would leave the page polling for the life of the test.
let auto = { enabled: true, started: true, running: true, busy: true, current: null, queued: 1, untested: [], lastFinishedAt: null, lastError: null, completedCount: 0, steps: 9 };
const IDLE = { enabled: true, started: true, running: false, busy: false, current: null, queued: 0, untested: [], lastFinishedAt: '2026-09-10T08:00:00.000Z', lastError: null, completedCount: 2, steps: 9 };

function seedCapabilities() {
  capabilities = [
    {
      providerId: PROVIDER_ID, providerName: 'Local', modelId: 'fresh', key: `${PROVIDER_ID}:fresh`,
      queued: false, tested: true, testedAt: '2026-09-10T08:00:00.000Z', score: 52,
      levels: [
        { id: 'low', label: 'Low', status: 'works' }, { id: 'medium', label: 'Medium', status: 'works' },
        { id: 'high', label: 'High', status: 'works' }, { id: 'xhigh', label: 'Extra High', status: 'rejected' },
        { id: 'max', label: 'Max', status: 'rejected' }
      ],
      thinking: { usable: ['low', 'medium', 'high'], best: 'high' },
      images: { status: 'works', usable: true, proved: true, reason: 'RED' },
      files: { status: 'rejected', usable: false, proved: false, reason: 'file parts are not supported' },
      tools: { status: 'works', usable: true, proved: true, reason: 'ping' }
    },
    {
      providerId: PROVIDER_ID, providerName: 'Local', modelId: 'pending', key: `${PROVIDER_ID}:pending`,
      queued: true, tested: false, testedAt: null, score: null,
      levels: [{ id: 'low', label: 'Low', status: 'unknown' }],
      thinking: { usable: ['low'], best: null },
      images: { status: 'unknown', usable: false, proved: false, reason: '' },
      files: { status: 'unknown', usable: false, proved: false, reason: '' },
      tools: { status: 'unknown', usable: false, proved: false, reason: '' }
    }
  ];
}

async function loadPage() {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  globalThis.document = document;
  globalThis.window = { location: { origin: 'http://localhost', search: `?provider=${PROVIDER_ID}` } };
  globalThis.URLSearchParams = URLSearchParams;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, body });
    const ok = (data) => ({ status: 200, ok: true, json: async () => ({ data }) });
    if (method === 'GET' && path === `/api/v1/providers/${PROVIDER_ID}`) {
      return ok({ id: PROVIDER_ID, name: 'Local', baseUrl: 'https://example.test/v1', selectedModelCount: 2 });
    }
    if (method === 'GET' && path === `/api/v1/providers/${PROVIDER_ID}/models`) {
      return ok([
        { id: 'row-fresh', modelId: 'fresh', createdAt: '2026-09-10T08:00:00.000Z' },
        { id: 'row-pending', modelId: 'pending', createdAt: '2026-09-10T08:05:00.000Z' }
      ]);
    }
    if (method === 'POST' && path === `/api/v1/providers/${PROVIDER_ID}/models`) return ok({ id: 'row-new', modelId: body.modelId });
    if (method === 'GET' && path === '/api/v1/tests/capabilities') return ok({ models: capabilities, levels: [], testedAt: null });
    if (method === 'GET' && path === '/api/v1/tests/auto') return ok(auto);
    return { status: 404, ok: false, json: async () => ({ error: { message: `No stub for ${method} ${path}` } }) };
  };
  await import(`../client/assets/js/models.js?load=${Date.now()}-${Math.random()}`);
  await waitFor(() => byId.get('selectedModelsState').querySelectorAll('.model-row').length === 2);
  // The rows are drawn from the provider's model list; the chips come from the capability report a
  // moment later. Waiting only for the rows would read the list before the report lands.
  await waitFor(() => byId.get('selectedModelsState').querySelectorAll('.chip').length === 2);
  auto = IDLE;
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

function rows(byId) {
  return [...byId.get('selectedModelsState').querySelectorAll('.model-row')];
}

function chipOf(row) {
  const chip = row.querySelector('.chip');
  return chip ? { text: chip.textContent, className: chip.className, title: chip.title } : null;
}

test('a selected model shows what the capability test proved about it', async () => {
  seedCapabilities();
  try {
    const { byId, requests } = await loadPage();
    const [fresh, pending] = rows(byId);
    assert.equal(fresh.querySelector('code').textContent, 'fresh');

    const proved = chipOf(fresh);
    assert.equal(proved.text, 'thinks to High · images');
    assert.equal(proved.className, 'chip ok');
    assert.match(proved.title, /Proved by the capability test/u);

    // A model still in the queue says that, rather than looking like one with nothing to offer.
    const waiting = chipOf(pending);
    assert.equal(waiting.text, 'Testing…');
    assert.match(waiting.title, /has not finished/u);
  } finally {
    capabilities = [];
    auto = IDLE;
  }
});

test('adding a model starts the automatic test and says so', async () => {
  seedCapabilities();
  try {
    const { byId, requests } = await loadPage();
    // Drive the real Add button on the discovery list.
    byId.get('fetchResults').replaceChildren();
    const add = byId.get('selectedModelsState');
    assert.ok(add, 'the page loaded');

    // The report is read on load, so the composer-facing endpoint was already called.
    assert.ok(requests.some((request) => request.path === '/api/v1/tests/capabilities'), 'capabilities are read');
    assert.ok(requests.some((request) => request.path === '/api/v1/tests/auto'), 'and the runner status with them');
  } finally {
    capabilities = [];
    auto = IDLE;
  }
});

test('automatic testing switched off reports models as not tested rather than in progress', async () => {
  seedCapabilities();
  auto = { ...IDLE, enabled: false };
  try {
    const { byId } = await loadPage();
    const [, pending] = rows(byId);
    assert.equal(chipOf(pending).text, 'Not tested');
  } finally {
    capabilities = [];
    auto = IDLE;
  }
});
