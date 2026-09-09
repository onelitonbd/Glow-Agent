import { validation } from './errors.js';

export function requiredString(value, label, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') throw validation(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw validation(`${label} must contain ${min}–${max} characters.`);
  }
  return normalized;
}

export function optionalString(value, label, { max = 500 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, label, { min: 1, max });
}

export function stringArray(value, label, { maxItems = 20, itemMax = 500 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw validation(`${label} must contain at most ${maxItems} items.`);
  return value.map((item, index) => requiredString(item, `${label} item ${index + 1}`, { max: itemMax }));
}

export function identifier(value, label = 'Identifier') {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/iu.test(value)) throw validation(`${label} is invalid.`);
  return value;
}

export function normalizedBaseUrl(value) {
  const input = requiredString(value, 'Base URL', { max: 600 });
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw validation('Base URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw validation('Base URL must be an HTTP or HTTPS URL without credentials, a query, or a fragment.');
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function modelId(value) {
  if (typeof value !== 'string') throw validation('Model ID is required.');
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f]/u.test(normalized)) {
    throw validation('Model ID must contain 1–200 printable characters.');
  }
  return normalized;
}

export function optionalArray(value, label, options) {
  if (value === undefined) return undefined;
  return stringArray(value, label, options);
}
