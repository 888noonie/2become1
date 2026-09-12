// components/stem-crate-panel.js — FUN-mode production crate (Phase 14B.3).
// Crate rows stay in this component. Request objects and media stay out of StateStore.
// Placement into a stack is disabled until Phase 14C.

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

function deckTrackIds(state) {
  const project = state.currentProject || {};
  return [project.anchor_track_id, project.lead_track_id].filter(Boolean);
}

export function mountStemCratePanel({
  container,
  store,
  onAnnounce,
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

  root.append(
    heading,
    outcomeEl,
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
      if (!disposed) renderCards();
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

    const placeBtn = createElement('button', {
      class: 'button stem-crate__place',
      type: 'button',
      text: PLACE_STACK_COPY,
      disabled: 'true',
      title: PLACE_STACK_COPY,
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
    ? store.subscribeSlice('currentProject', () => { refreshOutcome(); })
    : store.subscribe(() => { refreshOutcome(); });

  return function dispose() {
    disposed = true;
    window.clearTimeout(searchTimer);
    unsub?.();
    container.replaceChildren();
  };
}
