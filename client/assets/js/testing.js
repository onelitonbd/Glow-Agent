import { api } from './api.js';
import { element, showToast } from './ui.js';

const state = { models: [], report: null, running: false, status: new Map() };

const modelList = document.getElementById('testModelList');
const modelCount = document.getElementById('testModelCount');
const runButton = document.getElementById('runTests');
const runLabel = document.getElementById('runTestsLabel');
const progress = document.getElementById('testProgress');
const ranking = document.getElementById('rankingReport');
const rankingUpdated = document.getElementById('rankingUpdated');

const CAPABILITIES = [
  { key: 'vision', label: 'Images' },
  { key: 'files', label: 'Files' },
  { key: 'tools', label: 'Tools' }
];

function chip(text, tone) {
  return element('span', `chip${tone ? ` ${tone}` : ''}`, text);
}

function statusTone(status) {
  if (status === 'works') return 'ok';
  if (status === 'accepted') return 'maybe';
  if (status === 'rejected') return 'no';
  return 'unknown';
}

// Every model row keeps its own live status, so a long run says which model it is on and what it
// is asking that model right now.
function renderModels() {
  modelList.replaceChildren();
  state.status = new Map();
  modelCount.textContent = state.models.length ? `${state.models.length} selected model${state.models.length === 1 ? '' : 's'}` : '';
  if (state.models.length === 0) {
    modelList.append(element('p', 'hint', 'No models are selected yet. Add a provider and select at least one model to test.'));
    const link = element('a', 'button secondary full button-spaced', 'Open providers');
    link.href = '/providers.html';
    modelList.append(link);
    return;
  }
  state.models.forEach((model) => {
    const row = element('label', 'test-row');
    row.dataset.key = model.key;
    const box = element('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.key = model.key;
    box.setAttribute('aria-label', `Test ${model.modelId} on ${model.providerName}`);
    const copy = element('span', 'test-row-copy');
    copy.append(element('b', 'data-name', model.modelId), element('span', 'data-subtitle', model.providerName));
    const statusNode = element('span', 'test-row-state', 'Ready');
    row.append(box, copy, statusNode);
    state.status.set(model.key, { row, node: statusNode, phase: 'ready' });
    modelList.append(row);
  });
}

function setRowStatus(key, phase, text) {
  const entry = state.status.get(key);
  if (!entry) return;
  entry.phase = phase;
  entry.node.textContent = text;
  entry.row.className = `test-row${phase === 'ready' ? '' : ` ${phase}`}`;
}

function markAll(phase, text) {
  for (const [key, entry] of state.status) {
    if (entry.phase === 'done' || entry.phase === 'failed') continue;
    setRowStatus(key, phase, text);
  }
}

function selectedKeys() {
  return modelList.querySelectorAll('input').filter((box) => box.checked).map((box) => box.dataset.key);
}

// The summary line above the list: which model, which capability, and how far through the run.
// `live` draws the pulsing dot: on while the run is in flight, off for the final line, which
// stays up so the outcome is still on screen after the button frees up.
function showProgress({ text, tone = '', stepIndex = 0, stepTotal = 0, index = 0, total = 0, live = true }) {
  progress.hidden = false;
  progress.className = `test-progress${tone ? ` ${tone}` : ''}${live ? '' : ' done'}`;
  progress.replaceChildren();
  if (live) {
    const dot = element('span', 'stream-status-dot');
    dot.setAttribute('aria-hidden', 'true');
    progress.append(dot);
  }
  const lines = element('span', 'test-progress-copy');
  lines.append(element('b', 'test-progress-title', text));
  const detail = [];
  if (total) detail.push(`model ${Math.min(index + 1, total)} of ${total}`);
  if (stepTotal) detail.push(`step ${stepIndex} of ${stepTotal}`);
  if (detail.length) lines.append(element('span', 'test-progress-detail', detail.join(' · ')));
  progress.append(lines);
  if (total) {
    const bar = element('span', 'test-progress-bar');
    const fill = element('span', 'test-progress-fill');
    fill.style.width = `${Math.round(((index + (stepTotal ? stepIndex / stepTotal : 0)) / total) * 100)}%`;
    bar.append(fill);
    progress.append(bar);
  }
}

function setRunning(running) {
  state.running = running;
  runButton.disabled = running;
  runLabel.textContent = running ? 'Testing…' : 'Run tests';
  runButton.classList.toggle('is-busy', running);
  modelList.querySelectorAll('input').forEach((box) => { box.disabled = running; });
}

function renderReport() {
  const entries = state.report?.entries || [];
  rankingUpdated.textContent = state.report?.testedAt ? new Date(state.report.testedAt).toLocaleString() : '';
  ranking.replaceChildren();
  if (entries.length === 0) {
    const empty = element('div', 'empty-state');
    const mark = element('span', 'empty-icon');
    mark.setAttribute('aria-hidden', 'true');
    empty.append(mark, element('h2', '', 'No results yet'), element('p', '', 'Run the tests to rank your models by what they can actually do.'));
    ranking.append(empty);
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
      const node = chip(level.label, statusTone(result?.status));
      node.title = result?.reason || 'Not tested.';
      levelChips.append(node);
    });
    levels.append(levelChips);
    card.append(levels);

    CAPABILITIES.forEach((capability) => {
      const result = entry.results?.[capability.key] || {};
      const row = element('div', 'capability');
      row.append(element('span', 'capability-label', capability.label));
      const node = chip(
        result.status === 'works' ? 'Yes' : result.status === 'accepted' ? 'Accepted' : result.status === 'rejected' ? 'No' : 'Untested',
        statusTone(result.status)
      );
      node.title = result.reason || 'Not tested.';
      const chips = element('span', 'capability-chips');
      chips.append(node);
      row.append(chips);
      card.append(row);
    });

    card.append(element('p', 'rank-meta', `Answered in ${Math.round((entry.results?.baseline?.ms || 0) / 100) / 10}s · tested ${new Date(entry.testedAt).toLocaleString()}`));
    ranking.append(card);
  });
}

