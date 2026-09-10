import { api } from './api.js';
import { element, icon, showToast, setButtonBusy } from './ui.js';

const state = {
  plugins: [],
  repos: [],
  reposPluginId: null,
  cloneStatus: {},
  openTools: new Set()
};

const pluginsState = document.getElementById('pluginsState');
const pluginsCount = document.getElementById('pluginsCount');
const dialog = document.getElementById('githubDialog');
const form = document.getElementById('githubForm');
const saveGithub = document.getElementById('saveGithub');
const presetSelect = document.getElementById('preset');
const modeSelect = document.getElementById('mode');
const modeHint = document.getElementById('modeHint');
const transportSelect = document.getElementById('transport');
const githubFields = document.getElementById('githubFields');
const customFields = document.getElementById('customFields');
let dialogOpener = document.getElementById('openPluginDialog');
let editingPluginId = null;

const MODE_HINTS = {
  remote: 'GitHub hosts the server at https://api.githubcopilot.com/mcp/. Nothing to install; a personal access token is sent as a bearer header.',
  'local-docker': 'Runs ghcr.io/github/github-mcp-server in Docker and talks to it over stdio. Leave the token empty to use the image\'s own browser sign-in.',
  'local-binary': 'Runs a github-mcp-server binary on this machine with the stdio argument.'
};

function parseJsonField(value, fallback, label) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function syncDialogFields() {
  const preset = presetSelect.value;
  githubFields.hidden = preset !== 'github';
  customFields.hidden = preset !== 'custom';
  modeHint.textContent = MODE_HINTS[modeSelect.value] || '';
  const http = transportSelect.value === 'http';
  for (const id of ['url', 'headers']) document.getElementById(id).closest('.field').hidden = !http;
  for (const id of ['command', 'args', 'env']) document.getElementById(id).closest('.field').hidden = http;
  const binaryField = document.getElementById('binary').closest('.field');
  binaryField.hidden = preset !== 'github' || modeSelect.value !== 'local-binary';
}

function openDialog(opener, plugin = null) {
  dialogOpener = opener;
  editingPluginId = plugin?.id || null;
  form.reset();
  const config = plugin?.config || {};
  presetSelect.value = config.preset === 'custom' ? 'custom' : 'github';
  modeSelect.value = config.mode || 'remote';
  transportSelect.value = config.transport === 'stdio' ? 'stdio' : 'http';
  document.getElementById('toolsets').value = (config.toolsets || []).join(',');
  document.getElementById('readOnly').checked = Boolean(config.readOnly);
  document.getElementById('localClone').checked = Boolean(config.localClone);
  document.getElementById('binary').value = '';
  document.getElementById('url').value = config.url || '';
  document.getElementById('command').value = config.command || '';
  document.getElementById('args').value = (config.args || []).length ? JSON.stringify(config.args) : '';
  // Secrets are never sent back to the browser, so the token/header/env fields start empty.
  document.getElementById('token').placeholder = config.hasToken ? 'Saved — enter a new value to replace it' : 'ghp_… or github_pat_…';
  syncDialogFields();
  dialog.showModal();
  setTimeout(() => document.getElementById('token').focus(), 20);
}

function closeDialog() {
  dialog.close();
  dialogOpener?.focus();
}

