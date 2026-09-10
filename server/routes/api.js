import { Router } from 'express';
import { AppError, notFound, validation } from '../lib/errors.js';
import { approvals } from '../services/approvals.js';
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
import {
  createConversation,
  deleteMessage,
  editMessage,
  getConversation,
  listConversations,
  regenerateMessageStream,
  respondToConversation,
  respondToConversationStream
} from '../services/conversations.js';
import { FILE_MANAGEMENT_TOOL_IDS, SHELL_TOOL_IDS, listTools } from '../services/tools.js';
import { getSettings, updateSettings } from '../services/settings.js';
import {
  capabilityReport,
  forgetModelTest,
  forgetProviderTests,
  isTestLockBusy,
  listTestableModels,
  modelCapabilities,
  modelTestReport,
  runModelTests,
  supportedThinkingLevels,
  THINKING_LEVELS,
  untestedModels,
  withTestLock
} from '../services/model-tests.js';
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
  listPresets,
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

// Server-sent events need their own error path: headers are already on the wire, so a failure is
// reported as an `error` event instead of an HTTP status.
function sseRoute(run) {
  return async (request, response) => {
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders?.();
    const emit = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await run(request, emit);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.', { expose: true });
      emit('error', { code: appError.code, message: appError.expose ? appError.message : 'An unexpected server error occurred.' });
    } finally {
      response.end();
    }
  };
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

