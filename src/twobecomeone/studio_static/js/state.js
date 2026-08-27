// js/state.js — unidirectional state store.
//
// Phase 4.3: the store is the sole communication path between views and
// components. Reducers return new objects; components never mutate snapshots.
// DOM nodes, EventSource instances, Audio objects, timers, and AbortControllers
// are kept OUTSIDE state. Subscribers receive a structuredClone of the snapshot
// so they can never mutate state by reference.
//
// V1 (Phase 8A) adds two additive slices — `session` and `proposals` — and
// registers the V1 reducers in `actions/reducers.js`. The store remains the
// only mutation path and never holds runtime objects.

import {
  V1_INITIAL_SESSION,
  V1_INITIAL_PROPOSALS,
} from './actions/reducers.js';

const INITIAL_STATE = {
  route: 'studio',
  // V1 additive slices. Frozen-by-clone on first read; reducers in
  // actions/reducers.js own these mutations.
  session: structuredClone(V1_INITIAL_SESSION),
  proposals: structuredClone(V1_INITIAL_PROPOSALS),
  health: null,
  currentProject: null,
  projects: { items: [], total: 0 },
  // Per-deck resolved tracks keyed by track ID (null payload = unresolvable).
  deckTracks: {},
  save: { status: 'idle', pending: [], error: null, lastError: null },
  plan: { data: null, loading: false, error: null, request: null },
  // Stem metadata per track; payload cache stays outside the store.
  stems: {},
  library: {
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
    query: '',
    status: 'active',
    sort: 'created',
    source: null,
    density: 'grid',
    loading: false,
    error: null,
  },
  jobs: {
    items: [],
    total: 0,
    activeCount: 0,
    latestPreview: null,
    latestRender: null,
  },
  sourcePicker: {
    open: false,
    slot: null, // 'anchor' | 'lead' | null
    tab: 'library',
  },
  playback: {
    trackId: null,
    source: null, // { trackId, kind: 'track'|'stem', stemName, variant, url } | null
    playing: false,
    time: 0,
    duration: 0,
    error: null,
  },
  ui: {
    toast: null,
  },
};

export class StateStore extends EventTarget {
  constructor(initial = INITIAL_STATE) {
    super();
    this._state = structuredClone(initial);
    this._reducers = new Map();
  }

  /** Register a reducer for an action type. */
  register(actionType, reducer) {
    this._reducers.set(actionType, reducer);
  }

  /** Return a deep copy of the current state. */
  getState() {
    return structuredClone(this._state);
  }

