// tests/frontend/arrangement/transport-core.test.js — GATE 1 / Gate 8 T1.
//
// The pure transport command/state model: every legal transition row, every
// no-op, supersession (Play during a stop fade), epoch/generation increments,
// and the isPlaying / parked-playhead reconciliation. Fake clock only: no
// AudioContext, no wall-clock timer, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Phase,
  LEGAL_TRANSITIONS,
  createTransportState,
  transportReduce,
  isLegalTransition,
} from '../../../src/twobecomeone/studio_static/js/arrangement/transport.js';

const END = 480000;

function fresh(extra = {}) {
  return createTransportState({ arrangementEndFrame: END, sampleRate: 48000, ...extra });
}

function playToPlaying(s) {
  // PREPARING -> STOPPED (ready) -> STARTING (play) -> PLAYING (started).
  let r = transportReduce(s, { type: 'ready' });
  r = transportReduce(r.state, { type: 'play', fromFrame: 0 });
  r = transportReduce(r.state, { type: 'started' });
  return r.state;
}

test('T1: the transition table and the reducer agree (driven, not tautological)', () => {
  // Drive the REDUCER and check the table predicts it (review 13: the old test
  // only compared the table to itself and hid a real contradiction).
  // prepare during active playback is rejected (there is no PLAYING->PREPARING edge).
  const playing = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  assert.equal(playing.phase, Phase.PLAYING);
  const prepWhilePlaying = transportReduce(playing, { type: 'prepare' });
  assert.equal(prepWhilePlaying.effects[0].type, 'noop', 'prepare during playback is a no-op');
  assert.equal(isLegalTransition(Phase.PLAYING, Phase.PREPARING), false);
  // prepare from stopped IS allowed (re-prepare) and the table lists it.
  const stopping = transportReduce(playing, { type: 'stop' }).state;
  const stopped = transportReduce(stopping, { type: 'stopped', parkedFrame: 0 }).state;
  assert.equal(stopped.phase, Phase.STOPPED);
  assert.equal(isLegalTransition(Phase.STOPPED, Phase.PREPARING), true);
  assert.equal(transportReduce(stopped, { type: 'prepare' }).state.phase, Phase.PREPARING);
  // Spot-check unreachable rows are rejected.
  assert.equal(isLegalTransition(Phase.STOPPED, Phase.PLAYING), false);
  assert.equal(isLegalTransition(Phase.UNPREPARED, Phase.PLAYING), false);
  assert.equal(isLegalTransition(Phase.FAILED, Phase.STOPPED), false);
});

test('T1: prepare -> ready parks at the ProjectState position', () => {
  let r = transportReduce(fresh(), { type: 'prepare', plan: {} });
  assert.equal(r.state.phase, Phase.PREPARING);
  assert.equal(r.effects[0].type, 'prepare');
  r = transportReduce(r.state, { type: 'ready', parkedFrame: 12345 });
  assert.equal(r.state.phase, Phase.STOPPED);
  assert.equal(r.state.parkedFrame, 12345);
  assert.equal(r.state.cueFrame, 12345);
  // The ONLY path to ProjectState is a writeParked effect.
  assert.deepEqual(r.effects, [{ type: 'writeParked', frame: 12345 }]);
});

test('T1: play starts a new epoch and a start effect at the cue', () => {
  const s0 = transportReduce(fresh({}), { type: 'prepare' }).state;
  const ready = transportReduce(s0, { type: 'ready', parkedFrame: 4000 }).state;
  const before = ready.epoch;
  const r = transportReduce(ready, { type: 'play' });
  assert.equal(r.state.phase, Phase.STARTING);
  assert.equal(r.state.isPlaying, true);
  assert.equal(r.state.epoch, before + 1, 'play begins a new playback epoch');
  const eff = r.effects.find((e) => e.type === 'start');
  assert.ok(eff);
  assert.equal(eff.startFrame, 4000, 'play starts from the cue');
  assert.equal(eff.supersededStop, false);
  // heard >= T_s moves to playing.
  const p = transportReduce(r.state, { type: 'started' });
  assert.equal(p.state.phase, Phase.PLAYING);
});

