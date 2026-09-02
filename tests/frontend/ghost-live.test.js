// tests/frontend/ghost-live.test.js — Phase 12B UI truthfulness.
//
// The committed-layers view must show the resolved live state per layer:
// loading / scheduled / live / idle / error, with truthful copy replacing
// the old "Included in the next preview/render" promise line (which stays
// only as a secondary, accurate note), an aria-live status region, and the
// Undo control disabled while the live engine is mid-transition.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function loadView() {
  return import('../../src/twobecomeone/studio_static/js/components/committed-layers.js');
}

class FakeStore {
  constructor(session, liveStatus) {
    this.session = session;
    this.live = liveStatus || { layers: [] };
    this.subscribers = [];
    this.state = { session, ghostLiveStatus: this.live };
  }
  getState() { return this.state; }
  subscribeSlice(slice, fn) {
    if (slice === 'session' || slice === 'ghostLiveStatus') {
      this.subscribers.push(fn);
    }
    return () => {};
  }
  dispatch() {}
}

function committedSession() {
  return {
    committedLayers: [{
      layerId: 'layer-c-1',
      actionId: 'c-1',
      proposalId: 'a-1',
      launchReceipt: { launchBeat: 32, targetBpm: 120 },
      placement: { gainDb: -6 },
      transformSpec: { semanticRegion: { startBeat: 0, endBeat: 16 } },
      asset: { id: 'ga-1', contentHash: 'sha256:abc' },
    }],
    revertedLayers: [],
  };
}

function liveFor(state, extra = {}) {
  return { layers: [{ layerId: 'layer-c-1', actionId: 'c-1', state, launchBeat: 32, error: null, ...extra }] };
}

async function mount(session, live) {
  const { mountCommittedLayers } = await loadView();
  const store = new FakeStore(session, live);
  const container = document.createElement('div');
  const undoCalls = [];
  const disposer = mountCommittedLayers({
    container,
    store,
    onUndo: async (id) => { undoCalls.push(id); return { ok: true }; },
  });
  return { store, container, undoCalls, disposer };
}

const LIVE_COPY = {
  loading: 'Loading committed Ghost…',
  scheduled: 'Scheduled for the next Lead phrase',
  live: 'Playing live',
  idle: 'Ready when the Lead is playing',
  error: 'Live playback unavailable',
};

test('live layer shows truthful Playing-live copy and keeps the render note secondary', async () => {
  const { container } = await mount(committedSession(), liveFor('live'));
  const item = container.querySelector('.committed-layer');
  const truth = item.querySelector('.committed-layer__truth').textContent;
  assert.match(truth, /Playing live/);
  // The render-inclusion line is secondary and still accurate.
  const secondary = item.querySelector('.committed-layer__render-note');
  assert.ok(secondary);
  assert.match(secondary.textContent, /preview\/render/);
});

test('scheduled layer shows the armed-boundary copy', async () => {
  const { container } = await mount(committedSession(), liveFor('scheduled'));
  const truth = container.querySelector('.committed-layer__truth').textContent;
  assert.match(truth, /Scheduled for the next Lead phrase/);
});

test('idle layer shows the honest Lead-not-playing copy', async () => {
  const { container } = await mount(committedSession(), liveFor('idle'));
  const truth = container.querySelector('.committed-layer__truth').textContent;
  assert.match(truth, /Ready when the Lead is playing/);
});

test('loading layer shows the loading copy', async () => {
  const { container } = await mount(committedSession(), liveFor('loading'));
  const truth = container.querySelector('.committed-layer__truth').textContent;
  assert.match(truth, /Loading committed Ghost/);
});

test('error layer shows the error copy with its stable code', async () => {
  const { container } = await mount(committedSession(), liveFor('error', {
    error: { code: 'S_ASSET_UNAVAILABLE', message: 'the committed audio could not be loaded' },
  }));
  const item = container.querySelector('.committed-layer');
  const truth = item.querySelector('.committed-layer__truth').textContent;
  assert.match(truth, /Live playback unavailable/);
  const error = item.querySelector('.committed-layer__error');
  assert.ok(error);
  assert.match(error.textContent, /S_ASSET_UNAVAILABLE|could not be loaded/);
});

test('the truth region is aria-live polite', async () => {
  const { container } = await mount(committedSession(), liveFor('live'));
  const truth = container.querySelector('.committed-layer__truth');
  assert.equal(truth.getAttribute('aria-live'), 'polite');
});

test('missing live state falls back to idle copy (honest default)', async () => {
  const { container } = await mount(committedSession(), { layers: [] });
  const truth = container.querySelector('.committed-layer__truth').textContent;
  assert.match(truth, /Ready when the Lead is playing/);
});

test('badge element exposes the raw state class per layer', async () => {
  const { container } = await mount(committedSession(), liveFor('live'));
  const badge = container.querySelector('.committed-layer__badge');
  assert.ok(badge);
  assert.match(badge.className, /committed-layer__badge--live/);
  assert.equal(badge.textContent, 'live');
});