export function createApiRouter({ db, config, autoTests = null }) {
  const router = Router();
  router.get('/health', (_request, response) => success(response, {
    status: 'ok', service: 'glow-agent', time: new Date().toISOString()
  }));
  router.get('/tools', (_request, response) => {
    const { developerTools } = getSettings(db);
    success(response, listTools().map((tool) => ({
      ...tool,
      enabled: FILE_MANAGEMENT_TOOL_IDS.includes(tool.id)
        ? developerTools.fileManagement !== false
        : SHELL_TOOL_IDS.includes(tool.id)
          ? developerTools.shell === true
          : true
    })));
  });

  // One-shot approvals for gated tool calls. The chat stream emits a confirmation_required
  // event carrying the approval id; this route is the ONLY way such an approval settles —
  // the model never sees the id and its tool loop stays paused until a decision lands.
  router.post('/approvals/:approvalId', (request, response, next) => {
    try {
      const raw = request.body?.decision;
      const decision = raw === 'approve' ? 'approved' : raw === 'deny' ? 'denied' : null;
      if (!decision) throw validation('Send decision: "approve" or "deny".');
      if (!approvals.decide(request.params.approvalId, decision)) throw notFound('Pending approval');
      success(response, { status: decision });
    } catch (error) {
      next(error);
    }
  });

  router.route('/providers')
    .get((_request, response) => success(response, listProviders(db)))
    .post((request, response, next) => {
      try {
        const provider = createProvider(db, request.body ?? {});
        // A brand-new provider has no models yet, but it may gain them in the same breath.
        autoTests?.notify();
        success(response, provider, 201);
      } catch (error) { next(error); }
    });
  router.route('/providers/:providerId')
    .get((request, response, next) => {
      try { success(response, getProvider(db, request.params.providerId)); } catch (error) { next(error); }
    })
    .put((request, response, next) => {
      try {
        const provider = updateProvider(db, request.params.providerId, request.body ?? {});
        // A new URL or key means every measurement taken against the old one is a guess, so the
        // report is dropped and the automatic runner measures these models again.
        forgetProviderTests(db, provider.id);
        autoTests?.notify();
        success(response, provider);
      } catch (error) { next(error); }
    })
    .delete((request, response, next) => {
      try {
        deleteProvider(db, request.params.providerId);
        autoTests?.notify();
        response.status(204).end();
      } catch (error) { next(error); }
    });
  router.post('/providers/:providerId/fetch-models', rateLimit({ windowMs: 60_000, max: 12, code: 'MODEL_FETCH_RATE_LIMITED' }), asyncRoute(async (request, response) => {
    success(response, await fetchProviderModels(db, request.params.providerId, config.providerFetchTimeoutMs));
  }));
  router.route('/providers/:providerId/models')
    .get((request, response, next) => {
      try { success(response, listSelectedModels(db, request.params.providerId)); } catch (error) { next(error); }
    })
    .post((request, response, next) => {
      try {
        const selected = addSelectedModel(db, request.params.providerId, request.body ?? {});
        // This is the moment a model becomes usable in chat, so it is tested right away rather
        // than waiting for the next sweep. The chat picks the capability up from the report.
        autoTests?.notify([`${request.params.providerId}:${selected.modelId}`]);
        success(response, selected, 201);
      } catch (error) { next(error); }
    });
  router.delete('/providers/:providerId/models/:modelId', (request, response, next) => {
    try {
      const removed = deleteSelectedModel(db, request.params.providerId, request.params.modelId);
      forgetModelTest(db, removed.providerId, removed.modelId);
      autoTests?.notify();
      response.status(204).end();
    } catch (error) { next(error); }
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
  // Workspace preferences. Declared before /conversations so the literal path is unambiguous.
  router.get('/settings', (_request, response) => success(response, getSettings(db)));
  router.put('/settings', (request, response, next) => {
    try {
      const settings = updateSettings(db, request.body ?? {});
      // Switching automatic testing on should test the backlog now, not at the next sweep.
      if (request.body?.autoTesting) autoTests?.notify();
      success(response, settings);
    } catch (error) { next(error); }
  });

  // ---- Model capability testing ----
  // The Testing page gathers every selected model, probes each one, and ranks the results.
  router.get('/tests/models', (_request, response) => success(response, listTestableModels(db)));
  router.get('/tests/levels', (_request, response) => success(response, THINKING_LEVELS));
  router.get('/tests/report', (_request, response) => success(response, modelTestReport(db)));
  // What the composer needs: every selected model, its proven thinking levels, and whether it
  // takes images or files. One request instead of one per model.
  router.get('/tests/capabilities', (_request, response) => success(response, capabilityReport(db)));
  router.get('/tests/capabilities/:providerId/:modelId', (request, response, next) => {
    try { success(response, modelCapabilities(db, request.params.providerId, request.params.modelId)); } catch (error) { next(error); }
  });
  // Is the automatic runner working right now, and on what? The chat and the Testing page poll
  // this so a model that is being probed says so instead of looking untested.
  router.get('/tests/auto', (_request, response) => {
    success(response, autoTests ? autoTests.status() : {
      enabled: getSettings(db).autoTesting.enabled,
      started: false, running: isTestLockBusy(), busy: isTestLockBusy(), current: null, queued: 0,
      untested: untestedModels(db).map(({ key, providerName, modelId }) => ({ key, providerName, modelId })),
      lastFinishedAt: null, lastError: null, completedCount: 0, steps: 9
    });
  });
  // Tests everything that has never been tested, without waiting for the sweep.
  router.post('/tests/auto/run', rateLimit({ windowMs: 60_000, max: 6, code: 'MODEL_TEST_RATE_LIMITED' }), asyncRoute(async (_request, response) => {
    if (!autoTests) throw new AppError(409, 'AUTO_TEST_UNAVAILABLE', 'Automatic testing is not running in this process.', { expose: true });
    autoTests.notify();
    success(response, autoTests.status());
  }));
  router.get('/tests/levels/:providerId/:modelId', (request, response, next) => {
    try { success(response, supportedThinkingLevels(db, request.params.providerId, request.params.modelId)); } catch (error) { next(error); }
  });
  router.post('/tests/run/stream', rateLimit({ windowMs: 60_000, max: 6, code: 'MODEL_TEST_RATE_LIMITED' }), sseRoute(async (request, emit) => {
    const only = Array.isArray(request.body?.models) ? request.body.models.map((key) => String(key)).slice(0, 200) : null;
    // The same lock the automatic runner holds: two runs against one provider would only double
    // the cost and could interleave their results.
    await withTestLock(() => runModelTests(db, { timeoutMs: Math.min(config.providerFetchTimeoutMs + 5_000, 30_000), emit, only }));
  }));

  router.get('/conversations/:conversationId', (request, response, next) => {
    try { success(response, getConversation(db, request.params.conversationId)); } catch (error) { next(error); }
  });
  router.post('/conversations/:conversationId/respond', rateLimit({ windowMs: 60_000, max: 30, code: 'CHAT_RATE_LIMITED' }), asyncRoute(async (request, response) => {
    success(response, await respondToConversation(db, request.params.conversationId, request.body ?? {}, config.chatTimeoutMs, { rootDirectory: config.rootDirectory, workspaceDirectory: config.workspaceDirectory, fetchTimeoutMs: config.providerFetchTimeoutMs, maxToolRounds: config.maxToolRounds, maxProviderRetries: config.maxProviderRetries }));
  }));
  const chatOptions = () => ({
    rootDirectory: config.rootDirectory,
    workspaceDirectory: config.workspaceDirectory,
    fetchTimeoutMs: config.providerFetchTimeoutMs,
    maxToolRounds: config.maxToolRounds,
    maxProviderRetries: config.maxProviderRetries
  });
  router.post('/conversations/:conversationId/respond/stream', rateLimit({ windowMs: 60_000, max: 30, code: 'CHAT_RATE_LIMITED' }), sseRoute(async (request, emit) => {
    await respondToConversationStream(db, request.params.conversationId, request.body ?? {}, config.chatTimeoutMs, emit, chatOptions());
  }));
  // Per-message actions behind the chat bubbles. Deleting a reply takes the question that produced
  // it; editing a question drops the reply it produced; regenerate re-answers a stored question,
  // with the model the caller picks.
  router.route('/conversations/:conversationId/messages/:messageId')
    .delete((request, response, next) => {
      try { success(response, deleteMessage(db, request.params.conversationId, request.params.messageId, request.body ?? {})); } catch (error) { next(error); }
    })
    .put((request, response, next) => {
      try { success(response, editMessage(db, request.params.conversationId, request.params.messageId, request.body ?? {})); } catch (error) { next(error); }
    });
  router.post('/conversations/:conversationId/messages/:messageId/regenerate/stream', rateLimit({ windowMs: 60_000, max: 30, code: 'CHAT_RATE_LIMITED' }), sseRoute(async (request, emit) => {
    await regenerateMessageStream(db, request.params.conversationId, request.params.messageId, request.body ?? {}, config.chatTimeoutMs, emit, chatOptions());
  }));

  // ---- Plugins ----
  // The catalog of MCP servers Glow Agent ships. Declared before /plugins/:pluginId so the
  // literal path is not swallowed by the parameter route.
  router.get('/plugins/presets', (_request, response) => success(response, listPresets()));
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
