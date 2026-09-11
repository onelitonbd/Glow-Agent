import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDom } from './fixtures/dom.mjs';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../client/testing.html', import.meta.url)), 'utf8');

function sseResponse(events) {
  const payload = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(payload) };
          },
          releaseLock() {}
        };
      }
    }
  };
}

const MODELS = [
  { key: 'prov-1:alpha', providerId: 'prov-1', providerName: 'Local', modelId: 'alpha' },
  { key: 'prov-1:beta', providerId: 'prov-1', providerName: 'Local', modelId: 'beta' }
];

const baselineReport = {
  testedAt: '2026-09-10T08:00:00.000Z',
  levels: [{ id: 'low', label: 'Low', value: 'low' }, { id: 'high', label: 'High', value: 'high' }],
  entries: [
    {
      providerId: 'prov-1', providerName: 'Local', modelId: 'alpha', key: 'prov-1:alpha', rank: 1, score: 30,
      testedAt: '2026-09-10T08:00:00.000Z',
      results: { baseline: { status: 'works', ms: 120 }, thinking: { low: { status: 'works' }, high: { status: 'rejected' } }, vision: { status: 'works' }, files: { status: 'rejected' }, tools: { status: 'works' } }
    },
    {
      providerId: 'prov-1', providerName: 'Local', modelId: 'beta', key: 'prov-1:beta', rank: 2, score: 20,
      testedAt: '2026-09-10T08:00:00.000Z',
      results: { baseline: { status: 'works', ms: 240 }, thinking: { low: { status: 'works' }, high: { status: 'works' } }, vision: { status: 'rejected' }, files: { status: 'rejected' }, tools: { status: 'rejected' } }
    }
  ]
};

// What the run returns in real life: the single model probed again, folded into the full ranking.
function mergedReport(score) {
  return {
    ...baselineReport,
    testedAt: '2026-09-10T10:00:00.000Z',
    entries: [
      { ...baselineReport.entries[0], score, rank: 1, testedAt: '2026-09-10T10:00:00.000Z' },
      { ...baselineReport.entries[1], rank: 2 }
    ]
  };
}

async function loadTesting({ holdFirstRun = false } = {}) {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  let streaming = null; // { resolve } — when holding, the run completes only when the test ends it.
  globalThis.document = document;
  globalThis.window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/api/v1/tests/models') return { status: 200, ok: true, json: async () => ({ data: MODELS }) };
    if (method === 'GET' && path === '/api/v1/tests/report') return { status: 200, ok: true, json: async () => ({ data: baselineReport }) };
    if (method === 'GET' && path === '/api/v1/tests/auto') {
      return { status: 200, ok: true, json: async () => ({ data: { enabled: false, started: true, running: false, current: null, queued: 0, untested: [], completedCount: 0, steps: 0 } }) };
    }
    if (method === 'POST' && path === '/api/v1/tests/run/stream') {
      const key = body?.models?.[0] || MODELS[0].key;
      const model = MODELS.find((item) => item.key === key) || MODELS[0];
      if (holdFirstRun && !streaming) {
        return new Promise((resolve) => {
          streaming = {
            resolve: () => resolve(sseResponse([
              ['model-start', { key, providerName: model.providerName, modelId: model.modelId, index: 0, total: 1 }],
              ['model', { key, providerName: model.providerName, modelId: model.modelId, score: 55, index: 0, total: 1 }],
              ['completed', mergedReport(55)]
            ]))
          };
        });
      }
      return sseResponse([
        ['model-start', { key, providerName: model.providerName, modelId: model.modelId, index: 0, total: 1 }],
        ['progress', { key, label: 'Thinking low', modelId: model.modelId, index: 0, total: 1, stepIndex: 2, stepTotal: 9 }],
        ['model', { key, providerName: model.providerName, modelId: model.modelId, score: 55, index: 0, total: 1 }],
        ['completed', mergedReport(55)]
      ]);
    }
    return { status: 404, ok: false, json: async () => ({ error: { message: `No stub for ${method} ${path}` } }) };
  };
  await import(`../client/assets/js/testing.js?load=${Date.now()}-${Math.random()}`);
  await waitFor(() => byId.get('testModelList').querySelectorAll('.test-row').length === 2);
  await waitFor(() => byId.get('rankingReport').querySelectorAll('.rank-card').length === 2);
  return { byId, requests, finishRun: () => streaming?.resolve() };
}

