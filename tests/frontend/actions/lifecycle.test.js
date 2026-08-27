// tests/frontend/actions/lifecycle.test.js — V1 proposal lifecycle.
//
// Phase 8A acceptance: lifecycle helper models the frozen transitions
// ready -> scheduled -> auditioning -> accepted/rejected and rejects every
// other transition with L_INVALID_TRANSITION. It never mutates.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_STATES,
  canTransition,
  validateTransition,
  isTerminalState,
  getValidNextStates,
} from '../../../src/twobecomeone/studio_static/js/actions/lifecycle.js';
import { ERROR_CODES } from '../../../src/twobecomeone/studio_static/js/actions/errors.js';

test('frozen happy-path: ready -> scheduled -> auditioning -> accepted', () => {
  assert.equal(canTransition('ready', 'scheduled'), true);
  assert.equal(canTransition('scheduled', 'auditioning'), true);
  assert.equal(canTransition('auditioning', 'accepted'), true);

  for (const [from, to] of [
    ['ready', 'scheduled'],
    ['scheduled', 'auditioning'],
    ['auditioning', 'accepted'],
  ]) {
    const r = validateTransition(from, to);
    assert.equal(r.ok, true);
    assert.equal(r.value.from, from);
    assert.equal(r.value.to, to);
  }
});

test('rejection is reachable from any non-terminal state', () => {
  for (const from of ['ready', 'scheduled', 'auditioning']) {
    const r = validateTransition(from, 'rejected');
    assert.equal(r.ok, true);
    assert.equal(r.value.to, 'rejected');
  }
});

test('accepted and rejected are terminal', () => {
  assert.equal(isTerminalState('accepted'), true);
  assert.equal(isTerminalState('rejected'), true);
  assert.equal(isTerminalState('ready'), false);

  for (const from of ['accepted', 'rejected']) {
    for (const to of ['ready', 'scheduled', 'auditioning', 'accepted', 'rejected']) {
      const r = validateTransition(from, to);
      assert.equal(r.ok, false, `unexpected success ${from} -> ${to}`);
      assert.equal(r.code, ERROR_CODES.L_INVALID_TRANSITION);
    }
  }
});

test('rejects illegal skips', () => {
  assert.equal(canTransition('ready', 'auditioning'), false);
  assert.equal(canTransition('ready', 'accepted'), false);
  assert.equal(canTransition('scheduled', 'accepted'), false);
  const r = validateTransition('ready', 'auditioning');
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.L_INVALID_TRANSITION);
});

test('rejects unknown lifecycle states', () => {
  const r1 = validateTransition('glorp', 'scheduled');
  assert.equal(r1.ok, false);
  assert.equal(r1.code, ERROR_CODES.L_INVALID_TRANSITION);
  const r2 = validateTransition('ready', 'glorp');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ERROR_CODES.L_INVALID_TRANSITION);
});

test('exports the canonical state names', () => {
  assert.equal(LIFECYCLE_STATES.READY, 'ready');
  assert.equal(LIFECYCLE_STATES.SCHEDULED, 'scheduled');
  assert.equal(LIFECYCLE_STATES.AUDITIONING, 'auditioning');
  assert.equal(LIFECYCLE_STATES.ACCEPTED, 'accepted');
  assert.equal(LIFECYCLE_STATES.REJECTED, 'rejected');
});

test('getValidNextStates returns frozen list and is safe on unknowns', () => {
  const readyNext = getValidNextStates('ready');
  assert.deepEqual([...readyNext].sort(), ['rejected', 'scheduled']);
  assert.equal(Object.isFrozen(readyNext), true);
  assert.deepEqual([...getValidNextStates('accepted')], []);
  assert.deepEqual([...getValidNextStates('whatever')], []);
});
