import { api } from './api.js';
import { element, icon } from './ui.js';

const toolsState = document.getElementById('toolsState');

function toolIcon(toolId) {
  return toolId === 'calculator' ? 'calculator' : 'clock';
}

async function load() {
  toolsState.replaceChildren(element('div', 'loading', 'Loading tools'));
  try {
    const tools = await api.tools.list();
    const list = element('div', 'list');
    tools.forEach((tool) => {
      const card = element('article', 'card data-card');
      const top = element('div', 'data-card-top');
      const badge = element('span', 'data-icon violet'); badge.setAttribute('aria-hidden', 'true'); badge.append(icon(toolIcon(tool.id)));
      const copy = element('span'); copy.append(element('b', 'data-name', tool.name), element('span', 'data-subtitle', tool.description));
      top.append(badge, copy);
      const meta = element('div', 'data-meta'); const dot = document.createElement('i');
      meta.append(dot, document.createTextNode('Select in chat to permit this tool for one response'));
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
