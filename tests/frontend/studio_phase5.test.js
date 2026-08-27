// tests/frontend/studio_phase5.test.js — Phase 5 Studio deck, waveform, cues, analysis, stems, and plan tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function loadContext() {
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const { ProjectManager } = await import('../../src/twobecomeone/studio_static/js/project.js');
  const { audioController } = await import('../../src/twobecomeone/studio_static/js/audio.js');
  const store = registerReducers(new StateStore());
  const projectManager = new ProjectManager(store);
  return { store, projectManager, audioController };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  };
}

test('waveform snapToBeat calculates correctly clamped to duration', async () => {
  const { snapToBeat } = await import('../../src/twobecomeone/studio_static/js/waveform.js');
  const grid = { first_beat: 0.5, interval: 0.5, suggested_downbeat: 1.0 };
  const duration = 10.0;

  // Exact beats: 0.5, 1.0, 1.5, 2.0...
  assert.equal(snapToBeat(0.6, grid, duration), 0.5);
  assert.equal(snapToBeat(0.8, grid, duration), 1.0);
  assert.equal(snapToBeat(1.2, grid, duration), 1.0);
  assert.equal(snapToBeat(1.3, grid, duration), 1.5);
  // Boundary clamp
  assert.equal(snapToBeat(-1.0, grid, duration), 0.5);
  assert.equal(snapToBeat(15.0, grid, duration), 10.0);
});

test('waveform fetchWaveform validates payload and caches immutable response', async () => {
  const { fetchWaveform } = await import('../../src/twobecomeone/studio_static/js/waveform.js');
  let fetchCount = 0;
  const mockFetch = async (url) => {
    fetchCount += 1;
    return jsonResponse({
      version: 1,
      bins: 1200,
      peaks: Array.from({ length: 1200 }, () => [-0.5, 0.5]),
    });
  };

  const p1 = await fetchWaveform('track-wf-1', mockFetch);
  assert.equal(p1.version, 1);
  assert.equal(p1.bins, 1200);
  assert.equal(p1.peaks.length, 1200);
  assert.equal(fetchCount, 1);

  // Cached on second call
  const p2 = await fetchWaveform('track-wf-1', mockFetch);
  assert.equal(p2, p1);
  assert.equal(fetchCount, 1);
});

test('audioController handles track and stem sources as one singleton', async () => {
  const { audioController } = await import('../../src/twobecomeone/studio_static/js/audio.js');

  audioController.play({
    trackId: 'track-1',
    url: '/api/tracks/track-1/audio',
    kind: 'track',
    variant: 'full',
  });
  assert.equal(audioController.current.trackId, 'track-1');
  assert.equal(audioController.current.kind, 'track');
  assert.equal(audioController.playing, true);

  // Playing a stem stops previous and activates stem
  audioController.play({
    trackId: 'track-2',
    url: '/api/stems/s1/audio?name=vocals',
    kind: 'stem',
    stemName: 'vocals',
    variant: 'vocals',
  });
  assert.equal(audioController.current.trackId, 'track-2');
  assert.equal(audioController.current.kind, 'stem');
  assert.equal(audioController.current.stemName, 'vocals');
  assert.equal(audioController.playing, true);

  audioController.stop();
  assert.equal(audioController.current, null);
  assert.equal(audioController.playing, false);
});

test('planRender dispatches verified render plan from server', async () => {
  const { mountPlan } = await import('../../src/twobecomeone/studio_static/js/components/plan.js');
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());

  const project = {
    id: 'p-plan',
    name: 'Plan Test',
    anchor_track_id: 't-anchor',
    lead_track_id: 't-lead',
    anchor_variant: 'full',
    lead_variant: 'vocals',
    settings: { duration: 30, snap: true, pitch_mode: 'match', anchor_gain: 0.8, lead_gain: 0.9 },
  };
  store.dispatch({ type: 'project/set', project });

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/api/renders/plan')) {
      return jsonResponse({
        tempo_ratio: 1.15,
        bpm_change_percent: 15.0,
        anchor_tempo_ratio: 1.0,
        lead_tempo_ratio: 1.15,
        anchor_bpm_change_percent: 0.0,
        lead_bpm_change_percent: 15.0,
        output_bpm: 140.0,
        tempo_mode: 'foundation',
        semitone_shift: -2,
        anchor_key: 'A min',
        lead_key: 'C min',
        anchor_variant: 'full',
        lead_variant: 'vocals',
        pitch_mode: 'match',
        arrangement_mode: 'overlay',
        transition: { start: 0, crossfade_duration: 0, crossfade_curve: 'equal_power' },
        channel: { anchor: { gain: 0.8, pan: 0, eq: { low: 0, mid: 0, high: 0 } }, lead: { gain: 0.9, pan: 0, eq: { low: 0, mid: 0, high: 0 } } },
        sources: { anchor: { output_start: 0, source_start: 0, source_consumed: 30 }, lead: { output_start: 0, source_start: 0, source_consumed: 34.5 } },
        duration: { requested: 30, available: 30, output: 30.0 },
        output_duration: 30.0,
        warnings: ['High tempo shift'],
      });
    }
    return jsonResponse({});
  };

  const container = dom.window.document.createElement('div');
  const dispose = mountPlan({ container, store });

  // Give debounce timer time to run
  await new Promise((r) => setTimeout(r, 300));

  const planState = store.getState().plan;
  assert.equal(planState.loading, false);
  assert.ok(planState.data);
  assert.equal(planState.data.semitone_shift, -2);
  assert.equal(planState.data.lead_variant, 'vocals');

  const text = container.textContent;
  assert.ok(text.includes('Exact Render Plan'));
  assert.ok(text.includes('1.150x') && text.includes('+15.0%'), 'shows lead stretch ratio and percent');
  assert.ok(text.includes('-2 semitones'));
  assert.ok(text.includes('High tempo shift'));
  assert.ok(text.includes('140.0 BPM'), 'shows output BPM');
  assert.equal(container.querySelector('.plan-clock__bar--anchor').style.left, '0%');
  assert.equal(container.querySelector('.plan-clock__bar--lead').style.width, '100%');

  dispose();
});
