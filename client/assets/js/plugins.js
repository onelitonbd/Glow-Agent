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
const dialog = document.getElementById('githubDialog');
const form = document.getElementById('githubForm');
const saveGithub = document.getElementById('saveGithub');
const modeSelect = document.getElementById('mode');
const modeHint = document.getElementById('modeHint');
const tokenInput = document.getElementById('token');
let dialogOpener = null;
let editingPluginId = null;

const MODE_HINTS = {
  remote: 'GitHub hosts the server at https://api.githubcopilot.com/mcp/. Nothing to install; the token is sent as a bearer header.',
  'local-docker': 'Runs ghcr.io/github/github-mcp-server in Docker over stdio. Leave the token empty to use the image\'s own browser sign-in.',
  'local-binary': 'Runs a github-mcp-server binary on this machine with the stdio argument.'
};

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function syncDialogFields() {
  modeHint.textContent = MODE_HINTS[modeSelect.value] || '';
  // The binary path only applies to the native-binary mode; the host applies to all three.
  document.getElementById('binaryField').hidden = modeSelect.value !== 'local-binary';
  document.getElementById('hostField').hidden = false;
}

function openDialog(opener, plugin = null) {
  dialogOpener = opener;
  editingPluginId = plugin?.id || null;
  form.reset();
  const config = plugin?.config || {};
  modeSelect.value = config.mode || 'remote';
  document.getElementById('toolsets').value = (config.toolsets || []).join(',');
  document.getElementById('host').value = config.host || '';
  document.getElementById('readOnly').checked = Boolean(config.readOnly);
  document.getElementById('localClone').checked = Boolean(config.localClone);
  document.getElementById('binary').value = config.binary || '';
  tokenInput.placeholder = config.hasToken ? 'Saved — enter a new value to replace it' : 'ghp_… or github_pat_…';
  syncDialogFields();
  dialog.showModal();
  setTimeout(() => tokenInput.focus(), 20);
}

function closeDialog() {
  dialog.close();
  dialogOpener?.focus();
}

async function submitDialog(event) {
  event.preventDefault();
  const token = tokenInput.value.trim();
  const values = {
    preset: 'github',
    github: {
      mode: modeSelect.value,
      toolsets: splitList(document.getElementById('toolsets').value),
      readOnly: document.getElementById('readOnly').checked,
      localClone: document.getElementById('localClone').checked,
      host: document.getElementById('host').value.trim(),
      binary: document.getElementById('binary').value.trim(),
      // An empty token means "keep whatever is stored", so it is simply not sent.
      ...(token ? { token } : {})
    }
  };
  setButtonBusy(saveGithub, true, 'Connecting…');
  try {
    const pluginId = editingPluginId || (await api.plugins.create({ type: 'mcp', preset: 'github' })).id;
    await api.plugins.configure(pluginId, values);
    await api.plugins.connect(pluginId);
    closeDialog();
    await load();
    showToast('GitHub MCP server connected.');
  } catch (error) {
    showToast(error.message, 'danger');
    await load();
  } finally {
    setButtonBusy(saveGithub, false, 'Connect');
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
  settings.addEventListener('click', () => openDialog(settings, plugin));
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
    card.append(body);
    const installed = state.plugins.find((plugin) => plugin.config?.preset === preset.id);
    const add = element('button', 'button small');
    add.type = 'button';
    if (installed) {
      add.append(icon('check'), document.createTextNode('Added'));
      add.disabled = true;
      add.title = `${preset.name} is already set up.`;
    } else {
      add.append(icon('plus'), document.createTextNode(`Add ${preset.name}`));
      add.addEventListener('click', () => openDialog(add));
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

modeSelect.addEventListener('change', syncDialogFields);
form.addEventListener('submit', submitDialog);
document.getElementById('closeGithubDialog').addEventListener('click', closeDialog);
document.getElementById('cancelGithub').addEventListener('click', closeDialog);
dialog.addEventListener('close', () => { editingPluginId = null; });

load();
