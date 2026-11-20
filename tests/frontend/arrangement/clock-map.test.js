// tests/frontend/arrangement/clock-map.test.js — GATE 1 / Gate 8 T2.
//
// TransportMap clock arithmetic: exact integer round trips over 10,000 loop
// passes (no drift), frame-zero and source-end selection, and the three loop
// entry cases (before the loop, inside it, past it). Pure; no audio.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTransportMap } from '../../../src/twobecomeone/studio_static/js/arrangement/transport.js';

test('T2: no-loop map is an exact integer bijection', () => {
  const map = createTransportMap({ startFrame: 1000, loop: null });
  for (const d of [0, 1, 127, 4096, 999999]) {
    const { frame, pass } = map.toTransport(d);
    assert.equal(frame, 1000 + d);
    assert.equal(pass, 0);
    assert.equal(map.toCtx(frame, pass), d, `round trip at d=${d}`);
  }
  // Frame zero maps back to a negative playback offset (before the start).
  assert.equal(map.toCtx(0, 0), -1000);
});

test('T2: 10,000 loop passes round-trip exactly with no drift', () => {
  const a = 48000; const b = 144000; const L = b - a; // 2 s loop at 48 kHz
  const map = createTransportMap({ startFrame: a, loop: [a, b] });
  assert.equal(map.hasLoop, true);
  assert.equal(map.loopLength, L);
  // Walk 10,000 passes; every pass start and a sample inside it must round-trip.
  for (let p = 0; p < 10000; p += 1) {
    for (const off of [0, 1, Math.floor(L / 2), L - 1]) {
      const d = map.passStartCtx(p) + off;
      const { frame, pass } = map.toTransport(d);
      assert.equal(pass, p, `pass at (p=${p}, off=${off})`);
      assert.equal(frame, a + off, `frame at (p=${p}, off=${off})`);
      assert.equal(map.toCtx(frame, pass), d, `round trip at (p=${p}, off=${off})`);
    }
  }
});

test('T2: loop unrolling is drift-free at large pass counts (arbitrary offsets)', () => {
  const a = 0; const b = 7; const L = 7;
  const map = createTransportMap({ startFrame: 0, loop: [a, b] });
  // Prime-ish offsets avoid landing only on boundaries.
  for (const d of [0, 1, 6, 7, 8, 13, 14, 100, 7 * 5000 + 3, 7 * 9999 + 6]) {
    const { frame, pass } = map.toTransport(d);
    assert.equal(map.toCtx(frame, pass), d, `round trip at d=${d}`);
    assert.equal(frame, a + (d % L), `frame = a + (d mod L) at d=${d}`);
  }
});

test('T2: loop entry cases — before, inside, and past the loop', () => {
  const a = 48000; const b = 144000; const L = b - a;
  // Start BEFORE the loop: lead-in [s, a) then full passes.
  const before = createTransportMap({ startFrame: 0, loop: [a, b] });
  assert.equal(before.firstSegmentLength, b - 0, 'first segment is [start, b)');
  assert.equal(before.toTransport(0).frame, 0);
  assert.equal(before.toTransport(a).frame, a, 'reaches the loop start at d=a');
  assert.equal(before.toTransport(b).frame, a, 'wraps b -> a at d=b');
  assert.equal(before.toTransport(b + 1).frame, a + 1);

  // Start INSIDE the loop: partial first pass [s, b) then full passes.
  const s = a + 1000;
  const inside = createTransportMap({ startFrame: s, loop: [a, b] });
  assert.equal(inside.toTransport(0).frame, s);
  assert.equal(inside.toTransport(b - s).frame, a, 'wraps to a after the partial pass');
  assert.equal(inside.toTransport(b - s + 5).frame, a + 5);

  // Start PAST the loop: linear (the loop is behind us).
  const past = createTransportMap({ startFrame: b + 5000, loop: [a, b] });
  assert.equal(past.hasLoop, false, 'a start past the loop end does not wrap');
  assert.equal(past.toTransport(10).frame, b + 5010);
});

test('T2: playback from frame zero and past the end are representable', () => {
  const map = createTransportMap({ startFrame: 0, loop: null });
  assert.equal(map.toTransport(0).frame, 0, 'frame zero maps to playback zero');
  const END = 480000;
  const past = map.toTransport(END + 5000);
  assert.equal(past.frame, END + 5000, 'a position beyond active material is a legal map value');
});
