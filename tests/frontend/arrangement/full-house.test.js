// tests/frontend/arrangement/full-house.test.js — OPERATION FULL HOUSE.
//
// The Studio arrangement editor's new edit commands, the live engine's plan
// replacement and the DawSession lifecycle (import, transport, save/open,
// export), over the existing simulated Web Audio host.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EditEngine, InvalidEditError } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '../../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { validateProject, deserializeProject } from '../../../src/twobecomeone/studio_static/js/arrangement/project-state.js';
import { RealtimeEngine } from '../../../src/twobecomeone/studio_static/js/realtime-engine.js';
import {
  DawSession, computePeaks, DECODE_LIMITS, EXPORT_TAIL_SEC,
} from '../../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';
import { readWavHeader } from '../../../src/twobecomeone/studio_static/js/arrangement/wav.js';
import {
  FakeAudioContext, installFakeWorkletGlobal, fakeStretchFactory, flush, manualTimers, SR,
} from './helpers/fake-audio.js';

installFakeWorkletGlobal();

const stem = (name, durationSec = 8, ref = `/api/stems/set/audio?name=${name}`) => ({ name, durationSec, bufferReference: ref });

function loaded(bpm = 120) {
  const e = new EditEngine();
  e.setMasterBpm(bpm);
  const { clipId } = e.loadStemToTrack(0, stem('vocals'));
  return { e, clipId };
}

// ------------------------------------------------------------------ edit API

test('deleteClip removes only the clip; undo restores it against the same asset', () => {
  const { e, clipId } = loaded();
  const asset = e.state.clips[0].assetId;
  e.deleteClip(clipId);
  assert.equal(e.state.clips.length, 0);
  assert.ok(e.state.assets[asset], 'the source asset is never deleted');
  e.undo();
  assert.equal(e.state.clips[0].id, clipId);
  assert.throws(() => e.deleteClip('nope'), (err) => err instanceof InvalidEditError && err.code === 'NOT_FOUND');
});

test('duplicateClip copies every musical field to the next free position', () => {
  const { e, clipId } = loaded();
  e.setClipPitch(clipId, 3, true);
  e.setClipGain(clipId, -4);
  const { clipId: copyId } = e.duplicateClip(clipId);
  const [a, b] = [e.state.clips.find((c) => c.id === clipId), e.state.clips.find((c) => c.id === copyId)];
  assert.notEqual(copyId, clipId);
  assert.equal(b.timelineStartBeat, a.timelineStartBeat + a.durationBeats);
  for (const k of ['assetId', 'sourceOffsetSec', 'durationBeats', 'pitchSemitones', 'preserveFormants', 'clipGainDb', 'stretchMode']) {
    assert.deepEqual(b[k], a[k], k);
  }
});

test('batch is one atomic, undoable step; a failing sub-command leaves state untouched', () => {
  const { e, clipId } = loaded();
  const before = e.serialize();
  const depth = e.historyDepth.past;
  assert.throws(() => e.batch([
    { name: 'setTrackMute', args: { trackIndex: 0, mute: true } },
    { name: 'setClipGain', args: { clipId, gainDb: 99 } },
  ]));
  assert.equal(e.serialize(), before, 'nothing of a refused batch lands');
  e.batch([
    { name: 'setTrackMute', args: { trackIndex: 0, mute: true } },
    { name: 'setTrackName', args: { trackIndex: 0, name: 'A Vocals' } },
  ]);
  assert.equal(e.historyDepth.past, depth + 1);
  e.undo();
  assert.equal(e.serialize(), before);
});

test('stretchClipKeepingSource keeps the source span and follows the measured tempo', () => {
  const e = new EditEngine();
  e.setMasterBpm(120);
  const { clipId } = e.loadStemToTrack(0, { ...stem('vocals'), nativeBpm: 100 }, undefined);
  e.setClipStretch(clipId, 1);
  e.trimClip(clipId, 'end', -4);
  const span = e.state.clips[0].durationBeats * 0.5; // ratio 1: beats x 0.5 s = source seconds
  const out = e.stretchClipKeepingSource(clipId, 'auto');
  const c = e.state.clips[0];
  assert.equal(c.stretchMode, 'beat_sync');
  assert.ok(Math.abs(out.durationBeats - span / (120 / 100) / 0.5) < 1e-9, 'faster material takes fewer beats');
  assert.equal(c.sourceOffsetSec, 0);
  assert.equal(c.pitchSemitones, 0, 'time stretch never touches pitch');
  const unknown = new EditEngine();
  const { clipId: u } = unknown.loadStemToTrack(0, stem('drums'));
  assert.throws(() => unknown.stretchClipKeepingSource(u, 'auto'), (err) => err.code === 'BEAT_SYNC_UNAVAILABLE');
  unknown.setAssetTempo(unknown.state.clips[0].assetId, 90);
  assert.equal(unknown.state.assets[unknown.state.clips[0].assetId].nativeBpmSource, 'owner', 'an entered tempo is labelled as entered');
  unknown.stretchClipKeepingSource(u, 0.5);
  assert.equal(unknown.state.clips[0].durationBeats, 32, 'half speed doubles the timeline length');
});

