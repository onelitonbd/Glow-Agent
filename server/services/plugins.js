import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { notFound, validation, AppError } from '../lib/errors.js';
import { requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';
import { McpClient, mcpServerOptions } from './mcp.js';
import { buildMcpToolset, isMutatingTool } from './mcp-tools.js';

const execFileP = promisify(execFile);

// ---- GitHub MCP presets ----
// The remote server is hosted by GitHub; the local server runs the official image or binary and
// speaks MCP over stdio. Toolsets are selected with the X-MCP-Toolsets header (remote) or the
// --toolsets flag (local); read-only mode uses X-MCP-Readonly / --read-only.
const GITHUB_REMOTE_URL = 'https://api.githubcopilot.com/mcp/';
const GITHUB_DOCKER_IMAGE = 'ghcr.io/github/github-mcp-server';
const GITHUB_DEFAULT_TOOLSETS = ['repos', 'users', 'issues', 'pull_requests', 'context'];
const MAX_STORED_TOOLS = 250;

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeConfig(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key === 'string' && typeof item === 'string') out[key] = item;
  }
  return out;
}

// The stored `mutating` flag must match what the write gate enforces, so both use isMutatingTool
// (annotations when the server publishes them, the tool-name heuristic when it does not).
function storedTool(tool) {
  return {
    name: safeString(tool.name),
    description: safeString(tool.description).slice(0, 300),
    mutating: isMutatingTool(tool)
  };
}

function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// A plugin row stores the MCP server definition in a JSON config blob. Secrets (the GitHub
// token, custom headers, custom env) are never returned to the browser.
function safePlugin(row) {
  const config = safeConfig(row.config);
  const github = config.github && typeof config.github === 'object' ? config.github : {};
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: {
      preset: safeString(config.preset) || 'custom',
      mode: safeString(github.mode) || 'remote',
      transport: config.transport === 'stdio' ? 'stdio' : 'http',
      url: safeString(config.url),
      command: safeString(config.command),
      args: stringList(config.args),
      toolsets: stringList(github.toolsets),
      readOnly: github.readOnly === true,
      host: safeString(github.host),
      localClone: github.localClone === true,
      toolAllowlist: stringList(config.toolAllowlist),
      hasToken: Boolean(safeString(github.token) || stringMap(config.headers).Authorization),
      connected: config.connected === true,
      serverName: safeString(config.serverName),
      serverVersion: safeString(config.serverVersion),
      toolCount: Number(config.toolCount) || 0,
      tools: Array.isArray(config.tools) ? config.tools.slice(0, MAX_STORED_TOOLS) : [],
      connectedAt: safeString(config.connectedAt),
      lastError: safeString(config.lastError),
      selectedRepo: safeString(config.selectedRepo),
      ownerLogin: safeString(config.ownerLogin || config.owner),
      account: safeString(config.account),
      avatarUrl: safeString(config.avatarUrl)
    }
  };
}

function pluginRow(db, rawId) {
  const id = requiredString(rawId, 'Plugin ID', { max: 64 });
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!row) throw notFound('Plugin');
  return row;
}

