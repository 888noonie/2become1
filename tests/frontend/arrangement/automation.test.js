// tests/frontend/arrangement/automation.test.js — OPERATION THE ORCHESTRA.
// Gain automation is linear in amplitude. A dB lerp is the defective control.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gainLinearAtBeat,
  gainLinearAtBeatDbLerp,
  panAtBeat,
  scheduleGainEnvelope,
  schedulePanEnvelope,
} from '../../../src/twobecomeone/studio_static/js/arrangement/automation.js';
import { EditEngine, InvalidEditError } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import {
  deserializeProject,
  serializeProject,
} from '../../../src/twobecomeone/studio_static/js/arrangement/project-state.js';
import { scheduleOfflineEnvelopes } from '../../../src/twobecomeone/studio_static/js/arrangement/offline-render.js';
import { compileRenderPlan, dbToLinear } from '../../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { createTransportMap } from '../../../src/twobecomeone/studio_static/js/arrangement/transport.js';
import { FakeAudioParam } from './helpers/fake-audio.js';

const SR = 48000;
const BPM = 120;

/** Four-bar vocal entrance: 120 BPM, volume 0, silence at beat 0, unity at beat 16. */
function entranceTrack(extra = {}) {
  return {
    volumeDb: 0,
    gainPoints: [{ beat: 0, db: -60 }, { beat: 16, db: 0 }],
    ...extra,
  };
}

function paramAt(track, seconds, options = {}) {
  const map = options.map ?? createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 0 }, 0);
  scheduleGainEnvelope(param, track, {
    originSec: 0,
    map,
    sampleRate: SR,
    bpm: BPM,
    audible: true,
    horizonSec: 120,
    now: 0,
    ...options,
  });
  return param.valueAt(seconds);
}

test('four-bar entrance holds the first point, the amplitude midpoint, unity, then the last point', () => {
  const track = entranceTrack();
  const floor = dbToLinear(-60);
  assert.equal(gainLinearAtBeat(track, 0), floor);
  assert.ok(Math.abs(gainLinearAtBeat(track, 8) - (floor + 1) / 2) < 1e-12);
  assert.equal(gainLinearAtBeat(track, 16), 1);
  assert.equal(gainLinearAtBeat(track, 20), 1, 'after the last point the last value holds');
  // 120 BPM: beat 8 is 4.000 s, beat 16 is 8.000 s.
  assert.equal(8 * (60 / BPM), 4);
  assert.equal(16 * (60 / BPM), 8);
});

test('the musical curve ignores mute and a missing envelope is the fader', () => {
  const track = entranceTrack({ mute: true });
  assert.equal(gainLinearAtBeat(track, 0), gainLinearAtBeat(entranceTrack(), 0));
  const bare = { volumeDb: -6 };
  assert.equal(gainLinearAtBeat(bare, 3), dbToLinear(-6));
  assert.equal(gainLinearAtBeat({ volumeDb: -6, gainPoints: [] }, 3), dbToLinear(-6));
});

test('offsets sit on the fader and the absolute level is clamped', () => {
  const quiet = { volumeDb: -6, gainPoints: [{ beat: 0, db: 0 }, { beat: 4, db: 0 }] };
  assert.ok(Math.abs(gainLinearAtBeat(quiet, 2) - dbToLinear(-6)) < 1e-12);
  const hot = { volumeDb: 6, gainPoints: [{ beat: 0, db: 6 }] };
  assert.ok(Math.abs(gainLinearAtBeat(hot, 1) - dbToLinear(6)) < 1e-12);
});

test('a dB lerp at the midpoint is a different curve, and the scheduler follows amplitude', () => {
  const track = entranceTrack();
  const linear = gainLinearAtBeat(track, 8);
  const defective = gainLinearAtBeatDbLerp(track, 8);
  assert.ok(Math.abs(defective - dbToLinear(-30)) < 1e-12);
  assert.ok(Math.abs(linear - defective) > 0.2);
  const heard = paramAt(track, 4);
  assert.ok(Math.abs(heard - linear) < 1e-9, `scheduler at 4.000 s is ${heard}, want ${linear}`);
  assert.ok(Math.abs(heard - defective) > 0.2, 'a dB lerp must not match the scheduled value');
});

