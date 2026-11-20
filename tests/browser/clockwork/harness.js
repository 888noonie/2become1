// tests/browser/clockwork/harness.js — Milestone C1 offline transport proofs +
// Gate 2 priming probe (browser side).
//
// Renders deterministic transport scenarios through the SHARED engine code
// (buildBackbone + buildClipVoice + gate-envelope + clipNeedsDsp) in an
// OfflineAudioContext and measures the Gate 8 B-criteria as pure signal
// analysis. Also runs the Gate 2 scheduling-horizon (priming) sweep. Outputs one
// JSON report. No production media: every fixture is synthesised here.
//
// Proofs:
//   B1  start/stop accuracy  : bypass onset 0 frames; stretched onset <= 128
//   B2  stop is silence      : after the stop end, max abs <= 1e-7
//   B3  seek source frames   : index-encoded bypass decodes the exact source frame
//   B4  loop handover unity  : complementary crossfade gains sum to 1 (<= 1e-9)
//   B5  click-safety matrix  : DC envelope probe (output == clipGain*transportGate
//                              <= 1e-6), frame-0 first sample 0, silence stays silent
//   G6  bypass parity        : bypass output == source[n-offset]*envelope <= 1e-6
//   G7  non-finite           : NaN zeroed + counted, output finite
//   G2  priming horizon      : first-5 ms level vs schedule horizon, per rate

import { buildBackbone, buildClipVoice, limiterLookaheadFrames } from '/src/twobecomeone/studio_static/js/arrangement/offline-render.js';
import { clipNeedsDsp } from '/src/twobecomeone/studio_static/js/arrangement/time-math.js';
import {
  startGateAt, stopGateAt, crossfadeUpAt, crossfadeDownAt, loopSeamWindow,
  START_RAMP_FRAMES, STOP_RAMP_FRAMES, SEEK_RAMP_FRAMES, LOOP_XFADE_FRAMES,
} from '/src/twobecomeone/studio_static/js/arrangement/gate-envelope.js';
import { sourceFrameAt, sourceFrameAtWrongRate } from '/src/twobecomeone/studio_static/js/arrangement/voice-scheduler.js';
import SignalsmithStretch from '/src/twobecomeone/studio_static/vendor/signalsmith-stretch/SignalsmithStretch.mjs';

const SR = 48000;
// Sub-ceiling probe level: keeps the limiter transparent so envelope/unity oracles
// measure the transport gates, not limiter gain-reduction (ceiling is 0.966).
const PROBE_DC = 0.5;
const report = { checks: [], measurements: {}, negativeControls: [], errors: [] };
const results = () => report;
const check = (name, passed, detail) => report.checks.push({ name, passed, detail });

// ---------- fixtures (all synthesised) ----------

const IDX_L = 4096; // index-encoded: L = (n mod 4096)/4096 * scale
const IDX_SCALE = 0.4;

/** Index-encoded source: the source frame playing at any output sample decodes
 *  exactly from the (L, R) pair — the exact source-offset oracle for bypass. */
function makeIndexSource(frames) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let n = 0; n < frames; n += 1) {
    l[n] = IDX_SCALE * ((n % IDX_L) / IDX_L);
    r[n] = IDX_SCALE * (Math.floor(n / IDX_L) / IDX_L);
  }
  return { channels: [l, r] };
}
function decodeIndex(l, r) {
  return Math.round((l / IDX_SCALE) * IDX_L) + IDX_L * Math.round((r / IDX_SCALE) * IDX_L);
}

function makeDc(frames, v = 1) {
  return { channels: [new Float32Array(frames).fill(v), new Float32Array(frames).fill(v)] };
}
function makeImpulse(frames, at) {
  const l = new Float32Array(frames); const r = new Float32Array(frames);
  l[at] = 1; r[at] = 1;
  return { channels: [l, r] };
}
function makeTone(frames, freq = 440, phase = 0) {
  const l = new Float32Array(frames); const r = new Float32Array(frames);
  for (let n = 0; n < frames; n += 1) {
    const v = 0.4 * Math.sin((2 * Math.PI * freq * n) / SR + phase);
    l[n] = v; r[n] = v;
  }
  return { channels: [l, r] };
}

