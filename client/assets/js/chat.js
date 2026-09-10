import { api } from './api.js';
import { renderMarkdown } from './markdown.js';
import { element, icon, showToast } from './ui.js';

const state = {
  conversations: [],
  conversation: null,
  providers: [],
  availableModels: [],
  skills: [],
  tools: [],
  plugins: [],
  selectedProviderId: null,
  selectedModelId: null,
  selectedPluginId: null,
  pluginRepos: []
};
const chatLog = document.getElementById('chatLog');
const title = document.getElementById('conversationTitle');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendMessage');
const modelTrigger = document.getElementById('openModelPicker');
const skillTrigger = document.getElementById('openSkills');
const toolTrigger = document.getElementById('openTools');
const pluginTrigger = document.getElementById('openPlugins');
const modelDialog = document.getElementById('modelDialog');
const modelOptions = document.getElementById('modelOptions');
const modelPickerHint = document.getElementById('modelPickerHint');
const skillsDialog = document.getElementById('skillsDialog');
const toolsDialog = document.getElementById('toolsDialog');
const chatToolOptions = document.getElementById('chatToolOptions');
const chatSkillOptions = document.getElementById('chatSkillOptions');
const chatPluginOptions = document.getElementById('chatPluginOptions');
const historyDrawer = document.getElementById('historyDrawer');
const conversationList = document.getElementById('conversationList');
const themeToggle = document.getElementById('toggleTheme');

function selectedModel() {
  return state.availableModels.find((entry) => entry.providerId === state.selectedProviderId && entry.modelId === state.selectedModelId) || null;
}

function syncThemeToggle() {
  if (!themeToggle) return;
  const theme = window.GlowTheme?.current?.() || document.documentElement.dataset.theme || 'dark';
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  themeToggle.replaceChildren(icon(nextTheme === 'light' ? 'sun' : 'moon'));
  themeToggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
  themeToggle.title = `Switch to ${nextTheme} theme`;
  themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
}

const TOOL_NAMES = {
  calculator: 'Calculator',
  current_time: 'Current time',
  read_skill: 'Read skill',
  list_files: 'List files',
  read_file: 'Read file',
  write_file: 'Write file',
  sql_query: 'SQL query',
  web_search: 'Web search',
  fetch_url: 'Fetch URL',
  github_list_repos: 'GitHub list repos',
  github_clone: 'GitHub clone repo',
  github_list_files: 'GitHub list files',
  github_read_file: 'GitHub read file',
  github_write_file: 'GitHub write file',
  github_rename_file: 'GitHub rename file',
  github_delete_file: 'GitHub delete file',
  github_commit: 'GitHub commit',
  github_push: 'GitHub push'
};

function toolIconName(toolId) {
  if (toolId === 'calculator') return 'calculator';
  if (toolId === 'current_time') return 'clock';
  if (toolId.startsWith('github_') || toolId.startsWith('mcp_')) return 'plug';
  return 'spark';
}

// MCP tool ids are discovered at runtime (mcp_<server tool>), so they get a readable label
// instead of a lookup in the static catalog.
function mcpToolLabel(toolId) {
  const bare = toolId.slice(4).replace(/[_-]+/gu, ' ').trim();
  return bare ? `MCP: ${bare.charAt(0).toUpperCase()}${bare.slice(1)}` : 'MCP tool';
}

function toolDisplay(toolId) {
  if (typeof toolId === 'string' && toolId.startsWith('mcp_')) return { label: mcpToolLabel(toolId), icon: 'plug' };
  return { label: TOOL_NAMES[toolId] || toolId || 'Tool', icon: toolIconName(toolId) };
}

function renderThinking(text, open) {
  const details = element('details', `thinking${open ? ' is-streaming' : ''}`);
  details.open = open;
  details.append(element('summary', '', 'Thinking'));
  details.append(element('div', 'thinking-content', text));
  return details;
}

function renderToolCall(name) {
  const card = element('div', 'tool-call');
  const badge = element('span', 'tool-call-icon'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('spark'));
  const label = element('span', 'tool-call-label', `Using ${toolDisplay(name).label}…`);
  card.append(badge, label);
  return card;
}

