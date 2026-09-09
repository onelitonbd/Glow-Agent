import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, sep, join, dirname } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', 'build', 'dist', 'coverage',
  'out', 'target', '.next', '.nuxt', '.output', '.parcel-cache', '.svelte-kit',
  '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '__pycache__', '.cache'
]);
const LIST_LIMIT = 400;
const LIST_DEPTH = 10;
const READ_LIMIT = 256 * 1024;
const WRITE_LIMIT = 256 * 1024;
const SQL_LIMIT = 100;

const WEB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function withinRoot(rootDirectory, target) {
  const resolvedRoot = resolve(rootDirectory);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function resolveWithinRoot(rootDirectory, relPath) {
  const safeRelative = typeof relPath === 'string' ? relPath.trim() : '';
  if (!safeRelative || safeRelative === '.') return resolve(rootDirectory);
  const target = resolve(rootDirectory, safeRelative);
  if (!withinRoot(rootDirectory, target)) throw new Error('Path is outside the workspace.');
  return target;
}

export function listFiles(rootDirectory, relPath) {
  let base;
  try { base = resolveWithinRoot(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(base)) return { error: 'Directory does not exist.' };
  if (!statSync(base).isDirectory()) return { error: 'Path is not a directory.' };
  const entries = [];
  const walk = (dir, depth) => {
    if (entries.length >= LIST_LIMIT || depth > LIST_DEPTH) return;
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of items) {
      if (entries.length >= LIST_LIMIT) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      const path = relative(rootDirectory, absolute);
      const type = entry.isDirectory() ? 'directory' : 'file';
      let size = null;
      if (type === 'file') { try { size = statSync(absolute).size; } catch { size = null; } }
      entries.push({ path, type, size });
      if (type === 'directory') walk(absolute, depth + 1);
    }
  };
  walk(base, 0);
  return {
    directory: relative(rootDirectory, base) || '.',
    entries,
    entryCount: entries.length,
    truncated: entries.length >= LIST_LIMIT
  };
}

export function readFile(rootDirectory, relPath) {
  let target;
  try { target = resolveWithinRoot(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(target) || !statSync(target).isFile()) return { error: 'File does not exist.' };
  const stats = statSync(target);
  if (stats.size > READ_LIMIT) return { error: `File is too large to read (${stats.size} bytes).` };
  let buffer;
  try { buffer = readFileSync(target); } catch (error) { return { error: error.message }; }
  if (buffer.includes(0)) return { error: 'This file appears binary and cannot be read as text.' };
  const content = buffer.toString('utf8');
  return { path: relative(rootDirectory, target), size: stats.size, content };
}

export function writeFile(rootDirectory, relPath, content) {
  if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'A file path is required.' };
  let target;
  try { target = resolveWithinRoot(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (target.includes(`${sep}.git${sep}`) || target.endsWith(`${sep}.git`)) {
    return { error: 'Writing inside .git is not allowed.' };
  }
  const contentString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (contentString.length > WRITE_LIMIT) return { error: `Content is too large to write (${contentString.length} characters).` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contentString, 'utf8');
  } catch (error) {
    return { error: error.message };
  }
  const size = statSync(target).size;
  return { path: relative(rootDirectory, target), pathType: 'file', size, bytes: size, wrote: true };
}

function stripSqlLiterals(sql) {
  return sql
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/'(?:[^']|'')*'/gu, '')
    .replace(/"(?:[^"]|"")*"/gu, '');
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
    const limited = rows.slice(0, SQL_LIMIT);
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

async function fetchText(url, { timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) return { error: `Request failed with HTTP ${response.status}.` };
    const buffer = Buffer.from(await response.arrayBuffer());
    return { text: buffer.toString('utf8'), bytes: buffer.length };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'The request timed out.' : 'The request could not be completed.' };
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
