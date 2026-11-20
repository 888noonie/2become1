// tests/frontend/arrangement/realtime-engine-live.test.js — ENGINE-LEVEL
// verification of the repaired live transport (OPERATION THE GOLDEN EAR II).
//
// Every test instantiates the actual RealtimeEngine over the simulated Web Audio
// host (helpers/fake-audio.js): real buildBackbone / buildClipVoice, real
// transport reducer, real voice pool, a fake device clock and a fake Signalsmith
// node that follows the vendored pop rule. This proves lifecycle, timing and
// ownership contracts; it does NOT prove audible correctness (see the bounded
// Chromium checks in tests/browser/clockwork-rescue).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeAudioContext, installFakeWorkletGlobal, fakeStretchFactory, flush, manualTimers,
  flatPlan, planClip, silentSource, SR,
} from './helpers/fake-audio.js';
import {
  RealtimeEngine, MEASURED_PRIMING_FLOOR_MS, SELECTED_SCHEDULING_HORIZON_MS,
  ASSUMED_BUILD_BUDGET_MS, ASSUMED_JITTER_ALLOWANCE_MS, DEFAULT_WAKE_MS, ADMISSION_WINDOW_MS,
} from '../../../src/twobecomeone/studio_static/js/realtime-engine.js';
import { STRICT_LIFECYCLE } from '../../../src/twobecomeone/studio_static/js/voice-pool.js';
import { SEEK_RAMP_FRAMES, LOOP_XFADE_FRAMES, STOP_RAMP_FRAMES } from '../../../src/twobecomeone/studio_static/js/arrangement/gate-envelope.js';

installFakeWorkletGlobal();

const LEAD = SELECTED_SCHEDULING_HORIZON_MS / 1000;

async function makeEngine({
  clips = [planClip({ clipId: 'pad', start: 0, length: 20 * SR })],
  sources = null, startAt = 0, tracks = 8, factory = fakeStretchFactory(), loopRange = null, ...opts
} = {}) {
  const ctx = new FakeAudioContext({ currentTime: startAt });
  const plan = flatPlan({ tracks, clips, loopRange });
  const frames = Math.max(...clips.map((c) => c.sourceEndFrame), SR) + SR;
  const buffers = sources ?? Object.fromEntries([...new Set(clips.map((c) => c.bufferReference))].map((r) => [r, silentSource(frames)]));
  const log = { parked: [], capacity: [], fail: [], warn: [], states: [] };
  const timers = manualTimers();
  const engine = new RealtimeEngine(ctx, plan, buffers, {
    StretchFactory: factory,
    limiterModuleUrl: 'limiter.js',
    timers,
    onParked: (f) => log.parked.push(f),
    onCapacityError: (e) => log.capacity.push(e),
    onFail: (e) => log.fail.push(e),
    onWarn: (e) => log.warn.push(e),
    onStateChange: (s) => log.states.push(s.phase),
    ...opts,
  });
  await engine.prepare();
  log.parked.length = 0;
  return { ctx, engine, plan, log, timers, factory };
}

/** Advance the device clock in wake-sized steps, running one scheduler pass each. */
async function advance(ctx, engine, toSec, stepSec = 0.025, onStep = null) {
  while (ctx.currentTime + 1e-12 < toSec) {
    ctx.currentTime = Math.min(toSec, ctx.currentTime + stepSec);
    await engine.tick();
    await flush();
    onStep?.();
  }
}

const audible = (engine) => [...engine.voices.values()].filter((v) => v.gate && v.nodesConnected);
const gateAt = (v, t) => v.gate.gain.valueAt(t);
const trackSum = (engine, t, track = 0) => audible(engine)
  .filter((v) => v.trackIndex === track)
  .reduce((s, v) => s + gateAt(v, t) * v.clipGain.gain.valueAt(t), 0);

function assertLifecycleHistories(engine) {
  for (const { history } of engine.lifecycleLog) {
    const ranks = history.filter((s) => s !== 'released').map((s) => STRICT_LIFECYCLE.indexOf(s));
    for (let i = 1; i < ranks.length; i += 1) assert.ok(ranks[i] > ranks[i - 1], `history ${history.join('>')} is forward-only`);
    assert.equal(history.at(-1), 'released');
    assert.equal(history.at(-2), 'disconnected', 'released only after disconnection');
  }
}

// ------------------------------------------------------------------ timing

