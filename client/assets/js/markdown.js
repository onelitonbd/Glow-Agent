const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

function htmlNode(tag, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function mathNode(tag, text = '') {
  const node = document.createElementNS(MATH_NS, tag);
  if (text) node.textContent = text;
  return node;
}

function appendText(parent, text) {
  if (text) parent.append(document.createTextNode(text));
}

function closingIndex(source, marker, from) {
  let index = source.indexOf(marker, from);
  while (index !== -1 && source[index - 1] === '\\') index = source.indexOf(marker, index + marker.length);
  return index;
}

function safeHref(value) {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const greekLetters = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
};

const mathOperators = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  neq: '≠', ne: '≠', approx: '≈', sim: '∼', to: '→', rightarrow: '→', leftarrow: '←',
  infty: '∞', sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇', in: '∈', notin: '∉',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', forall: '∀', exists: '∃', land: '∧', lor: '∨'
};

const mathFunctions = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det', 'gcd']);

function createMath(source, display = false) {
  const input = source.trim().replace(/\r?\n/g, ' ');
  let position = 0;

  const skipWhitespace = () => {
    while (/\s/u.test(input[position] || '')) position += 1;
  };

  const parseGroup = () => {
    skipWhitespace();
    if (input[position] !== '{') return parseAtomWithScripts();
    position += 1;
    const row = mathNode('mrow');
    for (const child of parseSequence('}')) row.append(child);
    if (input[position] === '}') position += 1;
    return row;
  };

  const readTextGroup = () => {
    skipWhitespace();
    if (input[position] !== '{') return '';
    position += 1;
    let depth = 1;
    let text = '';
    while (position < input.length && depth > 0) {
      const character = input[position++];
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      if (depth > 0) text += character;
    }
    return text;
  };

  const parseControl = () => {
    position += 1;
    const matched = input.slice(position).match(/^[A-Za-z]+/u);
    if (!matched) {
      const character = input[position++] || '\\';
      return mathNode(/[+\-=/<>()[\],.;:|]/u.test(character) ? 'mo' : 'mi', character);
    }
    const command = matched[0];
    position += command.length;
    if (command === 'frac') {
      const numerator = parseGroup() || mathNode('mrow');
      const denominator = parseGroup() || mathNode('mrow');
      const fraction = mathNode('mfrac');
      fraction.append(numerator, denominator);
      return fraction;
    }
    if (command === 'sqrt') {
      const radicand = parseGroup() || mathNode('mrow');
      const root = mathNode('msqrt');
      root.append(radicand);
      return root;
    }
    if (command === 'text' || command === 'mathrm' || command === 'operatorname') {
      return mathNode('mtext', readTextGroup());
    }
    if (command === 'left' || command === 'right' || command === 'displaystyle') return null;
    if (Object.hasOwn(greekLetters, command)) return mathNode('mi', greekLetters[command]);
    if (Object.hasOwn(mathOperators, command)) return mathNode('mo', mathOperators[command]);
    if (mathFunctions.has(command)) return mathNode('mi', command);
    return mathNode('mtext', `\\${command}`);
  };

  const parseAtom = () => {
    skipWhitespace();
    if (position >= input.length || input[position] === '}') return null;
    const character = input[position];
    if (character === '\\') return parseControl();
    if (character === '{') return parseGroup();
    if (/\d/u.test(character)) {
      const number = input.slice(position).match(/^\d+(?:\.\d+)?/u)[0];
      position += number.length;
      return mathNode('mn', number);
    }
    position += 1;
    if (/[A-Za-z]/u.test(character)) return mathNode('mi', character);
    if (/[+\-=*/<>|!,:;]/u.test(character)) return mathNode('mo', character);
    return mathNode('mo', character);
  };

  const parseAtomWithScripts = () => {
    let base = parseAtom();
    if (!base) return null;
    let subscript = null;
    let superscript = null;
    while (input[position] === '_' || input[position] === '^') {
      const kind = input[position++];
      const script = parseGroup() || mathNode('mrow');
      if (kind === '_') subscript = script;
      else superscript = script;
    }
    if (subscript && superscript) {
      const scripted = mathNode('msubsup');
      scripted.append(base, subscript, superscript);
      return scripted;
    }
    if (subscript) {
      const scripted = mathNode('msub');
      scripted.append(base, subscript);
      return scripted;
    }
    if (superscript) {
      const scripted = mathNode('msup');
      scripted.append(base, superscript);
      return scripted;
    }
    return base;
  };

  const parseSequence = (stop = '') => {
    const nodes = [];
    while (position < input.length && input[position] !== stop) {
      const atom = parseAtomWithScripts();
      if (atom) nodes.push(atom);
      else if (position < input.length && input[position] !== stop) position += 1;
    }
    return nodes;
  };

  const math = mathNode('math');
  math.classList.add(display ? 'math-display' : 'math-inline');
  math.setAttribute('aria-label', input || 'Mathematical expression');
  if (display) math.setAttribute('display', 'block');
  const row = mathNode('mrow');
  for (const child of parseSequence()) row.append(child);
  math.append(row);
  return math;
}

