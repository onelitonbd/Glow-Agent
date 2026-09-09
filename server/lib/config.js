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

function positiveIntegerSetting(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
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
    providerFetchTimeoutMs: 15_000,
    chatTimeoutMs: 60_000,
    // Safety ceiling on tool-use rounds per turn (kept high so it is effectively unlimited,
    // still bounded so a runaway tool loop cannot hang the request). Configure with MAX_TOOL_ROUNDS.
    maxToolRounds: positiveIntegerSetting(env.MAX_TOOL_ROUNDS, 500, 'MAX_TOOL_ROUNDS'),
    // How many times to retry a provider request after a failure (network, 5xx, timeout, or a
    // mid-stream interruption), resuming from any partial content. Configure with MAX_PROVIDER_RETRIES.
    maxProviderRetries: positiveIntegerSetting(env.MAX_PROVIDER_RETRIES, 20, 'MAX_PROVIDER_RETRIES')
  });
}