function renderToolResult(toolId, summary) {
  const info = toolDisplay(toolId);
  const row = element('div', 'tool-event');
  const badge = element('span', 'tool-event-icon'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon(info.icon));
  const text = element('span', 'tool-event-text', summary || info.label);
  row.append(badge, text);
  return row;
}

function renderTimeline(message) {
  const fragment = document.createDocumentFragment();
  const timeline = Array.isArray(message.timeline) ? message.timeline : [];
  const streaming = Boolean(message.isStreaming);
  let index = 0;
  while (index < timeline.length) {
    const entry = timeline[index];
    if (entry.type === 'thinking') {
      let text = '';
      while (index < timeline.length && timeline[index].type === 'thinking') { text += timeline[index].text; index += 1; }
      fragment.append(renderThinking(text, streaming));
    } else if (entry.type === 'content') {
      let text = '';
      while (index < timeline.length && timeline[index].type === 'content') { text += timeline[index].text; index += 1; }
      if (text) fragment.append(renderMarkdown(text, { streaming }));
    } else if (entry.type === 'tool_call') {
      fragment.append(renderToolCall(entry.name));
      index += 1;
    } else if (entry.type === 'tool_result') {
      fragment.append(renderToolResult(entry.toolId, entry.summary));
      index += 1;
    } else {
      index += 1;
    }
  }
  return fragment;
}

function renderStreamStatus(text, tone) {
  const row = element('div', `stream-status${tone === 'warn' ? ' warn' : ''}`);
  const dot = element('span', 'stream-status-dot');
  dot.setAttribute('aria-hidden', 'true');
  row.append(dot, element('span', '', text));
  return row;
}

function renderToolEvents(toolEvents) {
  const wrap = element('div', 'tool-events');
  const head = element('div', 'tool-events-head');
  head.append(icon('spark'));
  const title = element('span', 'tool-events-title', `${toolEvents.length} tool${toolEvents.length === 1 ? '' : 's'} used`);
  head.append(title);
  wrap.append(head);
  const list = element('div', 'tool-events-list');
  toolEvents.forEach((toolEvent) => {
    const info = toolDisplay(toolEvent.toolId);
    const row = element('div', 'tool-event');
    const badge = element('span', 'tool-event-icon'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon(info.icon));
    const text = element('span', 'tool-event-text', toolEvent.summary || info.label);
    row.append(badge, text);
    list.append(row);
  });
  wrap.append(list);
  return wrap;
}

function renderLog() {
  const followLatest = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 56;
  const tableOffsets = [...chatLog.querySelectorAll('.markdown-table-scroll')].map((table) => table.scrollLeft);
  chatLog.replaceChildren();
  title.textContent = state.conversation?.title || 'New conversation';
  const messages = state.conversation?.messages || [];
  if (messages.length === 0) {
    const empty = element('div', 'chat-empty');
    const mark = element('span', 'empty-icon'); mark.setAttribute('aria-hidden', 'true'); mark.append(icon('spark'));
    empty.append(mark, element('h2', '', 'Where should we start?'), element('p', '', 'Add a provider and select a model, then send a message from this private local workspace.'));
    chatLog.append(empty);
    return;
  }
  messages.forEach((message) => {
    const bubble = element('article', `message ${message.role}`);
    if (message.role === 'assistant') {
      const streaming = Boolean(message.isStreaming);
      const hasTimeline = Array.isArray(message.timeline) && message.timeline.length;
      if (hasTimeline) {
        bubble.append(renderTimeline(message));
      } else {
        if (message.reasoning) bubble.append(renderThinking(message.reasoning, streaming));
        if (message.content) bubble.append(renderMarkdown(message.content, { streaming }));
        if (Array.isArray(message.toolEvents) && message.toolEvents.length) bubble.append(renderToolEvents(message.toolEvents));
      }
    } else if (message.content) {
      bubble.append(document.createTextNode(message.content));
    }
    if (message.isStreaming && message.status) bubble.append(renderStreamStatus(message.status, message.statusTone));
    chatLog.append(bubble);
  });
  [...chatLog.querySelectorAll('.markdown-table-scroll')].forEach((table, index) => {
    table.scrollLeft = tableOffsets[index] || 0;
  });
  if (followLatest) chatLog.scrollTop = chatLog.scrollHeight;
}