test('two points on the same beat are a step to the later point', () => {
  const track = {
    volumeDb: 0,
    gainPoints: [{ beat: 4, db: -60 }, { beat: 4, db: 0 }],
  };
  const floor = dbToLinear(-60);
  assert.equal(gainLinearAtBeat(track, 0), floor, 'before the shared beat the first point holds');
  assert.equal(gainLinearAtBeat(track, 4), 1, 'at the shared beat the later point applies');
  assert.equal(gainLinearAtBeat(track, 6), 1);
  const frame = Math.round(4 * (60 / BPM) * SR);
  const atStep = frame / SR;
  const justBefore = paramAt(track, atStep - 1 / SR);
  const at = paramAt(track, atStep);
  assert.ok(Math.abs(justBefore - floor) < 1e-6);
  assert.ok(Math.abs(at - 1) < 1e-9);
  assert.ok(Math.abs(at - justBefore) > 0.5, 'the step is not a ramp across a zero-length span');
});

test('a loop seam steps to the loop-start gain and does not ramp in from the loop end', () => {
  const track = entranceTrack();
  const loopEndFrame = Math.round(8 * (60 / BPM) * SR);
  const map = createTransportMap({ startFrame: 0, loop: [0, loopEndFrame], sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 0 }, 1);
  scheduleGainEnvelope(param, track, {
    originSec: 0, map, sampleRate: SR, bpm: BPM, audible: true, horizonSec: 120, now: 0,
  });
  const seam = map.passStartCtx(1) / SR;
  assert.equal(seam, 4);
  const startLin = gainLinearAtBeat(track, 0);
  const endLin = gainLinearAtBeat(track, 8);
  assert.ok(Math.abs(endLin - startLin) > 0.2);
  const seamEvents = param.events.filter((e) => Math.abs(e.t - seam) < 1e-6);
  const step = seamEvents.find((e) => e.type === 'set');
  assert.ok(step, 'the seam has a setValue event');
  assert.ok(Math.abs(step.v - startLin) < 1e-9, 'the seam event is the loop-start gain');
  assert.ok(
    !seamEvents.some((e) => e.type === 'linear' && Math.abs(e.v - endLin) < 1e-6),
    'the seam is not a ramp that arrives on the loop-end gain',
  );
  assert.ok(Math.abs(param.valueAt(seam) - startLin) < 1e-9);
  assert.ok(Math.abs(param.valueAt(seam + 0.01) - startLin) < Math.abs(param.valueAt(seam + 0.01) - endLin));
});

test('a silenced track schedules 0 for the whole future', () => {
  const track = entranceTrack();
  const map = createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 0 }, 1);
  scheduleGainEnvelope(param, track, {
    originSec: 0, map, sampleRate: SR, bpm: BPM, audible: false, horizonSec: 120, now: 0,
  });
  assert.equal(param.valueAt(4), 0);
  assert.equal(param.valueAt(8), 0);
  assert.ok(param.events.every((e) => e.v === 0));
});

test('two points at one beat schedule a set and no zero-length ramp', () => {
  const track = { volumeDb: 0, gainPoints: [{ beat: 4, db: -60 }, { beat: 4, db: 0 }] };
  const map = createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 0 }, 1);
  scheduleGainEnvelope(param, track, {
    originSec: 0, map, sampleRate: SR, bpm: BPM, audible: true, now: 0,
  });
  const at = 2;
  const there = param.events.filter((e) => Math.abs(e.t - at) < 1e-6);
  assert.equal(there[there.length - 1].type, 'set');
  assert.ok(Math.abs(there[there.length - 1].v - 1) < 1e-9);
  for (let i = 1; i < param.events.length; i += 1) {
    if (param.events[i].type === 'linear') {
      assert.ok(param.events[i].t > param.events[i - 1].t + 1e-9);
    }
  }
});

