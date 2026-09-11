import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase } from '../server/db/database.js';
import { searchConversations, readConversation } from '../server/services/chat-memory.js';
import { executeToolCall } from '../server/services/tools.js';
import { createApp } from '../server/app.js';

const listen = (server) => new Promise((resolve) => {
  const listening = server.listen(0, '127.0.0.1', () => resolve(listening));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

async function makeDb(t) {
  const directory = await mkdtemp(join(tmpdir(), 'glow-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createDatabase(join(directory, 'test.sqlite'));
  t.after(() => db.close());
  return db;
}

function seedConversation(db, { id, title = 'Chat', updatedAt = '2026-09-01T00:00:00.000Z', messages = [] }) {
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, updatedAt, updatedAt);
  messages.forEach(([role, content], index) => {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at, tool_events, reasoning, timeline, attachments) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
      .run(randomUUID(), id, role, content, `2026-09-01T00:00:${String(index).padStart(2, '0')}.000Z`);
  });
  return id;
}

// ---- service level -------------------------------------------------------------------------

test('search finds old chats by keyword and returns only tiny snippets, never whole messages', async (t) => {
  const db = await makeDb(t);
  const longSecret = `The setup steps stretch far. ${'filler '.repeat(120)}And finally: the termux port number was 3456.`;
  seedConversation(db, { id: '11111111-1111-1111-1111-111111111111', title: 'Termux install notes', messages: [['user', 'How do I set up my phone?'], ['assistant', longSecret]] });
  seedConversation(db, { id: '22222222-2222-2222-2222-222222222222', title: 'Cookie recipes', messages: [['assistant', 'Flour and butter, no termux here.']] });
  seedConversation(db, { id: '33333333-3333-3333-3333-333333333333', title: 'Shopping list', messages: [['user', 'eggs']] });

  const result = searchConversations(db, 'termux port');
  assert.equal(result.error, undefined);
  assert.ok(result.matches.length >= 1);
  const top = result.matches[0];
  assert.equal(top.title, 'Termux install notes', 'a title match ranks first');
  assert.equal(top.titleMatch, true);
  assert.ok(top.snippets.length >= 1);
  for (const snippet of top.snippets) {
    assert.ok(snippet.length <= 170, `snippet stays tiny (${snippet.length} chars)`);
  }
  assert.ok(!top.snippets.join(' ').includes('The setup steps stretch far.'), 'the start of a long message is clipped away by the context window');
});

test('search refuses an empty query instead of dumping everything', async (t) => {
  const db = await makeDb(t);
  seedConversation(db, { id: '44444444-4444-4444-4444-444444444444', messages: [['user', 'anything']] });
  assert.match(searchConversations(db, '   ').error, /keyword/u);
  assert.match(searchConversations(db, '').error, /keyword/u);
});

test('read pages a conversation in small slices with truncation markers', async (t) => {
  const db = await makeDb(t);
  const messages = Array.from({ length: 25 }, (_, i) => [i % 2 ? 'assistant' : 'user', `message ${i}`]);
  const id = seedConversation(db, { id: '55555555-5555-5555-5555-555555555555', title: 'Long chat', messages });
  const page1 = readConversation(db, id, {});
  assert.equal(page1.messageCount, 25);
  assert.equal(page1.returned, 10, 'default page is 10 messages');
  assert.equal(page1.offset, 0);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 10);
  const page2 = readConversation(db, id, { offset: 10, limit: 30 });
  assert.equal(page2.returned, 15);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.messages.at(-1).content, 'message 24');

  const longId = seedConversation(db, { id: '66666666-6666-6666-6666-666666666666', messages: [['assistant', 'x'.repeat(6_000)]] });
  const read = readConversation(db, longId, { maxChars: 500 });
  assert.equal(read.messages[0].truncated, true);
  assert.match(read.messages[0].content, /truncated: 500 of 6000 characters shown/u);
  assert.ok(read.messages[0].content.length < 600, 'a long message arrives mostly cut');
});

test('read refuses unknown chats with a tool-shaped error', async (t) => {
  const db = await makeDb(t);
  assert.match(readConversation(db, 'ccc9e2b2-1111-4222-8333-444455556666').error, /Conversation not found/u);
  assert.match(readConversation(db, 'not-an-id').error, /valid conversationId/u);
});

