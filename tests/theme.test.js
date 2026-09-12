import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const storage = new Map([['glow-agent-theme', 'light']]);
const emitted = [];
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  }
};
globalThis.document = {
  documentElement: { dataset: {}, style: {} },
  dispatchEvent: (event) => emitted.push(event)
};
globalThis.CustomEvent = class {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

await import('../client/assets/js/theme.js');

test('theme controller restores, toggles, and persists the selected theme', () => {
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(window.GlowTheme.current(), 'light');
  assert.equal(window.GlowTheme.toggle(), 'dark');
  assert.equal(storage.get('glow-agent-theme'), 'dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(emitted.at(-1).type, 'glow-theme-change');
});

test('every served page loads the shared theme controller before the stylesheet', async () => {
  const clientDirectory = join(process.cwd(), 'client');
  const pages = (await readdir(clientDirectory)).filter((name) => name.endsWith('.html'));
  // logo-showcase.html is PWA logo chooser, also must follow theme pattern
  assert.deepEqual(pages.sort(), ['404.html', 'index.html', 'library.html', 'logo-showcase.html', 'models.html', 'other-settings.html', 'plugins.html', 'providers.html', 'settings.html', 'skills.html', 'testing.html', 'tools.html']);
  for (const page of pages) {
    const markup = await readFile(join(clientDirectory, page), 'utf8');
    assert.ok(markup.indexOf('/assets/js/theme.js') < markup.indexOf('/assets/css/app.css'), `${page} must apply a saved theme before CSS loads`);
  }
});