test('a loop that ends on a breakpoint steps to the loop-start gain', () => {
  const track = entranceTrack();
  const loopEndFrame = Math.round(16 * (60 / BPM) * SR);
  const map = createTransportMap({ startFrame: 0, loop: [0, loopEndFrame], sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 0 }, 1);
  scheduleGainEnvelope(param, track, {
    originSec: 0, map, sampleRate: SR, bpm: BPM, audible: true, horizonSec: 120, now: 0,
  });
  const seam = 8;
  const startLin = dbToLinear(-60);
  const sets = param.events.filter((e) => e.type === 'set' && Math.abs(e.t - seam) < 1e-6);
  assert.ok(sets.length >= 1);
  assert.ok(Math.abs(sets[sets.length - 1].v - startLin) < 1e-9);
  assert.ok(!param.events.some((e) => e.type === 'linear' && Math.abs(e.t - seam) < 1e-6));
  const approach = param.events.filter((e) => e.type === 'linear' && e.t < seam);
  assert.ok(approach.length >= 1);
  assert.ok(seam - approach[approach.length - 1].t >= (1 / SR) - 1e-6);
  const mid = (startLin + 1) / 2;
  assert.ok(Math.abs(param.valueAt(12) - mid) < 1e-3);
  assert.ok(Math.abs(param.valueAt(12) - 1) > 0.2);
});

test('starting in the middle anchors on that beat, not the first point', () => {
  const track = entranceTrack();
  const start = Math.round(8 * (60 / BPM) * SR);
  const map = createTransportMap({ startFrame: start, sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 0 }, 1);
  scheduleGainEnvelope(param, track, {
    originSec: 1, map, sampleRate: SR, bpm: BPM, audible: true, now: 1,
  });
  const mid = (dbToLinear(-60) + 1) / 2;
  assert.ok(Math.abs(param.valueAt(1) - mid) < 1e-6);
  assert.ok(Math.abs(param.valueAt(1) - dbToLinear(-60)) > 0.2);
});

test('move, slip, and stretch leave gain points on the track', () => {
  const engine = new EditEngine();
  const { clipId } = engine.loadStemToTrack(0, {
    name: 'vocals.wav', durationSec: 30, bufferReference: 'cache:vocals',
    source: { section: { startSec: 30 } },
  }, null);
  engine.trimClip(clipId, 'end', -20);
  const points = [{ beat: 0, db: -60 }, { beat: 16, db: 0 }];
  engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points } });
  const before = structuredClone(engine.state.tracks[0].gainPoints);
  engine.moveClip(clipId, 0, 4);
  assert.equal(engine.state.clips.find((c) => c.id === clipId).timelineStartBeat, 4);
  assert.deepEqual(engine.state.tracks[0].gainPoints, before);
  const offset = engine.state.clips.find((c) => c.id === clipId).sourceOffsetSec;
  engine.slipClip(clipId, offset + 0.5);
  assert.notEqual(engine.state.clips.find((c) => c.id === clipId).sourceOffsetSec, offset);
  assert.deepEqual(engine.state.tracks[0].gainPoints, before);
  engine.stretchClipKeepingSource(clipId, 0.5);
  assert.deepEqual(engine.state.tracks[0].gainPoints, before);
});

test('undo restores the previous points and one drag gesture is one undo', () => {
  const engine = new EditEngine();
  const depth = engine.historyDepth.past;
  engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [{ beat: 0, db: -12 }] } });
  assert.equal(engine.historyDepth.past, depth + 1);
  engine.runGesture(
    { name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [{ beat: 0, db: -24 }] } },
    'gain-envelope-0',
  );
  engine.runGesture(
    { name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [{ beat: 1, db: -30 }] } },
    'gain-envelope-0',
  );
  assert.equal(engine.historyDepth.past, depth + 2, 'two gesture updates are one undo step');
  assert.equal(engine.undo(), true);
  assert.deepEqual(engine.state.tracks[0].gainPoints, [{ beat: 0, db: -12 }]);
  assert.equal(engine.undo(), true);
  assert.equal(engine.state.tracks[0].gainPoints, undefined);
});

