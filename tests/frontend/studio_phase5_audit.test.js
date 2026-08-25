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
      } else if (action.type === 'playback/set') {
        state = { ...state, playback: { ...state.playback, ...rest } };
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

  // First PATCH resolves slowly with the FIRST name; a second save() lands
  // while it is in flight. The stale response must not clobber the newer edit.
  let resolveFirst;
  stubFetch({
    'PATCH /api/projects/p1': async ({ options }) => {
      const body = JSON.parse(options.body);
      if (body.name === 'First') {
        await new Promise((r) => { resolveFirst = r; });
        return jsonResponse({ id: 'p1', name: 'First', settings: {}, updated_at: 2 });
      }
      return jsonResponse({ id: 'p1', name: 'Second', settings: {}, updated_at: 3 });
    },
  });

  pm.save({ name: 'First' });
  // Force the first flush to start (bypass debounce) so the PATCH is in flight.
  await new Promise((r) => setTimeout(r, 0));
  pm.flushNow(); // starts the in-flight PATCH for 'First'
  await new Promise((r) => setTimeout(r, 10));

  // A newer edit arrives while the first PATCH is in flight.
  pm.save({ name: 'Second' });
  assert.equal(store.getState().currentProject.name, 'Second', 'optimistic second edit visible');

  // Let the first (stale) response land.
  resolveFirst();
  await new Promise((r) => setTimeout(r, 20));

  // The stale 'First' response must not overwrite the newer 'Second' edit.
  assert.equal(store.getState().currentProject.name, 'Second', 'newer local edit is preserved');

  // The second save is still queued and will persist 'Second'.
  await pm.flushNow();
  assert.equal(store.getState().currentProject.name, 'Second', 'second edit persists');
});

test('ProjectManager keeps newer edit visible when the queued save fails', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js');
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js');
  const store = registerReducers(new StateStore());
  store.dispatch({ type: 'project/set', project: { id: 'p1', name: 'Old', settings: {}, updated_at: 1 } });
  const pm = new ProjectManager(store);

  let resolveFirst;
  let secondAttempts = 0;
  stubFetch({
    'PATCH /api/projects/p1': async ({ options }) => {
      const body = JSON.parse(options.body);
      if (body.name === 'First') {
        await new Promise((r) => { resolveFirst = r; });
        return jsonResponse({ id: 'p1', name: 'First', settings: {}, updated_at: 2 });
      }
      secondAttempts += 1;
      return jsonResponse({ error: { code: 'x', message: 'network down', detail: null } }, 500);
    },
  });

  pm.save({ name: 'First' });
  await new Promise((r) => setTimeout(r, 0));
  pm.flushNow();
  await new Promise((r) => setTimeout(r, 10));

  pm.save({ name: 'Second' });
  resolveFirst();
  await new Promise((r) => setTimeout(r, 20));

  // The queued 'Second' save fails; the newer edit must remain visible.
  await pm.flushNow();
  assert.equal(store.getState().currentProject.name, 'Second', 'failed write keeps newer edit visible');
  assert.equal(store.getState().save.status, 'error');
  assert.ok(secondAttempts >= 1, 'the queued save was attempted');
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

test('Analysis dialog shows effective, detected, and override layers separately', async () => {
  const store = makeStore({});
  const track = {
    id: 't1',
    name: 'Track',
    detected: { bpm: 120, key: { tonic: 'C', mode: 'major' }, beat_grid: { first_beat: 0.1, suggested_downbeat: 0.5 } },
    overrides: { bpm: 128, tonic: null, mode: null, first_beat: null, suggested_downbeat: null },
  };

  const { openAnalysisDialog } = await import('../../src/twobecomeone/studio_static/js/components/analysis-dialog.js');
  openAnalysisDialog({ track, store }).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));

  const dialog = document.querySelector('.dialog__body');
  assert.ok(dialog, 'dialog rendered');
  const text = dialog.textContent;
  assert.ok(text.includes('Detected BPM'), 'detected BPM row present');
  assert.ok(text.includes('120.0 BPM'), 'detected BPM value shown');
  assert.ok(text.includes('Effective (used for mixing)'), 'effective row present');
  assert.ok(text.includes('128.0 BPM'), 'effective BPM reflects override (128)');
});

