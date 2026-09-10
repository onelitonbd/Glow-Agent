import { randomUUID } from 'node:crypto';
import express from 'express';
import { join } from 'node:path';
import { createDatabase } from './db/database.js';
import { AppError } from './lib/errors.js';
import { createApiRouter } from './routes/api.js';
import { createAutoTestScheduler } from './services/auto-tests.js';

export function createApp(config) {
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
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; script-src 'self'"
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
  app.use(express.json({ limit: '64kb', type: 'application/json' }));
  const autoTests = createAutoTestScheduler({
    db,
    timeoutMs: Math.min(config.providerFetchTimeoutMs + 5_000, 30_000),
    intervalMs: config.autoTestIntervalMs
  });
  app.use('/api/v1', createApiRouter({ db, config, autoTests }));
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
