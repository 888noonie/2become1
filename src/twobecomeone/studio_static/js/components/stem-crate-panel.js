// components/stem-crate-panel.js — FUN crate + Phase 14C four-role stack builder.
// Crate rows stay in this component. Request objects and media stay out of StateStore.

import { createElement, replaceChildren } from '../dom.js';
import { showToast } from './toast.js';
import { openAnalysisDialog } from './analysis-dialog.js';
import {
  listStemCrate,
  patchStemCrateItem,
  createStemCrateItem,
  listStems,
  listJobs,
  getTrack,
  postProjectAction,
  getActionState,
  buildPreviewStemStackAction,
} from '../api.js';
import {
  PLACE_STACK_COPY,
  LOOP_BARS,
  CRATE_ROLES,
  roleForStemName,
  methodLabel,
  hashShorthand,
  mediaStatusLabel,
  separationOutcome,
} from '../stem-crate.js';
import {
  crateComponentPayload,
  destinationBarsFromSlots,
  feverRecipe,
  stackStateLabel,
} from '../stem-stack.js';

function deckTrackIds(state) {
  const project = state.currentProject || {};
  return [project.anchor_track_id, project.lead_track_id].filter(Boolean);
}

const SLOT_LABELS = Object.freeze({
  beat: 'BEAT',
  bass: 'BASS',
  other: 'OTHER',
  voice: 'VOICE',
});