test('T1: owner UX — stop returns to the cue, pause parks at the heard position', () => {
  const s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  // Stop -> park at cue.
  let r = transportReduce(s, { type: 'stop', fadeOutFrames: 480, atFrame: 200000 });
  assert.equal(r.state.phase, Phase.STOPPING);
  const stopEff = r.effects.find((e) => e.type === 'stop');
  assert.equal(stopEff.park, 'cue');
  assert.equal(stopEff.parkFrame, s.cueFrame);
  r = transportReduce(r.state, { type: 'stopped', parkedFrame: stopEff.parkFrame });
  assert.equal(r.state.phase, Phase.STOPPED);

  // Pause -> park at the heard frame (distinct command).
  const s2 = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  let r2 = transportReduce(s2, { type: 'pause', heardFrame: 345678, fadeOutFrames: 480 });
  const pauseEff = r2.effects.find((e) => e.type === 'stop');
  assert.equal(pauseEff.park, 'heard');
  assert.equal(pauseEff.parkFrame, 345678);
  r2 = transportReduce(r2.state, { type: 'stopped', parkedFrame: 345678 });
  assert.equal(r2.state.parkedFrame, 345678, 'pause parks at the heard position');
});

test('T1: Play during a stop fade supersedes the pending stop with a new epoch', () => {
  const s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  const stopping = transportReduce(s, { type: 'stop', fadeOutFrames: 480 }).state;
  assert.equal(stopping.phase, Phase.STOPPING);
  const epochBefore = stopping.epoch;
  // Play arrives mid-fade: must be legal and cancel the stop.
  const r = transportReduce(stopping, { type: 'play', fromFrame: 0 });
  assert.equal(r.state.phase, Phase.STARTING, 'play supersedes the pending stop');
  assert.equal(r.state.epoch, epochBefore + 1, 'a new playback epoch begins');
  const eff = r.effects.find((e) => e.type === 'start');
  assert.equal(eff.supersededStop, true, 'the runtime is told the stop was cancelled');
});

test('T1: rapid repeated commands are no-ops that never corrupt state', () => {
  let s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  // play while playing -> no-op
  let r = transportReduce(s, { type: 'play' });
  assert.equal(r.effects[0].type, 'noop');
  assert.equal(r.state.epoch, s.epoch, 'a no-op play does not bump the epoch');
  // stop while playing twice -> second is a no-op
  r = transportReduce(s, { type: 'stop' });
  assert.equal(r.state.phase, Phase.STOPPING);
  const r2 = transportReduce(r.state, { type: 'stop' });
  assert.equal(r2.effects[0].type, 'noop');
  // seek while unprepared -> noop
  const r3 = transportReduce(fresh(), { type: 'seek', frame: 100 });
  assert.equal(r3.effects[0].type, 'noop');
});

test('T1: seek while playing retargets (new epoch, seam effect); seek while stopped parks', () => {
  const s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  const epochBefore = s.epoch;
  let r = transportReduce(s, { type: 'seek', frame: 123456 });
  assert.equal(r.state.phase, Phase.SEEKING);
  assert.equal(r.state.epoch, epochBefore + 1, 'a seek begins a new audio epoch');
  assert.equal(r.state.cueFrame, 123456);
  const eff = r.effects.find((e) => e.type === 'seek');
  assert.equal(eff.seamFrame, 123456);
  // A newer seek while seeking simply retargets.
  r = transportReduce(r.state, { type: 'seek', frame: 200000, retarget: true });
  assert.equal(r.state.phase, Phase.SEEKING);
  assert.equal(r.state.seamFrame, 200000);
  // Seek done -> playing.
  r = transportReduce(r.state, { type: 'seekDone' });
  assert.equal(r.state.phase, Phase.PLAYING);
  // Seek while stopped: no audio, just a parked write.
  const stopped = transportReduce(fresh(), { type: 'prepare' }).state;
  const ready = transportReduce(stopped, { type: 'ready' }).state;
  const rs = transportReduce(ready, { type: 'seek', frame: 999 });
  assert.equal(rs.state.phase, Phase.STOPPED);
  assert.equal(rs.state.parkedFrame, 999);
  assert.deepEqual(rs.effects, [{ type: 'writeParked', frame: 999 }]);
});

test('T1: playback from frame zero and beyond the end are legal positions', () => {
  const s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  // From frame zero.
  let r = transportReduce(s, { type: 'seek', frame: 0 });
  assert.equal(r.state.seamFrame, 0);
  // Beyond the end of active material is a legal parked/seeked position.
  r = transportReduce(playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state), { type: 'seek', frame: END + 50000 });
  assert.equal(r.state.seamFrame, END + 50000, 'seek past the end is legal (plays silence)');
});

