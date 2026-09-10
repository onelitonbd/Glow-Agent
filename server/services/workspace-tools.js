import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { lookup } from 'node:dns/promises';
import { resolveSafePath } from './file-guard.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', 'build', 'dist', 'coverage',
  'out', 'target', '.next', '.nuxt', '.output', '.parcel-cache', '.svelte-kit',
  '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '__pycache__', '.cache'
]);
const LIST_LIMIT = 400;
const LIST_DEPTH = 10;
// A single read_file call returns at most this many characters; bigger files are paged through
// with offset/limit up to READ_DISK_CAP total size.
const READ_LIMIT = 256 * 1024;
const READ_DISK_CAP = 4 * 1024 * 1024;
const WRITE_LIMIT = 256 * 1024;
const SQL_LIMIT = 100;
const SQL_CELL_LIMIT = 8_192;
// Web fetches are capped so a hostile or careless URL cannot exhaust device memory.
const WEB_MAX_BYTES = 1024 * 1024;
const WEB_MAX_REDIRECTS = 5;

const WEB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Filesystem errors echo absolute paths; the model only ever needs the reason, so known errno
// codes map to static messages and anything unknown collapses to a generic failure.
const FS_ERROR_MESSAGES = {
  ENOENT: 'Path does not exist.',
  EACCES: 'Permission denied.',
  EPERM: 'Operation not permitted.',
  EISDIR: 'Expected a file but found a directory.',
  ENOTDIR: 'A path component is not a directory.',
  EEXIST: 'Path already exists.',
  ENAMETOOLONG: 'The path is too long.',
  ENOSPC: 'The device is out of storage space.',
  ELOOP: 'The path contains too many levels of symbolic links.'
};

function cleanError(error) {
  return FS_ERROR_MESSAGES[error?.code] || 'The file operation failed.';
}

function safePath(rootDirectory, relPath) {
  return resolveSafePath(rootDirectory, relPath);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

export function listFiles(rootDirectory, relPath, { recursive = false } = {}) {
  let base;
  try { base = safePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(base)) return { error: 'Directory does not exist.' };
  if (!statSync(base).isDirectory()) return { error: 'Path is not a directory.' };
  const resolvedRoot = resolve(rootDirectory);
  const entries = [];
  const addEntry = (absolute, type) => {
    let size = null;
    if (type === 'file') { try { size = statSync(absolute).size; } catch { size = null; } }
    entries.push({ path: relative(resolvedRoot, absolute), type, size });
  };
  const sortedItems = (dir) => {
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  };
  if (!recursive) {
    // Shallow mode: just this directory's immediate contents, so large trees stay cheap.
    for (const entry of sortedItems(base)) {
      if (entries.length >= LIST_LIMIT) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      addEntry(join(base, entry.name), entry.isDirectory() ? 'directory' : 'file');
    }
  } else {
    const walk = (dir, depth) => {
      if (entries.length >= LIST_LIMIT || depth > LIST_DEPTH) return;
      for (const entry of sortedItems(dir)) {
        if (entries.length >= LIST_LIMIT) break;
        if (SKIP_DIRS.has(entry.name)) continue;
        const absolute = join(dir, entry.name);
        const type = entry.isDirectory() ? 'directory' : 'file';
        addEntry(absolute, type);
        if (type === 'directory') walk(absolute, depth + 1);
      }
    };
    walk(base, 0);
  }
  return {
    directory: relative(resolvedRoot, base) || '.',
    recursive: recursive === true,
    entries,
    entryCount: entries.length,
    truncated: entries.length >= LIST_LIMIT
  };
}

export function readFile(rootDirectory, relPath, { offset = 0, limit = READ_LIMIT } = {}) {
  let target;
  try { target = safePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(target) || !statSync(target).isFile()) return { error: 'File does not exist.' };
  const stats = statSync(target);
  if (stats.size > READ_DISK_CAP) return { error: `File is too large to read (${stats.size} bytes).` };
  let buffer;
  try { buffer = readFileSync(target); } catch (error) { return { error: cleanError(error) }; }
  if (buffer.includes(0)) return { error: 'This file appears binary and cannot be read as text.' };
  const full = buffer.toString('utf8');
  const start = clampInteger(offset, 0, 0, full.length);
  const count = clampInteger(limit, READ_LIMIT, 1, READ_LIMIT);
  const content = full.slice(start, start + count);
  return {
    path: relative(resolve(rootDirectory), target),
    size: stats.size,
    totalChars: full.length,
    offset: start,
    returnedChars: content.length,
    truncated: start + content.length < full.length,
    content
  };
}

export function writeFile(rootDirectory, relPath, content) {
  if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'A file path is required.' };
  let target;
  try { target = safePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  const contentString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (contentString.length > WRITE_LIMIT) return { error: `Content is too large to write (${contentString.length} characters).` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contentString, 'utf8');
  } catch (error) {
    return { error: cleanError(error) };
  }
  const size = statSync(target).size;
  return { path: relative(resolve(rootDirectory), target), pathType: 'file', size, bytes: size, wrote: true };
}