test('N4: the timing budget is separated and labelled (measured / assumed / configured)', async () => {
  const { engine } = await makeEngine();
  const t = engine.diagnostics().timing;
  assert.equal(t.primingLeadMs.value, MEASURED_PRIMING_FLOOR_MS);
  assert.match(t.primingLeadMs.provenance, /^measured/);
  assert.equal(t.buildBudgetMs.value, ASSUMED_BUILD_BUDGET_MS);
  assert.match(t.buildBudgetMs.provenance, /assumed/);
  assert.match(t.jitterAllowanceMs.provenance, /assumed, not measured/);
  assert.equal(t.wakeIntervalMs.value, DEFAULT_WAKE_MS);
  assert.equal(t.startLeadMs.value, MEASURED_PRIMING_FLOOR_MS + ASSUMED_BUILD_BUDGET_MS);
  assert.equal(t.admissionWindowMs.value, ADMISSION_WINDOW_MS);
  assert.match(t.deviceOutputLatencyMs.provenance, /not measured/);
  assert.match(t.audiblePlayResponseMs.provenance, /not measured at the speaker/);
  engine.dispose();
});

test('the actual scheduler starts when Play is requested and stops after Stop completes', async () => {
  const { ctx, engine, timers } = await makeEngine();
  assert.equal(engine.schedulerRunning(), false, 'idle before Play');
  engine.play();
  assert.equal(engine.schedulerRunning(), true, 'Play starts the wake loop');
  await engine.settle();
  assert.ok(engine.voices.size >= 1, 'the first window is filled on Play without waiting for a wake');
  // The wake loop really drives the engine: fire wakes while advancing the clock.
  for (let i = 0; i < 8; i += 1) { ctx.currentTime += 0.025; await timers.fireAll(); await flush(); }
  assert.equal(engine.state().phase, 'playing', 'started() was delivered by the live engine');
  engine.stop();
  for (let i = 0; i < 8; i += 1) { ctx.currentTime += 0.025; await timers.fireAll(); await flush(); }
  assert.equal(engine.state().phase, 'stopped');
  assert.equal(engine.schedulerRunning(), false, 'the wake loop ends when nothing needs service');
  engine.dispose();
});

// -------------------------------------------------------------------- stop

test('N2: Stop completes, isPlaying is false, the cue is parked once, processors return to baseline', async () => {
  const { ctx, engine, log } = await makeEngine({ clips: [
    planClip({ clipId: 'a', trackIndex: 0, start: 0, length: 10 * SR }),
    planClip({ clipId: 'b', trackIndex: 1, start: 0, length: 10 * SR, rate: 1.2 }),
  ] });
  const baseline = ctx.connectedProcessors();
  engine.play(24000);
  await advance(ctx, engine, 2.0);
  assert.equal(ctx.connectedProcessors(), baseline + 2);
  engine.stop();
  const stopAt = ctx.currentTime;
  await engine.settle();
  for (const v of audible(engine)) assert.equal(gateAt(v, stopAt + STOP_RAMP_FRAMES / SR), 0, 'faded from the CURRENT time');
  await advance(ctx, engine, 2.2);
  const s = engine.state();
  assert.equal(s.phase, 'stopped');
  assert.equal(s.isPlaying, false);
  assert.deepEqual(log.parked, [24000], 'parked cue written exactly once');
  assert.equal(engine.pendingStop, null, 'no stale pending-stop state');
  assert.equal(ctx.connectedProcessors(), baseline, 'processor count back to baseline');
  assert.equal(engine.pool.stats().live, 0, 'every slot released');
  assertLifecycleHistories(engine);
  engine.dispose();
});

test('N2: Stop works immediately after Play (before the epoch is heard), with nothing ever sounding', async () => {
  const { ctx, engine, log } = await makeEngine();
  engine.play();
  await engine.settle();
  const voices = audible(engine);
  engine.stop();
  for (const v of voices) {
    for (const t of [ctx.currentTime + LEAD, ctx.currentTime + 1, ctx.currentTime + 5]) assert.equal(gateAt(v, t), 0);
  }
  await advance(ctx, engine, 0.3);
  assert.equal(engine.state().phase, 'stopped');
  assert.deepEqual(log.parked, [0]);
  assert.equal(ctx.connectedProcessors(), 0);
  engine.dispose();
});

test('N2: Stop completes when no clip events remain (past the arrangement)', async () => {
  const { ctx, engine, log } = await makeEngine({ clips: [planClip({ clipId: 'short', start: 0, length: SR / 2 })] });
  engine.play();
  await advance(ctx, engine, 0.4);
  engine.stop();
  await advance(ctx, engine, 0.6);
  assert.equal(engine.state().phase, 'stopped');
  assert.deepEqual(log.parked, [0]);
  engine.dispose();
});

