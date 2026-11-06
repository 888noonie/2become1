import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMashupController } from '../../src/twobecomeone/studio_static/js/mashup/session.js';
import { setupDom, teardownDom } from './helpers/dom.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PYTHON = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));

function pythonJson(code, arg) {
  const raw = execFileSync(PYTHON, ['-c', code, arg], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function harness(overrides = {}) {
  const project = { id: 'p1', anchor_track_id: null, lead_track_id: null };
  let state = {
    currentProject: project,
    deckTracks: {},
    urlQueue: {
      armed: false,
      items: [],
      activeImportId: null,
      endNotified: { A: false, B: false },
    },
    daw: { lastDirective: null, lastError: null, agentReply: '' },
    jobs: { items: [], total: 0, activeCount: 0 },
  };
  const played = [];
  const submitted = [];
  let jobCount = 0;
  const store = {
    getState: () => state,
    dispatch(action) {
      if (action.type === 'mashup/queue') state = { ...state, urlQueue: action.urlQueue };
      else if (action.type === 'mashup/daw') {
        state = {
          ...state,
          daw: {
            lastDirective: Object.hasOwn(action, 'lastDirective') ? action.lastDirective : state.daw.lastDirective,
            lastError: Object.hasOwn(action, 'lastError') ? action.lastError : state.daw.lastError,
            agentReply: Object.hasOwn(action, 'agentReply') ? action.agentReply : state.daw.agentReply,
          },
        };
      } else if (action.type === 'deckTrack/set') {
        state = { ...state, deckTracks: { ...state.deckTracks, [action.trackId]: action.track } };
      }
      return state;
    },
  };
  const liveMixer = {
    snapshot() {
      return {
        decks: {
          A: { playing: false, ended: false, time: 0, duration: 0 },
          B: { playing: false, ended: false, time: 0, duration: 0 },
        },
      };
    },
    on() { return () => {}; },
    getMixerState() { return { crossfaderPosition: 0 }; },
    setCrossfader() { return { ok: true }; },
    setDeckEq(deck, band, db) {
      return { ok: true, value: { deck, band, db } };
    },
    setDeckTrim() { return { ok: true }; },
    setDeckFilter() { return { ok: true }; },
    setDeckLoop() { return { ok: true }; },
    pause() { return { ok: true }; },
    async play(deck, descriptor) {
      played.push({ deck, descriptor });
      return { ok: true };
    },
  };
  const controller = createMashupController({
    store,
    liveMixer,
    projectManager: {
      assign(slot, trackId) {
        if (slot === 'anchor') project.anchor_track_id = trackId;
        else project.lead_track_id = trackId;
      },
    },
    async submitYouTube(url) {
      if (overrides.submitYouTube) return overrides.submitYouTube(url);
      jobCount += 1;
      const job = { id: `job-${jobCount}`, status: 'queued', result: null, error: null };
      submitted.push(url);
      return job;
    },
    watchJob(jobId, onUpdate) {
      const trackId = `track${jobId.replace('-', '')}ok`;
      onUpdate({ id: jobId, status: 'complete', result: { track_id: trackId }, error: null });
      return () => {};
    },
    async getTrack(trackId) {
      return { id: trackId, name: 'Imported', bpm: 120, audio_url: `/api/tracks/${trackId}/audio`, beat_grid: { first_beat: 0 } };
    },
    async interpret(text) {
      if (overrides.interpret) return overrides.interpret(text);
      return {
        schema: 'playback-directive/v1',
        ok: true,
        tier: 'deterministic',
        source: 'grammar',
        model: null,
        ops: [{ op: 'eq', deck: 'A', band: 'low', db: -12 }],
        declined: [],
        error: null,
      };
    },
  });
  return { controller, store, played, submitted, project };
}

test('an empty armed queue loads the next link onto deck A, then deck B', async () => {
  const { controller, store, played, submitted, project } = harness();
  controller.enqueue([
    'https://youtu.be/abcdefghijk',
    'https://www.youtube.com/watch?v=bbcdefghijk',
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().urlQueue.armed, true);
  assert.equal(submitted.length, 2);
  assert.equal(played.length, 2);
  assert.equal(played[0].deck, 'A');
  assert.equal(played[1].deck, 'B');
  assert.equal(project.anchor_track_id, played[0].descriptor.trackId);
  assert.equal(project.lead_track_id, played[1].descriptor.trackId);
  assert.equal(store.getState().urlQueue.activeImportId, null);
});

test('a mix command applies the returned directive and records it', async () => {
  const { controller, store } = harness();
  await controller.command('drop the bass on deck A');
  assert.equal(store.getState().daw.lastDirective.ops[0].db, -12);
  assert.equal(store.getState().daw.lastError, null);
  assert.equal(
    store.getState().daw.agentReply,
    'I have dropped the bass to come in on the next suitable cue',
  );
});

test('a failed import stays on the queue item after a vocal-loop command', async () => {
  const rejection = pythonJson(
    'import json,sys; from twobecomeone.queue_acquisition import plan_youtube_acquisition; print(json.dumps(plan_youtube_acquisition(sys.argv[1])))',
    'not-a-youtube-link',
  );
  const { controller, store } = harness({
    submitYouTube: async () => {
      throw new Error(rejection.error.message);
    },
    interpret: (text) => pythonJson(
      'import json,sys; from twobecomeone.mashup_intent import interpret; print(json.dumps(interpret(sys.argv[1])))',
      text,
    ),
  });
  controller.enqueue(['not-a-youtube-link']);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = store.getState().urlQueue.items[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, rejection.error.message);
  assert.equal(store.getState().daw.lastDirective, null);
  assert.equal(store.getState().daw.lastError, null);

  await controller.command('loop the vocal on deck B');
  const afterCommand = store.getState();
  const decline = afterCommand.daw.lastDirective.declined[0];
  assert.equal(afterCommand.urlQueue.items[0].error.message, rejection.error.message);
  assert.equal(decline.code, 'STEM_LOOP_UNAVAILABLE');
  assert.equal(afterCommand.daw.lastError, null);

  controller.enqueue(['https://example.com/still-not-youtube']);
  await new Promise((resolve) => setImmediate(resolve));
  const afterSecondFailure = store.getState();
  assert.equal(afterSecondFailure.urlQueue.items[0].error.message, rejection.error.message);
  assert.equal(afterSecondFailure.urlQueue.items[1].status, 'failed');
  assert.equal(afterSecondFailure.daw.lastDirective.declined[0].code, 'STEM_LOOP_UNAVAILABLE');
  assert.equal(afterSecondFailure.daw.lastError, null);

  const dom = setupDom();
  try {
    const { renderUrlQueuePanel } = await import(
      '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
    );
    const { renderDawCommandBar } = await import(
      '../../src/twobecomeone/studio_static/js/components/daw-command-bar.js'
    );
    const queue = document.createElement('div');
    const bar = document.createElement('div');
    document.body.append(queue, bar);
    renderUrlQueuePanel({ container: queue, state: afterSecondFailure });
    renderDawCommandBar({ container: bar, state: afterSecondFailure });
    const row = queue.querySelector('li.mashup-queue__item');
    assert.equal(row.querySelector('.mashup-queue__url').textContent, 'not-a-youtube-link');
    assert.equal(row.querySelector('.mashup-queue__status').textContent, 'failed');
    assert.equal(row.querySelector('.mashup-queue__error').textContent, rejection.error.message);
    const shown = [...bar.querySelectorAll('.mashup-daw__declined li')].map((item) => item.textContent);
    assert.deepEqual(shown, [decline.message]);
    assert.equal(bar.querySelector('.mashup-daw__error'), null);
    assert.equal(bar.textContent.includes(rejection.error.message), false);
  } finally {
    teardownDom(dom);
  }
});

test('a rejected directive records the error and does not require a deck', async () => {
  const { controller, store } = harness();
  controller.directive({ ok: false, schema: 'nope' });
  assert.ok(store.getState().daw.lastError);
  assert.equal(store.getState().daw.lastError.code.length > 0, true);
});
