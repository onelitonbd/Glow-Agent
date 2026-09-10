import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDom } from './fixtures/dom.mjs';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../client/index.html', import.meta.url)), 'utf8');

function sseResponse(events) {
  const payload = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(payload) };
          },
          releaseLock() {}
        };
      }
    }
  };
}

// Loads the real chat page script against a seeded DOM and an in-memory conversation, then returns
// the handles needed to drive it: the log, the model dialog, the requests it made, the clipboard.
async function loadChat() {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  const copied = [];
  const conversation = {
    id: 'conv-1',
    title: 'Haiku chat',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:02.000Z',
    messageCount: 2,
    messages: [
      { id: 'msg-user', role: 'user', content: 'Write me a haiku.', reasoning: '', toolEvents: [], timeline: null, createdAt: '2026-09-10T10:00:00.000Z' },
      { id: 'msg-ai', role: 'assistant', content: 'Quiet morning rain.', providerId: 'prov-1', modelId: 'alpha', reasoning: '', toolEvents: [], timeline: null, createdAt: '2026-09-10T10:00:01.000Z' }
    ]
  };
  const clone = () => JSON.parse(JSON.stringify(conversation));
  // Mirrors the server: an answer goes with the question that produced it, and a regenerate
  // replaces every answer after that question.
  const answer = (questionId, model) => {
    const question = conversation.messages.find((entry) => entry.id === questionId);
    const index = conversation.messages.indexOf(question);
    conversation.messages.splice(index + 1);
    conversation.messages.push({
      id: `msg-ai-${model}`,
      role: 'assistant',
      content: `Answer from ${model}.`,
      providerId: 'prov-1',
      modelId: model,
      reasoning: '',
      toolEvents: [],
      timeline: null,
      createdAt: new Date().toISOString()
    });
    return clone();
  };

  globalThis.document = document;
  globalThis.window = { confirm: () => true, location: { origin: 'http://localhost' } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { clipboard: { writeText: async (value) => { copied.push(value); } } }
  });
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, body });
    const messagePath = path.match(/^\/api\/v1\/conversations\/conv-1\/messages\/([\w-]+)$/u);
    const regeneratePath = path.match(/^\/api\/v1\/conversations\/conv-1\/messages\/([\w-]+)\/regenerate\/stream$/u);
    if (method === 'GET' && path === '/api/v1/conversations') return { status: 200, ok: true, json: async () => ({ data: [{ id: 'conv-1', title: 'Haiku chat', messageCount: 2 }] }) };
    if (method === 'GET' && path === '/api/v1/conversations/conv-1') return { status: 200, ok: true, json: async () => ({ data: clone() }) };
    if (method === 'GET' && path === '/api/v1/skills') return { status: 200, ok: true, json: async () => ({ data: [] }) };
    if (method === 'GET' && path === '/api/v1/tools') return { status: 200, ok: true, json: async () => ({ data: [] }) };
    if (method === 'GET' && path === '/api/v1/plugins') return { status: 200, ok: true, json: async () => ({ data: [] }) };
    if (method === 'GET' && path === '/api/v1/providers') return { status: 200, ok: true, json: async () => ({ data: [{ id: 'prov-1', name: 'Local' }] }) };
    if (method === 'GET' && path === '/api/v1/providers/prov-1/models') return { status: 200, ok: true, json: async () => ({ data: [{ modelId: 'alpha' }, { modelId: 'beta' }] }) };
    // What the Testing page proved about alpha: three thinking levels work, two were refused.
    if (method === 'GET' && path === '/api/v1/tests/report') {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: {
            testedAt: '2026-09-10T08:00:00.000Z',
            levels: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'xhigh', label: 'Extra High', value: 'xhigh' },
              { id: 'max', label: 'Max', value: 'max' }
            ],
            entries: [{
              providerId: 'prov-1',
              providerName: 'Local',
              modelId: 'alpha',
              key: 'prov-1:alpha',
              rank: 1,
              score: 44,
              testedAt: '2026-09-10T08:00:00.000Z',
              results: {
                baseline: { status: 'works', ms: 120, reason: 'READY' },
                thinking: {
                  low: { status: 'works', reason: 'The model returned reasoning text.' },
                  medium: { status: 'works', reason: 'The model returned reasoning text.' },
                  high: { status: 'works', reason: 'The model returned reasoning text.' },
                  xhigh: { status: 'rejected', reason: 'unknown reasoning_effort xhigh' },
                  max: { status: 'rejected', reason: 'unknown reasoning_effort max' }
                },
                vision: { status: 'works', reason: 'The model answered the image: RED' },
                files: { status: 'rejected', reason: 'file parts are not supported' },
                tools: { status: 'works', reason: 'The model called ping.' }
              }
            }]
          }
        })
      };
    }
    if (method === 'DELETE' && messagePath) {
      const target = conversation.messages.find((entry) => entry.id === messagePath[1]);
      const index = conversation.messages.indexOf(target);
      conversation.messages.splice(index - 1, 2);
      return { status: 200, ok: true, json: async () => ({ data: clone() }) };
    }
    if (method === 'PUT' && messagePath) {
      const target = conversation.messages.find((entry) => entry.id === messagePath[1]);
      target.content = body.content;
      conversation.messages.splice(conversation.messages.indexOf(target) + 1);
      return { status: 200, ok: true, json: async () => ({ data: clone() }) };
    }
    if (method === 'POST' && regeneratePath) {
      const updated = answer(regeneratePath[1], body.modelId);
      return sseResponse([
        ['status', { tone: 'info', text: 'Waiting for the model…' }],
        ['started', { conversationId: 'conv-1' }],
        ['token', { text: `Answer from ${body.modelId}.` }],
        ['completed', { conversation: updated }]
      ]);
    }
    return { status: 404, ok: false, json: async () => ({ error: { message: `No stub for ${method} ${path}` } }) };
  };

  await import(`../client/assets/js/chat.js?load=${Date.now()}-${Math.random()}`);
  await waitFor(() => byId.get('conversationList').children.length > 0);
  return { byId, requests, copied, conversation };
}

