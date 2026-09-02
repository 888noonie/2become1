// js/actions/errors.js — frozen Action error code table.
//
// This module is part of the V1 Action and DeckTransport foundation
// (Phase 8A). It is intentionally pure: no imports from DOM, view, audio,
// fetch, app-context, or any controller. It defines the only error codes
// the dispatcher may surface from validation, permission, lifecycle, or
// idempotency failures.
//
// Conventions:
//   - All error codes are exported as stable UPPER_SNAKE_CASE strings.
//   - Every returned failure carries one of these codes; no implementation
//     exceptions or UI copy leak into the Action contract.
//   - Each code carries a short, descriptive message that is suitable for
//     logging but is NOT user-facing copy. UIs translate as they choose.
//   - Codes are grouped by family: validation (V_), permission (P_),
//     lifecycle (L_), idempotency (I_), transport (T_), and invariant (X_).

export const ERROR_CODES = Object.freeze({
  // --- Validation ---
  V_INVALID_TYPE: 'V_INVALID_TYPE',
  V_MISSING_ID: 'V_MISSING_ID',
  V_MISSING_ACTOR: 'V_MISSING_ACTOR',
  V_INVALID_ACTOR: 'V_INVALID_ACTOR',
  V_MISSING_TYPE: 'V_MISSING_TYPE',
  V_UNKNOWN_TYPE: 'V_UNKNOWN_TYPE',
  V_MISSING_PAYLOAD: 'V_MISSING_PAYLOAD',
  V_NON_SERIALIZABLE: 'V_NON_SERIALIZABLE',
  V_UNEXPECTED_PAYLOAD_KEY: 'V_UNEXPECTED_PAYLOAD_KEY',
  V_MISSING_REQUESTED_AT: 'V_MISSING_REQUESTED_AT',
  V_MISSING_IDEMPOTENCY_KEY: 'V_MISSING_IDEMPOTENCY_KEY',
  V_MISSING_SOURCE: 'V_MISSING_SOURCE',
  V_MISSING_DESTINATION: 'V_MISSING_DESTINATION',
  V_INVALID_DECK: 'V_INVALID_DECK',
  V_SAME_DECK: 'V_SAME_DECK',
  V_INVALID_STEM: 'V_INVALID_STEM',
  V_MISSING_REGION: 'V_MISSING_REGION',
  V_REGION_NOT_OBJECT: 'V_REGION_NOT_OBJECT',
  V_REGION_INVALID_BOUNDS: 'V_REGION_INVALID_BOUNDS',
  V_REGION_NON_FINITE: 'V_REGION_NON_FINITE',
  V_MISSING_TIMING: 'V_MISSING_TIMING',
  V_INVALID_LAUNCH: 'V_INVALID_LAUNCH',
  V_INVALID_QUANTIZE: 'V_INVALID_QUANTIZE',
  V_INVALID_GAIN: 'V_INVALID_GAIN',
  V_MISSING_PROPOSAL_ID: 'V_MISSING_PROPOSAL_ID',
  V_PROPOSAL_ID_NOT_STRING: 'V_PROPOSAL_ID_NOT_STRING',
  V_MISSING_COMMIT_ACTION_ID: 'V_MISSING_COMMIT_ACTION_ID',
  V_MISSING_ACCEPTED_ASSET: 'V_MISSING_ACCEPTED_ASSET',
  V_INVALID_ACCEPTED_ASSET: 'V_INVALID_ACCEPTED_ASSET',
  V_MISSING_CONTENT_HASH: 'V_MISSING_CONTENT_HASH',
  V_INVALID_CONTENT_HASH: 'V_INVALID_CONTENT_HASH',
  V_MISSING_TRANSFORM_SPEC: 'V_MISSING_TRANSFORM_SPEC',
  V_INVALID_TRANSFORM_SPEC: 'V_INVALID_TRANSFORM_SPEC',
  V_REASON_NOT_STRING: 'V_REASON_NOT_STRING',

  // --- Permission ---
  P_ACTOR_NOT_ALLOWED: 'P_ACTOR_NOT_ALLOWED',
  P_PRODUCER_PREVIEW_DENIED: 'P_PRODUCER_PREVIEW_DENIED',

  // --- Lifecycle ---
  L_UNKNOWN_PROPOSAL: 'L_UNKNOWN_PROPOSAL',
  L_INVALID_TRANSITION: 'L_INVALID_TRANSITION',
  L_NOT_AUDITIONING: 'L_NOT_AUDITIONING',
  L_UNKNOWN_COMMIT: 'L_UNKNOWN_COMMIT',
  L_ALREADY_REVERTED: 'L_ALREADY_REVERTED',
  L_LAYER_LIMIT: 'L_LAYER_LIMIT',
  L_LAYER_INVALID: 'L_LAYER_INVALID',

  // --- Idempotency ---
  I_KEY_REUSED_WITH_DIFFERENT_REQUEST: 'I_KEY_REUSED_WITH_DIFFERENT_REQUEST',

  // --- Transport ---
  T_INVALID_TRANSPORT: 'T_INVALID_TRANSPORT',
  T_INVALID_DECK: 'T_INVALID_DECK',
  T_INVALID_PLAYING: 'T_INVALID_PLAYING',
  T_INVALID_TEMPO: 'T_INVALID_TEMPO',
  T_INVALID_SIGNATURE: 'T_INVALID_SIGNATURE',
  T_INVALID_BEAT: 'T_INVALID_BEAT',
  T_INVALID_TIME: 'T_INVALID_TIME',
  T_INVALID_GRID_REVISION: 'T_INVALID_GRID_REVISION',
  T_TRANSPORT_NOT_PLAYING: 'T_TRANSPORT_NOT_PLAYING',

  // --- Invariant ---
  X_INTERNAL: 'X_INTERNAL',
});

