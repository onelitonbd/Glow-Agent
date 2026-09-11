import { mkdtemp, rm, readFile as fsReadFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runShell } from '../server/services/developer-tools.js';
import { executeToolCall, toolsForSettings, SHELL_TOOL_IDS, FILE_MANAGEMENT_TOOL_IDS } from '../server/services/tools.js';
import { createDatabase } from '../server/db/database.js';
import { getSettings, updateSettings, defaultDeveloperToolsSettings } from '../server/services/settings.js';

const makeRoot = () => mkdtemp(join(tmpdir(), 'glow-shell-test-'));
const makeDb = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'glow-shell-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = createDatabase(join(dir, 'test.sqlite'));
  t.after(() => db.close());
  return db;
};

// ---- run_shell behaviour -----------------------------------------------------------------

test('run_shell runs commands in the workspace and reports exit code and streams', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const hello = await runShell(root, 'echo hello && pwd >&2');
  assert.equal(hello.exitCode, 0);
  assert.match(hello.stdout, /hello/u);
  assert.equal(hello.stderr.trim().length > 0, true);
  const failing = await runShell(root, 'echo nope >&2; exit 3');
  assert.equal(failing.exitCode, 3);
  assert.match(failing.stderr, /nope/u);
});

test('run_shell really writes in the workspace root', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const made = await runShell(root, 'mkdir -p via-shell && printf "from shell" > via-shell/out.txt');
  assert.equal(made.exitCode, 0);
  const body = await fsReadFile(join(root, 'via-shell', 'out.txt'), 'utf8');
  assert.equal(body, 'from shell');
});

test('run_shell kills long-running process groups at the timeout', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = Date.now();
  const result = await runShell(root, 'sleep 30 & sleep 30', { timeoutMs: 1_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 10_000, 'the group kill, not the 30s sleeps, ends the call');
});

test('run_shell clamps timeouts and truncates oversized output', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const big = await runShell(root, 'yes ABCDEFGH | head -c 200000');
  assert.equal(big.exitCode, 0);
  assert.equal(big.stdoutTruncated, true);
  assert.ok(big.stdout.length <= 16 * 1024 + 16);
  assert.ok(big.durationMs < 30_000);
});

test('run_shell scrubs the environment and refuses database-file commands', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.GLOW_SECRET_FOR_TEST = 'do-not-leak';
  try {
    const env = await runShell(root, 'printenv');
    assert.equal(env.stdout.includes('GLOW_SECRET_FOR_TEST'), false);
    assert.match(env.stdout, /PATH=/u);
  } finally {
    delete process.env.GLOW_SECRET_FOR_TEST;
  }
  const dbTry = await runShell(root, 'cat data/glow-agent.sqlite | head');
  assert.match(dbTry.error, /database files are not allowed/u);
  const walTry = await runShell(root, 'cp glow-agent.sqlite-wal /tmp/x');
  assert.match(walTry.error, /database files are not allowed/u);
  assert.match((await runShell(root, '')).error, /command is required/u);
  assert.match((await runShell(root, 'x'.repeat(4_001))).error, /too long/u);
});

test('run_shell flows through executeToolCall and is refused when the gate is off', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const call = { function: { name: 'run_shell', arguments: '{"command":"echo gated"}' } };
  const on = await executeToolCall(call, new Set(['run_shell']), { rootDirectory: root, developerTools: { fileManagement: true, shell: true } });
  assert.equal(on.result.exitCode, 0);
  assert.match(on.summary, /Shell command exited 0: echo gated/u);
  const off = await executeToolCall(call, new Set(['run_shell']), { rootDirectory: root, developerTools: { fileManagement: true, shell: false } });
  assert.match(off.result.error, /disabled in settings/u);
  const defaulted = await executeToolCall(call, new Set(['run_shell']), { rootDirectory: root });
  // Without an explicit settings object the executor honours the allowed-set alone.
  assert.equal(defaulted.result.exitCode, 0);
});

// ---- the settings gate -------------------------------------------------------------------

test('developer tool settings default to file tools on and shell off', async (t) => {
  const db = await makeDb(t);
  assert.deepEqual(defaultDeveloperToolsSettings(), { fileManagement: true, shell: false, confirmShell: false });
  const fresh = getSettings(db);
  assert.deepEqual(fresh.developerTools, { fileManagement: true, shell: false, confirmShell: false });
  const saved = updateSettings(db, { developerTools: { fileManagement: false, shell: true, confirmShell: true } });
  assert.deepEqual(saved.developerTools, { fileManagement: false, shell: true, confirmShell: true });
  const reread = getSettings(db);
  assert.deepEqual(reread.developerTools, { fileManagement: false, shell: true, confirmShell: true });
  assert.throws(() => updateSettings(db, {}), /Nothing to save/u);
});

test('toolsForSettings filters the gated groups while keeping built-ins', async () => {
  const all = toolsForSettings({ fileManagement: true, shell: true }).map((tool) => tool.id);
  for (const id of [...FILE_MANAGEMENT_TOOL_IDS, ...SHELL_TOOL_IDS]) assert.ok(all.includes(id));
  const noShell = toolsForSettings({ fileManagement: true, shell: false }).map((tool) => tool.id);
  assert.ok(!noShell.includes('run_shell'));
  assert.ok(noShell.includes('edit_file'));
  const none = toolsForSettings({ fileManagement: false, shell: false }).map((tool) => tool.id);
  for (const id of FILE_MANAGEMENT_TOOL_IDS) assert.ok(!none.includes(id));
  assert.ok(!none.includes('run_shell'));
  assert.ok(none.includes('calculator') && none.includes('read_file') && none.includes('fetch_url'));
  const defaults = toolsForSettings().map((tool) => tool.id);
  assert.ok(defaults.includes('edit_file') && !defaults.includes('run_shell'));
});
