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
import { store, projectManager, ghostController, stemStackController, liveMixer } from '../app-context.js';
import { mountDeck } from '../components/deck.js';
import { mountPlan } from '../components/plan.js';
import { mountRenderActions } from '../components/render-actions.js';
import { mountGhostCard } from '../components/ghost-card.js';
import { mountCommittedLayers } from '../components/committed-layers.js';
import { mountPerformanceDeck } from '../components/performance-deck.js';
import { mountStemCratePanel } from '../components/stem-crate-panel.js';
import { mountStemDeskPanel } from '../components/stem-desk-panel.js';
import { openSourcePicker } from '../components/source-picker.js';
import { mountLiveCrossfader } from '../components/live-crossfader.js';
import { mountUrlQueuePanel } from '../components/url-queue-panel.js';
import { mountDawCommandBar } from '../components/daw-command-bar.js';
import { mountArrangementPanel } from '../components/arrangement-panel.js';
import { mountArrangementProducer } from '../components/arrangement-producer.js';
import { RealtimeEngine } from '../realtime-engine.js';
import { renderOffline } from '../arrangement/offline-render.js';
import { get, listStems, listTracks } from '../api.js';
import { startMashupSession } from '../mashup/session.js';
import {
  checkGhostPreconditions,
  ensureVocalsStemKnown,
  openGhostPhraseDialog,
} from '../components/ghost-phrase.js';

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

