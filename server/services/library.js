import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { now } from '../db/database.js';
import { identifier } from '../lib/validate.js';
import { notFound, validation } from '../lib/errors.js';

const DATA_URL_RE = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu;
const MAX_LIBRARY_FILE_BYTES = 25 * 1024 * 1024; // 25MB for library direct uploads

function ensureLibraryDir(libraryDirectory) {
  mkdirSync(libraryDirectory, { recursive: true });
}

function safeExt(originalName, mimeType) {
  const ext = extname(originalName || '').toLowerCase().slice(0, 12);
  if (ext && /^[.][a-z0-9]{1,10}$/iu.test(ext)) return ext;
  // fallback from mime
  const mimeMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'text/csv': '.csv',
    'application/zip': '.zip'
  };
  return mimeMap[mimeType?.toLowerCase()] || '';
}

function toLibraryFile(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: Number(row.size),
    type: row.type,
    conversationId: row.conversation_id || null,
    messageId: row.message_id || null,
    createdAt: row.created_at,
    // Direct API links
    url: `/api/v1/library/${row.id}/file`,
    previewUrl: `/api/v1/library/${row.id}/file`,
    metaUrl: `/api/v1/library/${row.id}`
  };
}

function classifyType(mimeType, originalName) {
  const mime = (mimeType || '').toLowerCase();
  const name = (originalName || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('markdown') || name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.csv')) return 'doc';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function parseDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' ? DATA_URL_RE.exec(dataUrl.trim()) : null;
  if (!match) return null;
  const base64 = match[2].replace(/\s+/gu, '');
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  return { mimeType: match[1].toLowerCase(), base64, bytes, dataUrl: `data:${match[1].toLowerCase()};base64,${base64}` };
}

export function listLibraryFiles(db) {
  const rows = db.prepare('SELECT * FROM library_files ORDER BY created_at DESC LIMIT 500').all();
  return rows.map(toLibraryFile);
}

export function getLibraryFile(db, rawId) {
  const id = identifier(rawId, 'File ID');
  const row = db.prepare('SELECT * FROM library_files WHERE id = ?').get(id);
  if (!row) throw notFound('Library file');
  return toLibraryFile(row);
}

export function getLibraryFileRow(db, rawId) {
  const id = identifier(rawId, 'File ID');
  const row = db.prepare('SELECT * FROM library_files WHERE id = ?').get(id);
  if (!row) throw notFound('Library file');
  return row;
}

export function saveLibraryFile(db, libraryDirectory, { originalName, mimeType, dataUrl, buffer, size, conversationId = null, messageId = null }) {
  ensureLibraryDir(libraryDirectory);
  let fileBuffer;
  let finalMime = mimeType || 'application/octet-stream';
  let finalSize = size || 0;

  if (buffer && Buffer.isBuffer(buffer)) {
    fileBuffer = buffer;
    finalSize = buffer.length;
  } else if (dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw validation('File must be a valid base64 data URL.');
    if (parsed.bytes === 0) throw validation('File is empty.');
    if (parsed.bytes > MAX_LIBRARY_FILE_BYTES) throw validation(`File is ${Math.round(parsed.bytes / 1024 / 1024)} MB. Max ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB.`);
    fileBuffer = Buffer.from(parsed.base64, 'base64');
    finalMime = parsed.mimeType || finalMime;
    finalSize = parsed.bytes;
  } else {
    throw validation('File data is required.');
  }

  if (finalSize > MAX_LIBRARY_FILE_BYTES) throw validation(`File too large (${finalSize} bytes).`);

  const id = randomUUID();
  const cleanName = (originalName || 'file').trim().slice(0, 180) || 'file';
  const ext = safeExt(cleanName, finalMime);
  const storedName = `${id}${ext}`;
  const absolutePath = resolve(join(libraryDirectory, storedName));

  // Ensure path stays inside library dir
  const libResolved = resolve(libraryDirectory);
  if (!absolutePath.startsWith(libResolved)) throw validation('Invalid file path.');

  try {
    writeFileSync(absolutePath, fileBuffer);
  } catch (e) {
    throw validation(`Could not save file: ${e.message}`);
  }

  const type = classifyType(finalMime, cleanName);
  const createdAt = now();

  db.prepare(`
    INSERT INTO library_files (id, original_name, stored_name, mime_type, size, type, conversation_id, message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, cleanName, storedName, finalMime, finalSize, type, conversationId || null, messageId || null, createdAt);

  return toLibraryFile({
    id,
    original_name: cleanName,
    stored_name: storedName,
    mime_type: finalMime,
    size: finalSize,
    type,
    conversation_id: conversationId || null,
    message_id: messageId || null,
    created_at: createdAt
  });
}

// Save from chat attachment (already parsed)
export function saveAttachmentToLibrary(db, libraryDirectory, attachment, { conversationId, messageId }) {
  try {
    if (!attachment?.dataUrl) return null;
    return saveLibraryFile(db, libraryDirectory, {
      originalName: attachment.name || 'attachment',
      mimeType: attachment.mimeType,
      dataUrl: attachment.dataUrl,
      conversationId,
      messageId
    });
  } catch {
    // Library save should not break chat flow - silently skip on error
    return null;
  }
}

export function deleteLibraryFile(db, libraryDirectory, rawId) {
  const row = getLibraryFileRow(db, rawId);
  const absolutePath = resolve(join(libraryDirectory, row.stored_name));
  const libResolved = resolve(libraryDirectory);
  // Safety check
  if (!absolutePath.startsWith(libResolved)) throw validation('Invalid file path.');

  try {
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
  } catch {
    // ignore deletion errors, still remove DB row
  }
  db.prepare('DELETE FROM library_files WHERE id = ?').run(row.id);
  return { deleted: true, id: row.id };
}

export function readLibraryFileBuffer(libraryDirectory, storedName) {
  const absolutePath = resolve(join(libraryDirectory, storedName));
  const libResolved = resolve(libraryDirectory);
  if (!absolutePath.startsWith(libResolved)) throw validation('Invalid file path.');
  if (!existsSync(absolutePath)) throw notFound('File on disk');
  return { buffer: readFileSync(absolutePath), path: absolutePath };
}
