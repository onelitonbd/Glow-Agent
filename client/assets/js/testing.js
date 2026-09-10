import { api } from './api.js';
import { element, showToast } from './ui.js';

const state = { models: [], report: null, running: false, status: new Map(), auto: null, poll: null };

const modelList = document.getElementById('testModelList');
const modelCount = document.getElementById('testModelCount');
const runButton = document.getElementById('runTests');
const runLabel = document.getElementById('runTestsLabel');
const progress = document.getElementById('testProgress');
const ranking = document.getElementById('rankingReport');
const rankingUpdated = document.getElementById('rankingUpdated');
const autoToggle = document.getElementById('autoTestToggle');
const autoState = document.getElementById('autoTestState');
const autoProgress = document.getElementById('autoTestProgress');

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
    modelList.append(element('p', 'hint', 'Nothing to test yet. Testing runs against the models you have selected on the Models page for each provider — discovering a provider\'s models is not enough.'));
    const link = element('a', 'button secondary full button-spaced', 'Open providers');
    link.href = '/providers.html';
    modelList.append(link);
    runButton.disabled = true;
    runLabel.textContent = 'No models selected';
    return;
  }
  runButton.disabled = false;
  runLabel.textContent = 'Run tests';
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
  // Spread first: querySelectorAll returns a NodeList in a browser, which has forEach but no
  // filter or map. Calling .filter on it directly throws and silently kills the click handler.
  return [...modelList.querySelectorAll('input')].filter((box) => box.checked).map((box) => box.dataset.key);
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
  if (state.auto?.running) {
    showToast('The automatic test is running. It will finish in a moment.', 'danger');
    return;
  }
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

// Loaded separately on purpose: a failure reading the old report must not leave the model list
// stuck on "Gathering models", which reads exactly like a page that does nothing.
async function loadModels() {
  try {
    state.models = await api.tests.models();
    renderModels();
  } catch (error) {
    modelList.replaceChildren(element('p', 'hint', `The model list could not be loaded: ${error.message}`));
    modelCount.textContent = '';
    showToast(error.message, 'danger');
  }
}

async function loadReport() {
  try {
    state.report = await api.tests.report();
    renderReport();
  } catch {
    // No stored report is normal on a fresh install; the empty state already says so.
    renderReport();
  }
}

// ---- Automatic testing ----
// The same probes run by themselves when a model is added. This section only reports that and
// lets it be turned off; it never starts a run of its own.

function describeAuto(auto) {
  if (!auto) return '';
  if (!auto.enabled) return 'Off';
  if (auto.current) return `Testing ${auto.current.modelId}`;
  if (auto.untested?.length) return `${auto.untested.length} waiting`;
  return 'Everything is tested';
}

function renderAutoProgress(auto) {
  if (!autoProgress) return;
  const current = auto?.current;
  if (!current) {
    autoProgress.hidden = true;
    autoProgress.replaceChildren();
    return;
  }
  autoProgress.hidden = false;
  autoProgress.className = 'test-progress';
  autoProgress.replaceChildren();
  const dot = element('span', 'stream-status-dot');
  dot.setAttribute('aria-hidden', 'true');
  autoProgress.append(dot);
  const lines = element('span', 'test-progress-copy');
  lines.append(element('b', 'test-progress-title', `Testing ${current.modelId} automatically — ${current.label}`));
  const detail = [];
  if (current.stepTotal) detail.push(`step ${current.stepIndex} of ${current.stepTotal}`);
  if (auto.queued) detail.push(`${auto.queued} more waiting`);
  if (detail.length) lines.append(element('span', 'test-progress-detail', detail.join(' · ')));
  autoProgress.append(lines);
  if (current.stepTotal) {
    const bar = element('span', 'test-progress-bar');
    const fill = element('span', 'test-progress-fill');
    fill.style.width = `${Math.round((current.stepIndex / current.stepTotal) * 100)}%`;
    bar.append(fill);
    autoProgress.append(bar);
  }
}

// Marks the rows the automatic runner has not reached yet, so the list and the ranking agree.
function renderAutoMarkers(auto) {
  const waiting = new Set((auto?.untested || []).map((entry) => entry.key));
  for (const [key, entry] of state.status) {
    if (entry.phase !== 'ready' && entry.phase !== 'queued') continue;
    if (auto?.current?.key === key) setRowStatus(key, 'testing', auto.current.label || 'Testing…');
    else if (waiting.has(key)) setRowStatus(key, 'queued', auto?.enabled === false ? 'Not tested' : 'Queued');
    else setRowStatus(key, 'ready', 'Ready');
  }
}

function scheduleAutoPoll(auto) {
  if (state.poll) clearTimeout(state.poll);
  state.poll = null;
  const active = Boolean(auto?.running || auto?.current || auto?.untested?.length);
  if (!active || auto?.enabled === false) return;
  state.poll = setTimeout(pollAuto, 1_500);
}

async function pollAuto() {
  const wasRunning = Boolean(state.auto?.running || state.auto?.current);
  try {
    state.auto = await api.tests.auto();
  } catch {
    return;
  }
  if (autoToggle) autoToggle.checked = state.auto.enabled === true;
  if (autoState) autoState.textContent = describeAuto(state.auto);
  renderAutoProgress(state.auto);
  renderAutoMarkers(state.auto);
  // A run just finished: the ranking below is now stale, and the models list may have gained a
  // result it did not have a second ago.
  const finished = wasRunning && !state.auto.running && !state.auto.current;
  if (finished) await loadReport();
  scheduleAutoPoll(state.auto);
}

autoToggle?.addEventListener('change', async () => {
  const enabled = autoToggle.checked;
  try {
    await api.settings.update({ autoTesting: { enabled } });
    showToast(enabled ? 'Automatic testing is on.' : 'Automatic testing is off. New models will wait for a manual run.');
  } catch (error) {
    autoToggle.checked = !enabled;
    showToast(error.message, 'danger');
    return;
  }
  state.auto = await api.tests.auto();
  if (autoState) autoState.textContent = describeAuto(state.auto);
  renderAutoProgress(state.auto);
  renderAutoMarkers(state.auto);
  scheduleAutoPoll(state.auto);
});

async function load() {
  await Promise.all([loadModels(), loadReport()]);
  await pollAuto();
}

load();