test('N2: repeated Play/Stop cycles each park once and return to baseline', async () => {
  const { ctx, engine, log } = await makeEngine();
  for (let i = 0; i < 5; i += 1) {
    engine.play();
    await advance(ctx, engine, ctx.currentTime + 0.3);
    engine.stop();
    await advance(ctx, engine, ctx.currentTime + 0.1);
    assert.equal(engine.state().phase, 'stopped', `cycle ${i}`);
    assert.equal(ctx.connectedProcessors(), 0, `cycle ${i} baseline`);
  }
  assert.deepEqual(log.parked, [0, 0, 0, 0, 0]);
  engine.dispose();
});

test('Play during Stop begins a new epoch; the old voices never re-open and the superseded stop never parks', async () => {
  const { ctx, engine, log } = await makeEngine();
  engine.play();
  await advance(ctx, engine, 1.0);
  const old = audible(engine);
  engine.stop();
  ctx.currentTime += 0.004; // inside the 10 ms fade
  engine.play();
  await engine.settle();
  assert.equal(engine.state().phase, 'starting');
  for (const v of old) for (const t of [ctx.currentTime + 0.02, ctx.currentTime + 1, ctx.currentTime + 10]) assert.equal(gateAt(v, t), 0);
  await advance(ctx, engine, 1.5);
  assert.equal(engine.state().phase, 'playing');
  assert.deepEqual(log.parked, [], 'the superseded stop wrote nothing');
  assert.ok(Math.abs(trackSum(engine, 1.5) - 1) < 1e-9, 'exactly one voice-worth of gain');
  engine.dispose();
});

// -------------------------------------------------------------------- seek

for (const [label, from, to] of [['forward 4 s', 1 * SR, 5 * SR], ['backward', 8 * SR, 2 * SR]]) {
  test(`N1: ${label} seek hands over at now + lead; the old voice is silent afterwards (bypass + DSP)`, async () => {
    const { ctx, engine } = await makeEngine({ clips: [
      planClip({ clipId: 'pad', trackIndex: 0, start: 0, length: 12 * SR }),
      planClip({ clipId: 'arp', trackIndex: 1, start: 0, length: 12 * SR, rate: 0.857 }),
    ] });
    engine.play(from);
    await advance(ctx, engine, 1.0);
    const old = audible(engine);
    assert.equal(old.length, 2);
    const seekAt = ctx.currentTime;
    engine.seek(to);
    await engine.settle();
    const origin = seekAt + LEAD;
    const incoming = audible(engine).filter((v) => !old.includes(v));
    assert.equal(incoming.length, 2, 'both incoming voices armed');
    for (const v of incoming) {
      assert.ok(Math.abs(v.t0 - origin) < 1e-9, `incoming epoch begins at now + lead (${v.t0})`);
      assert.equal(v.occ.outStart, to, 'incoming source position is the seek target');
    }
    for (const v of old) {
      assert.equal(gateAt(v, origin - 1e-6), 1, 'old audio preserved until the handover');
      assert.equal(gateAt(v, origin + SEEK_RAMP_FRAMES / SR), 0, 'old audio gone at the end of the crossfade');
      assert.equal(gateAt(v, seekAt + 4), 0, 'and not audible four seconds later');
    }
    for (const t of [origin, origin + 0.001, origin + 0.0025, origin + 0.004]) {
      for (const track of [0, 1]) {
        const s = trackSum(engine, t, track);
        assert.ok(Math.abs(s - 1) < 1e-6, `crossfade sums to unity on track ${track} at ${t}: ${s}`);
      }
    }
    await advance(ctx, engine, origin + 0.1);
    assert.equal(engine.state().phase, 'playing', 'seekDone() delivered');
    assert.ok(old.every((v) => !engine.voices.has(v.key)), 'outgoing voices disconnected and released');
    assertLifecycleHistories(engine);
    engine.dispose();
  });
}

test('N1/N5: rapid repeated seeks retire obsolete voices and accumulate no hidden nodes', async () => {
  const { ctx, engine } = await makeEngine({ clips: [
    planClip({ clipId: 'pad', trackIndex: 0, start: 0, length: 30 * SR }),
    planClip({ clipId: 'arp', trackIndex: 1, start: 0, length: 30 * SR, rate: 1.2 }),
  ] });
  engine.play();
  await advance(ctx, engine, 1.0);
  let peak = 0;
  for (let i = 0; i < 12; i += 1) {
    engine.seek((2 + i) * SR);
    await engine.settle();
    ctx.currentTime += 0.010;
    await engine.tick();
    peak = Math.max(peak, ctx.connectedProcessors());
    assert.ok(ctx.connectedProcessors() <= engine.capacity, 'connected processors never exceed capacity');
  }
  await advance(ctx, engine, ctx.currentTime + 0.4);
  const live = audible(engine);
  assert.equal(live.length, 2, 'only the final epoch remains');
  assert.ok(live.every((v) => v.occ.outStart === 13 * SR), 'and it is the last seek target');
  assert.equal(ctx.connectedProcessors(), 2);
  assert.equal(engine.pool.stats().live, 2);
  assert.ok(peak <= engine.capacity);
  engine.dispose();
});

