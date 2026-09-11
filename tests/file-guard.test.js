import { mkdtemp, rm, mkdir, writeFile as fsWriteFile, symlink, readFile as fsReadFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedRelative, resolveSafePath } from '../server/services/file-guard.js';
import { listFiles, readFile, sqlQuery, webSearch, writeFile, fetchUrl, isPrivateAddress } from '../server/services/workspace-tools.js';
import { serializeToolResult, TOOL_RESULT_LIMIT } from '../server/services/tools.js';
import { createDatabase } from '../server/db/database.js';

const makeRoot = () => mkdtemp(join(tmpdir(), 'glow-guard-test-'));

test('file-guard blocks directory escapes and protects .git, .env and sqlite files', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => resolveSafePath(root, '../outside.txt'), /outside the workspace/u);
  assert.throws(() => resolveSafePath(root, '.git/config'), /protected/u);
  assert.throws(() => resolveSafePath(root, 'sub/.git/HEAD'), /protected/u);
  assert.throws(() => resolveSafePath(root, '.env'), /protected/u);
  assert.throws(() => resolveSafePath(root, '.env.local'), /protected/u);
  assert.throws(() => resolveSafePath(root, 'data/glow-agent.sqlite'), /protected/u);
  assert.throws(() => resolveSafePath(root, 'data/glow-agent.sqlite-wal'), /protected/u);
  assert.equal(isProtectedRelative('notes/todo.md'), false);
  assert.equal(isProtectedRelative('repo/app.sqlite3'), true);
});

test('file-guard stops symlink escapes for reads, writes and new targets', async (t) => {
  const root = await makeRoot();
  const outside = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await fsWriteFile(join(outside, 'secret.txt'), 'top secret');
  await symlink(outside, join(root, 'link-out'), 'dir');

  // Read through a symlinked directory is refused even though the string path looks inside.
  const read = readFile(root, 'link-out/secret.txt');
  assert.match(read.error, /outside the workspace/u);

  // Write through the symlinked directory is refused too.
  const write = writeFile(root, 'link-out/new.txt', 'payload');
  assert.match(write.error, /outside the workspace/u);

  // A symlink pointing to a single file outside is refused.
  await symlink(join(outside, 'secret.txt'), join(root, 'file-link'));
  assert.match(readFile(root, 'file-link').error, /outside the workspace/u);

  // A symlink inside pointing at the workspace itself still works.
  await mkdir(join(root, 'real'), { recursive: true });
  await fsWriteFile(join(root, 'real', 'ok.txt'), 'fine');
  await symlink(join(root, 'real'), join(root, 'link-in'), 'dir');
  assert.equal(readFile(root, 'link-in/ok.txt').content, 'fine');
});

test('protected paths stay protected through symlinks', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  await fsWriteFile(join(root, 'data', 'app.sqlite'), 'DB');
  await symlink(join(root, 'data'), join(root, 'alias'), 'dir');
  assert.match(readFile(root, 'alias/app.sqlite').error, /protected/u);
  assert.match(readFile(root, 'data/app.sqlite').error, /protected/u);
});

test('workspace tools refuse protected paths end to end', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git'));
  await fsWriteFile(join(root, '.git', 'config'), '[core]');
  await fsWriteFile(join(root, '.env'), 'HOST=127.0.0.1');
  assert.match(readFile(root, '.git/config').error, /protected/u);
  assert.match(readFile(root, '.env').error, /protected/u);
  assert.match(writeFile(root, '.git/hooks/x.sh', 'echo').error, /protected/u);
  assert.match(writeFile(root, '.env.production', 'X=1').error, /protected/u);
  assert.match(listFiles(root, '.git').error, /protected/u);
});

