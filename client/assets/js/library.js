import { api } from './api.js';
import { element, icon, showToast } from './ui.js';

const state = {
  files: [],
  filter: 'all',
  search: '',
  view: localStorage.getItem('glow-library-view') || 'grid'
};

const libraryState = document.getElementById('libraryState');
const searchInput = document.getElementById('searchInput');
const stats = document.getElementById('stats');
const gridBtn = document.getElementById('gridBtn');
const listBtn = document.getElementById('listBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const previewDialog = document.getElementById('previewDialog');
const previewTitle = document.getElementById('previewTitle');
const previewKicker = document.getElementById('previewKicker');
const previewMedia = document.getElementById('previewMedia');
const previewLink = document.getElementById('previewLink');
const previewDetails = document.getElementById('previewDetails');
const openFileBtn = document.getElementById('openFileBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');

function humanSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function filteredFiles() {
  return state.files.filter(f => {
    if (state.filter !== 'all') {
      if (state.filter === 'file' && ['image','pdf','doc'].includes(f.type)) return false;
      if (state.filter !== 'file' && f.type !== state.filter) return false;
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      return f.originalName.toLowerCase().includes(q) || f.mimeType.toLowerCase().includes(q);
    }
    return true;
  });
}

function fileIcon(type) {
  if (type === 'image') return 'spark';
  if (type === 'pdf') return 'file';
  if (type === 'doc') return 'file';
  return 'paperclip';
}

function renderStats(list) {
  if (!stats) return;
  if (list.length === 0 && state.files.length === 0) { stats.hidden = true; return; }
  stats.hidden = false;
  const totalSize = state.files.reduce((s, f) => s + (f.size || 0), 0);
  stats.textContent = '';
  stats.append(
    Object.assign(element('span'), { innerHTML: `<b>${list.length}</b> shown · <b>${state.files.length}</b> total · <b>${humanSize(totalSize)}</b>` })
  );
}

function renderGrid(files) {
  const grid = element('div', 'lib-grid');
  files.forEach(file => {
    const card = element('div', 'lib-card');
    const preview = element('div', 'lib-card-preview');
    if (file.type === 'image') {
      const img = element('img');
      img.src = api.library.fileUrl(file.id);
      img.alt = file.originalName;
      img.loading = 'lazy';
      preview.append(img);
    } else {
      const ic = element('span', `ph ${file.type}`);
      ic.append(icon(fileIcon(file.type)));
      preview.append(ic);
    }
    const body = element('div', 'lib-card-body');
    const name = element('div', 'lib-card-name', file.originalName);
    name.title = file.originalName;
    const meta = element('div', 'lib-card-meta');
    meta.append(element('span', '', file.type.toUpperCase()), element('span', '', '·'), element('span', '', humanSize(file.size)));
    const actions = element('div', 'lib-card-actions');
    const open = element('a', 'primary');
    open.href = api.library.fileUrl(file.id);
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';
    const details = element('button');
    details.type = 'button';
    details.textContent = 'Details';
    details.addEventListener('click', () => showPreview(file));
    actions.append(open, details);
    body.append(name, meta, actions);
    card.append(preview, body);
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      showPreview(file);
    });
    grid.append(card);
  });
  return grid;
}

function renderList(files) {
  const list = element('div', 'lib-list');
  files.forEach(file => {
    const row = element('div', 'lib-row');
    const iconWrap = element('div', `lib-row-icon ${file.type}`);
    if (file.type === 'image') {
      const img = element('img');
      img.src = api.library.fileUrl(file.id);
      img.alt = file.originalName;
      img.loading = 'lazy';
      iconWrap.append(img);
    } else {
      iconWrap.append(icon(fileIcon(file.type)));
    }
    const main = element('div', 'lib-row-main');
    const name = element('div', 'lib-row-name', file.originalName);
    name.title = file.originalName;
    const sub = element('div', 'lib-row-sub');
    sub.append(
      element('span', '', file.type),
      element('span', '', '·'),
      element('span', '', humanSize(file.size)),
      element('span', '', '·'),
      element('span', '', new Date(file.createdAt).toLocaleDateString())
    );
    main.append(name, sub);
    const actions = element('div', 'lib-row-actions');
    const open = element('a');
    open.href = api.library.fileUrl(file.id);
    open.target = '_blank';
    open.rel = 'noopener';
    open.title = 'Open file';
    open.setAttribute('aria-label', `Open ${file.originalName}`);
    open.append(icon('link'));
    const del = element('button');
    del.type = 'button';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete ${file.originalName}`);
    del.append(icon('trash'));
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${file.originalName}?`)) return;
      try {
        await api.library.remove(file.id);
        state.files = state.files.filter(f => f.id !== file.id);
        render();
        showToast('File deleted.');
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });
    actions.append(open, del);
    row.append(iconWrap, main, actions);
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      showPreview(file);
    });
    list.append(row);
  });
  return list;
}

