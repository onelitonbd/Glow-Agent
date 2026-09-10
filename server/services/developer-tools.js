import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync,
  statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveSafePath } from './file-guard.js';

// File-management tools beyond the original read/write/list set: targeted edits, explicit
// create, delete and rename for files and folders. Every path goes through the shared guard,
// all failures return `{ error }` (never throw), and results only ever describe paths relative
// to the workspace root. OS errors collapse to static messages so absolute paths never leak.

const WRITE_LIMIT = 256 * 1024;
const EDIT_DISK_CAP = 4 * 1024 * 1024;
const EDIT_LIMIT = 25;

const rel = (rootDirectory, target) => relative(rootDirectory, target) || '.';

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function guardRootItself(rootDirectory, target, action) {
  if (resolve(target) === resolve(rootDirectory)) {
    return `The workspace root cannot be ${action}.`;
  }
  return null;
}

export function editFile(rootDirectory, relPath, edits, { replaceAll = false } = {}) {
  // Arguments are validated before any filesystem checks so malformed calls fail the same way
  // regardless of what already exists on disk.
  if (!Array.isArray(edits) || edits.length === 0) return { error: 'Provide at least one edit with search and replace text.' };
  if (edits.length > EDIT_LIMIT) return { error: `At most ${EDIT_LIMIT} edits per call.` };
  const prepared = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (!edit || typeof edit !== 'object') return { error: `Edit ${index + 1} must be an object with search and replace strings.` };
    if (typeof edit.search !== 'string' || edit.search.length === 0) return { error: `Edit ${index + 1} is missing the search text.` };
    if (edit.search.length > 64_000) return { error: `Edit ${index + 1} search text is too long.` };
    if (typeof edit.replace !== 'string') return { error: `Edit ${index + 1} is missing the replace string.` };
    if (edit.replace.length > WRITE_LIMIT) return { error: `Edit ${index + 1} replace text is too long.` };
    prepared.push({ search: edit.search, replace: edit.replace });
  }
  let target;
  try { target = resolveSafePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (!existsSync(target) || isDirectory(target)) return { error: 'File does not exist.' };
  const stats = statSync(target);
  if (stats.size > EDIT_DISK_CAP) return { error: `File is too large to edit (${stats.size} bytes).` };
  const buffer = readFileSync(target);
  if (buffer.includes(0)) return { error: 'This file appears binary and cannot be edited as text.' };
  let content = buffer.toString('utf8');
  const sizeBefore = stats.size;
  let replacements = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    const { search, replace } = prepared[index];
    const occurrences = content.split(search).length - 1;
    if (occurrences === 0) {
      // Edits apply in order and the file is written only after every edit succeeds, so a
      // failing edit leaves the file completely untouched.
      return {
        error: `Edit ${index + 1} matched nothing in the file. Read the file to see its current content. No changes were saved.`,
        editsApplied: index,
        path: rel(rootDirectory, target)
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        error: `Edit ${index + 1} matched ${occurrences} places in the file. Include more surrounding context so the search text is unique, or set replaceAll to true. No changes were saved.`,
        editsApplied: index,
        path: rel(rootDirectory, target)
      };
    }
    content = content.split(search).join(replace);
    replacements += occurrences;
  }
  if (content.length > EDIT_DISK_CAP) return { error: `The edit would make the file too large (${content.length} characters).` };
  try {
    writeFileSync(target, content, 'utf8');
  } catch {
    return { error: 'The file could not be saved after editing.' };
  }
  const size = statSync(target).size;
  return {
    path: rel(rootDirectory, target),
    edited: true,
    editsApplied: prepared.length,
    replacements,
    sizeBefore,
    sizeAfter: size,
    bytes: size
  };
}

export function createFolder(rootDirectory, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.trim() === '.') return { error: 'A folder path is required.' };
  let target;
  try { target = resolveSafePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (existsSync(target)) {
    if (isDirectory(target)) return { path: rel(rootDirectory, target), pathType: 'directory', created: false, alreadyExists: true };
    return { error: 'A file already exists at that path.' };
  }
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    return { error: 'The folder could not be created.' };
  }
  return { path: rel(rootDirectory, target), pathType: 'directory', created: true };
}

