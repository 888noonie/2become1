// tests/frontend/arrangement/voice-pool.test.js — GATE 4.
//
// Bounded voice pool: capacity derived from concurrency (not an assumed 24),
// lifecycle accounting (pending/sounding/tail/free), high-water marks, byte
// accounting, epoch retirement (Play-during-stop cancellation), and the
// exhaustion REFUSAL path that never steals or drops an audible clip.

import test from 'node:test';
import assert from 'node:assert/strict';

import { VoicePool, VoiceState, deriveVoiceCapacity, PoolExhaustedError, STRICT_LIFECYCLE, LifecycleError } from '../../../src/twobecomeone/studio_static/js/voice-pool.js';
import { MAX_CLIPS_PER_GRAPH } from '../../../src/twobecomeone/studio_static/js/arrangement/offline-render.js';

test('GATE 4: capacity is derived from concurrency and the graph limit', () => {
  const d = deriveVoiceCapacity({ trackCount: 8, maxOverlappingPerTrack: 2, seamPartners: 2, tailReserve: 4 });
  assert.equal(d.sounding, 16, '8 tracks x 2 overlapping');
  assert.equal(d.required, 22, 'sounding + seam partners + tail reserve');
  assert.equal(d.capacity, 22);
  assert.equal(d.fits, true, '22 <= the 32 graph limit');
  assert.equal(d.graphLimit, MAX_CLIPS_PER_GRAPH);

  // A harsher scenario that DOES exceed the limit is reported honestly.
  const hot = deriveVoiceCapacity({ trackCount: 8, maxOverlappingPerTrack: 3, seamPartners: 8, tailReserve: 8 });
  assert.equal(hot.required, 40);
  assert.equal(hot.fits, false, 'over-budget concurrency does not fit the graph limit');
  assert.equal(hot.capacity, MAX_CLIPS_PER_GRAPH, 'clamped to the qualified instance budget');
});

test('GATE 4: lifecycle and resource accounting', () => {
  const pool = new VoicePool(8);
  const a = pool.acquire({ epoch: 1, bytes: 1000, nowFrame: 0, tailFrames: 480 });
  assert.equal(a.ok, true);
  const b = pool.acquire({ epoch: 1, bytes: 2000, nowFrame: 0 });
  pool.markSounding(a.voice.id);
  pool.markPending(b.voice.id);
  let s = pool.stats();
  assert.equal(s.live, 2);
  assert.equal(s.sounding, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.allocatedBytes, 3000);
  assert.equal(s.peakConcurrent, 2);

  // a ends -> tail, then swept after its tail.
  pool.markTail(a.voice.id, 480);
  s = pool.stats();
  assert.equal(s.tail, 1);
  assert.equal(s.sounding, 0);
  pool.sweep(481);
  s = pool.stats();
  assert.equal(s.live, 1, 'the expired tail was reclaimed');
  assert.equal(s.releasedTotal, 1000);
  assert.equal(s.allocatedBytes, 2000);
  assert.equal(s.stolen, 0);
});

test('GATE 4: pool exhaustion REFUSES a new voice without stealing audible audio', () => {
  const pool = new VoicePool(3);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = pool.acquire({ epoch: 1, bytes: 10, nowFrame: 0 });
    assert.equal(r.ok, true);
    pool.markSounding(r.voice.id);
    ids.push(r.voice.id);
  }
  // The pool is full of sounding (audible) voices.
  const refused = pool.acquire({ epoch: 1, bytes: 10, nowFrame: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'POOL_EXHAUSTED');
  assert.ok(refused.error instanceof PoolExhaustedError);
  // The current audible arrangement is preserved: all three still sounding.
  const s = pool.stats();
  assert.equal(s.sounding, 3, 'no audible clip was stolen or dropped');
  assert.equal(s.stolen, 0);
  assert.equal(s.refusals, 1);
  // canAcquire reports the truth before an epoch begins.
  assert.equal(pool.canAcquire(1), false);
  assert.equal(pool.canAcquire(0), true);
});

test('GATE 4: a new epoch retires old-epoch voices (Play supersedes a stop fade)', () => {
  const pool = new VoicePool(8);
  const old = pool.acquire({ epoch: 1, bytes: 100, nowFrame: 0 });
  pool.markSounding(old.voice.id);
  // A stop fade is pending on epoch 1 (voice still sounding while fading).
  // Play begins epoch 2; every epoch-1 voice is recycled silently.
  pool.retireEpoch(2);
  const s = pool.stats();
  assert.equal(s.live, 0, 'old-epoch voices are recycled');
  assert.equal(s.allocatedBytes, 0);
  // The new epoch can allocate freely.
  const fresh = pool.acquire({ epoch: 2, bytes: 50, nowFrame: 0 });
  assert.equal(fresh.ok, true);
});

