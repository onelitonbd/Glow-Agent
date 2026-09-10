import { api } from './api.js';
import { renderMarkdown } from './markdown.js';
import { element, icon, iconButton, showToast, toolIconName } from './ui.js';

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
  pluginRepos: [],
  // Guards every action that starts a request, so two streams can never run at once.
  busy: false,
  editingMessageId: null,
  // Set while the model picker is open to re-answer one message instead of choosing a default.
  modelPickFor: null,
  // Capability results from the Testing page, and the thinking level for the next message.
  testReport: null,
  thinkingLevel: null,
  // One entry per selected model: proven thinking levels plus whether it takes images or files.
  capabilities: [],
  // Files waiting to go with the next message, and the automatic runner's live status.
  attachments: [],
  autoTest: null,
  autoTicks: 0
};

// How many times the chat will poll the automatic runner before giving up. A real run finishes in
// seconds per model; this only stops a hung probe from polling for the life of the tab.
const MAX_AUTO_POLLS = 400;
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
const modelDialogTitle = document.getElementById('modelDialogTitle');
const modelOptions = document.getElementById('modelOptions');
const modelPickerHint = document.getElementById('modelPickerHint');
const skillsDialog = document.getElementById('skillsDialog');
const toolsDialog = document.getElementById('toolsDialog');
const chatToolOptions = document.getElementById('chatToolOptions');
const chatSkillOptions = document.getElementById('chatSkillOptions');
const chatPluginOptions = document.getElementById('chatPluginOptions');
const attachButton = document.getElementById('attachButton');
const attachDialog = document.getElementById('attachDialog');
const attachOptions = document.getElementById('attachOptions');
const attachHint = document.getElementById('attachHint');
const attachTray = document.getElementById('attachTray');
const composerStatus = document.getElementById('composerStatus');
const imagePicker = document.getElementById('imagePicker');
const filePicker = document.getElementById('filePicker');
const thinkingTrigger = document.getElementById('openThinking');
const thinkingDialog = document.getElementById('thinkingDialog');
const thinkingOptions = document.getElementById('thinkingOptions');
const thinkingHint = document.getElementById('thinkingHint');
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
  edit_file: 'Edit file',
  create_file: 'Create file',
  create_folder: 'Create folder',
  delete_file: 'Delete file',
  delete_folder: 'Delete folder',
  rename_file: 'Rename file',
  rename_folder: 'Rename folder',
  run_shell: 'Shell command',
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

// Live approval card for a gated tool call. It exists only in the streaming assistant timeline
// (never persisted); after the stream closes, the persisted tool_result summary tells the story.
function renderApprovalCard(entry) {
  const pending = !entry.outcome;
  const card = element('div', `approval-card${entry.outcome ? ` is-${entry.outcome}` : ''}`);
  const head = element('div', 'approval-head');
  const badge = element('span', 'tool-call-icon'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('terminal'));
  const title = element('span', 'approval-title', pending
    ? 'Shell command needs your approval'
    : entry.outcome === 'approved'
      ? 'Approved — running'
      : entry.outcome === 'denied'
        ? 'Denied — not run'
        : 'Not run — approval ended');
  head.append(badge, title);
  const pre = element('pre', 'approval-command');
  pre.textContent = entry.command || '';
  card.append(head, pre);
  if (pending) {
    const row = element('div', 'approval-actions');
    const approve = element('button', 'button small', 'Approve');
    approve.type = 'button';
    const deny = element('button', 'button small danger', 'Deny');
    deny.type = 'button';
    approve.addEventListener('click', () => decideApproval(entry, 'approve', [approve, deny]));
    deny.addEventListener('click', () => decideApproval(entry, 'deny', [approve, deny]));
    row.append(approve, deny);
    card.append(row);
  }
  return card;
}