test('T1: AudioContext suspension parks honestly; failed is terminal until prepare', () => {
  const s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  let r = transportReduce(s, { type: 'contextSuspended', heardFrame: 555, message: 'system stopped audio' });
  assert.equal(r.state.phase, Phase.STOPPED);
  assert.equal(r.state.isPlaying, false);
  assert.equal(r.state.fault.code, 'CONTEXT_SUSPENDED');
  assert.equal(r.state.parkedFrame, 555);
  // Recovery: prepare -> ready -> play works again.
  r = transportReduce(r.state, { type: 'prepare' });
  assert.equal(r.state.phase, Phase.PREPARING);
  // fail is terminal except via prepare.
  const failed = transportReduce(s, { type: 'fail', code: 'PROCESSOR_ERROR', message: 'boom' }).state;
  assert.equal(failed.phase, Phase.FAILED);
  assert.equal(transportReduce(failed, { type: 'play' }).effects[0].type, 'noop');
  assert.equal(transportReduce(failed, { type: 'prepare' }).state.phase, Phase.PREPARING);
});

test('T1: deadline miss fades out and parks at the heard position (never plays late)', () => {
  const s = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  const r = transportReduce(s, { type: 'deadlineMiss', heardFrame: 777, fadeOutFrames: 480 });
  assert.equal(r.state.phase, Phase.STOPPING);
  const stop = r.effects.find((e) => e.type === 'stop');
  assert.equal(stop.park, 'heard');
  assert.equal(stop.parkFrame, 777);
  const fail = r.effects.find((e) => e.type === 'fail');
  assert.equal(fail.fatal, false);
});

test('T1: isPlaying and parkedFrame are reconciliation values, never an audio clock', () => {
  // Documented contract: isPlaying is a logical belief; parkedFrame is a static
  // bookkeeping value. Neither is advanced by any event here to produce audio —
  // the reducer only ever emits effects carrying integer frames for the runtime
  // to schedule against the context clock. Assert there is no wall-clock/timer
  // dependency in the model by driving it purely and checking determinism.
  const a = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  const b = playToPlaying(transportReduce(fresh(), { type: 'prepare' }).state);
  assert.deepEqual(a, b, 'the model is a pure function of commands (no hidden clock)');
  assert.equal(typeof a.isPlaying, 'boolean');
  assert.equal(typeof a.parkedFrame, 'number');
});

test('T1: setLoop validates and bumps the generation; capacity errors never disturb state', () => {
  const s = fresh();
  let r = transportReduce(s, { type: 'setLoop', loop: [48000, 144000] });
  assert.deepEqual(r.state.loop, [48000, 144000]);
  assert.equal(r.effects[0].type, 'setLoop');
  // A backwards loop is refused with an explicit, testable code.
  r = transportReduce(s, { type: 'setLoop', loop: [100, 50] });
  assert.equal(r.effects[0].type, 'capacityError');
  assert.equal(r.effects[0].code, 'LOOP_TOO_SHORT');
  // capacityError leaves the state untouched (never steals or drops audio).
  const before = fresh();
  const rc = transportReduce(before, { type: 'capacityError', code: 'POOL_EXHAUSTED' });
  assert.equal(rc.state, before, 'a capacity error does not mutate transport state');
  assert.equal(rc.effects[0].code, 'POOL_EXHAUSTED');
});

test('T1: generation increments on every state-changing command (stale-work invalidation)', () => {
  let s = transportReduce(fresh(), { type: 'prepare' }).state;
  const g0 = s.generation;
  s = transportReduce(s, { type: 'ready' }).state;
  s = transportReduce(s, { type: 'play' }).state;
  const g1 = s.generation;
  assert.ok(g1 > g0, 'play/ready bump the generation');
  s = transportReduce(s, { type: 'setLoop', loop: [0, 100] }).state;
  assert.ok(s.generation > g1, 'setLoop bumps the generation');
});

test('Golden Ear II: a keepCue retarget (live loop change) moves the epoch but not the Stop cue', () => {
  let s = createTransportState({ arrangementEndFrame: END });
  s = transportReduce(s, { type: 'prepare' }).state;
  s = transportReduce(s, { type: 'ready', parkedFrame: 1000 }).state;
  s = transportReduce(s, { type: 'play' }).state;
  const epoch = s.epoch;
  const r = transportReduce(s, { type: 'seek', frame: 50000, keepCue: true });
  assert.equal(r.state.phase, Phase.SEEKING);
  assert.equal(r.state.epoch, epoch + 1);
  assert.equal(r.state.cueFrame, 1000, 'cue kept');
  assert.equal(r.effects[0].keepCue, true);
  const owner = transportReduce(s, { type: 'seek', frame: 50000 });
  assert.equal(owner.state.cueFrame, 50000, 'an owner seek still moves the cue');
});
