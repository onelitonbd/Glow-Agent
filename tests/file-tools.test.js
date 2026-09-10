import { mkdtemp, rm, mkdir, readFile as fsReadFile, writeFile as fsWriteFile, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFile, createFolder, deleteFile, deleteFolder, editFile, renameFile, renameFolder
} from '../server/services/developer-tools.js';
import { executeToolCall } from '../server/services/tools.js';

const makeRoot = () => mkdtemp(join(tmpdir(), 'glow-filetools-test-'));

// ---- edit_file -------------------------------------------------------------------------

test('edit_file applies ordered unique search/replace edits', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'note.md'), 'alpha beta gamma beta\n');
  const result = editFile(root, 'note.md', [
    { search: 'alpha', replace: 'ALPHA' },
    { search: 'gamma', replace: 'GAMMA' }
  ]);
  assert.equal(result.edited, true);
  assert.equal(result.replacements, 2);
  const body = await fsReadFile(join(root, 'note.md'), 'utf8');
  assert.equal(body, 'ALPHA beta GAMMA beta\n');
});

test('edit_file refuses ambiguous matches unless replaceAll is set', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'dups.txt'), 'one one one');
  const ambiguous = editFile(root, 'dups.txt', [{ search: 'one', replace: 'two' }]);
  assert.match(ambiguous.error, /matched 3 places/u);
  assert.equal(await fsReadFile(join(root, 'dups.txt'), 'utf8'), 'one one one');
  const all = editFile(root, 'dups.txt', [{ search: 'one', replace: 'two' }], { replaceAll: true });
  assert.equal(all.replacements, 3);
  assert.equal(await fsReadFile(join(root, 'dups.txt'), 'utf8'), 'two two two');
});

test('edit_file reports the first failing edit and keeps earlier applied edits visible', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'partial.txt'), 'start middle end');
  const result = editFile(root, 'partial.txt', [
    { search: 'start', replace: 'START' },
    { search: 'missing text', replace: 'x' }
  ]);
  // The file is only written after every edit succeeds, so a failing edit leaves it untouched.
  assert.match(result.error, /matched nothing/u);
  assert.equal(result.editsApplied, 1);
  assert.equal(await fsReadFile(join(root, 'partial.txt'), 'utf8'), 'start middle end');
});

test('edit_file guards: binary, missing file, escapes and protected targets', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  assert.match(editFile(root, 'bin.dat', [{ search: 'x', replace: 'y' }]).error, /binary/u);
  assert.match(editFile(root, 'nope.txt', [{ search: 'x', replace: 'y' }]).error, /does not exist/u);
  assert.match(editFile(root, '../x.txt', [{ search: 'x', replace: 'y' }]).error, /outside the workspace/u);
  assert.match(editFile(root, '.env', [{ search: 'a', replace: 'b' }]).error, /protected/u);
  assert.match(editFile(root, 'f.txt', []).error, /at least one edit/u);
  assert.match(editFile(root, 'f.txt', [{ search: '', replace: 'b' }]).error, /missing the search text/u);
  assert.match(editFile(root, 'f.txt', [{ search: 'a' }]).error, /missing the replace string/u);
});

// ---- create_folder / create_file --------------------------------------------------------

test('create_folder creates nested folders and tolerates existing ones', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = createFolder(root, 'a/b/c');
  assert.equal(created.created, true);
  assert.ok(existsSync(join(root, 'a', 'b', 'c')));
  const again = createFolder(root, 'a/b/c');
  assert.equal(again.alreadyExists, true);
  await fsWriteFile(join(root, 'file-here'), 'x');
  assert.match(createFolder(root, 'file-here').error, /file already exists/u);
  assert.match(createFolder(root, '').error, /folder path is required/u);
  assert.match(createFolder(root, 'data/x.sqlite').error, /protected/u);
});

test('create_file creates once and never overwrites', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = createFile(root, 'src/app.js', 'console.log(1);\n');
  assert.equal(created.created, true);
  assert.equal(created.bytes, 16);
  const clash = createFile(root, 'src/app.js', 'other');
  assert.match(clash.error, /already exists/u);
  assert.equal(await fsReadFile(join(root, 'src/app.js'), 'utf8'), 'console.log(1);\n');
  assert.match(createFile(root, '.git/HEAD', 'x').error, /protected/u);
});

// ---- delete_file / delete_folder --------------------------------------------------------

test('delete_file removes files and refuses folders, missing paths and protected files', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'gone.txt'), 'bye');
  assert.equal(deleteFile(root, 'gone.txt').deleted, true);
  assert.ok(!existsSync(join(root, 'gone.txt')));
  assert.match(deleteFile(root, 'gone.txt').error, /does not exist/u);
  await mkdir(join(root, 'folder'));
  assert.match(deleteFile(root, 'folder').error, /folder/u);
  await mkdir(join(root, 'data'), { recursive: true });
  await fsWriteFile(join(root, 'data', 'secret.sqlite'), 'db');
  assert.match(deleteFile(root, 'data/secret.sqlite').error, /protected/u);
});

