import { notFound, validation } from '../lib/errors.js';
import { identifier, modelId } from '../lib/validate.js';
import { now } from '../db/database.js';

// Workspace preferences. These are stored in the database (not .env) because the user changes
// them from the app and expects them to survive a restart.
const TITLE_KEY = 'titleGeneration';

export function defaultTitleSettings() {
  return { enabled: false, providerId: null, modelId: null };
}

function stored(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TITLE_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Anything unreadable or half-written falls back to the defaults rather than breaking the page.
export function getSettings(db) {
  const value = stored(db);
  return {
    titleGeneration: {
      enabled: value?.enabled === true,
      providerId: typeof value?.providerId === 'string' && value.providerId ? value.providerId : null,
      modelId: typeof value?.modelId === 'string' && value.modelId ? value.modelId : null
    }
  };
}

export function updateSettings(db, body = {}) {
  const next = body?.titleGeneration;
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
  const value = { enabled, providerId, modelId: selectedModelId };
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(TITLE_KEY, JSON.stringify(value), now());
  return getSettings(db);
}
