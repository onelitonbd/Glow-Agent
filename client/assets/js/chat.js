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
  selectedProviderId: null,
  selectedModelId: null
};
const chatLog = document.getElementById('chatLog');
const title = document.getElementById('conversationTitle');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendMessage');
const modelTrigger = document.getElementById('openModelPicker');
const skillTrigger = document.getElementById('openSkills');
const toolTrigger = document.getElementById('openTools');
const modelDialog = document.getElementById('modelDialog');
const modelOptions = document.getElementById('modelOptions');
const modelPickerHint = document.getElementById('modelPickerHint');
const skillsDialog = document.getElementById('skillsDialog');
const toolsDialog = document.getElementById('toolsDialog');
const chatToolOptions = document.getElementById('chatToolOptions');
const chatSkillOptions = document.getElementById('chatSkillOptions');
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

function toolDisplay(toolId) {
  return toolId === 'calculator' ? { label: 'Calculator', icon: 'calculator' } : { label: 'Current time', icon: 'clock' };
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
    if (message.role === 'assistant' && message.reasoning) {
      const thinking = element('details', `thinking${message.isStreaming ? ' is-streaming' : ''}`);
      thinking.open = Boolean(message.isStreaming);
      thinking.append(element('summary', '', 'Thinking'));
      thinking.append(element('div', 'thinking-content', message.reasoning));
      bubble.append(thinking);
    }
    if (message.content) {
      if (message.role === 'assistant') bubble.append(renderMarkdown(message.content, { streaming: Boolean(message.isStreaming) }));
      else bubble.append(document.createTextNode(message.content));
    }
    if (message.role === 'assistant' && Array.isArray(message.toolEvents) && message.toolEvents.length) {
      bubble.append(renderToolEvents(message.toolEvents));
    }
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

async function loadWorkspace() {
  try {
    const [conversations, skills, tools] = await Promise.all([api.conversations.list(), api.skills.list(), api.tools.list()]);
    state.conversations = conversations;
    state.skills = skills;
    state.tools = tools;
    renderConversationList();
    renderSkillPicker();
    renderToolPicker();
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

function appendStreamDelta(type, text) {
  if (!text || !state.conversation) return;
  const messages = state.conversation.messages || (state.conversation.messages = []);
  let assistant = messages.find((message) => message.id === 'streaming-assistant');
  if (!assistant) {
    assistant = { id: 'streaming-assistant', role: 'assistant', content: '', reasoning: '', isStreaming: true };
    messages.push(assistant);
  }
  if (type === 'thinking') assistant.reasoning += text;
  if (type === 'token') assistant.content += text;
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
    const result = await api.conversations.streamRespond(conversation.id, {
      message,
      providerId: state.selectedProviderId,
      modelId: state.selectedModelId,
      toolIds: state.tools.map((tool) => tool.id)
    }, async (eventName, payload) => {
      if (eventName === 'thinking') appendStreamDelta('thinking', payload.text);
      if (eventName === 'token') appendStreamDelta('token', payload.text);
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
