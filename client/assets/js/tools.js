import { api } from './api.js';
import { element, icon, toolIconName } from './ui.js';

const toolsState = document.getElementById('toolsState');

async function load() {
  toolsState.replaceChildren(element('div', 'loading', 'Loading tools'));
  try {
    const tools = await api.tools.list();
    const list = element('div', 'list');
    tools.forEach((tool) => {
      const card = element('article', 'card data-card');
      const top = element('div', 'data-card-top');
      const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon(toolIconName(tool.id)));
      const copy = element('span'); copy.append(element('b', 'data-name', tool.name), element('span', 'data-subtitle', tool.description));
      top.append(badge, copy);
      const meta = element('div', 'data-meta'); const dot = document.createElement('i');
      const off = tool.enabled === false;
      if (off) card.classList.add('tool-disabled');
      meta.append(dot, document.createTextNode(off
        ? 'Disabled — turn it on in Other settings → Developer tools'
        : 'Always offered to the model in chat'));
      card.append(top, meta);
      list.append(card);
    });
    toolsState.replaceChildren(list);
  } catch (error) {
    const empty = element('div', 'empty-state');
    empty.append(element('h2', '', 'Could not load tools'), element('p', '', error.message));
    toolsState.replaceChildren(empty);
  }
}

load();
