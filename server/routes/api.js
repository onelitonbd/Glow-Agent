import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import {
  addSelectedModel,
  createProvider,
  deleteProvider,
  deleteSelectedModel,
  fetchProviderModels,
  getProvider,
  listProviders,
  listSelectedModels,
  updateProvider
} from '../services/providers.js';
import { createSkill, deleteSkill, getSkill, listSkills, updateSkill } from '../services/skills.js';
import { createConversation, getConversation, listConversations, respondToConversation, respondToConversationStream } from '../services/conversations.js';
import { listTools } from '../services/tools.js';

function success(response, data, status = 200) {
  response.status(status).json({ data });
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function rateLimit({ windowMs, max, code }) {
  const buckets = new Map();
  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || 'local';
    const bucket = buckets.get(key) || { startedAt: now, count: 0 };
    if (now - bucket.startedAt >= windowMs) {
      bucket.startedAt = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > max) return next(new AppError(429, code, 'Too many requests. Please wait and try again.'));
    return next();
  };
}

export function createApiRouter({ db, config }) {
  const router = Router();
  router.get('/health', (_request, response) => success(response, {
    status: 'ok', service: 'glow-agent', time: new Date().toISOString()
  }));
  router.get('/tools', (_request, response) => success(response, listTools()));

  router.route('/providers')
    .get((_request, response) => success(response, listProviders(db)))
    .post((request, response, next) => {
      try {
        success(response, createProvider(db, request.body ?? {}), 201);
      } catch (error) { next(error); }
    });
  router.route('/providers/:providerId')
    .get((request, response, next) => {
      try { success(response, getProvider(db, request.params.providerId)); } catch (error) { next(error); }
    })
    .put((request, response, next) => {
      try { success(response, updateProvider(db, request.params.providerId, request.body ?? {})); } catch (error) { next(error); }
    })
    .delete((request, response, next) => {
      try { deleteProvider(db, request.params.providerId); response.status(204).end(); } catch (error) { next(error); }
    });
  router.post('/providers/:providerId/fetch-models', rateLimit({ windowMs: 60_000, max: 12, code: 'MODEL_FETCH_RATE_LIMITED' }), asyncRoute(async (request, response) => {
    success(response, await fetchProviderModels(db, request.params.providerId, config.providerFetchTimeoutMs));
  }));
  router.route('/providers/:providerId/models')
    .get((request, response, next) => {
      try { success(response, listSelectedModels(db, request.params.providerId)); } catch (error) { next(error); }
    })
    .post((request, response, next) => {
      try { success(response, addSelectedModel(db, request.params.providerId, request.body ?? {}), 201); } catch (error) { next(error); }
    });
  router.delete('/providers/:providerId/models/:modelId', (request, response, next) => {
    try { deleteSelectedModel(db, request.params.providerId, request.params.modelId); response.status(204).end(); } catch (error) { next(error); }
  });

  router.route('/skills')
    .get((_request, response) => success(response, listSkills(db)))
    .post((request, response, next) => {
      try { success(response, createSkill(db, request.body ?? {}), 201); } catch (error) { next(error); }
    });
  router.route('/skills/:skillId')
    .get((request, response, next) => {
      try { success(response, getSkill(db, request.params.skillId)); } catch (error) { next(error); }
    })
    .put((request, response, next) => {
      try { success(response, updateSkill(db, request.params.skillId, request.body ?? {})); } catch (error) { next(error); }
    })
    .delete((request, response, next) => {
      try { deleteSkill(db, request.params.skillId); response.status(204).end(); } catch (error) { next(error); }
    });

  router.route('/conversations')
    .get((_request, response) => success(response, listConversations(db)))
    .post((request, response, next) => {
      try { success(response, createConversation(db, request.body ?? {}), 201); } catch (error) { next(error); }
    });
  router.get('/conversations/:conversationId', (request, response, next) => {
    try { success(response, getConversation(db, request.params.conversationId)); } catch (error) { next(error); }
  });
  router.post('/conversations/:conversationId/respond', rateLimit({ windowMs: 60_000, max: 30, code: 'CHAT_RATE_LIMITED' }), asyncRoute(async (request, response) => {
    success(response, await respondToConversation(db, request.params.conversationId, request.body ?? {}, config.chatTimeoutMs));
  }));
  router.post('/conversations/:conversationId/respond/stream', rateLimit({ windowMs: 60_000, max: 30, code: 'CHAT_RATE_LIMITED' }), async (request, response) => {
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders?.();
    const emit = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await respondToConversationStream(db, request.params.conversationId, request.body ?? {}, config.chatTimeoutMs, emit);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.', { expose: true });
      emit('error', { code: appError.code, message: appError.expose ? appError.message : 'An unexpected server error occurred.' });
    } finally {
      response.end();
    }
  });
  return router;
}
