// js/actions/permission.js — constitutional permission gate.
//
// This module is part of the V1 Action and DeckTransport foundation
// (Phase 8A). It is intentionally pure: no imports from DOM, view, audio,
// fetch, app-context, or any controller. It encodes the frozen permission
// table from V1_ACTION_TRANSPORT_TRI_PHASE_PLAN.md and the architecture
// doc's "Producer proposes; humans commit" rule.
//
// Permission table:
//   preview_layer     - human: allowed; producer: allowed only when
//                       producerPreviewAllowed === true
//   commit_layer      - human: allowed; producer: denied
//   reject_proposal   - human: allowed; producer: denied
//   revert_commit     - human: allowed; producer: denied
//
// The gate returns a Result object that never throws. The dispatcher
// aborts before any projection or ledger change when the gate fails.

import { ACTION_TYPES, getActorTypes } from './contracts.js';
import { ERROR_CODES, buildFailure, buildSuccess } from './errors.js';

export const PERMISSION_DEFAULTS = Object.freeze({
  producerPreviewAllowed: false,
});

function normalizeContext(context) {
  if (!context || typeof context !== 'object') {
    return { producerPreviewAllowed: PERMISSION_DEFAULTS.producerPreviewAllowed };
  }
  return {
    producerPreviewAllowed: context.producerPreviewAllowed === true,
  };
}

export function checkPermission(action, context) {
  if (!action || action.type !== ACTION_TYPES.PREVIEW_LAYER
      && action.type !== ACTION_TYPES.COMMIT_LAYER
      && action.type !== ACTION_TYPES.REJECT_PROPOSAL
      && action.type !== ACTION_TYPES.REVERT_COMMIT) {
    return buildFailure(ERROR_CODES.V_UNKNOWN_TYPE, { type: action && action.type });
  }

  const actor = action.actor;
  if (!actor || typeof actor !== 'object') {
    return buildFailure(ERROR_CODES.V_MISSING_ACTOR);
  }
  const isHuman = actor.type === getActorTypes().HUMAN;
  const isProducer = actor.type === getActorTypes().PRODUCER;

  if (!isHuman && !isProducer) {
    return buildFailure(ERROR_CODES.V_INVALID_ACTOR, { field: 'actor.type' });
  }

  const ctx = normalizeContext(context);

  if (action.type === ACTION_TYPES.COMMIT_LAYER
      || action.type === ACTION_TYPES.REVERT_COMMIT) {
    if (!isHuman) {
      return buildFailure(ERROR_CODES.P_ACTOR_NOT_ALLOWED, {
        action: action.type,
        actor: actor.type,
      });
    }
    return buildSuccess({ allowed: true });
  }

  if (action.type === ACTION_TYPES.REJECT_PROPOSAL) {
    if (!isHuman) {
      return buildFailure(ERROR_CODES.P_ACTOR_NOT_ALLOWED, {
        action: action.type,
        actor: actor.type,
      });
    }
    return buildSuccess({ allowed: true });
  }

  // preview_layer
  if (isHuman) {
    return buildSuccess({ allowed: true });
  }
  if (!ctx.producerPreviewAllowed) {
    return buildFailure(ERROR_CODES.P_PRODUCER_PREVIEW_DENIED, {
      producerPreviewAllowed: ctx.producerPreviewAllowed,
    });
  }
  return buildSuccess({ allowed: true });
}