test('Stop during a seek handover silences both sides and completes', async () => {
  const { ctx, engine, log } = await makeEngine();
  engine.play();
  await advance(ctx, engine, 1.0);
  engine.seek(6 * SR);
  await engine.settle();
  ctx.currentTime += 0.03; // before the 104 ms handover
  engine.stop();
  const end = ctx.currentTime + STOP_RAMP_FRAMES / SR;
  for (const v of audible(engine)) for (const t of [end, end + 0.1, end + 5]) assert.equal(gateAt(v, t), 0);
  await advance(ctx, engine, ctx.currentTime + 0.2);
  assert.equal(engine.state().phase, 'stopped');
  assert.deepEqual(log.parked, [6 * SR], 'Stop returns to the cue (the seek target)');
  assert.equal(ctx.connectedProcessors(), 0);
  engine.dispose();
});

test('no stale generation resumes: builds that resolve after a newer seek are never armed', async () => {
  const gates = [];
  let release;
  const hold = { on: false };
  const factory = fakeStretchFactory({
    beforeResolve: () => (hold.on ? new Promise((r) => gates.push(r)) : null),
  });
  const { ctx, engine } = await makeEngine({ clips: [planClip({ clipId: 'arp', trackIndex: 0, start: 0, length: 20 * SR, rate: 1.2 })], factory });
  engine.play();
  await advance(ctx, engine, 1.0);
  hold.on = true;
  engine.seek(5 * SR); // build held
  await flush();
  hold.on = false;
  engine.seek(9 * SR); // supersedes while the first build is still held
  await flush();
  assert.equal(gates.length, 1, 'the superseded build is still in flight');
  // Now let the stale build finish.
  release = gates.shift();
  release();
  await engine.settle();
  await flush();
  const stale = factory.made.find((n) => n.calls.length === 0 && n.bufferFrames > 0);
  assert.ok(stale, 'the superseded build produced a node');
  assert.equal(stale.calls.length, 0, 'the stale node was never scheduled');
  assert.equal(stale.outputs.size, 0, 'and it is disconnected');
  assert.ok(audible(engine).every((v) => v.occ.outStart !== 5 * SR), 'no voice of the superseded seek is live');
  engine.dispose();
});

// ---------------------------------------------------------------- capacity

test('N5: pool overflow on seek refuses without discarding current audio', async () => {
  const clips = Array.from({ length: 4 }, (_, i) => planClip({ clipId: `c${i}`, trackIndex: i, start: 0, length: 20 * SR }));
  const { ctx, engine, log } = await makeEngine({ clips, capacity: 6 });
  engine.play();
  await advance(ctx, engine, 1.0);
  const before = audible(engine);
  const epoch = engine.state().epoch;
  engine.seek(8 * SR); // needs 4 more beside the 4 sounding: 8 > 6
  await engine.settle();
  assert.equal(log.capacity.at(-1).code, 'POOL_EXHAUSTED');
  assert.equal(engine.state().phase, 'playing', 'transport unchanged');
  assert.equal(engine.state().epoch, epoch, 'no new epoch');
  for (const v of before) assert.equal(gateAt(v, ctx.currentTime + 5), 1, 'current audio untouched');
  assert.equal(engine.pool.stats().stolen, 0);
  engine.dispose();
});

