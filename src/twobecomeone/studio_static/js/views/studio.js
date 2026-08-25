// views/studio.js — Studio view.
//
// Phase 5 (Task 2): persisted project header (name/rename, recent-project
// switcher, New mix, confirmed Delete) plus serialized autosave status. Deck
// slots now persist through the ProjectManager; deck controls, waveforms,
// cues, and the plan arrive in Tasks 3–6. Phase 4 placeholder is retired.

import { createElement } from '../dom.js';
import { openSourcePicker } from '../components/source-picker.js';
import { confirmDialog, openDialog } from '../components/dialog.js';
import { showToast } from '../components/toast.js';
import { store, projectManager } from '../app-context.js';

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

function slotSummaryCard(slot, label, state) {
  const project = state.currentProject || {};
  const trackId = slot === 'anchor' ? project.anchor_track_id : project.lead_track_id;
  const resolved = trackId ? state.deckTracks[trackId] : null;
  const track = resolved || state.library.items.find((t) => t.id === trackId) || null;

  const title = createElement('div', { class: 'slot-card__title', text: label });
  let trackText = 'No track selected';
  if (trackId && !track) {
    trackText = 'Track unavailable (missing or trashed)';
  } else if (track) {
    trackText = track.name;
  }
  const trackEl = createElement('div', { class: 'slot-card__track', text: trackText });
  const chooseBtn = createElement('button', {
    class: 'button', type: 'button',
    text: track ? 'Replace' : 'Choose',
    onclick: () => openSourcePicker(store, slot),
  });
  const actions = [chooseBtn];
  if (trackId) {
    actions.push(createElement('button', {
      class: 'button', type: 'button', text: 'Clear',
      onclick: () => projectManager.clear(slot),
    }));
  }
  return createElement('div', { class: `slot-card slot-card--${slot}` }, [
    title, trackEl,
    createElement('div', { class: 'slot-card__actions' }, actions),
  ]);
}

export function mountStudio({ container }) {
  const render = (state) => {
    const swapBtn = createElement('button', {
      class: 'button', type: 'button', text: 'Swap decks',
      disabled:
        !(state.currentProject?.anchor_track_id && state.currentProject?.lead_track_id)
          ? 'true'
          : null,
      onclick: () => projectManager.swap(),
    });

    const retryBtn = state.save.status === 'error'
      ? createElement('button', {
          class: 'button', type: 'button', text: 'Retry save',
          onclick: () => projectManager.retry(),
        })
      : null;

    container.replaceChildren(
      createElement('div', { class: 'studio' }, [
        projectHeader(),
        retryBtn,
        createElement('div', { class: 'slot-summary' }, [
          slotSummaryCard('anchor', 'Foundation', state),
          swapBtn,
          slotSummaryCard('lead', 'Lead', state),
        ]),
      ]),
    );
  };

  const refresh = () => render(store.getState());
  const subs = [
    store.subscribeSlice('currentProject', refresh),
    store.subscribeSlice('deckTracks', refresh),
    store.subscribeSlice('library', refresh),
    store.subscribeSlice('save', refresh),
  ];
  render(store.getState());

  return () => {
    for (const unsub of subs) unsub();
    // Flush pending autosave when leaving the Studio view where practical.
    projectManager.flushNow();
  };
}