function renderConversationList() {
  conversationList.replaceChildren();
  if (state.conversations.length === 0) {
    conversationList.append(element('p', 'hint', 'No conversations saved yet.'));
    return;
  }
  state.conversations.forEach((conversation) => {
    const button = element('button', state.conversation?.id === conversation.id ? 'active' : '', conversation.title);
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        state.conversation = await api.conversations.get(conversation.id);
        historyDrawer.close();
        renderConversationList();
        renderLog();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });
    conversationList.append(button);
  });
}

function renderModelPicker() {
  modelOptions.replaceChildren();
  if (state.availableModels.length === 0) {
    modelPickerHint.textContent = 'No selected models yet. Add a provider, fetch its models, and select at least one for chat.';
    const link = element('a', 'button secondary full', 'Open providers'); link.href = '/providers.html';
    modelOptions.append(link);
    return;
  }
  modelPickerHint.textContent = 'The highlighted selection is used for your next message.';
  state.availableModels.forEach((entry) => {
    const isSelected = entry.providerId === state.selectedProviderId && entry.modelId === state.selectedModelId;
    const option = element('button', `model-option${isSelected ? ' selected' : ''}`);
    option.type = 'button';
    const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('database'));
    const copy = element('span', 'copy'); copy.append(element('b', 'data-name', entry.modelId), element('span', 'data-subtitle', entry.providerName));
    option.append(badge, copy);
    if (isSelected) option.append(icon('check'));
    option.addEventListener('click', () => {
      state.selectedProviderId = entry.providerId;
      state.selectedModelId = entry.modelId;
      modelTrigger.classList.add('selected');
      modelTrigger.setAttribute('aria-label', `Selected model: ${entry.modelId}. Choose provider and model.`);
      modelTrigger.title = `${entry.providerName} · ${entry.modelId}`;
      modelDialog.close();
      renderModelPicker();
      showToast(`${entry.modelId} selected.`);
    });
    modelOptions.append(option);
  });
}

function renderSkillPicker() {
  skillTrigger.classList.add('selected');
  skillTrigger.setAttribute('aria-label', 'Skills are always available to the assistant.');
  skillTrigger.title = 'Skills are always available';
  chatSkillOptions.replaceChildren();
  if (state.skills.length === 0) {
    chatSkillOptions.append(element('p', 'hint', 'No skills are available yet. Create one from the Skills page.'));
    return;
  }
  chatSkillOptions.append(element('p', 'hint', 'These skills are always available to the assistant. It reads their instructions when needed.'));
  state.skills.forEach((skill) => {
    const option = element('button', 'model-option selected');
    option.type = 'button';
    const badge = element('span', 'data-icon'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('spark'));
    const copy = element('span', 'copy'); copy.append(element('b', 'data-name', skill.name), element('span', 'data-subtitle', skill.description));
    option.append(badge, copy, icon('check'));
    option.addEventListener('click', () => showToast(`${skill.name} is always available.`));
    chatSkillOptions.append(option);
  });
}


function toolIcon(toolId) {
  return toolId === 'calculator' ? 'calculator' : 'clock';
}

// Every enabled MCP plugin whose server answered the handshake contributes tools to the next
// message. Nothing has to be chosen per message, so the request does not name a plugin.
function activeMcpPlugins() {
  return state.plugins.filter((plugin) => plugin.type === 'mcp' && plugin.enabled && plugin.config?.connected);
}

