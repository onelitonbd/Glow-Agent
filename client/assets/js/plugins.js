import { api } from './api.js';
import { element, icon, showToast, setButtonBusy } from './ui.js';

const state = {
  plugins: [],
  repos: [],
  selectedPluginId: null,
  cloneStatus: {}
};

const pluginsState = document.getElementById('pluginsState');
const pluginsCount = document.getElementById('pluginsCount');
const dialog = document.getElementById('githubDialog');
const form = document.getElementById('githubForm');
const dialogTitle = document.getElementById('githubDialogTitle');
const saveGithub = document.getElementById('saveGithub');
const clientIdInput = document.getElementById('clientId');
const clientSecretInput = document.getElementById('clientSecret');
const codeInput = document.getElementById('code');
const callbackUrlLabel = document.getElementById('callbackUrlLabel');
let dialogOpener = document.getElementById('openPluginDialog');

function githubPlugin() {
  return state.plugins.find((plugin) => plugin.type === 'github') || null;
}

function openDialog(opener) {
  dialogOpener = opener;
  form.reset();
  callbackUrlLabel.textContent = `${window.location.origin}/plugins.html`;
  dialog.showModal();
  setTimeout(() => clientIdInput.focus(), 20);
}

function closeDialog() {
  dialog.close();
  dialogOpener?.focus();
}

function actionMenu(plugin, shell) {
  const menu = element('div', 'overflow-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Actions for ${plugin.name}`);
  const remove = element('button', 'menu-danger', 'Delete plugin');
  remove.type = 'button'; remove.setAttribute('role', 'menuitem'); remove.prepend(icon('trash'));
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await api.plugins.remove(plugin.id);
      state.selectedPluginId = null;
      await load();
      showToast('Plugin deleted.');
    } catch (error) {
      remove.disabled = false;
      showToast(error.message, 'danger');
    }
  });
  menu.append(remove);
  shell.append(menu);
}

function avatar(plugin) {
  const node = element('span', 'plugin-avatar');
  node.setAttribute('aria-hidden', 'true');
  if (plugin.config?.avatarUrl) {
    const image = new Image();
    image.alt = plugin.config.account || 'GitHub account';
    image.src = plugin.config.avatarUrl;
    image.referrerPolicy = 'no-referrer';
    node.append(image);
  } else {
    node.append(icon('server'));
  }
  return node;
}

function statusLine(kind, text) {
  const status = element('div', `plugin-status ${kind}`);
  status.append(document.createElement('i'), document.createTextNode(text));
  return status;
}