runButton.addEventListener('click', async () => {
  if (state.running) return;
  const keys = selectedKeys();
  if (keys.length === 0) {
    showToast('Pick at least one model to test.', 'danger');
    return;
  }
  setRunning(true);
  markAll('waiting', 'Waiting');
  keys.forEach((key) => setRowStatus(key, 'queued', 'Queued'));
  showProgress({ text: `Starting — ${keys.length} model${keys.length === 1 ? '' : 's'} to test.`, total: keys.length });
  try {
    const report = await api.tests.streamRun(keys, (event, payload) => {
      if (event === 'model-start') {
        setRowStatus(payload.key, 'testing', 'Testing…');
        showProgress({ text: `Testing ${payload.modelId}`, total: payload.total, index: payload.index });
        state.status.get(payload.key)?.row.scrollIntoView?.({ block: 'nearest' });
      } else if (event === 'progress') {
        setRowStatus(payload.key, 'testing', payload.label);
        showProgress({
          text: `${payload.modelId} — ${payload.label}`,
          stepIndex: payload.stepIndex,
          stepTotal: payload.stepTotal,
          index: payload.index,
          total: payload.total
        });
      } else if (event === 'model') {
        if (payload.error) {
          setRowStatus(payload.key, 'failed', `Failed — ${payload.error}`);
          showProgress({ text: `${payload.modelId} failed: ${payload.error}`, tone: 'warn', index: payload.index, total: payload.total });
        } else {
          setRowStatus(payload.key, 'done', `${payload.score} pts`);
          showProgress({ text: `${payload.modelId} finished with ${payload.score} points.`, index: payload.index, total: payload.total });
        }
      }
    });
    state.report = report;
    renderReport();
    showProgress({ text: `Testing finished — ${report.entries.length} model${report.entries.length === 1 ? '' : 's'} ranked.`, live: false });
    showToast('Testing finished.');
  } catch (error) {
    markAll('failed', 'Stopped');
    showProgress({ text: error.message, tone: 'warn', live: false });
    showToast(error.message, 'danger');
  } finally {
    setRunning(false);
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