async function waitFor(condition, ms = 2_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the page to catch up.');
}

// The buttons are icon-only, so their names live in aria-label, not in text.
function labels(node) {
  return node.querySelectorAll('button').map((button) => button.getAttribute('aria-label'));
}

function actionButton(byId, role, actionId) {
  const bar = byId.get('chatLog').querySelectorAll('.message-actions').find((entry) => entry.classList.contains(role));
  return bar.querySelectorAll('button').find((button) => button.dataset.action === actionId);
}

async function openConversation(byId) {
  byId.get('openHistory').dispatchEvent('click');
  byId.get('conversationList').querySelector('button').dispatchEvent('click');
  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-actions').length === 2);
}

test('an answer offers Regenerate, Copy, Delete, and Try another model', async () => {
  const { byId } = await loadChat();
  await openConversation(byId);
  const bars = byId.get('chatLog').querySelectorAll('.message-actions');
  assert.deepEqual(bars.map((bar) => bar.className), ['message-actions user', 'message-actions assistant']);
  assert.deepEqual(labels(bars[1]), ['Regenerate', 'Copy', 'Delete', 'Try another model']);
  // Icons only: nothing but the svg is rendered inside a button.
  const regenerate = bars[1].querySelectorAll('button')[0];
  assert.equal(regenerate.textContent, '');
  assert.deepEqual(regenerate.children.map((child) => child.tagName), ['SVG']);
  assert.equal(regenerate.title, 'Regenerate');
});

test('a question offers Regenerate, Copy, and Edit, and copying uses the clipboard', async () => {
  const { byId, copied } = await loadChat();
  await openConversation(byId);
  const bars = byId.get('chatLog').querySelectorAll('.message-actions');
  assert.deepEqual(labels(bars[0]), ['Regenerate', 'Copy', 'Edit']);
  actionButton(byId, 'user', 'copy').dispatchEvent('click');
  await waitFor(() => copied.length === 1);
  assert.deepEqual(copied, ['Write me a haiku.']);
});

test('Regenerate on a question re-answers that question', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);
  actionButton(byId, 'user', 'regenerate').dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path.endsWith('/regenerate/stream')));
  const regenerate = requests.find((request) => request.path.endsWith('/regenerate/stream'));
  assert.equal(regenerate.path, '/api/v1/conversations/conv-1/messages/msg-user/regenerate/stream');
  assert.equal(regenerate.body.modelId, 'alpha');
  await waitFor(() => byId.get('chatLog').textContent.includes('Answer from alpha.'));
  assert.equal(byId.get('chatLog').querySelectorAll('.message.user').length, 1, 'the question is answered again, not duplicated');
});

test('Delete on an answer asks once more, then removes the pair', async () => {
  const { byId, requests, conversation } = await loadChat();
  await openConversation(byId);
  const remove = actionButton(byId, 'assistant', 'delete');
  remove.dispatchEvent('click');
  assert.equal(remove.classList.contains('confirming'), true, 'the first tap only arms the button');
  assert.equal(remove.getAttribute('aria-label'), 'Tap again to delete', 'the armed state is announced');
  assert.equal(requests.some((request) => request.method === 'DELETE'), false);
  remove.dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.method === 'DELETE'));
  const sent = requests.find((request) => request.method === 'DELETE');
  assert.equal(sent.path, '/api/v1/conversations/conv-1/messages/msg-ai');
  assert.deepEqual(sent.body, { withQuestion: true });
  await waitFor(() => conversation.messages.length === 0);
  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-actions').length === 0);
});