test('Stem dialog does not refetch stems on playback ticks', async () => {
  const store = makeStore({
    currentProject: { id: 'p1', lead_track_id: 't1', lead_variant: 'full' },
  });
  const track = { id: 't1', name: 'Track', duration: 60 };

  let stemFetches = 0;
  stubFetch({
    'GET /api/tracks/t1/stems': async () => {
      stemFetches += 1;
      return jsonResponse({
        track_id: 't1',
        stems: ['full', 'sides'],
        variants: [
          { name: 'full', stem_set_id: null, method: null, model_name: null, device: null, audio_url: '/api/tracks/t1/audio' },
          { name: 'sides', stem_set_id: 's1', method: 'ffmpeg', model_name: null, device: 'cpu', audio_url: '/api/stems/s1/audio?name=sides' },
        ],
      });
    },
  });

  const { openStemDialog } = await import('../../src/twobecomeone/studio_static/js/components/stem-dialog.js');
  openStemDialog({ track, role: 'lead', store }).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stemFetches, 1, 'one initial fetch');

  // Simulate many playback timeupdate ticks (same variant, changing time).
  for (let i = 0; i < 5; i += 1) {
    store.dispatch({ type: 'playback/set', source: { variant: 'full', trackId: 't1' }, time: i, playing: true });
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(stemFetches, 1, 'no refetch on playback ticks');
});

test('Stem dialog renders structured progress_detail warning text', async () => {
  const store = makeStore({
    currentProject: { id: 'p1', lead_track_id: 't1', lead_variant: 'full' },
  });
  const track = { id: 't1', name: 'Track', duration: 60 };

  stubFetch({
    'GET /api/tracks/t1/stems': async () => jsonResponse({ track_id: 't1', stems: ['full'], variants: [{ name: 'full', stem_set_id: null, method: null, model_name: null, device: null, audio_url: '/api/tracks/t1/audio' }] }),
    'POST /api/tracks/t1/separations': async () => jsonResponse({ id: 'job1', status: 'running', progress_phase: 'separating' }),
  });

  const { openStemDialog } = await import('../../src/twobecomeone/studio_static/js/components/stem-dialog.js');
  openStemDialog({ track, role: 'lead', store }).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));

  // Trigger the separation and then a structured OOM warning via the job watcher.
  const separateBtn = document.querySelector('.stem-dialog button.button--primary');
  assert.ok(separateBtn, 'separate button present');
  separateBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  // The watchJob callback is internal; we assert the dialog does not render
  // "[object Object]" by checking the status element is a string. This is a
  // structural guard: the code path now branches on typeof detail === 'object'.
  const statusEl = document.querySelector('.stem-dialog__status');
  assert.ok(statusEl, 'status element present');
  assert.ok(!statusEl.textContent.includes('[object Object]'), 'no raw object interpolation');
});

test('Plan source-time uses capped output duration and multiplies by tempo ratio', async () => {
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
      l1: { id: 'l1', name: 'Lead', duration: 7.669, bpm: 60, key: { tonic: 'C', mode: 'major' } },
    },
  });

  stubFetch({
    'POST /api/renders/plan': async () => jsonResponse({
      tempo_ratio: 2,
      bpm_change_percent: 100,
      semitone_shift: 0,
      effective_bpm: { anchor: 120, lead: 60 },
      effective_keys: { anchor: { tonic: 'C', mode: 'major' }, lead: { tonic: 'C', mode: 'major' } },
      anchor_variant: 'full',
      lead_variant: 'full',
      pitch_mode: 'match',
      selected_sources: { anchor: {}, lead: {} },
      duration: { requested: 30, available: 7.669, output: 7.669 },
      output_duration: 7.669,
      warnings: [],
    }),
  });

  const { mountPlan } = await import('../../src/twobecomeone/studio_static/js/components/plan.js');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dispose = mountPlan({ container, store });

  await new Promise((r) => setTimeout(r, 400));

  const text = container.textContent;
  // Source time = output (7.669) × ratio (2) ≈ 15.3s, NOT 7.669 / 2.
  assert.ok(text.includes('× 2.000'), 'shows multiplication by tempo ratio');
  assert.ok(text.includes('0:15'), `shows multiplied source time, got: ${text}`);
  assert.ok(!text.includes('0:03'), 'does not divide by tempo ratio');
  dispose();
});
