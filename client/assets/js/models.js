import { api, ApiError } from './api.js';
import { element, icon, iconButton, showToast } from './ui.js';

const providerId = new URLSearchParams(window.location.search).get('provider');
const providerName = document.getElementById('providerName');
const providerDescription = document.getElementById('providerDescription');
const selectedState = document.getElementById('selectedModelsState');
const selectedCount = document.getElementById('selectedModelCount');
const fetchButton = document.getElementById('fetchModels');
const fetchResults = document.getElementById('fetchResults');
const state = { provider: null, selectedModels: [], fetchedModels: [] };

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
        showToast('Model removed from chat.');
      } catch (error) {
        remove.disabled = false;
        showToast(error.message, 'danger');
      }
    });
    row.append(dot, id, remove);
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
        showToast(`${modelId} is ready for chat.`);
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

async function load() {
  if (!providerId) return invalidProvider();
  try {
    state.provider = await api.providers.get(providerId);
    providerName.textContent = state.provider.name;
    providerDescription.textContent = `${state.provider.selectedModelCount} model(s) are currently selected. Fetching contacts ${state.provider.baseUrl} only from this device's server.`;
    await loadSelected();
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