async function decideApproval(entry, decision, buttons) {
  buttons.forEach((button) => { button.disabled = true; });
  const previous = entry.outcome;
  entry.outcome = decision === 'approve' ? 'approved' : 'denied';
  renderLog();
  try {
    await api.approvals.decide(entry.approvalId, decision);
  } catch (error) {
    // Roll the card back so the user can act again (for example after an expired approval is
    // replaced by a fresh proposal from the model).
    entry.outcome = previous;
    showToast(error.message, 'danger');
    renderLog();
  }
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
    } else if (entry.type === 'confirmation') {
      fragment.append(renderApprovalCard(entry));
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

// What the capability probe proved about one selected model. `null` means the workspace has not
// measured it yet — which is a temporary state now that testing runs by itself.
function capabilityFor(providerId, modelId) {
  return state.capabilities.find((entry) => entry.providerId === providerId && entry.modelId === modelId) || null;
}

function currentCapability() {
  if (!state.selectedProviderId || !state.selectedModelId) return null;
  return capabilityFor(state.selectedProviderId, state.selectedModelId);
}

// Kept for the ranking view: the full stored report, when there is one.
function currentModelTest() {
  if (!state.testReport || !state.selectedProviderId || !state.selectedModelId) return null;
  return state.testReport.entries.find((entry) => entry.providerId === state.selectedProviderId && entry.modelId === state.selectedModelId) || null;
}

const THINKING_STATUS = {
  works: { label: 'Works', tone: 'ok' },
  accepted: { label: 'Accepted', tone: 'maybe' },
  rejected: { label: 'Not supported', tone: 'no' },
  skipped: { label: 'Skipped', tone: 'no' },
  unknown: { label: 'Untested', tone: 'unknown' }
};

// One row of the composer's capability readout: what the probe found, in words a person can act on.
function verdictLabel(verdict) {
  if (!verdict) return { label: 'Untested', tone: 'unknown' };
  if (verdict.status === 'works') return { label: 'Yes', tone: 'ok' };
  if (verdict.status === 'accepted') return { label: 'Accepted', tone: 'maybe' };
  if (verdict.status === 'rejected') return { label: 'Not supported', tone: 'no' };
  if (verdict.status === 'skipped') return { label: 'Skipped', tone: 'no' };
  return { label: 'Untested', tone: 'unknown' };
}

function syncThinkingTrigger() {
  if (!thinkingTrigger) return;
  const capability = currentCapability();
  const level = state.thinkingLevel;
  thinkingTrigger.classList.toggle('selected', Boolean(level));
  const label = level ? (capability?.levels || []).find((entry) => entry.id === level)?.label || level : null;
  const queued = capability && !capability.tested;
  thinkingTrigger.title = label
    ? `Thinking level: ${label}`
    : queued
      ? `Thinking level — ${capability.modelId} is being tested`
      : 'Thinking level';
  thinkingTrigger.setAttribute('aria-label', thinkingTrigger.title);
}

// The levels offered are exactly what the probe found for this model: proven first, then merely
// accepted, with unsupported ones last and clearly marked.
function renderThinkingPicker() {
  const capability = currentCapability();
  const levels = capability?.levels || [];
  thinkingOptions.replaceChildren();
  thinkingHint.textContent = !state.selectedModelId
    ? 'Choose a model first.'
    : capability?.tested
      ? `Tested ${new Date(capability.testedAt).toLocaleString()}. “Works” means the probe saw reasoning come back; “Accepted” means the parameter went through but no reasoning was returned.`
      : state.autoTest?.enabled === false
        ? 'This model has not been tested, so every level is offered. Turn automatic testing on, or run it from the Testing page.'
        : 'This model has not been tested yet. It is queued for the automatic test — every level is offered until the result is in.';

  const off = element('button', `model-option${state.thinkingLevel ? '' : ' selected'}`);
  off.type = 'button';
  off.dataset.level = '';
  const offBadge = element('span', 'data-icon violet'); offBadge.setAttribute('aria-hidden', 'true'); offBadge.append(icon('close'));
  const offCopy = element('span', 'copy'); offCopy.append(element('b', 'data-name', 'Off'), element('span', 'data-subtitle', 'Answer without a thinking level'));
  off.append(offBadge, offCopy);
  if (!state.thinkingLevel) off.append(icon('check'));
  off.addEventListener('click', () => chooseThinkingLevel(null));
  thinkingOptions.append(off);

  const rank = (status) => (status === 'works' ? 0 : status === 'accepted' ? 1 : status === 'unknown' ? 2 : 3);
  levels
    .map((level) => ({ level, status: level.status || 'unknown', reason: level.reason || '' }))
    .sort((a, b) => rank(a.status) - rank(b.status))
    .forEach(({ level, status, reason }) => {
      const info = THINKING_STATUS[status] || THINKING_STATUS.unknown;
      const option = element('button', `model-option${state.thinkingLevel === level.id ? ' selected' : ''}`);
      option.type = 'button';
      option.dataset.level = level.id;
      const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('spark'));
      const copy = element('span', 'copy');
      copy.append(element('b', 'data-name', level.label), element('span', 'data-subtitle', reason || info.label));
      option.append(badge, copy, chip(info.label, info.tone));
      option.addEventListener('click', () => chooseThinkingLevel(level.id));
      thinkingOptions.append(option);
    });
}

// ---- Attachments ----
// The composer offers an image or a document only for a model the probe saw accept one. That is
// the whole point of the report: the button is not a guess, and it says why when it says no.

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function attachmentVerdict(kind) {
  const capability = currentCapability();
  if (!capability) return { allowed: false, reason: 'Choose a model first.', verdict: null, tested: false };
  const verdict = kind === 'image' ? capability.images : capability.files;
  // Untested is not a rejection: the automatic runner has not got to it yet, so the file is
  // allowed and the hint says the result is pending.
  if (!capability.tested) {
    return { allowed: true, reason: `${capability.modelId} has not been tested yet, so this may still be refused.`, verdict: null, tested: false };
  }
  if (!verdict?.usable) {
    return {
      allowed: false,
      reason: verdict?.reason || `${capability.modelId} refused ${kind === 'image' ? 'image input' : 'file attachments'} in testing.`,
      verdict,
      tested: true
    };
  }
  return {
    allowed: true,
    reason: verdict.proved ? `Proved in testing — ${verdict.reason}`.slice(0, 160) : 'The provider accepted this in testing, though the model gave nothing back.',
    verdict,
    tested: true
  };
}