test('naturalSpeed import keeps the measured tempo on the asset but plays at ratio 1', () => {
  const e = new EditEngine();
  e.run({ name: 'loadStemToTrack', args: { trackIndex: 4, audioFile: { ...stem('vocals'), nativeBpm: 84.3 }, naturalSpeed: true } });
  const c = e.state.clips[0];
  assert.equal(c.stretchMode, 'manual');
  assert.equal(c.customStretchRatio, 1);
  assert.equal(c.durationBeats, 16, '8 s at 120 BPM');
  assert.equal(e.state.assets[c.assetId].nativeBpm, 84.3);
  assert.equal(e.state.assets[c.assetId].nativeBpmSource, 'analysis');
});

test('runGesture coalesces one fader drag into a single undo step', () => {
  const { e } = loaded();
  const depth = e.historyDepth.past;
  for (const v of [-1, -2, -3, -4]) e.runGesture({ name: 'setTrackVolume', args: { trackIndex: 0, volumeDb: v } }, 'vol:0');
  e.endGesture();
  assert.equal(e.historyDepth.past, depth + 1);
  assert.equal(e.state.tracks[0].volumeDb, -4);
  e.undo();
  assert.equal(e.state.tracks[0].volumeDb, 0, 'undo returns to before the drag, not to the last step');
  e.runGesture({ name: 'setTrackVolume', args: { trackIndex: 0, volumeDb: -6 } }, 'vol:0');
  e.run({ name: 'setTrackPan', args: { trackIndex: 0, pan: 0.5 } });
  e.runGesture({ name: 'setTrackVolume', args: { trackIndex: 0, volumeDb: -7 } }, 'vol:0');
  assert.equal(e.historyDepth.past, depth + 3, 'a different edit ends the gesture');
});

test('the master level is optional project state that the plan and validation honour', () => {
  const { e } = loaded();
  assert.equal(compileRenderPlan(e.state).master.gainLinear, 1, 'absent = 0 dB (older projects unchanged)');
  e.setMasterVolume(-6);
  const plan = compileRenderPlan(e.state);
  assert.ok(Math.abs(plan.master.gainLinear - 10 ** (-6 / 20)) < 1e-12);
  assert.equal(validateProject({ ...e.snapshot(), master: { volumeDb: 40 } }).ok, false);
  const round = deserializeProject(e.serialize());
  assert.equal(round.master.volumeDb, -6);
});

test('the edit revision moves on edits, undo and redo, but not on playhead moves', () => {
  const { e } = loaded();
  const r = e.revision;
  e.setPlayhead(3);
  assert.equal(e.revision, r);
  e.setTrackPan(0, 0.2);
  e.undo();
  e.redo();
  assert.equal(e.revision, r + 3);
});

// ------------------------------------------------------------------ live engine

function planClip({ id, track = 0, start = 0, length = 4 * SR, src = 0 }) {
  return {
    clipId: id, assetId: 'a', trackIndex: track, bufferReference: 'src',
    timelineStartFrame: start, timelineEndFrame: start + length, timelineDurationFrames: length,
    sourceStartFrame: src, sourceEndFrame: src + length, sourceSpanFrames: length,
    rate: 1, pitchSemitones: 0, pitchFactor: 1, preserveFormants: false, clipGainDb: 0, clipGainLinear: 1,
    fadeInFrames: 0, fadeOutFrames: 0,
  };
}

function enginePlan(clips, mix = {}) {
  const end = Math.max(...clips.map((c) => c.timelineEndFrame));
  return {
    sampleRate: SR, masterBpm: 120, loopRange: null,
    master: { gainLinear: mix.master ?? 1 },
    limiter: { ceilingLinear: 10 ** (-0.3 / 20), lookaheadMs: 5, releaseMs: 50 },
    tracks: Array.from({ length: 8 }, (_, i) => ({
      trackIndex: i, name: `T${i}`, volumeLinear: mix.volume?.[i] ?? 1, pan: mix.pan?.[i] ?? 0,
      mute: false, solo: false, audible: !(mix.muted ?? []).includes(i),
      eq: { lowGainDb: mix.low?.[i] ?? 0, midGainDb: 0, highGainDb: 0 },
    })),
    output: { channels: 2, arrangementEndFrame: end, totalFrames: end },
    clips,
  };
}

