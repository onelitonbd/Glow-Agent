export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name) {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrowLeft: '<path d="m15 18-6-6 6-6"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m-7 4v7m4-7v7m4-7v7M6 6l1 15h10l1-15"/>',
    spark: '<path d="m12 3-1.91 5.81a2 2 0 0 1-1.28 1.28L3 12l5.81 1.91a2 2 0 0 1 1.28 1.28L12 21l1.91-5.81a2 2 0 0 1 1.28-1.28L21 12l-5.81-1.91a2 2 0 0 1-1.28-1.28L12 3Z"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    paperclip: '<path d="m21.4 11.6-8.7 8.7a6 6 0 0 1-8.5-8.5l9.1-9.1a4 4 0 0 1 5.7 5.7l-9.1 9.1a2 2 0 0 1-2.8-2.8l8.4-8.4"/>',
    settings: '<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.2 2.2-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V20.4h-3.1v-.11a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06-2.2-2.2.06-.06A1.7 1.7 0 0 0 6.78 15a1.7 1.7 0 0 0-1.56-1.03h-.11v-3.1h.11A1.7 1.7 0 0 0 6.78 9.84a1.7 1.7 0 0 0-.34-1.87l-.06-.06 2.2-2.2.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1.03-1.56v-.11h3.1v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06 2.2 2.2-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.03h.11v3.1h-.11A1.7 1.7 0 0 0 19.4 15Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon: '<path d="M20.7 15.1A8.5 8.5 0 0 1 8.9 3.3 8.5 8.5 0 1 0 20.7 15.1Z"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.2-2.8-.4-.4-2.8Z"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M21 4v5h-5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    calculator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
    plug: '<path d="M14 6.5a2.5 2.5 0 0 1 5 0V9h2v4h-2v3.5a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2V14h2.5a2.5 2.5 0 0 0 0-5H2.5V6a2 2 0 0 1 2-2H9v2.5a2.5 2.5 0 0 1 5 0Z"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/>',
    filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><path d="M9 15h6"/><path d="M12 12v6"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    square: '<path d="M8.5 8.5h7v7h-7z"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[name] || '';
  return svg;
}

export function iconButton(iconName, label, className = '') {
  const button = element('button', `icon-button ${className}`.trim());
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(iconName));
  return button;
}

// Shared tool-id → icon mapping so the chat timeline and the tools page agree on how each
// capability looks (previously every non-calculator tool fell back to a clock or spark).
export function toolIconName(toolId) {
  const id = typeof toolId === 'string' ? toolId : '';
  const direct = {
    calculator: 'calculator',
    current_time: 'clock',
    list_files: 'folder',
    read_file: 'file',
    write_file: 'pencil',
    edit_file: 'pencil',
    create_file: 'filePlus',
    create_folder: 'folderPlus',
    delete_file: 'trash',
    delete_folder: 'trash',
    rename_file: 'pencil',
    rename_folder: 'pencil',
    run_shell: 'terminal',
    sql_query: 'database',
    web_search: 'search',
    fetch_url: 'globe',
    read_skill: 'spark',
    search_conversations: 'history',
    read_conversation: 'history'
  };
  if (direct[id]) return direct[id];
  if (id.startsWith('github_') || id.startsWith('mcp_') || id.startsWith('github')) return 'plug';
  return 'spark';
}

let toastTimer;
export function showToast(message, tone = 'default') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = element('div', 'toast');
    toast.id = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

export function setButtonBusy(button, busy, busyText = 'Working…') {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || button.textContent;
  }
}

export function formatDate(isoDate) {
  const date = new Date(isoDate);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