test('delete_file removes a dangling symlink without touching its target', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(root, 'missing-target'), join(root, 'dangling'));
  const stats = await lstat(join(root, 'dangling'));
  assert.ok(stats.isSymbolicLink());
  assert.equal(deleteFile(root, 'dangling').deleted, true);
  assert.ok(!existsSync(join(root, 'dangling')));
});

test('delete_folder requires recursive for non-empty folders and never deletes the root', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'empty'));
  assert.equal(deleteFolder(root, 'empty').deleted, true);
  await mkdir(join(root, 'full', 'inner'), { recursive: true });
  await fsWriteFile(join(root, 'full', 'inner', 'x.txt'), 'x');
  const blocked = deleteFolder(root, 'full');
  assert.match(blocked.error, /not empty/u);
  assert.ok(existsSync(join(root, 'full', 'inner', 'x.txt')));
  const gone = deleteFolder(root, 'full', { recursive: true });
  assert.equal(gone.deleted, true);
  assert.equal(gone.recursive, true);
  assert.ok(!existsSync(join(root, 'full')));
  assert.match(deleteFolder(root, '.').error, /workspace root cannot be deleted/u);
  assert.match(deleteFolder(root, '').error, /folder path is required/u);
  await fsWriteFile(join(root, 'afile.txt'), 'x');
  assert.match(deleteFolder(root, 'afile.txt').error, /file/u);
});

// ---- rename_file / rename_folder --------------------------------------------------------

test('rename_file renames and moves files, creating destination parents', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'old.txt'), 'body');
  const renamed = renameFile(root, 'old.txt', 'newdir/new.txt');
  assert.equal(renamed.renamed, true);
  assert.equal(await fsReadFile(join(root, 'newdir', 'new.txt'), 'utf8'), 'body');
  assert.ok(!existsSync(join(root, 'old.txt')));
  assert.match(renameFile(root, 'newdir/new.txt', 'no-parent/../../x').error, /outside the workspace/u);
});

test('rename_file refuses existing destinations, folders and protected paths', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await fsWriteFile(join(root, 'a.txt'), 'a');
  await fsWriteFile(join(root, 'b.txt'), 'b');
  assert.match(renameFile(root, 'a.txt', 'b.txt').error, /already exists/u);
  await mkdir(join(root, 'dir'));
  assert.match(renameFile(root, 'dir', 'dir2').error, /folder/u);
  assert.match(renameFile(root, 'a.txt', '.env').error, /protected/u);
  assert.match(renameFile(root, 'missing.txt', 'x.txt').error, /does not exist/u);
  assert.match(renameFile(root, 'a.txt', 'a.txt').error, /same/u);
});

test('rename_folder renames folders and blocks self-nesting and collisions', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'proj', 'src'), { recursive: true });
  await fsWriteFile(join(root, 'proj', 'src', 'main.js'), '//');
  const renamed = renameFolder(root, 'proj', 'renamed-proj');
  assert.equal(renamed.renamed, true);
  assert.equal(await fsReadFile(join(root, 'renamed-proj', 'src', 'main.js'), 'utf8'), '//');
  assert.match(renameFolder(root, 'renamed-proj', 'renamed-proj/inner').error, /inside itself/u);
  await fsWriteFile(join(root, 'plain.txt'), 'x');
  assert.match(renameFolder(root, 'plain.txt', 'not-a-dir').error, /file/u);
  assert.match(renameFolder(root, '.', 'elsewhere').error, /workspace root cannot be renamed/u);
});

// ---- dispatch through executeToolCall ----------------------------------------------------

test('the new tools execute through the standard tool-call dispatcher', async (t) => {
  const root = await makeRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (name, args, allowed) => executeToolCall(
    { function: { name, arguments: JSON.stringify(args) } },
    new Set(allowed || [name]),
    { rootDirectory: root }
  );
  const make = await run('create_file', { path: 'demo.txt', content: 'hello' });
  assert.equal(make.result.created, true);
  assert.equal(make.summary, 'Created file: demo.txt (5 bytes)');
  const edit = await run('edit_file', { path: 'demo.txt', edits: [{ search: 'hello', replace: 'goodbye' }] });
  assert.match(edit.summary, /Edited file: demo\.txt \(1 replacement\)/u);
  const mv = await run('rename_file', { from: 'demo.txt', to: 'renamed.txt' });
  assert.equal(mv.summary, 'Renamed file: demo.txt → renamed.txt');
  const del = await run('delete_file', { path: 'renamed.txt' });
  assert.equal(del.summary, 'Deleted file: renamed.txt');
  const denied = await run('delete_file', { path: 'renamed.txt' }, ['calculator']);
  assert.equal(denied.summary, 'An unavailable tool call was blocked.');
});
