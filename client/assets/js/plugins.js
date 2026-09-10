import { api } from './api.js';
import { element, icon, showToast, setButtonBusy } from './ui.js';

const state = {
  plugins: [],
  presets: [],
  repos: [],
  reposPluginId: null,
  cloneStatus: {},
  openTools: new Set()
};

const pluginsState = document.getElementById('pluginsState');
const pluginsCount = document.getElementById('pluginsCount');
const presetState = document.getElementById('presetState');
const dialog = document.getElementById('presetDialog');
const dialogTitle = document.getElementById('presetDialogTitle');
const dialogKicker = document.getElementById('presetDialogKicker');
const dialogDescription = document.getElementById('presetDialogDescription');
const form = document.getElementById('presetForm');

let dialogOpener = null;
let dialogPreset = null;
let editingPluginId = null;
// The live form controls, keyed by the preset's own setting key.
let dialogFields = new Map();
let dialogHints = new Map();
let dialogSubmit = null;

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

// ---- the setup form, built from the chosen server's declared fields ----

function fieldValue(field) {
  const control = dialogFields.get(field.key);
  if (!control) return undefined;
  if (field.type === 'check') return control.checked;
  if (field.type === 'list') return splitList(control.value);
  const value = control.value.trim();
  // An untouched secret is not sent, so re-saving a plugin never wipes a stored credential.
  if (field.secret && value === '') return undefined;
  return value;
}

function buildControl(field) {
  if (field.type === 'select') {
    const control = element('select');
    for (const option of field.options || []) {
      const node = element('option', '', option.label);
      node.value = option.value;
      control.append(node);
    }
    return control;
  }
  if (field.type === 'check') {
    const control = element('input');
    control.type = 'checkbox';
    return control;
  }
  const control = element('input');
  control.type = field.type === 'password' ? 'password' : 'text';
  if (field.placeholder) control.placeholder = field.placeholder;
  control.maxLength = 300;
  control.autocomplete = 'off';
  return control;
}

function renderFields(preset, config) {
  form.replaceChildren();
  dialogFields = new Map();
  dialogHints = new Map();

  for (const field of preset.setup || []) {
    const control = buildControl(field);
    control.id = `setup-${field.key}`;
    control.name = field.key;
    dialogFields.set(field.key, control);

    if (field.type === 'check') {
      const row = element('div', 'check-row');
      control.checked = Boolean(config[field.key]);
      const label = element('label', '', field.label);
      label.htmlFor = control.id;
      row.append(control, label);
      form.append(row);
      continue;
    }

    const wrap = element('div', 'field');
    const label = element('label', '', field.label);
    label.htmlFor = control.id;
    wrap.append(label, control);
    if (field.hint) wrap.append(element('p', 'hint', field.hint));
    // A select explains the choice the user just made.
    if (field.type === 'select') {
      const hint = element('p', 'hint');
      dialogHints.set(field.key, hint);
      wrap.append(hint);
    }
    if (field.secret && config.hasToken) control.placeholder = 'Saved — enter a new value to replace it';
    form.append(wrap);
  }

  const actions = element('div', 'dialog-actions');
  const cancel = element('button', 'button secondary', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeDialog);
  dialogSubmit = element('button', 'button', editingPluginId ? 'Save and connect' : 'Connect');
  dialogSubmit.type = 'submit';
  actions.append(cancel, dialogSubmit);
  form.append(actions);

  // Seed values and visibility from the stored settings.
  for (const field of preset.setup || []) {
    const control = dialogFields.get(field.key);
    if (!control || field.type === 'check') continue;
    const stored = config[field.key];
    if (field.type === 'list') {
      // A new plugin starts from the preset's default, which the user can then trim.
      const list = Array.isArray(stored) && stored.length > 0 ? stored : (field.default || []);
      control.value = list.join(',');
    }
    else if (!field.secret) control.value = stored || (field.options?.[0]?.value ?? '');
  }
  refreshHints();
  applyVisibility(preset);
}

function refreshHints() {
  if (!dialogPreset) return;
  for (const field of dialogPreset.setup || []) {
    const control = dialogFields.get(field.key);
    const hint = dialogHints.get(field.key);
    if (!control || !hint) continue;
    const selected = (field.options || []).find((option) => option.value === control.value);
    hint.textContent = selected?.hint || '';
  }
}

// A field can declare that it only applies to some value of another field.
function applyVisibility(preset) {
  for (const field of preset.setup || []) {
    const control = dialogFields.get(field.key);
    if (!control) continue;
    let visible = true;
    for (const [dependency, allowed] of Object.entries(field.showWhen || {})) {
      const source = dialogFields.get(dependency);
      if (source && !allowed.includes(source.value)) visible = false;
    }
    const wrap = control.closest('.field, .check-row');
    if (wrap) wrap.hidden = !visible;
  }
}