test('Try another model opens the picker and re-answers with the chosen model', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);
  actionButton(byId, 'assistant', 'other-model').dispatchEvent('click');
  assert.equal(byId.get('modelDialog').open, true);
  assert.equal(byId.get('modelDialogTitle').textContent, 'Answer with another model');
  assert.match(byId.get('modelPickerHint').textContent, /answer that message again/u);
  const beta = byId.get('modelOptions').querySelectorAll('button').find((button) => button.dataset.modelId === 'beta');
  beta.dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path.endsWith('/regenerate/stream')));
  const regenerate = requests.find((request) => request.path.endsWith('/regenerate/stream'));
  assert.equal(regenerate.method, 'POST');
  assert.equal(regenerate.path, '/api/v1/conversations/conv-1/messages/msg-user/regenerate/stream');
  assert.equal(regenerate.body.modelId, 'beta');
  // The question stays on screen; only the answer is replaced.
  await waitFor(() => byId.get('chatLog').textContent.includes('Answer from beta.'));
  assert.equal(byId.get('chatLog').textContent.includes('Write me a haiku.'), true);
});

test('Regenerate re-answers the same question with the model already selected', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);
  actionButton(byId, 'assistant', 'regenerate').dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path.endsWith('/regenerate/stream')));
  const regenerate = requests.find((request) => request.path.endsWith('/regenerate/stream'));
  assert.equal(regenerate.path, '/api/v1/conversations/conv-1/messages/msg-user/regenerate/stream');
  assert.equal(regenerate.body.modelId, 'alpha');
  assert.equal(regenerate.body.providerId, 'prov-1');
  assert.deepEqual(regenerate.body.toolIds, []);
  // No new question is written: the log still holds exactly one of them.
  await waitFor(() => byId.get('chatLog').textContent.includes('Answer from alpha.'));
  assert.equal(byId.get('chatLog').querySelectorAll('.message.user').length, 1);
});

test('the thinking button lists the levels the test proved, and sends the chosen one', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);
  byId.get('openThinking').dispatchEvent('click');
  assert.equal(byId.get('thinkingDialog').open, true);
  const options = byId.get('thinkingOptions').querySelectorAll('button');
  // Off first, then the proven levels, then the refused ones — not the ladder's own order.
  assert.deepEqual(options.map((option) => option.querySelector('b').textContent), ['Off', 'Low', 'Medium', 'High', 'Extra High', 'Max']);
  const refused = options.find((option) => option.dataset.level === 'xhigh');
  assert.equal(refused.querySelector('.chip').textContent, 'Not supported');
  assert.match(byId.get('thinkingHint').textContent, /Tested/u, 'the hint says when the model was probed');

  options.find((option) => option.dataset.level === 'high').dispatchEvent('click');
  assert.equal(byId.get('thinkingDialog').open, false);
  assert.equal(byId.get('openThinking').title, 'Thinking level: High');

  actionButton(byId, 'assistant', 'regenerate').dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path.endsWith('/regenerate/stream')));
  assert.equal(requests.find((request) => request.path.endsWith('/regenerate/stream')).body.thinkingLevel, 'high');
});

test('Edit replaces the bubble with a field and re-sends the corrected message', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);
  actionButton(byId, 'user', 'edit').dispatchEvent('click');
  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-editor').length === 1);
  const field = byId.get('chatLog').querySelector('.message-editor-input');
  assert.equal(field.value, 'Write me a haiku.');
  field.value = 'Write me a tanka.';
  byId.get('chatLog').querySelector('.message-editor-actions').querySelectorAll('button')
    .find((button) => button.dataset.action === 'save-edit').dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path.endsWith('/regenerate/stream')));
  const edit = requests.find((request) => request.method === 'PUT');
  assert.equal(edit.path, '/api/v1/conversations/conv-1/messages/msg-user');
  assert.deepEqual(edit.body, { content: 'Write me a tanka.' });
  const regenerate = requests.find((request) => request.path.endsWith('/regenerate/stream'));
  assert.equal(regenerate.path, '/api/v1/conversations/conv-1/messages/msg-user/regenerate/stream');
  assert.ok(requests.indexOf(edit) < requests.indexOf(regenerate), 'the correction is saved before it is answered again');
});