test('N5: an occurrence refused by a full pool is retried (never permanently skipped) and a late one is reported', async () => {
  // Track 0: clip A [0, 1 s), clip B [1.1 s, 3.1 s). Capacity 1: B enters the
  // admission window (144 ms ahead) while A still holds the only slot, so it is
  // refused, retried, and built once A is released (A ends + 21 ms margin).
  const clips = [
    planClip({ clipId: 'A', trackIndex: 0, start: 0, length: SR }),
    planClip({ clipId: 'B', trackIndex: 0, start: Math.round(1.1 * SR), length: 2 * SR }),
  ];
  const { ctx, engine, log } = await makeEngine({ clips, capacity: 1 });
  engine.play();
  await advance(ctx, engine, 1.15);
  assert.ok(log.capacity.some((e) => e.code === 'POOL_EXHAUSTED'), 'the refusal is reported');
  await advance(ctx, engine, 2.0);
  const b = [...engine.voices.values()].find((v) => v.clipId === 'B');
  assert.ok(b && b.armed, 'B was scheduled once a slot was really free');
  assert.equal(engine.deadlineMisses, 0);
  engine.dispose();

  // Same geometry with no gap: B can never be built in time -> explicit deadline miss.
  const tight = await makeEngine({ clips: [
    planClip({ clipId: 'A', trackIndex: 0, start: 0, length: SR }),
    planClip({ clipId: 'B', trackIndex: 0, start: SR, length: 2 * SR }),
  ], capacity: 1 });
  tight.engine.play();
  await advance(tight.ctx, tight.engine, 1.6);
  assert.ok(tight.engine.deadlineMisses >= 1 || tight.engine.lateVoices.length >= 1
    || tight.log.warn.some((w) => w.code === 'DEADLINE_MISS'), 'a voice that cannot be armed in time is reported, not dropped');
  assert.equal(tight.engine.state().fault?.code, 'DEADLINE_MISS');
  tight.engine.dispose();
});

test('N5: the ledger and the real graph agree at every wake (8 tracks, loop, seeks)', async () => {
  const clips = Array.from({ length: 8 }, (_, i) => planClip({ clipId: `c${i}`, trackIndex: i, start: 0, length: 8 * SR, rate: i % 2 ? 1.2 : 1 }));
  const { ctx, engine } = await makeEngine({ clips });
  engine.setLoop([1 * SR, 2 * SR]);
  engine.play();
  const check = () => {
    const connected = ctx.connectedProcessors();
    const owned = [...engine.voices.values()].filter((v) => v.nodesConnected).length;
    assert.equal(connected, owned, 'every connected processor is owned by exactly one ledger entry');
    assert.ok(connected <= engine.capacity && connected <= 32);
    assert.ok(engine.pool.stats().live <= engine.capacity);
    const ids = [...engine.voices.values()].map((v) => v.poolId);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate slot ownership');
  };
  await advance(ctx, engine, 4.0, 0.025, check);
  engine.seek(3 * SR);
  await advance(ctx, engine, 5.0, 0.025, check);
  engine.stop();
  await advance(ctx, engine, 5.3, 0.025, check);
  assert.equal(ctx.connectedProcessors(), 0);
  assert.equal(engine.pool.stats().illegalTransitions, 0);
  assertLifecycleHistories(engine);
  engine.dispose();
});

// -------------------------------------------------------------------- loop

test('N6: loop wraps hand over with complementary seam envelopes on the exact loop samples', async () => {
  const a = 1 * SR; const b = 2 * SR;
  const { ctx, engine } = await makeEngine({ clips: [
    planClip({ clipId: 'pad', trackIndex: 0, start: 0, length: 6 * SR }),
    planClip({ clipId: 'hits', trackIndex: 1, start: 0, length: 6 * SR, rate: 1.2 }),
  ] });
  engine.setLoop([a, b]);
  engine.play(Math.round(0.5 * SR));
  const seen = new Map();
  await advance(ctx, engine, 4.5, 0.025, () => {
    for (const v of engine.voices.values()) if (v.armed) seen.set(v.key, v);
  });
  const origin = [...seen.values()][0].rec.originSec;
  const half = LOOP_XFADE_FRAMES / 2;
  for (const clipId of ['pad', 'hits']) {
    const passes = [...seen.values()].filter((v) => v.clipId === clipId).sort((x, y) => x.pass - y.pass);
    assert.deepEqual(passes.map((v) => v.pass), [0, 1, 2, 3, 4], `${clipId}: every pass exactly once`);
    assert.equal(passes[0].occ.outStart, Math.round(0.5 * SR));
    for (let p = 1; p < passes.length; p += 1) {
      const out = passes[p - 1]; const inc = passes[p];
      assert.equal(inc.occ.outStart, a, 'each repeat starts at the loop start sample');
      assert.equal(out.occ.outEnd, b, 'each pass ends at the loop end sample');
      assert.equal(out.vp.outKind, 'loop-out');
      assert.equal(inc.vp.inKind, 'loop-in');
      // Seam on the device clock and the sources around it.
      const seamSec = origin + inc.occ.ctxStart / SR;
      const r = clipId === 'hits' ? 1.2 : 1;
      assert.equal(inc.vp.sourceStart, Math.round((a - half) * r), 'incoming source = exact frame at a - N/2');
      assert.equal(out.vp.sourceEnd, Math.round((b + half) * r), 'outgoing source = exact frame at b + N/2');
      assert.equal(inc.vp.startOffset, inc.occ.ctxStart - half, 'incoming pre-rolls half the seam window');
      assert.equal(out.vp.endOffset, out.occ.ctxEnd + half, 'outgoing post-rolls half the seam window');
      for (let k = -half; k <= half; k += 10) {
        const t = seamSec + k / SR;
        const sum = gateAt(out, t) + gateAt(inc, t);
        assert.ok(Math.abs(sum - 1) < 1e-9, `${clipId} pass ${p}: seam gains sum to 1 at ${k} frames (${sum})`);
      }
      assert.ok(Math.abs(gateAt(out, seamSec - half / SR) - 1) < 1e-9);
      assert.ok(Math.abs(gateAt(out, seamSec + half / SR)) < 1e-9);
      assert.ok(Math.abs(gateAt(inc, seamSec - half / SR)) < 1e-9);
      assert.ok(Math.abs(gateAt(inc, seamSec + half / SR) - 1) < 1e-9);
    }
  }
  engine.dispose();
});

