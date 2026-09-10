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
import {
  approvePluginWrites,
  cloneGithubRepo,
  commitGithub,
  configurePlugin,
  connectPlugin,
  createPlugin,
  deletePlugin,
  getPlugin,
  inspectPlugin,
  listPlugins,
  pluginAccount,
  pluginRepositories,
  pushGithub,
  repoDeleteFile,
  repoListFiles,
  repoReadFile,
  repoRenameFile,
  repoWriteFile,
  selectPluginRepo,
  updatePlugin
} from '../services/plugins.js';

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
    success(response, await respondToConversation(db, request.params.conversationId, request.body ?? {}, config.chatTimeoutMs, { rootDirectory: config.rootDirectory, workspaceDirectory: config.workspaceDirectory, fetchTimeoutMs: config.providerFetchTimeoutMs, maxToolRounds: config.maxToolRounds, maxProviderRetries: config.maxProviderRetries }));
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
      await respondToConversationStream(db, request.params.conversationId, request.body ?? {}, config.chatTimeoutMs, emit, { rootDirectory: config.rootDirectory, workspaceDirectory: config.workspaceDirectory, fetchTimeoutMs: config.providerFetchTimeoutMs, maxToolRounds: config.maxToolRounds, maxProviderRetries: config.maxProviderRetries });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.', { expose: true });
      emit('error', { code: appError.code, message: appError.expose ? appError.message : 'An unexpected server error occurred.' });
    } finally {
      response.end();
    }
  });

  // ---- Plugins ----
  router.route('/plugins')
    .get((_request, response) => success(response, listPlugins(db)))
    .post((request, response, next) => {
      try { success(response, createPlugin(db, request.body ?? {}), 201); } catch (error) { next(error); }
    });
  router.route('/plugins/:pluginId')
    .get((request, response, next) => {
      try { success(response, getPlugin(db, request.params.pluginId)); } catch (error) { next(error); }
    })
    .put((request, response, next) => {
      try { success(response, updatePlugin(db, request.params.pluginId, request.body ?? {})); } catch (error) { next(error); }
    })
    .delete((request, response, next) => {
      try { deletePlugin(db, request.params.pluginId); response.status(204).end(); } catch (error) { next(error); }
    });

  // ---- MCP server definition + connection ----
  // Saves the server definition (preset, transport, URL/headers or command/args/env, toolsets).
  router.post('/plugins/:pluginId/config', (request, response, next) => {
    try { success(response, configurePlugin(db, request.params.pluginId, request.body ?? {})); } catch (error) { next(error); }
  });
  // Runs the MCP handshake and tools/list, persists the result, and resolves the GitHub account.
  router.post('/plugins/:pluginId/connect', rateLimit({ windowMs: 60_000, max: 20, code: 'MCP_CONNECT_RATE_LIMITED' }), asyncRoute(async (request, response) => {
    success(response, await connectPlugin(db, request.params.pluginId, request.body && Object.keys(request.body).length ? request.body : null));
  }));
  // Live handshake + tool discovery without changing the stored config.
  router.post('/plugins/:pluginId/inspect', asyncRoute(async (request, response) => {
    success(response, await inspectPlugin(db, request.params.pluginId));
  }));
  // Approves the next batch of mutating MCP tool calls (the "ask before writing" gate).
  router.post('/plugins/:pluginId/writes/approve', asyncRoute(async (request, response) => {
    success(response, approvePluginWrites(db, request.params.pluginId));
  }));

  // ---- GitHub preset (account + repositories, via the server's own MCP tools) ----
  router.post('/plugins/:pluginId/github/me', asyncRoute(async (request, response) => {
    success(response, await pluginAccount(db, request.params.pluginId));
  }));
  router.post('/plugins/:pluginId/github/repos', asyncRoute(async (request, response) => {
    success(response, await pluginRepositories(db, request.params.pluginId, { query: request.body?.query }));
  }));
  router.post('/plugins/:pluginId/github/select', asyncRoute(async (request, response) => {
    success(response, selectPluginRepo(db, request.params.pluginId, request.body ?? {}));
  }));

  // ---- Optional local clone of the selected repository ----
  router.post('/plugins/:pluginId/github/clone', asyncRoute(async (request, response) => {
    success(response, await cloneGithubRepo(db, request.params.pluginId, config.workspaceDirectory));
  }));
  router.post('/plugins/:pluginId/github/commit', asyncRoute(async (request, response) => {
    success(response, await commitGithub(db, request.params.pluginId, config.workspaceDirectory, request.body ?? {}));
  }));
  router.post('/plugins/:pluginId/github/push', asyncRoute(async (request, response) => {
    success(response, await pushGithub(db, request.params.pluginId, config.workspaceDirectory));
  }));
  router.post('/plugins/:pluginId/repo/list', asyncRoute(async (request, response) => {
    success(response, repoListFiles(db, request.params.pluginId, config.workspaceDirectory, request.body?.path ?? ''));
  }));
  router.post('/plugins/:pluginId/repo/read', asyncRoute(async (request, response) => {
    success(response, repoReadFile(db, request.params.pluginId, config.workspaceDirectory, request.body?.path));
  }));
  router.post('/plugins/:pluginId/repo/write', asyncRoute(async (request, response) => {
    success(response, repoWriteFile(db, request.params.pluginId, config.workspaceDirectory, request.body?.path, request.body?.content));
  }));
  router.post('/plugins/:pluginId/repo/rename', asyncRoute(async (request, response) => {
    success(response, repoRenameFile(db, request.params.pluginId, config.workspaceDirectory, request.body?.from, request.body?.to));
  }));
  router.post('/plugins/:pluginId/repo/delete', asyncRoute(async (request, response) => {
    success(response, repoDeleteFile(db, request.params.pluginId, config.workspaceDirectory, request.body?.path));
  }));

  return router;
}
