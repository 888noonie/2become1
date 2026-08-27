// js/actions/contracts.js — frozen V1 Action contract.
//
// This module is part of the V1 Action and DeckTransport foundation
// (Phase 8A). It is intentionally pure: no imports from DOM, view, audio,
// fetch, app-context, or any controller. It defines the frozen Action
// envelope, allowed payload shapes per type, and the normalize/validate
// pipeline.
//
// The frozen Action envelope is:
//   { id, schemaVersion: 1, type, actor: { type, id }, requestedAt,
//     idempotencyKey, payload }
//
// Only three types are accepted:
//   preview_layer   — propose a Ghost borrow from one deck to another
//   commit_layer    — accept the proposal referenced by payload.proposalId
//   reject_proposal — reject the proposal referenced by payload.proposalId
//
// The validator returns a structured Result ({ ok, value } | { ok: false, code, message })
// and never throws on bad input. Serializability is checked because the
// frozen architecture disallows storing functions, symbols, or class
// instances inside StateStore.

import { ERROR_CODES, buildFailure, buildSuccess } from './errors.js';

export const SCHEMA_VERSION = 1;

export const ACTION_TYPES = Object.freeze(Object.freeze({
  PREVIEW_LAYER: 'preview_layer',
  COMMIT_LAYER: 'commit_layer',
  REJECT_PROPOSAL: 'reject_proposal',
}));

const ALLOWED_TOP_KEYS = Object.freeze([
  'id',
  'schemaVersion',
  'type',
  'actor',
  'requestedAt',
  'idempotencyKey',
  'payload',
]);

const ALLOWED_ACTOR_KEYS = Object.freeze(['type', 'id']);

const ALLOWED_PREVIEW_KEYS = Object.freeze(['source', 'destination', 'timing', 'gainDb']);
const ALLOWED_PREVIEW_SOURCE_KEYS = Object.freeze(['deck', 'stem', 'region']);
const ALLOWED_PREVIEW_DESTINATION_KEYS = Object.freeze(['deck']);
const ALLOWED_PREVIEW_TIMING_KEYS = Object.freeze(['launch', 'quantize']);

const ALLOWED_COMMIT_KEYS = Object.freeze(['proposalId', 'acceptedAsset', 'acceptedAt']);
const ALLOWED_ACCEPTED_ASSET_KEYS = Object.freeze(['id', 'contentHash', 'transformSpec']);

const ALLOWED_REJECT_KEYS = Object.freeze(['proposalId', 'rejectedAt', 'reason']);

const ALLOWED_REGION_KEYS = Object.freeze([
  'id',
  'label',
  'startBeat',
  'endBeat',
  'gridRevision',
]);

const ACTOR_TYPES = Object.freeze({
  HUMAN: 'human',
  PRODUCER: 'producer',
});

export const GAIN_MIN_DB = -24;
export const GAIN_MAX_DB = 12;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Structured serializability check. Accepts JSON-shaped values plus a few
// safe leaves (undefined mapped out, Date excluded, etc.). Returns false
// for functions, symbols, class instances, BigInt, or anything that cannot
// survive structuredClone.
export function isSerializable(value, seen = new WeakSet()) {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') {
    return false;
  }
  if (t !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isSerializable(item, seen)) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!isSerializable(value[key], seen)) return false;
  }
  return true;
}

function rejectKeys(value, allowed, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return buildFailure(code, { unexpectedKey: key, allowed });
    }
  }
  return null;
}

function validateDeck(value, code) {
  if (value !== 'A' && value !== 'B') {
    return buildFailure(code, { value });
  }
  return null;
}

function validateRegion(region) {
  if (!isPlainObject(region)) {
    return buildFailure(ERROR_CODES.V_REGION_NOT_OBJECT);
  }
  const keyFailure = rejectKeys(region, ALLOWED_REGION_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY);
  if (keyFailure) return keyFailure;
  if (!isNonEmptyString(region.id)) {
    return buildFailure(ERROR_CODES.V_MISSING_ID, { field: 'region.id' });
  }
  if (
    Object.hasOwn(region, 'startBeat') &&
    (!isFiniteNumber(region.startBeat) || region.startBeat < 0)
  ) {
    return buildFailure(ERROR_CODES.V_REGION_INVALID_BOUNDS, { field: 'startBeat' });
  }
  if (
    Object.hasOwn(region, 'endBeat') &&
    (!isFiniteNumber(region.endBeat) || region.endBeat < 0)
  ) {
    return buildFailure(ERROR_CODES.V_REGION_INVALID_BOUNDS, { field: 'endBeat' });
  }
  if (
    Object.hasOwn(region, 'startBeat') &&
    Object.hasOwn(region, 'endBeat') &&
    region.endBeat <= region.startBeat
  ) {
    return buildFailure(ERROR_CODES.V_REGION_INVALID_BOUNDS, {
      reason: 'endBeat <= startBeat',
    });
  }
  if (Object.hasOwn(region, 'gridRevision') && !isNonEmptyString(region.gridRevision)) {
    return buildFailure(ERROR_CODES.V_REGION_INVALID_BOUNDS, { field: 'gridRevision' });
  }
  return null;
}