export function mountStemCratePanel({
  container,
  store,
  onAnnounce,
  stackController,
} = {}) {
  if (!container) throw new Error('mountStemCratePanel requires a container');

  const root = createElement('section', {
    class: 'stem-crate',
    'aria-label': 'Stem crate',
  });
  container.replaceChildren(root);

  const heading = createElement('h2', { class: 'stem-crate__title', text: 'Stem crate' });
  const outcomeEl = createElement('p', {
    class: 'stem-crate__outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const search = createElement('input', {
    class: 'input stem-crate__search',
    type: 'search',
    placeholder: 'Search crate',
    'aria-label': 'Search stem crate',
  });
  const filters = createElement('div', {
    class: 'stem-crate__filters',
    role: 'group',
    'aria-label': 'Filter crate by role',
  });
  const slotsEl = createElement('div', {
    class: 'stem-crate__slots',
    role: 'group',
    'aria-label': 'Stem stack roles',
  });
  const feverEl = createElement('p', {
    class: 'stem-crate__fever',
    role: 'status',
  });
  const stackStatusEl = createElement('p', {
    class: 'stem-crate__stack-state',
    role: 'status',
    'aria-live': 'polite',
    text: 'Stack idle',
  });
  const previewBtn = createElement('button', {
    class: 'button stem-crate__preview',
    type: 'button',
    text: 'Preview stack',
    disabled: 'true',
  });
  const commitBtn = createElement('button', {
    class: 'button stem-crate__commit',
    type: 'button',
    text: 'Commit stack',
    disabled: 'true',
  });
  const undoBtn = createElement('button', {
    class: 'button stem-crate__undo',
    type: 'button',
    text: 'Undo stack',
    disabled: 'true',
  });
  const grid = createElement('div', { class: 'stem-crate__grid' });
  const addBtn = createElement('button', {
    class: 'button',
    type: 'button',
    text: 'Add deck stems to crate',
  });

  let query = '';
  let role = null;
  let items = [];
  let searchTimer = 0;
  let disposed = false;
  const slots = { beat: null, bass: null, other: null, voice: null };
  let lastCommitActionId = null;

  function setFilter(nextRole) {
    role = nextRole;
    for (const btn of filters.querySelectorAll('button')) {
      const value = btn.dataset.role || null;
      const active = value === (role || '');
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    reload();
  }

  filters.appendChild(createElement('button', {
    class: 'button is-active',
    type: 'button',
    text: 'All',
    'data-role': '',
    'aria-pressed': 'true',
    onclick: () => setFilter(null),
  }));
  for (const value of CRATE_ROLES) {
    filters.appendChild(createElement('button', {
      class: 'button',
      type: 'button',
      text: value,
      'data-role': value,
      'aria-pressed': 'false',
      onclick: () => setFilter(value),
    }));
  }

  search.addEventListener('input', () => {
    query = search.value.trim();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => reload(), 200);
  });

  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    try {
      const added = await addDeckStems(store.getState());
      onAnnounce?.(added ? `Added ${added} stem${added === 1 ? '' : 's'} to the crate.` : 'No new deck stems to add.');
      showToast(added ? `Added ${added} stem${added === 1 ? '' : 's'} to the crate.` : 'No new deck stems to add.', 'success');
      await reload();
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      addBtn.disabled = false;
    }
  });

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    try {
      await previewStack();
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      refreshStackChrome();
    }
  });
  commitBtn.addEventListener('click', async () => {
    commitBtn.disabled = true;
    try {
      const result = await stackController.commit();
      const projectId = store.getState().currentProject?.id;
      if (projectId) await hydrateProjection(projectId);
      const layers = store.getState().session?.committedLayers || [];
      if (layers.length) lastCommitActionId = layers[layers.length - 1].actionId;
      onAnnounce?.('Stem stack committed.');
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      refreshStackChrome();
    }
  });
  undoBtn.addEventListener('click', async () => {
    undoBtn.disabled = true;
    try {
      const layer = (store.getState().session?.committedLayers || []).slice(-1)[0];
      const commitActionId = layer?.actionId || lastCommitActionId;
      if (!commitActionId) throw new Error('No committed stack to undo');
      await stackController.revert(commitActionId);
      const projectId = store.getState().currentProject?.id;
      if (projectId) await hydrateProjection(projectId);
      lastCommitActionId = null;
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      refreshStackChrome();
    }
  });

  root.append(
    heading,
    outcomeEl,
    slotsEl,
    feverEl,
    stackStatusEl,
    createElement('div', { class: 'stem-crate__stack-actions' }, [previewBtn, commitBtn, undoBtn]),
    createElement('div', { class: 'stem-crate__toolbar' }, [search, filters]),
    grid,
    addBtn,
  );

  async function addDeckStems(state) {
    let added = 0;
    for (const trackId of deckTrackIds(state)) {
      const data = await listStems(trackId);
      for (const variant of data.variants || []) {
        if (!variant.stem_set_id || variant.name === 'full') continue;
        try {
          await createStemCrateItem({
            track_id: trackId,
            stem_set_id: variant.stem_set_id,
            stem_name: variant.name,
            role: roleForStemName(variant.name),
          });
          added += 1;
        } catch (err) {
          if (err.status !== 409 && !/already exists/i.test(err.message || '')) throw err;
        }
      }
    }
    return added;
  }

  async function reload() {
    try {
      const listing = await listStemCrate({ query, role, limit: 100 });
      items = listing.items || [];
      if (!disposed) {
        renderSlots();
        renderCards();
        refreshStackChrome();
      }
      await refreshOutcome();
    } catch (err) {
      items = [];
      if (!disposed) {
        replaceChildren(grid, [
          createElement('p', { class: 'stem-crate__empty', text: err.message || 'Crate is unavailable.' }),
        ]);
      }
    }
  }

  async function refreshOutcome() {
    const state = store.getState();
    const ids = deckTrackIds(state);
    const variants = [];
    for (const trackId of ids) {
      try {
        const data = await listStems(trackId);
        variants.push(...(data.variants || []));
      } catch {
        /* deck stem tray is optional for the outcome line */
      }
    }
    let jobs = [];
    try {
      const payload = await listJobs({ kind: 'separate', limit: 20 });
      jobs = payload.items || [];
    } catch {
      jobs = [];
    }
    const outcome = separationOutcome({
      variants: [
        ...variants,
        ...items.map((item) => ({ name: item.stem_name, method: item.method })),
      ],
      jobs,
      hasTrack: ids.length > 0,
    });
    outcomeEl.textContent = outcome.label;
    outcomeEl.dataset.code = outcome.code;
  }

  function placedCount() {
    return CRATE_ROLES.filter((key) => slots[key]).length;
  }

  function refreshStackChrome() {
    const recipe = feverRecipe(slots);
    feverEl.textContent = recipe.label;
    feverEl.dataset.unlocked = recipe.unlocked ? 'true' : 'false';
    const snap = stackController?.snapshot?.() || { phase: 'idle' };
    stackStatusEl.textContent = `Stack ${stackStateLabel(snap.phase)}`;
    previewBtn.disabled = placedCount() < 1 || !stackController;
    commitBtn.disabled = snap.phase !== 'auditioning';
    const hasLayer = (store.getState().session?.committedLayers || []).length > 0;
    undoBtn.disabled = !hasLayer && !lastCommitActionId;
    renderSlots();
  }

  function renderSlots() {
    replaceChildren(slotsEl, CRATE_ROLES.map((key) => {
      const item = slots[key];
      const label = item
        ? `${SLOT_LABELS[key]}: ${item.stem_name}`
        : `${SLOT_LABELS[key]} empty`;
      const remove = item ? createElement('button', {
        class: 'button button--sm',
        type: 'button',
        text: 'Remove',
        'aria-label': `Remove ${SLOT_LABELS[key]}`,
        onclick: () => {
          slots[key] = null;
          refreshStackChrome();
          onAnnounce?.(`${SLOT_LABELS[key]} cleared`);
        },
      }) : null;
      return createElement('div', {
        class: `stem-crate-slot${item ? ' is-filled' : ''}`,
        'data-role': key,
      }, [
        createElement('p', { class: 'stem-crate-slot__label', text: label }),
        item ? createElement('p', {
          class: 'stem-crate-slot__method',
          text: methodLabel(item.method, item.stem_name),
        }) : null,
        remove,
      ]);
    }));
  }

  function placeItem(item) {
    const slotRole = item.role && CRATE_ROLES.includes(item.role)
      ? item.role
      : roleForStemName(item.stem_name);
    if (item.stem_name === 'center' || item.stem_name === 'sides') {
      slots.other = item;
      onAnnounce?.(`Placed ffmpeg ${item.stem_name} into OTHER`);
    } else {
      slots[slotRole] = item;
      onAnnounce?.(`Placed ${item.stem_name} into ${SLOT_LABELS[slotRole]}`);
    }
    refreshStackChrome();
  }

  async function hydrateProjection(projectId) {
    const state = await getActionState(projectId);
    store.dispatch({
      type: 'v1/hydrate-projection',
      projection: { session: state.session, proposals: state.proposals },
      lastSequence: state.last_sequence,
    });
    return state;
  }

  async function previewStack() {
    const projectId = store.getState().currentProject?.id;
    if (!projectId) throw new Error('Open a project before previewing a stack');
    if (!stackController) throw new Error('Stem stack runtime is unavailable');
    const components = CRATE_ROLES
      .filter((key) => slots[key])
      .map((key) => crateComponentPayload(slots[key], key));
    const action = buildPreviewStemStackAction({
      components,
      destinationBars: destinationBarsFromSlots(slots),
    });
    const result = await postProjectAction(projectId, action);
    const outcome = result.outcome || result;
    await stackController.preview({ projectId, action, outcome });
    await hydrateProjection(projectId);
    refreshStackChrome();
  }

  function renderCards() {
    if (items.length === 0) {
      replaceChildren(grid, [
        createElement('p', { class: 'stem-crate__empty', text: 'Crate is empty. Separate stems, then add them here.' }),
      ]);
      return;
    }
    replaceChildren(grid, items.map((item) => cardFor(item)));
  }

  function cardFor(item) {
    const status = mediaStatusLabel(item);
    const method = methodLabel(item.method, item.stem_name);
    const provenance = item.provenance === 'source_track_inherited'
      ? 'source inherited'
      : (item.provenance || 'unknown provenance');
    const bpm = Number.isFinite(item.effective_bpm) ? Math.round(item.effective_bpm) : '—';
    const key = [item.effective_tonic, item.effective_mode].filter(Boolean).join(' ') || 'unknown';
    const confidence = Number.isFinite(item.analysis_confidence)
      ? `confidence ${item.analysis_confidence}`
      : 'confidence unknown';
    const gridNote = item.loop_truth?.grid_status === 'stale_revision'
      ? 'Loop region is stale until you correct the grid.'
      : (item.loop_truth?.low_confidence ? 'Check this grid.' : '');
    const compat = item.compatibility?.explanation;
    const canPlace = status === 'available';

    const placeBtn = createElement('button', {
      class: 'button stem-crate__place',
      type: 'button',
      text: PLACE_STACK_COPY,
      ...(canPlace ? {} : { disabled: 'true' }),
      title: canPlace ? PLACE_STACK_COPY : 'Unavailable stems cannot be placed',
      onclick: canPlace ? () => placeItem(item) : undefined,
    });

    const bars = createElement('div', {
      class: 'stem-crate__bars',
      role: 'group',
      'aria-label': `Loop length for ${item.stem_name}`,
    }, LOOP_BARS.map((count) => createElement('button', {
      class: `button button--sm ${item.loop_bars === count ? 'is-active' : ''}`,
      type: 'button',
      text: String(count),
      'aria-pressed': item.loop_bars === count ? 'true' : 'false',
      onclick: async () => {
        try {
          await patchStemCrateItem(item.id, { loop_bars: count });
          onAnnounce?.(`Loop length set to ${count} bars.`);
          await reload();
        } catch (err) {
          showToast(err.message, 'danger');
        }
      },
    })));

    const gridBtn = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Correct grid',
      onclick: async () => {
        try {
          const track = await getTrack(item.track_id);
          await openAnalysisDialog({ track, store, onAnnounce, trigger: gridBtn });
          await reload();
        } catch (err) {
          showToast(err.message, 'danger');
        }
      },
    });

    return createElement('article', {
      class: `stem-crate-card stem-crate-card--${status}`,
      'data-stem-name': item.stem_name,
      'data-method': item.method,
      'data-status': status,
    }, [
      createElement('div', { class: 'stem-crate-card__top' }, [
        createElement('strong', { class: 'stem-crate-card__stem', text: item.stem_name }),
        createElement('span', { class: `stem-crate-card__method stem-crate-card__method--${item.method || 'unknown'}`, text: method }),
      ]),
      createElement('p', {
        class: 'stem-crate-card__track',
        text: item.source_track_name || item.label || 'Untitled track',
      }),
      createElement('p', {
        class: 'stem-crate-card__facts',
        text: `${bpm} BPM · ${key} · ${confidence} · ${provenance}`,
      }),
      createElement('p', {
        class: 'stem-crate-card__hash',
        text: hashShorthand(item.content_sha256) ? `source ${hashShorthand(item.content_sha256)}` : '',
      }),
      createElement('p', { class: 'stem-crate-card__status', text: status }),
      gridNote ? createElement('p', { class: 'stem-crate-card__note', text: gridNote }) : null,
      compat ? createElement('p', { class: 'stem-crate-card__compat', text: compat }) : null,
      bars,
      createElement('div', { class: 'stem-crate-card__actions' }, [gridBtn, placeBtn]),
    ]);
  }

  reload();
  const unsub = store.subscribeSlice
    ? store.subscribeSlice('currentProject', () => { refreshOutcome(); refreshStackChrome(); })
    : store.subscribe(() => { refreshOutcome(); refreshStackChrome(); });

  return function dispose() {
    disposed = true;
    window.clearTimeout(searchTimer);
    unsub?.();
    container.replaceChildren();
  };
}
