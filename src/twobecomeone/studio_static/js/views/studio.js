// views/studio.js — Studio view with dual decks, waveforms, cue controls, and exact arrangement plan.
//
// Phase 5:
// - Persisted project header (name, autosave status, New mix, switch, delete).
// - Foundation (Anchor) and Lead Decks with full audio transports, responsive DPR waveforms,
//   seekable playheads, beat snapping, and explicit cue setting.
// - Analysis correction modal and Stem separation modal with truthful tray.
// - Grouped arrangement controls (Timing, Harmony, Mix) and exact server-authored plan.

import { createElement, replaceChildren } from '../dom.js';
import { confirmDialog, openDialog } from '../components/dialog.js';
import { showToast } from '../components/toast.js';
import { store, projectManager } from '../app-context.js';
import { mountDeck } from '../components/deck.js';
import { mountPlan } from '../components/plan.js';

function saveStatusLabel(save) {
  if (save.status === 'saving') return 'Saving…';
  if (save.status === 'saved') return 'Saved locally';
  if (save.status === 'error') return save.lastError || 'Save failed';
  return '';
}

function projectHeader() {
  const state = store.getState();
  const project = state.currentProject;
  const nameBtn = createElement('button', {
    class: 'project-title', type: 'button',
    'aria-label': 'Rename project',
    text: project ? project.name : 'Untitled mix',
    onclick: () => renameProject(nameBtn),
  });
  const statusEl = createElement('span', {
    class: 'save-status', role: 'status', 'aria-live': 'polite',
    text: saveStatusLabel(state.save),
  });

  const newBtn = createElement('button', {
    class: 'button', type: 'button', text: 'New mix',
    onclick: async () => {
      try {
        await projectManager.newProject();
        showToast('New mix created.', 'success');
      } catch (err) {
        showToast(err.message, 'danger');
      }
    },
  });
  const switchBtn = createElement('button', {
    class: 'button', type: 'button', text: 'Projects',
    onclick: () => openSwitcher(),
  });
  const deleteBtn = createElement('button', {
    class: 'button button--danger', type: 'button', text: 'Delete project',
    onclick: async () => {
      const current = store.getState().currentProject;
      if (!current) return;
      const ok = await confirmDialog({
        title: 'Delete project?',
        description: `This deletes “${current.name}” only. Its tracks stay in your library.`,
        confirmLabel: 'Delete project',
        danger: true,
        trigger: deleteBtn,
      });
      if (!ok) return;
      try {
        await projectManager.delete(current.id);
        showToast('Project deleted.', 'success');
      } catch (err) {
        showToast(err.message, 'danger');
      }
    },
  });

  return createElement('header', { class: 'project-header' }, [
    nameBtn, statusEl,
    createElement('div', { class: 'project-header__actions' }, [newBtn, switchBtn, deleteBtn]),
  ]);
}

async function renameProject(trigger) {
  const project = store.getState().currentProject;
  if (!project) return;
  const input = createElement('input', {
    class: 'input', type: 'text', value: project.name,
    'aria-label': 'Project name', maxLength: '200',
  });
  const value = await openDialog({
    title: 'Rename project',
    body: [input],
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Rename', value: 'save', kind: 'primary' },
    ],
    trigger,
  });
  if (value === 'save' && input.value.trim()) {
    projectManager.rename(input.value.trim());
  }
}

async function openSwitcher() {
  const projects = await projectManager.refreshList();
  const current = store.getState().currentProject;
  const list = createElement('div', { class: 'project-list', role: 'list' });
  for (const p of projects) {
    const isCurrent = current && p.id === current.id;
    list.appendChild(createElement('div', { class: 'project-list__row', role: 'listitem' }, [
      createElement('span', {
        class: 'project-list__name',
        text: isCurrent ? `${p.name} (current)` : p.name,
      }),
      isCurrent
        ? createElement('span', { class: 'picker__hint', text: '' })
        : createElement('button', {
            class: 'button', type: 'button', text: 'Open',
            onclick: async () => {
              try {
                await projectManager.switchTo(p.id);
                showToast(`Opened “${p.name}”.`, 'success');
              } catch (err) {
                showToast(err.message, 'danger');
              }
            },
          }),
    ]));
  }
  if (projects.length === 0) {
    list.appendChild(createElement('p', { text: 'No projects yet.' }));
  }
  await openDialog({
    title: 'Recent mixes',
    body: [list],
    actions: [{ label: 'Close', value: 'close' }],
  });
}

export function mountStudio({ container }) {
  const disposers = [];
  let anchorDisposer = null;
  let leadDisposer = null;
  let planDisposer = null;

  const studioRoot = createElement('div', { class: 'studio' });
  container.replaceChildren(studioRoot);

  const headerContainer = createElement('div', { class: 'studio__header-container' });
  const liveAnnouncer = createElement('div', {
    class: 'sr-only',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  const onAnnounce = (msg) => {
    liveAnnouncer.textContent = msg;
  };

  const retryContainer = createElement('div', { class: 'studio__retry-container' });
  const decksContainer = createElement('div', { class: 'studio__decks' });
  const swapBar = createElement('div', { class: 'studio__swap-bar' });
  const planContainer = createElement('div', { class: 'studio__plan-container' });

  const anchorDeckMount = createElement('div', { class: 'deck-slot deck-slot--anchor' });
  const leadDeckMount = createElement('div', { class: 'deck-slot deck-slot--lead' });

  decksContainer.appendChild(anchorDeckMount);
  decksContainer.appendChild(leadDeckMount);

  studioRoot.appendChild(headerContainer);
  studioRoot.appendChild(liveAnnouncer);
  studioRoot.appendChild(retryContainer);
  studioRoot.appendChild(swapBar);
  studioRoot.appendChild(decksContainer);
  studioRoot.appendChild(planContainer);

  function updateHeader() {
    replaceChildren(headerContainer, [projectHeader()]);

    const state = store.getState();
    if (state.save.status === 'error') {
      replaceChildren(retryContainer, [
        createElement('button', {
          class: 'button button--danger',
          type: 'button',
          text: 'Retry save',
          onclick: () => projectManager.retry(),
        }),
      ]);
    } else {
      replaceChildren(retryContainer, []);
    }

    const canSwap = Boolean(state.currentProject?.anchor_track_id && state.currentProject?.lead_track_id);
    const swapBtn = createElement('button', {
      class: 'button',
      type: 'button',
      text: '⇄ Swap Foundation & Lead',
      disabled: canSwap ? null : 'true',
      onclick: () => {
        projectManager.swap();
        showToast('Swapped Foundation and Lead decks.', 'success');
        onAnnounce('Swapped Foundation and Lead decks.');
      },
    });
    replaceChildren(swapBar, [swapBtn]);
  }

  // Mount decks
  anchorDisposer = mountDeck({ container: anchorDeckMount, role: 'anchor', onAnnounce });
  leadDisposer = mountDeck({ container: leadDeckMount, role: 'lead', onAnnounce });
  planDisposer = mountPlan({ container: planContainer, store });

  updateHeader();

  const unsubSave = store.subscribeSlice('save', updateHeader);
  const unsubProject = store.subscribeSlice('currentProject', updateHeader);
  disposers.push(unsubSave, unsubProject);

  return function dispose() {
    for (const d of disposers) d();
    if (anchorDisposer) anchorDisposer();
    if (leadDisposer) leadDisposer();
    if (planDisposer) planDisposer();
    projectManager.flushNow();
  };
}