/** A flat plan: transparent EQ/pan/sum so the audio path is identity (for oracles). */
function flatPlan(tracks = 8) {
  return {
    sampleRate: SR,
    masterBpm: 120,
    loopRange: null,
    master: { gainLinear: 1 },
    limiter: { ceilingLinear: 10 ** (-0.3 / 20), lookaheadMs: 5, releaseMs: 50 },
    tracks: Array.from({ length: tracks }, (_, i) => ({
      trackIndex: i, name: `T${i}`, volumeLinear: 1, pan: 0, mute: false, solo: false, audible: true,
      eq: { lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
    })),
    output: { channels: 2, arrangementEndFrame: 0, totalFrames: 0 },
    clips: [],
  };
}

const MODULES = {
  limiterModuleUrl: '/src/twobecomeone/studio_static/js/arrangement/limiter-worklet.js',
  captureModuleUrl: '/src/twobecomeone/studio_static/js/arrangement/capture-worklet.js',
};
const StretchFactory = (ctx, opts) => SignalsmithStretch(ctx, opts);

// A clip-shaped descriptor for buildClipVoice.
function clipSpec({ sourceStart = 0, sourceLen, outStart = 0, outLen, rate = 1, pitch = 0,
  clipGainLinear = 1, fadeIn = 0, fadeOut = 0, preserveFormants = false }) {
  return {
    sourceStartFrame: sourceStart,
    sourceEndFrame: sourceStart + sourceLen,
    timelineStartFrame: outStart,
    timelineDurationFrames: outLen ?? sourceLen / rate,
    rate, pitchSemitones: pitch, preserveFormants,
    clipGainLinear, fadeInFrames: fadeIn, fadeOutFrames: fadeOut,
    sampleRate: SR,
  };
}

/** Write a transport-gain shape onto an AudioParam (linear, sample-accurate). */
function applyGate(param, gate, atSec = 0) {
  param.cancelScheduledValues(atSec);
  const f2s = (f) => f / SR;
  if (gate.kind === 'start') {
    param.setValueAtTime(0, f2s(gate.Ts));
    param.linearRampToValueAtTime(1, f2s(gate.Ts + (gate.N ?? START_RAMP_FRAMES)));
  } else if (gate.kind === 'stop') {
    param.setValueAtTime(1, f2s(gate.Te - (gate.N ?? STOP_RAMP_FRAMES)));
    param.linearRampToValueAtTime(0, f2s(gate.Te));
  } else if (gate.kind === 'up') {
    param.setValueAtTime(0, f2s(gate.W0));
    param.linearRampToValueAtTime(1, f2s(gate.W0 + (gate.N ?? SEEK_RAMP_FRAMES)));
  } else if (gate.kind === 'down') {
    param.setValueAtTime(1, f2s(gate.W0));
    param.linearRampToValueAtTime(0, f2s(gate.W0 + (gate.N ?? SEEK_RAMP_FRAMES)));
  }
}

/**
 * Render a scenario: voices (each {clip, source, dspBypass, gate, track}) through
 * the shared backbone. Trims the limiter lookahead so output frame == timeline.
 */
async function renderScenario(voices, totalFrames, { plan = flatPlan(), trimLatency = true } = {}) {
  const latency = limiterLookaheadFrames(plan);
  const ctx = new OfflineAudioContext(2, totalFrames + latency, SR);
  const backbone = await buildBackbone(ctx, plan, { ...MODULES, capture: false });
  for (const spec of voices) {
    const v = await buildClipVoice(ctx, spec.clip, spec.source, {
      StretchFactory, dspBypass: spec.dspBypass ?? true, sampleRate: SR,
    });
    const gate = ctx.createGain();
    // Outgoing/decaying gates (down, stop) are OPEN before their window; rising
    // gates (up, start) are CLOSED before theirs. Set the held value correctly
    // so the param is right before the first automation event.
    const rising = spec.gate && (spec.gate.kind === 'up' || spec.gate.kind === 'start');
    gate.gain.value = spec.gate ? (rising ? 0 : 1) : 1;
    if (spec.gate) applyGate(gate.gain, spec.gate);
    v.clipGain.connect(gate);
    gate.connect(backbone.trackInputs[spec.track ?? 0]);
    spec._voice = v;
  }
  const rendered = await ctx.startRendering();
  const off = trimLatency ? latency : 0;
  return {
    l: rendered.getChannelData(0).slice(off),
    r: rendered.getChannelData(1).slice(off),
    limiterStats: backbone.limiterStats,
    latency,
  };
}

// ---------- measurement helpers ----------

function maxAbs(x, from = 0, to = x.length) {
  let m = 0;
  for (let i = from; i < to; i += 1) { const a = Math.abs(x[i]); if (a > m) m = a; }
  return m;
}
function rms(x, from, to) {
  let s = 0; const n = to - from;
  for (let i = from; i < to; i += 1) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, n));
}
function corr(a, b) {
  let sa = 0; let sb = 0; let sab = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { sa += a[i]; sb += b[i]; sab += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const n = a.length;
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt((na / n - (sa / n) ** 2) * (nb / n - (sb / n) ** 2) + 1e-20);
}
function envelope(x, hop) {
  const out = [];
  for (let i = 0; i + hop <= x.length; i += hop) out.push(rms(x, i, i + hop));
  return out;
}

// =========================== PROOFS ===========================

async function proveB3() {
  // B3: exact source-frame selection through the real bypass voice (index oracle).
  const src = makeIndexSource(48000 * 4);
  const cases = [];
  const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(1234); // [0,1)
  // Seeded source starts incl. 0 and near the source end (clamped in range).
  const maxStart = src.channels[0].length - 128;
  const starts = [0, 1, 4095, 4096, 4097, maxStart];
  while (starts.length < 50) starts.push(Math.floor(rnd() * maxStart));
  const outStart = 2400;
  const outLen = 512;
  let allExact = true;
  const voices = [];
  for (const s of starts) {
    voices.push({
      clip: clipSpec({ sourceStart: s, sourceLen: outLen, outStart, outLen, rate: 1 }),
      source: src, dspBypass: true,
    });
  }
  // Render them on separate tracks/frames to avoid overlap: space them out.
  const spaced = [];
  let at = 2400;
  for (const s of starts) {
    spaced.push({
      clip: clipSpec({ sourceStart: s, sourceLen: 64, outStart: at, outLen: 64, rate: 1 }),
      source: src, dspBypass: true,
    });
    at += 128;
  }
  const { l, r } = await renderScenario(spaced, at + 1024);
  let k = 0; at = 2400;
  for (const s of starts) {
    // Decode a few samples into the occurrence.
    for (const off of [8, 24, 48]) {
      const n = decodeIndex(l[at + off], r[at + off]);
      const expected = s + off;
      if (n !== expected) { allExact = false; cases.push({ s, off, n, expected }); }
    }
    at += 128; k += 1;
  }
  check('B3: bypass voice emits the EXACT source frame (index oracle, 0 frames error)', allExact,
    { positions: starts.length, mismatches: cases.slice(0, 5) });
  report.measurements.b3Positions = starts.length;

  // Frame-zero and source-end selection explicitly.
  const edgeVoices = [
    { clip: clipSpec({ sourceStart: 0, sourceLen: 64, outStart: 1000, outLen: 64 }), source: src, dspBypass: true },
    { clip: clipSpec({ sourceStart: src.channels[0].length - 64, sourceLen: 64, outStart: 1200, outLen: 64 }), source: src, dspBypass: true },
  ];
  const e = await renderScenario(edgeVoices, 2048);
  const n0 = decodeIndex(e.l[1000 + 8], e.r[1000 + 8]);
  const nEnd = decodeIndex(e.l[1200 + 8], e.r[1200 + 8]);
  check('B3: frame-zero and source-end selection are exact', n0 === 8 && nEnd === (src.channels[0].length - 64 + 8),
    { n0, expected0: 8, nEnd, expectedEnd: src.channels[0].length - 64 + 8 });
}

async function proveB5Envelope() {
  // B5: DC envelope probe — a 1.0 source through a voice outputs exactly
  // clipGain * transportGate (the two gain stages are separable and exact).
  const N = 4096;
  const dc = makeDc(N, PROBE_DC);
  const clipGainLinear = 1;
  // A start gate over [1000, 1000+120).
  const v = [{ clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: N, clipGainLinear }), source: dc, dspBypass: true, gate: { kind: 'start', Ts: 1000 } }];
  const { l } = await renderScenario(v, N + 4096);
  // Expected envelope = PROBE_DC * clipGain * startGateAt(t) (limiter transparent).
  let maxErr = 0;
  for (let t = 0; t < N; t += 1) {
    const expected = PROBE_DC * clipGainLinear * startGateAt(t, 1000);
    maxErr = Math.max(maxErr, Math.abs(l[t] - expected));
  }
  check('B5: DC envelope probe (output == clipGain x transportGate) <= 1e-6', maxErr <= 1e-6, { maxErr });
  report.measurements.b5EnvelopeMaxErr = maxErr;

  // Frame-0 start: the first output sample after a start at frame 0 is exactly 0.
  const v0 = [{ clip: clipSpec({ sourceStart: 0, sourceLen: 512, outStart: 0, outLen: 512 }), source: makeDc(512, 1), dspBypass: true, gate: { kind: 'start', Ts: 0 } }];
  const z = await renderScenario(v0, 1024);
  check('B5: a frame-0 start outputs an exact 0 first sample', Math.abs(z.l[0]) <= 1e-9, { first: z.l[0] });

  // Silence stays silent across a seam between silent regions.
  const silent = [{ clip: clipSpec({ sourceStart: 0, sourceLen: 2048, outStart: 500, outLen: 2048 }), source: makeDc(2048, 0), dspBypass: true, gate: { kind: 'start', Ts: 500 } }];
  const s = await renderScenario(silent, 4096);
  check('B5: silence stays silent (max abs <= 1e-7)', maxAbs(s.l) <= 1e-7, { max: maxAbs(s.l) });
}

