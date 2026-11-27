// views/library.js — Library view.
//
// Phase 4.8: loading/empty/populated/error/offline states, debounced search,
// source/status filters, allowlisted sort, pagination/load-more, grid/list
// density, artwork or source-colored placeholder, safe title/provenance/
// duration/effective BPM/key, play/pause via AudioController, assign as
// foundation/lead, rename, trash/restore. Event delegation on the list.

import { createElement, replaceChildren } from '../dom.js';
import { audioController } from '../audio.js';
import { confirmDialog, openDialog } from '../components/dialog.js';
import { openSourcePicker } from '../components/source-picker.js';
import { showToast } from '../components/toast.js';
import { formatBpm, formatKey, formatTime, sourceLabel } from '../format.js';
import {
  listTracks, renameTrack, trashTrack, restoreTrack, listStems, patch, get,
} from '../api.js';
import {
  createStemList, onStemRenamed, offerStem, roleLabel, stemMatch, stemsFromVariants,
} from '../stem-sleeve.js';
import { openStemFocus } from '../stem-focus.js';
import { projectManager } from '../app-context.js';
import { renameQueuedTracks } from '../mashup/queue-governor.js';

const TRACK_NAME_LIMIT = 200;

const PAGE_SIZE = 50;

export function mountLibrary({ store, container, stemApi = null, navigate = null }) {
  const disposers = [];
  // OPERATION OPEN THE RECORD SLEEVES: a recording's stems open beneath its
  // card. The list element is kept per track so a re-render (playback, a
  // project change, a rename) re-attaches the same list: it stays open and
  // keeps focus. Search matches come from the backend's `match.stems`.
  const stems = stemApi ?? { listStems, patchJson: patch, getJson: get };
  const goTo = navigate ?? ((hash) => { window.location.hash = hash; });
  const sleeves = new Map(); // track id → {list, open, loaded}
  const matchLists = new Map(); // track id → {list, source}
  const useStem = (stem) => {
    if (!offerStem(stem)) {
      showToast('That stem’s audio is not available, so it cannot be placed.', 'danger');
      return;
    }
    showToast(`${stem.displayName} (${roleLabel(stem.role)}, from ${stem.trackName || 'its recording'}) is ready in the Arrangement. Choose a lane and a bar there; nothing plays until you press Play.`, 'success');
    goTo('#/studio/arrangement');
  };
  // OPERATION STUDIO SURGEON: the shared Stem-Focus panel, in asset mode.
  const focusStem = (stem, trigger) => openStemFocus({
    mode: 'asset', stem, trigger, api: { patchJson: stems.patchJson, fetchJson: stems.getJson },
    onPlace: (s, span) => {
      if (!offerStem(s, span)) { showToast('That stem’s audio is not available, so it cannot be placed.', 'danger'); return false; }
      showToast(`${s.displayName}: the selection is ready in the Arrangement. Choose a lane and a bar there; nothing plays until you press Play.`, 'success');
      goTo('#/studio/arrangement');
      return true;
    },
  });
  const stemListFor = (map, track, extra) => {
    let entry = map.get(track.id);
    if (!entry) {
      entry = {
        list: createStemList({
          label: extra.label, api: stems, onUse: useStem, onFocus: focusStem, showReasons: extra.showReasons,
          announce: () => {},
        }),
        ...extra.state,
      };
      map.set(track.id, entry);
    }
    return entry;
  };
  const openSleeve = async (track, entry) => {
    entry.loaded = 'loading';
    entry.list.setLoading(true);
    try {
      const response = await stems.listStems(track.id);
      if (!sleeves.has(track.id)) return;
      entry.list.setStems(stemsFromVariants(response, { trackId: track.id, trackName: track.name }));
      entry.loaded = 'yes';
    } catch (err) {
      entry.loaded = null;
      entry.list.setError(`Could not read the stems: ${err.message}`);
    }
  };
  let searchTimer = null;
  let abortController = null;

  // ---- Toolbar ----
  const searchInput = createElement('input', {
    class: 'input', type: 'search', placeholder: 'Search tracks and stem names…',
    'aria-label': 'Search tracks and stem names',
  });
  const statusSelect = createElement('select', {
    class: 'select', 'aria-label': 'Filter by status',
  }, [
    createElement('option', { value: 'active', text: 'Active' }),
    createElement('option', { value: 'trash', text: 'Trash' }),
    createElement('option', { value: 'all', text: 'All' }),
  ]);
  const sourceSelect = createElement('select', {
    class: 'select', 'aria-label': 'Filter by source',
  }, [
    createElement('option', { value: '', text: 'All sources' }),
    createElement('option', { value: 'upload', text: 'Upload' }),
    createElement('option', { value: 'local', text: 'Local' }),
    createElement('option', { value: 'youtube', text: 'YouTube' }),
  ]);
  const sortSelect = createElement('select', {
    class: 'select', 'aria-label': 'Sort tracks',
  }, [
    createElement('option', { value: 'created', text: 'Newest' }),
    createElement('option', { value: 'name', text: 'Name' }),
    createElement('option', { value: 'bpm', text: 'BPM' }),
    createElement('option', { value: 'duration', text: 'Duration' }),
  ]);
  const densityButton = createElement('button', {
    class: 'button button--ghost', type: 'button', 'aria-label': 'Toggle grid/list density',
    text: 'Grid',
  });

  const toolbar = createElement('div', { class: 'library-toolbar' }, [
    searchInput, statusSelect, sourceSelect, sortSelect, densityButton,
  ]);

  const addPane = createElement('button', {
    class: 'button button--primary library-add',
    type: 'button',
    'aria-label': 'Add a track',
    text: '+ Add a track',
  });
  addPane.addEventListener('click', () => {
    void openSourcePicker(store, null);
  });

  const listEl = createElement('div', { class: 'track-list track-list--grid', role: 'list' });
  const loadMoreEl = createElement('div', { class: 'load-more' });

  container.replaceChildren(
    createElement('header', { class: 'view-heading' }, [
      createElement('h1', { text: 'Library' }),
      addPane,
    ]),
    toolbar, listEl, loadMoreEl,
  );

  // ---- State sync ----
  const syncFromState = (state) => {
    const lib = state.library;
    if (searchInput.value !== lib.query) searchInput.value = lib.query;
    if (statusSelect.value !== lib.status) statusSelect.value = lib.status;
    if (sortSelect.value !== lib.sort) sortSelect.value = lib.sort;
    if (sourceSelect.value !== (lib.source || '')) sourceSelect.value = lib.source || '';
    densityButton.textContent = lib.density === 'grid' ? 'List' : 'Grid';
    listEl.className = `track-list ${lib.density === 'grid' ? 'track-list--grid' : ''}`;
  };

  // ---- Rendering ----
  const render = (state) => {
    const lib = state.library;
    if (lib.loading && lib.items.length === 0) {
      listEl.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('div', { class: 'spinner' }),
        createElement('p', { text: 'Loading your library…' }),
      ]));
      loadMoreEl.replaceChildren();
      return;
    }
    if (lib.error) {
      listEl.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('p', { class: 'state__title', text: 'Something went wrong' }),
        createElement('p', { text: lib.error }),
      ]));
      loadMoreEl.replaceChildren();
      return;
    }
    if (lib.items.length === 0) {
      const emptyText = lib.status === 'trash'
        ? 'Trash is empty.'
        : 'No tracks yet. Upload or import one to get started.';
      listEl.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('p', { class: 'state__title', text: emptyText }),
      ]));
      loadMoreEl.replaceChildren();
      return;
    }

    const active = document.activeElement;
    const hadFocus = active && listEl.contains(active);
    const cards = lib.items.map((track) => renderTrackCard(track, store));
    replaceChildren(listEl, cards);
    const present = new Set(lib.items.map((t) => t.id));
    for (const map of [sleeves, matchLists]) {
      for (const [id, entry] of map) {
        if (!present.has(id)) { entry.list.dispose(); map.delete(id); }
      }
    }
    // A kept stem list was re-attached; hand focus back to the same control.
    // When that list left (a search ended, so the card shows its own stems
    // instead of the matches), use the same stem's control in the list shown now.
    if (hadFocus && active.isConnected && document.activeElement !== active) active.focus();
    else if (hadFocus && !active.isConnected && active.dataset?.key) {
      const same = [...listEl.querySelectorAll('[data-key]')].find((el) => el.dataset.key === active.dataset.key && !el.disabled);
      same?.focus();
    }

    // Load more.
    if (lib.items.length < lib.total) {
      loadMoreEl.replaceChildren(createElement('button', {
        class: 'button', type: 'button', text: 'Load more',
        onclick: () => loadMore(),
      }));
    } else {
      loadMoreEl.replaceChildren();
    }
  };

  const renderTrackCard = (track, store) => {
    const isAnchor = store.getState().currentProject?.anchor_track_id === track.id;
    const isLead = store.getState().currentProject?.lead_track_id === track.id;
    const playing = store.getState().playback.trackId === track.id && store.getState().playback.playing;

    const art = createElement('div', {
      class: `track-card__art${isAnchor ? ' track-card__art--anchor' : isLead ? ' track-card__art--lead' : ''}`,
      'aria-hidden': 'true',
      text: isAnchor ? 'A' : isLead ? 'L' : '♪',
    });
    // If artwork exists, use an <img> (safe: src is a backend URL, alt is empty).
    if (track.artwork_url) {
      const fallback = createElement('span', { text: art.textContent });
      const img = createElement('img', { src: track.artwork_url, alt: '', class: 'track-card__art-img' });
      img.addEventListener('error', () => img.remove(), { once: true });
      art.replaceChildren(fallback, img);
    }

    const title = createElement('div', { class: 'track-card__title', text: track.name, title: track.name });

    const meta = createElement('div', { class: 'track-card__meta' }, [
      createElement('span', { text: sourceLabel(track.source?.kind) }),
      createElement('span', { text: `${formatBpm(track)} BPM` }),
      createElement('span', { text: formatKey(track) }),
      createElement('span', { text: formatTime(track.duration) }),
    ]);

    const playBtn = createElement('button', {
      class: 'button button--icon', type: 'button',
      'aria-label': playing ? `Pause ${track.name}` : `Play ${track.name}`,
      text: playing ? '⏸' : '▶',
      'data-action': 'playback',
    });

    const assignAnchor = createElement('button', {
      class: 'button', type: 'button', text: 'Foundation',
      'data-action': 'anchor', 'aria-pressed': String(isAnchor),
    });
    const assignLead = createElement('button', {
      class: 'button', type: 'button', text: 'Lead',
      'data-action': 'lead', 'aria-pressed': String(isLead),
    });
    const renameBtn = createElement('button', {
      class: 'button button--ghost', type: 'button', text: 'Rename',
      'data-action': 'rename',
    });
    const trashBtn = createElement('button', {
      class: `button button--ghost${track.deleted_at ? '' : ' button--danger'}`, type: 'button',
      text: track.deleted_at ? 'Restore' : 'Trash',
      'data-action': track.deleted_at ? 'restore' : 'trash',
    });

    const sleeve = sleeves.get(track.id);
    const open = Boolean(sleeve?.open);
    const stemsId = `library-stems-${track.id}`;
    const stemsBtn = createElement('button', {
      class: 'button button--ghost', type: 'button', text: open ? 'Hide stems' : 'Stems',
      'aria-expanded': String(open), 'aria-controls': stemsId,
      'aria-label': `${open ? 'Hide' : 'Show'} the separated stems of ${track.name}`,
      'data-action': 'stems',
    });

    const actions = createElement('div', { class: 'track-card__actions' }, [
      assignAnchor, assignLead, renameBtn, stemsBtn, trashBtn,
    ]);

    // Stems that matched the search, beneath their recording (one result).
    let matchBlock = null;
    const match = stemMatch(track.match, { trackId: track.id, trackName: track.name });
    if (match && match.stems.length) {
      const entry = stemListFor(matchLists, track, {
        label: `Stems of ${track.name} matching the search`, showReasons: true, state: { source: null },
      });
      if (entry.source !== track.match) {
        entry.source = track.match;
        entry.list.setStems(match.stems);
      }
      matchBlock = createElement('div', { class: 'track-card__stems track-card__stems--match' }, [
        createElement('p', {
          class: 'track-card__stems-head',
          text: match.trackMatched
            ? `${match.stems.length} matching ${match.stems.length === 1 ? 'stem' : 'stems'} (the recording also matches)`
            : `${match.stems.length} matching ${match.stems.length === 1 ? 'stem' : 'stems'} (found by stem; the recording name does not match)`,
        }),
        entry.list.el,
      ]);
    } else if (matchLists.has(track.id)) {
      matchLists.get(track.id).list.dispose();
      matchLists.delete(track.id);
    }

    const sleeveBlock = createElement('div', {
      id: stemsId, class: 'track-card__stems', role: 'group',
      'aria-label': `Separated stems of ${track.name}`, hidden: open ? undefined : 'true',
    }, open ? [sleeve.list.el] : []);

    const badge = (isAnchor || isLead)
      ? createElement('span', { class: `track-card__badge track-card__badge--${isAnchor ? 'anchor' : 'lead'}`, text: isAnchor ? 'Foundation' : 'Lead' })
      : null;
    return createElement('div', {
      class: `track-card${playing ? ' is-playing' : ''}${open ? ' is-open' : ''}`, role: 'listitem', 'data-track-id': track.id,
    }, [
      art, createElement('div', { class: 'track-card__identity' }, [title, meta, badge]), playBtn, actions,
      matchBlock, sleeveBlock,
    ]);
  };

  // ---- Actions ----
  const togglePlay = (track) => {
    const state = store.getState();
    if (state.playback.trackId === track.id && state.playback.playing) {
      audioController.pause();
      store.dispatch({ type: 'playback/set', playing: false });
    } else {
      audioController.play(track.id, track.audio_url);
      store.dispatch({ type: 'playback/set', trackId: track.id, playing: true });
    }
  };

  const assignSlot = (slot, track) => {
    projectManager.assign(slot, track.id);
    showToast(`Assigned "${track.name}" as ${slot === 'anchor' ? 'foundation' : 'lead'}.`, 'success');
  };

  const rename = async (track) => {
    const input = createElement('input', { class: 'input', type: 'text', value: track.name, 'aria-label': 'New name' });
    const value = await openDialog({
      title: 'Rename track',
      body: [input],
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Save', value: 'save', kind: 'primary' },
      ],
    });
    if (value !== 'save') return;
    const nextName = input.value.trim();
    if (!nextName) {
      showToast('Enter a track name.', 'danger');
      return;
    }
    if ([...nextName].length > TRACK_NAME_LIMIT) {
      showToast(`A track name must be ${TRACK_NAME_LIMIT} characters or fewer.`, 'danger');
      return;
    }
    try {
      const updated = await renameTrack(track.id, nextName);
      store.dispatch({ type: 'library/upsert-track', track: updated });
      const queue = store.getState().urlQueue;
      if (queue) {
        const nextQueue = renameQueuedTracks(queue, track.id, updated.name);
        if (nextQueue !== queue) {
          store.dispatch({ type: 'mashup/queue', urlQueue: nextQueue });
        }
      }
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const trash = async (track) => {
    const ok = await confirmDialog({
      title: 'Move to trash?',
      description: `"${track.name}" will be hidden from the active library. Existing project selections stay intact.`,
      confirmLabel: 'Trash',
      danger: true,
    });
    if (!ok) return;
    try {
      const updated = await trashTrack(track.id);
      store.dispatch({ type: 'library/upsert-track', track: updated });
      // Refresh the current filter view.
      load();
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const restore = async (track) => {
    try {
      const updated = await restoreTrack(track.id);
      store.dispatch({ type: 'library/upsert-track', track: updated });
      load();
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  // ---- Data loading ----
  const load = async ({ silent = false } = {}) => {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const lib = store.getState().library;
    if (!silent) store.dispatch({ type: 'library/loading', loading: true });
    try {
      const data = await listTracks({
        limit: PAGE_SIZE,
        offset: 0,
        query: lib.query || undefined,
        status: lib.status,
        sort: lib.sort,
        source: lib.source || undefined,
      }, signal);
      store.dispatch({
        type: 'library/set',
        items: data.items, total: data.total, limit: data.limit, offset: data.offset,
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      store.dispatch({ type: 'library/error', error: err.message });
    }
  };

  const loadMore = async () => {
    const lib = store.getState().library;
    const nextOffset = lib.items.length;
    try {
      const data = await listTracks({
        limit: PAGE_SIZE,
        offset: nextOffset,
        query: lib.query || undefined,
        status: lib.status,
        sort: lib.sort,
        source: lib.source || undefined,
      });
      store.dispatch({
        type: 'library/append',
        items: data.items, total: data.total, offset: data.offset,
      });
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  // ---- Event wiring ----
  const onSearch = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      store.dispatch({ type: 'library/filter', query: searchInput.value });
      load();
    }, 300);
  };
  searchInput.addEventListener('input', onSearch);
  disposers.push(() => { if (searchTimer) clearTimeout(searchTimer); });

  statusSelect.addEventListener('change', () => {
    store.dispatch({ type: 'library/filter', status: statusSelect.value });
    load();
  });
  sourceSelect.addEventListener('change', () => {
    store.dispatch({ type: 'library/filter', source: sourceSelect.value || null });
    load();
  });
  sortSelect.addEventListener('change', () => {
    store.dispatch({ type: 'library/filter', sort: sortSelect.value });
    load();
  });
  densityButton.addEventListener('click', () => {
    const current = store.getState().library.density;
    store.dispatch({ type: 'library/filter', density: current === 'grid' ? 'list' : 'grid' });
  });

  // One delegated listener handles every track-card action, including cards
  // added by pagination or import updates.
  const onTrackAction = (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !listEl.contains(button)) return;
    const card = button.closest('[data-track-id]');
    const track = store.getState().library.items.find((item) => item.id === card?.dataset.trackId);
    if (!track) return;
    const action = button.dataset.action;
    if (action === 'playback') togglePlay(track);
    else if (action === 'anchor' || action === 'lead') assignSlot(action, track);
    else if (action === 'rename') rename(track);
    else if (action === 'trash') trash(track);
    else if (action === 'restore') restore(track);
    else if (action === 'stems') toggleStems(track, button);
  };
  const toggleStems = (track, button) => {
    const entry = stemListFor(sleeves, track, {
      label: `Separated stems of ${track.name}`, showReasons: false, state: { open: false, loaded: null },
    });
    entry.open = !entry.open;
    const block = button.closest('[data-track-id]')?.querySelector('.track-card__stems:not(.track-card__stems--match)');
    if (block) {
      block.hidden = !entry.open;
      block.replaceChildren(...(entry.open ? [entry.list.el] : []));
    }
    button.setAttribute('aria-expanded', String(entry.open));
    button.textContent = entry.open ? 'Hide stems' : 'Stems';
    button.setAttribute('aria-label', `${entry.open ? 'Hide' : 'Show'} the separated stems of ${track.name}`);
    // Re-read every time it opens: a separation may have finished since.
    if (entry.open && entry.loaded !== 'loading') void openSleeve(track, entry);
  };
  listEl.addEventListener('click', onTrackAction);
  disposers.push(() => listEl.removeEventListener('click', onTrackAction));

  // Subscribe only to the slices this view renders.
  const refresh = () => {
    const state = store.getState();
    syncFromState(state);
    render(state);
  };
  const unsubscribeLibrary = store.subscribeSlice('library', refresh);
  const unsubscribeProject = store.subscribeSlice('currentProject', refresh);
  let playbackKey = '';
  const unsubscribePlayback = store.subscribeSlice('playback', (playback) => {
    const nextKey = `${playback.trackId || ''}:${playback.playing ? '1' : '0'}`;
    if (nextKey !== playbackKey) {
      playbackKey = nextKey;
      refresh();
    }
  });

  // A rename changes what the search finds: search again now, without a
  // loading flash, so the open stem lists keep their place and focus.
  const unsubscribeRenamed = onStemRenamed(() => {
    if (store.getState().library.query) void load({ silent: true });
  });

  disposers.push(() => {
    unsubscribeRenamed();
    unsubscribeLibrary();
    unsubscribeProject();
    unsubscribePlayback();
    if (abortController) abortController.abort();
    for (const map of [sleeves, matchLists]) {
      for (const entry of map.values()) entry.list.dispose();
      map.clear();
    }
  });

  // Initial load.
  load();

  return () => {
    for (const dispose of disposers) dispose();
  };
}