async function waitFor(condition, ms = 2_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the page to catch up.');
}

function rowOf(byId, key) {
  return [...byId.get('testModelList').querySelectorAll('.test-row')].find((row) => row.dataset.key === key);
}

test('each model row offers its own Test button that probes only that model', async () => {
  const { byId, requests } = await loadTesting();
  const alpha = rowOf(byId, 'prov-1:alpha');
  const button = alpha.querySelector('.test-single');
  assert.equal(button.getAttribute('aria-label'), 'Test only alpha');
  button.dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path === '/api/v1/tests/run/stream'));
  const run = requests.find((request) => request.path === '/api/v1/tests/run/stream');
  assert.deepEqual(run.body.models, ['prov-1:alpha'], 'exactly one model goes out, whatever the checkboxes say');
  // The row narrates the run and then shows the fresh score.
  await waitFor(() => rowOf(byId, 'prov-1:alpha').textContent.includes('55 pts'));
});

test('re-testing one model updates the ranking to the latest result without losing the others', async () => {
  const { byId } = await loadTesting();
  // Before: two cards from the old report, alpha at 30 pts.
  assert.equal(byId.get('rankingReport').querySelectorAll('.rank-card').length, 2);
  rowOf(byId, 'prov-1:alpha').querySelector('.test-single').dispatchEvent('click');
  await waitFor(() => rowOf(byId, 'prov-1:alpha').textContent.includes('55 pts'));
  const cards = [...byId.get('rankingReport').querySelectorAll('.rank-card')];
  assert.equal(cards.length, 2, 'the full ranking is kept, not collapsed to the one re-tested model');
  assert.ok(cards[0].textContent.includes('55 pts'), 'the tested model now shows its new score');
  assert.ok(cards[1].textContent.includes('20 pts'), 'the untouched model keeps its earlier result');
  assert.match(byId.get('rankingUpdated').textContent, /\S/u, 'the report timestamp is refreshed');
});

test('the report Re-test button re-probes just that model', async () => {
  const { byId, requests } = await loadTesting();
  const card = [...byId.get('rankingReport').querySelectorAll('.rank-card')].find((node) => node.textContent.includes('beta'));
  const again = [...card.querySelectorAll('button')].find((button) => button.classList.contains('rank-retest'));
  assert.equal(again.getAttribute('aria-label'), 'Re-test only beta');
  assert.equal(again.disabled, false);
  again.dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path === '/api/v1/tests/run/stream'));
  const run = requests.find((request) => request.path === '/api/v1/tests/run/stream');
  assert.deepEqual(run.body.models, ['prov-1:beta']);
});

test('while one model is being tested, other single-run actions stay locked', async () => {
  const { byId, requests, finishRun } = await loadTesting({ holdFirstRun: true });
  rowOf(byId, 'prov-1:alpha').querySelector('.test-single').dispatchEvent('click');
  await waitFor(() => requests.filter((request) => request.path === '/api/v1/tests/run/stream').length === 1);
  const betaButton = rowOf(byId, 'prov-1:beta').querySelector('.test-single');
  assert.equal(betaButton.disabled, true, 'other rows are locked during a run');
  // Even the main Run tests button refuses until this model finishes.
  assert.equal(byId.get('runTests').disabled, true);
  finishRun();
  await waitFor(() => rowOf(byId, 'prov-1:alpha').textContent.includes('55 pts'));
  assert.equal(byId.get('runTests').disabled, false);
  assert.equal(requests.filter((request) => request.path === '/api/v1/tests/run/stream').length, 1, 'and nothing double-started');
});