function stripSqlLiterals(sql) {
  return sql
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/'(?:[^']|'')*'/gu, '')
    .replace(/"(?:[^"]|"")*"/gu, '');
}

function capSqlCell(value) {
  if (typeof value === 'string' && value.length > SQL_CELL_LIMIT) return `${value.slice(0, SQL_CELL_LIMIT)}…[truncated]`;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `<blob ${value.length} bytes>`;
  return value;
}

export function sqlQuery(db, sql) {
  if (typeof sql !== 'string' || !sql.trim()) return { error: 'A SQL query is required.' };
  const trimmed = sql.trim();
  if (trimmed.length > 20_000) return { error: 'SQL query is too long.' };
  if (!/^(select|with)\b/iu.test(trimmed)) return { error: 'Only read-only SELECT queries are allowed.' };
  const withoutTrailingSemi = trimmed.replace(/;+\s*$/u, '');
  if (withoutTrailingSemi.includes(';')) return { error: 'Only a single SQL statement is allowed.' };
  const sanitized = stripSqlLiterals(withoutTrailingSemi);
  if (/\b(pragma|attach|detach|load_extension|insert|update|delete|drop|alter|create|replace|truncate|vacuum|reindex|grant|revoke)\b/iu.test(sanitized)) {
    return { error: 'Only read-only SELECT queries are allowed.' };
  }
  try {
    const rows = db.prepare(trimmed).all();
    const capped = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, capSqlCell(value)])));
    const limited = capped.slice(0, SQL_LIMIT);
    return {
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows: limited,
      rowCount: rows.length,
      truncated: rows.length > SQL_LIMIT
    };
  } catch (error) {
    return { error: `SQL error: ${error.message}` };
  }
}

// ---- Web fetch with SSRF and memory guards -------------------------------------------

function parseIpLiteral(hostname) {
  const host = hostname.toLowerCase();
  // IPv4-mapped/-compatible forms inside brackets or bare.
  const mapped = /^\[?::ffff:(\d+\.\d+\.\d+\.\d+)\]?$/u.exec(host);
  const candidate = mapped ? mapped[1] : host.replace(/^\[|\]$/gu, '');
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(candidate)) return candidate.split('.').map(Number);
  return null;
}

export function isPrivateAddress(hostname) {
  if (typeof hostname !== 'string' || !hostname) return true;
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === 'localhost.' || host.endsWith('.localhost') || host.endsWith('.localhost.')) return true;
  const v4 = parseIpLiteral(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // IETF assignments block
    if (a >= 224) return true; // multicast/reserved/broadcast
    return false;
  }
  const bare = host.replace(/^\[|\]$/gu, '');
  if (!bare.includes(':')) return false; // a plain domain name — resolved via DNS later
  if (bare === '::' || bare === '::1') return true;
  if (bare.startsWith('fe80') || bare.startsWith('fe90') || bare.startsWith('fea0') || bare.startsWith('feb0')) return true; // fe80::/10
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true; // fc00::/7 unique-local
  if (bare.includes('::ffff:')) {
    const mapped = bare.split('::ffff:')[1] || '';
    return isPrivateAddress(mapped);
  }
  return false;
}

async function assertPublicHostname(hostname) {
  if (isPrivateAddress(hostname)) throw new Error('URLs that point at local or private network addresses are not allowed.');
  // A public-looking domain can still resolve to a private address, so check what DNS says.
  const bare = hostname.replace(/^\[|\]$/gu, '');
  if (parseIpLiteral(bare) || bare.includes(':')) return; // literal already checked above
  let records;
  try {
    records = await lookup(bare, { all: true });
  } catch {
    throw new Error('The host could not be resolved.');
  }
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('URLs that point at local or private network addresses are not allowed.');
  }
}