function enableSwitch(plugin) {
  const toggle = element('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(plugin.enabled));
  toggle.setAttribute('aria-label', plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`);
  toggle.title = plugin.enabled ? 'Click to disable for chat' : 'Click to enable for chat';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      const updated = await api.plugins.update(plugin.id, { enabled: !plugin.enabled });
      const index = state.plugins.findIndex((entry) => entry.id === plugin.id);
      if (index !== -1) state.plugins[index] = updated;
      toggle.disabled = false;
      render();
      showToast(updated.enabled ? `${plugin.name} enabled.` : `${plugin.name} disabled.`);
    } catch (error) {
      toggle.disabled = false;
      showToast(error.message, 'danger');
    }
  });
  return toggle;
}

function connectedCard(plugin) {
  const shell = element('div', 'plugin-flow');
  const connected = plugin.config.hasToken;

  if (!connected) {
    const connect = element('button', 'button small', 'Connect GitHub'); connect.type = 'button';
    connect.prepend(icon('server'));
    connect.addEventListener('click', () => openDialog(connect));
    const step = element('div', 'plugin-step');
    step.append(element('div', 'plugin-step-title', 'Connect your account'));
    step.append(statusLine('busy', 'Not connected yet'));
    step.append(connect);
    shell.append(step);
  } else {
    const accountStep = element('div', 'plugin-step');
    accountStep.append(element('div', 'plugin-step-title', 'Signed in as'));
    const account = element('div', 'plugin-account');
    account.append(avatar(plugin), (() => {
      const copy = element('span');
      copy.append(element('b', 'data-name', plugin.config.account || plugin.config.ownerLogin || 'GitHub account'));
      copy.append(element('span', 'data-subtitle', `@${plugin.config.ownerLogin || plugin.config.owner || ''} · connected`));
      return copy;
    })());
    accountStep.append(account);
    accountStep.append(statusLine('ok', 'Connected to GitHub'));
    shell.append(accountStep);
  }

  const repoStep = element('div', 'plugin-step');
  repoStep.append(element('div', 'plugin-step-title', 'Choose a repository'));
  if (connected) {
    const selectWrap = element('div', 'field');
    const label = element('label', '', 'Repository');
    label.append(element('span', '', 'FROM  YOUR  ACCOUNT'));
    const select = element('select');
    select.setAttribute('aria-label', 'Repository');
    select.append(element('option', '', state.repos.length ? 'Loading repositories…' : 'No repositories found'));
    state.repos.forEach((repo) => {
      const option = element('option', '', repo.fullName);
      option.value = repo.fullName;
      if (plugin.config.selectedRepo === repo.fullName) option.selected = true;
      select.append(option);
    });
    select.addEventListener('change', async () => {
      const fullName = select.value;
      const repo = state.repos.find((entry) => entry.fullName === fullName);
      if (!repo) return;
      setButtonBusy(select, true, 'Selecting…');
      try {
        await api.plugins.selectRepo(plugin.id, { owner: repo.owner, repo: repo.name, defaultBranch: repo.defaultBranch });
        setButtonBusy(select, false);
        await load();
        showToast(`Repository ${fullName} selected. It will be cloned on your next message.`);
      } catch (error) {
        setButtonBusy(select, false);
        showToast(error.message, 'danger');
      }
    });
    selectWrap.append(label, select);
    repoStep.append(selectWrap);

    if (!plugin.config.selectedRepo) {
      repoStep.append(statusLine('busy', 'Select a repository above to enable cloning.'));
    } else {
      const clone = element('button', 'button small full', 'Clone now'); clone.type = 'button';
      clone.prepend(icon('spark'));
      clone.addEventListener('click', async () => {
        setButtonBusy(clone, true, 'Cloning…');
        state.cloneStatus[plugin.id] = { kind: 'busy', text: 'Cloning the repository…' };
        render();
        try {
          const result = await api.plugins.clone(plugin.id);
          state.cloneStatus[plugin.id] = { kind: 'ok', text: `Cloned ${result.repository} (${result.status})`.trim() };
          await load();
          showToast('Repository cloned into the local workspace.');
        } catch (error) {
          state.cloneStatus[plugin.id] = { kind: 'error', text: error.message };
          render();
          showToast(error.message, 'danger');
        } finally {
          setButtonBusy(clone, false);
          clone.disabled = false;
        }
      });
      repoStep.append(clone);

      const status = state.cloneStatus[plugin.id] || statusLineForPlugin(plugin);
      if (status) repoStep.append(status);

      const browse = element('button', 'button small full', 'Browse files'); browse.type = 'button';
      browse.prepend(icon('spark'));
      browse.addEventListener('click', async () => {
        setButtonBusy(browse, true, 'Loading…');
        try {
          const listing = await api.plugins.repoList(plugin.id, '');
          setButtonBusy(browse, false);
          if (listing.error) {
            showToast(listing.error, 'danger');
            return;
          }
          const panel = element('div', 'repo-browser');
          const entries = Array.isArray(listing.entries) ? listing.entries : [];
          if (entries.length === 0) panel.append(element('p', 'hint', 'This repository is empty.'));
          entries.forEach((entry) => {
            const row = element('div', `repo-file${entry.type === 'directory' ? ' dir' : ''}`);
            const dot = element('span', 'repo-file-toggle'); dot.setAttribute('aria-hidden', 'true');
            row.append(dot, document.createTextNode(entry.path));
            row.addEventListener('click', async () => {
              if (entry.type === 'directory') {
                const child = await api.plugins.repoList(plugin.id, entry.path);
                if (child.error) { showToast(child.error, 'danger'); return; }
                (child.entries || []).forEach((childEntry) => {
                  const childRow = element('div', `repo-file${childEntry.type === 'directory' ? ' dir' : ''}`);
                  childRow.append(document.createElement('span'), document.createTextNode(childEntry.path));
                  panel.append(childRow);
                });
              }
            });
            panel.append(row);
          });
          repoStep.append(panel);
        } catch (error) {
          setButtonBusy(browse, false);
          showToast(error.message, 'danger');
        }
      });
      repoStep.append(browse);
    }
  } else {
    repoStep.append(statusLine('busy', 'Connect GitHub to choose a repository.'));
  }
  shell.append(repoStep);
  return shell;
}
function statusLineForPlugin(plugin) {
  if (plugin.config.selectedRepo) {
    return statusLine(plugin.enabled ? 'ok' : 'busy', plugin.enabled ? `Selected ${plugin.config.selectedRepo}` : `Selected ${plugin.config.selectedRepo} · enable to use`);
  }
  return null;
}

function pluginCard(plugin) {
  const shell = element('div', 'list-shell');
  const card = element('article', 'card data-card');
  const top = element('div', 'data-card-top');
  const pluginIcon = element('span', 'data-icon violet');
  pluginIcon.setAttribute('aria-hidden', 'true'); pluginIcon.append(icon('server'));
  const copy = element('span');
  copy.append(element('b', 'data-name', plugin.name), element('span', 'data-subtitle', 'GitHub · repositories & commits'));
  const toggle = enableSwitch(plugin);
  top.append(pluginIcon, copy, toggle);
  const meta = element('div', 'data-meta');
  const dot = document.createElement('i');
  meta.append(dot, document.createTextNode(plugin.enabled ? 'Enabled for chat' : 'Disabled for chat'));
  card.append(top, meta, connectedCard(plugin));
  shell.append(card);
  return shell;
}

function render() {
  pluginsState.replaceChildren();
  pluginsCount.textContent = `${state.plugins.length} ${state.plugins.length === 1 ? 'plugin' : 'plugins'}`;
  if (state.plugins.length === 0) {
    const empty = element('div', 'empty-state');
    const mark = element('span', 'empty-icon'); mark.setAttribute('aria-hidden', 'true'); mark.append(icon('server'));
    const add = element('button', 'button full', 'Add GitHub plugin'); add.type = 'button'; add.prepend(icon('plus'));
    add.addEventListener('click', async () => {
      setButtonBusy(add, true, 'Adding…');
      try {
        await api.plugins.create({ type: 'github', name: 'GitHub' });
        await load();
        showToast('GitHub plugin added.');
      } catch (error) {
        setButtonBusy(add, false);
        showToast(error.message, 'danger');
      }
    });
    empty.append(mark, element('h2', '', 'No plugins yet'), element('p', '', 'Add the GitHub plugin to let the assistant work on a cloned repository.'), add);
    pluginsState.append(empty);
    return;
  }
  const list = element('div', 'list');
  state.plugins.forEach((plugin) => list.append(pluginCard(plugin)));
  pluginsState.append(list);
}

async function load() {
  pluginsState.replaceChildren(element('div', 'loading', 'Loading plugins'));
  try {
    state.plugins = await api.plugins.list();
    const plugin = githubPlugin();
    if (plugin?.config?.hasToken) {
      try { state.repos = await api.plugins.githubRepos(plugin.id); } catch { state.repos = []; }
    } else {
      state.repos = [];
    }
    render();
  } catch (error) {
    const empty = element('div', 'empty-state');
    const retry = element('button', 'button secondary full', 'Try again'); retry.type = 'button'; retry.addEventListener('click', load);
    empty.append(element('h2', '', 'Could not load plugins'), element('p', '', error.message), retry);
    pluginsState.append(empty);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const plugin = githubPlugin();
  if (!plugin) { closeDialog(); return; }
  const values = { clientId: clientIdInput.value, clientSecret: clientSecretInput.value, code: codeInput.value };
  setButtonBusy(saveGithub, true, 'Connecting…');
  try {
    await api.plugins.connectGithub(plugin.id, values);
    state.repos = [];
    state.cloneStatus[plugin.id] = { kind: 'ok', text: 'Connected to GitHub' };
    closeDialog();
    await load();
    showToast('GitHub connected.');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    setButtonBusy(saveGithub, false);
  }
});

document.getElementById('closeGithubDialog').addEventListener('click', closeDialog);
document.getElementById('cancelGithub').addEventListener('click', closeDialog);
dialog.addEventListener('cancel', () => setTimeout(() => dialogOpener?.focus(), 0));
load();
