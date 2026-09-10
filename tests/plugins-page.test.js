import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDom } from './fixtures/dom.mjs';
import { listPresets } from '../server/services/plugins.js';

const PAGE_HTML = readFileSync(fileURLToPath(new URL('../client/plugins.html', import.meta.url)), 'utf8');

// Loads the real Plugins page script against a seeded DOM and a stubbed API, then returns
// everything needed to drive it: the catalog, the dialog, and every request it made.
async function loadPage({ plugins = [] } = {}) {
  const { document, byId } = createDom(PAGE_HTML);
  const requests = [];
  let nextPluginId = 1;

  const routes = [
    ['GET', '/api/v1/plugins/presets', () => ({ status: 200, data: listPresets() })],
    ['GET', '/api/v1/plugins', () => ({ status: 200, data: plugins })],
    ['POST', '/api/v1/plugins', (body) => {
      const plugin = { id: `plugin-${nextPluginId++}`, type: 'mcp', name: body.name || 'GitHub', enabled: false, config: { preset: body.preset, connected: false } };
      plugins.push(plugin);
      return { status: 201, data: plugin };
    }],
    ['POST', /^\/api\/v1\/plugins\/[\w-]+\/config$/u, (body, url) => ({ status: 200, data: { id: url.split('/')[4], config: body[body.preset] } })],
    ['POST', /^\/api\/v1\/plugins\/[\w-]+\/connect$/u, (body, url) => ({ status: 200, data: { plugin: { id: url.split('/')[4] }, server: { name: 'fixture-mcp', toolCount: 5 } } })]
  ];

  globalThis.document = document;
  globalThis.window = { confirm: () => true };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path, body });
    const route = routes.find(([routeMethod, routePath]) => routeMethod === method && (routePath instanceof RegExp ? routePath.test(path) : routePath === path));
    if (!route) return { status: 404, ok: false, json: async () => ({ error: { message: `No stub for ${method} ${path}` } }) };
    const result = route[2](body, path);
    return { status: result.status, ok: result.status < 400, json: async () => ({ data: result.data }) };
  };

  // The page captures its DOM nodes at import time, so every load needs a fresh module instance.
  await import(`../client/assets/js/plugins.js?load=${Date.now()}-${Math.random()}`);
  // `load()` runs at import time; wait for the catalog to be rendered.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { byId, requests };
}

function controls(form) {
  return form.querySelectorAll('input, select').filter((node) => node.name);
}

test('the setup form is built from the chosen server\'s own fields, not a shared GitHub form', async () => {
  const { byId } = await loadPage();
  const catalog = byId.get('presetState');

  // The catalog is the curated list the server sent, with one Add button per server.
  // One card per shipped server, and only GitHub asks for a credential.
  assert.deepEqual(catalog.querySelectorAll('button').map((button) => button.textContent), ['Set up GitHub', 'Set up Memory', 'Add Sequential Thinking', 'Set up Filesystem']);
  const add = catalog.querySelector('button');
  add.dispatchEvent('click');

  assert.equal(byId.get('presetDialogTitle').textContent, 'Add GitHub');
  const form = byId.get('presetForm');
  const fields = controls(form);
  assert.deepEqual(fields.map((field) => field.name), ['mode', 'token', 'toolsets', 'binary', 'host', 'readOnly', 'localClone']);

  // The credential field for this server is a password, and the page never declares its own
  // GitHub inputs — the HTML ships no server-specific form at all.
  assert.equal(fields.find((field) => field.name === 'token').type, 'password');
  assert.equal(/name="token"|id="token"/u.test(PAGE_HTML), false, 'the page holds no static server form');

  // A field can be scoped to one of another field's values.
  const mode = fields.find((field) => field.name === 'mode');
  const binary = fields.find((field) => field.name === 'binary');
  assert.equal(mode.value, 'remote');
  assert.equal(binary.closest('.field').hidden, true, 'the binary path only applies to the native-binary mode');
  mode.value = 'local-binary';
  form.dispatchEvent('change');
  assert.equal(controls(form).find((field) => field.name === 'binary').closest('.field').hidden, false);
});

test('saving sends only that server\'s settings and keeps a stored credential untouched', async () => {
  const { byId, requests } = await loadPage();
  byId.get('presetState').querySelector('button').dispatchEvent('click');
  const form = byId.get('presetForm');

  const fields = controls(form);
  fields.find((field) => field.name === 'mode').value = 'local-binary';
  fields.find((field) => field.name === 'binary').value = '/usr/local/bin/github-mcp-server';
  fields.find((field) => field.name === 'localClone').checked = true;
  form.dispatchEvent('change');
  form.dispatchEvent('submit');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const create = requests.find((request) => request.method === 'POST' && request.path === '/api/v1/plugins');
  assert.deepEqual(create.body, { type: 'mcp', preset: 'github' });

  const configure = requests.find((request) => request.path.endsWith('/config'));
  assert.equal(configure.body.preset, 'github');
  assert.deepEqual(configure.body.github, {
    mode: 'local-binary',
    toolsets: ['repos', 'users', 'issues', 'pull_requests', 'context'],
    binary: '/usr/local/bin/github-mcp-server',
    host: '',
    readOnly: false,
    localClone: true
  });
  assert.equal('token' in configure.body.github, false, 'an untouched secret is not sent, so the stored one survives');
  assert.equal('url' in configure.body.github, false, 'no generic server field is posted');
  assert.ok(requests.some((request) => request.path.endsWith('/connect')), 'saving connects the server');
});

test('a server with no settings opens a dialog that only has to be connected', async () => {
  const { byId, requests } = await loadPage();
  const thinking = byId.get('presetState').querySelectorAll('button').find((button) => button.textContent === 'Add Sequential Thinking');
  thinking.dispatchEvent('click');

  assert.equal(byId.get('presetDialogTitle').textContent, 'Add Sequential Thinking');
  assert.equal(controls(byId.get('presetForm')).length, 0, 'no credential and no other field is asked for');
  assert.match(byId.get('presetDialogDescription').textContent, /nothing to configure/u);

  byId.get('presetForm').dispatchEvent('submit');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const configure = requests.find((request) => request.path.endsWith('/config'));
  assert.deepEqual(configure.body, { preset: 'sequential-thinking', 'sequential-thinking': {} });
  assert.ok(requests.some((request) => request.path.endsWith('/connect')));
});

test('a server already added cannot be added twice', async () => {
  const { byId } = await loadPage({
    plugins: [{ id: 'p1', type: 'mcp', name: 'GitHub', enabled: true, config: { preset: 'github', connected: true, toolCount: 5, tools: [] } }]
  });
  const add = byId.get('presetState').querySelector('button');
  assert.equal(add.textContent, 'Added');
  assert.equal(add.disabled, true);
});
