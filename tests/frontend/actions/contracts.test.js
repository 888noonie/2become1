// tests/frontend/actions/contracts.test.js — V1 frozen Action contract.
//
// Phase 8A acceptance: validator returns structured Result, never mutates
// input, never throws, rejects bad decks/bounds/keys/payloads with stable
// codes, and accepts well-formed preview/commit/reject envelopes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_TYPES,
  SCHEMA_VERSION,
  validateAction,
  isSerializable,
  GAIN_MIN_DB,
  GAIN_MAX_DB,
} from '../../../src/twobecomeone/studio_static/js/actions/contracts.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

function previewPayload(overrides = {}) {
  return {
    source: {
      deck: 'A',
      stem: 'vocal',
      region: {
        id: 'chorus_2',
        label: 'chorus 2',
        startBeat: 16,
        endBeat: 32,
        gridRevision: 'g-2026-08-27',
      },
    },
    destination: { deck: 'B' },
    timing: { launch: 'next_phrase', quantize: true },
    gainDb: -3,
    ...overrides,
  };
}

function baseAction(overrides = {}) {
  return {
    id: 'a-1',
    schemaVersion: SCHEMA_VERSION,
    type: ACTION_TYPES.PREVIEW_LAYER,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:00Z',
    idempotencyKey: 'key-1',
    payload: previewPayload(),
    ...overrides,
  };
}

test('frozen Action envelope accepts a valid preview_layer', () => {
  const result = validateAction(baseAction());
  assert.equal(result.ok, true);
  assert.equal(result.value.type, 'preview_layer');
});

test('rejects null/non-object actions', () => {
  for (const bad of [null, undefined, 42, 'string', true]) {
    const r = validateAction(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, ERROR_CODES.V_INVALID_TYPE);
  }
});