async function fetchText(url, { timeoutMs = 12_000, maxBytes = WEB_MAX_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    let response = null;
    for (let redirect = 0; redirect <= WEB_MAX_REDIRECTS; redirect += 1) {
      const parsed = new URL(current);
      await assertPublicHostname(parsed.hostname);
      response = await fetch(current, {
        headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' },
        redirect: 'manual',
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        // Every redirect target is re-validated; a public URL must not bounce to 169.254.169.254.
        current = new URL(response.headers.get('location'), current).href;
        continue;
      }
      break;
    }
    if (!response) return { error: 'The request could not be completed.' };
    if (!response.ok) return { error: `Request failed with HTTP ${response.status}.` };
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) return { error: 'The response is too large to fetch safely.' };
    const reader = response.body?.getReader();
    if (!reader) return { error: 'The response had no readable body.' };
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: 'The response is too large to fetch safely.' };
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { text: buffer.toString('utf8'), bytes: buffer.length };
  } catch (error) {
    if (error.name === 'AbortError') return { error: 'The request timed out.' };
    if (typeof error.message === 'string' && error.message.includes('not allowed')) return { error: error.message };
    return { error: error.message === 'The host could not be resolved.' ? error.message : 'The request could not be completed.' };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&apos;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function decodeDuckDuckGoHref(rawHref) {
  try {
    const parsed = new URL(rawHref, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : rawHref;
  } catch {
    return rawHref;
  }
}

function parseDuckDuckGo(html) {
  const results = [];
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gu;
  const anchors = [...html.matchAll(anchorPattern)];
  const snippets = [...html.matchAll(snippetPattern)].map((match) => htmlToText(match[1]));
  anchors.forEach((match, index) => {
    results.push({
      title: htmlToText(match[2]),
      url: decodeDuckDuckGoHref(match[1]),
      snippet: snippets[index] || ''
    });
  });
  return results.filter((result) => result.title);
}

export async function webSearch(query, maxResults = 5) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { error: 'A search query is required.' };
  const cap = Math.max(1, Math.min(Number(maxResults) || 5, 8));
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  if (!html.error) {
    const results = parseDuckDuckGo(html.text);
    if (results.length) return { query: q, results: results.slice(0, cap), provider: 'duckduckgo' };
    const fallback = await instantAnswer(q, cap);
    if (fallback && fallback.results && fallback.results.length) return { query: q, results: fallback.results, provider: 'duckduckgo' };
    return { query: q, results: [], note: 'No results found for this query.' };
  }
  const fallback = await instantAnswer(q, cap);
  if (fallback && fallback.results && fallback.results.length) return { query: q, results: fallback.results, provider: 'duckduckgo' };
  return { error: html.error };
}

async function instantAnswer(query, cap) {
  const response = await fetchText(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (response.error) return { results: [] };
  try {
    const data = JSON.parse(response.text);
    const results = [];
    const push = (text, url) => { if (text && results.length < cap) results.push({ title: text.split(/[.:]/u)[0] || 'Result', url: url || '', snippet: text }); };
    if (data.AbstractText) push(data.AbstractText, data.AbstractURL);
    if (data.Answer) push(data.Answer, '');
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    related.filter((item) => item?.Text).slice(0, cap).forEach((item) => push(item.Text, item.FirstURL));
    return { results };
  } catch {
    return { results: [] };
  }
}

export async function fetchUrl(url, maxChars = 4_000) {
  const input = typeof url === 'string' ? url.trim() : '';
  if (!input) return { error: 'A URL is required.' };
  let parsed;
  try { parsed = new URL(input); } catch { return { error: 'URL must be a valid HTTP or HTTPS address.' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http and https URLs are allowed.' };
  const response = await fetchText(parsed.href);
  if (response.error) return { error: response.error };
  const cap = Math.max(200, Math.min(Number(maxChars) || 4_000, 20_000));
  const content = htmlToText(response.text);
  return {
    url: parsed.href,
    content: content.slice(0, cap),
    charCount: content.length,
    truncated: content.length > cap
  };
}