async function liveEngine(clips) {
  const ctx = new FakeAudioContext();
  const buffers = { src: { channels: [new Float32Array(40 * SR), new Float32Array(40 * SR)] } };
  const engine = new RealtimeEngine(ctx, enginePlan(clips), buffers, {
    StretchFactory: fakeStretchFactory(), limiterModuleUrl: 'limiter.js', timers: manualTimers(),
  });
  await engine.prepare();
  return { ctx, engine };
}

async function run(ctx, engine, toSec) {
  while (ctx.currentTime + 1e-12 < toSec) {
    ctx.currentTime = Math.min(toSec, ctx.currentTime + 0.025);
    await engine.tick();
    await flush();
  }
}

test('replacePlan while stopped swaps the plan and ramps the mixer, no voices built', async () => {
  const { ctx, engine } = await liveEngine([planClip({ id: 'x' })]);
  const out = await engine.replacePlan(enginePlan([planClip({ id: 'x', start: SR })], { volume: { 2: 0.5 }, muted: [3], low: { 1: -6 }, master: 0.5 }));
  assert.equal(out.reseeked, false);
  assert.equal(engine.plan.clips[0].timelineStartFrame, SR);
  ctx.currentTime = 0.05;
  const ti = engine.backbone.trackInputs;
  assert.equal(ti['gain-2'].gain.value, 0.5);
  assert.equal(ti['gain-3'].gain.value, 0, 'a muted track ramps to silence');
  assert.equal(ti['eq-1'].low.gain.value, -6);
  assert.equal(engine.backbone.master.gain.value, 0.5);
  assert.equal(engine.voices.size, 0);
});

test('a clip edit while playing hands over at the heard position: old voices fade, only the new plan sounds', async () => {
  const { ctx, engine } = await liveEngine([planClip({ id: 'x', length: 20 * SR })]);
  engine.play(0);
  await run(ctx, engine, 1.0);
  assert.equal(engine.state().phase, 'playing');
  const oldEpochVoices = [...engine.voices.values()].map((v) => v.key);
  const moved = planClip({ id: 'x', start: 0, length: 20 * SR, src: 2 * SR });
  const out = await engine.replacePlan(enginePlan([moved]));
  assert.equal(out.reseeked, true);
  await run(ctx, engine, 1.6);
  assert.equal(engine.state().phase, 'playing', 'an edit never stops playback');
  const live = [...engine.voices.values()];
  assert.ok(live.every((v) => !oldEpochVoices.includes(v.key)), 'every old voice has been released');
  assert.ok(live.length >= 1);
  assert.ok(live.every((v) => v.vp.sourceStart >= 2 * SR), 'the voices that sound read the edited source region');
  // The frame heard `startLead` from now is the frame being rendered now (1.0 s),
  // because the epoch itself started `startLead` after Play.
  assert.ok(Math.abs(out.frame - SR) < 0.03 * SR, `handover at the heard position (${out.frame})`);
  assert.equal(engine.deadlineMisses, 0);
  engine.stop();
  await run(ctx, engine, 2.2);
  assert.equal(engine.voices.size, 0, 'Stop releases everything');
  assert.equal(ctx.connectedProcessors(), 0);
});

test('a mixer-only change while playing does not re-seek', async () => {
  const { ctx, engine } = await liveEngine([planClip({ id: 'x', length: 20 * SR })]);
  engine.play(0);
  await run(ctx, engine, 0.6);
  const epoch = engine.state().epoch;
  const gen = engine.state().generation;
  const out = await engine.replacePlan(enginePlan([planClip({ id: 'x', length: 20 * SR })], { muted: [0] }));
  assert.equal(out.reseeked, false);
  assert.equal(engine.state().epoch, epoch);
  assert.equal(engine.state().generation, gen);
  ctx.currentTime += 0.05;
  assert.equal(engine.backbone.trackInputs['gain-0'].gain.value, 0);
});

// ------------------------------------------------------------------ session