test('N6: an interior loop pass never repeats stale audio and Stop/Seek work during the loop', async () => {
  const { ctx, engine, log } = await makeEngine({ clips: [planClip({ clipId: 'pad', start: 0, length: 6 * SR })] });
  engine.setLoop([1 * SR, 2 * SR]);
  engine.play();
  await advance(ctx, engine, 3.3);
  // At any time at most two voices of the clip are audible, and only across a seam.
  for (let t = 1.2; t < 3.3; t += 0.0101) {
    const s = trackSum(engine, t);
    assert.ok(s <= 1 + 1e-6, `no doubled audio at ${t.toFixed(3)} (${s})`);
  }
  engine.seek(Math.round(1.5 * SR));
  await advance(ctx, engine, 3.6);
  assert.equal(engine.state().phase, 'playing');
  const v = audible(engine).find((x) => x.pass === 0);
  assert.ok(v && v.occ.outStart === Math.round(1.5 * SR), 'seek inside the loop restarts the pass map there');
  engine.stop();
  await advance(ctx, engine, 3.8);
  assert.equal(engine.state().phase, 'stopped');
  assert.deepEqual(log.parked, [Math.round(1.5 * SR)]);
  assert.equal(ctx.connectedProcessors(), 0);
  engine.dispose();
});

test('N6: a loop shorter than the feasibility minimum is refused, and setLoop re-anchors the active mapping', async () => {
  const { ctx, engine, log } = await makeEngine({ clips: [planClip({ clipId: 'pad', start: 0, length: 10 * SR })] });
  engine.setLoop([SR, SR + 1000]);
  assert.equal(log.capacity.at(-1).code, 'LOOP_TOO_SHORT');
  assert.equal(engine.state().loop, null);
  engine.play();
  await advance(ctx, engine, 0.5);
  const cue = engine.state().cueFrame;
  engine.setLoop([1 * SR, 2 * SR]);
  await advance(ctx, engine, 2.6);
  assert.deepEqual(engine.state().loop, [SR, 2 * SR]);
  assert.equal(engine.state().cueFrame, cue, 'a loop change keeps the Stop cue');
  const passes = new Set([...engine.voices.values()].map((v) => v.pass));
  assert.ok([...passes].some((p) => p >= 1), 'the active map now wraps at the new loop end');
  assert.ok(engine.playhead() >= SR && engine.playhead() < 2 * SR, `heard position is inside the loop (${engine.playhead()})`);
  engine.dispose();
});

// --------------------------------------------------------------- signalsmith

test('N4: Signalsmith receives exactly arm-now + one future stop, with the measured lead supplied', async () => {
  const factory = fakeStretchFactory();
  const { ctx, engine } = await makeEngine({ clips: [planClip({ clipId: 'arp', start: 0, length: 4 * SR, rate: 1.2 })], factory });
  engine.play();
  await engine.settle();
  const node = factory.made.at(-1);
  assert.equal(node.calls.length, 2, 'two schedule() calls');
  const [arm, stop] = node.calls;
  assert.equal(arm.obj.active, true);
  assert.ok(arm.obj.output < arm.calledAt, 'the arm is in the past, so the stop cannot pop it');
  assert.equal(stop.obj.active, false);
  assert.equal(stop.popped.filter((s) => s.active).length, 0, 'the stop discarded no active segment');
  const v = [...engine.voices.values()][0];
  assert.ok(Math.abs(stop.obj.output - v.t1) < 1e-9, 'one future stop at the occurrence end');
  const at = node.inputAt(v.t0);
  assert.ok(at.active && Math.abs(at.input) < 1e-9, `the slice's first frame lands exactly at t0 (input ${at.input})`);
  const lead = (v.t0 - arm.calledAt) * 1000;
  assert.ok(lead >= MEASURED_PRIMING_FLOOR_MS, `priming lead supplied: ${lead} ms`);
  assert.ok(engine.diagnostics().timing.suppliedDspLeadMs.min >= MEASURED_PRIMING_FLOOR_MS);
  engine.dispose();
});

