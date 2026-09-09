import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { conflict, notFound, validation, AppError } from '../lib/errors.js';
import { requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';

const execFileP = promisify(execFile);
const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH_TOKEN = 'https://github.com/login/oauth/access_token';

// A plugin row stores type, display name, and a JSON config blob (never returned to the browser
// once saved). GitHub config holds the OAuth access token plus the repo the user selected.
function safePlugin(row) {
  const config = safeConfig(row.config);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: {
      // Only expose non-secret, non-token fields to the browser.
      account: config.account ?? null,
      ownerLogin: config.ownerLogin ?? config.owner ?? null,
      avatarUrl: config.avatarUrl ?? null,
      selectedRepo: config.selectedRepo ?? null,
      hasToken: Boolean(config.access_token)
    }
  };
}

function pluginRow(db, rawId) {
  const id = requiredString(rawId, 'Plugin ID', { max: 64 });
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!row) throw notFound('Plugin');
  return row;
}

function safeConfig(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function configWithToken(row) {
  const config = safeConfig(row.config);
  if (!config.access_token) throw new AppError(409, 'GITHUB_NOT_CONNECTED', 'Connect your GitHub account before using this plugin.', { expose: true });
  return config;
}

function cloneParent(workspaceDirectory) {
  const parent = resolve(workspaceDirectory, 'repos');
  return parent;
}

function repoSlug(owner, repo) {
  return `${owner}__${repo}`;
}

function withinParent(parent, target) {
  const resolvedParent = resolve(parent);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + sep);
}

function repoDirectory(workspaceDirectory, config) {
  const owner = safeString(config.owner);
  const repo = safeString(config.repo || config.selectedRepo);
  if (!owner || !repo) throw validation('A repository must be selected before cloning.');
  const parent = cloneParent(workspaceDirectory);
  const dir = join(parent, repoSlug(owner, repo));
  if (!withinParent(parent, dir)) throw validation('Repository path is outside the workspace.');
  return dir;
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function githubRequest(token, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'glow-agent',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new AppError(401, 'GITHUB_AUTH_FAILED', 'The GitHub token is invalid or expired. Reconnect your account.', { expose: true });
    }
    if (!response.ok) {
      throw new AppError(502, 'GITHUB_API_ERROR', `GitHub returned HTTP ${response.status}.`, { expose: true });
    }
    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === 'AbortError') throw new AppError(502, 'GITHUB_TIMEOUT', 'The GitHub request timed out.', { expose: true });
    throw new AppError(502, 'GITHUB_UNREACHABLE', 'GitHub could not be reached.', { expose: true });
  } finally {
    clearTimeout(timeout);
  }
}

export function listPlugins(db) {
  return db.prepare('SELECT * FROM plugins ORDER BY created_at ASC').all().map(safePlugin);
}

export function getPlugin(db, rawId) {
  return safePlugin(pluginRow(db, rawId));
}

export function createPlugin(db, body = {}) {
  const type = requiredString(body.type, 'Plugin type', { max: 40 }).toLowerCase();
  if (!['github'].includes(type)) throw validation('Only the GitHub plugin is supported currently.');
  const name = requiredString(body.name || 'GitHub', 'Plugin name', { max: 80 });
  const id = randomUUID();
  const timestamp = now();
  db.prepare('INSERT INTO plugins (id, type, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, type, name, JSON.stringify({}), 0, timestamp, timestamp);
  return getPlugin(db, id);
}

export function updatePlugin(db, rawId, body = {}) {
  const row = pluginRow(db, rawId);
  // Only allow updating the enabled state from the client; tokens and the selected repository
  // are managed by the GitHub OAuth / select endpoints.
  const enabledValue = typeof body.enabled === 'boolean' ? Number(body.enabled) : Number(row.enabled);
  db.prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabledValue, now(), rawId);
  return getPlugin(db, rawId);
}

export function deletePlugin(db, rawId) {
  const row = pluginRow(db, rawId);
  db.prepare('DELETE FROM plugins WHERE id = ?').run(row.id);
}

export async function fetchGithubToken({ clientId, clientSecret, code }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(GITHUB_OAUTH_TOKEN, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      signal: controller.signal
    });
    const payload = await response.json();
    const token = payload?.access_token;
    if (!token) throw new AppError(401, 'GITHUB_OAUTH_FAILED', payload?.error_description || payload?.error || 'GitHub OAuth exchange failed.', { expose: true });
    return token;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'GITHUB_UNREACHABLE', 'GitHub could not be reached.', { expose: true });
  } finally {
    clearTimeout(timeout);
  }
}

// Exchanges an OAuth code, fetches the signed-in account, and persists the token + account.
export async function connectGithub(db, rawId, { clientId, clientSecret, code }) {
  const token = await fetchGithubToken({ clientId, clientSecret, code });
  const account = await githubRequest(token, '/user');
  const row = pluginRow(db, rawId);
  const existing = safeConfig(row.config);
  const config = {
    ...existing,
    access_token: token,
    owner: safeString(account?.login),
    ownerLogin: safeString(account?.login),
    account: safeString(account?.name) || safeString(account?.login),
    avatarUrl: safeString(account?.avatar_url),
    connectedAt: now(),
    // A fresh connection clears any previously selected/cloned repository so the user picks again.
    selectedRepo: '',
    cloned: false,
    pushApproved: false
  };
  db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now(), row.id);
  return getPlugin(db, row.id);
}