test('a v1 project with no gainPoints deserializes and the curve is the fader', () => {
  const engine = new EditEngine();
  engine.loadStemToTrack(0, {
    name: 'vocals.wav', durationSec: 10, bufferReference: 'cache:vocals',
    source: { section: { startSec: 30 } },
  }, 90);
  engine.setAssetTempo(Object.keys(engine.state.assets)[0], 100);
  const state = engine.snapshot();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.tracks[0].gainPoints, undefined);
  assert.equal(state.assets[Object.keys(state.assets)[0]].nativeBpmSource, 'owner');
  assert.equal(state.assets[Object.keys(state.assets)[0]].source.section.startSec, 30);
  const restored = deserializeProject(serializeProject(state));
  const asset = restored.assets[Object.keys(restored.assets)[0]];
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.tracks[0].gainPoints, undefined);
  assert.equal(asset.nativeBpmSource, 'owner');
  assert.equal(asset.source.section.startSec, 30);
  assert.equal(gainLinearAtBeat(restored.tracks[0], 4), dbToLinear(restored.tracks[0].volumeDb));
  const again = new EditEngine({ project: restored });
  const points = [{ beat: 0, db: -60 }, { beat: 16, db: 0 }];
  again.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points } });
  const roundTrip = deserializeProject(again.serialize());
  assert.deepEqual(roundTrip.tracks[0].gainPoints, points);
  assert.equal(roundTrip.schemaVersion, 1);
  assert.equal(roundTrip.assets[Object.keys(roundTrip.assets)[0]].nativeBpmSource, 'owner');
  assert.equal(roundTrip.assets[Object.keys(roundTrip.assets)[0]].source.section.startSec, 30);
});

test('more than 48 points is refused and does not enter history', () => {
  const engine = new EditEngine();
  const depth = engine.historyDepth.past;
  const points = Array.from({ length: 49 }, (_, i) => ({ beat: i, db: 0 }));
  assert.throws(
    () => engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points } }),
    (err) => err instanceof InvalidEditError,
  );
  assert.equal(engine.historyDepth.past, depth);
  assert.equal(engine.state.tracks[0].gainPoints, undefined);
  assert.throws(
    () => engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [{ beat: -1, db: 0 }] } }),
    (err) => err instanceof InvalidEditError,
  );
  assert.throws(
    () => engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [{ beat: 0, db: 6.1 }] } }),
    (err) => err instanceof InvalidEditError,
  );
  assert.throws(
    () => engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [{ beat: Number.NaN, db: 0 }] } }),
    (err) => err instanceof InvalidEditError,
  );
  assert.equal(engine.historyDepth.past, depth);
});

test('offline scheduling ignores loopRange and does not restart the entrance', () => {
  const param = new FakeAudioParam({ currentTime: 0 }, 1);
  scheduleOfflineEnvelopes({
    trackInputs: { 'gain-0': { gain: param } },
  }, {
    sampleRate: SR,
    masterBpm: BPM,
    loopRange: [0, 16],
    tracks: [{
      trackIndex: 0,
      audible: true,
      volumeDb: 0,
      gainPoints: [{ beat: 0, db: -60 }, { beat: 16, db: 0 }],
    }],
  }, 0);
  const mid = (dbToLinear(-60) + 1) / 2;
  assert.ok(Math.abs(param.valueAt(4) - mid) < 1e-9);
  assert.equal(param.valueAt(10), 1, 'beat 20 holds; the loop is not unrolled into the bounce');
});

test('pan uses the same hold, line, and step, and does not add track.pan', () => {
  assert.equal(panAtBeat({ pan: -0.25, panPoints: [] }, 3), -0.25);
  assert.equal(panAtBeat({ pan: -0.25 }, 3), -0.25);
  const track = { pan: 0.8, panPoints: [{ beat: 0, pan: -1 }, { beat: 4, pan: 1 }] };
  assert.equal(panAtBeat(track, 0), -1);
  assert.equal(panAtBeat(track, 2), 0);
  assert.equal(panAtBeat(track, 8), 1);
  const step = { pan: 0, panPoints: [{ beat: 2, pan: -1 }, { beat: 2, pan: 1 }] };
  assert.equal(panAtBeat(step, 0), -1);
  assert.equal(panAtBeat(step, 2), 1);
});

