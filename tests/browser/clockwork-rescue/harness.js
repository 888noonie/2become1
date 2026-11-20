// tests/browser/clockwork-rescue/harness.js — browser side of run.mjs.
//
// Drives the ACTUAL RealtimeEngine with real worklets. In "offline" mode the
// device clock is an OfflineAudioContext advanced by suspend() wakes every
// 1024 frames (21.3 ms, about one scheduler wake); every wake runs
// engine.tick() and waits for its builds, exactly as a live wake would, and the
// rendered PCM is then analysed. All material is synthesised (fixtures.js).

import { RealtimeEngine } from '/src/twobecomeone/studio_static/js/realtime-engine.js';
import { buildArrangementGraph, renderOffline } from '/src/twobecomeone/studio_static/js/arrangement/offline-render.js';
import SignalsmithStretch from '/src/twobecomeone/studio_static/vendor/signalsmith-stretch/SignalsmithStretch.mjs';
import * as fx from '/tools/clockwork-audition/fixtures.js';
import { EditEngine } from '/src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '/src/twobecomeone/studio_static/js/arrangement/render-plan.js';

const SR = 48000;
const mode = new URLSearchParams(location.search).get('mode') ?? 'offline';
const report = { mode, checks: [], measurements: {}, negativeControls: [], errors: [] };
const check = (name, passed, detail) => report.checks.push({ name, passed: !!passed, detail });
const MODULES = { limiterModuleUrl: '/src/twobecomeone/studio_static/js/arrangement/limiter-worklet.js' };
const LEGACY_URL = '/src/twobecomeone/studio_static/js/realtime-engine.legacy-c1.tmp.js';
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };

function flatPlan(clips, { tracks = 8, loopRange = null } = {}) {
  const end = clips.reduce((m, c) => Math.max(m, c.timelineEndFrame), 0);
  return {
    sampleRate: SR, masterBpm: 120, loopRange,
    master: { gainLinear: 1 },
    limiter: { ceilingLinear: 10 ** (-0.3 / 20), lookaheadMs: 5, releaseMs: 50 },
    tracks: Array.from({ length: tracks }, (_, i) => ({
      trackIndex: i, name: `T${i}`, volumeLinear: 1, pan: 0, mute: false, solo: false, audible: true,
      eq: { lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
    })),
    output: { channels: 2, arrangementEndFrame: end, totalFrames: end },
    clips,
  };
}

function clip({ id, track = 0, start = 0, length, rate = 1, ref }) {
  return {
    clipId: id, assetId: ref, trackIndex: track, bufferReference: ref,
    timelineStartFrame: start, timelineEndFrame: start + length, timelineDurationFrames: length,
    sourceStartFrame: 0, sourceEndFrame: Math.round(length * rate),
    rate, pitchSemitones: 0, preserveFormants: false, clipGainLinear: 1, fadeInFrames: 0, fadeOutFrames: 0,
  };
}

/** Goertzel magnitude of frequency f over x[a, b). Amplitude-normalised. */
function tone(x, a, b, f) {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let n = a; n < b; n += 1) { const s = x[n] + c * s1 - s2; s2 = s1; s1 = s; }
  const re = s1 - s2 * Math.cos(w); const im = s2 * Math.sin(w);
  return (2 * Math.sqrt(re * re + im * im)) / (b - a);
}
const db = (v, ref) => 20 * Math.log10(Math.max(v, 1e-12) / ref);

/**
 * Render the engine on an OfflineAudioContext. `actions` = [{ at: sec, run(engine) }]
 * applied on the first wake at or after `at` (at 0: before rendering).
 */
async function renderEngine({ engineUrl = null, plan, buffers, seconds, actions = [], options = {} }) {
  const Engine = engineUrl ? (await import(engineUrl)).RealtimeEngine : RealtimeEngine;
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const builds = [];
  const StretchFactory = async (c, o) => {
    const t = performance.now();
    const node = await SignalsmithStretch(c, o);
    builds.push(performance.now() - t);
    return node;
  };
  const engine = new Engine(ctx, plan, buffers, {
    ...MODULES, StretchFactory, timers: noTimers, watchContextState: false, ...options,
  });
  await engine.prepare();
  const pending = [...actions].sort((x, y) => x.at - y.at);
  const states = [];
  const runDue = async (t) => {
    while (pending.length && pending[0].at <= t + 1e-9) {
      const a = pending.shift();
      a.run(engine, ctx);
    }
    await engine.tick();
    if (engine.settle) await engine.settle();
    states.push([ctx.currentTime, engine.state().phase]);
  };
  await runDue(0);
  const step = 1024 / SR;
  for (let t = step; t < seconds - step; t += step) {
    const at = Math.round(t * SR / 128) * 128 / SR;
    ctx.suspend(at).then(async () => {
      try { await runDue(ctx.currentTime); } catch (err) { report.errors.push(`wake @${at}: ${err.message}`); }
      ctx.resume();
    });
  }
  const rendered = await ctx.startRendering();
  const diag = engine.diagnostics ? engine.diagnostics() : null;
  const final = engine.state();
  return { out: rendered.getChannelData(0), engine, diag, final, states, builds };
}