export async function githubMe(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const account = await githubRequest(config.access_token, '/user');
  return { login: account?.login || '', name: account?.name || '', avatarUrl: account?.avatar_url || '' };
}

export async function githubListRepos(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const repos = await githubRequest(config.access_token, '/user/repos?per_page=100&sort=updated');
  if (!Array.isArray(repos)) return [];
  return repos.map((repo) => ({
    fullName: repo?.full_name || '',
    name: repo?.name || '',
    owner: repo?.owner?.login || '',
    private: Boolean(repo?.private),
    defaultBranch: repo?.default_branch || 'main',
    updatedAt: repo?.updated_at || '',
    url: repo?.clone_url || ''
  })).filter((repo) => repo.fullName);
}

async function git(args, cwd) {
  try {
    const result = await execFileP('git', args, { cwd, timeout: 60_000 });
    return { output: (result.stdout || '').trim() };
  } catch (error) {
    throw new AppError(500, 'GIT_ERROR', `git ${args.slice(0, 2).join(' ')} failed: ${(error.stderr || error.message).trim().slice(0, 300)}`, { expose: true });
  }
}

// Clones (or refreshes) the selected repo into the local workspace.
export async function cloneGithubRepo(db, rawId, workspaceDirectory) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const { owner, repo } = resolveRepo(config);
  const dir = repoDirectory(workspaceDirectory, config);
  const authUrl = authenticatedRepoUrl(owner, repo, config.access_token);
  const cleanUrl = cleanRepoUrl(owner, repo);
  if (existsSync(join(dir, '.git'))) {
    // Use the authenticated URL for the fetch, then reset to the clean URL so the token is not
    // persisted in the repository's remote config.
    await git(['remote', 'set-url', 'origin', authUrl], dir);
    const output = await git(['fetch', '--prune', 'origin'], dir);
    await git(['remote', 'set-url', 'origin', cleanUrl], dir);
    const updatedConfig = { ...config, cloned: true };
    db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedConfig), now(), row.id);
    return { repository: `${owner}/${repo}`, directory: dir, cloned: false, status: 'updated', output: output.output };
  }
  const parent = cloneParent(workspaceDirectory);
  // Clone directly (authenticated so private repos work), then reset the remote to the clean URL.
  await git(['clone', '--depth', '1', authUrl, dir], parent);
  await git(['remote', 'set-url', 'origin', cleanUrl], dir);
  const updatedConfig = { ...config, cloned: true };
  db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedConfig), now(), row.id);
  return { repository: `${owner}/${repo}`, directory: dir, cloned: true, status: 'cloned' };
}

function resolveRepo(config) {
  const repo = safeString(config.repo || config.selectedRepo);
  const slash = repo.indexOf('/');
  const owner = slash > 0 ? repo.slice(0, slash) : safeString(config.owner);
  const name = slash > 0 ? repo.slice(slash + 1) : safeString(config.repo);
  if (!owner || !name) throw validation('A repository must be selected before cloning.');
  return { owner, repo: name };
}

function cleanRepoUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

// Authenticated URL used for a single git operation (clone/fetch/push). The token is never
// persisted in the repository's remote because caller resets origin to the clean URL afterwards.
function authenticatedRepoUrl(owner, repo, token) {
  if (!token) return cleanRepoUrl(owner, repo);
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

export function githubWorkspaceDirectory(workspaceDirectory, config) {
  return repoDirectory(workspaceDirectory, config);
}

export function selectGithubRepo(db, rawId, { owner, repo, defaultBranch }) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const fullName = `${safeString(owner)}/${safeString(repo)}`;
  config.owner = safeString(owner);
  config.repo = safeString(repo);
  config.selectedRepo = fullName;
  config.defaultBranch = safeString(defaultBranch) || 'main';
  // Selecting a (possibly different) repo invalidates any previous clone so it is re-cloned.
  config.cloned = false;
  config.pushApproved = false;
  db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now(), row.id);
  return getPlugin(db, row.id);
}

// Stage + commit changes locally, but do NOT push. Pushing requires explicit confirmation.
export async function commitGithub(db, rawId, workspaceDirectory, { message }) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const dir = repoDirectory(workspaceDirectory, config);
  if (!existsSync(join(dir, '.git'))) throw validation('The repository has not been cloned yet.');
  const commitMessage = safeString(message || 'Glow Agent update');
  const add = await git(['add', '-A'], dir);
  const diff = await git(['status', '--short'], dir);
  if (!diff.output) return { committed: false, message: 'No changes to commit.', directory: dir };
  const commit = await git(['commit', '-m', commitMessage], dir);
  return { committed: true, message: commit.output, directory: dir };
}

