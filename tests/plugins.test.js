import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../server/db/database.js';
import {
  activeMcpPlugin,
  approvePluginWrites,
  configurePlugin,
  connectPlugin,
  createMcpToolContext,
  createPlugin,
  deletePlugin,
  getPlugin,
  inspectPlugin,
  listPlugins,
  repoListFiles,
  selectPluginRepo,
  updatePlugin
} from '../server/services/plugins.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

async function tempDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-plugins-'));
  return { db: createDatabase(join(directory, 'test.sqlite')), directory };
}

// Points a plugin at the local fixture MCP server over stdio.
function fixtureConfig() {
  return { preset: 'custom', transport: 'stdio', command: process.execPath, args: ['--no-warnings', FIXTURE] };
}

test('MCP plugins are created, configured, connected, and discovered without leaking secrets', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'github', name: 'GitHub' });
    assert.equal(created.type, 'mcp');
    assert.equal(created.config.preset, 'github');
    assert.equal(created.config.connected, false);
    assert.deepEqual(created.config.toolsets, ['repos', 'users', 'issues', 'pull_requests', 'context']);
    assert.equal(listPlugins(db).length, 1);

    configurePlugin(db, created.id, fixtureConfig());
    const connected = await connectPlugin(db, created.id);
    assert.equal(connected.server.name, 'fixture-mcp');
    assert.equal(connected.server.toolCount, 5);

    const plugin = getPlugin(db, created.id);
    assert.equal(plugin.config.connected, true);
    assert.equal(plugin.config.serverName, 'fixture-mcp');
    assert.equal(plugin.config.toolCount, 5);
    assert.deepEqual(plugin.config.tools.map((tool) => tool.name), ['read_thing', 'write_thing', 'delete_thing', 'describe_server', 'explode']);
    // The flag the UI shows must match what the write gate enforces: write_thing by annotation,
    // delete_thing by the name heuristic (the fixture publishes no annotations for it).
    const flagged = Object.fromEntries(plugin.config.tools.map((tool) => [tool.name, tool.mutating]));
    assert.deepEqual(flagged, { read_thing: false, write_thing: true, delete_thing: true, describe_server: false, explode: false });
    assert.equal(plugin.config.lastError, '');
    // The stored blob holds the command, but nothing secret is echoed back to the browser.
    assert.equal(JSON.stringify(plugin).includes(FIXTURE), true);
    assert.equal(plugin.config.hasToken, false);

    // Inspect performs a live handshake without changing what is stored.
    const inspected = await inspectPlugin(db, created.id);
    assert.equal(inspected.toolCount, 5);
    assert.equal(inspected.server.name, 'fixture-mcp');

    updatePlugin(db, created.id, { enabled: true });
    assert.equal(activeMcpPlugin(db, created.id).pluginId, created.id);
    updatePlugin(db, created.id, { enabled: false });
    assert.equal(activeMcpPlugin(db, created.id), null, 'a disabled plugin is never used for a message');

    deletePlugin(db, created.id);
    assert.equal(listPlugins(db).length, 0);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a server that cannot start records the failure instead of marking the plugin connected', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'custom', name: 'Broken' });
    configurePlugin(db, created.id, { preset: 'custom', transport: 'stdio', command: 'definitely-not-installed-glow-agent', args: [] });
    await assert.rejects(() => connectPlugin(db, created.id), (error) => {
      assert.equal(error.code, 'MCP_CONNECT_FAILED');
      return true;
    });
    const plugin = getPlugin(db, created.id);
    assert.equal(plugin.config.connected, false);
    assert.match(plugin.config.lastError, /not found|Could not start/u);
    assert.equal(activeMcpPlugin(db, created.id), null);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the GitHub preset expands to the documented remote and local MCP server definitions', async () => {
  const { resolveServer } = await import('../server/services/plugins.js');
  const remote = resolveServer({ preset: 'github', github: { mode: 'remote', token: 'ghp_secret', toolsets: ['repos', 'issues'], readOnly: true } });
  assert.equal(remote.transport, 'http');
  assert.equal(remote.url, 'https://api.githubcopilot.com/mcp/');
  assert.equal(remote.headers.Authorization, 'Bearer ghp_secret');
  assert.equal(remote.headers['X-MCP-Toolsets'], 'repos,issues');
  assert.equal(remote.headers['X-MCP-Readonly'], 'true');

  const docker = resolveServer({ preset: 'github', github: { mode: 'local-docker', token: 'ghp_secret', toolsets: ['repos'] } });
  assert.equal(docker.transport, 'stdio');
  assert.equal(docker.command, 'docker');
  assert.deepEqual(docker.args, ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server', '--toolsets', 'repos']);
  assert.equal(docker.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_secret');

  const enterprise = resolveServer({ preset: 'github', github: { mode: 'remote', host: 'octocorp.ghe.com' } });
  assert.equal(enterprise.url, 'https://copilot-api.octocorp.ghe.com/mcp/');
});

test('the chat request exposes the server tools and gates writes until the user approves', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'custom', name: 'GitHub' });
    configurePlugin(db, created.id, fixtureConfig());
    await connectPlugin(db, created.id);
    updatePlugin(db, created.id, { enabled: true });

    const context = await createMcpToolContext(db, created.id);
    try {
      assert.equal(context.definitions.length, 5);
      assert.equal(context.byName.has('mcp_read_thing'), true);
      assert.equal(context.writesApproved, false);

      const read = await context.client.callTool('read_thing', { id: 'z' });
      assert.equal(JSON.parse(read.content[0].text).args.id, 'z');
    } finally {
      await context.dispose();
    }

    // The approval is one-shot: it is set for the next message and cleared when that ends.
    assert.equal(getPlugin(db, created.id).config.writesApproved, undefined);
    approvePluginWrites(db, created.id);
    const approved = await createMcpToolContext(db, created.id);
    assert.equal(approved.writesApproved, true);
    await approved.dispose();
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('read-only plugins never expose mutating tools to the model', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'custom', name: 'Read only' });
    configurePlugin(db, created.id, { ...fixtureConfig(), github: { readOnly: true } });
    await connectPlugin(db, created.id);
    updatePlugin(db, created.id, { enabled: true });
    const context = await createMcpToolContext(db, created.id);
    try {
      // write_thing (readOnlyHint false) and delete_thing (mutating name) are withheld; explode
      // declares readOnlyHint true, so read-only mode correctly keeps it.
      assert.deepEqual(context.definitions.map((tool) => tool.id), ['mcp_read_thing', 'mcp_describe_server', 'mcp_explode']);
    } finally {
      await context.dispose();
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the optional local clone stays off until the plugin enables it', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'github', name: 'GitHub' });
    selectPluginRepo(db, created.id, { owner: 'acme', repo: 'widgets', defaultBranch: 'main' });
    assert.equal(getPlugin(db, created.id).config.selectedRepo, 'acme/widgets');
    assert.throws(() => repoListFiles(db, created.id, directory, ''), (error) => {
      assert.equal(error.code, 'LOCAL_CLONE_DISABLED');
      return true;
    });

    configurePlugin(db, created.id, { preset: 'github', github: { localClone: true, token: 'ghp_secret' } });
    selectPluginRepo(db, created.id, { owner: 'acme', repo: 'widgets', defaultBranch: 'main' });
    // Not cloned yet, so the workspace read reports that instead of inventing files.
    assert.equal(repoListFiles(db, created.id, directory, '').error, 'The repository has not been cloned yet.');
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