function openDialog(opener, preset, plugin = null) {
  dialogOpener = opener;
  dialogPreset = preset;
  editingPluginId = plugin?.id || null;
  const config = plugin?.config || {};
  dialogTitle.textContent = editingPluginId ? preset.name : `Add ${preset.name}`;
  dialogKicker.textContent = 'MCP SERVER · SETUP';
  dialogDescription.textContent = preset.setup?.length
    ? preset.description
    : `${preset.description} There is nothing to configure — connect it and its tools are available.`;
  renderFields(preset, config);
  dialog.showModal();
  const first = form.querySelector('select, input');
  setTimeout(() => first?.focus(), 20);
}

function closeDialog() {
  dialog.close();
  dialogOpener?.focus();
}

// Changing one answer can reveal or hide another field, and a select explains its own choice.
form.addEventListener('change', () => {
  refreshHints();
  if (dialogPreset) applyVisibility(dialogPreset);
});

async function submitDialog(event) {
  event.preventDefault();
  if (!dialogPreset) return;
  const values = {};
  for (const field of dialogPreset.setup || []) {
    const value = fieldValue(field);
    if (value !== undefined) values[field.key] = value;
  }
  setButtonBusy(dialogSubmit, true, 'Connecting…');
  try {
    const pluginId = editingPluginId || (await api.plugins.create({ type: 'mcp', preset: dialogPreset.id })).id;
    await api.plugins.configure(pluginId, { preset: dialogPreset.id, [dialogPreset.id]: values });
    await api.plugins.connect(pluginId);
    closeDialog();
    await load();
    showToast(`${dialogPreset.name} connected — the assistant now has its tools.`);
  } catch (error) {
    showToast(error.message, 'danger');
    await load();
  } finally {
    setButtonBusy(dialogSubmit, false, editingPluginId ? 'Save and connect' : 'Connect');
  }
}

function statusLine(plugin) {
  const config = plugin.config || {};
  if (config.connected) {
    const box = element('div', 'plugin-status ok');
    box.append(icon('check'));
    const label = config.serverName ? `${config.serverName}${config.serverVersion ? ` ${config.serverVersion}` : ''}` : 'Connected';
    box.append(element('span', '', `${label} · ${config.toolCount} tools`));
    return box;
  }
  const box = element('div', 'plugin-status warn');
  box.append(icon('plug'));
  box.append(element('span', '', config.lastError ? `Not connected — ${config.lastError}` : 'Not connected yet'));
  return box;
}

