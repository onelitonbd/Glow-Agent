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
// Overridable per test so a run can be shown as in flight, then finished.
let autoStatus = { enabled: true, started: true, running: false, busy: false, current: null, queued: 0, untested: [], lastFinishedAt: null, lastError: null, completedCount: 1, steps: 9 };

async function loadChat({ pathname = '/', holdStream = false } = {}) {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  const copied = [];
  const historyCalls = [];
  // Stop-button flow: the held stream never finishes; the signal the page passes lets it die.
  let lastStreamSignal = null;
  let serverPersistedStop = false;
  const windowRef = {
    confirm: () => true,
    location: { origin: 'http://localhost', pathname },
    history: {
      pushState: (_state, _title, url) => { historyCalls.push(['push', url]); windowRef.location.pathname = url; },
      replaceState: (_state, _title, url) => { historyCalls.push(['replace', url]); windowRef.location.pathname = url; }
    }
  };
  globalThis.window = windowRef;
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
  globalThis.window = windowRef;
  globalThis.FileReader = class {
    readAsDataURL(file) {
      setTimeout(() => { this.result = file.dataUrl; this.onload?.(); }, 0);
    }
  };
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
    if (method === 'GET' && path === '/api/v1/conversations/conv-1') {
      const copy = clone();
      // What the real server does on a disconnect: save the partial reply with a stopped marker.
      if (serverPersistedStop) {
        copy.messages.push({ id: 'msg-stopped', role: 'assistant', content: 'Partial answer.', providerId: 'prov-1', modelId: 'alpha', reasoning: '', toolEvents: [], timeline: [{ type: 'content', text: 'Partial answer.' }, { type: 'stopped' }], createdAt: '2026-09-10T10:00:03.000Z' });
      }
      return { status: 200, ok: true, json: async () => ({ data: copy }) };
    }
    // First sends go through this create step; reusing conv-1 keeps the respond/stream stub aligned.
    if (method === 'POST' && path === '/api/v1/conversations') {
      return { status: 201, ok: true, json: async () => ({ data: { id: 'conv-1', title: 'New conversation', createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T10:00:00.000Z', messageCount: 0 } }) };
    }
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
    // The composer's capability view: alpha thinks at three levels and reads images but refuses
    // files; beta has not been probed yet.
    if (method === 'GET' && path === '/api/v1/tests/capabilities') {
      const levels = [
        ['low', 'Low', 'works'], ['medium', 'Medium', 'works'], ['high', 'High', 'works'],
        ['xhigh', 'Extra High', 'rejected'], ['max', 'Max', 'rejected']
      ].map(([id, label, status]) => ({ id, label, value: id, status, reason: `probe: ${status}` }));
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: {
            testedAt: '2026-09-10T08:00:00.000Z',
            levels: levels.map(({ id, label, value }) => ({ id, label, value })),
            models: [
              {
                providerId: 'prov-1', providerName: 'Local', modelId: 'alpha', key: 'prov-1:alpha',
                queued: false, tested: true, testedAt: '2026-09-10T08:00:00.000Z', score: 44,
                levels,
                thinking: { usable: ['low', 'medium', 'high'], best: 'high' },
                images: { status: 'works', usable: true, proved: true, reason: 'The model answered the image: RED' },
                files: { status: 'rejected', usable: false, proved: false, reason: 'file parts are not supported' },
                tools: { status: 'works', usable: true, proved: true, reason: 'The model called ping.' }
              },
              {
                providerId: 'prov-1', providerName: 'Local', modelId: 'beta', key: 'prov-1:beta',
                queued: true, tested: false, testedAt: null, score: null,
                levels: levels.map(({ id, label, value }) => ({ id, label, value, status: 'unknown', reason: '' })),
                thinking: { usable: ['low', 'medium', 'high', 'xhigh', 'max'], best: null },
                images: { status: 'unknown', usable: false, proved: false, reason: '' },
                files: { status: 'unknown', usable: false, proved: false, reason: '' },
                tools: { status: 'unknown', usable: false, proved: false, reason: '' }
              }
            ]
          }
        })
      };
    }
    if (method === 'GET' && path === '/api/v1/tests/auto') {
      return { status: 200, ok: true, json: async () => ({ data: autoStatus }) };
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
    if (method === 'POST' && path === '/api/v1/conversations/conv-1/respond/stream') {
      lastStreamSignal = options.signal || null;
      if (holdStream) {
        // First block arrives, then silence until the page aborts the fetch (the Stop tap).
        const startedBytes = new TextEncoder().encode(`event: started\ndata: ${JSON.stringify({ conversationId: 'conv-1' })}\n\n`);
        let emittedStart = false;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: () => {
                if (!emittedStart) {
                  emittedStart = true;
                  return Promise.resolve({ done: false, value: startedBytes });
                }
                return new Promise((_resolve, reject) => {
                  const fail = () => {
                    serverPersistedStop = true;
                    reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
                  };
                  // The Stop tap can beat this read to it: an already-dead signal never fires again.
                  if (options.signal?.aborted) { fail(); return; }
                  options.signal?.addEventListener('abort', fail, { once: true });
                });
              },
              releaseLock() {}
            })
          }
        };
      }
      // Mirror the server: the question is stored with the attachments that travelled with it.
      conversation.messages.push({
        id: `msg-user-${conversation.messages.length}`,
        role: 'user',
        content: body.message,
        reasoning: '',
        toolEvents: [],
        timeline: null,
        attachments: body.attachments || [],
        createdAt: new Date().toISOString()
      });
      const updated = answer(conversation.messages.at(-1).id, body.modelId);
      return sseResponse([
        ['started', { conversationId: 'conv-1' }],
        ['token', { text: `Answer from ${body.modelId}.` }],
        ['completed', { conversation: updated }]
      ]);
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
  return { byId, requests, copied, conversation, historyCalls, windowRef, document, streamSignal: () => lastStreamSignal };
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
  return [...node.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
}