function saveConfig(db, row, config) {
  db.prepare('UPDATE plugins SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now(), row.id);
}

// ---- Server definition: preset + stored config -> concrete MCP transport options ----

// Expands the GitHub preset into a real server definition, or passes a custom one through.
export function resolveServer(config = {}) {
  const preset = safeString(config.preset) || 'custom';
  const github = config.github && typeof config.github === 'object' ? config.github : {};
  const token = safeString(github.token);
  const toolsets = stringList(github.toolsets);
  const readOnly = github.readOnly === true;
  const host = safeString(github.host);
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90_000;

  if (preset === 'github') {
    const mode = safeString(github.mode) || 'remote';
    if (mode === 'local-docker' || mode === 'local-binary') {
      const flags = [];
      if (mode === 'local-binary') flags.push('stdio');
      if (toolsets.length) flags.push('--toolsets', toolsets.join(','));
      if (readOnly) flags.push('--read-only');
      if (host) flags.push('--gh-host', host);
      const env = {};
      if (token) env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
      if (host) env.GITHUB_HOST = host;
      if (mode === 'local-docker') {
        return {
          transport: 'stdio',
          command: 'docker',
          args: [
            'run', '-i', '--rm',
            ...(token ? ['-e', 'GITHUB_PERSONAL_ACCESS_TOKEN'] : []),
            ...(host ? ['-e', 'GITHUB_HOST'] : []),
            GITHUB_DOCKER_IMAGE,
            ...flags
          ],
          env,
          fetchTimeoutMs: timeoutMs
        };
      }
      const binary = safeString(github.binary) || 'github-mcp-server';
      return { transport: 'stdio', command: binary, args: flags, env, fetchTimeoutMs: timeoutMs };
    }
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (toolsets.length) headers['X-MCP-Toolsets'] = toolsets.join(',');
    if (readOnly) headers['X-MCP-Readonly'] = 'true';
    const url = host ? `https://copilot-api.${host}/mcp/` : GITHUB_REMOTE_URL;
    return { transport: 'http', url, headers, fetchTimeoutMs: timeoutMs };
  }

  return mcpServerOptions({ ...config, timeoutMs });
}

function serverLabel(config) {
  const preset = safeString(config.preset) || 'custom';
  if (preset === 'github') return 'github';
  const url = safeString(config.url);
  if (url) { try { return new URL(url).hostname; } catch { return 'mcp'; } }
  return safeString(config.command) || 'mcp';
}

export function listPlugins(db) {
  return db.prepare('SELECT * FROM plugins ORDER BY created_at ASC').all().map(safePlugin);
}

export function getPlugin(db, rawId) {
  return safePlugin(pluginRow(db, rawId));
}

export function createPlugin(db, body = {}) {
  const type = requiredString(body.type, 'Plugin type', { max: 40 }).toLowerCase();
  if (!['mcp'].includes(type)) throw validation('Only MCP plugins are supported. The GitHub plugin is an MCP plugin.');
  const preset = safeString(body.preset).toLowerCase();
  if (preset && !['github', 'custom'].includes(preset)) throw validation('Preset must be "github" or "custom".');
  const effectivePreset = preset || 'github';
  const name = requiredString(body.name || (effectivePreset === 'github' ? 'GitHub' : 'MCP server'), 'Plugin name', { max: 80 });
  const id = randomUUID();
  const timestamp = now();
  const config = {
    preset: effectivePreset,
    github: { mode: 'remote', toolsets: [...GITHUB_DEFAULT_TOOLSETS] }
  };
  db.prepare('INSERT INTO plugins (id, type, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, type, name, JSON.stringify(config), 0, timestamp, timestamp);
  return getPlugin(db, id);
}

// Applies a client-supplied server definition to the stored config. Secrets are only replaced
// when a new value is sent, so re-saving a plugin never wipes an existing token.
export function configurePlugin(db, rawId, body = {}) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  const preset = safeString(body.preset).toLowerCase() || safeString(config.preset) || 'github';
  if (!['github', 'custom'].includes(preset)) throw validation('Preset must be "github" or "custom".');
  const previousGithub = config.github && typeof config.github === 'object' ? config.github : {};
  const incomingGithub = body.github && typeof body.github === 'object' ? body.github : {};
  const github = {
    ...previousGithub,
    mode: safeString(incomingGithub.mode) || safeString(previousGithub.mode) || 'remote',
    token: incomingGithub.token === undefined ? safeString(previousGithub.token) : safeString(incomingGithub.token),
    host: incomingGithub.host === undefined ? safeString(previousGithub.host) : safeString(incomingGithub.host),
    binary: incomingGithub.binary === undefined ? safeString(previousGithub.binary) : safeString(incomingGithub.binary)
  };
  if (Array.isArray(incomingGithub.toolsets)) github.toolsets = stringList(incomingGithub.toolsets);
  else if (github.toolsets === undefined) github.toolsets = [...GITHUB_DEFAULT_TOOLSETS];
  if (typeof incomingGithub.readOnly === 'boolean') github.readOnly = incomingGithub.readOnly;
  if (typeof incomingGithub.localClone === 'boolean') github.localClone = incomingGithub.localClone;

  const next = {
    ...config,
    preset,
    github,
    transport: safeString(body.transport).toLowerCase() === 'stdio' ? 'stdio' : 'http',
    url: body.url === undefined ? safeString(config.url) : safeString(body.url),
    command: body.command === undefined ? safeString(config.command) : safeString(body.command),
    args: body.args === undefined ? stringList(config.args) : stringList(body.args),
    env: body.env === undefined ? stringMap(config.env) : stringMap(body.env)
  };
  if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    next.headers = { ...stringMap(config.headers), ...stringMap(body.headers) };
  }
  if (Array.isArray(body.toolAllowlist)) next.toolAllowlist = stringList(body.toolAllowlist);

  const server = resolveServer(next);
  if (server.transport === 'http' && !server.url) throw validation('A server URL is required for an HTTP MCP server.');
  if (server.transport === 'stdio' && !server.command) throw validation('A command is required for a stdio MCP server.');

  // A changed server definition invalidates the previous connection and repo choice.
  const signature = JSON.stringify([server.transport, server.url || '', server.command || '', server.args || [], server.headers || {}, server.env || {}]);
  if (signature !== safeString(config.serverSignature)) {
    next.connected = false;
    next.connectedAt = '';
    next.serverName = '';
    next.serverVersion = '';
    next.toolCount = 0;
    next.tools = [];
    next.lastError = '';
    next.selectedRepo = '';
    next.ownerLogin = '';
    next.account = '';
    next.avatarUrl = '';
  }
  next.serverSignature = signature;
  next.writesApproved = false;
  saveConfig(db, row, next);
  return getPlugin(db, row.id);
}