function enableSwitch(plugin) {
  const toggle = element('button', `switch${plugin.enabled ? ' on' : ''}`);
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(Boolean(plugin.enabled)));
  toggle.setAttribute('aria-label', plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`);
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      const updated = await api.plugins.update(plugin.id, { enabled: !plugin.enabled });
      const index = state.plugins.findIndex((entry) => entry.id === plugin.id);
      if (index !== -1) state.plugins[index] = updated;
      render();
      showToast(updated.enabled ? `${plugin.name} enabled — the assistant now has its tools.` : `${plugin.name} disabled.`);
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      toggle.disabled = false;
    }
  });
  return toggle;
}

function toolsPanel(plugin) {
  const tools = plugin.config?.tools || [];
  if (tools.length === 0) return element('p', 'hint', 'No tools discovered yet.');
  const list = element('div', 'tool-grid');
  for (const tool of tools) {
    const chip = element('div', `tool-chip${tool.mutating ? ' write' : ''}`);
    chip.append(element('strong', '', tool.name));
    if (tool.description) chip.append(element('span', 'tool-chip-desc', tool.description));
    if (tool.mutating) chip.append(element('em', 'tool-chip-flag', 'writes'));
    list.append(chip);
  }
  return list;
}

async function loadRepos(plugin) {
  state.reposPluginId = plugin.id;
  state.repos = [];
  render();
  try {
    state.repos = await api.plugins.githubRepos(plugin.id);
  } catch (error) {
    showToast(error.message, 'danger');
  }
  render();
}

function repoSection(plugin) {
  const shell = element('div', 'plugin-repo');
  const row = element('div', 'plugin-step-title');
  row.append(element('span', 'step-num', '2'), document.createTextNode('Repository'));
  const refresh = element('button', 'link-button', 'Reload');
  refresh.type = 'button';
  refresh.addEventListener('click', () => loadRepos(plugin));
  row.append(refresh);
  shell.append(row);

  const config = plugin.config || {};
  if (!config.connected) {
    shell.append(element('p', 'hint', 'Connect the server first, then the repositories for your account appear here.'));
    return shell;
  }
  if (!config.ownerLogin) {
    shell.append(element('p', 'hint', 'No GitHub account resolved. Enable the users toolset and reconnect to list your repositories.'));
    return shell;
  }
  shell.append(element('p', 'hint', `Signed in as ${config.ownerLogin}.`));

  const select = element('select');
  select.setAttribute('aria-label', 'Repository');
  const placeholder = element('option', '', 'Choose a repository…');
  placeholder.value = '';
  select.append(placeholder);
  const repos = state.reposPluginId === plugin.id ? state.repos : [];
  if (state.reposPluginId !== plugin.id && !config.selectedRepo) loadRepos(plugin);
  for (const repo of repos) {
    const option = element('option', '', `${repo.fullName}${repo.private ? ' (private)' : ''}`);
    option.value = repo.fullName;
    if (config.selectedRepo === repo.fullName) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', async () => {
    const [owner, ...rest] = select.value.split('/');
    if (!owner || rest.length === 0) return;
    try {
      const updated = await api.plugins.selectRepo(plugin.id, { owner, repo: rest.join('/'), defaultBranch: repos.find((entry) => entry.fullName === select.value)?.defaultBranch });
      const index = state.plugins.findIndex((entry) => entry.id === plugin.id);
      if (index !== -1) state.plugins[index] = updated;
      render();
      showToast(`Working on ${updated.config.selectedRepo}.`);
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
  shell.append(select);
  if (config.selectedRepo) {
    const status = element('div', 'plugin-status ok');
    status.append(icon('check'), element('span', '', `Selected ${config.selectedRepo}`));
    shell.append(status);
  }
  return shell;
}

async function browseFiles(plugin, target) {
  setButtonBusy(target, true, 'Loading…');
  try {
    const listing = await api.plugins.repoList(plugin.id, '');
    target.replaceChildren(icon('server'), document.createTextNode('Browse files'));
    const next = target.nextElementSibling;
    if (next?.classList.contains('repo-browser')) { next.remove(); return; }
    const panel = element('div', 'repo-browser');
    if (listing.error) {
      panel.append(element('p', 'hint', listing.error));
    } else {
      for (const entry of listing.entries) {
        const row = element('div', `repo-file${entry.type === 'directory' ? ' dir' : ''}`);
        row.append(icon(entry.type === 'directory' ? 'server' : 'wrench'), element('span', '', entry.path));
        panel.append(row);
      }
      if (listing.entries.length === 0) panel.append(element('p', 'hint', 'The repository is empty.'));
    }
    target.after(panel);
  } catch (error) {
    showToast(error.message, 'danger');
    target.replaceChildren(icon('server'), document.createTextNode('Browse files'));
  } finally {
    setButtonBusy(target, false);
  }
}

function localCloneSection(plugin) {
  const shell = element('div', 'plugin-repo');
  const row = element('div', 'plugin-step-title');
  row.append(element('span', 'step-num', '3'), document.createTextNode('Local clone'));
  shell.append(row);
  shell.append(element('p', 'hint', 'Advanced: keeps a git clone in the workspace so the assistant can also work on files locally. The MCP tools work on GitHub directly without this.'));
  const actions = element('div', 'row-actions');
  const clone = element('button', 'button small');
  clone.type = 'button';
  clone.append(icon('server'), document.createTextNode(state.cloneStatus[plugin.id] || 'Clone now'));
  clone.disabled = !plugin.config?.selectedRepo;
  clone.addEventListener('click', async () => {
    setButtonBusy(clone, true, 'Cloning…');
    try {
      const result = await api.plugins.clone(plugin.id);
      state.cloneStatus[plugin.id] = result.status === 'cloned' ? 'Cloned' : 'Updated';
      showToast(`Repository ${result.status} at ${result.directory}.`);
      render();
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setButtonBusy(clone, false);
    }
  });
  const browse = element('button', 'button small secondary');
  browse.type = 'button';
  browse.append(icon('server'), document.createTextNode('Browse files'));
  browse.disabled = !plugin.config?.selectedRepo;
  browse.addEventListener('click', () => browseFiles(plugin, browse));
  actions.append(clone, browse);
  shell.append(actions);
  if (!plugin.config?.selectedRepo) shell.append(element('p', 'hint', 'Select a repository above to enable cloning.'));
  return shell;
}

function pluginCard(plugin) {
  const card = element('div', 'plugin-flow');
  const config = plugin.config || {};
  const preset = state.presets.find((entry) => entry.id === config.preset) || { id: config.preset, name: config.presetName || config.preset, description: '', setup: [] };
  const head = element('div', 'plugin-card-head');
  const titleRow = element('div', 'plugin-step-title');
  titleRow.append(element('span', 'step-num', '1'), document.createTextNode(plugin.name));
  titleRow.append(element('span', 'plugin-badge', `${config.presetName || config.preset} · MCP`));
  head.append(titleRow, enableSwitch(plugin));
  card.append(head);
  card.append(statusLine(plugin));
  if (config.writesApproved) {
    const approved = element('div', 'plugin-status ok');
    approved.append(icon('check'), element('span', '', 'Writes approved for your next message'));
    card.append(approved);
  }

  const actions = element('div', 'row-actions');
  const settings = element('button', 'button small secondary');
  settings.type = 'button';
  settings.append(icon('settings'), document.createTextNode('Setup'));
  settings.addEventListener('click', () => openDialog(settings, preset, plugin));
  const test = element('button', 'button small secondary');
  test.type = 'button';
  test.append(icon('plug'), document.createTextNode('Test'));
  test.addEventListener('click', async () => {
    setButtonBusy(test, true, 'Testing…');
    try {
      const result = await api.plugins.inspect(plugin.id);
      showToast(`${result.server?.name || 'Server'} answered with ${result.toolCount} tools.`);
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setButtonBusy(test, false);
    }
  });
  const approve = element('button', 'button small');
  approve.type = 'button';
  approve.append(icon('check'), document.createTextNode('Approve writes'));
  approve.title = 'Lets the assistant run one message worth of this server\'s tools that change data.';
  approve.addEventListener('click', async () => {
    setButtonBusy(approve, true, 'Approving…');
    try {
      await api.plugins.approveWrites(plugin.id);
      await load();
      showToast('Writes approved for the next message.');
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setButtonBusy(approve, false);
    }
  });
  const remove = element('button', 'button small danger');
  remove.type = 'button';
  remove.append(icon('trash'), document.createTextNode('Remove'));
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Remove the plugin "${plugin.name}"?`)) return;
    remove.disabled = true;
    try {
      await api.plugins.remove(plugin.id);
      await load();
      showToast('Plugin removed.');
    } catch (error) {
      remove.disabled = false;
      showToast(error.message, 'danger');
    }
  });
  actions.append(settings, test, approve, remove);
  card.append(actions);

  if (config.accountAware) {
    card.append(repoSection(plugin));
    if (config.localClone) card.append(localCloneSection(plugin));
  }

  const toolCount = config.toolCount || 0;
  if (toolCount > 0) {
    const toggle = element('button', 'link-button', state.openTools.has(plugin.id) ? 'Hide tools' : `Show the ${toolCount} tools the assistant gets`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      if (state.openTools.has(plugin.id)) state.openTools.delete(plugin.id);
      else state.openTools.add(plugin.id);
      render();
    });
    card.append(toggle);
    if (state.openTools.has(plugin.id)) card.append(toolsPanel(plugin));
  }
  return card;
}