function actionButton(byId, role, actionId) {
  const bar = [...byId.get('chatLog').querySelectorAll('.message-actions')].find((entry) => entry.classList.contains(role));
  return [...bar.querySelectorAll('button')].find((button) => button.dataset.action === actionId);
}

async function openConversation(byId) {
  byId.get('openHistory').dispatchEvent('click');
  byId.get('conversationList').querySelector('button').dispatchEvent('click');
  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-actions').length === 2);
}

test('an answer offers Regenerate, Copy, Delete, and Try another model', async () => {
  const { byId } = await loadChat();
  await openConversation(byId);
  const bars = [...byId.get('chatLog').querySelectorAll('.message-actions')];
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
  const bars = [...byId.get('chatLog').querySelectorAll('.message-actions')];
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
  const beta = [...byId.get('modelOptions').querySelectorAll('button')].find((button) => button.dataset.modelId === 'beta');
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
  const options = [...byId.get('thinkingOptions').querySelectorAll('button')];
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
  [...byId.get('chatLog').querySelector('.message-editor-actions').querySelectorAll('button')]
    .find((button) => button.dataset.action === 'save-edit').dispatchEvent('click');
  await waitFor(() => requests.some((request) => request.path.endsWith('/regenerate/stream')));
  const edit = requests.find((request) => request.method === 'PUT' && request.path.includes('/messages/'));
  assert.equal(edit.path, '/api/v1/conversations/conv-1/messages/msg-user');
  assert.deepEqual(edit.body, { content: 'Write me a tanka.' });
  const regenerate = requests.find((request) => request.path.endsWith('/regenerate/stream'));
  assert.equal(regenerate.path, '/api/v1/conversations/conv-1/messages/msg-user/regenerate/stream');
  assert.ok(requests.indexOf(edit) < requests.indexOf(regenerate), 'the correction is saved before it is answered again');
});

