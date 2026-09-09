import { randomUUID } from 'node:crypto';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { identifier, modelId, normalizedBaseUrl, optionalArray, optionalString, requiredString, stringArray } from '../lib/validate.js';
import { now } from '../db/database.js';

function safeProvider(row, selectedModelCount = 0) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    keyStatus: {
      primaryAvailable: true,
      backupKeyCount: Number(row.backup_key_count ?? 0)
    },
    selectedModelCount: Number(row.selected_model_count ?? selectedModelCount),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function providerWithMetadata(db, providerId) {
  return db.prepare(`
    SELECT p.*, COUNT(pm.id) AS selected_model_count
    FROM providers p
    LEFT JOIN provider_models pm ON pm.provider_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(providerId);
}

function credentialBundle(row, encryptionKey) {
  const credentials = decryptJson(row.credential_ciphertext, encryptionKey);
  if (!credentials || typeof credentials.primaryKey !== 'string' || !Array.isArray(credentials.backupKeys)) {
    throw new Error('Invalid credentials shape.');
  }
  return credentials;
}

function keyMetadata(row, encryptionKey) {
  const credentials = credentialBundle(row, encryptionKey);
  return { primaryAvailable: Boolean(credentials.primaryKey), backupKeyCount: credentials.backupKeys.length };
}

function safeProviderWithKeys(row, encryptionKey) {
  const safe = safeProvider(row);
  safe.keyStatus = keyMetadata(row, encryptionKey);
  return safe;
}

function handleSqliteConflict(error, entityName) {
  if (error?.message?.includes('UNIQUE constraint failed')) throw conflict(`${entityName} already exists.`);
  throw error;
}

export function listProviders(db, encryptionKey) {
  const rows = db.prepare(`
    SELECT p.*, COUNT(pm.id) AS selected_model_count
    FROM providers p
    LEFT JOIN provider_models pm ON pm.provider_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).all();
  return rows.map((row) => safeProviderWithKeys(row, encryptionKey));
}

export function getProvider(db, encryptionKey, rawProviderId) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const row = providerWithMetadata(db, providerId);
  if (!row) throw notFound('Provider');
  return safeProviderWithKeys(row, encryptionKey);
}

