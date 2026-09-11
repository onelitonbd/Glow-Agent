// A very small DOM, just enough to load a real page module in Node and inspect what it builds.
//
// The Plugins page builds its setup form at runtime from the field list the server sends, so the
// only way to check that form is to run the page's own code. This shim implements the handful of
// DOM features that module touches (elements, text, attributes, listeners, closest/querySelector,
// and a dialog), and is seeded from the ids the real HTML file declares — so a page that drops an
// id the script needs fails here too.
//
// It is not a browser. It models structure, attributes, and events; it does not do layout, CSS,
// or HTML parsing beyond extracting element ids.

class ClassList {
  constructor(node) {
    this.node = node;
  }

  get #set() {
    return new Set(String(this.node.className || '').split(/\s+/u).filter(Boolean));
  }

  add(...names) {
    const set = this.#set;
    for (const name of names) set.add(name);
    this.node.className = [...set].join(' ');
  }

  remove(...names) {
    const set = this.#set;
    for (const name of names) set.delete(name);
    this.node.className = [...set].join(' ');
  }

  contains(name) {
    return this.#set.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

export class DomNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this._text = '';
    this.className = '';
    this.id = '';
    this.name = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.placeholder = '';
    this.maxLength = null;
    this.autocomplete = '';
    this.htmlFor = '';
    this.title = '';
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.selected = false;
  }

  // Reading text walks the subtree, so a button built from an icon plus a text node still reads
  // as its label.
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string' || typeof node === 'number') {
        const text = new DomNode('#text');
        text.textContent = String(node);
        text.parentNode = this;
        this.children.push(text);
        continue;
      }
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  after(node) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    node.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, node);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(event) {
    const type = typeof event === 'string' ? event : event.type;
    const detail = typeof event === 'string'
      ? { type, preventDefault() {}, stopPropagation() {}, target: this }
      : { preventDefault() {}, stopPropagation() {}, target: this, ...event };
    let node = this;
    // Listeners fire on the target and then bubble to ancestors, like the real DOM.
    while (node) {
      for (const handler of node.listeners.get(type) || []) handler.call(node, detail);
      node = node.parentNode;
    }
    return true;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of walk(this)) {
      if (child !== this && matches(child, selector)) return child;
    }
    return null;
  }

  querySelectorAll(selector) {
    return nodeList([...walk(this)].filter((child) => child !== this && matches(child, selector)));
  }

  focus() {}

  // A real input.click() opens the file dialog; here it just fires the click, which is enough for
  // a page that triggers a hidden picker from a button.
  click() {
    this.dispatchEvent('click');
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent('close');
  }
}

// A NodeList rather than an Array, because that is what a browser returns: it has forEach, is
// iterable, and is indexable — but it has no filter, map, find, some, or every. Returning an
// Array here let page code call .filter on a NodeList and pass every test while throwing in the
// browser, so the shape is now honest and a misuse fails here too.
function nodeList(nodes) {
  const list = {
    length: nodes.length,
    forEach: (callback, thisArg) => nodes.forEach(callback, thisArg),
    item: (index) => nodes[index] ?? null,
    [Symbol.iterator]: () => nodes[Symbol.iterator]()
  };
  nodes.forEach((node, index) => { list[index] = node; });
  return list;
}

function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}

// Supports `tag`, `.class`, `#id`, `tag.class`, and comma-separated lists — all the page's
// queries are that simple.
function matches(node, selector) {
  return String(selector).split(',').map((part) => part.trim()).some((part) => matchesSequence(node, part));
}

// Handles descendant combinators ("details summary") as well as a single compound selector.
function matchesSequence(node, sequence) {
  const parts = sequence.split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return false;
  if (!matchesOne(node, parts.at(-1))) return false;
  let current = node.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    let found = null;
    while (current) {
      if (matchesOne(current, parts[index])) { found = current; break; }
      current = current.parentNode;
    }
    if (!found) return false;
    current = found.parentNode;
  }
  return true;
}

function matchesOne(node, selector) {
  // `'.field'.split(/(?=[.#])/u)` keeps the leading part, so the tag has to be told apart from a
  // class or id by its first character rather than by position.
  const parts = selector.split(/(?=[.#])/u).filter(Boolean);
  const tag = parts.length > 0 && !/^[.#]/u.test(parts[0]) ? parts.shift() : '';
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const part of parts) {
    if (part.startsWith('.') && !node.classList.contains(part.slice(1))) return false;
    if (part.startsWith('#') && node.id !== part.slice(1)) return false;
  }
  return true;
}

export function createDom(html) {
  const root = new DomNode('body');
  const byId = new Map();
  // Seed the ids the real page declares, so a missing id is a test failure rather than a silent
  // no-op in the page script.
  // Walk the open tags, not just the ids: the tag name and the `hidden` attribute are both real
  // things a page depends on, and matching an id without its own tag pairs the wrong elements.
  for (const tag of html.matchAll(/<(\w+)\b([^>]*)>/gu)) {
    const id = /\sid="([\w-]+)"/u.exec(tag[2])?.[1];
    if (!id) continue;
    const node = new DomNode(tag[1]);
    node.id = id;
    // `hidden` is a property the page reads and writes, so seed it from the markup: a page that
    // assumes a panel starts hidden would otherwise pass here and fail in the browser.
    node.hidden = /\shidden(\s|=|$)/u.test(tag[2]);
    byId.set(id, node);
    root.append(node);
  }
  const documentElement = new DomNode('html');
  const document = {
    body: root,
    documentElement,
    createElement: (tag) => new DomNode(tag),
    createElementNS: (_namespace, tag) => new DomNode(tag),
    createDocumentFragment: () => new DomNode('#fragment'),
    createTextNode: (text) => {
      const node = new DomNode('#text');
      node.textContent = String(text);
      return node;
    },
    getElementById: (id) => byId.get(id) || null,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => nodeList([...walk(root)].filter((child) => child !== root && matches(child, selector))),
    addEventListener: (type, handler) => root.addEventListener(type, handler)
  };
  return { document, root, byId, DomNode };
}