// ---- The composer follows the capability report ----

function stubFile(name, type, dataUrl, size = 1024) {
  return { name, type, dataUrl, size };
}

test('the attach button offers what the model was proved to take, and refuses the rest with a reason', async () => {
  const { byId } = await loadChat();
  await openConversation(byId);

  byId.get('attachButton').dispatchEvent('click');
  assert.equal(byId.get('attachDialog').open, true);
  const rows = [...byId.get('attachOptions').querySelectorAll('.model-option')];
  assert.deepEqual(rows.map((row) => row.dataset.kind), ['image', 'file']);

  // alpha reads images but refused file parts in testing.
  const image = rows.find((row) => row.dataset.kind === 'image');
  const file = rows.find((row) => row.dataset.kind === 'file');
  assert.equal(image.disabled, false);
  assert.equal(file.disabled, true, 'a proved rejection closes the option');
  assert.match(file.querySelector('.data-subtitle').textContent, /file parts are not supported/u, 'and says why');
  assert.equal(file.querySelector('.chip').textContent, 'Not supported');
  assert.equal(image.querySelector('.chip').textContent, 'Yes');
  assert.match(byId.get('attachHint').textContent, /capability test/u);
});

test('an attached image is sent with the message and shown in the conversation', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);

  byId.get('attachButton').dispatchEvent('click');
  [...byId.get('attachOptions').querySelectorAll('.model-option')]
    .find((row) => row.dataset.kind === 'image').dispatchEvent('click');

  const picker = byId.get('imagePicker');
  picker.files = [stubFile('red.png', 'image/png', 'data:image/png;base64,QUJD', 2048)];
  picker.dispatchEvent('change');
  await new Promise((resolve) => setTimeout(resolve, 60));
  await waitFor(() => byId.get('attachTray').querySelectorAll('.attach-pill').length === 1);

  const pill = byId.get('attachTray').querySelector('.attach-pill');
  assert.equal(pill.querySelector('b').textContent, 'red.png');
  assert.equal(pill.querySelector('.attach-thumb').src, 'data:image/png;base64,QUJD');
  assert.equal(byId.get('attachButton').classList.contains('selected'), true);

  byId.get('messageInput').value = 'What colour is this?';
  byId.get('composer').dispatchEvent('submit');
  await waitFor(() => requests.some((request) => request.path.endsWith('/respond/stream')));

  const sent = requests.find((request) => request.path.endsWith('/respond/stream'));
  assert.equal(sent.body.attachments.length, 1);
  assert.deepEqual(sent.body.attachments[0], {
    kind: 'image', name: 'red.png', mimeType: 'image/png', size: 2048, dataUrl: 'data:image/png;base64,QUJD'
  });
  assert.equal(byId.get('attachTray').hidden, true, 'the tray clears once the message is away');

  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-image').length > 0);
  assert.equal(byId.get('chatLog').querySelector('.message-image').src, 'data:image/png;base64,QUJD');
});

test('a file that is too big is refused before it is attached', async () => {
  const { byId, requests } = await loadChat();
  await openConversation(byId);

  byId.get('attachButton').dispatchEvent('click');
  [...byId.get('attachOptions').querySelectorAll('.model-option')]
    .find((row) => row.dataset.kind === 'image').dispatchEvent('click');

  const picker = byId.get('imagePicker');
  picker.files = [stubFile('huge.png', 'image/png', 'data:image/png;base64,QUJD', 9 * 1024 * 1024)];
  picker.dispatchEvent('change');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(byId.get('attachTray').children.length, 0, 'nothing was attached');
  // The toast is created on demand and hung on the body, not seeded from the page markup.
  const toast = [...document.body.children].find((node) => node.id === 'toast');
  assert.match(toast.textContent, /9 MB/u);
  assert.equal(requests.filter((request) => request.path.endsWith('/respond/stream')).length, 0);
});