const latency = 240; // limiter lookahead (5 ms)

// ------------------------------------------------------------------ offline

async function seekScenario(engineUrl, rate) {
  const seconds = 3.0;
  const src = fx.twoTone(9 * rate + 1, 4 * rate); // 300 Hz before source 4 s (at this rate), 900 Hz after
  const plan = flatPlan([clip({ id: 'tone', ref: 'tone', length: 8 * SR, rate })]);
  let seekAt = null;
  const r = await renderEngine({
    engineUrl, plan, buffers: { tone: src }, seconds,
    actions: [
      { at: 0, run: (e) => e.play(0) },
      { at: 1.0, run: (e, c) => { seekAt = c.currentTime; e.seek(5 * SR); } },
    ],
  });
  const origin = seekAt + 0.104;
  const o = Math.round(origin * SR) + latency;
  const ref = tone(r.out, o - 0.25 * SR, o - 0.05 * SR, 300);
  const win = (t0, t1, f) => tone(r.out, o + Math.round(t0 * SR), o + Math.round(t1 * SR), f);
  return {
    seekAt, origin,
    oldBeforeHandoverDb: db(tone(r.out, o - 0.02 * SR, o - 0.002 * SR, 300), ref),
    oldAfter10msDb: db(win(0.010, 0.110, 300), ref),
    oldAfter4sDb: seconds - origin > 1.2 ? db(win(1.0, 1.4, 300), ref) : null,
    newAfter10msDb: db(win(0.010, 0.110, 900), ref),
    oldLateDb: db(win(1.2, 1.6, 300), ref),
    final: r.final.phase,
    fault: r.final.fault?.code ?? null,
    nanCount: r.out.reduce((k, v) => k + (Number.isFinite(v) ? 0 : 1), 0),
    envAroundOrigin: Array.from({ length: 30 }, (_, i) => {
      const a0 = o - Math.round(0.1 * SR) + i * 240; let e = 0;
      for (let n = a0; n < a0 + 240; n += 1) e += r.out[n] ** 2;
      return +(Math.sqrt(e / 240)).toFixed(4);
    }),
    outLength: r.out.length,
    events: r.diag?.events ? r.diag.events.map((e) => `${e.type}@${e.at.toFixed(3)}${e.code ? `:${e.code}` : ''}`).slice(-12) : null,
    diag: r.diag?.timing ? { dsp: r.diag.timing.suppliedDspLeadMs, misses: r.diag.deadlineMisses } : null,
  };
}

async function stopScenario(engineUrl) {
  const seconds = 2.2;
  const plan = flatPlan([
    clip({ id: 'pad', ref: 'pad', length: 6 * SR }),
    clip({ id: 'arp', track: 1, ref: 'arp', length: 6 * SR, rate: 1.2 }),
  ]);
  let stopAt = null;
  const r = await renderEngine({
    engineUrl, plan, buffers: { pad: fx.pad(7), arp: fx.arp(8) }, seconds,
    actions: [
      { at: 0, run: (e) => e.play(0) },
      { at: 1.0, run: (e, c) => { stopAt = c.currentTime; e.stop(); } },
    ],
  });
  const quiet = Math.round((stopAt + 480 / SR) * SR) + latency + 128;
  let maxAfter = 0;
  for (let n = quiet; n < r.out.length; n += 1) maxAfter = Math.max(maxAfter, Math.abs(r.out[n]));
  let maxBefore = 0;
  for (let n = Math.round(0.5 * SR); n < Math.round(stopAt * SR); n += 1) maxBefore = Math.max(maxBefore, Math.abs(r.out[n]));
  return {
    stopAt, maxBefore, maxAfter, final: r.final.phase, isPlaying: r.final.isPlaying,
    connected: r.diag ? r.diag.connectedProcessors : null,
    poolLive: r.diag ? r.diag.pool.live : null,
    dspLead: r.diag?.timing ? r.diag.timing.suppliedDspLeadMs : null,
  };
}