function syncAttachTrigger() {
  if (!attachButton) return;
  const images = attachmentVerdict('image');
  const files = attachmentVerdict('file');
  const anyAllowed = images.allowed || files.allowed;
  attachButton.disabled = !anyAllowed;
  attachButton.classList.toggle('selected', state.attachments.length > 0);
  const title = !state.selectedModelId
    ? 'Add an image or a file — choose a model first'
    : anyAllowed
      ? `Add ${[images.allowed ? 'an image' : null, files.allowed ? 'a file' : null].filter(Boolean).join(' or ')}`
      : 'This model accepts neither images nor files';
  attachButton.title = title;
  attachButton.setAttribute('aria-label', title);
}

function renderAttachPicker() {
  const capability = currentCapability();
  attachOptions.replaceChildren();
  const rows = [
    { kind: 'image', name: 'Image', subtitle: 'PNG, JPG, GIF or WebP', iconName: 'spark' },
    { kind: 'file', name: 'Document', subtitle: 'PDF or a text file', iconName: 'paperclip' }
  ];
  rows.forEach((row) => {
    const gate = attachmentVerdict(row.kind);
    const info = verdictLabel(gate.verdict);
    const option = element('button', `model-option${gate.allowed ? '' : ' disabled'}`);
    option.type = 'button';
    option.dataset.kind = row.kind;
    option.disabled = !gate.allowed;
    const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon(row.iconName));
    const copy = element('span', 'copy');
    copy.append(element('b', 'data-name', row.name), element('span', 'data-subtitle', gate.allowed ? row.subtitle : gate.reason));
    option.append(badge, copy, chip(info.label, info.tone));
    option.addEventListener('click', () => {
      if (!gate.allowed) return;
      attachDialog.close();
      (row.kind === 'image' ? imagePicker : filePicker)?.click();
    });
    attachOptions.append(option);
  });
  attachHint.textContent = !capability
    ? 'Choose a model first — what can be attached depends on what that model was proved to accept.'
    : capability.tested
      ? `Decided by the capability test run on ${new Date(capability.testedAt).toLocaleString()}. Up to ${MAX_ATTACHMENTS} files, ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each.`
      : `Waiting on the automatic test for ${capability.modelId}. You can attach now; the result may still rule it out.`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}

function humanSize(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function addAttachment(kind, file) {
  if (!file) return;
  if (state.attachments.length >= MAX_ATTACHMENTS) {
    showToast(`At most ${MAX_ATTACHMENTS} attachments per message.`, 'danger');
    return;
  }
  const gate = attachmentVerdict(kind);
  if (!gate.allowed) {
    showToast(gate.reason, 'danger');
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showToast(`${file.name} is ${humanSize(file.size)}. The limit is ${humanSize(MAX_ATTACHMENT_BYTES)}.`, 'danger');
    return;
  }
  let dataUrl;
  try {
    dataUrl = await readFileAsDataUrl(file);
  } catch (error) {
    showToast(error.message, 'danger');
    return;
  }
  // The kind comes from the file, not from which button opened the picker: a PDF picked from the
  // image button is still a document.
  const mimeType = String(file.type || (kind === 'image' ? 'image/png' : 'application/octet-stream'));
  state.attachments.push({
    kind: mimeType.startsWith('image/') ? 'image' : 'file',
    name: file.name || 'attachment',
    mimeType,
    size: file.size,
    dataUrl
  });
  renderAttachTray();
  syncAttachTrigger();
  showToast(`${file.name} attached.`);
}

// The picked files sit above the textarea until they are sent, each one removable.
function renderAttachTray() {
  if (!attachTray) return;
  attachTray.replaceChildren();
  attachTray.hidden = state.attachments.length === 0;
  state.attachments.forEach((attachment, index) => {
    const pill = element('span', 'attach-pill');
    if (attachment.kind === 'image') {
      const thumb = element('img', 'attach-thumb');
      thumb.src = attachment.dataUrl;
      thumb.alt = attachment.name;
      pill.append(thumb);
    } else {
      const mark = element('span', 'attach-icon'); mark.setAttribute('aria-hidden', 'true'); mark.append(icon('paperclip'));
      pill.append(mark);
    }
    const copy = element('span', 'attach-copy');
    copy.append(element('b', '', attachment.name), element('span', '', humanSize(attachment.size)));
    pill.append(copy);
    const remove = iconButton('close', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachTray();
      syncAttachTrigger();
    });
    pill.append(remove);
    attachTray.append(pill);
  });
}

function chip(text, tone) {
  return element('span', `chip ${tone}`, text);
}

function chooseThinkingLevel(levelId) {
  state.thinkingLevel = levelId;
  syncThinkingTrigger();
  renderThinkingPicker();
  thinkingDialog.close();
  showToast(levelId ? `Thinking level set to ${levelId}.` : 'Thinking level turned off.');
}

