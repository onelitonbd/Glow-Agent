import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../server/db/database.js';
import {
  activeMcpPlugins,
  approvePluginWrites,
  configurePlugin,
  connectPlugin,
  createMcpToolContext,
  createPlugin,
  deletePlugin,
  getPlugin,
  inspectPlugin,
  listPlugins,
  listPresets,
  repoListFiles,
  resolveServer,
  selectPluginRepo,
  updatePlugin
} from '../server/services/plugins.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

async function tempDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-plugins-'));
  return { db: createDatabase(join(directory, 'test.sqlite')), directory };
}

// The GitHub preset's local-binary mode is how the tests point a plugin at the fixture server:
// the preset runs the configured binary with `stdio` (plus flags the fixture ignores), so the
// fixture is launched exactly the way a real github-mcp-server binary would be.
function fixtureSettings() {
  return { mode: 'local-binary', binary: FIXTURE };
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

    configurePlugin(db, created.id, { preset: 'github', github: fixtureSettings() });
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
    assert.equal(plugin.config.hasToken, false);

    // Inspect performs a live handshake without changing what is stored.
    const inspected = await inspectPlugin(db, created.id);
    assert.equal(inspected.toolCount, 5);
    assert.equal(inspected.server.name, 'fixture-mcp');

    updatePlugin(db, created.id, { enabled: true });
    assert.deepEqual(activeMcpPlugins(db).map((entry) => entry.pluginId), [created.id]);
    updatePlugin(db, created.id, { enabled: false });
    assert.deepEqual(activeMcpPlugins(db), [], 'a disabled plugin never contributes tools');

    deletePlugin(db, created.id);
    assert.equal(listPlugins(db).length, 0);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('only the shipped MCP servers can be added, and no generic server can be smuggled in', async () => {
  const { db, directory } = await tempDatabase();
  try {
    // The catalog is what the Plugins page renders: today that is GitHub alone.
    assert.deepEqual(listPresets().map((preset) => preset.id), ['github']);
    assert.equal(listPresets()[0].accountAware, true);

    assert.throws(() => createPlugin(db, { type: 'mcp', preset: 'custom', name: 'Anything' }), (error) => {
      assert.match(error.message, /Unknown MCP server/u);
      return true;
    });

    const created = createPlugin(db, { type: 'mcp', preset: 'github', name: 'GitHub' });
    assert.throws(() => configurePlugin(db, created.id, { preset: 'custom', url: 'https://evil.example/mcp/' }), (error) => {
      assert.match(error.message, /Unknown MCP server/u);
      return true;
    });

    // A client posting the old free-form fields cannot change where the plugin points: only the
    // preset's own settings keys are read, so the resolved server stays GitHub's.
    configurePlugin(db, created.id, {
      preset: 'github',
      url: 'https://evil.example/mcp/',
      command: 'evil',
      args: ['--steal'],
      headers: { Authorization: 'Bearer nope' },
      env: { TOKEN: 'nope' },
      github: { mode: 'remote', token: 'ghp_secret' }
    });
    // resolveServer needs the real stored config, which keeps the token the API never returns.
    const stored = JSON.parse(db.prepare('SELECT config FROM plugins WHERE id = ?').get(created.id).config);
    const server = resolveServer(stored);
    assert.equal(server.transport, 'http');
    assert.equal(server.url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(server.headers.Authorization, 'Bearer ghp_secret');
    assert.equal(stored.url, undefined, 'the posted url is not stored');
    assert.equal(stored.command, undefined, 'the posted command is not stored');
    assert.equal(stored.args, undefined);
    assert.equal(stored.headers, undefined);
    assert.equal(stored.env, undefined);
    assert.equal(getPlugin(db, created.id).config.hasToken, true);
    // The token is never echoed back, and no free-form command or url is shown either.
    assert.equal(JSON.stringify(getPlugin(db, created.id)).includes('ghp_secret'), false);
    assert.equal(getPlugin(db, created.id).config.url, undefined);
    assert.equal(getPlugin(db, created.id).config.command, undefined);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a server that cannot start records the failure instead of marking the plugin connected', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'github', name: 'Broken' });
    configurePlugin(db, created.id, { preset: 'github', github: { mode: 'local-binary', binary: 'definitely-not-installed-glow-agent' } });
    await assert.rejects(() => connectPlugin(db, created.id), (error) => {
      assert.equal(error.code, 'MCP_CONNECT_FAILED');
      return true;
    });
    const plugin = getPlugin(db, created.id);
    assert.equal(plugin.config.connected, false);
    assert.match(plugin.config.lastError, /not found|Could not start/u);
    updatePlugin(db, created.id, { enabled: true });
    assert.deepEqual(activeMcpPlugins(db), [], 'a plugin whose server never answered contributes no tools');
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the GitHub preset expands to the documented remote and local MCP server definitions', () => {
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

  const binary = resolveServer({ preset: 'github', github: { mode: 'local-binary', binary: FIXTURE } });
  assert.equal(binary.transport, 'stdio');
  assert.equal(binary.command, FIXTURE);
  assert.equal(binary.args[0], 'stdio');
  assert.equal(binary.args.includes('--toolsets'), true);

  const enterprise = resolveServer({ preset: 'github', github: { mode: 'remote', host: 'octocorp.ghe.com' } });
  assert.equal(enterprise.url, 'https://copilot-api.octocorp.ghe.com/mcp/');
});

test('the chat request exposes the server tools and gates writes until the user approves', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'github', name: 'GitHub' });
    configurePlugin(db, created.id, { preset: 'github', github: fixtureSettings() });
    await connectPlugin(db, created.id);
    updatePlugin(db, created.id, { enabled: true });

    const context = await createMcpToolContext(db, created.id);
    try {
      assert.equal(context.definitions.length, 5);
      assert.equal(context.byName.has('mcp_github_read_thing'), true);
      assert.equal(context.writesApproved, false);
      // Each tool entry carries its own session and approval, which is what lets several
      // servers share one merged tool map.
      assert.equal(context.byName.get('mcp_github_read_thing').client, context.client);
      assert.equal(context.byName.get('mcp_github_read_thing').writesApproved, false);
      assert.equal(context.byName.get('mcp_github_write_thing').mutating, true);

      const read = await context.client.callTool('read_thing', { id: 'z' });
      assert.equal(JSON.parse(read.content[0].text).args.id, 'z');
    } finally {
      await context.dispose();
    }

    // The approval is one-shot: it is set for the next message and cleared when that ends. The
    // flag is reported to the UI so the user can see whether the next message can write.
    assert.equal(getPlugin(db, created.id).config.writesApproved, false);
    approvePluginWrites(db, created.id);
    const approved = await createMcpToolContext(db, created.id);
    assert.equal(approved.writesApproved, true);
    assert.equal(approved.byName.get('mcp_github_write_thing').writesApproved, true);
    await approved.dispose();
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Two installed servers of the same preset must not overwrite each other's tools.
test('two plugins of the same preset each keep their own namespaced tools', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const first = createPlugin(db, { type: 'mcp', preset: 'github', name: 'GitHub work' });
    const second = createPlugin(db, { type: 'mcp', preset: 'github', name: 'GitHub personal' });
    for (const plugin of [first, second]) {
      configurePlugin(db, plugin.id, { preset: 'github', github: fixtureSettings() });
      await connectPlugin(db, plugin.id);
      updatePlugin(db, plugin.id, { enabled: true });
    }
    assert.deepEqual(activeMcpPlugins(db).map((entry) => entry.key), ['github', 'github']);

    const one = await createMcpToolContext(db, first.id, { serverKey: 'github-1' });
    const two = await createMcpToolContext(db, second.id, { serverKey: 'github-2' });
    try {
      assert.equal(one.byName.has('mcp_github-1_read_thing'), true);
      assert.equal(two.byName.has('mcp_github-2_read_thing'), true);
      const merged = new Map([...one.byName, ...two.byName]);
      assert.equal(merged.size, 10, 'both servers contribute all five tools');
      assert.notEqual(one.byName.get('mcp_github-1_read_thing').client, two.byName.get('mcp_github-2_read_thing').client);
    } finally {
      await one.dispose();
      await two.dispose();
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('read-only plugins never expose mutating tools to the model', async () => {
  const { db, directory } = await tempDatabase();
  try {
    const created = createPlugin(db, { type: 'mcp', preset: 'github', name: 'Read only' });
    configurePlugin(db, created.id, { preset: 'github', github: { ...fixtureSettings(), readOnly: true } });
    await connectPlugin(db, created.id);
    updatePlugin(db, created.id, { enabled: true });
    const context = await createMcpToolContext(db, created.id);
    try {
      // write_thing (readOnlyHint false) and delete_thing (mutating name) are withheld; explode
      // declares readOnlyHint true, so read-only mode correctly keeps it.
      assert.deepEqual(context.definitions.map((tool) => tool.id), ['mcp_github_read_thing', 'mcp_github_describe_server', 'mcp_github_explode']);
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

// Migration v7 rewrites plugins that predate the curated catalog.
test('legacy OAuth and custom-server plugin rows become a configured GitHub MCP plugin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'glow-agent-plugins-'));
  const databasePath = join(directory, 'test.sqlite');
  try {
    const seeded = createDatabase(databasePath);
    // Roll the schema back to v6 and put the two legacy shapes in it: the original GitHub OAuth
    // plugin, and the first-cut MCP plugin that could point at any server.
    const stamp = new Date().toISOString();
    seeded.prepare('INSERT INTO plugins (id, type, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-oauth', 'github', 'GitHub', JSON.stringify({ token: 'gho_oauth', ownerLogin: 'octocat' }), 1, stamp, stamp);
    seeded.prepare('INSERT INTO plugins (id, type, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-custom', 'mcp', 'Anything', JSON.stringify({ preset: 'custom', url: 'https://example.test/mcp/', headers: { Authorization: 'Bearer x' } }), 1, stamp, stamp);
    seeded.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    seeded.close();

    // Reopening runs the pending migration, exactly as a real upgrade would.
    const db = createDatabase(databasePath);
    try {
      assert.deepEqual(db.prepare('SELECT version FROM schema_migrations WHERE version = 7').all().length, 1);
      for (const id of ['legacy-oauth', 'legacy-custom']) {
        const plugin = getPlugin(db, id);
        assert.equal(plugin.type, 'mcp');
        assert.equal(plugin.config.preset, 'github');
        assert.equal(plugin.config.mode, 'remote');
        assert.deepEqual(plugin.config.toolsets, ['repos', 'users', 'issues', 'pull_requests', 'context']);
        // The old credential is dropped: an OAuth token cannot authenticate the MCP endpoint, and
        // a custom server's headers have no meaning for a preset.
        assert.equal(plugin.config.hasToken, false);
        assert.equal(plugin.config.connected, false);
        assert.equal(JSON.stringify(plugin).includes('gho_oauth'), false);
        assert.equal(JSON.stringify(plugin).includes('example.test'), false);
        // And the migrated row can still be resolved into a real server definition.
        const stored = JSON.parse(db.prepare('SELECT config FROM plugins WHERE id = ?').get(id).config);
        assert.equal(resolveServer(stored).url, 'https://api.githubcopilot.com/mcp/');
      }
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