// Push only proceeds when the user has explicitly confirmed (config.pushApproved === true).
export async function pushGithub(db, rawId, workspaceDirectory) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const { owner, repo } = resolveRepo(config);
  const dir = repoDirectory(workspaceDirectory, config);
  if (config.pushApproved !== true) {
    throw new AppError(403, 'GITHUB_PUSH_REQUIRES_CONFIRMATION', 'Push requires your confirmation. Approve the push in the chat UI.', { expose: true });
  }
  if (!existsSync(join(dir, '.git'))) throw validation('The repository has not been cloned yet.');
  const branch = safeString(config.defaultBranch) || 'main';
  const authUrl = authenticatedRepoUrl(owner, repo, config.access_token);
  const cleanUrl = cleanRepoUrl(owner, repo);
  await git(['remote', 'set-url', 'origin', authUrl], dir);
  await git(['push', 'origin', `HEAD:${branch}`], dir);
  await git(['remote', 'set-url', 'origin', cleanUrl], dir);
  db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...config, pushApproved: false }), now(), row.id);
  return { pushed: true, repository: `${owner}/${repo}`, branch, directory: dir };
}

// Approves the single next push for this plugin (called by the chat UI before a push completes).
export function approveGithubPush(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  config.pushApproved = true;
  db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now(), row.id);
  return getPlugin(db, row.id);
}

// ---- Repository file operations, strictly scoped to the cloned repo ----

function repoDir(workspaceDirectory, config) {
  return repoDirectory(workspaceDirectory, config);
}

function resolveRepoPath(root, relPath) {
  const safeRelative = safeString(relPath);
  if (!safeRelative) throw validation('A file path is required.');
  const target = resolve(root, safeRelative);
  if (!withinParent(root, target)) throw validation('Path is outside the repository.');
  return target;
}

export function repoListFiles(db, rawId, workspaceDirectory, relPath = '') {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const root = repoDir(workspaceDirectory, config);
  if (!existsSync(root)) return { error: 'The repository has not been cloned yet.' };
  let base;
  if (safeString(relPath)) {
    try { base = resolveRepoPath(root, relPath); } catch (error) { return { error: error.message }; }
  } else {
    base = root;
  }
  if (!existsSync(base)) return { error: 'Directory does not exist.' };
  if (!statSync(base).isDirectory()) return { error: 'Path is not a directory.' };
  let items;
  try { items = readdirSync(base, { withFileTypes: true }); } catch { return { error: 'Could not read directory.' }; }
  return {
    repository: config.selectedRepo,
    directory: relative(root, base) || '.',
    entries: items
      .filter((entry) => !['node_modules', '.git'].includes(entry.name))
      .map((entry) => ({
        path: relative(root, join(base, entry.name)),
        type: entry.isDirectory() ? 'directory' : 'file'
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
  };
}

export function repoReadFile(db, rawId, workspaceDirectory, relPath) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const root = repoDir(workspaceDirectory, config);
  let target;
  try { target = resolveRepoPath(root, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(target) || !statSync(target).isFile()) return { error: 'File does not exist.' };
  const stats = statSync(target);
  if (stats.size > 256 * 1024) return { error: 'File is too large to read.' };
  const buffer = readFileSync(target);
  if (buffer.includes(0)) return { error: 'This file appears binary and cannot be read as text.' };
  return { repository: config.selectedRepo, path: relative(root, target), size: stats.size, content: buffer.toString('utf8') };
}

export function repoWriteFile(db, rawId, workspaceDirectory, relPath, content) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const root = repoDir(workspaceDirectory, config);
  let target;
  try { target = resolveRepoPath(root, relPath); } catch (error) { return { error: error.message }; }
  const contentString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (contentString.length > 256 * 1024) return { error: 'Content is too large to write.' };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contentString, 'utf8');
  } catch (error) {
    return { error: error.message };
  }
  return { repository: config.selectedRepo, path: relative(root, target), wrote: true, bytes: Buffer.byteLength(contentString) };
}

export function repoDeleteFile(db, rawId, workspaceDirectory, relPath) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const root = repoDir(workspaceDirectory, config);
  let target;
  try { target = resolveRepoPath(root, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(target)) return { error: 'File does not exist.' };
  if (statSync(target).isDirectory()) return { error: 'Use a file path, not a directory.' };
  try {
    unlinkSync(target);
  } catch (error) {
    return { error: error.message };
  }
  return { repository: config.selectedRepo, path: relative(root, target), deleted: true };
}

export function repoRenameFile(db, rawId, workspaceDirectory, from, to) {
  const row = pluginRow(db, rawId);
  const config = configWithToken(row);
  const root = repoDir(workspaceDirectory, config);
  let source;
  let destination;
  try {
    source = resolveRepoPath(root, from);
    destination = resolveRepoPath(root, to);
  } catch (error) {
    return { error: error.message };
  }
  if (!existsSync(source)) return { error: 'Source file does not exist.' };
  if (existsSync(destination)) return { error: 'A file already exists at the destination.' };
  try {
    mkdirSync(dirname(destination), { recursive: true });
    const content = readFileSync(source);
    writeFileSync(destination, content);
    unlinkSync(source);
  } catch (error) {
    return { error: error.message };
  }
  return { repository: config.selectedRepo, from: relative(root, source), to: relative(root, destination), renamed: true };
}