// Only the enabled flag is switched from the chat UI; the server definition goes through
// configurePlugin so a change always re-runs the handshake.
export function updatePlugin(db, rawId, body = {}) {
  const row = pluginRow(db, rawId);
  const enabledValue = typeof body.enabled === 'boolean' ? Number(body.enabled) : Number(row.enabled);
  db.prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?').run(enabledValue, now(), rawId);
  return getPlugin(db, rawId);
}

export function deletePlugin(db, rawId) {
  const row = pluginRow(db, rawId);
  db.prepare('DELETE FROM plugins WHERE id = ?').run(row.id);
}

function connectedConfig(row) {
  const config = safeConfig(row.config);
  if (config.connected !== true) {
    throw new AppError(409, 'MCP_NOT_CONNECTED', 'Connect the MCP server before using this plugin.', { expose: true });
  }
  return config;
}

// Performs the MCP handshake, discovers the tools, and (for GitHub) resolves the signed-in
// account. The result is persisted so the UI can show the tools without reconnecting.
export async function connectPlugin(db, rawId, body = null) {
  if (body) configurePlugin(db, rawId, body);
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  const server = resolveServer(config);
  const client = new McpClient(server);
  let next = { ...config };
  try {
    await client.connect({ timeoutMs: 20_000 });
    const tools = await client.listTools();
    const storedTools = tools.slice(0, MAX_STORED_TOOLS).map(storedTool).filter((tool) => tool.name);
    next = {
      ...next,
      connected: true,
      lastError: '',
      connectedAt: now(),
      serverName: safeString(client.serverInfo?.name),
      serverVersion: safeString(client.serverInfo?.version),
      serverInstructions: safeString(client.instructions).slice(0, 2000),
      protocolVersion: safeString(client.protocolVersion),
      transport: server.transport,
      toolCount: tools.length,
      tools: storedTools
    };
    if (safeString(config.preset) === 'github' && storedTools.some((tool) => tool.name === 'get_me')) {
      try {
        const account = await accountFromClient(client);
        next = { ...next, ...account };
      } catch {
        // The account is cosmetic; a failure here must not fail the connection.
      }
    }
  } catch (error) {
    next = { ...next, connected: false, lastError: String(error?.message || 'Connection failed.').slice(0, 400) };
    saveConfig(db, row, next);
    throw new AppError(502, 'MCP_CONNECT_FAILED', next.lastError, { expose: true });
  } finally {
    await client.close();
  }
  saveConfig(db, row, next);
  return { plugin: getPlugin(db, row.id), server: { name: next.serverName, version: next.serverVersion, toolCount: next.toolCount } };
}

async function accountFromClient(client) {
  const response = await client.callTool('get_me', {}, { timeoutMs: 20_000 });
  if (response?.isError === true) throw new Error('get_me failed');
  const text = textFromResult(response);
  const account = parseJsonText(text) || {};
  const login = safeString(account.login || account.user?.login);
  if (!login) throw new Error('The MCP server did not return a GitHub login.');
  return {
    ownerLogin: login,
    owner: login,
    account: safeString(account.name || account.user?.name) || login,
    avatarUrl: safeString(account.avatar_url || account.user?.avatar_url)
  };
}

