import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabase } from '../server/db/database.js';
import {
  createPlugin,
  deletePlugin,
  getPlugin,
  listPlugins,
  repoDeleteFile,
  repoListFiles,
  repoReadFile,
  repoRenameFile,
  repoWriteFile,
  selectGithubRepo,
  updatePlugin
} from '../server/services/plugins.js';
import { executeGithubTool } from '../server/services/github-tools.js';

function seedToken(db, pluginId, owner = 'alice') {
  const row = db.prepare('SELECT config FROM plugins WHERE id = ?').get(pluginId);
  const config = JSON.parse(row.config);
  config.access_token = 'test-token';
  config.owner = owner;
  config.ownerLogin = owner;
  db.prepare('UPDATE plugins SET config = ? WHERE id = ?').run(JSON.stringify(config), pluginId);
}

test('plugin CRUD exposes safe GitHub state and respects enabled toggling', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-plugin-'));
  const db = createDatabase(join(tempDirectory, 'plugins.sqlite'));
  try {
    assert.deepEqual(listPlugins(db), []);

    const created = createPlugin(db, { type: 'github', name: 'GitHub' });
    assert.equal(created.type, 'github');
    assert.equal(created.enabled, false);
    assert.equal(created.config.hasToken, false);

    seedToken(db, created.id);
    const connected = getPlugin(db, created.id);
    assert.equal(connected.config.hasToken, true);
    assert.equal(connected.config.account, null);
    assert.equal(JSON.stringify(connected).includes('test-token'), false);

    const enabled = updatePlugin(db, created.id, { enabled: true });
    assert.equal(enabled.enabled, true);
    assert.equal(getPlugin(db, created.id).enabled, true);

    // Selecting a repo stores the chosen repo and clears the "cloned" flag so it re-clones.
    const updated = selectGithubRepo(db, created.id, { owner: 'alice', repo: 'demo', defaultBranch: 'main' });
    assert.equal(updated.config.selectedRepo, 'alice/demo');

    deletePlugin(db, created.id);
    assert.throws(() => getPlugin(db, created.id), /Plugin/u);
    assert.deepEqual(listPlugins(db), []);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('repository file operations are scoped to the cloned repo', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-plugin-'));
  const db = createDatabase(join(tempDirectory, 'plugins.sqlite'));
  const workspace = join(tempDirectory, 'workspace');
  try {
    const created = createPlugin(db, { type: 'github', name: 'GitHub' });
    seedToken(db, created.id);
    selectGithubRepo(db, created.id, { owner: 'alice', repo: 'demo', defaultBranch: 'main' });

    const repoDir = join(workspace, 'repos', 'alice__demo');
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(join(repoDir, 'src', 'index.js'), 'export const x = 1;\n');
    await writeFile(join(repoDir, 'README.md'), '# Demo\n');

    // Listing defaults to the repo root and filters out the git directory.
    let listing = repoListFiles(db, created.id, workspace);
    assert.equal(listing.directory, '.');
    assert.equal(listing.entries.some((entry) => entry.path === 'src' && entry.type === 'directory'), true);
    assert.equal(listing.entries.some((entry) => entry.path === 'README.md'), true);
    assert.equal(listing.entries.some((entry) => entry.path === '.git'), false);

    // Reading returns UTF-8 content scoped to the repo.
    const read = repoReadFile(db, created.id, workspace, 'src/index.js');
    assert.equal(read.content, 'export const x = 1;\n');
    assert.equal(read.path, 'src/index.js');

    // Writes create nested files.
    const written = repoWriteFile(db, created.id, workspace, 'src/util.js', 'export const y = 2;\n');
    assert.equal(written.wrote, true);
    assert.equal(await readFile(join(repoDir, 'src', 'util.js'), 'utf8'), 'export const y = 2;\n');

    // Renames move a file and update the listing.
    const renamed = repoRenameFile(db, created.id, workspace, 'src/util.js', 'src/helper.js');
    assert.equal(renamed.renamed, true);
    assert.equal(await readFile(join(repoDir, 'src', 'helper.js'), 'utf8'), 'export const y = 2;\n');

    // Deletes a file.
    const deleted = repoDeleteFile(db, created.id, workspace, 'src/helper.js');
    assert.equal(deleted.deleted, true);
    listing = repoListFiles(db, created.id, workspace, 'src');
    assert.equal(listing.entries.some((entry) => entry.path === 'src/helper.js'), false);

    // Path traversal is rejected.
    const escape = repoReadFile(db, created.id, workspace, '../outside.txt');
    assert.match(escape.error, /outside the repository/u);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('GitHub tools are executed with the plugin workspace when a plugin is active', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-plugin-'));
  const db = createDatabase(join(tempDirectory, 'plugins.sqlite'));
  const workspace = join(tempDirectory, 'workspace');
  try {
    const created = createPlugin(db, { type: 'github', name: 'GitHub' });
    seedToken(db, created.id);
    selectGithubRepo(db, created.id, { owner: 'alice', repo: 'demo', defaultBranch: 'main' });
    const repoDir = join(workspace, 'repos', 'alice__demo');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'app.js'), 'console.log(1);\n');

    const ctx = { db, pluginId: created.id, workspaceDirectory: workspace };
    const writeCall = await executeGithubTool({ function: { name: 'github_write_file', arguments: '{"path":"new.txt","content":"hello"}' } }, ctx);
    assert.equal(writeCall.result.wrote, true);
    assert.equal(await readFile(join(repoDir, 'new.txt'), 'utf8'), 'hello');

    const readCall = await executeGithubTool({ function: { name: 'github_read_file', arguments: '{"path":"app.js"}' } }, ctx);
    assert.equal(readCall.result.content, 'console.log(1);\n');

    const listCall = await executeGithubTool({ function: { name: 'github_list_files', arguments: '{}' } }, ctx);
    assert.ok(listCall.result.entries.length >= 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('push requires confirmation before it can proceed', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'glow-agent-plugin-'));
  const db = createDatabase(join(tempDirectory, 'plugins.sqlite'));
  const workspace = join(tempDirectory, 'workspace');
  try {
    const created = createPlugin(db, { type: 'github', name: 'GitHub' });
    seedToken(db, created.id);
    selectGithubRepo(db, created.id, { owner: 'alice', repo: 'demo', defaultBranch: 'main' });
    const repoDir = join(workspace, 'repos', 'alice__demo');
    await mkdir(join(repoDir, '.git'), { recursive: true });

    // Without approval, a push is rejected with a confirmation error.
    const call = await executeGithubTool({ function: { name: 'github_push', arguments: '{}' } }, { db, pluginId: created.id, workspaceDirectory: workspace });
    assert.match(call.result.error, /requires your confirmation/u);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
