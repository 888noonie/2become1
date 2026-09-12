// tests/frontend/runtime/crossfader.test.js — Phase 15B equal-power crossfader.

import test from 'node:test';
import assert from 'node:assert/strict';

import { equalPowerGains } from '../../../src/twobecomeone/studio_static/js/runtime/crossfader.js';

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

test('hard left routes only to deck A', () => {
  const { gainA, gainB } = equalPowerGains(0);
  assert.equal(gainA, 1);
  assert.equal(gainB, 0);
});

test('hard right routes only to deck B', () => {
  const { gainA, gainB } = equalPowerGains(100);
  assert.ok(near(gainA, 0));
  assert.equal(gainB, 1);
});

test('center splits equal power between A and B', () => {
  const { gainA, gainB } = equalPowerGains(50);
  assert.ok(near(gainA, Math.SQRT1_2));
  assert.ok(near(gainB, Math.SQRT1_2));
  assert.ok(near(gainA * gainA + gainB * gainB, 1));
});

test('clamps out-of-range positions', () => {
  const low = equalPowerGains(-10);
  const high = equalPowerGains(150);
  assert.deepEqual(low, equalPowerGains(0));
  assert.deepEqual(high, equalPowerGains(100));
});