test('a pan hold before the move is not ramped away', () => {
  const track = { pan: 0.8, panPoints: [{ beat: 4, pan: -1 }, { beat: 8, pan: 1 }] };
  const map = createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  const pan = new FakeAudioParam({ currentTime: 0 }, 0);
  schedulePanEnvelope(pan, track, {
    originSec: 0, map, sampleRate: SR, bpm: BPM, now: 0,
  });
  const early = -1 + (1 / 4) * 2;
  assert.ok(Math.abs(early - (-0.5)) < 1e-9, 'negative control: an early pan ramp is already halfway');
  assert.ok(Math.abs(pan.valueAt(1) - (-1)) < 1e-6, `at 1.000 s pan is ${pan.valueAt(1)}, want -1`);
  assert.ok(Math.abs(pan.valueAt(1) - early) > 0.4);
  assert.ok(Math.abs(pan.valueAt(3) - 0) < 1e-6, 'beat 6 is the pan midpoint');
});

test('pan scheduling writes the pan param and leaves the gain param alone', () => {
  const gain = new FakeAudioParam({ currentTime: 0 }, 0.5);
  const pan = new FakeAudioParam({ currentTime: 0 }, 0);
  gain.setValueAtTime(0.5, 0);
  const gainEvents = gain.events.length;
  const map = createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  schedulePanEnvelope(pan, {
    pan: 0,
    panPoints: [{ beat: 0, pan: -1 }, { beat: 4, pan: 1 }],
  }, { originSec: 0, map, sampleRate: SR, bpm: BPM, now: 0 });
  assert.equal(gain.events.length, gainEvents);
  assert.equal(pan.valueAt(0), -1);
  assert.ok(Math.abs(pan.valueAt(1) - 0) < 1e-9);
  const engine = new EditEngine();
  const depth = engine.historyDepth.past;
  assert.throws(
    () => engine.run({
      name: 'setTrackPanEnvelope',
      args: { trackIndex: 0, points: Array.from({ length: 49 }, (_, i) => ({ beat: i, pan: 0 })) },
    }),
    (err) => err instanceof InvalidEditError,
  );
  assert.equal(engine.historyDepth.past, depth);
  engine.run({ name: 'setTrackPanEnvelope', args: { trackIndex: 0, points: [{ beat: 0, pan: -1 }, { beat: 4, pan: 1 }] } });
  engine.runGesture(
    { name: 'setTrackPanEnvelope', args: { trackIndex: 0, points: [{ beat: 0, pan: -1 }, { beat: 5, pan: 1 }] } },
    'pan-envelope-0',
  );
  engine.runGesture(
    { name: 'setTrackPanEnvelope', args: { trackIndex: 0, points: [{ beat: 0, pan: -0.5 }, { beat: 5, pan: 1 }] } },
    'pan-envelope-0',
  );
  assert.equal(engine.historyDepth.past, depth + 2);
  assert.equal(engine.undo(), true);
  assert.equal(engine.state.tracks[0].panPoints[0].pan, -1);
});

test('clearing the envelope removes it and the plan copies points without touching clips', () => {
  const engine = new EditEngine();
  engine.loadStemToTrack(0, {
    name: 'vocals.wav', durationSec: 10, bufferReference: 'cache:vocals',
  }, null);
  const bare = compileRenderPlan(engine.state);
  const points = [{ beat: 0, db: -60 }, { beat: 16, db: 0 }];
  engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points } });
  const plan = compileRenderPlan(engine.state);
  assert.equal(JSON.stringify(plan.clips), JSON.stringify(bare.clips));
  assert.deepEqual(plan.tracks[0].gainPoints, points);
  assert.deepEqual(plan.tracks[1].gainPoints, []);
  engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: [] } });
  assert.equal(engine.state.tracks[0].gainPoints, undefined);
  engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points } });
  engine.run({ name: 'setTrackGainEnvelope', args: { trackIndex: 0, points: null } });
  assert.equal(engine.state.tracks[0].gainPoints, undefined);
});

