import { notFound, validation } from '../lib/errors.js';
import { identifier, modelId } from '../lib/validate.js';
import { now } from '../db/database.js';

// Workspace preferences. These are stored in the database (not .env) because the user changes
// them from the app and expects them to survive a restart.
const TITLE_KEY = 'titleGeneration';
const PROMPT_KEY = 'systemPrompt';
const AUTO_TEST_KEY = 'autoTesting';
const DEVELOPER_TOOLS_KEY = 'developerTools';
const CHAT_MODEL_KEY = 'chatModel';

// Long enough for detailed standing instructions, short enough that it cannot crowd out the
// conversation itself in the context window.
export const SYSTEM_PROMPT_MAX = 8_000;

export function defaultTitleSettings() {
  return { enabled: false, providerId: null, modelId: null };
}

// Automatic capability testing is on by default: the whole point is that a newly added model
// learns what it can do without the user having to open the Testing page and press a button.
export function defaultAutoTestSettings() {
  return { enabled: true };
}

// File-management tools default ON: they are confined to the workspace by the same guard the
// built-in read/write/list tools always used. Shell defaults OFF: it is unsandboxed arbitrary
// command execution, so the user has to opt in deliberately.
export function defaultDeveloperToolsSettings() {
  return { fileManagement: true, shell: false, confirmShell: false };
}

export function defaultChatModelSettings() {
  return { providerId: null, modelId: null, thinkingLevel: null };
}

function readSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now());
}

// Anything unreadable or half-written falls back to the defaults rather than breaking the page.
export function getSettings(db) {
  const title = readSetting(db, TITLE_KEY);
  const prompt = readSetting(db, PROMPT_KEY);
  const autoTest = readSetting(db, AUTO_TEST_KEY);
  const devTools = readSetting(db, DEVELOPER_TOOLS_KEY);
  const chatModel = readSetting(db, CHAT_MODEL_KEY);
  return {
    titleGeneration: {
      enabled: title?.enabled === true,
      providerId: typeof title?.providerId === 'string' && title.providerId ? title.providerId : null,
      modelId: typeof title?.modelId === 'string' && title.modelId ? title.modelId : null
    },
    // An empty prompt means "no extra instructions", which is the default.
    systemPrompt: { text: typeof prompt?.text === 'string' ? prompt.text : '' },
    // Missing means "never changed", which still means on.
    autoTesting: { enabled: autoTest?.enabled !== false },
    // fileManagement defaults on, shell defaults off; a saved value always wins.
    developerTools: {
      fileManagement: typeof devTools?.fileManagement === 'boolean' ? devTools.fileManagement : true,
      shell: devTools?.shell === true,
      // Only meaningful while shell access is on: every run_shell call then pauses the chat for
      // an explicit Approve/Deny tap from the user before anything executes.
      confirmShell: devTools?.confirmShell === true
    },
    // Last used chat model + thinking level, survives refresh and server restart
    chatModel: {
      providerId: typeof chatModel?.providerId === 'string' && chatModel.providerId ? chatModel.providerId : null,
      modelId: typeof chatModel?.modelId === 'string' && chatModel.modelId ? chatModel.modelId : null,
      thinkingLevel: typeof chatModel?.thinkingLevel === 'string' && chatModel.thinkingLevel ? chatModel.thinkingLevel : null
    }
  };
}

// Accepts either section on its own, so the page can save one card without touching the other.
export function updateSettings(db, body = {}) {
  const patch = body && typeof body === 'object' ? body : {};
  const hasTitle = patch.titleGeneration !== undefined;
  const hasPrompt = patch.systemPrompt !== undefined;
  const hasAutoTest = patch.autoTesting !== undefined;
  const hasDevTools = patch.developerTools !== undefined;
  const hasChatModel = patch.chatModel !== undefined;
  if (!hasTitle && !hasPrompt && !hasAutoTest && !hasDevTools && !hasChatModel) throw validation('Nothing to save. Send the settings you want to change.');

  if (hasDevTools) {
    const next = patch.developerTools;
    if (!next || typeof next !== 'object') throw validation('Developer tools settings are required.');
    writeSetting(db, DEVELOPER_TOOLS_KEY, {
      fileManagement: next.fileManagement !== false,
      shell: next.shell === true,
      confirmShell: next.confirmShell === true
    });
  }

  if (hasAutoTest) {
    const next = patch.autoTesting;
    if (!next || typeof next !== 'object') throw validation('Automatic testing settings are required.');
    writeSetting(db, AUTO_TEST_KEY, { enabled: next.enabled !== false });
  }

  if (hasTitle) {
    const next = patch.titleGeneration;
    if (!next || typeof next !== 'object') throw validation('Title settings are required.');
    const enabled = next.enabled === true;
    const providerId = next.providerId === null || next.providerId === undefined || next.providerId === ''
      ? null
      : identifier(next.providerId, 'Provider ID');
    const selectedModelId = next.modelId === null || next.modelId === undefined || next.modelId === ''
      ? null
      : modelId(next.modelId);
    if (providerId && !db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId)) {
      throw notFound('Provider');
    }
    // Turning the setting off keeps the saved choice, so switching it back on is one tap.
    if (enabled) {
      if (!providerId || !selectedModelId) throw validation('Choose the provider and model that will write titles.');
      const selected = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, selectedModelId);
      if (!selected) throw validation('Select that model for the provider before using it here.');
    }
    writeSetting(db, TITLE_KEY, { enabled, providerId, modelId: selectedModelId });
  }

  if (hasPrompt) {
    const next = patch.systemPrompt;
    if (!next || typeof next !== 'object') throw validation('System prompt settings are required.');
    const raw = next.text === undefined || next.text === null ? '' : next.text;
    if (typeof raw !== 'string') throw validation('The system prompt must be text.');
    if (raw.length > SYSTEM_PROMPT_MAX) throw validation(`The system prompt must be at most ${SYSTEM_PROMPT_MAX} characters.`);
    writeSetting(db, PROMPT_KEY, { text: raw });
  }

  if (hasChatModel) {
    const next = patch.chatModel;
    if (!next || typeof next !== 'object') throw validation('Chat model settings are required.');
    const providerId = next.providerId === null || next.providerId === undefined || next.providerId === ''
      ? null
      : (() => { try { return identifier(next.providerId, 'Provider ID'); } catch { return null; } })();
    const modelIdVal = next.modelId === null || next.modelId === undefined || next.modelId === ''
      ? null
      : (() => { try { return modelId(next.modelId); } catch { return String(next.modelId).slice(0, 200); } })();
    const thinkingLevel = next.thinkingLevel === null || next.thinkingLevel === undefined || next.thinkingLevel === ''
      ? null
      : String(next.thinkingLevel).slice(0, 120);

    // If provider/model pair is set, ensure they still exist; if not, clear to null so UI falls back gracefully
    let finalProviderId = providerId;
    let finalModelId = modelIdVal;
    if (finalProviderId) {
      const provExists = db.prepare('SELECT id FROM providers WHERE id = ?').get(finalProviderId);
      if (!provExists) {
        finalProviderId = null;
        finalModelId = null;
      } else if (finalModelId) {
        const modelExists = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?').get(finalProviderId, finalModelId);
        if (!modelExists) {
          // Keep provider but clear model if model gone, so user picks again
          finalModelId = null;
        }
      }
    } else {
      finalModelId = null;
    }

    writeSetting(db, CHAT_MODEL_KEY, {
      providerId: finalProviderId,
      modelId: finalModelId,
      thinkingLevel
    });
  }

  return getSettings(db);
}