const MESSAGES = Object.freeze({
  V_INVALID_TYPE: 'Action must be a non-null object',
  V_MISSING_ID: 'Action.id is required and must be a non-empty string',
  V_MISSING_ACTOR: 'Action.actor is required',
  V_INVALID_ACTOR: 'Action.actor.type and Action.actor.id must be non-empty strings',
  V_MISSING_TYPE: 'Action.type is required',
  V_UNKNOWN_TYPE: 'Action.type is not one of the allowed V1 types',
  V_MISSING_PAYLOAD: 'Action.payload is required and must be an object',
  V_NON_SERIALIZABLE: 'Action contains a non-serializable value (function/symbol/unsupported)',
  V_UNEXPECTED_PAYLOAD_KEY: 'Action payload contains an unknown key',
  V_MISSING_REQUESTED_AT: 'Action.requestedAt is required and must be a non-empty string',
  V_MISSING_IDEMPOTENCY_KEY: 'Action.idempotencyKey is required and must be a non-empty string',
  V_MISSING_SOURCE: 'preview_layer payload.source is required',
  V_MISSING_DESTINATION: 'preview_layer payload.destination is required',
  V_INVALID_DECK: 'deck must be exactly "A" or "B"',
  V_SAME_DECK: 'preview_layer source.deck and destination.deck must differ',
  V_INVALID_STEM: 'preview_layer source.stem must be a non-empty string',
  V_MISSING_REGION: 'preview_layer source.region is required',
  V_REGION_NOT_OBJECT: 'region must be an object',
  V_REGION_INVALID_BOUNDS: 'region bounds must be finite, non-negative, and startBeat <= endBeat',
  V_REGION_NON_FINITE: 'region numeric fields must be finite numbers',
  V_MISSING_TIMING: 'preview_layer payload.timing is required',
  V_INVALID_LAUNCH: 'timing.launch must be exactly "next_phrase"',
  V_INVALID_QUANTIZE: 'timing.quantize must be a boolean',
  V_INVALID_GAIN: 'gainDb must be a finite number within [-24, 12] dB',
  V_MISSING_PROPOSAL_ID: 'commit_layer/reject_proposal payload.proposalId is required',
  V_PROPOSAL_ID_NOT_STRING: 'proposalId must be a non-empty string',
  V_MISSING_COMMIT_ACTION_ID: 'revert_commit payload.commitActionId is required',
  V_MISSING_ACCEPTED_ASSET: 'commit_layer payload.acceptedAsset is required',
  V_INVALID_ACCEPTED_ASSET: 'acceptedAsset.id and acceptedAsset.contentHash must be non-empty strings',
  V_MISSING_CONTENT_HASH: 'acceptedAsset.contentHash is required and must be a non-empty string',
  V_MISSING_TRANSFORM_SPEC: 'acceptedAsset.transformSpec is required and must be an object',
  V_INVALID_TRANSFORM_SPEC: 'acceptedAsset.transformSpec must be a plain serializable object',
  V_REASON_NOT_STRING: 'reject_proposal.payload.reason must be a string when present',

  P_ACTOR_NOT_ALLOWED: 'actor is not allowed to perform this Action',
  P_PRODUCER_PREVIEW_DENIED: 'Producer preview is not permitted (producerPreviewAllowed=false)',

  L_UNKNOWN_PROPOSAL: 'proposalId does not reference a known proposal',
  L_INVALID_TRANSITION: 'proposal lifecycle transition is not permitted from current state',
  L_NOT_AUDITIONING: 'commit_layer requires the referenced proposal to be in auditioning',
  L_UNKNOWN_COMMIT: 'commitActionId does not reference a committed layer',
  L_ALREADY_REVERTED: 'the commit is already reverted',
  L_LAYER_LIMIT: 'a committed layer already exists; revert it before committing another',
  L_LAYER_INVALID: 'the committed layer is missing valid live placement facts',

  I_KEY_REUSED_WITH_DIFFERENT_REQUEST: 'idempotencyKey was reused with a semantically different request',

  T_INVALID_TRANSPORT: 'Transport must be a plain object',
  T_INVALID_DECK: 'deck must be "A" or "B"',
  T_INVALID_PLAYING: 'playing must be a boolean',
  T_INVALID_TEMPO: 'tempoBpm must be a finite number in [20, 300]',
  T_INVALID_SIGNATURE: 'signature/phrase fields must be integers within allowed ranges',
  T_INVALID_BEAT: 'beatAtStart must be a finite number',
  T_INVALID_TIME: 'startedAtAudioTime must be a finite number',
  T_INVALID_GRID_REVISION: 'gridRevision must be a non-empty string',

  T_TRANSPORT_NOT_PLAYING: 'destination deck transport is not playing',

  X_INTERNAL: 'Action dispatcher hit an invariant violation',
});

export function buildFailure(code, details = undefined) {
  if (!Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    return Object.freeze({
      ok: false,
      code: ERROR_CODES.X_INTERNAL,
      message: MESSAGES[ERROR_CODES.X_INTERNAL],
      details: { originalCode: String(code) },
    });
  }
  const failure = {
    ok: false,
    code,
    message: MESSAGES[code],
  };
  if (details !== undefined) failure.details = details;
  return Object.freeze(failure);
}

export function buildSuccess(value) {
  return Object.freeze({ ok: true, value: Object.freeze(value) });
}