test('a hold before the first rise is not ramped away', () => {
  const track = { volumeDb: 0, audible: true, trackIndex: 0, gainPoints: [{ beat: 4, db: -60 }, { beat: 8, db: 0 }] };
  const floor = dbToLinear(-60);
  assert.equal(gainLinearAtBeat(track, 2), floor);
  const heard = paramAt(track, 1);
  // Negative control: skipping the equal event at beat 4 ramps from beat 0,
  // so 1.000 s (frame 48,000) is already 0.25075.
  const skippedEqual = floor + (1 / 4) * (1 - floor);
  assert.ok(Math.abs(skippedEqual - 0.25075) < 1e-6, 'the defective early ramp is still the one Codex measured');
  assert.ok(Math.abs(heard - floor) < 1e-6, `at 1.000 s the hold is ${heard}, want ${floor}`);
  assert.ok(Math.abs(heard - skippedEqual) > 0.2, 'the scheduler must not follow the early ramp');
  const mid = paramAt(track, 3);
  const want = gainLinearAtBeat(track, 6);
  assert.ok(Math.abs(mid - want) < 1e-6, `at 3.000 s the rise is ${mid}, want ${want}`);
  const offline = new FakeAudioParam({ currentTime: 0 }, 0);
  scheduleOfflineEnvelopes({ trackInputs: { 'gain-0': { gain: offline } } }, {
    sampleRate: SR, masterBpm: BPM, loopRange: [0, 8 * SR], tracks: [track],
  }, 0);
  assert.ok(Math.abs(offline.valueAt(1) - heard) < 1e-9, 'export holds the same level live playback holds');
  assert.ok(Math.abs(offline.valueAt(3) - mid) < 1e-9, 'export rises on the same line');
});

test('a long loop does not reach the loop-end gain inside the first window', () => {
  const track = { volumeDb: 0, gainPoints: [{ beat: 0, db: -60 }, { beat: 480, db: 0 }] };
  const loopEnd = Math.round(240 * SR);
  const map = createTransportMap({ startFrame: 0, loop: [0, loopEnd], sampleRate: SR });
  const heard = paramAt(track, 60, { map });
  const want = gainLinearAtBeat(track, 120);
  // Negative control: writing the loop-end value at the 120 s horizon makes
  // 60 s the midpoint, 0.5005, which is a whole quarter of the rise too loud.
  const horizonStealsLoopEnd = dbToLinear(-60) + 0.5 * (1 - dbToLinear(-60));
  assert.ok(Math.abs(horizonStealsLoopEnd - 0.5005) < 1e-4);
  assert.ok(Math.abs(heard - want) < 1e-4, `at 60 s the live window is ${heard}, want ${want}`);
  assert.ok(Math.abs(heard - horizonStealsLoopEnd) > 0.2);
});

test('a later epoch keeps the outgoing curve until the handover', () => {
  const track = entranceTrack();
  const map = createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  const param = new FakeAudioParam({ currentTime: 4 }, 0);
  scheduleGainEnvelope(param, track, {
    originSec: 0, map, sampleRate: SR, bpm: BPM, audible: true, now: 0,
  });
  const restart = createTransportMap({ startFrame: 0, loop: null, sampleRate: SR });
  scheduleGainEnvelope(param, track, {
    originSec: 4.104, map: restart, sampleRate: SR, bpm: BPM, audible: true,
    anchorSec: 4, takeoverSec: 4.104,
    outgoingValueAt: (time) => gainLinearAtBeat(track, time * (BPM / 60)),
  });
  const outgoing = gainLinearAtBeat(track, 4.05 * (BPM / 60));
  assert.ok(Math.abs(param.valueAt(4.05) - outgoing) < 1e-4, `outgoing at 4.050 s is ${param.valueAt(4.05)}, want ${outgoing}`);
  assert.ok(Math.abs(param.valueAt(4.104) - gainLinearAtBeat(track, 0)) < 1e-6);
});