export function createProvider(db, encryptionKey, body) {
  const name = requiredString(body.name, 'Provider name', { max: 80 });
  const baseUrl = normalizedBaseUrl(body.baseUrl);
  const primaryKey = requiredString(body.apiKey, 'API key', { max: 500 });
  const backupKeys = stringArray(body.backupKeys ?? [], 'Backup API keys', { maxItems: 10, itemMax: 500 });
  const timestamp = now();
  const id = randomUUID();
  const credentialCiphertext = encryptJson({ primaryKey, backupKeys }, encryptionKey);
  try {
    db.prepare(`INSERT INTO providers (id, name, base_url, credential_ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name, baseUrl, credentialCiphertext, timestamp, timestamp);
  } catch (error) {
    handleSqliteConflict(error, 'A provider with this name');
  }
  return getProvider(db, encryptionKey, id);
}

export function updateProvider(db, encryptionKey, rawProviderId, body) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const existing = providerWithMetadata(db, providerId);
  if (!existing) throw notFound('Provider');
  const name = requiredString(body.name, 'Provider name', { max: 80 });
  const baseUrl = normalizedBaseUrl(body.baseUrl);
  const replacementPrimaryKey = optionalString(body.apiKey, 'API key', { max: 500 });
  const replacementBackupKeys = optionalArray(body.backupKeys, 'Backup API keys', { maxItems: 10, itemMax: 500 });
  const credentials = credentialBundle(existing, encryptionKey);
  const updatedCredentials = {
    primaryKey: replacementPrimaryKey ?? credentials.primaryKey,
    backupKeys: replacementBackupKeys ?? credentials.backupKeys
  };
  const timestamp = now();
  try {
    db.prepare(`UPDATE providers
      SET name = ?, base_url = ?, credential_ciphertext = ?, updated_at = ?
      WHERE id = ?`)
      .run(name, baseUrl, encryptJson(updatedCredentials, encryptionKey), timestamp, providerId);
  } catch (error) {
    handleSqliteConflict(error, 'A provider with this name');
  }
  return getProvider(db, encryptionKey, providerId);
}

export function deleteProvider(db, rawProviderId) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
  if (Number(result.changes) === 0) throw notFound('Provider');
}

export function listSelectedModels(db, rawProviderId) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  if (!providerWithMetadata(db, providerId)) throw notFound('Provider');
  return db.prepare('SELECT id, model_id, created_at FROM provider_models WHERE provider_id = ? ORDER BY model_id COLLATE NOCASE').all(providerId)
    .map((row) => ({ id: row.id, modelId: row.model_id, createdAt: row.created_at }));
}

export function addSelectedModel(db, rawProviderId, body) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  if (!providerWithMetadata(db, providerId)) throw notFound('Provider');
  const selectedModelId = modelId(body.modelId);
  const id = randomUUID();
  try {
    db.prepare('INSERT INTO provider_models (id, provider_id, model_id, created_at) VALUES (?, ?, ?, ?)')
      .run(id, providerId, selectedModelId, now());
  } catch (error) {
    handleSqliteConflict(error, 'This selected model');
  }
  return { id, modelId: selectedModelId };
}

export function deleteSelectedModel(db, rawProviderId, rawModelId) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const selectedModelId = identifier(rawModelId, 'Selected model ID');
  const result = db.prepare('DELETE FROM provider_models WHERE id = ? AND provider_id = ?').run(selectedModelId, providerId);
  if (Number(result.changes) === 0) throw notFound('Selected model');
}

function upstreamUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

async function providerFetch(url, keys, options) {
  let lastResponse;
  for (const apiKey of [keys.primaryKey, ...keys.backupKeys]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(options.headers || {}) },
        body: options.body,
        signal: controller.signal
      });
      lastResponse = response;
      if (response.ok || ![401, 403, 429].includes(response.status)) return response;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The provider request timed out.');
      throw new Error('The provider could not be reached.');
    } finally {
      clearTimeout(timeout);
    }
  }
  return lastResponse;
}

export async function fetchProviderModels(db, encryptionKey, rawProviderId, timeoutMs) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const row = providerWithMetadata(db, providerId);
  if (!row) throw notFound('Provider');
  let response;
  try {
    response = await providerFetch(upstreamUrl(row.base_url, '/models'), credentialBundle(row, encryptionKey), {
      method: 'GET', timeoutMs
    });
  } catch (error) {
    throw new AppError(502, 'PROVIDER_UNAVAILABLE', error.message, { expose: true });
  }
  if (!response?.ok) {
    const status = response?.status ? ` (HTTP ${response.status})` : '';
    throw new AppError(502, 'MODEL_DISCOVERY_FAILED', `Model discovery failed${status}. Check the provider URL and API key.`, { expose: true });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'The provider returned an invalid model response.', { expose: true });
  }
  const seen = new Set();
  const models = Array.isArray(payload?.data) ? payload.data
    .map((entry) => typeof entry?.id === 'string' ? entry.id.trim() : '')
    .filter((id) => id && id.length <= 200 && !/[\u0000-\u001f]/u.test(id))
    .filter((id) => !seen.has(id) && seen.add(id))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 500) : [];
  return { provider: safeProviderWithKeys(row, encryptionKey), models };
}

export function providerCredentials(db, encryptionKey, rawProviderId) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const row = providerWithMetadata(db, providerId);
  if (!row) throw notFound('Provider');
  return { provider: safeProviderWithKeys(row, encryptionKey), credentials: credentialBundle(row, encryptionKey) };
}

export { providerFetch, upstreamUrl };