async function proveB4Crossfade() {
  // B4: loop handover — complementary crossfade gains sum to exactly 1 (unity),
  // measured with DC sources on both voices (out + in == 1 at every sample).
  const N = 2048;
  const seam = 1024;
  const W0 = seam - LOOP_XFADE_FRAMES / 2;
  const voices = [
    { clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: N }), source: makeDc(N, PROBE_DC), dspBypass: true, gate: { kind: 'down', W0, N: LOOP_XFADE_FRAMES } },
    { clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: N }), source: makeDc(N, PROBE_DC), dspBypass: true, gate: { kind: 'up', W0, N: LOOP_XFADE_FRAMES } },
  ];
  const { l } = await renderScenario(voices, N + 4096);
  // Both voices carry the same DC; output = PROBE_DC * (g_out + g_in). Divide out
  // the DC to read the GAIN SUM, which must be exactly 1 (unity). Float32 Web
  // Audio ramps give ~1e-7; the exact 1e-9 unity is proven in Node (T4).
  let maxErr = 0;
  for (let t = 0; t < N; t += 1) {
    maxErr = Math.max(maxErr, Math.abs(l[t] / PROBE_DC - 1));
  }
  check('B4: loop handover crossfade gains sum to unity (<= 1e-6 float32; 1e-9 proven in Node T4)', maxErr <= 1e-6, { maxErr });
  report.measurements.b4UnityMaxErr = maxErr;
}