// The buttons under each message. An answer can be re-asked, copied, removed, or sent to a
// different model; a question can be copied or corrected.
function messageActions(message) {
  if (message.role === 'assistant') {
    return [
      { id: 'regenerate', icon: 'refresh', label: 'Regenerate', run: () => regenerate(message.id) },
      { id: 'copy', icon: 'copy', label: 'Copy', run: () => copyText(message.content) },
      { id: 'delete', icon: 'trash', label: 'Delete', run: () => removeMessage(message.id), danger: true, confirmTitle: 'Tap again to delete' },
      { id: 'other-model', icon: 'database', label: 'Try another model', run: () => askForModel(message.id) }
    ];
  }
  return [
    // Re-answering works from the question too: regenerate() re-answers the question a reply
    // belongs to, so a question just points at itself.
    { id: 'regenerate', icon: 'refresh', label: 'Regenerate', run: () => regenerate(message.id) },
    { id: 'copy', icon: 'copy', label: 'Copy', run: () => copyText(message.content) },
    { id: 'edit', icon: 'pencil', label: 'Edit', run: () => startEditing(message.id) }
  ];
}

// Nothing is actionable until the message exists on the server, so the optimistic copies shown
// while a request is in flight stay inert.
function isPersisted(message) {
  return typeof message.id === 'string' && !message.id.startsWith('pending-') && !message.id.startsWith('streaming-');
}

function renderActions(message) {
  if (!isPersisted(message) || message.isStreaming) return null;
  const bar = element('div', `message-actions ${message.role}`);
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', message.role === 'assistant' ? 'Answer options' : 'Your message options');
  for (const action of messageActions(message)) {
    // Icon only: the label lives in aria-label and the tooltip, so the row stays quiet.
    const button = element('button', `message-action${action.danger ? ' danger' : ''}`);
    button.type = 'button';
    button.dataset.action = action.id;
    button.dataset.messageId = message.id;
    button.setAttribute('aria-label', action.label);
    button.title = action.label;
    button.append(icon(action.icon));
    button.disabled = state.busy;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      // Destructive actions ask once more in place, which keeps the flow usable on a phone where
      // a native confirm dialog is awkward. With no label to change, the armed state is colour.
      if (action.confirmTitle && !button.classList.contains('confirming')) {
        button.classList.add('confirming');
        button.title = action.confirmTitle;
        button.setAttribute('aria-label', action.confirmTitle);
        setTimeout(() => {
          button.classList.remove('confirming');
          button.title = action.label;
          button.setAttribute('aria-label', action.label);
        }, 4_000);
        return;
      }
      button.classList.remove('confirming');
      button.title = action.label;
      button.setAttribute('aria-label', action.label);
      action.run();
    });
    bar.append(button);
  }
  return bar;
}

