import { api, ApiError } from './api.js';
import { element, icon, iconButton, showToast } from './ui.js';

const state = { providers: [], editingId: null };
const providersState = document.getElementById('providersState');
const providerCount = document.getElementById('providerCount');
const dialog = document.getElementById('providerDialog');
const form = document.getElementById('providerForm');
const nameInput = document.getElementById('providerName');
const baseUrlInput = document.getElementById('providerBaseUrl');
const apiKeyInput = document.getElementById('providerApiKey');
const backupKeyFields = document.getElementById('backupKeyFields');
const dialogTitle = document.getElementById('providerDialogTitle');
const keyRequirement = document.getElementById('keyRequirement');
const keyHint = document.getElementById('keyHint');
const saveButton = document.getElementById('saveProvider');
let dialogOpener = document.getElementById('openProviderDialog');

function openDialog(opener, provider = null) {
  dialogOpener = opener;
  state.editingId = provider?.id || null;
  form.reset();
  backupKeyFields.replaceChildren();
  const editing = Boolean(provider);
  dialogTitle.textContent = editing ? 'Configure provider' : 'Add provider';
  saveButton.textContent = editing ? 'Save changes' : 'Save provider';
  keyRequirement.textContent = editing ? 'OPTIONAL' : 'REQUIRED';
  keyHint.textContent = editing
    ? `Primary key remains encrypted. Paste a new value only to replace it. ${provider.keyStatus.backupKeyCount} backup key(s) are stored.`
    : 'Stored encrypted on this device. The value cannot be viewed again.';
  apiKeyInput.required = !editing;
  if (editing) {
    nameInput.value = provider.name;
    baseUrlInput.value = provider.baseUrl;
    apiKeyInput.placeholder = 'Paste a new key to replace the current one';
  } else {
    apiKeyInput.placeholder = 'Paste an API key';
  }
  dialog.showModal();
  setTimeout(() => nameInput.focus(), 20);
}

function closeDialog() {
  dialog.close();
  dialogOpener?.focus();
}

function addBackupKey() {
  const row = element('div', 'key-row');
  const field = element('div', 'field');
  const label = element('label');
  const labelText = document.createTextNode('Backup API key ');
  const tag = element('span', '', 'OPTIONAL');
  label.append(labelText, tag);
  const input = document.createElement('input');
  input.type = 'password';
  input.maxLength = 500;
  input.autocomplete = 'off';
  input.autocapitalize = 'none';
  input.placeholder = 'Paste a fallback API key';
  field.append(label, input);
  const remove = iconButton('close', 'Remove backup API key', 'remove-key');
  remove.addEventListener('click', () => row.remove());
  row.append(field, remove);
  backupKeyFields.append(row);
  input.focus();
}

function providerCard(provider) {
  const card = element('article', 'card data-card');
  const top = element('div', 'data-card-top');
  const providerIcon = element('span', 'data-icon');
  providerIcon.setAttribute('aria-hidden', 'true');
  providerIcon.append(icon('server'));
  const copy = element('span');
  copy.append(element('b', 'data-name', provider.name), element('span', 'data-subtitle', provider.baseUrl));
  top.append(providerIcon, copy);
  const meta = element('div', 'data-meta');
  const dot = document.createElement('i');
  meta.append(dot, document.createTextNode(`Primary key stored · ${provider.keyStatus.backupKeyCount} backup key${provider.keyStatus.backupKeyCount === 1 ? '' : 's'} · ${provider.selectedModelCount} selected model${provider.selectedModelCount === 1 ? '' : 's'}`));
  const actions = element('div', 'card-actions');
  const configure = element('button', 'button secondary small', 'Configure');
  configure.type = 'button';
  configure.prepend(icon('pencil'));
  configure.addEventListener('click', () => openDialog(configure, provider));
  const models = element('a', 'button secondary small', 'Models');
  models.href = `/models.html?provider=${encodeURIComponent(provider.id)}`;
  models.prepend(icon('database'));
  actions.append(configure, models);
  card.append(top, meta, actions);
  return card;
}

function render() {
  providersState.replaceChildren();
  providerCount.textContent = `${state.providers.length} ${state.providers.length === 1 ? 'provider' : 'providers'}`;
  if (state.providers.length === 0) {
    const empty = element('div', 'empty-state');
    const emptyIcon = element('span', 'empty-icon');
    emptyIcon.setAttribute('aria-hidden', 'true');
    emptyIcon.append(icon('server'));
    const add = element('button', 'button full', 'Add your first provider');
    add.type = 'button';
    add.prepend(icon('plus'));
    add.addEventListener('click', () => openDialog(add));
    empty.append(emptyIcon, element('h2', '', 'No providers yet'), element('p', '', 'Add an OpenAI-compatible endpoint before choosing models or chatting.'), add);
    providersState.append(empty);
    return;
  }
  const list = element('div', 'list');
  state.providers.forEach((provider) => list.append(providerCard(provider)));
  providersState.append(list);
}

async function load() {
  providersState.replaceChildren(element('div', 'loading', 'Loading providers'));
  try {
    state.providers = await api.providers.list();
    render();
  } catch (error) {
    providersState.replaceChildren(errorState(error));
  }
}

function errorState(error) {
  const empty = element('div', 'empty-state');
  const retry = element('button', 'button secondary full', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', load);
  empty.append(element('h2', '', 'Could not load providers'), element('p', '', error.message), retry);
  return empty;
}

async function saveProvider(event) {
  event.preventDefault();
  const backupKeys = [...backupKeyFields.querySelectorAll('input')].map((input) => input.value.trim()).filter(Boolean);
  const values = { name: nameInput.value, baseUrl: baseUrlInput.value };
  if (apiKeyInput.value.trim()) values.apiKey = apiKeyInput.value;
  if (!state.editingId) values.backupKeys = backupKeys;
  if (state.editingId && backupKeys.length > 0) {
    values.backupKeys = backupKeys;
  }
  saveButton.disabled = true;
  saveButton.textContent = state.editingId ? 'Saving…' : 'Saving…';
  try {
    if (state.editingId) await api.providers.update(state.editingId, values);
    else await api.providers.create(values);
    closeDialog();
    await load();
    showToast(state.editingId ? 'Provider configuration saved.' : 'Provider saved.');
  } catch (error) {
    showToast(error instanceof ApiError ? error.message : 'Could not save provider.', 'danger');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = state.editingId ? 'Save changes' : 'Save provider';
  }
}

document.getElementById('openProviderDialog').addEventListener('click', (event) => openDialog(event.currentTarget));
document.getElementById('closeProviderDialog').addEventListener('click', closeDialog);
document.getElementById('cancelProvider').addEventListener('click', closeDialog);
document.getElementById('addBackupKey').addEventListener('click', addBackupKey);
form.addEventListener('submit', saveProvider);
dialog.addEventListener('cancel', () => { setTimeout(() => dialogOpener?.focus(), 0); });
load();