function renderEmpty() {
  const isFiltered = Boolean(state.search || state.filter !== 'all');
  const empty = element('div', 'empty-state');
  empty.style.minHeight = '360px';
  empty.style.borderStyle = 'dashed';
  const ic = element('span', 'empty-icon');
  ic.append(icon(isFiltered ? 'search' : 'file'));
  const h2 = element('h2', '', isFiltered ? 'No matches' : 'Library is empty');
  const p = element('p', '', isFiltered
    ? 'Try a different search or filter. All photos, PDFs and files you upload will appear here.'
    : 'Upload a file or send a photo, PDF or document to the AI in chat. Every upload gets its own direct link you can open and share.');
  empty.append(ic, h2, p);
  if (state.files.length === 0 && !isFiltered) {
    const btn = element('button', 'button', 'Upload first file');
    btn.type = 'button';
    btn.style.marginTop = '16px';
    btn.addEventListener('click', () => fileInput?.click());
    empty.append(btn);
  }
  return empty;
}

function render() {
  const files = filteredFiles();
  renderStats(files);
  libraryState.replaceChildren();
  if (files.length === 0) {
    libraryState.append(renderEmpty());
    return;
  }
  libraryState.append(state.view === 'grid' ? renderGrid(files) : renderList(files));
}

function syncViewToggle() {
  gridBtn?.classList.toggle('active', state.view === 'grid');
  listBtn?.classList.toggle('active', state.view === 'list');
  localStorage.setItem('glow-library-view', state.view);
}

function showPreview(file) {
  if (!previewDialog) return;
  previewTitle.textContent = file.originalName;
  previewKicker.textContent = `${file.type.toUpperCase()} · ${humanSize(file.size)} · ${file.mimeType}`;
  const url = api.library.fileUrl(file.id);
  const absoluteUrl = `${window.location.origin}${url}`;
  previewLink.href = url;
  previewLink.textContent = absoluteUrl;
  openFileBtn.href = url;
  previewDetails.textContent = `Uploaded ${formatDate(file.createdAt)}${file.conversationId ? ` · From chat ${file.conversationId.slice(0,8)}` : ''} · ID ${file.id} · Stored as ${file.storedName}`;

  previewMedia.replaceChildren();
  previewMedia.hidden = false;
  if (file.type === 'image') {
    const img = element('img');
    img.src = url;
    img.alt = file.originalName;
    previewMedia.append(img);
  } else if (file.type === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.style.width = '100%';
    frame.style.height = '400px';
    frame.style.border = '0';
    frame.title = file.originalName;
    previewMedia.append(frame);
  } else {
    previewMedia.hidden = true;
  }
  previewDialog.showModal();
}

async function loadLibrary() {
  try {
    libraryState.replaceChildren(element('div', 'loading', 'Loading library'));
    state.files = await api.library.list();
    render();
  } catch (err) {
    libraryState.replaceChildren();
    libraryState.append(element('p', 'hint', err.message));
    showToast(err.message, 'danger');
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  for (const file of files) {
    try {
      showToast(`Uploading ${file.name}…`);
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await api.library.upload({ name: file.name, mimeType: file.type || 'application/octet-stream', dataUrl });
      state.files.unshift(uploaded);
      showToast(`${file.name} saved.`);
    } catch (err) {
      showToast(err.message || `Failed to upload ${file.name}`, 'danger');
    }
  }
  render();
}

searchInput?.addEventListener('input', () => { state.search = searchInput.value.trim(); render(); });

document.querySelectorAll('.lib-filters button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lib-filters button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter || 'all';
    render();
  });
});

gridBtn?.addEventListener('click', () => { state.view = 'grid'; syncViewToggle(); render(); });
listBtn?.addEventListener('click', () => { state.view = 'list'; syncViewToggle(); render(); });
uploadBtn?.addEventListener('click', () => fileInput?.click());
fileInput?.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  await uploadFiles(files);
});
copyLinkBtn?.addEventListener('click', async () => {
  const url = previewLink?.href ? `${window.location.origin}${previewLink.getAttribute('href')}` : previewLink?.textContent;
  if (!url) return;
  try { await navigator.clipboard.writeText(url); showToast('Link copied.'); } catch { showToast(`Link: ${url}`); }
});
document.querySelectorAll('[data-close-dialog]').forEach(btn => {
  btn.addEventListener('click', () => { document.getElementById(btn.dataset.closeDialog)?.close(); });
});

let dragCounter = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; document.body.classList.add('drag-over'); });
document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) document.body.classList.remove('drag-over'); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) await uploadFiles(files);
});

syncViewToggle();
loadLibrary();
