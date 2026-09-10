import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDom } from './fixtures/dom.mjs';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../client/testing.html', import.meta.url)), 'utf8');

const LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' }
];

function report() {
  return {
    testedAt: '2026-09-10T08:00:00.000Z',
    levels: LEVELS,
    entries: [
      {
        providerId: 'p1', providerName: 'Local', modelId: 'capable', key: 'p1:capable', rank: 1, score: 78,
        testedAt: '2026-09-10T08:00:00.000Z',
        results: {
          baseline: { status: 'works', ms: 900, reason: 'READY' },
          thinking: { low: { status: 'works' }, medium: { status: 'works' }, high: { status: 'works' }, xhigh: { status: 'rejected' }, max: { status: 'rejected' } },
          vision: { status: 'works', reason: 'The model answered the image: RED' },
          files: { status: 'rejected', reason: 'file parts are not supported' },
          tools: { status: 'works', reason: 'The model called ping.' }
        }
      },
      {
        providerId: 'p1', providerName: 'Local', modelId: 'plain', key: 'p1:plain', rank: 2, score: 14,
        testedAt: '2026-09-10T08:00:00.000Z',
        results: {
          baseline: { status: 'works', ms: 2_100, reason: 'READY' },
          thinking: { low: { status: 'rejected' }, medium: { status: 'rejected' }, high: { status: 'rejected' }, xhigh: { status: 'rejected' }, max: { status: 'rejected' } },
          vision: { status: 'rejected' }, files: { status: 'rejected' }, tools: { status: 'rejected' }
        }
      }
    ]
  };
}

// Loads the real Testing page against a seeded DOM and a stubbed API.
async function loadPage() {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  // Delivered one event per chunk with a pause between them. Sending the whole stream at once
  // would let a UI that only updates at the end pass, which is how the missing live status
  // got through the first time.
  const sse = [
    ['started', { total: 2, steps: 9, models: [{ key: 'p1:capable', providerName: 'Local', modelId: 'capable' }] }],
    ['model-start', { key: 'p1:capable', providerName: 'Local', modelId: 'capable', index: 0, total: 2 }],
    ['progress', { key: 'p1:capable', providerName: 'Local', modelId: 'capable', step: 'baseline', label: 'Waking the model up', stepIndex: 1, stepTotal: 9, index: 0, total: 2 }],
    ['progress', { key: 'p1:capable', providerName: 'Local', modelId: 'capable', step: 'vision', label: 'Image input', stepIndex: 7, stepTotal: 9, index: 0, total: 2 }],
    ['model', { key: 'p1:capable', providerName: 'Local', modelId: 'capable', score: 78, index: 0, total: 2 }],
    ['completed', report()]
  ];
  const encoder = new TextEncoder();

  globalThis.document = document;
  globalThis.window = { location: { origin: 'http://localhost' } };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/api/v1/tests/models') {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: [
            { providerId: 'p1', providerName: 'Local', modelId: 'capable', key: 'p1:capable' },
            { providerId: 'p1', providerName: 'Local', modelId: 'plain', key: 'p1:plain' }
          ]
        })
      };
    }
    if (method === 'GET' && path === '/api/v1/tests/report') return { status: 200, ok: true, json: async () => ({ data: report() }) };
    if (method === 'POST' && path === '/api/v1/tests/run/stream') {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let cursor = 0;
            return {
              read: async () => {
                if (cursor >= sse.length) return { done: true, value: undefined };
                const [event, data] = sse[cursor];
                cursor += 1;
                // Hold the previous events back briefly so the page has to paint them.
                if (cursor > 1) await new Promise((resolve) => setTimeout(resolve, 12));
                return { done: false, value: encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) };
              },
              releaseLock() {}
            };
          }
        }
      };
    }
    return { status: 404, ok: false, json: async () => ({ error: { message: `No stub for ${method} ${path}` } }) };
  };

  await import(`../client/assets/js/testing.js?load=${Date.now()}-${Math.random()}`);
  await waitFor(() => byId.get('testModelList').querySelectorAll('input').length === 2);
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