test('the model picker labels each model with what the report proved', async () => {
  const { byId } = await loadChat();
  await waitFor(() => byId.get('modelOptions').querySelectorAll('.model-option').length === 2);
  byId.get('openModelPicker').dispatchEvent('click');
  const options = [...byId.get('modelOptions').querySelectorAll('.model-option')];
  assert.deepEqual(options.map((option) => option.dataset.modelId), ['alpha', 'beta']);

  const alpha = options[0];
  assert.match(alpha.querySelector('.data-subtitle').textContent, /thinks to High/u);
  assert.match(alpha.querySelector('.data-subtitle').textContent, /images/u);
  assert.deepEqual([...alpha.querySelectorAll('.chip')].map((node) => `${node.textContent}:${node.className}`), [
    'High:chip ok', 'Images:chip ok', 'Files:chip no'
  ]);

  // beta has not been probed yet, so it says so instead of claiming it can do nothing.
  const beta = options[1];
  assert.match(beta.querySelector('.data-subtitle').textContent, /testing automatically/u);
  assert.deepEqual([...beta.querySelectorAll('.chip')].map((node) => node.textContent), ['Queued']);
});

test('the composer says which model is being tested and picks up the result when it lands', async () => {
  autoStatus = {
    enabled: true, started: true, running: true, busy: true,
    current: { key: 'prov-1:beta', providerName: 'Local', modelId: 'beta', label: 'Image input', stepIndex: 7, stepTotal: 9 },
    queued: 0, untested: [{ key: 'prov-1:beta', providerName: 'Local', modelId: 'beta' }],
    lastFinishedAt: null, lastError: null, completedCount: 0, steps: 9
  };
  try {
    const { byId, requests } = await loadChat();
    const status = byId.get('composerStatus');
    // The status is read after the conversation list, so wait for that request to land.
    await waitFor(() => requests.some((request) => request.path === '/api/v1/tests/auto'));
    await waitFor(() => status.hidden === false);
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /Testing beta — Image input \(7\/9\)/u);
    assert.equal(status.querySelectorAll('.stream-status-dot').length, 1, 'it is marked as live');

    // A model that has not been probed yet offers every level, and says why.
    [...byId.get('modelOptions').querySelectorAll('.model-option')]
      .find((option) => option.dataset.modelId === 'beta')?.dispatchEvent('click');
    byId.get('openModelPicker').dispatchEvent('click');
    [...byId.get('modelOptions').querySelectorAll('.model-option')]
      .find((option) => option.dataset.modelId === 'beta').dispatchEvent('click');
    byId.get('openThinking').dispatchEvent('click');
    assert.match(byId.get('thinkingHint').textContent, /queued for the automatic test/u);
  } finally {
    autoStatus = { enabled: true, started: true, running: false, busy: false, current: null, queued: 0, untested: [], lastFinishedAt: null, lastError: null, completedCount: 1, steps: 9 };
  }
});

// ---- Deep links: every saved chat has its own /chat/<id> address -----------------------------

test('opening /chat/conv-1 directly loads that conversation without touching the drawer', async () => {
  const { byId, requests, document } = await loadChat({ pathname: '/chat/conv-1' });
  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-actions').length === 2);
  assert.equal(byId.get('conversationTitle').textContent, 'Haiku chat');
  assert.equal(document.title, 'Haiku chat — Glow Agent');
  assert.ok(requests.some((request) => request.path === '/api/v1/conversations/conv-1'), 'the id in the URL is fetched');
});