function textFromResult(result) {
  const parts = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

// Live connection + tool discovery without touching the stored config.
export async function inspectPlugin(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  const server = resolveServer(config);
  return withClient(server, async (client) => {
    const tools = await client.listTools();
    return {
      connected: true,
      server: client.serverInfo,
      protocolVersion: client.protocolVersion,
      capabilities: client.capabilities,
      instructions: client.instructions,
      toolCount: tools.length,
      tools: tools.slice(0, MAX_STORED_TOOLS).map(storedTool).filter((tool) => tool.name)
    };
  });
}

export async function withClient(server, body) {
  const client = new McpClient(server);
  try {
    await client.connect({ timeoutMs: 20_000 });
    return await body(client);
  } finally {
    await client.close();
  }
}

// ---- GitHub account + repositories, through MCP tools ----

export async function pluginAccount(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  if (safeString(config.preset) !== 'github') throw validation('Only the GitHub plugin exposes a GitHub account.');
  const server = resolveServer(config);
  const account = await withClient(server, (client) => accountFromClient(client));
  saveConfig(db, row, { ...config, ...account, connected: true, connectedAt: now() });
  return account;
}

// Lists the signed-in user's repositories using the server's search_repositories tool.
export async function pluginRepositories(db, rawId, { query = '' } = {}) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  if (safeString(config.preset) !== 'github') throw validation('Only the GitHub plugin lists repositories.');
  const login = safeString(config.ownerLogin || config.owner);
  if (!login) throw new AppError(409, 'GITHUB_ACCOUNT_UNKNOWN', 'Resolve the GitHub account first (the "users" toolset must be enabled).', { expose: true });
  const server = resolveServer(config);
  const search = safeString(query) ? `${safeString(query)} user:${login}` : `user:${login}`;
  return withClient(server, async (client) => {
    const response = await client.callTool('search_repositories', { query: search, sort: 'updated', order: 'desc', per_page: 100 }, { timeoutMs: 30_000 });
    if (response?.isError === true) {
      throw new AppError(502, 'GITHUB_SEARCH_FAILED', textFromResult(response).slice(0, 300) || 'The repository search failed.', { expose: true });
    }
    const payload = parseJsonText(textFromResult(response)) || {};
    const items = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.repositories) ? payload.repositories : []);
    return items
      .map((repo) => {
        const fullName = safeString(repo.full_name || repo.fullName);
        const slash = fullName.indexOf('/');
        return {
          fullName,
          name: safeString(repo.name),
          owner: slash > 0 ? fullName.slice(0, slash) : '',
          private: Boolean(repo.private),
          defaultBranch: safeString(repo.default_branch || repo.defaultBranch) || 'main',
          updatedAt: safeString(repo.updated_at || repo.updatedAt),
          url: safeString(repo.html_url || repo.htmlUrl),
          description: safeString(repo.description),
          language: safeString(repo.language),
          stars: Number(repo.stars ?? repo.stargazers_count ?? 0) || 0
        };
      })
      .filter((repo) => repo.fullName);
  });
}

export function selectPluginRepo(db, rawId, { owner, repo, defaultBranch }) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  const ownerName = safeString(owner);
  const repoName = safeString(repo);
  if (!ownerName || !repoName) throw validation('Both an owner and a repository are required.');
  const next = {
    ...config,
    owner: ownerName,
    repo: repoName,
    selectedRepo: `${ownerName}/${repoName}`,
    defaultBranch: safeString(defaultBranch) || 'main',
    // A new repository invalidates any local clone and any pending write approval.
    cloned: false,
    writesApproved: false,
    pushApproved: false
  };
  saveConfig(db, row, next);
  return getPlugin(db, row.id);
}

// Approves the next batch of mutating MCP tool calls for this plugin.
export function approvePluginWrites(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  saveConfig(db, row, { ...config, writesApproved: true });
  return getPlugin(db, row.id);
}

// The plugin a chat request should use, or null when it is not usable for this message.
export function activeMcpPlugin(db, rawPluginId) {
  if (!rawPluginId) return null;
  const id = String(rawPluginId);
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!row || row.type !== 'mcp' || !Number(row.enabled)) return null;
  const config = safeConfig(row.config);
  if (config.connected !== true) return null;
  return { pluginId: id, config };
}

