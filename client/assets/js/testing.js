import { api } from './api.js';
import { element, showToast } from './ui.js';

const state = { models: [], report: null, running: false };

const modelList = document.getElementById('testModelList');
const modelCount = document.getElementById('testModelCount');
const runButton = document.getElementById('runTests');
const progress = document.getElementById('testProgress');
const ranking = document.getElementById('rankingReport');
const rankingUpdated = document.getElementById('rankingUpdated');

const CAPABILITIES = [
  { key: 'vision', label: 'Images' },
  { key: 'files', label: 'Files' },
  { key: 'tools', label: 'Tools' }
];

function chip(text, tone) {
  const node = element('span', `chip${tone ? ` ${tone}` : ''}`, text);
  return node;
}

function renderModels() {
  modelList.replaceChildren();
  modelCount.textContent = state.models.length ? `${state.models.length} selected model${state.models.length === 1 ? '' : 's'}` : '';
  if (state.models.length === 0) {
    const empty = element('p', 'hint', 'No models are selected yet. Add a provider and select at least one model to test.');
    const link = element('a', 'button secondary full button-spaced', 'Open providers');
    link.href = '/providers.html';
    modelList.append(empty, link);
    return;
  }
  state.models.forEach((model) => {
    const row = element('label', 'test-row');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.key = model.key;
    box.setAttribute('aria-label', `Test ${model.modelId} on ${model.providerName}`);
    const copy = element('span', 'test-row-copy');
    copy.append(element('b', 'data-name', model.modelId), element('span', 'data-subtitle', model.providerName));
    row.append(box, copy);
    modelList.append(row);
  });
}

function selectedKeys() {
  return modelList.querySelectorAll('input').filter((box) => box.checked).map((box) => box.dataset.key);
}

function showProgress(text, tone) {
  progress.hidden = false;
  progress.replaceChildren();
  progress.className = `test-progress${tone ? ` ${tone}` : ''}`;
  const dot = element('span', 'stream-status-dot');
  dot.setAttribute('aria-hidden', 'true');
  progress.append(dot, element('span', '', text));
}

function statusTone(status) {
  if (status === 'works') return 'ok';
  if (status === 'accepted') return 'maybe';
  if (status === 'rejected') return 'no';
  return 'unknown';
}

function renderReport() {
  const entries = state.report?.entries || [];
  rankingUpdated.textContent = state.report?.testedAt ? new Date(state.report.testedAt).toLocaleString() : '';
  ranking.replaceChildren();
  if (entries.length === 0) {
    ranking.append(element('div', 'empty-state'));
    ranking.firstChild.append(element('h2', '', 'No results yet'), element('p', '', 'Run the tests to rank your models by what they can actually do.'));
    return;
  }
  const best = Math.max(...entries.map((entry) => entry.score), 1);
  entries.forEach((entry) => {
    const card = element('article', 'rank-card');
    const head = element('div', 'rank-head');
    head.append(
      element('span', 'rank-place', `#${entry.rank}`),
      element('b', 'rank-model', entry.modelId),
      element('span', 'rank-score', `${entry.score} pts`)
    );
    card.append(head);
    card.append(element('p', 'rank-provider', entry.providerName));

    const bar = element('div', 'score-bar');
    const fill = element('span', 'score-bar-fill');
    fill.style.width = `${Math.round((entry.score / best) * 100)}%`;
    bar.append(fill);
    card.append(bar);

    // Thinking levels first: they are what the chat's thinking button is built from.
    const levels = element('div', 'capability');
    levels.append(element('span', 'capability-label', 'Thinking'));
    const levelChips = element('span', 'capability-chips');
    (state.report?.levels || []).forEach((level) => {
      const result = entry.results?.thinking?.[level.id];
      const status = result?.status || 'unknown';
      const node = chip(level.label, statusTone(status));
      node.title = result?.reason || 'Not tested.';
      levelChips.append(node);
    });
    levels.append(levelChips);
    card.append(levels);

    CAPABILITIES.forEach((capability) => {
      const result = entry.results?.[capability.key] || {};
      const row = element('div', 'capability');
      row.append(element('span', 'capability-label', capability.label));
      const node = chip(result.status === 'works' ? 'Yes' : result.status === 'accepted' ? 'Accepted' : result.status === 'rejected' ? 'No' : 'Untested', statusTone(result.status));
      node.title = result.reason || 'Not tested.';
      const chips = element('span', 'capability-chips');
      chips.append(node);
      row.append(chips);
      card.append(row);
    });

    const meta = element('p', 'rank-meta');
    meta.textContent = `Answered in ${Math.round((entry.results?.baseline?.ms || 0) / 100) / 10}s · tested ${new Date(entry.testedAt).toLocaleString()}`;
    card.append(meta);
    ranking.append(card);
  });
}

runButton.addEventListener('click', async () => {
  const keys = selectedKeys();
  if (keys.length === 0) {
    showToast('Pick at least one model to test.', 'danger');
    return;
  }
  state.running = true;
  runButton.disabled = true;
  modelList.querySelectorAll('input').forEach((box) => { box.disabled = true; });
  showProgress(`Starting — ${keys.length} model${keys.length === 1 ? '' : 's'} to test.`);
  try {
    const report = await api.tests.streamRun(keys, (event, payload) => {
      if (event === 'progress') {
        showProgress(`${payload.providerName} · ${payload.modelId} — ${payload.label}…`);
      } else if (event === 'model') {
        showProgress(payload.error
          ? `${payload.modelId} failed: ${payload.error}`
          : `${payload.modelId} finished with ${payload.score} points.`, payload.error ? 'warn' : '');
      }
    });
    state.report = report;
    renderReport();
    showToast('Testing finished.');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    state.running = false;
    runButton.disabled = false;
    progress.hidden = true;
    modelList.querySelectorAll('input').forEach((box) => { box.disabled = false; });
  }
});

async function load() {
  try {
    const [models, report] = await Promise.all([api.tests.models(), api.tests.report()]);
    state.models = models;
    state.report = report;
    renderModels();
    renderReport();
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

load();