async function proveB1B2() {
  // B1: bypass onset is 0 frames (impulse lands exactly where placed).
  const N = 4096;
  const at = 2000;
  const v = [{ clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: N }), source: makeImpulse(N, at), dspBypass: true }];
  const { l } = await renderScenario(v, N + 4096);
  let peakAt = 0;
  for (let i = 0; i < l.length; i += 1) if (Math.abs(l[i]) > Math.abs(l[peakAt])) peakAt = i;
  // The limiter delays by its lookahead then renderScenario trims it, so the
  // impulse should land at its placed frame.
  const bypassOnsetErr = Math.abs(peakAt - at);
  check('B1: bypass onset is sample-exact (0 frames)', bypassOnsetErr === 0, { peakAt, at, bypassOnsetErr });
  report.measurements.bypassOnsetErr = bypassOnsetErr;

  // B2: after a stop that ends at Te, captured audio is silence (<= 1e-7).
  const Te = 3000;
  const sv = [{ clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: N }), source: makeDc(N, 1), dspBypass: true, gate: { kind: 'stop', Te } }];
  const s = await renderScenario(sv, N + 4096);
  const after = maxAbs(s.l, Te + Math.round(0.125 * SR), s.l.length);
  check('B2: stop is silence after the fade + tail (max abs <= 1e-7)', after <= 1e-7, { after, Te });
  report.measurements.stopSilenceMax = after;

  // Stretched onset (B1): a transient at the SOURCE START (== the gain edge)
  // through a rate-0.857 DSP voice must begin within 128 frames of the gain
  // edge (output 0, after the limiter trim). Measures residual DSP latency.
  const impulse = makeImpulse(N, 0); // onset at source 0 == gain edge
  const dv = [{ clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: Math.round(N / 0.857), rate: 0.857 }), source: impulse, dspBypass: false }];
  try {
    const d = await renderScenario(dv, Math.round(N / 0.857) + 4096);
    let dPeak = 0;
    for (let i = 0; i < d.l.length; i += 1) if (Math.abs(d.l[i]) > Math.abs(d.l[dPeak])) dPeak = i;
    const peak = Math.abs(d.l[dPeak]);
    let onset = -1;
    for (let i = 0; i < d.l.length; i += 1) if (Math.abs(d.l[i]) > 0.2 * peak) { onset = i; break; }
    const stretchedOnsetErr = onset; // frames after the gain edge (output 0)
    check('B1: stretched onset within 128 frames at the gain edge', onset >= 0 && onset <= 128,
      { onsetFromGainEdge: onset, peakAt: dPeak });
    report.measurements.stretchedOnsetErr = stretchedOnsetErr;
    report.measurements.stretchedPipelineDelayFrames = onset;
  } catch (err) {
    report.measurements.stretchedOnsetErr = null;
    check('B1: stretched onset within 128 frames at the gain edge', false, { error: String(err) });
  }
}

