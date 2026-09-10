import { api, ApiError } from './api.js';
import { element, icon, iconButton, showToast } from './ui.js';

const providerId = new URLSearchParams(window.location.search).get('provider');
const providerName = document.getElementById('providerName');
const providerDescription = document.getElementById('providerDescription');
const selectedState = document.getElementById('selectedModelsState');
const selectedCount = document.getElementById('selectedModelCount');
const fetchButton = document.getElementById('fetchModels');
const fetchResults = document.getElementById('fetchResults');
const MAX_POLLS = 200;
const state = { provider: null, selectedModels: [], fetchedModels: [], capabilities: [], auto: null, poll: null, ticks: 0 };

// What the automatic capability test has proved about one of this provider's models. The report is
// what the chat composer is built from, so showing it here means you can see a new model become
// usable without leaving the page you added it on.
function capabilityFor(modelId) {
  return state.capabilities.find((entry) => entry.providerId === providerId && entry.modelId === modelId) || null;
}

function capabilityNote(modelId) {
  const capability = capabilityFor(modelId);
  if (!capability) return null;
  if (!capability.tested) {
    return state.auto?.enabled === false
      ? { text: 'Not tested', tone: 'unknown' }
      : { text: 'Testing…', tone: 'unknown' };
  }
  const thinking = capability.thinking.usable.length
    ? `thinks to ${capability.levels.find((level) => level.id === capability.thinking.best)?.label || capability.thinking.best}`
    : 'no thinking levels';
  const extras = [capability.images.usable ? 'images' : null, capability.files.usable ? 'files' : null].filter(Boolean);
  return { text: `${thinking}${extras.length ? ` · ${extras.join(' + ')}` : ''}`, tone: 'ok' };
}

function invalidProvider() {
  providerName.textContent = 'Provider unavailable';
  selectedState.replaceChildren(errorBlock('Open Providers', () => { window.location.href = '/providers.html'; }, 'Choose a configured provider before managing models.'));
  fetchButton.disabled = true;
}

function errorBlock(buttonText, handler, message) {
  const empty = element('div', 'empty-state');
  const button = element('button', 'button secondary full', buttonText);
  button.type = 'button';
  button.addEventListener('click', handler);
  empty.append(element('h2', '', 'Could not load models'), element('p', '', message), button);
  return empty;
}

function renderSelected() {
  selectedState.replaceChildren();
  selectedCount.textContent = `${state.selectedModels.length} selected`;
  if (state.selectedModels.length === 0) {
    const empty = element('div', 'empty-state');
    empty.style.minHeight = '170px';
    empty.append(element('h2', '', 'No models selected'), element('p', '', 'Fetch the provider list, then add the model IDs you want available in chat.'));
    selectedState.append(empty);
    return;
  }
  const list = element('div', 'model-list');
  state.selectedModels.forEach((model) => {
    const row = element('article', 'card model-row');
    const dot = element('span', 'data-icon model-row-icon');
    dot.append(icon('spark'));
    const id = element('code', '', model.modelId);
    const remove = iconButton('trash', `Remove ${model.modelId}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api.providers.removeSelectedModel(providerId, model.id);
        await loadSelected();
        await pollCapabilities();
        showToast('Model removed from chat.');
      } catch (error) {
        remove.disabled = false;
        showToast(error.message, 'danger');
      }
    });
    row.append(dot, id);
    // What the automatic test proved, beside the model it belongs to. A model still in the queue
    // says so rather than looking like one with nothing to offer.
    const capability = capabilityFor(model.modelId);
    const note = capabilityNote(model.modelId);
    if (note) {
      const badge = element('span', `chip ${note.tone === 'ok' ? 'ok' : ''}`, note.text);
      badge.title = capability?.tested
        ? `Proved by the capability test on ${new Date(capability.testedAt).toLocaleString()}.`
        : 'The automatic test has not finished with this model yet.';
      row.append(badge);
    }
    row.append(remove);
    list.append(row);
  });
  selectedState.append(list);
}

function renderFetchResults() {
  fetchResults.replaceChildren();
  if (state.fetchedModels.length === 0) return;
  const selectedNames = new Set(state.selectedModels.map((model) => model.modelId));
  state.fetchedModels.forEach((modelId) => {
    const row = element('div', 'fetch-result');
    row.append(element('code', '', modelId));
    const alreadySelected = selectedNames.has(modelId);
    const add = element('button', alreadySelected ? 'button secondary small' : 'button small', alreadySelected ? 'Added' : 'Add');
    add.type = 'button';
    add.disabled = alreadySelected;
    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        await api.providers.addSelectedModel(providerId, modelId);
        await loadSelected();
        // Adding a model starts the automatic capability test, and the chip above is what says so.
        await pollCapabilities();
        showToast(`${modelId} added. It is being tested now — the chat will offer what it can do.`);
      } catch (error) {
        add.disabled = false;
        showToast(error.message, 'danger');
      }
    });
    row.append(add);
    fetchResults.append(row);
  });
}

async function loadSelected() {
  state.selectedModels = await api.providers.selectedModels(providerId);
  renderSelected();
  renderFetchResults();
}

// Reads the report for this provider's models and keeps watching while the automatic test runs, so
// a model that was just added shows its result without a reload.
async function pollCapabilities() {
  if (state.poll) clearTimeout(state.poll);
  state.poll = null;
  try {
    const [report, auto] = await Promise.all([api.tests.capabilities(), api.tests.auto()]);
    state.capabilities = (report.models || []).filter((entry) => entry.providerId === providerId);
    state.auto = auto;
  } catch {
    return;
  }
  renderSelected();
  const active = Boolean(state.auto?.running || state.auto?.current
    || state.capabilities.some((entry) => !entry.tested));
  // Bounded on purpose: a probe that hangs upstream must not leave this page asking the server
  // every second forever. Five minutes is far longer than a real run takes.
  state.ticks += 1;
  if (active && state.auto?.enabled !== false && state.ticks < MAX_POLLS) state.poll = setTimeout(pollCapabilities, 1_500);
}

async function load() {
  if (!providerId) return invalidProvider();
  try {
    state.provider = await api.providers.get(providerId);
    providerName.textContent = state.provider.name;
    providerDescription.textContent = `${state.provider.selectedModelCount} model(s) are currently selected. Fetching contacts ${state.provider.baseUrl} only from this device's server.`;
    await loadSelected();
    await pollCapabilities();
  } catch (error) {
    invalidProvider();
    showToast(error instanceof ApiError ? error.message : 'Could not load the provider.', 'danger');
  }
}

fetchButton.addEventListener('click', async () => {
  fetchButton.disabled = true;
  fetchButton.textContent = 'Fetching…';
  fetchResults.replaceChildren(element('div', 'loading', 'Contacting provider'));
  try {
    const result = await api.providers.fetchModels(providerId);
    state.fetchedModels = result.models;
    renderFetchResults();
    if (result.models.length === 0) {
      fetchResults.append(element('p', 'hint', 'The provider returned no usable model IDs.'));
    } else {
      showToast(`${result.models.length} model${result.models.length === 1 ? '' : 's'} found.`);
    }
  } catch (error) {
    fetchResults.replaceChildren(element('p', 'hint', error.message));
    showToast(error.message, 'danger');
  } finally {
    fetchButton.disabled = false;
    fetchButton.textContent = 'Fetch models';
    fetchButton.prepend(icon('database'));
  }
});

load();