test('read_file pages large files with offset and limit', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = 'x'.repeat(300_000);
  await fsWriteFile(join(root, 'big.txt'), body);
  const first = readFile(root, 'big.txt');
  assert.equal(first.totalChars, 300_000);
  assert.equal(first.returnedChars, 256 * 1024);
  assert.equal(first.truncated, true);
  const second = readFile(root, 'big.txt', { offset: 256 * 1024 });
  assert.equal(second.offset, 256 * 1024);
  assert.equal(second.returnedChars, 300_000 - 256 * 1024);
  assert.equal(second.truncated, false);
  const window = readFile(root, 'big.txt', { offset: 10, limit: 25 });
  assert.equal(window.content, 'x'.repeat(25));
  assert.equal(window.truncated, true);
});

test('list_files defaults to a shallow listing and walks trees when recursive', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sub', 'deep'), { recursive: true });
  await fsWriteFile(join(root, 'top.txt'), 'a');
  await fsWriteFile(join(root, 'sub', 'nested.txt'), 'b');
  await fsWriteFile(join(root, 'sub', 'deep', 'bottom.txt'), 'c');

  const shallow = listFiles(root, '');
  assert.equal(shallow.recursive, false);
  assert.deepEqual(shallow.entries.map((entry) => entry.path).sort(), ['sub', 'top.txt']);

  const recursive = listFiles(root, '', { recursive: true });
  assert.equal(recursive.recursive, true);
  const paths = recursive.entries.map((entry) => entry.path);
  assert.ok(paths.includes('sub/nested.txt') && paths.includes(join('sub', 'deep', 'bottom.txt')));
});

test('sql_query caps oversized cells and reports blobs compactly', async (t) => {
  const dir = await makeRoot();
  const db = createDatabase(join(dir, 'caps.sqlite'));
  t.after(() => { db.close(); });
  db.exec('CREATE TABLE caps (id INTEGER, body TEXT, bin BLOB);');
  const longText = 'y'.repeat(20_000);
  const insert = db.prepare('INSERT INTO caps VALUES (?, ?, ?);');
  insert.run(1, longText, Buffer.from([1, 2, 3, 4]));
  const result = sqlQuery(db, 'SELECT * FROM caps');
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].body.length, 8_192 + '…[truncated]'.length);
  assert.equal(result.rows[0].bin, '<blob 4 bytes>');
});

test('web tools block SSRF targets before any network request', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('localhost'), true);
  assert.equal(isPrivateAddress('app.localhost'), true);
  assert.equal(isPrivateAddress('10.0.0.5'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('[fd00::1]'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  assert.equal(isPrivateAddress('example.com'), false);

  const fetched = await fetchUrl('http://127.0.0.1:3000/api/v1/health');
  assert.match(fetched.error, /not allowed/u);
  const metadata = await fetchUrl('http://169.254.169.254/latest/meta-data');
  assert.match(metadata.error, /not allowed/u);
  const searched = await webSearch('test');
  // Search either reaches the public network or fails cleanly; it must never reach localhost.
  if (searched.error) assert.doesNotMatch(searched.error, /127\.0\.0\.1/u);
});

test('serializeToolResult keeps small results intact and shrinks oversized ones', () => {
  const small = { path: 'a.txt', size: 3 };
  assert.equal(serializeToolResult(small), JSON.stringify(small));
  const huge = { path: 'big.txt', content: 'z'.repeat(TOOL_RESULT_LIMIT * 3), truncated: false };
  const serialized = serializeToolResult(huge);
  assert.ok(serialized.length <= TOOL_RESULT_LIMIT * 1.3);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.content, /truncated/u);
  const odd = { rows: ['q'.repeat(TOOL_RESULT_LIMIT * 2)] };
  const fallback = JSON.parse(serializeToolResult(odd));
  assert.equal(fallback.truncated, true);
  assert.ok(typeof fallback.preview === 'string');
});

test('fs errors never leak absolute workspace paths to tool callers', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'adir'));
  // Writing onto an existing directory triggers an EISDIR error from the OS.
  const result = writeFile(root, 'adir', 'content');
  assert.ok(result.error);
  assert.equal(result.error.includes(root), false);
});
