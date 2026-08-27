// js/actions/lifecycle.js — proposal lifecycle state machine.
//
// This module is part of the V1 Action and DeckTransport foundation
// (Phase 8A). It is intentionally pure: no imports from DOM, view, audio,
// fetch, app-context, or any controller. It encodes the frozen lifecycle
// from V1_ACTION_TRANSPORT_TRI_PHASE_PLAN.md:
//
//   ready -> scheduled -> auditioning -> accepted
//     |          |             |
//     +----------+-------------+-> rejected
//
// The lifecycle helper models scheduled/auditioning facts; it does NOT
// schedule audio. The state machine is exhaustive: every input state maps
// to the set of permitted next states, and any other transition is
// rejected with L_INVALID_TRANSITION.

import { ERROR_CODES, buildFailure, buildSuccess } from './errors.js';

export const LIFECYCLE_STATES = Object.freeze({
  READY: 'ready',
  SCHEDULED: 'scheduled',
  AUDITIONING: 'auditioning',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});

const TERMINAL_STATES = Object.freeze([LIFECYCLE_STATES.ACCEPTED, LIFECYCLE_STATES.REJECTED]);

const TRANSITIONS = Object.freeze({
  [LIFECYCLE_STATES.READY]: Object.freeze([
    LIFECYCLE_STATES.SCHEDULED,
    LIFECYCLE_STATES.REJECTED,
  ]),
  [LIFECYCLE_STATES.SCHEDULED]: Object.freeze([
    LIFECYCLE_STATES.AUDITIONING,
    LIFECYCLE_STATES.REJECTED,
  ]),
  [LIFECYCLE_STATES.AUDITIONING]: Object.freeze([
    LIFECYCLE_STATES.ACCEPTED,
    LIFECYCLE_STATES.REJECTED,
  ]),
  [LIFECYCLE_STATES.ACCEPTED]: Object.freeze([]),
  [LIFECYCLE_STATES.REJECTED]: Object.freeze([]),
});

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

export function isLifecycleState(value) {
  return Object.values(LIFECYCLE_STATES).includes(value);
}

export function canTransition(from, to) {
  if (!isLifecycleState(from) || !isLifecycleState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export function validateTransition(from, to) {
  if (!isLifecycleState(from)) {
    return buildFailure(ERROR_CODES.L_INVALID_TRANSITION, { reason: 'unknown from-state', from });
  }
  if (!isLifecycleState(to)) {
    return buildFailure(ERROR_CODES.L_INVALID_TRANSITION, { reason: 'unknown to-state', to });
  }
  if (!canTransition(from, to)) {
    return buildFailure(ERROR_CODES.L_INVALID_TRANSITION, { from, to });
  }
  return buildSuccess({ from, to });
}

export function getValidNextStates(state) {
  if (!isLifecycleState(state)) return Object.freeze([]);
  return TRANSITIONS[state];
}
