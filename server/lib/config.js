import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function loadDotEnv(filePath) {
  try {
    const contents = readFileSync(filePath, 'utf8');
    for (const sourceLine of contents.split(/\r?\n/u)) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function integerSetting(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return number;
}

function encryptionKey(value) {
  if (!value || value === 'replace-with-a-random-base64-encoded-32-byte-key') {
    throw new Error('APP_ENCRYPTION_KEY is required. Copy .env.example to .env and generate a 32-byte base64 key.');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('APP_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key.');
  }
  return key;
}

export function loadConfig({ env = process.env, loadEnv = true } = {}) {
  if (loadEnv) loadDotEnv(resolve(rootDirectory, '.env'));
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('This MVP only permits loopback binding. Set HOST to 127.0.0.1, ::1, or localhost.');
  }
  const databaseSetting = env.DATABASE_PATH || './data/glow-agent.sqlite';
  return Object.freeze({
    rootDirectory,
    host,
    port: integerSetting(env.PORT, 3000, 'PORT'),
    databasePath: isAbsolute(databaseSetting) ? databaseSetting : resolve(rootDirectory, databaseSetting),
    encryptionKey: encryptionKey(env.APP_ENCRYPTION_KEY),
    providerFetchTimeoutMs: 15_000,
    chatTimeoutMs: 60_000
  });
}
