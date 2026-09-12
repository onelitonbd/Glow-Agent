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
const READ_LIMIT = 256 * 1024;
const READ_DISK_CAP = 4 * 1024 * 1024;
const WRITE_LIMIT = 256 * 1024;
const SQL_LIMIT = 100;
const SQL_CELL_LIMIT = 8_192;
const WEB_MAX_BYTES = 1024 * 1024;
const WEB_MAX_REDIRECTS = 5;

const WEB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Glow-Agent/0.1';

const FS_ERROR_MESSAGES = {
  ENOENT: 'Path does not exist. Use list_files to see what exists.',
  EACCES: 'Permission denied.',
  EPERM: 'Operation not permitted.',
  EISDIR: 'Expected a file but found a directory. Use list_files to inspect.',
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
  if (!existsSync(base)) return { error: 'Directory does not exist. Use path "" for root or check with list_files.' };
  if (!statSync(base).isDirectory()) return { error: 'Path is not a directory. Use a folder path.' };
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
  if (!existsSync(target) || !statSync(target).isFile()) return { error: `File does not exist: "${relPath}". Use list_files to discover files first.` };
  const stats = statSync(target);
  if (stats.size > READ_DISK_CAP) return { error: `File too large to read (${stats.size} bytes, max ${READ_DISK_CAP}).` };
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
  if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'A file path is required, e.g. "notes/todo.md".' };
  let target;
  try { target = safePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  const contentString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (contentString.length > WRITE_LIMIT) return { error: `Content too large to write (${contentString.length} chars, max ${WRITE_LIMIT}).` };
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
    .replace(/--[^\\n]*/gu, ' ')
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
  if (typeof sql !== 'string' || !sql.trim()) return { error: 'A SQL query is required, e.g. "SELECT id, title FROM conversations LIMIT 5".' };
  const trimmed = sql.trim();
  if (trimmed.length > 20_000) return { error: 'SQL query too long (max 20000).' };
  if (!/^(select|with)\b/iu.test(trimmed)) return { error: 'Only read-only SELECT queries allowed. Example: SELECT * FROM conversations LIMIT 10' };
  const withoutTrailingSemi = trimmed.replace(/;+\s*$/u, '');
  if (withoutTrailingSemi.includes(';')) return { error: 'Only single SQL statement allowed, no semicolons inside.' };
  const sanitized = stripSqlLiterals(withoutTrailingSemi);
  if (/\b(pragma|attach|detach|load_extension|insert|update|delete|drop|alter|create|replace|truncate|vacuum|reindex|grant|revoke)\b/iu.test(sanitized)) {
    return { error: 'Only read-only SELECT allowed. Write statements blocked.' };
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
    return { error: `SQL error: ${error.message}. Try simpler query like "SELECT id, title FROM conversations LIMIT 5"` };
  }
}

// ---- Web fetch with SSRF and memory guards -------------------------------------------

function parseIpLiteral(hostname) {
  const host = hostname.toLowerCase();
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
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  const bare = host.replace(/^\[|\]$/gu, '');
  if (!bare.includes(':')) return false;
  if (bare === '::' || bare === '::1') return true;
  if (bare.startsWith('fe80') || bare.startsWith('fe90') || bare.startsWith('fea0') || bare.startsWith('feb0')) return true;
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true;
  if (bare.includes('::ffff:')) {
    const mapped = bare.split('::ffff:')[1] || '';
    return isPrivateAddress(mapped);
  }
  return false;
}

async function assertPublicHostname(hostname) {
  if (isPrivateAddress(hostname)) throw new Error('URLs that point at local or private network addresses are not allowed.');
  const bare = hostname.replace(/^\[|\]$/gu, '');
  if (parseIpLiteral(bare) || bare.includes(':')) return;
  let records;
  try {
    records = await lookup(bare, { all: true });
  } catch {
    // If DNS lookup fails, we allow the fetch to proceed - fetch itself will fail if host invalid
    // But we still block if hostname is obviously private (checked above)
    // This makes web_search more resilient in environments where DNS lookup is restricted
    return;
  }
  if (!records.length) return;
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('URLs that point at local or private network addresses are not allowed (DNS resolved to private).');
  }
}

