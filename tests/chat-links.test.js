import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/app.js';

const listen = (server) => new Promise((resolve) => {
  const listening = server.listen(0, '127.0.0.1', () => resolve(listening));
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'glow-chatlinks-'));
  const instance = createApp({
    rootDirectory: process.cwd(),
    databasePath: join(directory, 'glow.sqlite')
  });
  const server = await listen(instance.app);
  t.after(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); instance.close(); await rm(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('/chat/<id> serves the chat shell so deep links open a conversation', async (t) => {
  const base = await setup(t);
  const deep = await fetch(`${base}/chat/833a0133-b9a2-4c37-9c11-77e1d3a5510d`);
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get('content-type'), /text\/html/u);
  const html = await deep.text();
  assert.match(html, /<title>Glow Agent<\/title>/u, 'the chat page itself is served');
  assert.match(html, /id="chatLog"/u);
  // Every id shape reaches the page; validation belongs to the client against the API.
  const odd = await fetch(`${base}/chat/anything-at-all`);
  assert.equal(odd.status, 200);
});

test('/chat without an id bounces to the fresh-chat home, and unknown routes still 404', async (t) => {
  const base = await setup(t);
  const bounce = await fetch(`${base}/chat`, { redirect: 'manual' });
  assert.equal(bounce.status, 302);
  assert.equal(bounce.headers.get('location'), '/');
  const missing = await fetch(`${base}/no-such-page`, { headers: { Accept: 'text/html' } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /404|not found/iu);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const settings = await fetch(`${base}/settings.html`);
  assert.equal(settings.status, 200);
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
});