async function loopScenario(requested = Math.round(1.5 * SR)) {
  // Loop [1 s, 2 s) from 1.5 s (inside the loop; a start outside it enters at 1 s): phase-continuous pad + beat-periodic drums, so
  // the ideal looped output is known sample-for-sample.
  const seconds = 4.6;
  const plan = flatPlan([
    clip({ id: 'pad', ref: 'pad', length: 6 * SR }),
    clip({ id: 'drums', track: 1, ref: 'drums', length: 6 * SR }),
  ]);
  const padSrc = fx.pad(6.5); const drumSrc = fx.drums(6.5);
  const r = await renderEngine({
    plan, buffers: { pad: padSrc, drums: drumSrc }, seconds,
    actions: [{ at: 0, run: (e) => { e.setLoop([SR, 2 * SR]); e.play(requested); } }],
  });
  const origin = 0.104;
  const o = Math.round(origin * SR);
  const a = SR; const b = 2 * SR; const start = requested >= SR && requested < 2 * SR ? requested : SR; // outside the loop enters at a
  const ideal = (d) => {
    const f = d < b - start ? start + d : a + ((d - (b - start)) % (b - a));
    return padSrc.channels[0][f] + drumSrc.channels[0][f];
  };
  const seams = [];
  for (let p = 0; p < 4; p += 1) seams.push((b - start) + p * (b - a));
  let maxSeamErr = 0; let maxInteriorErr = 0;
  for (let d = 2000; d < Math.round((seconds - 0.2) * SR) - o; d += 1) {
    const err = Math.abs(r.out[o + d + latency] - ideal(d));
    const nearSeam = seams.some((s) => Math.abs(d - s) <= 120);
    if (nearSeam) maxSeamErr = Math.max(maxSeamErr, err); else maxInteriorErr = Math.max(maxInteriorErr, err);
  }
  // Each pass's beat transient lands on its exact frame.
  // Each pass's beat transient lands on the frame the ideal looped signal has it.
  const peakAt = (get) => { let best = 0; let at = 0; for (let k = -200; k <= 200; k += 1) { const v = Math.abs(get(k)); if (v > best) { best = v; at = k; } } return at; };
  const onsetErr = seams.map((s) => peakAt((k) => r.out[o + s + k + latency]) - peakAt((k) => ideal(s + k)));
  return {
    maxSeamErr, maxInteriorErr, onsetErr, final: r.final.phase, misses: r.diag.deadlineMisses,
    fault: r.final.fault, events: r.diag.events.map((e) => `${e.type}@${e.at.toFixed(3)}${e.code ? `:${e.code}` : ''}${e.message ? `:${e.message}` : ''}`).slice(-10),
  };
}

async function nonFiniteScenario() {
  const src = fx.pad(3);
  src.channels[0][Math.round(1.0 * SR)] = NaN;
  const plan = flatPlan([clip({ id: 'pad', ref: 'pad', length: 2 * SR })]);
  const r = await renderEngine({ plan, buffers: { pad: src }, seconds: 1.6, actions: [{ at: 0, run: (e) => e.play(0) }] });
  let finite = true;
  for (const v of r.out) if (!Number.isFinite(v)) { finite = false; break; }
  return { final: r.final.phase, fault: r.final.fault?.code ?? null, finite, connected: r.diag.connectedProcessors };
}

