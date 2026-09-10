import { untestedModels, withTestLock, runModelTests, isTestLockBusy, PROBE_STEPS } from './model-tests.js';
import { getSettings } from './settings.js';

// Automatic capability testing.
//
// Adding a model or a provider should not leave the user wondering what it can do: the probes run
// on their own, the report is stored, and the composer reads that report to decide which thinking
// levels and which attachment kinds to offer. This scheduler owns that background work.
//
// It is deliberately a plain queue with one run at a time. Probing costs real provider requests,
// so nothing here runs in parallel, and `withTestLock` keeps it from overlapping a manual run
// started from the Testing page.
export function createAutoTestScheduler({ db, timeoutMs = 20_000, intervalMs = 30_000 } = {}) {
  const queue = [];
  const state = {
    started: false,
    draining: false,
    current: null,
    lastFinishedAt: null,
    lastError: null,
    completedCount: 0
  };
  let timer = null;
  let kick = null;

  const enabled = () => getSettings(db).autoTesting.enabled === true;

  // Always takes a list. Iterating a bare string here would walk its characters and fill the
  // queue with single letters that match no model, which looks exactly like a runner that never
  // gets going.
  function enqueue(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (typeof key === 'string' && key && !queue.includes(key)) queue.push(key);
    }
  }

  // The status the UI polls: what is queued, what is being probed right now, and the setting that
  // governs all of it.
  function status() {
    return {
      enabled: enabled(),
      started: state.started,
      running: state.draining,
      busy: state.draining || isTestLockBusy(),
      current: state.current ? { ...state.current } : null,
      queued: queue.length,
      untested: untestedModels(db).map(({ key, providerName, modelId }) => ({ key, providerName, modelId })),
      lastFinishedAt: state.lastFinishedAt,
      lastError: state.lastError,
      completedCount: state.completedCount,
      steps: PROBE_STEPS.length
    };
  }

  // Called when something changed that makes the stored report incomplete: a model was added, a
  // provider's key or URL was replaced, or a stored result was thrown away.
  function notify(keys = null) {
    if (!state.started || !enabled()) return;
    if (keys) enqueue(keys);
    else for (const model of untestedModels(db)) enqueue(model.key);
    schedule();
  }

  function schedule() {
    if (!state.started || kick || state.draining) return;
    kick = setTimeout(() => {
      kick = null;
      drain().catch((error) => { state.lastError = String(error?.message || error); });
    }, 250);
    kick.unref?.();
  }

  async function drain() {
    if (state.draining) return;
    state.draining = true;
    try {
      while (queue.length > 0 && enabled()) {
        const key = queue.shift();
        // Re-check against the database: a manual run, or a removal, may have handled it already.
        const pending = untestedModels(db);
        const target = pending.find((model) => model.key === key);
        if (!target) continue;
        state.current = { key, providerName: target.providerName, modelId: target.modelId, label: 'Waking the model up', stepIndex: 1, stepTotal: PROBE_STEPS.length };
        try {
          await withTestLock(() => runModelTests(db, {
            timeoutMs,
            only: [key],
            emit: (event, payload) => {
              if (event !== 'progress' || !state.current) return;
              state.current = {
                ...state.current,
                label: payload.label,
                step: payload.step,
                stepIndex: payload.stepIndex,
                stepTotal: payload.stepTotal
              };
            }
          }));
          state.completedCount += 1;
          state.lastError = null;
        } catch (error) {
          // A model that cannot be reached is a result, not a crash: the probe already stored a
          // rejected baseline, so it will not be retried on every tick.
          state.lastError = `${target.modelId}: ${String(error?.message || error)}`;
        }
        state.current = null;
        state.lastFinishedAt = new Date().toISOString();
      }
    } finally {
      state.draining = false;
      // Anything queued while the last model was being probed gets its own pass rather than
      // waiting for the next sweep.
      if (queue.length > 0) schedule();
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    notify();
    // The sweep is the safety net for anything added while the server was down, and for a run that
    // was interrupted mid-way. It costs nothing when the queue is empty.
    timer = setInterval(() => notify(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    state.started = false;
    if (timer) clearInterval(timer);
    if (kick) clearTimeout(kick);
    timer = null;
    kick = null;
    queue.length = 0;
  }

  return { start, stop, notify, status };
}