test('N4: a slow FIRST batch is recovered explicitly — the epoch is re-anchored, never armed short', async () => {
  // 80 ms build (beyond the 40 ms assumed budget; live Chromium measured ~47 ms
  // for eight Signalsmith nodes). Nothing is time-bound before arming, so the
  // whole epoch moves later and every voice still gets its priming lead.
  let slow = false;
  const factory = fakeStretchFactory({ beforeResolve: (ctx) => { if (slow) ctx.currentTime += 0.08; } });
  const { ctx, engine, log } = await makeEngine({ clips: [planClip({ clipId: 'arp', start: 0, length: 4 * SR, rate: 1.2 })], factory });
  slow = true;
  const playAt = ctx.currentTime;
  engine.play();
  await engine.settle();
  assert.equal(engine.deadlineMisses, 0);
  assert.ok(log.warn.some((w) => w.code === 'START_DELAYED'), 'the delay is reported');
  const v = [...engine.voices.values()][0];
  const node = factory.made.at(-1);
  assert.equal(node.calls.length, 2, 'armed with the legal pair');
  const lead = (v.t0 - node.calls[0].calledAt) * 1000;
  assert.ok(lead >= MEASURED_PRIMING_FLOOR_MS, `supplied lead ${lead} ms >= measured floor`);
  assert.ok(v.t0 > playAt + LEAD, 'heard later than the 104 ms target');
  assert.deepEqual(engine.diagnostics().startDelaysMs.length, 1);
  await advance(ctx, engine, ctx.currentTime + 0.2);
  assert.equal(engine.state().phase, 'playing');
  engine.dispose();
});

test('N4: late scheduling inside a sounding epoch is detected — never armed, transport stops explicitly', async () => {
  // Clip B (DSP) enters the admission window while A plays; its build takes
  // 200 ms, so it can no longer receive its priming lead.
  let slowFor = null;
  const factory = fakeStretchFactory({ beforeResolve: (ctx) => { if (slowFor) { ctx.currentTime += 0.2; slowFor = null; } } });
  const { ctx, engine, log } = await makeEngine({ clips: [
    planClip({ clipId: 'A', trackIndex: 0, start: 0, length: 3 * SR, rate: 1.2 }),
    planClip({ clipId: 'B', trackIndex: 1, start: 2 * SR, length: SR, rate: 1.2 }),
  ], factory });
  engine.play();
  await advance(ctx, engine, 1.9);
  slowFor = 'B';
  await advance(ctx, engine, 2.2);
  assert.equal(engine.deadlineMisses, 1);
  assert.equal(engine.lateVoices[0].clipId, 'B');
  assert.ok(engine.lateVoices[0].leadMs < MEASURED_PRIMING_FLOOR_MS);
  const bNode = factory.made.find((n) => n.bufferFrames === Math.round(SR * 1.2) + 0);
  assert.ok(!bNode || bNode.calls.length === 0, 'the late voice was never scheduled');
  assert.ok(log.warn.some((w) => w.code === 'DEADLINE_MISS'));
  await advance(ctx, engine, ctx.currentTime + 0.1);
  assert.equal(engine.state().phase, 'stopped');
  assert.equal(engine.state().fault.code, 'DEADLINE_MISS');
  assert.equal(ctx.connectedProcessors(), 0);
  engine.dispose();
});

test('N4: a coarse live clock (baseLatency) is reserved in the start lead; the per-voice floor is priming + one quantum', async () => {
  const ctx = new FakeAudioContext({ baseLatency: 0.0107 });
  const plan = flatPlan({ clips: [planClip({ clipId: 'arp', start: 0, length: SR, rate: 1.2 })] });
  const factory = fakeStretchFactory();
  const engine = new RealtimeEngine(ctx, plan, { src: silentSource(2 * SR) }, {
    StretchFactory: factory, limiterModuleUrl: 'l.js', timers: manualTimers(),
  });
  await engine.prepare();
  const t = engine.diagnostics().timing;
  assert.ok(Math.abs(t.clockGranularityMs.value - 10.7) < 0.03);
  assert.ok(Math.abs(t.requiredDspLeadMs.value - (MEASURED_PRIMING_FLOOR_MS + (128 / SR) * 1000)) < 0.03);
  assert.ok(Math.abs(t.startLeadMs.value - (SELECTED_SCHEDULING_HORIZON_MS + 10.7)) < 0.03);
  engine.play();
  await engine.settle();
  const lead = engine.diagnostics().timing.suppliedDspLeadMs.min;
  assert.ok(lead >= MEASURED_PRIMING_FLOOR_MS + 10.7 - 0.03, `observed lead ${lead}: the start lead kept one clock burst in reserve`);
  engine.dispose();
});