function setPluginTrigger(count) {
  if (!pluginTrigger) return;
  pluginTrigger.classList.toggle('selected', count > 0);
  pluginTrigger.setAttribute('aria-label', count > 0 ? `${count} MCP plugin${count === 1 ? '' : 's'} enabled for this conversation.` : 'Plugins — connect MCP servers like GitHub');
  pluginTrigger.title = count > 0 ? `${count} plugin${count === 1 ? '' : 's'} enabled` : 'Plugins';
}

function renderPluginPicker() {
  const active = activeMcpPlugins();
  state.selectedPluginId = active[0]?.id || null;
  setPluginTrigger(active.length);
  chatPluginOptions.replaceChildren();
  if (state.plugins.length === 0) {
    chatPluginOptions.append(element('p', 'hint', 'No plugins yet. Add an MCP server from the Plugins page.'));
    return;
  }
  const toolTotal = active.reduce((total, plugin) => total + (plugin.config?.toolCount || 0), 0);
  const repoNote = state.plugins.some((plugin) => plugin.config?.accountAware) ? ' Servers that act on your account also need a repository picked below.' : '';
  chatPluginOptions.append(element('p', 'hint', active.length > 1
    ? `Every switch left on adds its tools to each message — currently ${toolTotal} tools from ${active.length} servers.${repoNote}`
    : `Leave a connected MCP server on to give the assistant its tools.${repoNote}`));
  state.plugins.forEach((plugin) => {
    const card = element('div', 'plugin-flow');
    const config = plugin.config || {};
    const connected = Boolean(config.connected);
    const enabled = Boolean(plugin.enabled);

    const toggle = element('button', `switch${enabled ? ' on' : ''}`);
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.setAttribute('aria-label', enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`);
    const titleRow = element('div', 'plugin-step-title');
    titleRow.append(element('span', 'step-num', '1'), document.createTextNode(plugin.name));
    titleRow.append(toggle);
    card.append(titleRow);

    if (!connected) {
      card.append(element('p', 'hint', config.lastError ? `Not connected — ${config.lastError}` : 'Connect this MCP server on the Plugins page before chat can use it.'));
    } else {
      const status = element('div', 'plugin-status ok');
      status.append(icon('check'), document.createTextNode(`${config.serverName || 'MCP server'} · ${config.toolCount || 0} tools`));
      card.append(status);

      // Only servers that act on your account need a repository choice.
      if (config.accountAware) {
        const repoRow = element('div', 'plugin-step-title');
        repoRow.append(element('span', 'step-num', '2'), document.createTextNode('Repository'));
        card.append(repoRow);
        const select = element('select');
        select.setAttribute('aria-label', 'Repository');
        const repos = state.pluginRepos || [];
        if (repos.length === 0) select.append(element('option', '', config.ownerLogin ? 'Loading repositories…' : 'Enable the users toolset to list repositories'));
        repos.forEach((repo) => {
          const option = element('option', '', repo.fullName);
          option.value = repo.fullName;
          if (config.selectedRepo === repo.fullName) option.selected = true;
          select.append(option);
        });
        select.addEventListener('change', async () => {
          const repo = repos.find((entry) => entry.fullName === select.value);
          if (!repo) return;
          try {
            await api.plugins.selectRepo(plugin.id, { owner: repo.owner, repo: repo.name, defaultBranch: repo.defaultBranch });
            showToast(`Working on ${repo.fullName}.`);
            await loadWorkspace();
          } catch (error) {
            showToast(error.message, 'danger');
          }
        });
        const field = element('div', 'field');
        field.append(select);
        card.append(field);
        if (config.selectedRepo) {
          const selected = element('div', 'plugin-status ok');
          selected.append(icon('check'), document.createTextNode(`Selected ${config.selectedRepo}`));
          card.append(selected);
        }
      }

      const approve = element('button', 'button secondary full', 'Approve writes for the next message');
      approve.type = 'button';
      approve.title = 'MCP tools that change data stay blocked until you approve them.';
      approve.addEventListener('click', async () => {
        approve.disabled = true;
        try {
          await api.plugins.approveWrites(plugin.id);
          showToast('Writes approved for your next message.');
        } catch (error) {
          showToast(error.message, 'danger');
        } finally {
          approve.disabled = false;
        }
      });
      card.append(approve);
    }

    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        const updated = await api.plugins.update(plugin.id, { enabled: !enabled });
        const index = state.plugins.findIndex((entry) => entry.id === plugin.id);
        if (index !== -1) state.plugins[index] = updated;
        renderPluginPicker();
        showToast(updated.enabled ? `${plugin.name} enabled.` : `${plugin.name} disabled.`);
      } catch (error) {
        toggle.disabled = false;
        showToast(error.message, 'danger');
      }
    });
    chatPluginOptions.append(card);
  });
}

function renderToolPicker() {
  toolTrigger.classList.add('selected');
  toolTrigger.setAttribute('aria-label', 'Tools are always enabled for this workspace.');
  toolTrigger.title = 'Tools are always enabled';
  chatToolOptions.replaceChildren();
  if (state.tools.length === 0) {
    chatToolOptions.append(element('p', 'hint', 'No tools are available from the local server.'));
    return;
  }
  chatToolOptions.append(element('p', 'hint', 'These tools are always offered to the model — no selection needed.'));
  state.tools.forEach((tool) => {
    const option = element('button', 'model-option selected');
    option.type = 'button';
    const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon(toolIcon(tool.id)));
    const copy = element('span', 'copy'); copy.append(element('b', 'data-name', tool.name), element('span', 'data-subtitle', tool.description));
    option.append(badge, copy, icon('check'));
    option.addEventListener('click', () => showToast(`${tool.name} is always enabled.`));
    chatToolOptions.append(option);
  });
}

async function loadModels() {
  state.providers = await api.providers.list();
  const results = await Promise.all(state.providers.map(async (provider) => {
    const models = await api.providers.selectedModels(provider.id);
    return models.map((model) => ({ providerId: provider.id, providerName: provider.name, modelId: model.modelId }));
  }));
  state.availableModels = results.flat();
  if (!selectedModel() && state.availableModels.length > 0) {
    state.selectedProviderId = state.availableModels[0].providerId;
    state.selectedModelId = state.availableModels[0].modelId;
    modelTrigger.classList.add('selected');
    modelTrigger.title = `${state.availableModels[0].providerName} · ${state.availableModels[0].modelId}`;
  }
  renderModelPicker();
}

// The repository list comes from the server's own search tool, so it only works once the
// GitHub MCP server is connected (the users + repos toolsets must be enabled).
async function loadPluginRepos() {
  const plugin = state.plugins.find((entry) => entry.type === 'mcp' && entry.config?.connected && entry.config?.preset === 'github');
  if (!plugin) { state.pluginRepos = []; return; }
  try {
    state.pluginRepos = await api.plugins.githubRepos(plugin.id);
  } catch {
    state.pluginRepos = [];
  }
}

async function loadWorkspace() {
  try {
    const [conversations, skills, tools, plugins] = await Promise.all([api.conversations.list(), api.skills.list(), api.tools.list(), api.plugins.list()]);
    state.conversations = conversations;
    state.skills = skills;
    state.tools = tools;
    state.plugins = plugins;
    renderConversationList();
    renderSkillPicker();
    renderToolPicker();
    await loadPluginRepos();
    renderPluginPicker();
    await loadModels();
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function startNewConversation() {
  state.conversation = null;
  messageInput.value = '';
  renderLog();
  renderConversationList();
  messageInput.focus();
}

async function ensureConversation() {
  if (state.conversation) return state.conversation;
  state.conversation = await api.conversations.create();
  state.conversations.unshift(state.conversation);
  renderConversationList();
  return state.conversation;
}

function appendStreamDelta(event, payload) {
  if (!payload || !state.conversation) return;
  if (event === 'started') {
    // Show something immediately so a slow first token never looks like a dead screen.
    const messages = state.conversation.messages || (state.conversation.messages = []);
    if (!messages.find((message) => message.id === 'streaming-assistant')) {
      messages.push({ id: 'streaming-assistant', role: 'assistant', content: '', reasoning: '', timeline: [], isStreaming: true, status: 'Connecting…' });
    }
    renderLog();
    return;
  }
  const messages = state.conversation.messages || (state.conversation.messages = []);
  let assistant = messages.find((message) => message.id === 'streaming-assistant');
  if (!assistant) {
    assistant = { id: 'streaming-assistant', role: 'assistant', content: '', reasoning: '', timeline: [], isStreaming: true };
    messages.push(assistant);
  }
  const timeline = assistant.timeline || (assistant.timeline = []);
  if (event === 'status') {
    assistant.status = payload.text || '';
    assistant.statusTone = payload.tone === 'warn' ? 'warn' : 'info';
    renderLog();
    return;
  }
  // Once real output arrives, drop the connect/retreive line.
  assistant.status = '';
  if (event === 'thinking') {
    assistant.reasoning += payload.text || '';
    timeline.push({ type: 'thinking', text: payload.text });
  } else if (event === 'token') {
    assistant.content += payload.text || '';
    timeline.push({ type: 'content', text: payload.text });
  } else if (event === 'tool_call') {
    timeline.push({ type: 'tool_call', name: payload.name });
  } else if (event === 'tool_result') {
    timeline.push({ type: 'tool_result', toolId: payload.toolId, summary: payload.summary });
  }
  renderLog();
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;
  if (!selectedModel()) {
    showToast('Choose a configured model before sending a message.', 'danger');
    modelDialog.showModal();
    return;
  }
  sendButton.disabled = true;
  try {
    const conversation = await ensureConversation();
    const pendingUserMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content: message,
      createdAt: new Date().toISOString()
    };
    state.conversation = {
      ...conversation,
      messages: [...(state.conversation?.messages || []), pendingUserMessage]
    };
    messageInput.value = '';
    messageInput.style.height = 'auto';
    renderLog();
    const requestBody = {
      message,
      providerId: state.selectedProviderId,
      modelId: state.selectedModelId,
      toolIds: state.tools.map((tool) => tool.id)
    };
    const result = await api.conversations.streamRespond(conversation.id, requestBody, async (eventName, payload) => {
      if (eventName === 'started' || eventName === 'status' || eventName === 'thinking' || eventName === 'token' || eventName === 'tool_call' || eventName === 'tool_result') {
        appendStreamDelta(eventName, payload);
      }
    });
    state.conversation = result.conversation;
    await loadWorkspace();
    renderLog();
  } catch (error) {
    showToast(error.message, 'danger');
    if (state.conversation) {
      try { state.conversation = await api.conversations.get(state.conversation.id); renderLog(); } catch { /* Preserve the current UI after an upstream failure. */ }
    }
  } finally {
    sendButton.disabled = false;
  }
});

document.getElementById('openModelPicker').addEventListener('click', () => { renderModelPicker(); modelDialog.showModal(); });
document.getElementById('openSkills').addEventListener('click', () => { renderSkillPicker(); skillsDialog.showModal(); });
document.getElementById('openTools').addEventListener('click', () => { renderToolPicker(); toolsDialog.showModal(); });
document.getElementById('openPlugins')?.addEventListener('click', () => { renderPluginPicker(); document.getElementById('pluginsDialog').showModal(); });
document.getElementById('attachButton').addEventListener('click', () => showToast('Attachments are the next capability phase.'));
themeToggle?.addEventListener('click', () => { window.GlowTheme?.toggle?.(); });
document.addEventListener('glow-theme-change', syncThemeToggle);
document.getElementById('openHistory').addEventListener('click', () => { renderConversationList(); historyDrawer.showModal(); });
document.getElementById('closeHistory').addEventListener('click', () => historyDrawer.close());
document.getElementById('newConversation').addEventListener('click', startNewConversation);
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
document.querySelectorAll('.coming-soon').forEach((button) => button.addEventListener('click', () => {
  historyDrawer.close();
  showToast(`${button.dataset.route} is the next workspace capability.`);
}));
messageInput.addEventListener('input', () => { messageInput.style.height = 'auto'; messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`; });
syncThemeToggle();
renderLog();
loadWorkspace();