function appendInline(parent, source) {
  let plain = '';
  const flush = () => {
    appendText(parent, plain);
    plain = '';
  };
  const appendDelimited = (tag, marker, from) => {
    const end = closingIndex(source, marker, from + marker.length);
    if (end === -1) return false;
    flush();
    const node = htmlNode(tag);
    appendInline(node, source.slice(from + marker.length, end));
    parent.append(node);
    return end + marker.length;
  };

  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '\\' && index + 1 < source.length) {
      plain += source[index + 1];
      index += 2;
      continue;
    }
    if (character === '`') {
      const end = closingIndex(source, '`', index + 1);
      if (end !== -1) {
        flush();
        const code = htmlNode('code', 'inline-code');
        code.textContent = source.slice(index + 1, end);
        parent.append(code);
        index = end + 1;
        continue;
      }
    }
    if (character === '$' && source[index + 1] !== '$') {
      const end = closingIndex(source, '$', index + 1);
      if (end !== -1 && end > index + 1) {
        flush();
        parent.append(createMath(source.slice(index + 1, end)));
        index = end + 1;
        continue;
      }
    }
    if (character === '[') {
      const labelEnd = source.indexOf('](', index + 1);
      const urlEnd = labelEnd === -1 ? -1 : closingIndex(source, ')', labelEnd + 2);
      if (labelEnd !== -1 && urlEnd !== -1) {
        const href = safeHref(source.slice(labelEnd + 2, urlEnd).trim().replace(/^<|>$/gu, ''));
        if (href) {
          flush();
          const link = htmlNode('a', 'markdown-link');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          appendInline(link, source.slice(index + 1, labelEnd));
          parent.append(link);
          index = urlEnd + 1;
          continue;
        }
      }
    }
    let delimitedEnd = 0;
    for (const [marker, tag] of [['**', 'strong'], ['__', 'strong'], ['~~', 's'], ['*', 'em'], ['_', 'em']]) {
      if (!source.startsWith(marker, index)) continue;
      delimitedEnd = appendDelimited(tag, marker, index) || 0;
      if (delimitedEnd) break;
    }
    if (delimitedEnd) {
      index = delimitedEnd;
      continue;
    }
    plain += character;
    index += 1;
  }
  flush();
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim());
}

