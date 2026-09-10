import { api } from './api.js';
import { element, showToast } from './ui.js';

const state = { providers: [], models: [], enabled: false, providerId: '', modelId: '' };

const providerSelect = document.getElementById('titleProvider');
const modelSelect = document.getElementById('titleModel');
const toggle = document.getElementById('titleEnabled');
const saveButton = document.getElementById('saveTitleSettings');
const statusLine = document.getElementById('titleStatus');
const promptText = document.getElementById('systemPromptText');
const promptCount = document.getElementById('promptCount');
const savePromptButton = document.getElementById('saveSystemPrompt');

// Kept in step with the server's own limit so the counter is never a lie.
const PROMPT_MAX = 8_000;

function renderProviderOptions() {
  providerSelect.replaceChildren();
  const placeholder = element('option', '', 'Choose a provider…');
  placeholder.value = '';
  providerSelect.append(placeholder);
  for (const provider of state.providers) {
    const option = element('option', '', provider.name);
    option.value = provider.id;
    if (provider.id === state.providerId) option.selected = true;
    providerSelect.append(option);
  }
  // With no providers at all there is nothing to pick, so say so instead of showing an empty box.
  if (state.providers.length === 0) providerSelect.append(element('option', '', 'Add a provider first'));
}

function renderModelOptions() {
  modelSelect.replaceChildren();
  const placeholder = element('option', '', state.providerId ? 'Choose a model…' : 'Choose a provider first');
  placeholder.value = '';
  modelSelect.append(placeholder);
  for (const model of state.models) {
    const option = element('option', '', model.modelId);
    option.value = model.modelId;
    if (model.modelId === state.modelId) option.selected = true;
    modelSelect.append(option);
  }
  if (state.providerId && state.models.length === 0) {
    modelSelect.append(element('option', '', 'No models selected for this provider'));
  }
  modelSelect.disabled = !state.providerId;
}

// The model list belongs to the chosen provider, so it is refetched whenever that changes.
async function loadModelsFor(providerId, preferredModelId = '') {
  state.modelId = preferredModelId;
  state.models = [];
  if (!providerId) { renderModelOptions(); return; }
  try {
    state.models = await api.providers.selectedModels(providerId);
  } catch (error) {
    state.models = [];
    showToast(error.message, 'danger');
  }
  renderModelOptions();
}

function syncToggle() {
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.setAttribute('aria-label', state.enabled ? 'Turn off auto-generated titles' : 'Turn on auto-generated titles');
}

function syncStatus(saved) {
  if (!saved?.titleGeneration) { statusLine.textContent = ''; return; }
  const { enabled, providerId, modelId } = saved.titleGeneration;
  const provider = state.providers.find((entry) => entry.id === providerId);
  statusLine.textContent = enabled
    ? `On — new chats are named by ${modelId} on ${provider?.name || 'the chosen provider'}.`
    : 'Off — chats keep being named from your first words.';
}

toggle.addEventListener('click', () => {
  state.enabled = !state.enabled;
  syncToggle();
});

providerSelect.addEventListener('change', async () => {
  state.providerId = providerSelect.value;
  await loadModelsFor(state.providerId);
});

modelSelect.addEventListener('change', () => {
  state.modelId = modelSelect.value;
});

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  try {
    const saved = await api.settings.update({
      titleGeneration: {
        enabled: state.enabled,
        providerId: state.providerId || null,
        modelId: state.modelId || null
      }
    });
    state.enabled = saved.titleGeneration.enabled;
    syncToggle();
    syncStatus(saved);
    showToast(saved.titleGeneration.enabled ? 'Titles will be written automatically.' : 'Auto titles turned off.');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    saveButton.disabled = false;
  }
});

function syncPromptCount() {
  promptCount.textContent = `${promptText.value.length} / ${PROMPT_MAX}`;
}

promptText.addEventListener('input', syncPromptCount);

savePromptButton.addEventListener('click', async () => {
  savePromptButton.disabled = true;
  try {
    const saved = await api.settings.update({ systemPrompt: { text: promptText.value } });
    promptText.value = saved.systemPrompt.text;
    syncPromptCount();
    showToast(saved.systemPrompt.text ? 'System prompt saved — it applies to every chat.' : 'System prompt cleared.');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    savePromptButton.disabled = false;
  }
});

async function load() {
  try {
    const [settings, providers] = await Promise.all([api.settings.get(), api.providers.list()]);
    state.providers = providers;
    state.enabled = settings.titleGeneration.enabled === true;
    state.providerId = settings.titleGeneration.providerId || '';
    state.modelId = settings.titleGeneration.modelId || '';
    renderProviderOptions();
    await loadModelsFor(state.providerId, settings.titleGeneration.modelId || '');
    syncToggle();
    syncStatus(settings);
    promptText.value = settings.systemPrompt?.text || '';
    syncPromptCount();
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

load();