function validatePreviewPayload(payload) {
  if (!isPlainObject(payload)) {
    return buildFailure(ERROR_CODES.V_MISSING_PAYLOAD);
  }
  const keyFailure = rejectKeys(payload, ALLOWED_PREVIEW_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY);
  if (keyFailure) return keyFailure;

  if (!isPlainObject(payload.source)) {
    return buildFailure(ERROR_CODES.V_MISSING_SOURCE);
  }
  const sourceKeyFailure = rejectKeys(
    payload.source, ALLOWED_PREVIEW_SOURCE_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY,
  );
  if (sourceKeyFailure) return sourceKeyFailure;

  const sourceDeckFailure = validateDeck(payload.source.deck, ERROR_CODES.V_INVALID_DECK);
  if (sourceDeckFailure) return sourceDeckFailure;

  if (!isNonEmptyString(payload.source.stem)) {
    return buildFailure(ERROR_CODES.V_INVALID_STEM);
  }

  if (!isPlainObject(payload.source.region)) {
    return buildFailure(ERROR_CODES.V_MISSING_REGION);
  }
  const regionFailure = validateRegion(payload.source.region);
  if (regionFailure) return regionFailure;

  if (!isPlainObject(payload.destination)) {
    return buildFailure(ERROR_CODES.V_MISSING_DESTINATION);
  }
  const destKeyFailure = rejectKeys(
    payload.destination, ALLOWED_PREVIEW_DESTINATION_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY,
  );
  if (destKeyFailure) return destKeyFailure;

  const destDeckFailure = validateDeck(payload.destination.deck, ERROR_CODES.V_INVALID_DECK);
  if (destDeckFailure) return destDeckFailure;

  if (payload.source.deck === payload.destination.deck) {
    return buildFailure(ERROR_CODES.V_SAME_DECK);
  }

  if (!isPlainObject(payload.timing)) {
    return buildFailure(ERROR_CODES.V_MISSING_TIMING);
  }
  const timingKeyFailure = rejectKeys(
    payload.timing, ALLOWED_PREVIEW_TIMING_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY,
  );
  if (timingKeyFailure) return timingKeyFailure;

  if (payload.timing.launch !== 'next_phrase') {
    return buildFailure(ERROR_CODES.V_INVALID_LAUNCH, { value: payload.timing.launch });
  }

  if (typeof payload.timing.quantize !== 'boolean') {
    return buildFailure(ERROR_CODES.V_INVALID_QUANTIZE);
  }

  if (!Object.hasOwn(payload, 'gainDb')) {
    return buildFailure(ERROR_CODES.V_INVALID_GAIN, { reason: 'gainDb missing' });
  }
  if (
    !isFiniteNumber(payload.gainDb) ||
    payload.gainDb < GAIN_MIN_DB ||
    payload.gainDb > GAIN_MAX_DB
  ) {
    return buildFailure(ERROR_CODES.V_INVALID_GAIN, {
      value: payload.gainDb,
      min: GAIN_MIN_DB,
      max: GAIN_MAX_DB,
    });
  }

  return null;
}

function validateAcceptedAsset(asset) {
  if (!isPlainObject(asset)) {
    return buildFailure(ERROR_CODES.V_MISSING_ACCEPTED_ASSET);
  }
  const keyFailure = rejectKeys(
    asset, ALLOWED_ACCEPTED_ASSET_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY,
  );
  if (keyFailure) return keyFailure;
  if (!isNonEmptyString(asset.id)) {
    return buildFailure(ERROR_CODES.V_INVALID_ACCEPTED_ASSET, { field: 'id' });
  }
  if (!isNonEmptyString(asset.contentHash)) {
    return buildFailure(ERROR_CODES.V_MISSING_CONTENT_HASH);
  }
  if (!isPlainObject(asset.transformSpec)) {
    return buildFailure(ERROR_CODES.V_MISSING_TRANSFORM_SPEC);
  }
  if (!isSerializable(asset.transformSpec)) {
    return buildFailure(ERROR_CODES.V_INVALID_TRANSFORM_SPEC);
  }
  return null;
}