test('GATE 4: unexpired tails occupy capacity; stale-epoch tails are reclaimed', () => {
  const pool = new VoicePool(2);
  const a = pool.acquire({ epoch: 1, bytes: 5, nowFrame: 0, tailFrames: 480 });
  pool.markTail(a.voice.id, 480);
  const b = pool.acquire({ epoch: 1, bytes: 5, nowFrame: 0, tailFrames: 480 });
  pool.markTail(b.voice.id, 480);
  // Both in unexpired tail: a third voice is refused (no stealing).
  assert.equal(pool.acquire({ epoch: 1, nowFrame: 0 }).ok, false, 'unexpired tails hold their slots');
  // But a NEW epoch reclaims the stale-epoch tails eagerly (they are inaudible).
  const c = pool.acquire({ epoch: 2, nowFrame: 100 });
  assert.equal(c.ok, true, 'stale-epoch tails are reclaimable by a newer epoch');
});

test('GATE 4: peak high-water mark records the maximum concurrent voices', () => {
  const pool = new VoicePool(16);
  const held = [];
  for (let i = 0; i < 6; i += 1) held.push(pool.acquire({ epoch: 1, bytes: 1, nowFrame: 0 }).voice.id);
  assert.equal(pool.stats().peakConcurrent, 6);
  // Release some, then allocate fewer: peak must NOT decrease.
  pool.release(held[0]); pool.release(held[1]);
  pool.acquire({ epoch: 1, bytes: 1, nowFrame: 0 });
  assert.equal(pool.stats().peakConcurrent, 6, 'peak is a high-water mark');
});

test('GATE 4: release frees bytes and returns the slot for reuse', () => {
  const pool = new VoicePool(4);
  const a = pool.acquire({ epoch: 1, bytes: 700, nowFrame: 0 });
  assert.equal(pool.stats().allocatedBytes, 700);
  pool.release(a.voice.id);
  const s = pool.stats();
  assert.equal(s.live, 0);
  assert.equal(s.allocatedBytes, 0);
  assert.equal(s.releasedTotal, 700);
  // Reuse keeps the pool bounded (no unbounded id growth in live count).
  for (let i = 0; i < 4; i += 1) assert.equal(pool.acquire({ epoch: 1, bytes: 1, nowFrame: 0 }).ok, true);
  assert.equal(pool.acquire({ epoch: 1, bytes: 1, nowFrame: 0 }).ok, false, 'still bounded at 4');
});

test('GATE 4: VoiceState names the lifecycle stages (legacy three + the strict ledger)', () => {
  // Golden Ear II (Grok N5) extends the enum with the engine-owned strict
  // lifecycle; the three C1 names are kept for the non-strict pool.
  assert.deepEqual(Object.values(VoiceState).sort(),
    ['allocated', 'disconnected', 'fading', 'pending', 'prepared', 'sounding', 'tail']);
  assert.deepEqual([...STRICT_LIFECYCLE], ['allocated', 'prepared', 'sounding', 'fading', 'disconnected']);
});

test('N5: a strict pool never frees a slot before the voice is disconnected', () => {
  const pool = new VoicePool(2, { strict: true });
  const a = pool.acquire({ epoch: 1, bytes: 10 }).voice;
  pool.advance(a.id, 'prepared');
  pool.advance(a.id, 'sounding');
  pool.advance(a.id, 'fading');
  // No automatic reclamation, whatever the clock or epoch says.
  pool.sweep(1e12, 99);
  assert.equal(pool.stats().live, 1);
  assert.throws(() => pool.release(a.id), LifecycleError, 'release before disconnection is refused');
  assert.throws(() => pool.releaseDisconnected(a.id), LifecycleError);
  pool.advance(a.id, 'disconnected');
  assert.deepEqual(pool.releaseDisconnected(a.id), ['allocated', 'prepared', 'sounding', 'fading', 'disconnected', 'released']);
  assert.equal(pool.stats().live, 0);
  assert.equal(pool.stats().illegalTransitions, 2);
});

test('N5: strict lifecycle is forward-only and ids are never reused', () => {
  const pool = new VoicePool(4, { strict: true });
  const a = pool.acquire({}).voice;
  pool.advance(a.id, 'sounding'); // skipping forwards is allowed
  assert.throws(() => pool.advance(a.id, 'prepared'), LifecycleError, 'backwards is refused');
  pool.advance(a.id, 'disconnected');
  pool.releaseDisconnected(a.id);
  const b = pool.acquire({}).voice;
  assert.notEqual(b.id, a.id, 'a released id is never handed out again (stale completions cannot alias)');
  assert.throws(() => pool.advance(a.id, 'fading'), LifecycleError, 'a released voice cannot be advanced');
});

test('N5: a strict pool refuses at capacity without stealing', () => {
  const pool = new VoicePool(1, { strict: true });
  assert.equal(pool.acquire({}).ok, true);
  const r = pool.acquire({});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'POOL_EXHAUSTED');
  assert.equal(pool.stats().stolen, 0);
});
