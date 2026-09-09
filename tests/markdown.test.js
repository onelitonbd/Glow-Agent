import assert from 'node:assert/strict';
import test from 'node:test';

class TestNode {
  constructor(tag, text = '') {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.value = text;
    this.classList = {
      values: new Set(),
      add: (...names) => names.forEach((name) => this.classList.values.add(name))
    };
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  set textContent(value) {
    this.value = String(value);
  }

  get textContent() {
    return this.value + this.children.map((child) => child.textContent).join('');
  }
}

globalThis.document = {
  createElement: (tag) => new TestNode(tag),
  createElementNS: (_namespace, tag) => new TestNode(tag),
  createTextNode: (text) => new TestNode('#text', String(text)),
  createDocumentFragment: () => new TestNode('#fragment')
};
globalThis.window = { location: { origin: 'http://localhost:3000' } };

const { renderMarkdown } = await import('../client/assets/js/markdown.js');

function nodesWithTag(node, tag) {
  return [node, ...node.children.flatMap((child) => nodesWithTag(child, tag))].filter((entry) => entry.tag === tag);
}

test('assistant Markdown renders structured text, tables, code, and common LaTeX math without HTML injection', () => {
  const output = renderMarkdown([
    '# Response title',
    '',
    '**Strong** text with `inline code`, [a safe link](https://example.com), and $x^2 + \\frac{1}{2}$.',
    '',
    '- First item',
    '- [x] Completed item',
    '',
    '| Plan | Price |',
    '| :--- | ---: |',
    '| Pro | $12$ |',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '$$\\sqrt{x} = y$$',
    '',
    '<script>window.bad = true</script> [unsafe](javascript:alert(1))'
  ].join('\n'));

  assert.equal(nodesWithTag(output, 'h1').length, 1);
  assert.equal(nodesWithTag(output, 'strong').length, 1);
  assert.equal(nodesWithTag(output, 'code').length, 2);
  assert.equal(nodesWithTag(output, 'ul').length, 1);
  assert.equal(nodesWithTag(output, 'input').length, 1);
  assert.equal(nodesWithTag(output, 'table').length, 1);
  assert.equal(nodesWithTag(output, 'th').length, 2);
  assert.equal(nodesWithTag(output, 'pre').length, 1);
  assert.equal(nodesWithTag(output, 'mfrac').length, 1);
  assert.equal(nodesWithTag(output, 'msup').length, 1);
  assert.equal(nodesWithTag(output, 'msqrt').length, 1);
  const links = nodesWithTag(output, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/');
  assert.equal(nodesWithTag(output, 'script').length, 0);
  assert.match(output.textContent, /<script>window\.bad = true<\/script>/u);
});