test('N4: stretch outside the measured range is played but reported as unqualified', async () => {
  const { engine, log } = await makeEngine({ clips: [planClip({ clipId: 'fast', start: 0, length: SR, rate: 1.6 })] });
  engine.play();
  await engine.settle();
  assert.ok(log.warn.some((w) => w.code === 'STRETCH_UNQUALIFIED'));
  assert.deepEqual(engine.diagnostics().unqualifiedStretch.map((u) => u.clipId), ['fast']);
  engine.dispose();
});

// ------------------------------------------------------------- edges/safety

test('frame-zero starts work: the first gate sample is exactly 0 and the source starts at frame 0', async () => {
  const { ctx, engine } = await makeEngine({ clips: [planClip({ clipId: 'p', start: 0, length: 2 * SR })] });
  engine.play(0);
  await engine.settle();
  const v = [...engine.voices.values()][0];
  assert.equal(v.vp.sourceStart, 0);
  assert.equal(gateAt(v, v.t0), 0);
  assert.ok(gateAt(v, v.t0 + 0.0025) === 1);
  const src = ctx.bufferSources()[0];
  assert.deepEqual([src.startCalls[0].when, src.startCalls[0].offset], [v.t0, 0]);
  engine.dispose();
});

test('a non-finite sample triggers a defined safe failure with observable reporting', async () => {
  const { ctx, engine, log } = await makeEngine();
  engine.play();
  await advance(ctx, engine, 0.5);
  engine.backbone.limiter.emitStats({ nonFiniteCount: 3, firstNonFiniteIndex: 4321 });
  await engine.tick();
  assert.equal(engine.state().phase, 'failed');
  assert.equal(engine.state().isPlaying, false);
  assert.equal(engine.state().fault.code, 'NON_FINITE');
  assert.equal(log.fail.at(-1).code, 'NON_FINITE');
  for (const v of audible(engine)) assert.equal(gateAt(v, ctx.currentTime + 0.003), 0, 'silenced');
  await advance(ctx, engine, 0.7);
  assert.equal(ctx.connectedProcessors(), 0, 'and released');
  engine.dispose();
});

test('context suspension parks honestly; Play after resume starts a fresh epoch', async () => {
  const { ctx, engine, log } = await makeEngine();
  engine.play();
  await advance(ctx, engine, 1.0);
  ctx.setState('suspended');
  assert.equal(engine.state().phase, 'stopped');
  assert.equal(engine.state().fault.code, 'CONTEXT_SUSPENDED');
  assert.equal(ctx.connectedProcessors(), 0);
  assert.equal(log.parked.length, 1);
  assert.ok(Math.abs(log.parked[0] - Math.round((1.0 - LEAD) * SR)) <= 1, `parked at the heard frame (${log.parked[0]})`);
  engine.play();
  assert.ok(log.warn.some((w) => w.code === 'CONTEXT_NOT_RUNNING'), 'Play refuses while suspended');
  ctx.setState('running');
  engine.play();
  await advance(ctx, engine, 1.3);
  assert.equal(engine.state().phase, 'playing');
  engine.dispose();
});

test('the arrangement end stops and returns to the cue', async () => {
  const { ctx, engine, log } = await makeEngine({ clips: [planClip({ clipId: 'p', start: 0, length: SR })] });
  engine.play();
  await advance(ctx, engine, 1.4);
  assert.equal(engine.state().phase, 'stopped');
  assert.deepEqual(log.parked, [0]);
  engine.dispose();
});

test('no .value write ever lands on a connected (running) node', async () => {
  const { ctx, engine } = await makeEngine({ clips: [planClip({ clipId: 'p', start: 0, length: 6 * SR })] });
  engine.setLoop([SR, 2 * SR]);
  engine.play();
  await advance(ctx, engine, 2.5);
  engine.seek(SR / 2);
  await advance(ctx, engine, 3.0);
  engine.stop();
  await advance(ctx, engine, 3.2);
  for (const n of ctx.nodes) if (n.gain) assert.equal(n.gain.valueWritesWhileConnected, 0);
  engine.dispose();
});