function renderEditor(message) {
  const wrap = element('div', 'message-editor');
  const field = element('textarea', 'message-editor-input');
  field.value = message.content;
  field.setAttribute('rows', '3');
  field.setAttribute('aria-label', 'Edit your message');
  const actions = element('div', 'message-editor-actions');
  const cancel = element('button', 'button secondary small', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel-edit';
  cancel.addEventListener('click', () => { state.editingMessageId = null; renderLog(); });
  const save = element('button', 'button small', 'Save and send');
  save.type = 'button';
  save.dataset.action = 'save-edit';
  save.addEventListener('click', () => saveEdit(message.id, field.value));
  actions.append(cancel, save);
  wrap.append(field, actions);
  return wrap;
}

async function copyText(text) {
  const value = String(text ?? '');
  if (!value.trim()) { showToast('There is nothing to copy yet.'); return; }
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch { copied = false; }
  if (!copied) copied = legacyCopy(value);
  if (copied) showToast('Copied to your clipboard.');
  else showToast('The browser blocked copying. Select the text instead.', 'danger');
}

// Older browsers and non-secure contexts have no clipboard API.
function legacyCopy(value) {
  try {
    const area = element('textarea', 'copy-fallback');
    area.value = value;
    area.setAttribute('readonly', '');
    document.body.append(area);
    area.select?.();
    const ok = document.execCommand?.('copy');
    area.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

async function removeMessage(messageId) {
  const conversation = state.conversation;
  if (!conversation || state.busy) return;
  try {
    // A reply is removed together with the question that produced it.
    state.conversation = await api.conversations.deleteMessage(conversation.id, messageId);
    await loadWorkspace();
    renderLog();
    showToast('Message deleted.');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

function startEditing(messageId) {
  if (state.busy) { showToast('Wait for the current answer to finish first.', 'danger'); return; }
  state.editingMessageId = messageId;
  renderLog();
}

// Saving a correction answers it again right away, which is what the edit button promises.
async function saveEdit(messageId, content) {
  const text = String(content ?? '').trim();
  const conversation = state.conversation;
  if (!text) { showToast('A message cannot be empty.', 'danger'); return; }
  if (!conversation || state.busy) return;
  try {
    state.editingMessageId = null;
    state.conversation = await api.conversations.editMessage(conversation.id, messageId, text);
    renderLog();
  } catch (error) {
    showToast(error.message, 'danger');
    return;
  }
  await regenerate(messageId);
}

function askForModel(messageId) {
  if (state.busy) { showToast('Wait for the current answer to finish first.', 'danger'); return; }
  state.modelPickFor = messageId;
  renderModelPicker();
  modelDialog.showModal();
}

// A reply is always re-answered through the question that produced it, so either id works as the
// starting point here.
function questionIdFor(messageId) {
  const messages = state.conversation?.messages || [];
  const index = messages.findIndex((entry) => entry.id === messageId);
  if (index < 0) return null;
  if (messages[index].role === 'user') return messageId;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return messages[cursor].id;
  }
  return null;
}

// Answers a stored question again. The old reply is dropped first so the new one lands in its
// place, while the question itself stays where it is.
async function regenerate(messageId, model = {}) {
  const conversation = state.conversation;
  if (!conversation || state.busy) return;
  const providerId = model.providerId || state.selectedProviderId;
  const modelId = model.modelId || state.selectedModelId;
  if (!providerId || !modelId) {
    showToast('Choose a configured model before answering again.', 'danger');
    return;
  }
  const questionId = questionIdFor(messageId);
  const messages = conversation.messages || [];
  const index = questionId ? messages.findIndex((entry) => entry.id === questionId) : -1;
  if (index < 0) {
    showToast('There is no question here to answer again.', 'danger');
    return;
  }
  state.conversation = { ...conversation, messages: messages.slice(0, index + 1) };
  renderLog();
  await runStream((onEvent) => api.conversations.streamRegenerate(conversation.id, questionId, {
    providerId,
    modelId,
    toolIds: state.tools.map((tool) => tool.id),
    ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {})
  }, onEvent));
}

function renderLog() {
  const followLatest = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 56;
  const tableOffsets = [...chatLog.querySelectorAll('.markdown-table-scroll')].map((table) => table.scrollLeft);
  chatLog.replaceChildren();
  title.textContent = state.conversation?.title || 'New conversation';
  // The tab reads like the page, which matters once a chat has its own deep link.
  document.title = state.conversation?.title ? `${state.conversation.title} — Glow Agent` : 'Glow Agent';
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
    const editing = state.editingMessageId === message.id && message.role === 'user';
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
    } else if (editing) {
      bubble.append(renderEditor(message));
    } else {
      if (message.content) bubble.append(document.createTextNode(message.content));
      const attached = renderAttachments(message.attachments);
      if (attached) bubble.append(attached);
    }
    if (message.isStreaming && message.status) bubble.append(renderStreamStatus(message.status, message.statusTone));
    chatLog.append(bubble);
    // A reply carries its actions underneath; the ones for a question sit outside the bubble so
    // the pill itself stays clean.
    if (!editing) {
      const actions = renderActions(message);
      if (actions) chatLog.append(actions);
    }
  });
  [...chatLog.querySelectorAll('.markdown-table-scroll')].forEach((table, index) => {
    table.scrollLeft = tableOffsets[index] || 0;
  });
  if (followLatest) chatLog.scrollTop = chatLog.scrollHeight;
}

// What travelled with a question. Images are shown; anything else is named, because a PDF has no
// thumbnail worth drawing at this size.
function renderAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const wrap = element('div', 'message-attachments');
  attachments.forEach((attachment) => {
    if (attachment.kind === 'image') {
      const image = element('img', 'message-image');
      image.src = attachment.dataUrl;
      image.alt = attachment.name || 'Attached image';
      wrap.append(image);
      return;
    }
    const pill = element('span', 'message-file');
    const mark = element('span', 'attach-icon'); mark.setAttribute('aria-hidden', 'true'); mark.append(icon('paperclip'));
    pill.append(mark, element('span', '', `${attachment.name}${attachment.size ? ` · ${humanSize(attachment.size)}` : ''}`));
    wrap.append(pill);
  });
  return wrap;
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
        await openConversation(conversation.id);
        historyDrawer.close();
      } catch (error) {
        showToast(error.message, 'danger');
      }
    });
    conversationList.append(button);
  });
}

