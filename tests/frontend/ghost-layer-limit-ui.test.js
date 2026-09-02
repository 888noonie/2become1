// tests/frontend/ghost-layer-limit-ui.test.js — Phase 12A.0 preview-entry gate.
//
// While a committed layer exists, the Ghost preview entry point must refuse
// with truthful copy (the server revalidates with L_LAYER_LIMIT; this is the
// convenience gate the UI shows before any dialog opens).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function loadModule() {
  return import('../../src/twobecomeone/studio_static/js/components/ghost-phrase.js');
}

const project = { id: 'p-1' };
const anchorTrack = { id: 't-a', name: 'Anchor', bpm: 120, duration: 60, beat_grid: { first_beat: 0, interval: 0.5 } };
const leadTrack = { id: 't-b', name: 'Lead', bpm: 120, duration: 60, beat_grid: { first_beat: 0, interval: 0.5 } };
const playback = { playing: true };

function baseArgs(session) {
  return { project, anchorTrack, leadTrack, playback, session };
}

test('preview entry is allowed while no committed layer exists', async () => {
  const { checkGhostPreconditions } = await loadModule();
  const result = checkGhostPreconditions(baseArgs({ committedLayers: [] }));
  assert.equal(result.ok, true);
});

test('preview entry is refused truthfully while a committed layer exists', async () => {
  const { checkGhostPreconditions } = await loadModule();
  const session = { committedLayers: [{ actionId: 'c-1', layerId: 'layer-c-1' }] };
  const result = checkGhostPreconditions(baseArgs(session));
  assert.equal(result.ok, false);
  assert.match(result.message, /Undo the committed Ghost first/i);
});

test('preview entry is allowed again after the layer is reverted', async () => {
  const { checkGhostPreconditions } = await loadModule();
  const session = { committedLayers: [], revertedLayers: [{ actionId: 'c-1' }] };
  const result = checkGhostPreconditions(baseArgs(session));
  assert.equal(result.ok, true);
});

test('missing session shape never blocks the preview entry', async () => {
  // Defensive: an absent session (older hydration) must not throw or block.
  const { checkGhostPreconditions } = await loadModule();
  const result = checkGhostPreconditions({ project, anchorTrack, leadTrack, playback });
  assert.equal(result.ok, true);
});