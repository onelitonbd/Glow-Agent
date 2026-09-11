import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { notFound, validation, AppError } from '../lib/errors.js';
import { requiredString } from '../lib/validate.js';
import { now } from '../db/database.js';
import { McpClient } from './mcp.js';
import { buildMcpToolset, isMutatingTool } from './mcp-tools.js';
import { resolveSafePath } from './file-guard.js';

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
// A plugin row stores the preset id plus that preset's settings in a JSON config blob. Secrets
// (the GitHub token) are never returned to the browser, and there is no generic URL/command to
// expose because a plugin can only ever be one of the shipped presets.
function safePlugin(row) {
  const config = safeConfig(row.config);
  const presetId = safeString(config.preset).toLowerCase();
  const preset = Object.hasOwn(MCP_PRESETS, presetId) ? MCP_PRESETS[presetId] : null;
  const settings = preset ? preset.settings(config[presetId]) : {};
  const { token, ...visibleSettings } = settings;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: {
      preset: presetId,
      presetName: preset ? preset.name : presetId,
      accountAware: preset?.accountAware === true,
      ...visibleSettings,
      hasToken: Boolean(safeString(token)),
      toolAllowlist: stringList(config.toolAllowlist),
      writesApproved: config.writesApproved === true,
      connected: config.connected === true,
      serverName: safeString(config.serverName),
      serverVersion: safeString(config.serverVersion),
      serverInstructions: safeString(config.serverInstructions),
      toolCount: Number(config.toolCount) || 0,
      tools: Array.isArray(config.tools) ? config.tools.slice(0, MAX_STORED_TOOLS) : [],
      connectedAt: safeString(config.connectedAt),
      lastError: safeString(config.lastError),
      selectedRepo: safeString(config.selectedRepo),
      defaultBranch: safeString(config.defaultBranch),
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

// The catalog of MCP servers Glow Agent ships. Only servers listed here can be added: the UI
// renders this list and the service refuses anything else, so there is no "bring your own
// server" form. Adding a server later means adding one entry here.
//
// The remote GitHub server is hosted by GitHub; the local server runs the official image or
// binary and speaks MCP over stdio. Toolsets are selected with the X-MCP-Toolsets header
// (remote) or the --toolsets flag (local); read-only mode uses X-MCP-Readonly / --read-only.
const MCP_PRESETS = Object.freeze({
  github: Object.freeze({
    id: 'github',
    name: 'GitHub',
    description: 'Read and change repositories, issues, and pull requests through GitHub\u2019s official MCP server.',
    accountAware: true,
    defaultToolsets: [...GITHUB_DEFAULT_TOOLSETS],
    // The setup form for this server, and the authoritative list of settings it accepts. The
    // Plugins page renders these fields and the service ignores any key that is not declared
    // here, so there is no shared or generic form to fill in.
    // One question. The rest still works, but sits behind an Advanced disclosure: someone
    // connecting their own account should paste a token and be done.
    setup: [
      {
        key: 'token',
        label: 'GitHub personal access token',
        type: 'password',
        placeholder: 'ghp_… or github_pat_…',
        hint: 'A classic token (ghp_…) with the repo, read:org, and read:user scopes. Everything else here is chosen for you. The token is stored on this device and never shown again.',
        secret: true,
        // Opens GitHub's token form with these three scopes already ticked, so the user does not
        // have to work out what to select. read:user is what resolves the account, repo is what
        // reaches private repositories, read:org covers organization membership.
        link: {
          href: 'https://github.com/settings/tokens/new?description=Glow%20Agent&scopes=repo,read:org,read:user',
          label: 'Create a token on GitHub'
        }
      },
      {
        key: 'mode',
        label: 'How to run it',
        type: 'select',
        advanced: true,
        options: [
          { value: 'remote', label: 'Remote — hosted by GitHub (nothing to install)', hint: 'GitHub hosts the server at https://api.githubcopilot.com/mcp/. Nothing to install; the token is sent as a bearer header.' },
          { value: 'local-docker', label: 'Local — official Docker image', hint: 'Runs ghcr.io/github/github-mcp-server in Docker over stdio. Leave the token empty to use the image\u2019s own browser sign-in.' },
          { value: 'local-binary', label: 'Local — native binary', hint: 'Runs a github-mcp-server binary on this machine with the stdio argument.' }
        ]
      },
      {
        key: 'toolsets',
        label: 'Toolsets',
        type: 'list',
        advanced: true,
        // The form starts with the curated default filled in, so a new plugin never silently asks
        // the server for every toolset it has.
        default: [...GITHUB_DEFAULT_TOOLSETS],
        placeholder: 'repos,users,issues,pull_requests,context',
        hint: 'Comma-separated. repos and users are needed for the account and repository list. Fewer toolsets means a smaller tool list for the model.'
      },
      { key: 'binary', label: 'Binary path', type: 'text', placeholder: 'github-mcp-server', advanced: true, showWhen: { mode: ['local-binary'] } },
      { key: 'host', label: 'GitHub Enterprise host', type: 'text', placeholder: 'octocorp.ghe.com', advanced: true },
      { key: 'readOnly', label: 'Read-only — hide every tool that changes data', type: 'check', advanced: true },
      { key: 'localClone', label: 'Also keep a local clone for bulk file work (needs a token)', type: 'check', advanced: true }
    ],
    settings: (github = {}) => ({
      mode: safeString(github.mode) || 'remote',
      toolsets: Array.isArray(github.toolsets) ? stringList(github.toolsets) : [...GITHUB_DEFAULT_TOOLSETS],
      readOnly: github.readOnly === true,
      localClone: github.localClone === true,
      host: safeString(github.host),
      binary: safeString(github.binary),
      token: safeString(github.token)
    }),
    // Turns the stored settings into concrete MCP transport options.
    build(github = {}, timeoutMs) {
      const token = safeString(github.token);
      const toolsets = stringList(github.toolsets);
      const readOnly = github.readOnly === true;
      const host = safeString(github.host);
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
  }),

  // The reference servers maintained by the MCP steering group. They need no credential and no
  // configuration, so adding one is a single tap.
  memory: Object.freeze({
    id: 'memory',
    name: 'Memory',
    description: 'A persistent knowledge graph the assistant can store entities, observations, and relations in, so facts survive across conversations.',
    setup: [
      {
        key: 'memoryFile',
        label: 'Memory file path',
        type: 'text',
        placeholder: 'leave empty for the server default',
        hint: 'A JSONL file the server reads and writes. Leave it empty to use the server\u2019s own default location.'
      }
    ],
    settings: (memory = {}) => ({ memoryFile: safeString(memory.memoryFile) }),
    build(memory = {}, timeoutMs) {
      const memoryFile = safeString(memory.memoryFile);
      return npxServer('@modelcontextprotocol/server-memory', {
        env: memoryFile ? { MEMORY_FILE_PATH: memoryFile } : {},
        timeoutMs
      });
    }
  }),

  'sequential-thinking': Object.freeze({
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'A structured scratchpad for step-by-step reasoning: the assistant records each thought, revises it, and branches when a plan fails.',
    setup: [],
    settings: () => ({}),
    build: (_settings, timeoutMs) => npxServer('@modelcontextprotocol/server-sequential-thinking', { timeoutMs })
  }),

  filesystem: Object.freeze({
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Reads, searches, and edits files in one folder you choose, so the assistant can work on a project that lives outside this workspace.',
    setup: [
      {
        key: 'directory',
        label: 'Folder to share',
        type: 'text',
        placeholder: '/home/you/projects',
        hint: 'The assistant can read and change files inside this folder and nowhere else. The server refuses anything outside it.'
      }
    ],
    settings: (filesystem = {}) => ({ directory: safeString(filesystem.directory) }),
    build(filesystem = {}, timeoutMs) {
      const directory = safeString(filesystem.directory);
      if (!directory) throw validation('Choose the folder this server may access.');
      return npxServer('@modelcontextprotocol/server-filesystem', { extraArgs: [directory], timeoutMs });
    }
  })
});

// The official reference servers ship on npm, so they run through npx with a pinned package. The
// user never types a command or a package name: each preset states its own, and nothing else.
function npxServer(packageName, { extraArgs = [], env = {}, timeoutMs } = {}) {
  return { transport: 'stdio', command: 'npx', args: ['-y', packageName, ...extraArgs], env, fetchTimeoutMs: timeoutMs };
}

// Metadata the Plugins page renders. Secrets are never part of a preset definition.
export function listPresets() {
  return Object.values(MCP_PRESETS).map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    accountAware: preset.accountAware === true,
    ...(preset.defaultToolsets ? { defaultToolsets: [...preset.defaultToolsets] } : {}),
    setup: preset.setup.map(({ key, label, type, placeholder, hint, options, showWhen, secret, advanced, link, default: fallback }) => ({
      key, label, type,
      ...(advanced ? { advanced: true } : {}),
      ...(link ? { link } : {}),
      ...(fallback ? { default: [...fallback] } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(hint ? { hint } : {}),
      ...(options ? { options } : {}),
      ...(showWhen ? { showWhen } : {}),
      // A secret field is rendered as a password and its stored value is never sent back.
      ...(secret ? { secret: true } : {})
    }))
  }));
}

function presetFor(config = {}) {
  const id = safeString(config.preset).toLowerCase();
  const preset = Object.hasOwn(MCP_PRESETS, id) ? MCP_PRESETS[id] : null;
  if (!preset) {
    throw validation(`Unknown MCP server "${id || 'none'}". Only the servers offered on the Plugins page are supported.`);
  }
  return preset;
}

// Expands the stored settings for a plugin into real MCP transport options.
export function resolveServer(config = {}) {
  const preset = presetFor(config);
  const settings = config[preset.id] && typeof config[preset.id] === 'object' ? config[preset.id] : {};
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90_000;
  const server = preset.build(preset.settings(settings), timeoutMs);
  if (server.transport === 'http' && !safeString(server.url)) throw validation('This MCP server has no URL configured.');
  if (server.transport === 'stdio' && !safeString(server.command)) throw validation('This MCP server has no command configured.');
  return server;
}

function serverLabel(config) {
  return safeString(config.preset).toLowerCase() || 'mcp';
}

export function listPlugins(db) {
  return db.prepare('SELECT * FROM plugins ORDER BY created_at ASC').all().map(safePlugin);
}

export function getPlugin(db, rawId) {
  return safePlugin(pluginRow(db, rawId));
}

export function createPlugin(db, body = {}) {
  const type = requiredString(body.type, 'Plugin type', { max: 40 }).toLowerCase();
  if (type !== 'mcp') throw validation('Plugins are MCP servers.');
  const requested = safeString(body.preset).toLowerCase();
  const preset = requested ? presetFor({ preset: requested }) : MCP_PRESETS.github;
  const name = requiredString(body.name || preset.name, 'Plugin name', { max: 80 });
  const id = randomUUID();
  const timestamp = now();
  const config = { preset: preset.id, [preset.id]: preset.settings({}) };
  db.prepare('INSERT INTO plugins (id, type, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, type, name, JSON.stringify(config), 0, timestamp, timestamp);
  return getPlugin(db, id);
}

// Applies the user's settings for this preset. Secrets are only replaced when a new value is
// sent, so re-saving a plugin never wipes an existing token. There is deliberately no way to
// point a plugin at an arbitrary URL or command: only the shipped presets can be configured.
export function configurePlugin(db, rawId, body = {}) {
  const row = pluginRow(db, rawId);
  const config = safeConfig(row.config);
  const preset = presetFor({ preset: safeString(body.preset).toLowerCase() || safeString(config.preset) || 'github' });
  const previous = config[preset.id] && typeof config[preset.id] === 'object' ? config[preset.id] : {};
  const incoming = body[preset.id] && typeof body[preset.id] === 'object' ? body[preset.id] : {};
  // Start from what is stored, then overlay only the keys the client actually sent.
  const fields = new Map(preset.setup.map((field) => [field.key, field]));
  const merged = { ...preset.settings(previous) };
  for (const [key, value] of Object.entries(incoming)) {
    const field = fields.get(key);
    // Keys this server does not declare are dropped, so a client cannot add settings of its own.
    if (!field || value === undefined) continue;
    if (field.type === 'check') merged[key] = value === true;
    else if (field.type === 'list') {
      // An emptied list means "leave it alone", so a blank field can never drop the default.
      const list = Array.isArray(value) ? stringList(value) : [];
      if (list.length > 0) merged[key] = list;
    }
    else if (typeof value === 'string' || typeof value === 'number') merged[key] = safeString(value);
  }
  const next = { ...config, preset: preset.id, [preset.id]: merged };
  const server = resolveServer(next);

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
    const accountAware = MCP_PRESETS[safeString(config.preset).toLowerCase()]?.accountAware === true;
    if (accountAware && storedTools.some((tool) => tool.name === 'get_me')) {
      try {
        const account = await accountFromClient(client);
        next = { ...next, ...account };
        // Pick the most recently updated repository as well, so the assistant can start working
        // without a second round of setup. A user can still choose a different one.
        if (!safeString(next.selectedRepo) && storedTools.some((tool) => tool.name === 'search_repositories')) {
          const chosen = await autoSelectRepository(client, account.ownerLogin);
          if (chosen) next = { ...next, ...chosen };
        }
      } catch {
        // The account and repository are conveniences; a failure here must not fail the connection.
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

// The repository the assistant should work on by default: the one the account touched last.
async function autoSelectRepository(client, login) {
  if (!safeString(login)) return null;
  const response = await client.callTool('search_repositories', { query: `user:${safeString(login)}`, sort: 'updated', order: 'desc', per_page: 1 }, { timeoutMs: 20_000 });
  if (response?.isError === true) return null;
  const payload = parseJsonText(textFromResult(response)) || {};
  const items = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.repositories) ? payload.repositories : []);
  const fullName = safeString(items[0]?.full_name || items[0]?.fullName);
  const slash = fullName.indexOf('/');
  if (slash <= 0) return null;
  return {
    owner: fullName.slice(0, slash),
    repo: fullName.slice(slash + 1),
    selectedRepo: fullName,
    defaultBranch: safeString(items[0].default_branch || items[0].defaultBranch) || 'main'
  };
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

// Every enabled plugin whose server answered the handshake takes part in a message, so adding a
// second MCP server gives the model that server's tools alongside the first one's. The enable
// switch in the chat picker is the only control; the client does not have to name a plugin.
export function activeMcpPlugins(db) {
  return db.prepare("SELECT * FROM plugins WHERE type = 'mcp' AND enabled = 1 ORDER BY created_at ASC").all()
    .map((row) => {
      const config = safeConfig(row.config);
      const presetId = safeString(config.preset).toLowerCase();
      return { pluginId: row.id, config, name: row.name, key: presetId || 'mcp' };
    })
    .filter((entry) => entry.config.connected === true);
}

// Builds the runtime MCP context for one chat request: a live session, the tool definitions the
// model may call, and the write gate. The caller MUST call dispose() when the request ends.
// `serverKey` namespaces this server's tool ids (mcp_<key>_<tool>). Callers that connect several
// plugins at once pass a unique key per plugin so two plugins of the same preset — say GitHub
// twice for two accounts — cannot overwrite each other's tools in the merged tool map.
export async function createMcpToolContext(db, pluginId, { serverKey } = {}) {
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
  const settings = presetFor(config).settings(config[safeString(config.preset).toLowerCase()]);
  const label = serverLabel(config);
  const key = safeString(serverKey) || label;
  const toolset = buildMcpToolset(tools, {
    serverKey: key,
    allowlist: stringList(config.toolAllowlist),
    readOnly: settings.readOnly === true
  });
  const writesApproved = config.writesApproved === true;
  const toolTimeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90_000;
  // Each entry keeps its own session, approval, and label, so one merged map can serve tools
  // from several servers without them interfering with each other.
  for (const entry of toolset.byName.values()) {
    entry.client = client;
    entry.writesApproved = writesApproved;
    entry.toolTimeoutMs = toolTimeoutMs;
    entry.serverLabel = label;
    entry.serverKey = key;
    entry.pluginId = pluginId;
  }
  return {
    pluginId,
    name: row.name,
    config,
    client,
    serverLabel: label,
    serverKey: key,
    serverName: safeString(client.serverInfo?.name) || label,
    serverInstructions: safeString(client.instructions),
    byName: toolset.byName,
    definitions: toolset.definitions,
    writesApproved,
    readOnly: settings.readOnly === true,
    selectedRepo: safeString(config.selectedRepo),
    toolTimeoutMs,
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

// Repository file tools share the workspace guard: symlinks inside a clone cannot escape it,
// and .git metadata (which also stores credentials-adjacent config) is never touchable.
function resolveRepoPath(root, relPath) {
  const safeRelative = safeString(relPath);
  if (!safeRelative) throw validation('A file path is required.');
  try {
    return resolveSafePath(root, safeRelative);
  } catch (error) {
    throw validation(error.message === 'Path is outside the workspace.' ? 'Path is outside the repository.' : error.message);
  }
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