async function offline() {
  for (const rate of [1, 1.2]) {
    const s = await seekScenario(null, rate);
    report.measurements[`seek_rate${rate}`] = s;
    check(`N1 seek (rate ${rate}): old audio preserved until the handover (>= -1 dB)`, s.oldBeforeHandoverDb > -1, s);
    check(`N1 seek (rate ${rate}): old audio <= -60 dB from 10 ms after the handover`, s.oldAfter10msDb < -60, s);
    check(`N1 seek (rate ${rate}): old audio still <= -60 dB 1.2-1.6 s later`, s.oldLateDb < -60, s);
    check(`N1 seek (rate ${rate}): new material within 1 dB from 10 ms after the handover`, Math.abs(s.newAfter10msDb) < 1, s);
  }
  const legacySeek = await seekScenario(LEGACY_URL, 1);
  report.negativeControls.push({ name: 'legacy C1 seek leaves old audio playing', detected: legacySeek.oldLateDb > -6, legacySeek });
  check('negative control: legacy C1 seek keeps the old tone audible (detected)', legacySeek.oldLateDb > -6, legacySeek);

  const st = await stopScenario(null);
  report.measurements.stop = st;
  check('N2 stop: output <= 1e-6 after the 10 ms fade + limiter', st.maxBefore > 0.01 && st.maxAfter <= 1e-6, st);
  check('N2 stop: engine reaches stopped, isPlaying false, processors and slots at baseline',
    st.final === 'stopped' && st.isPlaying === false && st.connected === 0 && st.poolLive === 0, st);
  check('N4: every Signalsmith voice was armed with >= the 64 ms measured priming lead', st.dspLead && st.dspLead.min >= 64, st.dspLead);
  const legacyStop = await stopScenario(LEGACY_URL);
  report.negativeControls.push({ name: 'legacy C1 stop never completes', detected: legacyStop.final !== 'stopped', legacyStop });
  check('negative control: legacy C1 stop stays in "stopping" (detected)', legacyStop.final !== 'stopped', legacyStop);

  const lp = await loopScenario();
  report.measurements.loop = lp;
  check('N6 loop: interior samples equal the ideal looped signal (<= 1e-5)', lp.maxInteriorErr <= 1e-5, lp);
  check('N6 loop: seam windows equal the ideal (complementary handover, <= 1e-4)', lp.maxSeamErr <= 1e-4, lp);
  check('N6 loop: each pass transient lands on its exact frame (0 frames)', lp.onsetErr.every((e) => e === 0), lp);
  check('N6 loop: no deadline miss, still playing', lp.misses === 0 && lp.final === 'playing', lp);
  // THE BROKEN RECORD (PM verdict on 1fb993f): Play from OUTSIDE the loop (the
  // page's 6 s) must play the loop, not run on to the arrangement end.
  const lpOut = await loopScenario(Math.round(5 * SR));
  report.measurements.loopFromOutside = lpOut;
  check('BROKEN RECORD loop from outside (5 s): output equals the ideal loop from its start (<= 1e-5 interior, 1e-4 seams)', lpOut.maxInteriorErr <= 1e-5 && lpOut.maxSeamErr <= 1e-4, lpOut);
  check('BROKEN RECORD loop from outside: transients exact, still playing after 4 passes, no miss', lpOut.onsetErr.every((e) => e === 0) && lpOut.final === 'playing' && lpOut.misses === 0, lpOut);

  const nf = await nonFiniteScenario();
  report.measurements.nonFinite = nf;
  check('non-finite: engine FAILED with NON_FINITE, output finite, processors released',
    nf.final === 'failed' && nf.fault === 'NON_FINITE' && nf.finite && nf.connected === 0, nf);
}

// ------------------------------------------------------------------ routing