export function createFile(rootDirectory, relPath, content) {
  if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'A file path is required.' };
  let target;
  try { target = resolveSafePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (existsSync(target)) return { error: 'File already exists. Use edit_file to change it or write_file to overwrite it.' };
  const contentString = typeof content === 'string' ? content : '';
  if (contentString.length > WRITE_LIMIT) return { error: `Content is too large to write (${contentString.length} characters).` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    // 'wx' refuses to overwrite, so a file that appears between the existence check and the
    // write still cannot be clobbered silently.
    writeFileSync(target, contentString, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    return { error: error?.code === 'EEXIST' ? 'File already exists. Use edit_file to change it or write_file to overwrite it.' : 'The file could not be created.' };
  }
  const size = statSync(target).size;
  return { path: rel(rootDirectory, target), pathType: 'file', created: true, size, bytes: size };
}

export function deleteFile(rootDirectory, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'A file path is required.' };
  let target;
  try { target = resolveSafePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  if (isDirectory(target) && !isSymlink(target)) return { error: 'Path is a folder. Use delete_folder to remove it.' };
  if (!existsSync(target) && !isSymlink(target)) return { error: 'File does not exist.' };
  try {
    unlinkSync(target);
  } catch {
    return { error: 'The file could not be deleted.' };
  }
  return { path: rel(rootDirectory, target), pathType: 'file', deleted: true };
}

export function deleteFolder(rootDirectory, relPath, { recursive = false } = {}) {
  if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'A folder path is required.' };
  let target;
  try { target = resolveSafePath(rootDirectory, relPath); } catch (error) { return { error: error.message }; }
  const rootError = guardRootItself(rootDirectory, target, 'deleted');
  if (rootError) return { error: rootError };
  if (isSymlink(target)) return { error: 'Path is a symbolic link, not a folder. Use delete_file to remove the link.' };
  if (!existsSync(target)) return { error: 'Folder does not exist.' };
  if (!isDirectory(target)) return { error: 'Path is a file. Use delete_file to remove it.' };
  try {
    // rmdirSync is the empty-folder path; it refuses non-empty folders with ENOTEMPTY, which
    // becomes the explicit signal that the recursive flag is required. rmSync (which ignores
    // emptiness entirely) is used only when the caller opted into a recursive delete.
    if (recursive === true) rmSync(target, { recursive: true });
    else rmdirSync(target);
  } catch (error) {
    return { error: error?.code === 'ENOTEMPTY' ? 'Folder is not empty. Set recursive to true to delete it with all of its contents.' : 'The folder could not be deleted.' };
  }
  return { path: rel(rootDirectory, target), pathType: 'directory', deleted: true, recursive: recursive === true };
}

function renameWithin(rootDirectory, from, to, { expectDirectory }) {
  if (typeof from !== 'string' || !from.trim()) return { error: 'A current path (from) is required.' };
  if (typeof to !== 'string' || !to.trim()) return { error: 'A new path (to) is required.' };
  if (from.trim() === to.trim()) return { error: 'The new path is the same as the current path.' };
  const label = expectDirectory ? 'folder' : 'file';
  let source;
  let destination;
  try {
    source = resolveSafePath(rootDirectory, from);
    destination = resolveSafePath(rootDirectory, to);
  } catch (error) {
    return { error: error.message };
  }
  const rootError = guardRootItself(rootDirectory, source, 'renamed');
  if (rootError) return { error: rootError };
  if (isSymlink(source)) return { error: 'Path is a symbolic link. Delete it with delete_file instead of renaming.' };
  if (!existsSync(source)) return { error: `${expectDirectory ? 'Folder' : 'File'} does not exist.` };
  const sourceIsDir = isDirectory(source);
  if (expectDirectory && !sourceIsDir) return { error: 'Path is a file. Use rename_file to move it.' };
  if (!expectDirectory && sourceIsDir) return { error: 'Path is a folder. Use rename_folder to move it.' };
  if (expectDirectory && (destination === source || destination.startsWith(source + sep))) {
    return { error: 'A folder cannot be moved inside itself.' };
  }
  if (existsSync(destination)) return { error: 'Something already exists at the destination.' };
  try {
    mkdirSync(dirname(destination), { recursive: true });
    try {
      renameSync(source, destination);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      // Cross-device move: copy the tree, then remove the original.
      cpSync(source, destination, { recursive: sourceIsDir });
      if (sourceIsDir) rmSync(source, { recursive: true });
      else unlinkSync(source);
    }
  } catch {
    return { error: `The ${label} could not be renamed.` };
  }
  return {
    from: rel(rootDirectory, source),
    to: rel(rootDirectory, destination),
    pathType: expectDirectory ? 'directory' : 'file',
    renamed: true
  };
}

