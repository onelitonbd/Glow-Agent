import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

// One source of truth for "where may a model-driven file tool reach?". Every workspace and
// repository file tool resolves paths through this module, so confinement rules and the
// protected-path list cannot silently drift apart between tools.
//
// Two independent checks are applied:
//   1. String confinement — the resolved path must stay under the root.
//   2. Realpath confinement — the nearest existing ancestor (and the target itself, when it
//      exists) is resolved through symlinks and must still be inside the root. Without this a
//      symlink inside the workspace would let a tool read or write anywhere on disk.
//
// Error messages are static and never echo absolute paths back to the model.

// Path segments (exact directory or file names) that are never touchable through a file tool.
const PROTECTED_SEGMENTS = new Set(['.git']);
// Environment files anywhere in the tree: .env, .env.local, .env.production, ...
const PROTECTED_ENV_PATTERN = /^\.env($|\.)/u;
// Local database files and their journaling companions.
const PROTECTED_DATABASE_PATTERN = /\.(sqlite|sqlite3)(-(wal|shm))?$/iu;

export function isProtectedRelative(relPath) {
  const segments = String(relPath).split(sep).filter(Boolean);
  for (const segment of segments) {
    if (PROTECTED_SEGMENTS.has(segment)) return true;
    if (PROTECTED_ENV_PATTERN.test(segment)) return true;
  }
  const base = segments[segments.length - 1] || '';
  return PROTECTED_DATABASE_PATTERN.test(base);
}

function realpathOf(absPath) {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}

function withinRoot(realRoot, candidate) {
  return candidate === realRoot || candidate.startsWith(realRoot + sep);
}

// Resolve `relPath` inside `rootDirectory`, returning an absolute path that is guaranteed to be
// both string-confined and symlink-confined to the root and free of protected segments.
// Throws an Error with a static, model-safe message otherwise.
export function resolveSafePath(rootDirectory, relPath) {
  const rootReal = realpathOf(rootDirectory) || resolve(rootDirectory);
  const safeRelative = typeof relPath === 'string' ? relPath.trim() : '';
  if (!safeRelative || safeRelative === '.') return rootReal;
  const target = resolve(rootReal, safeRelative);
  if (!withinRoot(rootReal, target)) throw new Error('Path is outside the workspace.');
  const relativeToRoot = target === rootReal ? '' : target.slice(rootReal.length + 1);
  if (relativeToRoot && isProtectedRelative(relativeToRoot)) {
    throw new Error('That path is protected and cannot be used with tools.');
  }
  if (existsSync(target)) {
    // The target itself exists: its real location must still be inside the root and
    // unprotected (a symlink can point into .git/ or onto the database just as easily as out).
    const realTarget = realpathOf(target) || target;
    if (!withinRoot(rootReal, realTarget)) throw new Error('Path is outside the workspace.');
    const realRelative = realTarget === rootReal ? '' : realTarget.slice(rootReal.length + 1);
    if (realRelative && isProtectedRelative(realRelative)) {
      throw new Error('That path is protected and cannot be used with tools.');
    }
    return target;
  }
  // The target does not exist yet (create_file, create_folder, rename destinations): realpath
  // the nearest existing ancestor so a symlinked parent cannot smuggle the new path outside.
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realAncestor = realpathOf(probe) || probe;
  if (!withinRoot(rootReal, realAncestor)) throw new Error('Path is outside the workspace.');
  return target;
}
