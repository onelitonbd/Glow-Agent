import { randomUUID } from 'node:crypto';
import express from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from './db/database.js';
import { AppError } from './lib/errors.js';
import { createApiRouter } from './routes/api.js';
import { createAutoTestScheduler } from './services/auto-tests.js';

export function createApp(config) {
  // Hand-rolled configs (e.g. in tests) get the same default as server/lib/config.js, so the
  // rest of the app can rely on the value always being present.
  config = {
    ...config,
    workspaceDirectory: config.workspaceDirectory || join(config.rootDirectory, 'data', 'workspace'),
    libraryDirectory: config.libraryDirectory || join(config.rootDirectory, 'data', 'library')
  };
  // The assistant's file-tool sandbox. Created up front so the folder is present even before
  // the first tool call (plugin clones also live under it), and so the app fails loudly at
  // boot rather than mid-turn if the location is unusable.
  mkdirSync(config.workspaceDirectory, { recursive: true });
  mkdirSync(config.libraryDirectory, { recursive: true });
  const db = createDatabase(config.databasePath);
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const startedAt = performance.now();
    request.requestId = randomUUID();
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      // PWA: allow manifest, service worker, and icons. Keep strict but add manifest-src, worker-src
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; script-src 'self'; manifest-src 'self'; worker-src 'self'"
    });
    response.on('finish', () => {
      const durationMs = Math.round(performance.now() - startedAt);
      // Keep operational logs useful while never serializing request bodies or secrets.
      console.info(JSON.stringify({ event: 'request', requestId: request.requestId, method: request.method, path: request.path, status: response.statusCode, durationMs }));
    });
    next();
  });
  // Attachments ride along inside the JSON body as base64 data URLs, so the chat endpoints get a
  // much larger ceiling than everything else. The limit is per request, and the attachment count
  // and per-file size are checked again in the service, so a big body still cannot smuggle in an
  // unlimited number of files.
  app.use('/api/v1/conversations', express.json({ limit: '24mb', type: 'application/json' }));
  app.use('/api/v1/library', express.json({ limit: '32mb', type: 'application/json' }));
  app.use(express.json({ limit: '64kb', type: 'application/json' }));
  const autoTests = createAutoTestScheduler({
    db,
    timeoutMs: Math.min(config.providerFetchTimeoutMs + 5_000, 30_000),
    intervalMs: config.autoTestIntervalMs
  });
  app.use('/api/v1', createApiRouter({ db, config, autoTests }));
  // Deep links: /chat/<id> is the shareable address of one conversation. The page loads the
  // same chat shell for every id; the client resolves the id against the API (an unknown or
  // deleted chat falls back to a fresh conversation with a notice).
  app.get('/chat', (_request, response) => response.redirect(302, '/'));
  app.get('/chat/:id', (_request, response, next) => {
    response.sendFile(join(config.rootDirectory, 'client', 'index.html'), (error) => { if (error) next(error); });
  });
  app.use(express.static(join(config.rootDirectory, 'client'), {
    extensions: ['html'],
    index: 'index.html',
    maxAge: 0,
    etag: true
  }));
  app.use((request, response, next) => {
    if (request.accepts('html')) return response.status(404).sendFile(join(config.rootDirectory, 'client', '404.html'));
    return next(new AppError(404, 'NOT_FOUND', 'Route was not found.'));
  });
  app.use((error, request, response, _next) => {
    const requestId = request.requestId || randomUUID();
    const status = error instanceof AppError ? error.status : error?.type === 'entity.parse.failed' ? 400 : 500;
    const code = error instanceof AppError ? error.code : error?.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'INTERNAL_ERROR';
    const message = error instanceof AppError && error.expose
      ? error.message
      : code === 'INVALID_JSON' ? 'Request body must be valid JSON.' : 'An unexpected server error occurred.';
    if (status >= 500) console.error(JSON.stringify({ event: 'error', requestId, code, name: error?.name, message: error?.message }));
    response.status(status).json({ error: { code, message, requestId } });
  });
  return {
    app,
    db,
    autoTests,
    close: () => {
      autoTests.stop();
      db.close();
    }
  };
}