test('a deep link to a missing chat falls back to a fresh screen and corrects the URL', async () => {
  const { byId, historyCalls } = await loadChat({ pathname: '/chat/nope' });
  await waitFor(() => historyCalls.some((call) => call[0] === 'replace' && call[1] === '/'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(byId.get('conversationTitle').textContent, 'New conversation');
});

test('selecting a chat from the drawer pushes its /chat/<id> address', async () => {
  const { byId, historyCalls, windowRef } = await loadChat();
  await openConversation(byId);
  assert.ok(historyCalls.some((call) => call[0] === 'push' && call[1] === '/chat/conv-1'));
  assert.equal(windowRef.location.pathname, '/chat/conv-1', 'the address bar follows the open chat');
});

test('starting a new conversation moves the address back to the chat home', async () => {
  const { byId, historyCalls, windowRef } = await loadChat();
  await openConversation(byId);
  byId.get('newConversation').dispatchEvent('click');
  assert.ok(historyCalls.some((call) => call[0] === 'push' && call[1] === '/'));
  assert.equal(windowRef.location.pathname, '/');
});

test('the first message replaces the fresh address with the new chat’s own link', async () => {
  const { byId, requests, historyCalls } = await loadChat();
  // Sends are only possible once a model is picked; the page waits for that itself, so do the same.
  await waitFor(() => byId.get('openModelPicker').classList.contains('selected'));
  byId.get('messageInput').value = 'Hello there.';
  byId.get('composer').dispatchEvent('submit');
  await waitFor(() => requests.some((request) => request.method === 'POST' && request.path === '/api/v1/conversations'));
  await waitFor(() => historyCalls.some((call) => call[0] === 'replace' && call[1] === '/chat/conv-1'));
});

test('the header link button copies the saved chat’s absolute URL', async () => {
  const { byId, copied } = await loadChat();
  byId.get('copyChatLink').dispatchEvent('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(copied.length, 0, 'an unsaved chat has nothing to copy');
  await openConversation(byId);
  byId.get('copyChatLink').dispatchEvent('click');
  await waitFor(() => copied.length === 1);
  assert.deepEqual(copied, ['http://localhost/chat/conv-1']);
});

// ---- Stop button: the send button turns red and ends the reply mid-stream --------------------

async function sendHeldMessage(byId) {
  await waitFor(() => byId.get('openModelPicker').classList.contains('selected'));
  byId.get('messageInput').value = 'Write something long.';
  byId.get('composer').dispatchEvent('submit');
  await waitFor(() => byId.get('sendMessage').classList.contains('is-stop'));
}

test('while a reply streams, the send button becomes a red Stop button', async () => {
  const { byId } = await loadChat({ holdStream: true });
  await openConversation(byId);
  await sendHeldMessage(byId);
  const send = byId.get('sendMessage');
  assert.equal(send.classList.contains('is-stop'), true);
  assert.equal(send.getAttribute('aria-label'), 'Stop response');
  assert.equal(send.title, 'Stop response');
  assert.equal(send.disabled, false, 'the Stop button must stay tappable during the reply');
});

test('tapping Stop aborts the request, restores the button, and shows the stopped marker', async () => {
  const { byId, streamSignal } = await loadChat({ holdStream: true });
  await openConversation(byId);
  await sendHeldMessage(byId);
  assert.equal(streamSignal().aborted, false);

  byId.get('sendMessage').dispatchEvent('click');
  await waitFor(() => streamSignal().aborted === true);
  await waitFor(() => byId.get('sendMessage').getAttribute('aria-label') === 'Send message');
  assert.equal(byId.get('sendMessage').classList.contains('is-stop'), false, 'the button turns back into Send after stopping');
  await waitFor(() => byId.get('chatLog').querySelectorAll('.message-stopped').length > 0);
  assert.match(byId.get('chatLog').querySelector('.message-stopped').textContent, /Stopped/u);
  // The server-saved partial message settled into history: a regular assistant bubble exists.
  await waitFor(() => byId.get('chatLog').textContent.includes('Partial answer.'));
});

test('a stray Enter submit while a reply streams does not stop it', async () => {
  const { byId, streamSignal } = await loadChat({ holdStream: true });
  await openConversation(byId);
  await sendHeldMessage(byId);
  byId.get('composer').dispatchEvent('submit');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(streamSignal().aborted, false, 'only the button itself stops the reply');
});
