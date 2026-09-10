import { randomUUID } from 'node:crypto';

export const APPROVAL_TIMEOUT_MS = 120_000;

// One-shot, in-memory pending approvals for gated tool calls (currently shell commands). An
// approval exists only while a live chat stream is paused on it — nothing is persisted, and
// every entry settles exactly once: the user decides, the timer expires it, or the conversation
// is aborted. The model can never settle an approval itself; only the HTTP route can.
export function createApprovalStore({ timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
  const pending = new Map();

  function create(meta) {
    const id = randomUUID();
    let resolveWait;
    const wait = new Promise((resolve) => { resolveWait = resolve; });
    const entry = { id, ...meta, settle: null, resolve: resolveWait, timer: null };
    entry.timer = setTimeout(() => settle(id, 'expired'), timeoutMs);
    pending.set(id, entry);
    return { id, wait };
  }

  function settle(id, outcome) {
    const entry = pending.get(id);
    if (!entry || entry.settle) return false;
    entry.settle = outcome;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(outcome);
    return true;
  }

  function decide(id, outcome) {
    if (!['approved', 'denied'].includes(outcome)) return false;
    return settle(id, outcome);
  }

  function abortConversation(conversationId) {
    let count = 0;
    for (const entry of pending.values()) {
      if (entry.conversationId === conversationId) {
        settle(entry.id, 'aborted');
        count += 1;
      }
    }
    return count;
  }

  return { create, decide, abortConversation, size: () => pending.size };
}

// Process-wide store: the conversation engine creates approvals and the HTTP route decides
// them, so both sides share one instance.
export const approvals = createApprovalStore();