function validateCommitPayload(payload) {
  if (!isPlainObject(payload)) {
    return buildFailure(ERROR_CODES.V_MISSING_PAYLOAD);
  }
  const keyFailure = rejectKeys(payload, ALLOWED_COMMIT_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY);
  if (keyFailure) return keyFailure;
  if (!isNonEmptyString(payload.proposalId)) {
    return buildFailure(ERROR_CODES.V_MISSING_PROPOSAL_ID);
  }
  if (!isNonEmptyString(payload.acceptedAt)) {
    return buildFailure(ERROR_CODES.V_MISSING_REQUESTED_AT, { field: 'acceptedAt' });
  }
  const assetFailure = validateAcceptedAsset(payload.acceptedAsset);
  if (assetFailure) return assetFailure;
  return null;
}

function validateRejectPayload(payload) {
  if (!isPlainObject(payload)) {
    return buildFailure(ERROR_CODES.V_MISSING_PAYLOAD);
  }
  const keyFailure = rejectKeys(payload, ALLOWED_REJECT_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY);
  if (keyFailure) return keyFailure;
  if (!isNonEmptyString(payload.proposalId)) {
    return buildFailure(ERROR_CODES.V_MISSING_PROPOSAL_ID);
  }
  if (!isNonEmptyString(payload.rejectedAt)) {
    return buildFailure(ERROR_CODES.V_MISSING_REQUESTED_AT, { field: 'rejectedAt' });
  }
  if (
    Object.hasOwn(payload, 'reason') &&
    payload.reason !== undefined &&
    !isNonEmptyString(payload.reason)
  ) {
    return buildFailure(ERROR_CODES.V_REASON_NOT_STRING);
  }
  return null;
}

export function validateAction(rawAction) {
  if (!isPlainObject(rawAction)) {
    return buildFailure(ERROR_CODES.V_INVALID_TYPE);
  }
  const topKeyFailure = rejectKeys(
    rawAction, ALLOWED_TOP_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY,
  );
  if (topKeyFailure) return topKeyFailure;

  if (!isNonEmptyString(rawAction.id)) {
    return buildFailure(ERROR_CODES.V_MISSING_ID);
  }

  if (rawAction.schemaVersion !== SCHEMA_VERSION) {
    return buildFailure(ERROR_CODES.V_INVALID_TYPE, {
      reason: 'schemaVersion mismatch',
      got: rawAction.schemaVersion,
      expected: SCHEMA_VERSION,
    });
  }

  if (!isPlainObject(rawAction.actor)) {
    return buildFailure(ERROR_CODES.V_MISSING_ACTOR);
  }
  const actorKeyFailure = rejectKeys(
    rawAction.actor, ALLOWED_ACTOR_KEYS, ERROR_CODES.V_UNEXPECTED_PAYLOAD_KEY,
  );
  if (actorKeyFailure) return actorKeyFailure;
  if (!isNonEmptyString(rawAction.actor.type)) {
    return buildFailure(ERROR_CODES.V_INVALID_ACTOR, { field: 'actor.type' });
  }
  if (!isNonEmptyString(rawAction.actor.id)) {
    return buildFailure(ERROR_CODES.V_INVALID_ACTOR, { field: 'actor.id' });
  }
  if (rawAction.actor.type !== ACTOR_TYPES.HUMAN && rawAction.actor.type !== ACTOR_TYPES.PRODUCER) {
    return buildFailure(ERROR_CODES.V_INVALID_ACTOR, { field: 'actor.type' });
  }

  if (!isNonEmptyString(rawAction.type)) {
    return buildFailure(ERROR_CODES.V_MISSING_TYPE);
  }

  if (!isNonEmptyString(rawAction.requestedAt)) {
    return buildFailure(ERROR_CODES.V_MISSING_REQUESTED_AT);
  }

  if (!isNonEmptyString(rawAction.idempotencyKey)) {
    return buildFailure(ERROR_CODES.V_MISSING_IDEMPOTENCY_KEY);
  }

  // Per-type payload validation.
  let payloadFailure;
  if (rawAction.type === ACTION_TYPES.PREVIEW_LAYER) {
    payloadFailure = validatePreviewPayload(rawAction.payload);
  } else if (rawAction.type === ACTION_TYPES.COMMIT_LAYER) {
    payloadFailure = validateCommitPayload(rawAction.payload);
  } else if (rawAction.type === ACTION_TYPES.REJECT_PROPOSAL) {
    payloadFailure = validateRejectPayload(rawAction.payload);
  } else {
    return buildFailure(ERROR_CODES.V_UNKNOWN_TYPE, { type: rawAction.type });
  }
  if (payloadFailure) return payloadFailure;

  if (!isSerializable(rawAction)) {
    return buildFailure(ERROR_CODES.V_NON_SERIALIZABLE);
  }

  return buildSuccess(rawAction);
}

export function getActorTypes() {
  return ACTOR_TYPES;
}