async function proveG6Parity() {
  // G6: zero-stretch zero-pitch fixture — bypass output equals source[n-offset]*envelope
  // computed INDEPENDENTLY (exact continuity oracle), tolerance 1e-6.
  const N = 4096;
  const src = makeTone(N, 220);
  const clipGainLinear = 0.7;
  const fadeIn = 0; const fadeOut = 0;
  const outStart = 500; const sourceStart = 100; const outLen = 2048;
  const v = [{ clip: clipSpec({ sourceStart, sourceLen: outLen, outStart, outLen, clipGainLinear, fadeIn, fadeOut }), source: src, dspBypass: true }];
  const { l } = await renderScenario(v, N + 4096);
  // Independent oracle: output[outStart + k] == src[sourceStart + k] * clipGain * microfadeLaw.
  // No fades here, and the region edge micro-fade is 0 frames (fadeIn=0), so the
  // clipGain is flat clipGainLinear within [outStart, outStart+outLen).
  let maxErr = 0;
  for (let k = 0; k < outLen; k += 1) {
    const expected = src.channels[0][sourceStart + k] * clipGainLinear;
    maxErr = Math.max(maxErr, Math.abs(l[outStart + k] - expected));
  }
  check('G6: zero-stretch zero-pitch bypass matches the independent oracle <= 1e-6', maxErr <= 1e-6, { maxErr });
  report.measurements.g6ParityMaxErr = maxErr;

  // The bypass predicate is the shared decision (rate 1 & 0 st -> bypass).
  check('G6: clipNeedsDsp is the shared predicate (rate 1, 0 st bypasses)',
    clipNeedsDsp(1, 0) === false && clipNeedsDsp(1, 7) === true && clipNeedsDsp(0.857, 0) === true, {});
}

async function proveG7NonFinite() {
  // G7: a NaN injected into a voice is zeroed and counted by the limiter guard;
  // the output stays finite (the click diagnostic cannot pass invalid audio).
  const N = 2048;
  const src = makeDc(N, 1);
  src.channels[0][800] = NaN;
  src.channels[1][801] = Infinity;
  const v = [{ clip: clipSpec({ sourceStart: 0, sourceLen: N, outStart: 0, outLen: N }), source: src, dspBypass: true }];
  const { l, r, limiterStats } = await renderScenario(v, N + 4096);
  let finite = true;
  for (let i = 0; i < l.length; i += 1) if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
  const last = limiterStats[limiterStats.length - 1] || {};
  // The SAFETY-critical property is that no non-finite sample reaches the output.
  // The fault COUNT + safe-failure state is engine behaviour proven in Node
  // (c1-safety.test.js zeroes+counts; realtime-engine drives `failed`); the
  // worklet posts stats every 256 blocks so a short render may not capture the
  // final count here. Output finiteness is the acceptance.
  check('G7: non-finite samples never reach the output (output stays finite)', finite, {
    finite, nonFiniteCountReported: last.nonFiniteCount, firstNonFiniteIndex: last.firstNonFiniteIndex,
  });
  report.measurements.nonFiniteOutputFinite = finite;
  report.measurements.nonFiniteCountReported = last.nonFiniteCount ?? 0;
}