// The same list serves two jobs: choosing the default model, and picking the model that answers
// one message again. The heading and hint say which one is open.
function renderModelPicker() {
  const reAnswer = Boolean(state.modelPickFor);
  if (modelDialogTitle) {
    modelDialogTitle.textContent = reAnswer ? 'Answer with another model' : 'Choose provider and model';
  }
  modelOptions.replaceChildren();
  if (state.availableModels.length === 0) {
    modelPickerHint.textContent = 'No selected models yet. Add a provider, fetch its models, and select at least one for chat.';
    const link = element('a', 'button secondary full', 'Open providers'); link.href = '/providers.html';
    modelOptions.append(link);
    return;
  }
  modelPickerHint.textContent = reAnswer
    ? 'Pick a model to answer that message again. Your message stays in the conversation.'
    : 'The highlighted selection is used for your next message.';
  state.availableModels.forEach((entry) => {
    const isSelected = entry.providerId === state.selectedProviderId && entry.modelId === state.selectedModelId;
    const capability = capabilityFor(entry.providerId, entry.modelId);
    const option = element('button', `model-option${isSelected ? ' selected' : ''}`);
    option.type = 'button';
    option.dataset.modelId = entry.modelId;
    const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon('database'));
    const copy = element('span', 'copy');
    copy.append(element('b', 'data-name', entry.modelId), element('span', 'data-subtitle', capabilitySummary(entry, capability)));
    option.append(badge, copy);
    // The proven headline capabilities, right in the list, so the choice does not need a detour
    // to the Testing page.
    capabilityChips(capability).forEach((node) => option.append(node));
    if (isSelected) option.append(icon('check'));
    option.addEventListener('click', () => {
      const messageId = state.modelPickFor;
      state.modelPickFor = null;
      selectModel(entry);
      modelDialog.close();
      renderModelPicker();
      if (messageId) regenerate(messageId);
    });
    modelOptions.append(option);
  });
}

// One line under a model's name in the picker: what the report says it can do, or where it is in
// the automatic queue.
function capabilitySummary(entry, capability) {
  if (!capability || !capability.tested) {
    return state.autoTest?.enabled === false
      ? `${entry.providerName} · not tested yet`
      : `${entry.providerName} · testing automatically`;
  }
  const thinking = capability.thinking.usable.length
    ? `thinks to ${capability.levels.find((level) => level.id === capability.thinking.best)?.label || capability.thinking.best}`
    : 'no thinking levels';
  const extras = [capability.images.usable ? 'images' : null, capability.files.usable ? 'files' : null].filter(Boolean);
  return `${entry.providerName} · ${thinking}${extras.length ? ` · ${extras.join(' + ')}` : ''}`;
}

function capabilityChips(capability) {
  if (!capability) return [chip('Untested', 'unknown')];
  if (!capability.tested) return [chip('Queued', 'unknown')];
  const nodes = [];
  const best = capability.levels.find((level) => level.id === capability.thinking.best);
  nodes.push(chip(best ? best.label : 'No thinking', best ? 'ok' : 'no'));
  nodes.push(chip('Images', verdictLabel(capability.images).tone));
  nodes.push(chip('Files', verdictLabel(capability.files).tone));
  return nodes;
}