// Builds the runtime MCP context for one chat request: a live session, the tool definitions the
// model may call, and the write gate. The caller MUST call dispose() when the request ends.
export async function createMcpToolContext(db, pluginId) {
  const row = pluginRow(db, pluginId);
  const config = safeConfig(row.config);
  const server = resolveServer(config);
  const client = new McpClient(server);
  await client.connect({ timeoutMs: 20_000 });
  let tools;
  try {
    tools = await client.listTools();
  } catch (error) {
    await client.close();
    throw new AppError(502, 'MCP_TOOLS_FAILED', `Could not read the tools from the MCP server: ${error.message}`, { expose: true });
  }
  const github = config.github && typeof config.github === 'object' ? config.github : {};
  const toolset = buildMcpToolset(tools, { allowlist: stringList(config.toolAllowlist), readOnly: github.readOnly === true });
  return {
    pluginId,
    config,
    client,
    serverLabel: serverLabel(config),
    serverName: safeString(client.serverInfo?.name) || serverLabel(config),
    byName: toolset.byName,
    definitions: toolset.definitions,
    writesApproved: config.writesApproved === true,
    selectedRepo: safeString(config.selectedRepo),
    toolTimeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90_000,
    async dispose() {
      await client.close();
    }
  };
}

// Clears a one-shot write approval after the request that used it finishes.
export function clearWriteApproval(db, rawPluginId) {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(String(rawPluginId));
  if (!row) return;
  const config = safeConfig(row.config);
  if (config.writesApproved !== true) return;
  saveConfig(db, row, { ...config, writesApproved: false });
}

// ---- Optional local clone (advanced) ----
// When the GitHub preset has `localClone` on, the selected repository is also cloned into the
// local workspace so the model can do bulk file work with the github_* tools. This needs a
// personal access token; the MCP tools work without one (the server holds the credential).

function cloneParent(workspaceDirectory) {
  return resolve(workspaceDirectory, 'repos');
}

function withinParent(parent, target) {
  const resolvedParent = resolve(parent);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + sep);
}

function resolveRepo(config) {
  const repo = safeString(config.repo || config.selectedRepo);
  const slash = repo.indexOf('/');
  const owner = slash > 0 ? repo.slice(0, slash) : safeString(config.owner);
  const name = slash > 0 ? repo.slice(slash + 1) : safeString(config.repo);
  if (!owner || !name) throw validation('A repository must be selected first.');
  return { owner, repo: name };
}

function repoDirectory(workspaceDirectory, config) {
  const { owner, repo } = resolveRepo(config);
  const parent = cloneParent(workspaceDirectory);
  const dir = join(parent, `${owner}__${repo}`);
  if (!withinParent(parent, dir)) throw validation('Repository path is outside the workspace.');
  return dir;
}

function resolveRepoPath(root, relPath) {
  const safeRelative = safeString(relPath);
  if (!safeRelative) throw validation('A file path is required.');
  const target = resolve(root, safeRelative);
  if (!withinParent(root, target)) throw validation('Path is outside the repository.');
  return target;
}

function githubToken(config) {
  const github = config.github && typeof config.github === 'object' ? config.github : {};
  const token = safeString(github.token);
  if (!token) throw new AppError(409, 'GITHUB_TOKEN_REQUIRED', 'The local clone needs a GitHub personal access token in the plugin settings.', { expose: true });
  return token;
}

function cleanRepoUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

// Authenticated URL used for one git operation; the caller resets origin to the clean URL
// afterwards so the token is never persisted in .git/config.
function authenticatedRepoUrl(owner, repo, token) {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

async function git(args, cwd) {
  try {
    const result = await execFileP('git', args, { cwd, timeout: 60_000 });
    return { output: (result.stdout || '').trim() };
  } catch (error) {
    throw new AppError(500, 'GIT_ERROR', `git ${args.slice(0, 2).join(' ')} failed: ${(error.stderr || error.message).trim().slice(0, 300)}`, { expose: true });
  }
}

function localCloneConfig(db, rawId) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  const github = config.github && typeof config.github === 'object' ? config.github : {};
  if (github.localClone !== true) throw new AppError(409, 'LOCAL_CLONE_DISABLED', 'Enable "Local clone" on the plugin to use the workspace tools.', { expose: true });
  return { row, config };
}