export function mountStudio({ container, railHost = null }) {
  const disposers = [];
  let anchorDisposer = null;
  let leadDisposer = null;
  let planDisposer = null;
  let renderActionsDisposer = null;
  let ghostCardDisposer = null;
  let committedLayersDisposer = null;
  let performanceDeckDisposer = null;
  let crateDisposer = null;
  let stemDeskDisposer = null;
  let liveCrossfaderDisposer = null;
  let queueDisposer = null;
  let dawDisposer = null;
  let mashupSession = null;

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
  const performanceDeckContainer = createElement('div', { class: 'studio__performance-deck-container' });
  const crateMount = createElement('div', { class: 'studio__stem-crate', hidden: 'true' });
  const stemDeskMount = createElement('div', { class: 'studio__stem-desk' });
  const decksContainer = createElement('div', { class: 'studio__decks' });
  const swapBar = createElement('div', { class: 'studio__swap-bar' });
  const crossfaderContainer = createElement('div', { class: 'studio__crossfader-container' });
  // Phase 10C: the Ghost status card sits between decks and plan so the
  // truthful state is visible in the natural flow.
  const ghostCardContainer = createElement('div', { class: 'studio__ghost-card-container' });
  const committedLayersContainer = createElement('div', { class: 'studio__committed-layers-container' });
  const planContainer = createElement('div', { class: 'studio__plan-container' });
  const renderActionsContainer = createElement('div', { class: 'studio__render-actions-container' });

  const anchorDeckMount = createElement('div', { class: 'deck-slot deck-slot--anchor' });
  const leadDeckMount = createElement('div', { class: 'deck-slot deck-slot--lead' });

  decksContainer.appendChild(anchorDeckMount);
  decksContainer.appendChild(leadDeckMount);

  // OPERATION FULL HOUSE: two surfaces share the Studio. Performance is the
  // accepted eight-channel desk; Arrangement is the non-linear editor. The
  // choice is remembered, and #/studio/arrangement opens the editor directly.
  const performanceView = createElement('div', { class: 'studio__surface studio__surface--performance' });
  const arrangementView = createElement('div', { class: 'studio__surface studio__surface--arrangement', hidden: 'true' });
  const surfaceButtons = {};
  const surfaceSwitch = createElement('div', { class: 'surface-switch', role: 'group', 'aria-label': 'Studio surface' },
    [['performance', 'Performance'], ['arrangement', 'Arrangement']].map(([key, label]) => {
      const button = createElement('button', {
        type: 'button', class: 'surface-switch__button', 'aria-pressed': 'false', text: label,
        dataset: { surface: key },
      });
      button.addEventListener('click', () => showSurface(key, true));
      surfaceButtons[key] = button;
      return button;
    }));
  let arrangementApi = null;
  function showSurface(key, remember = false) {
    const surface = key === 'arrangement' ? 'arrangement' : 'performance';
    performanceView.hidden = surface !== 'performance';
    arrangementView.hidden = surface !== 'arrangement';
    for (const [k, b] of Object.entries(surfaceButtons)) b.setAttribute('aria-pressed', String(k === surface));
    studioRoot.dataset.surface = surface;
    window.dispatchEvent(new CustomEvent('twobecomeone:studio-surface', { detail: { surface } }));
    if (surface === 'arrangement' && !arrangementApi) {
      arrangementApi = mountArrangementPanel({
        container: arrangementView,
        onAnnounce,
        listTracks,
        listStems,
        fetchJson: (url) => get(url),
        producer: mountArrangementProducer,
        sessionDeps: {
          fetchImpl: (url, init) => window.fetch(url, init),
          // Created ONLY by the Play button (a user gesture), never on load.
          createContext: () => new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }),
          RealtimeEngine,
          renderOffline,
          StretchFactory: async (ctx, opts) => {
            const { default: SignalsmithStretch } = await import('../../vendor/signalsmith-stretch/SignalsmithStretch.mjs');
            return SignalsmithStretch(ctx, opts);
          },
          modules: { limiterModuleUrl: '/assets/js/arrangement/limiter-worklet.js' },
        },
      });
      window.__arrangement = arrangementApi;
    }
    if (surface === 'arrangement') arrangementApi?.render();
    if (remember) {
      try { window.localStorage.setItem('twobecomeone.studio.surface', surface); } catch { /* private mode */ }
    }
  }

  studioRoot.appendChild(headerContainer);
  studioRoot.appendChild(surfaceSwitch);
  studioRoot.appendChild(liveAnnouncer);
  studioRoot.appendChild(retryContainer);
  studioRoot.appendChild(performanceView);
  studioRoot.appendChild(arrangementView);
  performanceView.appendChild(stemDeskMount);
  const arrangement = createElement('details', { class: 'workspace-drawer' }, [
    createElement('summary', { text: 'Arrangement & rendering' }),
    performanceDeckContainer, crateMount, swapBar, crossfaderContainer, decksContainer,
    ghostCardContainer, committedLayersContainer, planContainer, renderActionsContainer,
  ]);
  performanceView.appendChild(arrangement);
  const mashupSide = createElement('aside', { class: 'studio__mashup-side' });
  const queueMount = createElement('div', { class: 'studio__mashup-queue' });
  const dawMount = createElement('div', { class: 'studio__mashup-daw' });
  mashupSide.append(queueMount, dawMount);
  performanceView.appendChild(createElement('details', { class: 'workspace-drawer' }, [
    createElement('summary', { text: 'Queue & advanced mixing' }), mashupSide,
  ]));
  {
    const hashSurface = (window.location.hash.replace(/^#\/?/, '').split('/')[1] || '').trim();
    let stored = null;
    try { stored = window.localStorage.getItem('twobecomeone.studio.surface'); } catch { /* private mode */ }
    showSurface(hashSurface || stored || 'performance');
  }

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

  // Phase 10C flow: region-armed drag → seconds → beats → dialog → invoke.
  // The armed flag lives in the Foundation deck's own component state
  // (deckState.regionArmed); the deck calls onRegionSelected when a drag
  // completes, which opens the dialog pre-filled with the dragged region.
  async function openGhostFlow(preselection = null) {
    const state = store.getState();
    const project = state.currentProject;
    const anchorId = project?.anchor_track_id;
    const leadId = project?.lead_track_id;
    const anchorTrack = anchorId ? state.deckTracks[anchorId] : null;
    const leadTrack = leadId ? state.deckTracks[leadId] : null;
    if (!anchorTrack) {
      showToast('Choose a Foundation track first.', 'danger');
      return;
    }
    // Honest precondition gate (convenience only; the server revalidates).
    const precondition = checkGhostPreconditions({
      project, anchorTrack, leadTrack, playback: state.playback, decks: state.decks, session: state.session,
    });
    if (!precondition.ok) {
      showToast(precondition.message, 'danger');
      onAnnounce(precondition.message);
      return;
    }
    // Convenience stems precheck (server stays authoritative).
    const vocalsKnown = await ensureVocalsStemKnown(anchorTrack.id, store);
    if (!vocalsKnown) {
      showToast('Separate vocals on Foundation first.', 'danger');
      onAnnounce('Separate vocals on Foundation first.');
      return;
    }
    const anchorCard = anchorDeckMount.querySelector('.deck');
    await openGhostPhraseDialog({
      anchorTrack,
      leadTrack,
      preselected: preselection,
      onAnnounce,
      trigger: anchorCard?.querySelector('.deck__select-phrase') || null,
      onPreview: async (region, gainDb) => ghostController.invoke(region, gainDb),
    });
  }

  // Mount decks
  anchorDisposer = mountDeck({
    container: anchorDeckMount, role: 'anchor', onAnnounce, store, projectManager,
    onSelectPhrase: () => openGhostFlow(),
    onRegionSelected: ({ startSeconds, endSeconds }) => openGhostFlow({ startSeconds, endSeconds }),
  });
  leadDisposer = mountDeck({ container: leadDeckMount, role: 'lead', onAnnounce, store, projectManager });
  liveCrossfaderDisposer = mountLiveCrossfader({
    container: crossfaderContainer,
    store,
    onAnnounce,
  });
  performanceDeckDisposer = mountPerformanceDeck({
    container: performanceDeckContainer,
    store,
    projectManager,
    onAnnounce,
    onModeChange: (mode) => {
      const isFun = mode === 'fun';
      decksContainer.hidden = isFun;
      swapBar.hidden = isFun;
      crossfaderContainer.hidden = isFun;
      planContainer.hidden = isFun;
      crateMount.hidden = !isFun;
      studioRoot.dataset.deckMode = mode;
    },
  });
  crateDisposer = mountStemCratePanel({
    container: crateMount, store, onAnnounce, stackController: stemStackController,
    ghostController, liveMixer,
  });
  stemDeskDisposer = mountStemDeskPanel({
    container: stemDeskMount,
    onAnnounce,
    store,
    openPicker: openSourcePicker,
    railHost,
  });
  planDisposer = mountPlan({ container: planContainer, store, projectManager });
  renderActionsDisposer = mountRenderActions({
    container: renderActionsContainer, store, projectManager,
    health: store.getState().health,
  });
  ghostCardDisposer = mountGhostCard({
    container: ghostCardContainer,
    store,
    anchorCardEl: () => anchorDeckMount.querySelector('.deck'),
    leadCardEl: () => leadDeckMount.querySelector('.deck'),
    onAction: (action) => {
      if (action === 'release') {
        ghostController.release().catch((err) => showToast(err?.message || 'Release failed', 'danger'));
      } else if (action === 'commit') {
        ghostController.commit().catch((err) => showToast(err?.message || 'Commit failed', 'danger'));
      } else if (action === 'retry') {
        const status = store.getState().ghostStatus;
        if (status.error?.code === 'GHOST_HYDRATION_FAILED') {
          projectManager.retryHydration();
        } else if (status.summary) {
          ghostController.retry({
            id: `ghost-region-${status.summary.startBeat}-${status.summary.endBeat}`,
            startBeat: status.summary.startBeat,
            endBeat: status.summary.endBeat,
          }, status.summary.gainDb).catch((err) => showToast(err?.message || 'Retry failed', 'danger'));
        } else {
          showToast('Release this Ghost before creating another preview.', 'danger');
        }
      }
    },
  });
  committedLayersDisposer = mountCommittedLayers({
    container: committedLayersContainer,
    store,
    onAnnounce,
    onUndo: (commitActionId) => ghostController.revert(commitActionId),
  });

  mashupSession = startMashupSession({ store, liveMixer, projectManager });
  queueDisposer = mountUrlQueuePanel({
    container: queueMount,
    store,
    onEnqueueTrack: (track) => mashupSession.enqueueTrack(track),
    onRemove: (id) => mashupSession.remove(id),
    onArm: (armed) => mashupSession.setArmed(armed),
  });
  dawDisposer = mountDawCommandBar({
    container: dawMount,
    store,
    onCommand: (text) => { void mashupSession.command(text); },
    onDirective: (directive) => mashupSession.directive(directive),
  });

  updateHeader();

  const unsubSave = store.subscribeSlice('save', updateHeader);
  const unsubProject = store.subscribeSlice('currentProject', updateHeader);
  disposers.push(unsubSave, unsubProject);

  // OPERATION NEVER LOSE THE MIX: the router keeps this view mounted. Leaving
  // Studio hides it; nothing here is disposed, stopped or saved by navigation
  // except the legacy project autosave, which is flushed exactly as before.
  // Playback is left as it is (see docs/never-lose-the-mix.md).
  function surfaceFromHash(hash) {
    const part = String(hash || '').replace(/^#\/?/, '').split('/')[1] || '';
    return part === 'arrangement' || part === 'performance' ? part : null;
  }
  function show({ hash = window.location.hash } = {}) {
    const fromHash = surfaceFromHash(hash);
    if (fromHash && fromHash !== studioRoot.dataset.surface) showSurface(fromHash);
    else if (studioRoot.dataset.surface === 'arrangement') arrangementApi?.render();
  }
  function hide() {
    projectManager.flushNow();
  }

  function dispose() {
    for (const d of disposers) d();
    if (anchorDisposer) anchorDisposer();
    if (leadDisposer) leadDisposer();
    if (planDisposer) planDisposer();
    if (renderActionsDisposer) renderActionsDisposer();
    if (ghostCardDisposer) ghostCardDisposer();
    if (committedLayersDisposer) committedLayersDisposer();
    if (performanceDeckDisposer) performanceDeckDisposer();
    if (crateDisposer) crateDisposer();
    if (stemDeskDisposer) stemDeskDisposer();
    if (liveCrossfaderDisposer) liveCrossfaderDisposer();
    if (queueDisposer) queueDisposer();
    if (dawDisposer) dawDisposer();
    if (arrangementApi) { arrangementApi.dispose(); if (window.__arrangement === arrangementApi) delete window.__arrangement; }
    if (mashupSession) mashupSession.stop();
    projectManager.flushNow();
  }
  dispose.show = show;
  dispose.hide = hide;
  return dispose;
}
