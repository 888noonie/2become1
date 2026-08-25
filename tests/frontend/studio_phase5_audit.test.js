import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

/** Install a fetch stub driven by a handler map: method+path-prefix -> fn.
 * Returns { calls, stubs } where stubs holds the per-test mocks.
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    const entries = Object.entries(routes).sort(
      (a, b) => b[0].split(' ')[1].length - a[0].split(' ')[1].length,
    );
    for (const [key, handler] of entries) {
      const [m, prefix] = key.split(' ');
      if (method === m && path.startsWith(prefix)) {
        return handler({ path, options, calls });
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, stubs: routes };
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

// Utility: simulate a minimal StateStore for components without booting the
// full application.
function makeStore(initial = {}) {
  let state = {
    currentProject: null,
    projects: { items: [], total: 0 },
    deckTracks: {},
    save: { status: 'idle', pending: [], error: null, lastError: null },
    plan: { data: null, loading: false, error: null },
    stems: {},
    library: { items: [], total: 0, loading: false, error: null },
    jobs: { items: [], total: 0, activeCount: 0 },
    sourcePicker: { open: false, slot: null, tab: 'library' },
    playback: { trackId: null, source: null, playing: false, time: 0, duration: 0, error: null },
    ui: { toast: null },
    ...initial,
  };
  const listeners = new Set();
  return {
    getState: () => ({ ...state }),
    dispatch: (action) => {
      const { type: _type, ...rest } = action;
      if (action.type === 'plan/set') {
        state = { ...state, plan: { ...state.plan, ...rest } };
      } else if (action.type === 'project/patch-local' && state.currentProject) {
        state = { ...state, currentProject: { ...state.currentProject, ...action.fields } };
      } else if (action.type === 'stems/set') {
        state = { ...state, stems: { ...state.stems, [action.trackId]: action.data } };
      } else if (action.type === 'deckTrack/set') {
        state = { ...state, deckTracks: { ...state.deckTracks, [action.trackId]: action.track } };
      } else {
        state = { ...state };
      }
      listeners.forEach((fn) => fn(state));
      return state;
    },
    subscribe: (fn) => {
      let last = JSON.stringify(state);
      const handler = (nextState) => {
        const current = JSON.stringify(nextState);
        if (current !== last) {
          last = current;
          fn(nextState);
        }
      };
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    subscribeSlice: (slice, fn) => {
      let last = JSON.stringify(state[slice]);
      const handler = (nextState) => {
        const current = JSON.stringify(nextState[slice]);
        if (current !== last) {
          last = current;
          fn(nextState[slice]);
        }
      };
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

test('updateTrackAnalysis forwards JSON null for every reset field', async () => {
  const { calls } = stubFetch({
    'PATCH /api/tracks/t1': async () => jsonResponse({
      id: 't1',
      name: 'Track',
      detected: { bpm: 120, key: { tonic: 'C', mode: 'major' }, beat_grid: { first_beat: 0, suggested_downbeat: 0 } },
      overrides: { bpm: null, tonic: null, mode: null, first_beat: null, suggested_downbeat: null },
    }),
  });

  const { updateTrackAnalysis } = await import('../../src/twobecomeone/studio_static/js/api.js');
  await updateTrackAnalysis('t1', {
    bpm: null,
    tonic: null,
    mode: null,
    first_beat: null,
    suggested_downbeat: null,
  });

  const patchCall = calls.find((c) => c.method === 'PATCH' && c.path === '/api/tracks/t1');
  assert.ok(patchCall, 'PATCH call was made');
  assert.deepEqual(patchCall.body, {
    bpm: null,
    tonic: null,
    mode: null,
    first_beat: null,
    suggested_downbeat: null,
  });
});

test('ProjectManager save applies optimistic local patch before network', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js');
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js');
  const store = registerReducers(new StateStore());
  store.dispatch({ type: 'project/set', project: { id: 'p1', name: 'A', settings: {}, updated_at: 1 } });
  const pm = new ProjectManager(store);

  stubFetch({
    'PATCH /api/projects/p1': async () => jsonResponse({ id: 'p1', name: 'A', settings: { duration: 12 }, updated_at: 2 }),
  });

  pm.save({ settings: { duration: 12 } });
  assert.equal(store.getState().currentProject.settings.duration, 12, 'optimistic patch applied immediately');

  await pm.flushNow();
  assert.equal(store.getState().currentProject.settings.duration, 12, 'value persists after save');
});

test('ProjectManager rejects stale server response that would clobber newer local edit', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js');
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js');
  const store = registerReducers(new StateStore());
  store.dispatch({ type: 'project/set', project: { id: 'p1', name: 'Old', settings: {}, updated_at: 1 } });
  const pm = new ProjectManager(store);

  stubFetch({
    'PATCH /api/projects/p1': async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise((resolve) => setTimeout(() => resolve({
        id: 'p1',
        name: 'ServerName',
        settings: {},
        updated_at: 1,
      }), 100)),
    }),
  });

  pm.save({ name: 'LocalName' });
  await new Promise((r) => setTimeout(r, 10));
  // Simulate a newer local edit arriving while the first PATCH is in flight.
  store.dispatch({ type: 'project/patch-local', fields: { name: 'NewerLocal', updated_at: 5 } });

  await pm.flushNow();

  const current = store.getState().currentProject;
  assert.equal(current.name, 'NewerLocal', 'newer local edit is preserved');
});

test('Deck mount handles undefined deckTracks without throwing', async () => {
  const store = makeStore({
    currentProject: { id: 'p1', anchor_track_id: 't1', anchor_variant: 'full' },
    deckTracks: {},
  });
  const { mountDeck } = await import('../../src/twobecomeone/studio_static/js/components/deck.js');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const dispose = mountDeck({ container, role: 'anchor', store });

  // Re-render explicitly with the same undefined state.
  store.dispatch({ type: 'noop' });

  assert.ok(container.textContent.includes('Resolving track'), 'shows resolving state');
  dispose();
});

test('Plan component reads duration.output and output_duration aliases', async () => {
  const store = makeStore({
    currentProject: {
      id: 'p1',
      anchor_track_id: 'a1',
      lead_track_id: 'l1',
      anchor_variant: 'full',
      lead_variant: 'full',
      settings: { duration: 30 },
    },
    deckTracks: {
      a1: { id: 'a1', name: 'Anchor', duration: 10, bpm: 120, key: { tonic: 'C', mode: 'major' } },
      l1: { id: 'l1', name: 'Lead', duration: 7.669, bpm: 120, key: { tonic: 'C', mode: 'major' } },
    },
  });

  stubFetch({
    'POST /api/renders/plan': async () => jsonResponse({
      tempo_ratio: 1,
      bpm_change_percent: 0,
      semitone_shift: 0,
      effective_bpm: { anchor: 120, lead: 120 },
      effective_keys: { anchor: { tonic: 'C', mode: 'major' }, lead: { tonic: 'C', mode: 'major' } },
      anchor_variant: 'full',
      lead_variant: 'full',
      pitch_mode: 'match',
      selected_sources: { anchor: {}, lead: {} },
      duration: { requested: 30, available: 7.669, output: 7.669 },
      output_duration: 7.669,
      warnings: ['Requested duration exceeds the available overlap'],
    }),
  });

  const { mountPlan } = await import('../../src/twobecomeone/studio_static/js/components/plan.js');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dispose = mountPlan({ container, store });

  // Wait for debounced plan fetch.
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(
    container.textContent.includes('Mash Duration') && container.textContent.includes('0:08'),
    `shows capped duration, got: ${container.textContent}`,
  );
  dispose();
});

test('Stem dialog labels sides plural and uses server-authored audio_url', async () => {
  const store = makeStore({
    currentProject: { id: 'p1', lead_track_id: 't1', lead_variant: 'sides' },
    stems: {
      t1: {
        variants: [
          { name: 'full', audio_url: '/api/tracks/t1/audio' },
          { name: 'sides', stem_set_id: 's1', audio_url: '/api/stems/s1/audio?name=sides', method: 'ffmpeg' },
        ],
      },
    },
  });
  const track = { id: 't1', name: 'Track', duration: 60 };

  stubFetch({
    'GET /api/tracks/t1/stems': async () => jsonResponse({
      track_id: 't1',
      stems: ['full', 'sides'],
      variants: [
        { name: 'full', stem_set_id: null, method: null, model_name: null, device: null, audio_url: '/api/tracks/t1/audio' },
        { name: 'sides', stem_set_id: 's1', method: 'ffmpeg', model_name: null, device: 'cpu', audio_url: '/api/stems/s1/audio?name=sides' },
      ],
    }),
  });

  const { openStemDialog } = await import('../../src/twobecomeone/studio_static/js/components/stem-dialog.js');

  // The dialog is async and waits for user action; we won't block on it.
  openStemDialog({ track, role: 'lead', store }).catch(() => {});

  // Wait for the tray to render.
  await new Promise((r) => setTimeout(r, 50));

  const dialog = document.querySelector('.dialog__body');
  assert.ok(dialog, 'dialog rendered');
  assert.ok(dialog.textContent.includes('Sides (Side channel DSP)'), 'sides labeled truthfully');
});

test('Waveform controls are keyboard accessible via native range and buttons', async () => {
  const { mountWaveform } = await import('../../src/twobecomeone/studio_static/js/waveform.js');
  const container = document.createElement('div');
  document.body.appendChild(container);

  let seeked = null;
  mountWaveform({
    container,
    track: { id: 't1', name: 'Track', duration: 60, beat_grid: { first_beat: 0, interval: 0.5, suggested_downbeat: 0 } },
    role: 'lead',
    getTime: () => 5,
    onSeek: (s) => { seeked = s; },
    getCue: () => null,
    onSetCue: () => {},
    isSnapEnabled: () => true,
  });

  const slider = container.querySelector('input[type="range"]');
  assert.ok(slider, 'range slider fallback exists');

  slider.value = '100';
  slider.dispatchEvent(new window.Event('input'));
  assert.equal(seeked, 10, 'slider seeks to 10s');
});