export function renameFile(rootDirectory, from, to) {
  return renameWithin(rootDirectory, from, to, { expectDirectory: false });
}

export function renameFolder(rootDirectory, from, to) {
  return renameWithin(rootDirectory, from, to, { expectDirectory: true });
}

// ---- run_shell --------------------------------------------------------------------------
//
// One-off shell commands in the workspace directory. This is deliberately NOT sandboxed — the
// tool exists so the agent can do real work on the user's own device — so the controls are:
// a settings gate (off by default), a bounded command string, a timeout that kills the whole
// process group, capped captured output, a scrubbed environment, and a lightweight database
// guard. All limits are constants rather than hidden in env so behaviour is predictable.

const SHELL_COMMAND_LIMIT = 4_000;
const SHELL_DEFAULT_TIMEOUT_MS = 30_000;
const SHELL_MAX_TIMEOUT_MS = 120_000;
const SHELL_OUTPUT_LIMIT = 16 * 1024;

const SHELL_ENV_ALLOWLIST = ['PATH', 'HOME', 'PREFIX', 'TMPDIR', 'LD_LIBRARY_PATH', 'TERM', 'LANG', 'USER', 'SHELL'];

function shellBinary() {
  // Termux keeps its shell in $PREFIX/bin; stock POSIX always has /bin/sh.
  const prefix = process.env.PREFIX;
  if (prefix && existsSync(join(prefix, 'bin', 'sh'))) return join(prefix, 'bin', 'sh');
  return '/bin/sh';
}

function shellEnvironment() {
  const env = {};
  for (const key of SHELL_ENV_ALLOWLIST) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.TMPDIR) env.TMPDIR = '/tmp';
  return env;
}

// The local database holds provider API keys in plaintext on purpose (single-owner device), so
// even with shell enabled the model is never allowed to touch *.sqlite files. This is a blunt
// string check — it exists to stop honest model mistakes, not motivated attackers, and the
// settings gate remains the real control.
const DATABASE_COMMAND_PATTERN = /\.sqlite3?/iu;

export async function runShell(rootDirectory, command, { timeoutMs } = {}) {
  const text = typeof command === 'string' ? command.trim() : '';
  if (!text) return { error: 'A shell command is required.' };
  if (text.length > SHELL_COMMAND_LIMIT) return { error: `The command is too long (${text.length} characters).` };
  if (DATABASE_COMMAND_PATTERN.test(text)) {
    return { error: 'Commands that reference SQLite database files are not allowed.' };
  }
  const timeout = Number.isFinite(Number(timeoutMs))
    ? Math.max(1_000, Math.min(Math.floor(Number(timeoutMs)), SHELL_MAX_TIMEOUT_MS))
    : SHELL_DEFAULT_TIMEOUT_MS;
  const cwd = resolve(rootDirectory);
  return new Promise((resolvePromise) => {
    let child;
    try {
      // detached: true puts the shell in its own process group so a timeout can kill the whole
      // pipeline, not just the top shell.
      child = spawn(shellBinary(), ['-c', text], { cwd, env: shellEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolvePromise({ error: 'The shell command could not be started.' });
      return;
    }
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    // Streams are always drained (even past the cap) so the child never blocks on a full pipe.
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= SHELL_OUTPUT_LIMIT) { stdoutTruncated = true; return; }
      stdoutBytes += chunk.length;
      if (stdoutBytes > SHELL_OUTPUT_LIMIT) {
        stdoutTruncated = true;
        stdoutChunks.push(chunk.subarray(0, chunk.length - (stdoutBytes - SHELL_OUTPUT_LIMIT)));
      } else stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= SHELL_OUTPUT_LIMIT) { stderrTruncated = true; return; }
      stderrBytes += chunk.length;
      if (stderrBytes > SHELL_OUTPUT_LIMIT) {
        stderrTruncated = true;
        stderrChunks.push(chunk.subarray(0, chunk.length - (stderrBytes - SHELL_OUTPUT_LIMIT)));
      } else stderrChunks.push(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, timeout);
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise({ error: 'The shell command could not be started.' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        command: text,
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}