async function routing() {
  // One rate-1 clip through the two routes the hosts use today.
  const seconds = 2;
  const plan = flatPlan([clip({ id: 'pad', ref: 'pad', length: seconds * SR })]);
  plan.output.totalFrames = seconds * SR + 4096;
  const buffers = { pad: fx.pad(seconds + 0.2), drums: fx.drums(seconds + 0.2) };
  const opts = { ...MODULES, StretchFactory: (c, o) => SignalsmithStretch(c, o) };
  const results = {};
  for (const [name, ref] of [['pad', 'pad'], ['drums', 'drums']]) {
    const p = flatPlan([clip({ id: name, ref, length: seconds * SR })]);
    p.output.totalFrames = seconds * SR + 4096;
    const stretch = (await renderOffline(p, buffers, { ...opts, dspBypass: false })).audioBuffer.getChannelData(0);
    const stretchAgain = (await renderOffline(p, buffers, { ...opts })).audioBuffer.getChannelData(0);
    const bypass = (await renderOffline(p, buffers, { ...opts, dspBypass: true })).audioBuffer.getChannelData(0);
    let identical = true;
    for (let n = 0; n < stretch.length; n += 1) if (stretch[n] !== stretchAgain[n]) { identical = false; break; }
    // Best alignment within +-2048 frames, then residual and 10 ms envelope correlation.
    const N = seconds * SR - 4096;
    let best = { lag: 0, err: Infinity };
    for (let lag = -2048; lag <= 2048; lag += 1) {
      let e = 0; let s = 0;
      for (let n = 4096; n < N; n += 7) { const d = stretch[n + lag] - bypass[n]; e += d * d; s += bypass[n] * bypass[n]; }
      const rel = Math.sqrt(e / s);
      if (rel < best.err) best = { lag, err: rel };
    }
    const env = (x, lag) => { const o = []; for (let n = 4096; n + 480 < N; n += 480) { let s = 0; for (let k = 0; k < 480; k += 1) s += x[n + lag + k] ** 2; o.push(Math.sqrt(s / 480)); } return o; };
    const ea = env(stretch, best.lag); const eb = env(bypass, 0);
    const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
    const ma = mean(ea); const mb = mean(eb);
    let num = 0; let da = 0; let dbb = 0;
    for (let i = 0; i < ea.length; i += 1) { num += (ea[i] - ma) * (eb[i] - mb); da += (ea[i] - ma) ** 2; dbb += (eb[i] - mb) ** 2; }
    results[name] = {
      offlineDefaultIsStretchPath: identical,
      bestLagFrames: best.lag,
      residualRelRms: best.err,
      envelopeCorrelation: num / Math.sqrt(da * dbb),
      rmsRatioDb: 20 * Math.log10(ma / mb),
    };
  }
  // The accepted bounce is unchanged: the same eight-clip plan (rates 1, 1.2,
  // 0.857, a pitch shift, fades, gains) rendered through the C1 offline-render
  // (ec74085) and the repaired one must be bit-identical.
  const legacyOffline = await import('/src/twobecomeone/studio_static/js/arrangement/offline-render.legacy-c1.tmp.js');
  const mix = flatPlan(Array.from({ length: 8 }, (_, i) => {
    const c = clip({ id: `m${i}`, track: i, ref: ['pad', 'drums'][i % 2], length: 2 * SR, rate: [1, 1.2, 0.857, 1][i % 4] });
    c.sourceEndFrame = Math.round(2 * SR * c.rate);
    if (i === 3) c.pitchSemitones = 3;
    c.fadeInFrames = 240 * (i % 3); c.fadeOutFrames = 480; c.clipGainLinear = 0.5 + i * 0.05;
    return c;
  }));
  mix.output.totalFrames = 2 * SR + 4096;
  const big = { pad: fx.pad(3), drums: fx.drums(3) };
  const now = (await renderOffline(mix, big, opts)).audioBuffer;
  const was = (await legacyOffline.renderOffline(mix, big, opts)).audioBuffer;
  let diffs = 0; let maxAbs = 0;
  for (let c = 0; c < 2; c += 1) {
    const x = now.getChannelData(c); const y = was.getChannelData(c);
    for (let n = 0; n < x.length; n += 1) if (x[n] !== y[n]) { diffs += 1; maxAbs = Math.max(maxAbs, Math.abs(x[n] - y[n])); }
  }
  const cmp = (A, B) => {
    let d = 0; let m = 0;
    for (let c = 0; c < 2; c += 1) {
      const x = A.getChannelData(c); const y = B.getChannelData(c);
      for (let n = 0; n < x.length; n += 1) if (x[n] !== y[n]) { d += 1; m = Math.max(m, Math.abs(x[n] - y[n])); }
    }
    return { differingSamples: d, maxAbsDiff: m };
  };
  const now2 = (await renderOffline(mix, big, opts)).audioBuffer;
  const was2 = (await legacyOffline.renderOffline(mix, big, opts)).audioBuffer;
  results.bounceRepeatability = { newVsNew: cmp(now, now2), legacyVsLegacy: cmp(was, was2), newVsLegacyRepeat: cmp(now2, was2) };
  let peak = 0; for (const v of now.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
  results.bounceRegression = { frames: now.length, differingSamples: diffs, maxAbsDiff: maxAbs, peak };
  // Chromium's offline render of this plan is NOT bit-repeatable even for the
  // C1 code itself (measured: tens of thousands of 1-ULP differences between two
  // C1 renders), so bit-identity is not a valid oracle. The repaired bounce must
  // differ from C1 by no more than C1 differs from itself.
  const selfVar = Math.max(results.bounceRepeatability.legacyVsLegacy.maxAbsDiff, results.bounceRepeatability.newVsNew.maxAbsDiff);
  check('routing: the offline bounce is unchanged vs C1 ec74085 within C1\'s own run-to-run variation (<= 1 float32 ULP)',
    maxAbs <= Math.max(selfVar, 6e-8) && maxAbs <= 1.2e-7 && peak > 0.01, { ...results.bounceRegression, selfVariation: selfVar });
  report.measurements.routing = results;
  check('routing: the accepted offline bounce still routes rate-1 clips through Signalsmith (unchanged)',
    results.pad.offlineDefaultIsStretchPath && results.drums.offlineDefaultIsStretchPath, results);
  check('routing: divergence is measured (recorded, not a pass/fail of equality)', true, results);
}

// ------------------------------------------------------------------ live

async function live() {
  const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
  await ctx.resume();
  report.measurements.context = { state: ctx.state, baseLatencyMs: ctx.baseLatency * 1000, outputLatencyMs: ctx.outputLatency * 1000 };
  const set = new URLSearchParams(location.search).get('set') ?? 'worst';
  let plan; let buffers;
  if (set === 'audition') {
    // The owner audition arrangement itself (ProjectState -> compileRenderPlan).
    const proj = fx.auditionProject(EditEngine);
    plan = compileRenderPlan(proj.engine.state);
    buffers = proj.buffers;
  } else {
    const clips = Array.from({ length: 8 }, (_, i) => clip({ id: `c${i}`, track: i, ref: i % 2 ? 'arp' : 'pad', length: 6 * SR, rate: i % 2 ? 1.2 : 1 }));
    // Every track a Signalsmith voice for the worst case: rates 0.857 / 1.2.
    for (const [i, c] of clips.entries()) { c.rate = i % 2 ? 1.2 : 0.857; c.sourceEndFrame = Math.round(6 * SR * c.rate); }
    plan = flatPlan(clips);
    buffers = { pad: fx.pad(8), arp: fx.arp(8) };
  }
  report.measurements.set = set;
  const builds = [];
  const StretchFactory = async (c, o) => {
    const t = performance.now();
    const node = await SignalsmithStretch(c, o);
    builds.push(performance.now() - t);
    return node;
  };
  const wakes = [];
  const timers = {
    setTimeout: (fn, ms) => { const t = performance.now(); return setTimeout(() => { wakes.push(performance.now() - t - ms); fn(); }, ms); },
    clearTimeout: (id) => clearTimeout(id),
  };
  const silent = ctx.createGain();
  silent.gain.value = 0; // belt and braces on top of --disable-audio-output / --mute-audio
  silent.connect(ctx.destination);
  const engine = new RealtimeEngine(ctx, plan, buffers, { ...MODULES, StretchFactory, timers, destination: silent });
  await engine.prepare();
  const phases = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  engine.play(0);
  await sleep(1000); phases.push(engine.state().phase);
  engine.seek(3 * SR);
  await sleep(600); phases.push(engine.state().phase);
  engine.setLoop([3 * SR, 4 * SR]);
  await sleep(1500); phases.push(engine.state().phase);
  engine.stop();
  await sleep(400); phases.push(engine.state().phase);
  const d = engine.diagnostics();
  wakes.sort((x, y) => x - y);
  const q = (p) => wakes[Math.min(wakes.length - 1, Math.floor(p * wakes.length))];
  report.measurements.live = {
    phases,
    suppliedDspLeadMs: d.timing.suppliedDspLeadMs,
    deadlineMisses: d.deadlineMisses,
    lateVoices: d.lateVoices,
    buildMs: { count: builds.length, min: Math.min(...builds), max: Math.max(...builds), mean: builds.reduce((a, b) => a + b, 0) / builds.length },
    wakeLatenessMs: { count: wakes.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: wakes.at(-1) },
    stretchWarmupMs: d.stretchWarmupMs,
    startDelaysMs: d.startDelaysMs,
    clockCatchUpMaxMs: d.clockCatchUpMaxMs,
    lateVoices: d.lateVoices,
    armCosts: d.armCosts,
    armBatches: d.armBatches,
    peakConnectedProcessors: d.peakConnectedProcessors,
    connectedAfterStop: d.connectedProcessors,
    poolLiveAfterStop: d.pool.live,
    capacity: d.capacity,
  };
  check('live: Play -> playing, Seek -> playing, loop -> playing, Stop -> stopped', phases.join() === 'playing,playing,playing,stopped', phases);
  check('live: every Signalsmith arm received >= 64 ms lead, no deadline miss', d.deadlineMisses === 0 && d.timing.suppliedDspLeadMs.min >= 64, report.measurements.live);
  check('live: processors and slots return to baseline after Stop', d.connectedProcessors === 0 && d.pool.live === 0, report.measurements.live);
  engine.dispose();
  await ctx.close();
}

try {
  if (mode === 'offline') await offline();
  else if (mode === 'routing') await routing();
  else if (mode === 'live') await live();
  else throw new Error(`unknown mode ${mode}`);
} catch (err) {
  report.errors.push(`${err.name}: ${err.message}\n${err.stack}`);
}
window.__report = report;
window.__done = true;
