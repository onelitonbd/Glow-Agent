import { api } from './api.js';
import { element, icon, showToast, formatDate } from './ui.js';

const state = {
  conversations: [],
  conversation: null,
  providers: [],
  availableModels: [],
  skills: [],
  selectedProviderId: null,
  selectedModelId: null,
  selectedSkillIds: new Set()
};
const chatLog = document.getElementById('chatLog');
const title = document.getElementById('conversationTitle');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendMessage');
const modelTrigger = document.getElementById('openModelPicker');
const modelDialog = document.getElementById('modelDialog');
const modelOptions = document.getElementById('modelOptions');
const modelPickerHint = document.getElementById('modelPickerHint');
const skillsDialog = document.getElementById('skillsDialog');
const chatSkillOptions = document.getElementById('chatSkillOptions');
const historyDrawer = document.getElementById('historyDrawer');
const conversationList = document.getElementById('conversationList');

function selectedModel() {
  return state.availableModels.find((entry) => entry.providerId === state.selectedProviderId && entry.modelId === state.selectedModelId) || null;
}

function renderLog() {
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
    const bubble = element('article', `message ${message.role}`, message.content);
    const meta = element('div', 'message-meta', message.role === 'assistant' && message.modelId ? message.modelId : formatDate(message.createdAt));
    bubble.append(meta);
    chatLog.append(bubble);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
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
    const copy = element('span'); copy.append(element('b', 'data-name', entry.modelId), element('span', 'data-subtitle', entry.providerName));
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
  chatSkillOptions.replaceChildren();
  if (state.skills.length === 0) {
    chatSkillOptions.append(element('p', 'hint', 'No skills are available yet. Create one from the Skills page.'));
    return;
  }
  state.skills.forEach((skill) => {
    const isSelected = state.selectedSkillIds.has(skill.id);
    const option = element('button', `model-option${isSelected ? ' selected' : ''}`);
    option.type = 'button';
    const badge = element('span', 'data-icon'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('spark'));
    const copy = element('span'); copy.append(element('b', 'data-name', skill.name), element('span', 'data-subtitle', skill.description));
    option.append(badge, copy);
    if (isSelected) option.append(icon('check'));
    option.addEventListener('click', () => {
      if (isSelected) state.selectedSkillIds.delete(skill.id);
      else state.selectedSkillIds.add(skill.id);
      renderSkillPicker();
    });
    chatSkillOptions.append(option);
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
    const [conversations, skills] = await Promise.all([api.conversations.list(), api.skills.list()]);
    state.conversations = conversations;
    state.skills = skills;
    renderConversationList();
    renderSkillPicker();
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
    const result = await api.conversations.respond(conversation.id, {
      message,
      providerId: state.selectedProviderId,
      modelId: state.selectedModelId,
      skillIds: [...state.selectedSkillIds]
    });
    state.conversation = result.conversation;
    messageInput.value = '';
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
document.getElementById('attachButton').addEventListener('click', () => showToast('Attachments and tool permissions are the next capability phase.'));
document.getElementById('openHistory').addEventListener('click', () => { renderConversationList(); historyDrawer.showModal(); });
document.getElementById('closeHistory').addEventListener('click', () => historyDrawer.close());
document.getElementById('newConversation').addEventListener('click', startNewConversation);
document.getElementById('drawerNewChat').addEventListener('click', () => { historyDrawer.close(); startNewConversation(); });
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
messageInput.addEventListener('input', () => { messageInput.style.height = 'auto'; messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`; });
renderLog();
loadWorkspace();
