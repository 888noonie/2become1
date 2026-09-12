// tests/frontend/runtime/live-mixer-wiring.test.js — Phase 15A six-file wiring contract.
//
// Proves the decks slice, LiveMixer injection, and Ghost Lead ownership read
// deck B from the mixer (not the library preview singleton).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from '../helpers/dom.js';

import { GhostController } from '../../../src/twobecomeone/studio_static/js/runtime/ghost-controller.js';
import { LiveMixer } from '../../../src/twobecomeone/studio_static/js/runtime/live-mixer.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function loadStore() {
  const { StateStore, registerReducers } = await import('../../../src/twobecomeone/studio_static/js/state.js');
  return registerReducers(new StateStore());
}

test('initial state includes serializable empty decks A and B', async () => {
  const store = await loadStore();
  const { decks } = store.getState();
  assert.equal(typeof decks.A.playing, 'boolean');
  assert.equal(typeof decks.B.playing, 'boolean');
  assert.equal(decks.A.trackId, null);
  assert.equal(decks.B.trackId, null);
  assert.ok(!('element' in decks.A));
});

test('decks/set updates one deck immutably with plain JSON only', async () => {
  const store = await loadStore();
  const before = store.getState().decks;
  const nextDeck = {
    trackId: 't1', kind: 'track', variant: 'full', stemName: null, jobId: null, title: 'One',
    generation: 1, playing: true, paused: false, ended: false,
    contextState: 'running', contextClock: 1.5, error: null, time: 2, duration: 120,
  };
  store.dispatch({ type: 'decks/set', deck: 'A', deckState: nextDeck });
  const after = store.getState().decks;
  assert.notEqual(after, before);
  assert.equal(after.A.trackId, 't1');
  assert.equal(after.A.playing, true);
  assert.equal(after.B.trackId, null);

  class Handle {}
  const bBefore = store.getState().decks.B;
  store.dispatch({ type: 'decks/set', deck: 'B', deckState: { ...nextDeck, node: new Handle() } });
  assert.deepEqual(store.getState().decks.B, bBefore);
});

test('decks/set accepts a full A/B snapshot', async () => {
  const store = await loadStore();
  const empty = store.getState().decks.A;
  store.dispatch({
    type: 'decks/set',
    decks: {
      A: { ...empty, trackId: 'a', playing: true },
      B: { ...empty, trackId: 'b', playing: true },
    },
  });
  const { decks } = store.getState();
  assert.equal(decks.A.trackId, 'a');
  assert.equal(decks.B.trackId, 'b');
  assert.equal(decks.A.playing, true);
  assert.equal(decks.B.playing, true);
});

test('GhostController ownership reads Lead deck B from liveMixer', async () => {
  const store = {
    state: {
      currentProject: { id: 'p1', lead_track_id: 'lead-1' },
      deckTracks: { 'lead-1': { id: 'lead-1', bpm: 120, beat_grid: { first_beat: 0, interval: 0.5 } } },
      ghostStatus: { phase: 'idle' },
      proposals: { byId: {}, order: [], activeIds: [] },
    },
    getState() { return structuredClone(this.state); },
    dispatch(action) {
      if (action.type === 'v1/ghost-status/set') {
        this.state.ghostStatus = { ...this.state.ghostStatus, ...structuredClone(action.patch) };
      }
    },
  };
  const liveMixer = {
    getDeck(name) {
      if (name !== 'B') return { trackId: null, playing: false, time: 0 };
      return { trackId: 'lead-1', playing: true, time: 4.5 };
    },
  };
  const controller = new GhostController({
    store,
    api: {},
    liveMixer,
    audioContextFactory: { create: () => ({ currentTime: 0, state: 'running', resume: async () => {} }) },
  });
  assert.equal(controller._destinationOwnedAndPlaying(), true);
  liveMixer.getDeck = () => ({ trackId: 'lead-1', playing: false, time: 4.5 });
  assert.equal(controller._destinationOwnedAndPlaying(), false);
});

test('app-context constructs a shared LiveMixer singleton', async () => {
  const { liveMixer } = await import('../../../src/twobecomeone/studio_static/js/app-context.js');
  assert.ok(liveMixer instanceof LiveMixer);
  assert.equal(typeof liveMixer.getDeck('A').playing, 'boolean');
  assert.equal(typeof liveMixer.getDeck('B').playing, 'boolean');
});

test('playing deck A does not stop deck B after wiring leaf', async () => {
  class FakeMediaElement {
    constructor() { this.paused = true; this.currentTime = 0; this.duration = 10; this.src = ''; this._listeners = {}; }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() { this.src = ''; }
  }
  class FakeCtx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createMediaElementSource() { return { connect() { return {}; }, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() { return {}; }, disconnect() {} }; }
    addEventListener() {}
    removeEventListener() {}
    resume() { return Promise.resolve(); }
  }
  const elements = [new FakeMediaElement(), new FakeMediaElement()];
  let idx = 0;
  const mixer = new LiveMixer({
    audioContextFactory: { create: () => new FakeCtx() },
    mediaElementFactory: { create: () => elements[idx++] || new FakeMediaElement() },
  });
  await mixer.play('A', { trackId: 'a', url: '/a', kind: 'track', variant: 'full' });
  await mixer.play('B', { trackId: 'b', url: '/b', kind: 'track', variant: 'full' });
  assert.equal(mixer.getDeck('A').playing, true);
  assert.equal(mixer.getDeck('B').playing, true);
  assert.equal(elements[0].paused, false);
  assert.equal(elements[1].paused, false);
});
