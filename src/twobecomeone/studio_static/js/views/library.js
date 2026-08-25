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
import { showToast } from '../components/toast.js';
import { formatBpm, formatKey, formatTime, sourceLabel } from '../format.js';
import {
  listTracks, renameTrack, trashTrack, restoreTrack,
} from '../api.js';
import { projectManager } from '../app-context.js';

const PAGE_SIZE = 50;

export function mountLibrary({ store, container }) {
  const disposers = [];
  let searchTimer = null;
  let abortController = null;

  // ---- Toolbar ----
  const searchInput = createElement('input', {
    class: 'input', type: 'search', placeholder: 'Search tracks…',
    'aria-label': 'Search tracks',
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

  const listEl = createElement('div', { class: 'track-list track-list--grid', role: 'list' });
  const loadMoreEl = createElement('div', { class: 'load-more' });

  container.replaceChildren(toolbar, listEl, loadMoreEl);

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

    const cards = lib.items.map((track) => renderTrackCard(track, store));
    replaceChildren(listEl, cards);

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
      const img = createElement('img', { src: track.artwork_url, alt: '', class: 'track-card__art-img' });
      art.replaceChildren(img);
    }

    const title = createElement('div', { class: 'track-card__title', text: track.name });

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
      'data-action': 'anchor',
    });
    const assignLead = createElement('button', {
      class: 'button', type: 'button', text: 'Lead',
      'data-action': 'lead',
    });
    const renameBtn = createElement('button', {
      class: 'button button--ghost', type: 'button', text: 'Rename',
      'data-action': 'rename',
    });
    const trashBtn = createElement('button', {
      class: 'button button--ghost', type: 'button',
      text: track.deleted_at ? 'Restore' : 'Trash',
      'data-action': track.deleted_at ? 'restore' : 'trash',
    });

    const actions = createElement('div', { class: 'track-card__actions' }, [
      playBtn, assignAnchor, assignLead, renameBtn, trashBtn,
    ]);

    return createElement('div', { class: 'track-card', role: 'listitem', 'data-track-id': track.id }, [
      art, title, meta, actions,
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
    if (value === 'save' && input.value.trim()) {
      try {
        const updated = await renameTrack(track.id, input.value.trim());
        store.dispatch({ type: 'library/upsert-track', track: updated });
      } catch (err) {
        showToast(err.message, 'danger');
      }
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
  const load = async () => {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const lib = store.getState().library;
    store.dispatch({ type: 'library/loading', loading: true });
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

  disposers.push(() => {
    unsubscribeLibrary();
    unsubscribeProject();
    unsubscribePlayback();
    if (abortController) abortController.abort();
  });

  // Initial load.
  load();

  return () => {
    for (const dispose of disposers) dispose();
  };
}