function tableSeparators(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function tableAt(lines, index) {
  return lines[index]?.includes('|') && tableSeparators(lines[index + 1] || '');
}

function blockStart(lines, index) {
  const line = lines[index] || '';
  const trimmed = line.trim();
  return /^```/u.test(trimmed)
    || /^\$\$/u.test(trimmed)
    || /^(#{1,6})\s+/u.test(trimmed)
    || /^\s*(?:[-+*]|\d+\.)\s+/u.test(line)
    || /^\s*>/u.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)
    || tableAt(lines, index);
}

function appendParagraph(fragment, lines) {
  const paragraph = htmlNode('p', 'markdown-paragraph');
  lines.forEach((line, index) => {
    if (index) paragraph.append(htmlNode('br'));
    appendInline(paragraph, line);
  });
  fragment.append(paragraph);
}

function appendList(fragment, lines, start, ordered) {
  const list = htmlNode(ordered ? 'ol' : 'ul', ordered ? 'markdown-list ordered' : 'markdown-list');
  const pattern = ordered ? /^\s*(\d+)\.\s+(.+)$/u : /^\s*[-+*]\s+(.+)$/u;
  let index = start;
  while (index < lines.length) {
    const match = lines[index].match(pattern);
    if (!match) break;
    const item = htmlNode('li');
    const content = ordered ? match[2] : match[1];
    const task = content.match(/^\[([ xX])\]\s+/u);
    if (task) {
      const box = htmlNode('input', 'task-box');
      box.type = 'checkbox';
      box.disabled = true;
      box.checked = task[1].toLowerCase() === 'x';
      item.append(box);
      appendInline(item, content.slice(task[0].length));
    } else {
      appendInline(item, content);
    }
    list.append(item);
    index += 1;
  }
  fragment.append(list);
  return index;
}

function appendTable(fragment, lines, start) {
  const headers = tableCells(lines[start]);
  const alignments = tableCells(lines[start + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
  const wrap = htmlNode('div', 'markdown-table-wrap');
  const table = htmlNode('table', 'markdown-table');
  const head = htmlNode('thead');
  const headRow = htmlNode('tr');
  headers.forEach((header, column) => {
    const cell = htmlNode('th');
    cell.scope = 'col';
    cell.style.textAlign = alignments[column] || 'left';
    appendInline(cell, header);
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);
  const body = htmlNode('tbody');
  let index = start + 2;
  let rows = 0;
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    const cells = tableCells(lines[index]);
    const row = htmlNode('tr');
    headers.forEach((_header, column) => {
      const cell = htmlNode('td');
      cell.style.textAlign = alignments[column] || 'left';
      appendInline(cell, cells[column] || '');
      row.append(cell);
    });
    body.append(row);
    index += 1;
    rows += 1;
    if (rows >= 200) break;
  }
  table.append(body);
  wrap.append(table);
  fragment.append(wrap);
  return index;
}

function appendCodeBlock(fragment, lines, start) {
  const language = lines[start].trim().slice(3).trim().replace(/[^a-zA-Z0-9_+.-]/gu, '').slice(0, 30);
  const block = htmlNode('div', 'markdown-code-block');
  if (language) {
    const label = htmlNode('span', 'code-language');
    label.textContent = language;
    block.append(label);
  }
  const pre = htmlNode('pre');
  const code = htmlNode('code');
  let index = start + 1;
  const content = [];
  while (index < lines.length && !/^\s*```/u.test(lines[index])) {
    content.push(lines[index]);
    index += 1;
  }
  code.textContent = content.join('\n');
  pre.append(code);
  block.append(pre);
  fragment.append(block);
  return index < lines.length ? index + 1 : index;
}

function appendMathBlock(fragment, lines, start) {
  const opening = lines[start].trim();
  let expression = opening.slice(2);
  let index = start + 1;
  const closingOnLine = expression.indexOf('$$');
  if (closingOnLine !== -1) {
    expression = expression.slice(0, closingOnLine);
  } else {
    const parts = [expression];
    while (index < lines.length) {
      const closeAt = lines[index].indexOf('$$');
      if (closeAt !== -1) {
        parts.push(lines[index].slice(0, closeAt));
        index += 1;
        break;
      }
      parts.push(lines[index]);
      index += 1;
    }
    expression = parts.join('\n');
  }
  const block = htmlNode('div', 'markdown-math-block');
  block.append(createMath(expression, true));
  fragment.append(block);
  return index;
}

export function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown || '').replace(/\r\n?/gu, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (/^```/u.test(trimmed)) {
      index = appendCodeBlock(fragment, lines, index);
      continue;
    }
    if (/^\$\$/u.test(trimmed)) {
      index = appendMathBlock(fragment, lines, index);
      continue;
    }
    if (tableAt(lines, index)) {
      index = appendTable(fragment, lines, index);
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const level = heading[1].length;
      const node = htmlNode(`h${level}`, `markdown-heading markdown-heading-${level}`);
      appendInline(node, heading[2]);
      fragment.append(node);
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      fragment.append(htmlNode('hr', 'markdown-rule'));
      index += 1;
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const quote = htmlNode('blockquote', 'markdown-quote');
      const quoteLines = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/u, ''));
        index += 1;
      }
      appendParagraph(quote, quoteLines);
      fragment.append(quote);
      continue;
    }
    if (/^\s*[-+*]\s+/u.test(line)) {
      index = appendList(fragment, lines, index, false);
      continue;
    }
    if (/^\s*\d+\.\s+/u.test(line)) {
      index = appendList(fragment, lines, index, true);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraphLines.length && blockStart(lines, index)) break;
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(fragment, paragraphLines);
  }
  return fragment;
}