test('rejects unknown top-level keys', () => {
  const bad = { ...baseAction(), __proto__: { evil: true }, rogue: 1 };
  // JSON-shaped check: setting a key directly is fine for the schema, but
  // unexpected keys must be reported. Construct one without prototype
  // pollution tricks.
  const r = validateAction({ ...baseAction(), rogue: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY);
  assert.equal(r.details.unexpectedKey, 'rogue');
});

test('rejects unknown action type', () => {
  const r = validateAction(baseAction({ type: 'steal_deck' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_UNKNOWN_TYPE);
});

test('rejects bad schemaVersion', () => {
  const r = validateAction(baseAction({ schemaVersion: 2 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_INVALID_TYPE);
});

test('rejects missing actor fields and unknown actor types', () => {
  for (const bad of [
    baseAction({ actor: undefined }),
    baseAction({ actor: { id: 'richard' } }),
    baseAction({ actor: { type: 'ai' } }),
  ]) {
    const r = validateAction(bad);
    assert.equal(r.ok, false);
  }
});

test('rejects non-string id/requestedAt/idempotencyKey', () => {
  const cases = [
    baseAction({ id: '' }),
    baseAction({ id: 42 }),
    baseAction({ requestedAt: '' }),
    baseAction({ idempotencyKey: '' }),
  ];
  for (const a of cases) {
    const r = validateAction(a);
    assert.equal(r.ok, false);
    assert.ok(
      r.code === ERROR_CODES.V_MISSING_ID
        || r.code === ERROR_CODES.V_MISSING_REQUESTED_AT
        || r.code === ERROR_CODES.V_MISSING_IDEMPOTENCY_KEY,
      `unexpected code ${r.code}`,
    );
  }
});

test('rejects preview payload with same source/destination deck', () => {
  const r = validateAction(baseAction({
    payload: previewPayload({
      source: { deck: 'A', stem: 'vocal', region: { id: 'r1' } },
      destination: { deck: 'A' },
    }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_SAME_DECK);
});

test('rejects preview payload with bad deck', () => {
  const r = validateAction(baseAction({
    payload: previewPayload({
      source: { deck: 'C', stem: 'vocal', region: { id: 'r1' } },
    }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_INVALID_DECK);
});

test('rejects preview payload with bad gain', () => {
  for (const bad of [GAIN_MAX_DB + 0.5, GAIN_MIN_DB - 0.5, '3', NaN]) {
    const r = validateAction(baseAction({
      payload: previewPayload({ gainDb: bad }),
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, ERROR_CODES.V_INVALID_GAIN);
  }
});

test('rejects preview payload with bad launch/quantize', () => {
  const a = baseAction({
    payload: previewPayload({ timing: { launch: 'now', quantize: true } }),
  });
  const r = validateAction(a);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_INVALID_LAUNCH);

  const a2 = baseAction({
    payload: previewPayload({ timing: { launch: 'next_phrase', quantize: 'yes' } }),
  });
  const r2 = validateAction(a2);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ERROR_CODES.V_INVALID_QUANTIZE);
});

test('rejects preview payload with bad region bounds', () => {
  const cases = [
    // Non-object region is invalid.
    baseAction({
      payload: previewPayload({
        source: { deck: 'A', stem: 'vocal', region: null },
      }),
    }),
    baseAction({
      payload: previewPayload({
        source: {
          deck: 'A', stem: 'vocal',
          region: { id: 'r1', startBeat: -1, endBeat: 4 },
        },
      }),
    }),
    baseAction({
      payload: previewPayload({
        source: {
          deck: 'A', stem: 'vocal',
          region: { id: 'r1', startBeat: 10, endBeat: 5 },
        },
      }),
    }),
    baseAction({
      payload: previewPayload({
        source: {
          deck: 'A', stem: 'vocal',
          region: { id: 'r1', startBeat: 10, endBeat: 10 },
        },
      }),
    }),
  ];
  const codes = cases.map(validateAction).map((r) => {
    assert.equal(r.ok, false);
    return r.code;
  });
  assert.ok(codes.includes(ERROR_CODES.V_MISSING_REGION));
  assert.ok(codes.includes(ERROR_CODES.V_REGION_INVALID_BOUNDS));
});

test('rejects non-serializable action payloads', () => {
  // Unknown key containing a function is rejected as an unknown key.
  const a = baseAction();
  const clone = structuredClone(a);
  clone.payload.timing.fn = () => 42;
  const r = validateAction(clone);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY);

  // A nested function inside a known serializable field is rejected by the
  // non-serializable guard (via transformSpec validation for commit_layer).
  const commit = {
    id: 'a-2',
    schemaVersion: SCHEMA_VERSION,
    type: ACTION_TYPES.COMMIT_LAYER,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:01Z',
    idempotencyKey: 'key-2',
    payload: {
      proposalId: 'proposal-1',
      acceptedAt: '2026-08-27T00:00:02Z',
      acceptedAsset: {
        id: 'asset-1',
        contentHash: 'sha256:abc',
        transformSpec: { gainDb: -3, evil: () => 1 },
      },
    },
  };
  const r2 = validateAction(commit);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ERROR_CODES.V_INVALID_TRANSFORM_SPEC);
});

test('commit_layer requires proposalId, acceptedAsset, acceptedAt', () => {
  const commit = {
    id: 'a-2',
    schemaVersion: SCHEMA_VERSION,
    type: ACTION_TYPES.COMMIT_LAYER,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:01Z',
    idempotencyKey: 'key-2',
    payload: {
      proposalId: 'proposal-1',
      acceptedAt: '2026-08-27T00:00:02Z',
      acceptedAsset: {
        id: 'asset-1',
        contentHash: 'sha256:abc',
        transformSpec: { gainDb: -3, startBeat: 16 },
      },
    },
  };
  const ok = validateAction(commit);
  assert.equal(ok.ok, true);

  const missingProposal = validateAction({
    ...commit,
    payload: {
      ...commit.payload,
      proposalId: '',
    },
  });
  assert.equal(missingProposal.ok, false);
  assert.equal(missingProposal.code, ERROR_CODES.V_MISSING_PROPOSAL_ID);

  const missingHash = validateAction({
    ...commit,
    payload: {
      ...commit.payload,
      acceptedAsset: { ...commit.payload.acceptedAsset, contentHash: '' },
    },
  });
  assert.equal(missingHash.ok, false);
  assert.equal(missingHash.code, ERROR_CODES.V_MISSING_CONTENT_HASH);

  const badSpec = validateAction({
    ...commit,
    payload: {
      ...commit.payload,
      acceptedAsset: {
        ...commit.payload.acceptedAsset,
        transformSpec: { fn: () => 1 },
      },
    },
  });
  assert.equal(badSpec.ok, false);
  assert.equal(badSpec.code, ERROR_CODES.V_INVALID_TRANSFORM_SPEC);
});

test('reject_proposal requires proposalId + rejectedAt and rejects non-string reason', () => {
  const ok = validateAction({
    id: 'a-3',
    schemaVersion: SCHEMA_VERSION,
    type: ACTION_TYPES.REJECT_PROPOSAL,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:03Z',
    idempotencyKey: 'key-3',
    payload: {
      proposalId: 'proposal-1',
      rejectedAt: '2026-08-27T00:00:04Z',
      reason: 'no thanks',
    },
  });
  assert.equal(ok.ok, true);

  const badReason = validateAction({
    id: 'a-3b',
    schemaVersion: SCHEMA_VERSION,
    type: ACTION_TYPES.REJECT_PROPOSAL,
    actor: { type: 'human', id: 'richard' },
    requestedAt: '2026-08-27T00:00:03Z',
    idempotencyKey: 'key-3b',
    payload: {
      proposalId: 'proposal-1',
      rejectedAt: '2026-08-27T00:00:04Z',
      reason: 99,
    },
  });
  assert.equal(badReason.ok, false);
  assert.equal(badReason.code, ERROR_CODES.V_REASON_NOT_STRING);
});

test('isSerializable: true for plain JSON, false for functions/bigint/symbol', () => {
  assert.equal(isSerializable({ a: 1, b: [1, 'x', null] }), true);
  assert.equal(isSerializable({ fn: () => 1 }), false);
  assert.equal(isSerializable({ sym: Symbol('x') }), false);
  assert.equal(isSerializable({ big: 1n }), false);
  assert.equal(isSerializable({ inst: new Date() }), false);
  assert.equal(isSerializable({ nan: NaN }), false);
});

test('validator never mutates input', () => {
  const a = baseAction();
  const snapshot = JSON.stringify(a);
  validateAction(a);
  validateAction({ ...a, payload: { ...a.payload, gainDb: 9999 } });
  assert.equal(JSON.stringify(a), snapshot);
});