export async function cloneGithubRepo(db, rawId, workspaceDirectory) {
  const { row, config } = localCloneConfig(db, rawId);
  const token = githubToken(config);
  const { owner, repo } = resolveRepo(config);
  const dir = repoDirectory(workspaceDirectory, config);
  if (existsSync(join(dir, '.git'))) {
    await git(['remote', 'set-url', 'origin', authenticatedRepoUrl(owner, repo, token)], dir);
    const output = await git(['fetch', '--prune', 'origin'], dir);
    await git(['remote', 'set-url', 'origin', cleanRepoUrl(owner, repo)], dir);
    saveConfig(db, row, { ...config, cloned: true });
    return { repository: `${owner}/${repo}`, directory: dir, cloned: false, status: 'updated', output: output.output };
  }
  const parent = cloneParent(workspaceDirectory);
  await git(['clone', '--depth', '1', authenticatedRepoUrl(owner, repo, token), dir], parent);
  await git(['remote', 'set-url', 'origin', cleanRepoUrl(owner, repo)], dir);
  saveConfig(db, row, { ...config, cloned: true });
  return { repository: `${owner}/${repo}`, directory: dir, cloned: true, status: 'cloned' };
}

export async function commitGithub(db, rawId, workspaceDirectory, { message }) {
  const { config } = localCloneConfig(db, rawId);
  const dir = repoDirectory(workspaceDirectory, config);
  if (!existsSync(join(dir, '.git'))) throw validation('The repository has not been cloned yet.');
  const commitMessage = safeString(message || 'Glow Agent update');
  await git(['add', '-A'], dir);
  const diff = await git(['status', '--short'], dir);
  if (!diff.output) return { committed: false, message: 'No changes to commit.', directory: dir };
  const commit = await git(['commit', '-m', commitMessage], dir);
  return { committed: true, message: commit.output, directory: dir };
}

export async function pushGithub(db, rawId, workspaceDirectory) {
  const { row, config } = localCloneConfig(db, rawId);
  const token = githubToken(config);
  const { owner, repo } = resolveRepo(config);
  const dir = repoDirectory(workspaceDirectory, config);
  if (config.writesApproved !== true) {
    throw new AppError(403, 'GITHUB_PUSH_REQUIRES_CONFIRMATION', 'Push requires your confirmation. Approve writes in the chat UI.', { expose: true });
  }
  if (!existsSync(join(dir, '.git'))) throw validation('The repository has not been cloned yet.');
  const branch = safeString(config.defaultBranch) || 'main';
  await git(['remote', 'set-url', 'origin', authenticatedRepoUrl(owner, repo, token)], dir);
  await git(['push', 'origin', `HEAD:${branch}`], dir);
  await git(['remote', 'set-url', 'origin', cleanRepoUrl(owner, repo)], dir);
  saveConfig(db, row, { ...config, writesApproved: false });
  return { pushed: true, repository: `${owner}/${repo}`, branch, directory: dir };
}

export function repoListFiles(db, rawId, workspaceDirectory, relPath = '') {
  const { config } = localCloneConfig(db, rawId);
  const root = repoDirectory(workspaceDirectory, config);
  if (!existsSync(root)) return { error: 'The repository has not been cloned yet.' };
  let base = root;
  if (safeString(relPath)) {
    try { base = resolveRepoPath(root, relPath); } catch (error) { return { error: error.message }; }
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
      .map((entry) => ({ path: relative(root, join(base, entry.name)), type: entry.isDirectory() ? 'directory' : 'file' }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
  };
}

export function repoReadFile(db, rawId, workspaceDirectory, relPath) {
  const { config } = localCloneConfig(db, rawId);
  const root = repoDirectory(workspaceDirectory, config);
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
  const { config } = localCloneConfig(db, rawId);
  const root = repoDirectory(workspaceDirectory, config);
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
  const { config } = localCloneConfig(db, rawId);
  const root = repoDirectory(workspaceDirectory, config);
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
  const { config } = localCloneConfig(db, rawId);
  const root = repoDirectory(workspaceDirectory, config);
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

export { GITHUB_DEFAULT_TOOLSETS, GITHUB_REMOTE_URL };