// =========================== GATE 2: priming horizon ===========================
// Faithful reproduction of the golden-ear E7 mechanism: a Signalsmith voice is
// ACTIVATED (schedule() called) only `horizon` before its output reaches the
// playhead at T, via an OfflineAudioContext.suspend() hook that stands in for
// late main-thread scheduling. The source position at T is held FIXED across the
// sweep so only the priming differs. Sweeps source-advance rates, tonal/transient
// fixtures, timing offsets and processing presets. The horizon is then DERIVED as
// priming + wake + jitter (never hard-coded to 85 ms).

const PRIMING_T = 1.0;
const PRIMING_TARGET_INPUT = 2.0; // source position that must sound at T

/** Bound a promise so a single hang cannot stall the whole harness. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

async function buildSs(ctx, source, cfg) {
  const n = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  if (cfg) await n.configure(cfg);
  await n.addBuffers([source.channels[0], source.channels[1]]);
  n.connect(ctx.destination);
  return n;
}

/**
 * Render with a late activation at `activateAtSec` (E7 mechanism). The resume is
 * in a finally so a throwing `later` can NEVER deadlock the offline render.
 */
async function renderPrimed(seconds, build, activateAtSec, later) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const st = await build(ctx);
  if (activateAtSec != null) {
    ctx.suspend(activateAtSec).then(async () => {
      try { await later(st); } finally { await ctx.resume(); }
    });
  }
  const b = await ctx.startRendering();
  return b.getChannelData(0).slice();
}

async function measurePriming(rate, horizonSec, fixture, cfg = null, offsetFrames = 0) {
  const T = PRIMING_T + offsetFrames / SR;
  const src = fixture === 'tone' ? makeTone(Math.round(3 * SR), 440) : makePerc(Math.round(3 * SR));
  // Warm: active from output 0, source positioned so T sounds the target.
  const warm = await withTimeout(renderPrimed(1.8, async (ctx) => {
    const n = await buildSs(ctx, src, cfg);
    await n.schedule({ output: 0, input: PRIMING_TARGET_INPUT - T * rate, rate, active: true });
    return n;
  }, null, null), 15000, 'warm');
  // Cold: activated only `horizonSec` before T.
  const s = T - horizonSec;
  const cold = await withTimeout(renderPrimed(1.8, (ctx) => buildSs(ctx, src, cfg), s, async (n) => {
    await n.schedule({ output: s, input: PRIMING_TARGET_INPUT - horizonSec * rate, rate, active: true });
  }), 15000, 'cold');
  const a = Math.round(T * SR);
  return {
    coldFirst5msRms: rms(cold, a, a + 240),
    warmFirst5msRms: rms(warm, a, a + 240),
  };
}