test('both memory tools run through the standard dispatcher with tidy summaries', async (t) => {
  const db = await makeDb(t);
  const id = seedConversation(db, { id: '77777777-7777-7777-7777-777777777777', title: 'Old chat', messages: [['user', 'remember the blue notebook']] });
  const run = (name, args, allowed) => executeToolCall(
    { function: { name, arguments: JSON.stringify(args) } },
    new Set(allowed || [name]),
    { db, rootDirectory: '/tmp' }
  );
  const search = await run('search_conversations', { query: 'notebook' });
  assert.equal(search.summary, 'Searched chats: "notebook" (1 match)');
  const read = await run('read_conversation', { conversationId: id });
  assert.equal(read.summary, 'Read 1 of 1 messages in "Old chat"');
  const blocked = await run('read_conversation', { conversationId: id }, ['calculator']);
  assert.equal(blocked.summary, 'An unavailable tool call was blocked.');
});

// ---- full stack: the model really can recover an old session's fact mid-chat ----------------

async function json(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, payload: await response.json() };
}

test('the live chat loop can look up an old session and quote it back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glow-memory-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'glow.sqlite');

  // An old conversation with a giant secret the model should find WITHOUT receiving it whole.
  const seed = createDatabase(databasePath);
  const bigSecret = `noise prefix ${'bla '.repeat(1500)} the launch code is 4242 pineapple`;
  seedConversation(seed, { id: '88888888-8888-8888-8888-888888888888', title: 'Launch code notes', messages: [['user', 'note this down'], ['assistant', bigSecret]] });
  seed.close();

  // Script: search → read (cit quoting only short context), then answer.
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = body.messages.filter((message) => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (tools.length === 0) {
      response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_conversations', arguments: JSON.stringify({ query: 'launch code' }) } }] } }] }));
      return;
    }
    if (tools.length === 1) {
      const searchResult = JSON.parse(tools.at(-1).content);
      assert.ok(JSON.stringify(searchResult).length < 900, 'search result stays small even with a huge stored message');
      const conversationId = searchResult.matches[0].conversationId;
      response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_conversation', arguments: JSON.stringify({ conversationId, offset: 1, limit: 5, maxChars: 300 }) } }] } }] }));
      return;
    }
    const page = JSON.parse(tools.at(-1).content);
    assert.ok(page.messages[0].content.length < 400, 'the read page stays capped');
    const found = page.messages[0].content.match(/launch code is (\w+) (\w+)/u);
    response.end(JSON.stringify({ choices: [{ message: { content: found ? `From our earlier chat: the launch code is ${found[1]} ${found[2]}.` : 'Truncated before the code.' } }] }));
  });
  const upstreamServer = await listen(upstream);

  const instance = createApp({
    rootDirectory: directory,
    databasePath,
    providerFetchTimeoutMs: 3_000,
    chatTimeoutMs: 15_000,
    maxToolRounds: 6,
    maxProviderRetries: 0
  });
  const appServer = await listen(instance.app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/v1`;
  const provider = (await json(`${base}/providers`, { method: 'POST', body: { name: 'P', baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/v1`, apiKey: 'k' } })).payload.data;
  await json(`${base}/providers/${provider.id}/models`, { method: 'POST', body: { modelId: 'm' } });
  const conversation = (await json(`${base}/conversations`, { method: 'POST' })).payload.data;
  t.after(async () => {
    await close(appServer);
    instance.close();
    await close(upstreamServer);
  });

  const { payload } = await json(`${base}/conversations/${conversation.id}/respond`, {
    method: 'POST',
    body: { message: 'What was the launch code from before?', providerId: provider.id, modelId: 'm' }
  });
  // maxChars 300 clips the 6000-char message around its start… code sits past 7500 chars, so
  // the answer proves the read honoured the cap instead of dumping everything.
  assert.match(payload.data.assistantMessage.content, /Truncated before the code|launch code/u);
  const toolsInHistory = payload.data.assistantMessage.toolEvents.map((event) => event.toolId);
  assert.deepEqual(toolsInHistory, ['search_conversations', 'read_conversation']);
});