class FakeEngine {
  constructor(ctx, plan, buffers, options) {
    this.ctx = ctx; this.plan = plan; this.buffers = buffers; this.options = options;
    this.phase = 'unprepared'; this.loop = null; this.calls = []; FakeEngine.last = this;
  }
  async prepare() { this.phase = 'stopped'; }
  state() { return { phase: this.phase, loop: this.loop, epoch: 0 }; }
  play(f) { this.calls.push(['play', f]); this.phase = 'playing'; }
  stop() { this.calls.push(['stop']); this.phase = 'stopped'; }
  pause() { this.calls.push(['pause']); this.phase = 'stopped'; }
  seek(f) { this.calls.push(['seek', f]); }
  setLoop(l) { this.calls.push(['setLoop', l]); this.loop = l; }
  async replacePlan(p) { this.calls.push(['replacePlan', p]); this.plan = p; return { reseeked: false }; }
  playheadAt() { return 0; }
  outputDelaySec() { return 0; }
  dispose() { this.calls.push(['dispose']); this.phase = 'disposed'; }
}

function fakeServer() {
  const saved = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url]);
    if (url.startsWith('/api/stems/')) {
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
    }
    if (url === '/api/arrangements') {
      return { ok: true, json: async () => ({ items: [...saved.values()].map((v) => ({ id: v.id, name: v.name })) }) };
    }
    const m = /^\/api\/arrangements\/(.+)$/.exec(url);
    if (m && init.method === 'PUT') {
      const body = JSON.parse(init.body);
      saved.set(m[1], { id: m[1], name: body.name, project: body.project });
      return { ok: true, json: async () => ({ id: m[1] }) };
    }
    if (m) return { ok: saved.has(m[1]), status: saved.has(m[1]) ? 200 : 404, json: async () => saved.get(m[1]) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { saved, calls, fetchImpl };
}

const decodeAudio = async () => {
  const length = 10 * SR;
  const ch = [new Float32Array(length).fill(0.25), new Float32Array(length).fill(0.25)];
  return { sampleRate: SR, numberOfChannels: 2, length, getChannelData: (c) => ch[c] };
};

function makeSession(extra = {}) {
  const server = fakeServer();
  const contexts = [];
  const rendered = [];
  const session = new DawSession({
    fetchImpl: server.fetchImpl,
    decodeAudio,
    createContext: () => { const c = new FakeAudioContext(); contexts.push(c); return c; },
    RealtimeEngine: FakeEngine,
    renderOffline: async (plan, buffers, options) => {
      rendered.push({ plan, buffers, options });
      const frames = plan.output.totalFrames;
      const ch = [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(0.5)];
      return { audioBuffer: { getChannelData: (c) => ch[c] }, limiterStats: [] };
    },
    StretchFactory: () => null,
    modules: { limiterModuleUrl: '/assets/js/arrangement/limiter-worklet.js' },
    randomId: () => 'abc123',
    ...extra,
  });
  return { session, server, contexts, rendered };
}