  /** Dispatch an action; reducers produce a new state; subscribers are notified. */
  dispatch(action) {
    const type = action && action.type;
    const reducer = this._reducers.get(type);
    if (reducer) {
      const next = reducer(this._state, action);
      if (next !== this._state) {
        // Clone reducer output before storing it so action payload objects can
        // never retain a mutable reference into the internal state.
        this._state = structuredClone(next);
      }
    }
    // Always notify with a deep copy so subscribers cannot mutate state.
    const snapshot = structuredClone(this._state);
    this.dispatchEvent(new CustomEvent('change', {
      detail: snapshot,
    }));
    return structuredClone(snapshot);
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * @param {(state: object) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    const handler = (event) => listener(event.detail);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }

  /**
   * Subscribe to a specific slice. The listener fires only when the slice
   * (deep-compared) changes. Returns an unsubscribe function.
   * @param {string} sliceKey
   * @param {(slice: any) => void} listener
   * @returns {() => void}
   */
  subscribeSlice(sliceKey, listener) {
    let last = JSON.stringify(this._state[sliceKey]);
    const handler = (event) => {
      const current = JSON.stringify(event.detail[sliceKey]);
      if (current !== last) {
        last = current;
        listener(structuredClone(event.detail[sliceKey]));
      }
    };
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

import {
  V1_ACTION_TYPES,
  reduceV1,
} from './actions/reducers.js';

export function registerReducers(store) {
  // V1 (Phase 8A): register each additive v1/* action type individually so
  // the StateStore's exact-type reducer lookup remains unchanged for V0.3.
  // The proposals + session slices are managed exclusively through this path.
  for (const actionType of Object.values(V1_ACTION_TYPES)) {
    store.register(actionType, (state, action) => reduceV1(state, action));
  }

  store.register('route/set', (state, action) => ({
    ...state,
    route: action.route,
  }));

  store.register('health/set', (state, action) => ({
    ...state,
    health: action.health,
  }));

  store.register('project/set', (state, action) => ({
    ...state,
    currentProject: action.project,
  }));

  store.register('project/patch-local', (state, action) => {
    if (!state.currentProject) return state;
    return {
      ...state,
      currentProject: { ...state.currentProject, ...action.fields },
    };
  });

  store.register('projects/set', (state, action) => ({
    ...state,
    projects: { items: action.items, total: action.total },
  }));

  store.register('deckTrack/set', (state, action) => ({
    ...state,
    deckTracks: { ...state.deckTracks, [action.trackId]: action.track },
  }));

  store.register('save/status', (state, action) => {
    const { type: _type, ...updates } = action;
    return { ...state, save: { ...state.save, ...updates } };
  });

  store.register('plan/set', (state, action) => {
    const { type: _type, ...updates } = action;
    return { ...state, plan: { ...state.plan, ...updates } };
  });

  store.register('stems/set', (state, action) => ({
    ...state,
    stems: { ...state.stems, [action.trackId]: action.data },
  }));

  store.register('project/assign-slot', (state, action) => {
    const project = state.currentProject
      ? { ...state.currentProject }
      : { id: null, name: 'Untitled', anchor_track_id: null, lead_track_id: null };
    if (action.slot === 'anchor') project.anchor_track_id = action.trackId;
    else if (action.slot === 'lead') project.lead_track_id = action.trackId;
    return { ...state, currentProject: project };
  });

  store.register('library/loading', (state, action) => ({
    ...state,
    library: { ...state.library, loading: action.loading },
  }));

  store.register('library/set', (state, action) => ({
    ...state,
    library: {
      ...state.library,
      items: action.items,
      total: action.total,
      limit: action.limit,
      offset: action.offset,
      loading: false,
      error: null,
    },
  }));

  store.register('library/append', (state, action) => {
    // Deduplicate by track id.
    const seen = new Set(state.library.items.map((t) => t.id));
    const merged = [...state.library.items];
    for (const track of action.items) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        merged.push(track);
      }
    }
    return {
      ...state,
      library: {
        ...state.library,
        items: merged,
        total: action.total,
        offset: action.offset,
        loading: false,
        error: null,
      },
    };
  });

  store.register('library/upsert-track', (state, action) => {
    const track = action.track;
    const items = state.library.items.map((t) => (t.id === track.id ? track : t));
    const exists = state.library.items.some((t) => t.id === track.id);
    if (!exists) items.unshift(track);
    return {
      ...state,
      library: {
        ...state.library,
        items,
        total: exists ? state.library.total : state.library.total + 1,
      },
    };
  });

  store.register('library/filter', (state, action) => ({
    ...state,
    library: {
      ...state.library,
      query: action.query ?? state.library.query,
      status: action.status ?? state.library.status,
      sort: action.sort ?? state.library.sort,
      source: Object.hasOwn(action, 'source') ? action.source : state.library.source,
      density: action.density ?? state.library.density,
    },
  }));

  store.register('library/error', (state, action) => ({
    ...state,
    library: { ...state.library, loading: false, error: action.error },
  }));

  store.register('jobs/set', (state, action) => ({
    ...state,
    jobs: {
      items: action.items,
      total: action.total,
      activeCount: action.activeCount ?? state.jobs.activeCount,
      ...selectLatestRenderResults(action.items),
    },
  }));

  store.register('jobs/upsert', (state, action) => {
    const job = action.job;
    const items = state.jobs.items.map((j) => (j.id === job.id ? job : j));
    const exists = state.jobs.items.some((j) => j.id === job.id);
    if (!exists) items.unshift(job);
    const activeCount = items.filter((j) => j.status === 'queued' || j.status === 'running').length;
    return {
      ...state,
      jobs: {
        ...state.jobs,
        items,
        total: exists ? state.jobs.total : state.jobs.total + 1,
        activeCount,
        ...selectLatestRenderResults(items),
      },
    };
  });

  store.register('sourcePicker/open', (state, action) => ({
    ...state,
    sourcePicker: { open: true, slot: action.slot ?? null, tab: action.tab ?? 'library' },
  }));

  store.register('sourcePicker/close', (state) => ({
    ...state,
    sourcePicker: { ...state.sourcePicker, open: false },
  }));

  store.register('sourcePicker/tab', (state, action) => ({
    ...state,
    sourcePicker: { ...state.sourcePicker, tab: action.tab },
  }));

  store.register('playback/set', (state, action) => {
    const { type: _type, ...updates } = action;
    return {
      ...state,
      playback: { ...state.playback, ...updates },
    };
  });

  store.register('ui/toast', (state, action) => ({
    ...state,
    ui: { ...state.ui, toast: action.toast },
  }));

  return store;
}

/**
 * Select completed preview/full results independently. A later preview must
 * never replace the most recent completed full render (or vice versa).
 */
export function selectLatestRenderResults(items) {
  const latest = (kind) => {
    let selected = null;
    let selectedAt = -Infinity;
    for (const job of items || []) {
      if (job.kind !== kind || job.status !== 'complete') continue;
      const timestamp = Number(job.created_at ?? job.updated_at);
      const comparable = Number.isFinite(timestamp) ? timestamp : 0;
      if (selected === null || comparable > selectedAt) {
        selected = job;
        selectedAt = comparable;
      }
    }
    return selected;
  };
  return {
    latestPreview: latest('preview'),
    latestRender: latest('render'),
  };
}