async function fetchText(url, { timeoutMs = 15_000, maxBytes = WEB_MAX_BYTES, retries = 1 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    let response = null;
    for (let redirect = 0; redirect <= WEB_MAX_REDIRECTS; redirect += 1) {
      let parsed;
      try {
        parsed = new URL(current);
      } catch {
        return { error: 'Invalid URL format.' };
      }
      try {
        await assertPublicHostname(parsed.hostname);
      } catch (e) {
        return { error: e.message };
      }
      
      let attempt = 0;
      let lastError = null;
      while (attempt <= retries) {
        try {
          response = await fetch(current, {
            headers: { 
              'User-Agent': WEB_USER_AGENT, 
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'manual',
            signal: controller.signal
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          }
          attempt++;
        }
      }
      if (lastError) {
        if (lastError.name === 'AbortError') return { error: 'The request timed out.' };
        return { error: `Request failed: ${lastError.message}` };
      }
      
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        current = new URL(response.headers.get('location'), current).href;
        continue;
      }
      break;
    }
    if (!response) return { error: 'The request could not be completed.' };
    if (!response.ok) return { error: `Request failed with HTTP ${response.status}.` };
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) return { error: 'Response too large to fetch safely.' };
    const reader = response.body?.getReader();
    if (!reader) return { error: 'No readable body.' };
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: 'Response too large to fetch safely.' };
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { text: buffer.toString('utf8'), bytes: buffer.length };
  } catch (error) {
    if (error.name === 'AbortError') return { error: 'The request timed out.' };
    if (typeof error.message === 'string' && error.message.includes('not allowed')) return { error: error.message };
    return { error: error.message === 'The host could not be resolved.' ? error.message : `Request could not be completed: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&apos;/giu, "'")
    .replace(/&#x27;/giu, "'")
    .replace(/&#x2F;/giu, "/")
    .replace(/&#(\d+);/gu, (_, code) => {
      try { return String.fromCharCode(Number(code)); } catch { return ' '; }
    })
    .replace(/\s+/gu, ' ')
    .trim();
}

function decodeDuckDuckGoHref(rawHref) {
  if (!rawHref) return '';
  try {
    const parsed = new URL(rawHref, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    if (target) {
      try { return decodeURIComponent(target); } catch { return target; }
    }
    return rawHref;
  } catch {
    return rawHref;
  }
}

function parseDuckDuckGo(html) {
  if (!html || typeof html !== 'string') return [];
  const results = [];
  
  // Try multiple patterns for robustness - DuckDuckGo HTML structure changes
  const patterns = [
    // Classic pattern
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
    // Newer pattern with data-testid or other classes
    /<a[^>]*class="[^"]*result__url[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
    // Fallback: any link in results div
    /<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
    // Lite version
    /<a[^>]*rel="[^"]*noopener[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu
  ];
  
  const snippetPatterns = [
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/giu,
    /<span[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/span>/giu,
    /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/giu
  ];
  
  let anchors = [];
  for (const pattern of patterns) {
    const matches = [...html.matchAll(pattern)];
    if (matches.length > 0) {
      anchors = matches;
      break;
    }
  }
  
  let snippets = [];
  for (const pattern of snippetPatterns) {
    const matches = [...html.matchAll(pattern)].map(m => htmlToText(m[1]));
    if (matches.length > 0) {
      snippets = matches;
      break;
    }
  }
  
  // If no snippets found, try to extract from result divs
  if (snippets.length === 0) {
    const resultDivPattern = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>/giu;
    const bodies = [...html.matchAll(resultDivPattern)];
    snippets = bodies.map(m => htmlToText(m[1]).slice(0, 200));
  }
  
  anchors.forEach((match, index) => {
    const href = match[1];
    const titleRaw = match[2] || '';
    if (!href || href.startsWith('#') || href.includes('duckduckgo.com/y.js')) return;
    const title = htmlToText(titleRaw);
    if (!title || title.length < 2) return;
    const url = decodeDuckDuckGoHref(href);
    // Filter out duckduckgo internal links
    if (url.includes('duckduckgo.com') && !url.includes('uddg=')) return;
    if (url.startsWith('/')) return;
    results.push({
      title: title.slice(0, 200),
      url: url.slice(0, 500),
      snippet: (snippets[index] || '').slice(0, 300)
    });
  });
  
  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    if (!seen.has(r.url) && r.title) {
      seen.add(r.url);
      deduped.push(r);
    }
  }
  
  return deduped;
}

export async function webSearch(query, maxResults = 5) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { error: 'A search query is required, e.g. "Node.js 22 features".' };
  const cap = Math.max(1, Math.min(Number(maxResults) || 5, 8));
  
  // Try HTML endpoint first
  let html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { timeoutMs: 12000 });
  if (!html.error) {
    const results = parseDuckDuckGo(html.text);
    if (results.length > 0) {
      return { query: q, results: results.slice(0, cap), provider: 'duckduckgo' };
    }
  }
  
  // Try lite endpoint as fallback
  const lite = await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, { timeoutMs: 10000 });
  if (!lite.error) {
    const results = parseDuckDuckGo(lite.text);
    if (results.length > 0) {
      return { query: q, results: results.slice(0, cap), provider: 'duckduckgo-lite' };
    }
  }
  
  // Try instant answer API as final fallback
  const fallback = await instantAnswer(q, cap);
  if (fallback && fallback.results && fallback.results.length > 0) {
    return { query: q, results: fallback.results, provider: 'duckduckgo-api' };
  }
  
  if (html.error && lite.error) {
    return { query: q, results: [], note: `Search returned no results. Tried DuckDuckGo HTML (${html.error}) and lite (${lite.error}). Try different keywords.`, provider: 'duckduckgo' };
  }
  
  return { query: q, results: [], note: 'No results found for this query. Try broader or different keywords.', provider: 'duckduckgo' };
}

async function instantAnswer(query, cap) {
  const response = await fetchText(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { timeoutMs: 8000 });
  if (response.error) return { results: [] };
  try {
    const data = JSON.parse(response.text);
    const results = [];
    const push = (text, url) => { 
      if (text && results.length < cap) {
        const clean = htmlToText(text);
        if (clean) results.push({ title: clean.split(/[.:]/u)[0].slice(0, 100) || 'Result', url: url || '', snippet: clean.slice(0, 200) });
      }
    };
    if (data.AbstractText) push(data.AbstractText, data.AbstractURL);
    if (data.Answer) push(data.Answer, '');
    if (data.Definition) push(data.Definition, data.DefinitionURL);
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const item of related) {
      if (results.length >= cap) break;
      if (item?.Text) push(item.Text, item.FirstURL);
      else if (Array.isArray(item?.Topics)) {
        for (const sub of item.Topics) {
          if (results.length >= cap) break;
          if (sub?.Text) push(sub.Text, sub.FirstURL);
        }
      }
    }
    return { results };
  } catch {
    return { results: [] };
  }
}

export async function fetchUrl(url, maxChars = 4_000) {
  const input = typeof url === 'string' ? url.trim() : '';
  if (!input) return { error: 'A URL is required, e.g. "https://example.com".' };
  let parsed;
  try { parsed = new URL(input); } catch { return { error: 'URL must be valid HTTP or HTTPS, e.g. "https://example.com".' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http and https URLs allowed.' };
  const response = await fetchText(parsed.href, { timeoutMs: 15000 });
  if (response.error) return { error: response.error };
  const cap = Math.max(200, Math.min(Number(maxChars) || 4_000, 20_000));
  const content = htmlToText(response.text);
  if (!content) return { error: 'Page had no readable text content.', url: parsed.href };
  return {
    url: parsed.href,
    content: content.slice(0, cap),
    charCount: content.length,
    truncated: content.length > cap
  };
}