async function submitDialog(event) {
  event.preventDefault();
  let values;
  try {
    if (presetSelect.value === 'github') {
      const token = document.getElementById('token').value.trim();
      values = {
        preset: 'github',
        github: {
          mode: modeSelect.value,
          toolsets: splitList(document.getElementById('toolsets').value),
          readOnly: document.getElementById('readOnly').checked,
          localClone: document.getElementById('localClone').checked,
          ...(token ? { token } : {}),
          ...(document.getElementById('binary').value.trim() ? { binary: document.getElementById('binary').value.trim() } : {})
        }
      };
    } else {
      values = {
        preset: 'custom',
        transport: transportSelect.value,
        url: document.getElementById('url').value.trim(),
        headers: parseJsonField(document.getElementById('headers').value, {}, 'Headers'),
        command: document.getElementById('command').value.trim(),
        args: Object.values(parseJsonField(document.getElementById('args').value, [], 'Arguments')),
        env: parseJsonField(document.getElementById('env').value, {}, 'Environment')
      };
    }
  } catch (error) {
    showToast(error.message, 'danger');
    return;
  }
  setButtonBusy(saveGithub, true, 'Connecting…');
  try {
    const pluginId = editingPluginId || (await api.plugins.create({ type: 'mcp', preset: values.preset })).id;
    await api.plugins.configure(pluginId, values);
    await api.plugins.connect(pluginId);
    closeDialog();
    await load();
    showToast('MCP server connected.');
  } catch (error) {
    showToast(error.message, 'danger');
    await load();
  } finally {
    setButtonBusy(saveGithub, false, 'Connect server');
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
      showToast(updated.enabled ? `${plugin.name} enabled.` : `${plugin.name} disabled.`);
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
  const config = plugin.config || {};
  const row = element('div', 'plugin-step-title');
  row.append(element('span', 'step-num', '2'), document.createTextNode('Repository'));
  const refresh = element('button', 'link-button', 'Reload');
  refresh.type = 'button';
  refresh.addEventListener('click', () => loadRepos(plugin));
  row.append(refresh);
  shell.append(row);

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
  const head = element('div', 'plugin-card-head');
  const titleRow = element('div', 'plugin-step-title');
  titleRow.append(element('span', 'step-num', '1'), document.createTextNode(plugin.name));
  const badge = element('span', 'plugin-badge', plugin.config?.preset === 'github' ? 'GitHub MCP' : 'MCP');
  titleRow.append(badge);
  head.append(titleRow, enableSwitch(plugin));
  card.append(head);
  card.append(statusLine(plugin));

  const actions = element('div', 'row-actions');
  const settings = element('button', 'button small secondary');
  settings.type = 'button';
  settings.append(icon('settings'), document.createTextNode('Settings'));
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
  approve.title = 'Lets the assistant run one message worth of tools that change data.';
  approve.addEventListener('click', async () => {
    setButtonBusy(approve, true, 'Approving…');
    try {
      await api.plugins.approveWrites(plugin.id);
      showToast('Writes approved for the next message.');
    } catch (error) {
      showToast(error.message, 'danger');
    } finally {
      setButtonBusy(approve, false);
    }
  });
  const remove = element('button', 'button small danger');
  remove.type = 'button';
  remove.append(icon('trash'), document.createTextNode('Delete'));
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Delete the plugin "${plugin.name}"?`)) return;
    remove.disabled = true;
    try {
      await api.plugins.remove(plugin.id);
      await load();
      showToast('Plugin deleted.');
    } catch (error) {
      remove.disabled = false;
      showToast(error.message, 'danger');
    }
  });
  actions.append(settings, test, approve, remove);
  card.append(actions);

  if (plugin.config?.preset === 'github') {
    card.append(repoSection(plugin));
    if (plugin.config?.localClone) card.append(localCloneSection(plugin));
  }

  const toolCount = plugin.config?.toolCount || 0;
  if (toolCount > 0) {
    const toggle = element('button', 'link-button', state.openTools.has(plugin.id) ? 'Hide tools' : `Show ${toolCount} tools`);
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

function render() {
  pluginsCount.textContent = state.plugins.length ? `${state.plugins.length} installed` : '';
  pluginsState.replaceChildren();
  if (state.plugins.length === 0) {
    const empty = element('div', 'empty-state');
    empty.append(element('h2', '', 'No plugins yet'));
    empty.append(element('p', 'hint', 'Add the GitHub MCP server and the assistant can read and change your repositories.'));
    const add = element('button', 'button');
    add.type = 'button';
    add.append(icon('plus'), document.createTextNode('Add GitHub MCP server'));
    add.addEventListener('click', () => openDialog(add));
    empty.append(add);
    pluginsState.append(empty);
    return;
  }
  const add = element('button', 'button small secondary');
  add.type = 'button';
  add.append(icon('plus'), document.createTextNode('Add another MCP server'));
  add.addEventListener('click', () => openDialog(add));
  pluginsState.append(add);
  for (const plugin of state.plugins) pluginsState.append(pluginCard(plugin));
}

async function load() {
  try {
    state.plugins = await api.plugins.list();
    render();
  } catch (error) {
    pluginsState.replaceChildren(element('p', 'hint', error.message));
  }
}

presetSelect.addEventListener('change', syncDialogFields);
modeSelect.addEventListener('change', syncDialogFields);
transportSelect.addEventListener('change', syncDialogFields);
form.addEventListener('submit', submitDialog);
document.getElementById('closeGithubDialog').addEventListener('click', closeDialog);
document.getElementById('cancelGithub').addEventListener('click', closeDialog);
dialog.addEventListener('close', () => { editingPluginId = null; });

load();
