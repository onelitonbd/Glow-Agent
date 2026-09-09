import { api } from './api.js';
import { element, icon, iconButton, showToast } from './ui.js';

const state = { skills: [], editingId: null, activeMenuId: null };
const skillsState = document.getElementById('skillsState');
const count = document.getElementById('skillsCount');
const dialog = document.getElementById('skillDialog');
const form = document.getElementById('skillForm');
const dialogTitle = document.getElementById('skillDialogTitle');
const saveSkill = document.getElementById('saveSkill');
const nameInput = document.getElementById('skillName');
const descriptionInput = document.getElementById('skillDescription');
const instructionsInput = document.getElementById('skillInstructions');
let dialogOpener = document.getElementById('openSkillDialog');

function openDialog(opener, skill = null) {
  dialogOpener = opener;
  state.editingId = skill?.id || null;
  dialogTitle.textContent = skill ? 'Configure skill' : 'Add skill';
  saveSkill.textContent = skill ? 'Save changes' : 'Save skill';
  if (skill) {
    nameInput.value = skill.name;
    descriptionInput.value = skill.description;
    instructionsInput.value = skill.instructions;
  } else {
    form.reset();
  }
  dialog.showModal();
  setTimeout(() => nameInput.focus(), 20);
}

function closeDialog() {
  dialog.close();
  dialogOpener?.focus();
}

function actionMenu(skill, shell) {
  const menu = element('div', 'overflow-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Actions for ${skill.name}`);
  const configure = element('button', '', 'Configure');
  configure.type = 'button'; configure.setAttribute('role', 'menuitem'); configure.prepend(icon('pencil'));
  configure.addEventListener('click', () => {
    state.activeMenuId = null;
    render();
    openDialog(document.querySelector(`[data-skill-menu="${skill.id}"]`), skill);
  });
  const remove = element('button', 'menu-danger', 'Delete');
  remove.type = 'button'; remove.setAttribute('role', 'menuitem'); remove.prepend(icon('trash'));
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await api.skills.remove(skill.id);
      state.activeMenuId = null;
      await load();
      showToast('Skill deleted.');
    } catch (error) {
      remove.disabled = false;
      showToast(error.message, 'danger');
    }
  });
  menu.append(configure, remove);
  shell.append(menu);
}

function skillCard(skill) {
  const shell = element('div', `list-shell${state.activeMenuId === skill.id ? ' menu-open' : ''}`);
  const card = element('article', 'card data-card');
  const top = element('div', 'data-card-top');
  const skillIcon = element('span', 'data-icon');
  skillIcon.setAttribute('aria-hidden', 'true'); skillIcon.append(icon('spark'));
  const copy = element('span');
  copy.append(element('b', 'data-name', skill.name), element('span', 'data-subtitle', skill.description));
  const menuButton = iconButton('more', `Actions for ${skill.name}`);
  menuButton.dataset.skillMenu = skill.id;
  menuButton.setAttribute('aria-haspopup', 'menu');
  menuButton.setAttribute('aria-expanded', String(state.activeMenuId === skill.id));
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    state.activeMenuId = state.activeMenuId === skill.id ? null : skill.id;
    render();
    if (state.activeMenuId === skill.id) requestAnimationFrame(() => document.querySelector('.overflow-menu button')?.focus());
  });
  top.append(skillIcon, copy, menuButton);
  const meta = element('div', 'data-meta');
  const dot = document.createElement('i');
  meta.append(dot, document.createTextNode('Instructions ready'));
  card.append(top, meta);
  shell.append(card);
  if (state.activeMenuId === skill.id) actionMenu(skill, shell);
  return shell;
}

function render() {
  skillsState.replaceChildren();
  count.textContent = `${state.skills.length} ${state.skills.length === 1 ? 'skill' : 'skills'}`;
  if (state.skills.length === 0) {
    const empty = element('div', 'empty-state');
    const mark = element('span', 'empty-icon'); mark.setAttribute('aria-hidden', 'true'); mark.append(icon('spark'));
    const add = element('button', 'button full', 'Add your first skill'); add.type = 'button'; add.prepend(icon('plus'));
    add.addEventListener('click', () => openDialog(add));
    empty.append(mark, element('h2', '', 'No skills yet'), element('p', '', 'Add reusable instructions that you can select in a chat.'), add);
    skillsState.append(empty);
    return;
  }
  const list = element('div', 'list');
  state.skills.forEach((skill) => list.append(skillCard(skill)));
  const add = element('button', 'button secondary full', 'Add another skill'); add.type = 'button'; add.prepend(icon('plus'));
  add.addEventListener('click', () => openDialog(add));
  list.append(add);
  skillsState.append(list);
}

async function load() {
  skillsState.replaceChildren(element('div', 'loading', 'Loading skills'));
  try {
    state.skills = await api.skills.list();
    render();
  } catch (error) {
    const empty = element('div', 'empty-state');
    const retry = element('button', 'button secondary full', 'Try again'); retry.type = 'button'; retry.addEventListener('click', load);
    empty.append(element('h2', '', 'Could not load skills'), element('p', '', error.message), retry);
    skillsState.append(empty);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = { name: nameInput.value, description: descriptionInput.value, instructions: instructionsInput.value };
  const editing = Boolean(state.editingId);
  saveSkill.disabled = true; saveSkill.textContent = 'Saving…';
  try {
    if (editing) await api.skills.update(state.editingId, values);
    else await api.skills.create(values);
    closeDialog();
    await load();
    showToast(editing ? 'Skill updated.' : 'Skill saved.');
  } catch (error) {
    showToast(error.message, 'danger');
  } finally {
    saveSkill.disabled = false; saveSkill.textContent = editing ? 'Save changes' : 'Save skill';
  }
});

document.getElementById('openSkillDialog').addEventListener('click', (event) => openDialog(event.currentTarget));
document.getElementById('closeSkillDialog').addEventListener('click', closeDialog);
document.getElementById('cancelSkill').addEventListener('click', closeDialog);
dialog.addEventListener('cancel', () => setTimeout(() => dialogOpener?.focus(), 0));
document.addEventListener('click', (event) => {
  if (state.activeMenuId && !event.target.closest('.list-shell')) {
    state.activeMenuId = null;
    render();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dialog.open && state.activeMenuId) {
    state.activeMenuId = null;
    render();
  }
});
load();
