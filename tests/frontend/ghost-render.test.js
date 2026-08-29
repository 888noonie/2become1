// Phase 11B frontend render ownership and hydration hardening.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRenderBody } from '../../src/twobecomeone/studio_static/js/render.js';
import { validateProjectionShape } from '../../src/twobecomeone/studio_static/js/actions/hydration.js';

function project() {
  return {
    id: 'project-solid',
    anchor_track_id: 'anchor',
    lead_track_id: 'lead',
    anchor_variant: 'vocals',
    lead_variant: 'full',
    settings: {},
  };
}

function projection(layer = null) {
  return {
    projection_version: 1,
    last_sequence: 3,
    session: {
      deckAssignments: { A: null, B: null },
      committedLayers: layer ? [layer] : [],
      revertedLayers: [],
      acceptedActionIds: layer ? [layer.actionId] : [],
    },
    proposals: { byId: {}, order: [], activeIds: [] },
  };
}

test('render body supplies only project scope, never client-authored committed layers', () => {
  const body = buildRenderBody(project());
  assert.equal(body.project_id, 'project-solid');
  assert.equal(Object.hasOwn(body, 'committed_layers'), false);
  assert.equal(Object.hasOwn(body, 'assetId'), false);
});

test('hydration rejects layers in both committed and reverted lists', () => {
  const layer = { actionId: 'commit-1', nested: { safe: true } };
  const body = projection(layer);
  body.session.revertedLayers = [{ ...layer, revertedBy: 'undo-1' }];
  assert.equal(validateProjectionShape(body).ok, false);
});

test('hydration accepts bounded plain layer provenance and rejects class instances', () => {
  const layer = {
    actionId: 'commit-1',
    acceptedAsset: { id: 'ga-1', transformSpec: { semanticRegion: { startBeat: 0, endBeat: 8 } } },
  };
  assert.deepEqual(validateProjectionShape(projection(layer)), { ok: true });
  const hostile = projection(layer);
  hostile.session.committedLayers[0].runtime = new Date();
  assert.equal(validateProjectionShape(hostile).ok, false);
});

test('hydration bounds committed layer counts', () => {
  const body = projection();
  body.session.committedLayers = Array.from({ length: 257 }, (_, i) => ({ actionId: `c-${i}` }));
  assert.equal(validateProjectionShape(body).ok, false);
});