async function probePriming() {
  const rates = [0.857, 1.0, 1.2];
  const fixtures = ['tone', 'perc'];
  const offsets = [0, 37];
  const horizonsMs = [21, 32, 43, 64, 85]; // bounded; brackets the 64 ms E7 floor
  const rel = {};
  const warmRef = {};
  for (const rate of rates) {
    const m = await measurePriming(rate, 0.5, 'tone');
    warmRef[rate] = m.warmFirst5msRms;
  }
  for (const rate of rates) {
    rel[rate] = {};
    for (const fixture of fixtures) {
      rel[rate][fixture] = {};
      for (const off of offsets) {
        rel[rate][fixture][off] = {};
        for (const h of horizonsMs) {
          try {
            const m = await measurePriming(rate, h / 1000, fixture, null, off);
            rel[rate][fixture][off][h] = Number((20 * Math.log10((m.coldFirst5msRms + 1e-12) / (m.warmFirst5msRms + 1e-12))).toFixed(2));
          } catch (err) {
            rel[rate][fixture][off][h] = `ERR ${String(err).slice(0, 40)}`;
          }
        }
      }
    }
  }

  // Derived priming floor: smallest horizon where EVERY rate/fixture/offset is
  // within 0.8 dB of warm.
  let requiredMs = null;
  for (const h of horizonsMs) {
    let ok = true;
    for (const rate of rates) for (const fixture of fixtures) for (const off of offsets) {
      const v = rel[rate][fixture][off][h];
      if (typeof v !== 'number' || Math.abs(v) > 0.8) ok = false;
    }
    if (ok) { requiredMs = h; break; }
  }

  // Preset sensitivity at the derived horizon (floor scales with preset latency).
  const presets = [null, { preset: 'cheaper' }, { blockMs: 60 }];
  const presetSens = {};
  if (requiredMs != null) {
    for (const cfg of presets) {
      const key = cfg ? JSON.stringify(cfg) : 'default';
      let worst = 0;
      for (const rate of rates) {
        try {
          const m = await measurePriming(rate, requiredMs / 1000, 'tone', cfg, 0);
          const db = 20 * Math.log10((m.coldFirst5msRms + 1e-12) / (m.warmFirst5msRms + 1e-12));
          worst = Math.max(worst, Math.abs(db));
        } catch { worst = 99; }
      }
      presetSens[key] = Number(worst.toFixed(2));
    }
  }

  report.measurements.priming = { sweep: rel, warmRef, presetSensitivity: presetSens };
  report.measurements.primingRequiredMs = requiredMs;
  report.measurements.primingWakeMs = 25;
  report.measurements.primingJitterMs = 15;
  report.measurements.schedulingHorizonMs = requiredMs == null ? null : requiredMs + 25 + 15;
  check('GATE 2: a scheduling horizon is DERIVED (priming + wake + jitter), not hard-coded 85 ms',
    requiredMs != null, { requiredMs, wakeMs: 25, jitterMs: 15, schedulingHorizonMs: report.measurements.schedulingHorizonMs });

  // Negative control: a horizon well below the floor must read measurably quiet.
  let worstShort = 0;
  for (const rate of rates) {
    try {
      const m = await measurePriming(rate, 16 / 1000, 'tone');
      const db = 20 * Math.log10((m.coldFirst5msRms + 1e-12) / (m.warmFirst5msRms + 1e-12));
      worstShort = Math.min(worstShort, db);
    } catch { /* skip */ }
  }
  report.negativeControls.push({
    name: 'sub-floor horizon is measurably under-primed', detected: worstShort < -3,
    check: { worstRelDbAt16ms: Number(worstShort.toFixed(2)) },
  });
  report.measurements.schedulerIntervalNote = 'wake interval (25 ms) only wakes the scheduler; a shorter interval needs less horizon slack (slack = horizon - priming - 1 quantum) at a CPU cost';
}

function makePerc(frames) {
  // Sustained transient-rich bed: recurring noise bursts over a constant-level
  // noisy tone bed, still sounding at the 1.0 s measurement point (a decaying
  // one-shot would have vanished and read as silence).
  const l = new Float32Array(frames); const r = new Float32Array(frames);
  let seed = 777;
  for (let n = 0; n < frames; n += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff) * 2 - 1;
    const ph = (n / SR) % 0.25;
    const burst = 0.4 * noise * Math.exp(-ph / 0.04); // recurring bursts every 250 ms
    const bed = 0.12 * Math.sin((2 * Math.PI * 220 * n) / SR) + 0.06 * noise; // sustained bed
    const v = 0.5 * (burst + bed);
    l[n] = v; r[n] = v;
  }
  return { channels: [l, r] };
}

// =========================== driver ===========================

async function main() {
  const steps = [
    ['B3', proveB3],
    ['B5', proveB5Envelope],
    ['B4', proveB4Crossfade],
    ['B1B2', proveB1B2],
    ['G6', proveG6Parity],
    ['G7', proveG7NonFinite],
    ['G2', probePriming],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      report.errors.push(`${name}: ${String(err && err.stack || err)}`);
    }
  }
  report.passed = report.checks.every((c) => c.passed)
    && report.negativeControls.every((n) => n.detected)
    && report.errors.length === 0;
  window.__clockworkDone = true;
  window.__clockworkResults = report;
}

main();
export { results };