function selectModel(entry) {
  const changed = entry.providerId !== state.selectedProviderId || entry.modelId !== state.selectedModelId;
  state.selectedProviderId = entry.providerId;
  state.selectedModelId = entry.modelId;
  // A level tested on the old model says nothing about the new one.
  if (changed) {
    state.thinkingLevel = null;
    // Attachments are addressed to a specific model: a file this one cannot take must not ride
    // along silently and be refused by the provider.
    if (state.attachments.length > 0) {
      const blocked = state.attachments.filter((attachment) => !attachmentVerdict(attachment.kind).allowed);
      if (blocked.length > 0) {
        state.attachments = [];
        renderAttachTray();
        showToast(`${entry.modelId} does not take ${blocked.map((attachment) => attachment.name).join(', ')}, so they were removed.`, 'danger');
      }
    }
    syncThinkingTrigger();
    syncAttachTrigger();
  }
  modelTrigger.classList.add('selected');
  modelTrigger.setAttribute('aria-label', `Selected model: ${entry.modelId}. Choose provider and model.`);
  modelTrigger.title = `${entry.providerName} · ${entry.modelId}`;
  showToast(`${entry.modelId} selected.`);
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

// Capabilities and the automatic runner's status are read on their own: a chat must still work
// when the report is missing, and a missing report must not blank the conversation list.
async function loadCapabilities() {
  try {
    const report = await api.tests.capabilities();
    state.capabilities = report.models || [];
  } catch {
    state.capabilities = [];
  }
  syncThinkingTrigger();
  syncAttachTrigger();
  renderModelPicker();
}

// The live line above the textarea. It says which model the automatic test is on and which
// capability it is asking about, so a model that is mid-probe does not look broken.
function renderComposerStatus() {
  if (!composerStatus) return;
  const auto = state.autoTest;
  const current = auto?.current;
  const queued = auto?.queued || 0;
  if (current) {
    composerStatus.hidden = false;
    composerStatus.replaceChildren();
    const dot = element('span', 'stream-status-dot');
    dot.setAttribute('aria-hidden', 'true');
    composerStatus.append(dot, element('span', '', `Testing ${current.modelId} — ${current.label}${current.stepTotal ? ` (${current.stepIndex}/${current.stepTotal})` : ''}`));
    return;
  }
  if (auto?.running || queued > 0) {
    composerStatus.hidden = false;
    composerStatus.replaceChildren();
    const dot = element('span', 'stream-status-dot');
    dot.setAttribute('aria-hidden', 'true');
    composerStatus.append(dot, element('span', '', queued > 0 ? `Automatic testing — ${queued} model${queued === 1 ? '' : 's'} waiting.` : 'Automatic testing is finishing up.'));
    return;
  }
  composerStatus.hidden = true;
  composerStatus.replaceChildren();
}

let autoPollTimer = null;

// Polls only while the automatic runner has something to do, then stops: an idle chat should not
// keep asking the server whether it is busy.
function watchAutoTests() {
  if (autoPollTimer) clearTimeout(autoPollTimer);
  autoPollTimer = null;
  const active = Boolean(state.autoTest?.running || state.autoTest?.queued || state.autoTest?.untested?.length);
  // Bounded so a probe that hangs upstream cannot leave an open chat polling forever.
  state.autoTicks += 1;
  if (!active || state.autoTest?.enabled === false || state.autoTicks > MAX_AUTO_POLLS) return;
  autoPollTimer = setTimeout(async () => {
    const before = state.autoTest?.current?.key || '';
    await loadAutoStatus();
    // A model finished: its capabilities are now real, so re-read them.
    if (before && before !== (state.autoTest?.current?.key || '')) await loadCapabilities();
    watchAutoTests();
  }, 1_500);
}

async function loadAutoStatus() {
  try {
    state.autoTest = await api.tests.auto();
  } catch {
    return;
  }
  renderComposerStatus();
  renderModelPicker();
  syncThinkingTrigger();
  watchAutoTests();
}

async function loadWorkspace() {
  try {
    const [conversations, skills, tools, plugins, testReport] = await Promise.all([
      api.conversations.list(), api.skills.list(), api.tools.list(), api.plugins.list(), api.tests.report()
    ]);
    state.conversations = conversations;
    state.skills = skills;
    state.tools = tools;
    state.plugins = plugins;
    state.testReport = testReport;
    syncThinkingTrigger();
    renderConversationList();
    renderSkillPicker();
    renderToolPicker();
    await loadPluginRepos();
    renderPluginPicker();
    await loadModels();
  } catch (error) {
    showToast(error.message, 'danger');
  }
  // Read separately on purpose: the chat works without a report, and the report must not cost the
  // user their conversation list when it fails.
  await loadCapabilities();
  await loadAutoStatus();
}

function startNewConversation() {
  state.conversation = null;
  syncChatUrl(null);
  messageInput.value = '';
  renderLog();
  renderConversationList();
  messageInput.focus();
}

async function ensureConversation() {
  if (state.conversation) return state.conversation;
  state.conversation = await api.conversations.create();
  state.conversations.unshift(state.conversation);
  // The chat exists only now, so its address replaces the fresh "/" entry instead of adding a
  // navigation step the user never saw.
  syncChatUrl(state.conversation.id, { replace: true });
  renderConversationList();
  return state.conversation;
}

// ---- Deep links: every saved conversation has its own /chat/<id> address --------------------

function chatIdFromLocation() {
  const path = window.location?.pathname || '';
  const match = /^\/chat\/([\w-]+)\/?$/u.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

function syncChatUrl(id, { replace = false } = {}) {
  const target = id ? `/chat/${encodeURIComponent(id)}` : '/';
  if ((window.location?.pathname || '/') === target) return;
  try {
    const historyApi = window.history;
    if (replace) historyApi?.replaceState?.(null, '', target);
    else historyApi?.pushState?.(null, '', target);
  } catch { /* History can be unavailable in embedded contexts; the chat still works. */ }
}

async function openConversation(id, { pushUrl = true } = {}) {
  state.conversation = await api.conversations.get(id);
  if (pushUrl) syncChatUrl(id);
  renderConversationList();
  renderLog();
}

// Boot deep link: /chat/<id> loads that conversation straight away; a gone or unknown id falls
// back to a fresh chat with a notice (the URL is corrected in place).
async function restoreFromUrl() {
  const id = chatIdFromLocation();
  if (!id) return;
  try {
    state.conversation = await api.conversations.get(id);
  } catch (error) {
    showToast(`${error.message || 'That chat could not be opened.'} A new chat was started instead.`, 'danger');
    syncChatUrl(null, { replace: true });
  }
  renderConversationList();
  renderLog();
}

async function copyChatLink() {
  if (!state.conversation?.id) {
    showToast('Send a message first — the chat gets its own link once it is saved.', 'danger');
    return;
  }
  const origin = window.location?.origin || '';
  const url = `${origin}/chat/${encodeURIComponent(state.conversation.id)}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Chat link copied.');
  } catch {
    // Clipboard access can be refused; showing the link still lets the user copy it.
    showToast(`Chat link: ${url}`);
  }
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
  } else if (event === 'confirmation_required') {
    timeline.push({ type: 'confirmation', approvalId: payload.approvalId, toolId: payload.toolId, command: payload.command, outcome: null });
  } else if (event === 'confirmation_resolved') {
    const entry = timeline.find((item) => item.type === 'confirmation' && item.approvalId === payload.approvalId);
    // A local tap may already have flipped the card; the stream outcome is the source of truth.
    if (entry && payload.outcome !== 'approved' && payload.outcome !== 'denied') entry.outcome = payload.outcome;
    else if (entry && !entry.outcome) entry.outcome = payload.outcome;
  }
  renderLog();
}

const STREAM_EVENTS = new Set(['started', 'status', 'thinking', 'token', 'tool_call', 'tool_result', 'confirmation_required', 'confirmation_resolved']);

// Every way of getting an answer — a new message, a regenerate, a different model — streams
// through here, so the live status line and the error recovery behave the same everywhere.
async function runStream(start) {
  state.busy = true;
  sendButton.disabled = true;
  renderLog();
  try {
    const result = await start((eventName, payload) => {
      if (STREAM_EVENTS.has(eventName)) appendStreamDelta(eventName, payload);
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
    state.busy = false;
    sendButton.disabled = false;
    renderLog();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  // A file on its own is a complete question — "what is this?" is often just the picture.
  if (!message && state.attachments.length === 0) return;
  if (!selectedModel()) {
    showToast('Choose a configured model before sending a message.', 'danger');
    modelDialog.showModal();
    return;
  }
  // Checked again at send time: the capability report may have landed since the file was picked.
  const blocked = state.attachments.filter((attachment) => !attachmentVerdict(attachment.kind).allowed);
  if (blocked.length > 0) {
    showToast(attachmentVerdict(blocked[0].kind).reason, 'danger');
    return;
  }
  const attachments = state.attachments;
  state.attachments = [];
  renderAttachTray();
  syncAttachTrigger();
  runStream(async (onEvent) => {
    const conversation = await ensureConversation();
    const pendingUserMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content: message,
      attachments,
      createdAt: new Date().toISOString()
    };
    state.conversation = {
      ...conversation,
      messages: [...(state.conversation?.messages || []), pendingUserMessage]
    };
    messageInput.value = '';
    messageInput.style.height = 'auto';
    renderLog();
    return api.conversations.streamRespond(conversation.id, {
      message,
      providerId: state.selectedProviderId,
      modelId: state.selectedModelId,
      toolIds: state.tools.map((tool) => tool.id),
      ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
      ...(attachments.length ? { attachments } : {})
    }, onEvent);
  });
});

document.getElementById('openModelPicker').addEventListener('click', () => { state.modelPickFor = null; renderModelPicker(); modelDialog.showModal(); });
modelDialog.addEventListener('close', () => {
  if (!state.modelPickFor) return;
  state.modelPickFor = null;
  renderModelPicker();
});
document.getElementById('openSkills').addEventListener('click', () => { renderSkillPicker(); skillsDialog.showModal(); });
document.getElementById('openTools').addEventListener('click', () => { renderToolPicker(); toolsDialog.showModal(); });
document.getElementById('openPlugins')?.addEventListener('click', () => { renderPluginPicker(); document.getElementById('pluginsDialog').showModal(); });
thinkingTrigger?.addEventListener('click', () => { renderThinkingPicker(); thinkingDialog.showModal(); });
attachButton?.addEventListener('click', () => { renderAttachPicker(); attachDialog.showModal(); });
imagePicker?.addEventListener('change', () => { addAttachment('image', imagePicker.files?.[0]); imagePicker.value = ''; });
filePicker?.addEventListener('change', () => { addAttachment('file', filePicker.files?.[0]); filePicker.value = ''; });
themeToggle?.addEventListener('click', () => { window.GlowTheme?.toggle?.(); });
document.addEventListener('glow-theme-change', syncThemeToggle);
document.getElementById('openHistory').addEventListener('click', () => { renderConversationList(); historyDrawer.showModal(); });
document.getElementById('closeHistory').addEventListener('click', () => historyDrawer.close());
document.getElementById('newConversation').addEventListener('click', startNewConversation);
document.getElementById('copyChatLink').addEventListener('click', copyChatLink);

// Back/forward between chats: the URL is the source of truth, so follow where it points.
window.addEventListener?.('popstate', async () => {
  if (state.busy) return showToast('Wait for the reply to finish before switching chats.', 'danger');
  const id = chatIdFromLocation();
  try {
    if (!id) state.conversation = null;
    else if (state.conversation?.id !== id) await openConversation(id, { pushUrl: false });
  } catch (error) {
    showToast(error.message, 'danger');
    state.conversation = null;
  }
  renderConversationList();
  renderLog();
});
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
document.querySelectorAll('.coming-soon').forEach((button) => button.addEventListener('click', () => {
  historyDrawer.close();
  showToast(`${button.dataset.route} is the next workspace capability.`);
}));
messageInput.addEventListener('input', () => { messageInput.style.height = 'auto'; messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`; });
syncThemeToggle();
renderLog();
loadWorkspace();
// Runs alongside the workspace load: a deep-linked chat renders as soon as it arrives, and the
// conversation list highlights it once the list itself lands.
restoreFromUrl();