// The catalog only ever shows the servers Glow Agent ships, and each one can be added once.
function renderPresets() {
  presetState.replaceChildren();
  if (state.presets.length === 0) {
    presetState.append(element('p', 'hint', 'No MCP servers are available.'));
    return;
  }
  for (const preset of state.presets) {
    const card = element('div', 'preset-card');
    const body = element('div', 'preset-body');
    body.append(element('h3', 'preset-name', preset.name));
    body.append(element('p', 'hint', preset.description));
    body.append(element('p', 'preset-fields', preset.setup.length === 0
      ? 'No setup needed'
      : `${preset.setup.length} setup question${preset.setup.length === 1 ? '' : 's'}`));
    card.append(body);
    const installed = state.plugins.find((plugin) => plugin.config?.preset === preset.id);
    const add = element('button', 'button small');
    add.type = 'button';
    if (installed) {
      add.append(icon('check'), document.createTextNode('Added'));
      add.disabled = true;
      add.title = `${preset.name} is already set up.`;
    } else {
      add.append(icon('plus'), document.createTextNode(preset.setup.length === 0 ? `Add ${preset.name}` : `Set up ${preset.name}`));
      add.addEventListener('click', () => openDialog(add, preset));
    }
    card.append(add);
    presetState.append(card);
  }
}

function render() {
  pluginsCount.textContent = state.plugins.length ? `${state.plugins.length} added` : '';
  pluginsState.replaceChildren();
  if (state.plugins.length === 0) {
    pluginsState.append(element('p', 'hint', 'Nothing added yet. Pick a server below.'));
  } else {
    for (const plugin of state.plugins) pluginsState.append(pluginCard(plugin));
  }
  renderPresets();
}

async function load() {
  try {
    const [plugins, presets] = await Promise.all([api.plugins.list(), api.plugins.presets()]);
    state.plugins = plugins;
    state.presets = presets;
    render();
  } catch (error) {
    pluginsState.replaceChildren(element('p', 'hint', error.message));
  }
}

form.addEventListener('submit', submitDialog);
document.getElementById('closePresetDialog').addEventListener('click', closeDialog);
dialog.addEventListener('close', () => {
  editingPluginId = null;
  dialogPreset = null;
  dialogFields = new Map();
  dialogHints = new Map();
});

load();