const group = (title, bpm) => ({
  trackId: title, title, bpm, section: { startSec: 0, seconds: 30 },
  stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/${title}/audio?name=${role}&start=0&duration=30` })),
});

test('importGroup lands four stems on their lanes as ONE undo step and opens no audio device', async () => {
  const { session, contexts } = makeSession();
  await session.importGroup('A', group('Midnight', 96.8));
  await session.importGroup('B', group('Lanterns', 84.3));
  const s = session.state;
  assert.equal(s.clips.length, 8);
  assert.deepEqual(s.tracks.map((t) => t.name), ['A Vocals', 'A Drums', 'A Bass', 'A Other', 'B Vocals', 'B Drums', 'B Bass', 'B Other']);
  assert.equal(s.transport.masterBpm, 96.8, 'a fresh project takes the first track\'s measured tempo');
  assert.ok(s.clips.every((c) => c.customStretchRatio === 1), 'stems arrive at their own speed');
  assert.equal(session.edit.historyDepth.past, 2, 'one step per bank');
  assert.equal(contexts.length, 0, 'no AudioContext before Play');
  assert.ok(!JSON.stringify(s).includes('Float32Array') && Object.keys(session.buffers).length === 8);
  session.undo();
  assert.equal(session.state.clips.length, 4, 'undo removes the whole B bank at once');
  // Re-importing A replaces A's lanes inside the same single step.
  await session.importGroup('A', group('Midnight', 96.8));
  assert.equal(session.state.clips.filter((c) => c.trackIndex < 4).length, 4);
});

test('the decode budget refuses a stem set that would exceed the desk limit', async () => {
  const big = async () => ({ sampleRate: SR, numberOfChannels: 2, length: Math.ceil(DECODE_LIMITS.section.perStem / 8) + 1, getChannelData: () => new Float32Array(1) });
  const { session } = makeSession({ decodeAudio: big });
  await assert.rejects(session.importGroup('A', group('Huge', 100)), /per-stem limit/);
  assert.equal(session.state.clips.length, 0);
});

test('Play creates the one context and engine; edits reach it; Stop and Pause behave', async () => {
  const { session, contexts } = makeSession();
  await session.importGroup('A', group('Midnight', 96.8));
  session.seek(8);
  assert.equal(await session.play(), true);
  assert.equal(contexts.length, 1);
  const eng = FakeEngine.last;
  assert.deepEqual(eng.calls.find((c) => c[0] === 'play'), ['play', Math.round(8 * (60 / 96.8) * SR)]);
  session.apply({ name: 'setTrackMute', args: { trackIndex: 1, mute: true } });
  await session._sync;
  const replaced = eng.calls.filter((c) => c[0] === 'replacePlan').at(-1)[1];
  assert.equal(replaced.tracks[1].audible, false, 'the live engine receives the edited plan');
  session.setLoop(8, 16);
  await session._sync;
  assert.deepEqual(eng.loop, [Math.round(8 * (60 / 96.8) * SR), Math.round(16 * (60 / 96.8) * SR)]);
  session.stop();
  assert.equal(eng.phase, 'stopped');
  await session.play();
  assert.equal(contexts.length, 1, 'the same context is reused');
  await session.closeAudio();
  assert.equal(contexts[0].state, 'closed');
});

test('save then open restores the identical arrangement and decodes its references', async () => {
  const { session, server } = makeSession();
  await session.importGroup('A', group('Midnight', 96.8));
  session.apply({ name: 'moveClip', args: { clipId: session.state.clips[0].id, newTrackIndex: 0, newStartBeat: 16 } });
  session.apply({ name: 'setTrackEq', args: { trackIndex: 2, eq: { highGainDb: 4 } } });
  const { id } = await session.save('My song');
  assert.equal(id, 'my-song-abc123');
  assert.equal(session.dirty, false);
  const saved = session.edit.serialize();
  const second = makeSession();
  second.server.saved = server.saved;
  const reopen = new DawSession({ ...second.session.deps, fetchImpl: server.fetchImpl });
  await reopen.open(id);
  assert.equal(reopen.edit.serialize(), saved);
  assert.equal(Object.keys(reopen.buffers).length, 4);
  assert.equal(reopen.edit.canUndo, false, 'history starts fresh after opening (documented)');
  assert.equal(reopen.projectName, 'My song');
});

test('Export saves first, renders that saved state with a 0.5 s tail and encodes 24-bit WAV', async () => {
  const { session, server, rendered } = makeSession();
  await session.importGroup('A', group('Midnight', 96.8));
  const { wav, report, fileName } = await session.exportMix();
  assert.equal(rendered.length, 1);
  const savedProject = [...server.saved.values()][0].project;
  const { plan } = rendered[0];
  assert.deepEqual(compileRenderPlan(savedProject, { tailFrames: Math.round(EXPORT_TAIL_SEC * SR) }), plan, 'the bounce renders exactly the saved arrangement');
  const header = readWavHeader(wav);
  assert.equal(header.sampleRate, SR);
  assert.equal(header.channels, 2);
  assert.equal(header.bitsPerSample ?? header.bits, 24);
  assert.equal(report.frames, plan.output.totalFrames);
  assert.equal(fileName, 'untitled-arrangement.wav');
  assert.ok(Math.abs(report.peakDbfs - 20 * Math.log10(0.5)) < 1e-3);
});

test('export refuses an empty arrangement and one over the bounce clip budget', async () => {
  const { session } = makeSession();
  await assert.rejects(session.exportMix(), /nothing on the lanes/);
  await session.importGroup('A', group('Midnight', 96.8));
  const id = session.state.clips[0].id;
  for (let i = 0; i < 30; i += 1) session.apply({ name: 'duplicateClip', args: { clipId: id, startBeat: 40 + i * 8 } });
  await assert.rejects(session.exportMix(), /at most 32 clips/);
});

test('computePeaks reports min/max of the mono mix per bucket', () => {
  const l = new Float32Array(512); const r = new Float32Array(512);
  l[10] = 1; r[10] = 0.5; l[300] = -0.8; r[300] = -0.8;
  const p = computePeaks([l, r], 256);
  assert.equal(p.max.length, 2);
  assert.equal(p.max[0], 0.75);
  assert.ok(Math.abs(p.min[1] + 0.8) < 1e-6);
});