test('every selected model is listed with a checkbox, all ticked by default', async () => {
  const { byId } = await loadPage();
  const boxes = byId.get('testModelList').querySelectorAll('input');
  assert.deepEqual(boxes.map((box) => box.dataset.key), ['p1:capable', 'p1:plain']);
  assert.equal(boxes.every((box) => box.checked), true);
  assert.equal(byId.get('testModelCount').textContent, '2 selected models');
  assert.deepEqual(byId.get('testModelList').querySelectorAll('.data-name').map((node) => node.textContent), ['capable', 'plain']);
});

test('the stored report renders as a ranking with a verdict per capability', async () => {
  const { byId } = await loadPage();
  const cards = byId.get('rankingReport').querySelectorAll('.rank-card');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.querySelector('.rank-model').textContent), ['capable', 'plain']);
  assert.deepEqual(cards.map((card) => card.querySelector('.rank-place').textContent), ['#1', '#2']);
  assert.equal(cards[0].querySelector('.rank-score').textContent, '78 pts');
  assert.equal(cards[0].querySelector('.score-bar-fill').style.width, '100%');
  assert.equal(cards[1].querySelector('.score-bar-fill').style.width, '18%', 'the bar is relative to the best score');

  const chips = (card, label) => card.querySelectorAll('.capability')
    .find((row) => row.querySelector('.capability-label').textContent === label)
    .querySelectorAll('.chip').map((chip) => `${chip.textContent}:${chip.className}`);
  assert.deepEqual(chips(cards[0], 'Thinking'), ['Low:chip ok', 'Medium:chip ok', 'High:chip ok', 'Extra High:chip no', 'Max:chip no']);
  assert.deepEqual(chips(cards[0], 'Images'), ['Yes:chip ok']);
  assert.deepEqual(chips(cards[0], 'Files'), ['No:chip no']);
  assert.deepEqual(chips(cards[0], 'Tools'), ['Yes:chip ok']);
  assert.match(cards[0].querySelector('.rank-meta').textContent, /Answered in 0\.9s/u);
});

test('running the tests names the model and the capability while it works, on the button and the row', async () => {
  const { byId, requests } = await loadPage();
  byId.get('testModelList').querySelectorAll('input')[1].checked = false;
  const rows = byId.get('testModelList').querySelectorAll('.test-row');
  byId.get('runTests').dispatchEvent('click');

  // The button and the rows react before anything comes back from the server.
  assert.equal(byId.get('runTests').disabled, true);
  assert.equal(byId.get('runTestsLabel').textContent, 'Testing…');
  assert.equal(byId.get('testProgress').hidden, false);
  assert.match(byId.get('testProgress').querySelector('.test-progress-title').textContent, /1 model to test/u);
  assert.equal(rows[0].querySelector('.test-row-state').textContent, 'Queued');
  assert.equal(rows[1].querySelector('.test-row-state').textContent, 'Waiting', 'an unticked model is not part of the run');

  // Then the live status: which model, then which capability, then how far through.
  await waitFor(() => rows[0].querySelector('.test-row-state').textContent === 'Image input', 4_000);
  assert.equal(rows[0].classList.contains('testing'), true, 'the row being probed is marked');
  assert.equal(byId.get('testProgress').querySelector('.test-progress-title').textContent, 'capable — Image input');
  assert.equal(byId.get('testProgress').querySelector('.test-progress-detail').textContent, 'model 1 of 2 · step 7 of 9');

  await waitFor(() => byId.get('runTests').disabled === false, 4_000);
  assert.equal(byId.get('runTestsLabel').textContent, 'Run tests', 'the button reads normally again');
  assert.equal(rows[0].querySelector('.test-row-state').textContent, '78 pts');
  assert.equal(rows[0].classList.contains('done'), true);
  // The outcome stays on screen, without the pulsing dot that means "still working".
  assert.equal(byId.get('testProgress').hidden, false);
  assert.match(byId.get('testProgress').querySelector('.test-progress-title').textContent, /Testing finished/u);
  assert.equal(byId.get('testProgress').querySelectorAll('.stream-status-dot').length, 0);

  const run = requests.find((request) => request.path === '/api/v1/tests/run/stream');
  assert.deepEqual(run.body, { models: ['p1:capable'] }, 'only the ticked model is tested');
  assert.equal(byId.get('testModelList').querySelectorAll('input').every((box) => box.disabled === false), true);
  assert.equal(byId.get('rankingReport').querySelectorAll('.rank-card').length, 2);
});
