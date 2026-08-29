// tests/frontend/actions/permission.test.js — V1 constitutional permission gate.
//
// Phase 8A acceptance: human preview is allowed, producer preview is denied
// unless producerPreviewAllowed === true, producer commit/reject are always
// denied, including revert_commit, gate returns structured Result and never throws.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_TYPES,
} from '../../../src/twobecomeone/studio_static/js/actions/contracts.js';
import {
  checkPermission,
  PERMISSION_DEFAULTS,
} from '../../../src/twobecomeone/studio_static/js/actions/permission.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

function preview(actor) {
  return {
    id: 'a-1',
    schemaVersion: 1,
    type: ACTION_TYPES.PREVIEW_LAYER,
    actor,
    requestedAt: '2026-08-27T00:00:00Z',
    idempotencyKey: 'k',
    payload: {
      source: { deck: 'A', stem: 'vocal', region: { id: 'r' } },
      destination: { deck: 'B' },
      timing: { launch: 'next_phrase', quantize: true },
      gainDb: -3,
    },
  };
}

function commit(actor) {
  return {
    id: 'a-2',
    schemaVersion: 1,
    type: ACTION_TYPES.COMMIT_LAYER,
    actor,
    requestedAt: '2026-08-27T00:00:01Z',
    idempotencyKey: 'k',
    payload: {
      proposalId: 'p-1',
      acceptedAt: '2026-08-27T00:00:02Z',
      acceptedAsset: { id: 'as-1', contentHash: 'h', transformSpec: {} },
    },
  };
}

function reject(actor) {
  return {
    id: 'a-3',
    schemaVersion: 1,
    type: ACTION_TYPES.REJECT_PROPOSAL,
    actor,
    requestedAt: '2026-08-27T00:00:03Z',
    idempotencyKey: 'k',
    payload: {
      proposalId: 'p-1',
      rejectedAt: '2026-08-27T00:00:04Z',
    },
  };
}

function revert(actor) {
  return {
    id: 'a-4', schemaVersion: 1, type: ACTION_TYPES.REVERT_COMMIT, actor,
    requestedAt: '2026-08-27T00:00:05Z', idempotencyKey: 'rk',
    payload: { commitActionId: 'a-2', revertedAt: '2026-08-27T00:00:06Z' },
  };
}

test('human preview is always allowed', () => {
  const r = checkPermission(preview({ type: 'human', id: 'richard' }), {});
  assert.equal(r.ok, true);
});

test('producer preview is denied by default', () => {
  const r = checkPermission(preview({ type: 'producer', id: 'ghost' }), {});
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.P_PRODUCER_PREVIEW_DENIED);
});

test('producer preview is allowed when producerPreviewAllowed=true', () => {
  const r = checkPermission(
    preview({ type: 'producer', id: 'ghost' }),
    { producerPreviewAllowed: true },
  );
  assert.equal(r.ok, true);
});

test('producer commit is denied, human commit is allowed', () => {
  const denied = checkPermission(commit({ type: 'producer', id: 'ghost' }), {
    producerPreviewAllowed: true,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, ERROR_CODES.P_ACTOR_NOT_ALLOWED);
  assert.equal(denied.details.action, ACTION_TYPES.COMMIT_LAYER);

  const allowed = checkPermission(commit({ type: 'human', id: 'richard' }), {});
  assert.equal(allowed.ok, true);
});

test('producer reject is denied, human reject is allowed', () => {
  const denied = checkPermission(reject({ type: 'producer', id: 'ghost' }), {
    producerPreviewAllowed: true,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, ERROR_CODES.P_ACTOR_NOT_ALLOWED);

  const allowed = checkPermission(reject({ type: 'human', id: 'richard' }), {});
  assert.equal(allowed.ok, true);
});

test('producer revert is denied, human revert is allowed', () => {
  const denied = checkPermission(revert({ type: 'producer', id: 'ghost' }), {});
  assert.equal(denied.ok, false);
  assert.equal(denied.code, ERROR_CODES.P_ACTOR_NOT_ALLOWED);
  assert.equal(denied.details.action, ACTION_TYPES.REVERT_COMMIT);
  assert.equal(checkPermission(revert({ type: 'human', id: 'richard' }), {}).ok, true);
});

test('gate defaults: producerPreviewAllowed=false', () => {
  assert.equal(PERMISSION_DEFAULTS.producerPreviewAllowed, false);
});

test('gate returns failure for unknown action types and missing actors', () => {
  const unknownType = checkPermission({
    type: 'sneak_audio', actor: { type: 'human', id: 'x' },
  }, {});
  assert.equal(unknownType.ok, false);
  assert.equal(unknownType.code, ERROR_CODES.V_UNKNOWN_TYPE);

  const missingActor = checkPermission({
    type: ACTION_TYPES.COMMIT_LAYER,
  }, {});
  assert.equal(missingActor.ok, false);
  assert.equal(missingActor.code, ERROR_CODES.V_MISSING_ACTOR);
});
