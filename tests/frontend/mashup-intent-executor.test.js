import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDirective } from '../../src/twobecomeone/studio_static/js/mashup/directive-executor.js';
import { loopWindow } from '../../src/twobecomeone/studio_static/js/mashup/deck-loop.js';

function directive(ops, overrides = {}) {
  return {
    schema: 'playback-directive/v1',
    ok: true,
    tier: 'deterministic',
    source: 'grammar',
    model: null,
    ops,
    declined: [],
    error: null,
    ...overrides,
  };
}

test('applyDirective does not call ports when ok is false', () => {
  let calls = 0;
  const ports = {
    setEq() {
      calls += 1;
    },
    play() {
      calls += 1;
    },
  };
  const result = applyDirective(directive([], {
    ok: false,
    ops: [],
    error: { code: 'EMPTY', message: 'Nothing to interpret.' },
  }), ports);
  assert.equal(calls, 0);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.declined, []);
  assert.equal(result.error.code, 'EMPTY');
});

test('applyDirective calls setEq and skips a missing setFilter', () => {
  const seen = [];
  const ports = {
    setEq(deck, band, db) {
      seen.push([deck, band, db]);
    },
  };
  const eq = { op: 'eq', deck: 'A', band: 'low', db: -12 };
  const filter = { op: 'filter', deck: 'B', mode: 'highpass', amount: 0.7 };
  const result = applyDirective(directive([eq, filter]), ports);
  assert.deepEqual(seen, [['A', 'low', -12]]);
  assert.equal(result.error, null);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].op, 'eq');
  assert.equal(result.declined.length, 1);
  assert.equal(result.declined[0].code, 'PORT_MISSING');
  assert.equal(result.declined[0].op.op, 'filter');
});

test('a throwing port is PORT_FAILED and later ops still run', () => {
  const seen = [];
  const ports = {
    setEq() {
      throw new Error('eq exploded');
    },
    setGain(deck, value) {
      seen.push([deck, value]);
    },
  };
  const result = applyDirective(directive([
    { op: 'eq', deck: 'A', band: 'mid', db: -6 },
    { op: 'gain', deck: 'B', value: 0 },
  ]), ports);
  assert.deepEqual(seen, [['B', 0]]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].op, 'gain');
  assert.equal(result.declined.length, 1);
  assert.equal(result.declined[0].code, 'PORT_FAILED');
  assert.equal(result.declined[0].message, 'eq exploded');
  assert.equal(result.error, null);
});

test('unknown directive shape returns an error and calls nothing', () => {
  let calls = 0;
  const ports = {
    setEq() {
      calls += 1;
    },
    setCrossfader() {
      calls += 1;
    },
  };
  const result = applyDirective({ nope: true }, ports);
  assert.equal(calls, 0);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.declined, []);
  assert.equal(result.error.code, 'UNKNOWN_FIELD');
  assert.match(result.error.message, /nope/);
});

test('loopWindow at bpm 120 bars 1 is 2 seconds', () => {
  const window = loopWindow({ time: 0, duration: 30, bpm: 120, bars: 1 });
  assert.deepEqual(window, { start: 0, end: 2 });
  const later = loopWindow({ time: 5, duration: 30, bpm: 120, bars: 1 });
  assert.equal(later.end - later.start, 2);
  assert.deepEqual(later, { start: 4, end: 6 });
});

test('bad bpm returns null', () => {
  assert.equal(loopWindow({ time: 0, duration: 30, bpm: 10, bars: 1 }), null);
  assert.equal(loopWindow({ time: 0, duration: 30, bpm: 400, bars: 4 }), null);
  assert.equal(loopWindow({ time: 0, duration: 30, bpm: Number.NaN, bars: 1 }), null);
  assert.equal(loopWindow({ time: 0, duration: 0, bpm: 120, bars: 1 }), null);
});
