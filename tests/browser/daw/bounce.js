// tests/browser/daw/bounce.js — GATE 3/4/5/7 harness, browser side.
//
// Builds an original eight-stem arrangement through the real EditEngine,
// compiles the shared render plan, bounces it offline through the shared DSP
// path, measures it (GATE 4), runs four audio-level negative controls, and
// performs the minimal real-time AudioWorklet proof (GATE 5).
//
// All musical parts are synthesised here deterministically (original, no
// licensing question) plus the repo's own synthesised loop fixtures.

import { EditEngine } from '/src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '/src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { renderOffline, startRealtime } from '/src/twobecomeone/studio_static/js/arrangement/offline-render.js';
import { encodeWav24 } from '/src/twobecomeone/studio_static/js/arrangement/wav.js';
import { BDI_THRESHOLD, boundaryDiscontinuity, boundaryGate } from '/src/twobecomeone/studio_static/js/arrangement/click-guard.js';
import SignalsmithStretch from '/src/twobecomeone/studio_static/vendor/signalsmith-stretch/SignalsmithStretch.mjs';
import { SR, BPM, beat, buildStems } from './synth.js';
import { applyHarnessArrangement } from './arrangement-script.js';

const results = { measurements: {}, checks: [], negativeControls: [], gate5: {}, clickEvidence: {}, errors: [] };
const post = (path, body) => fetch(path, { method: 'POST', body });

async function loadFixture(path) {
  const bytes = await (await fetch(path)).arrayBuffer();
  const ctx = new AudioContext({ sampleRate: SR });
  const decoded = await ctx.decodeAudioData(bytes);
  await ctx.close();
  return Array.from({ length: 2 }, (_, c) => {
    const src = decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1));
    return Float32Array.from(src);
  });
}

// ---------- measurement helpers ----------

const peakOf = (x) => x.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
const rmsOf = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

function onsetSample(x, th = 0.02, from = 0) {
  for (let i = from; i < x.length; i += 1) {
    if (Math.abs(x[i]) > th) {
      let s = 0;
      for (let j = i; j < Math.min(i + 64, x.length); j += 1) if (Math.abs(x[j]) > th) s += 1;
      if (s > 32) return i;
    }
  }
  return -1;
}

function offsetSample(x, th = 0.02) {
  for (let i = x.length - 1; i >= 0; i -= 1) {
    if (Math.abs(x[i]) > th) return i;
  }
  return -1;
}

function zeroCrossFreq(x, start, seconds = 0.5) {
  const end = Math.min(x.length, start + Math.round(seconds * SR));
  let c = 0;
  for (let i = Math.max(1, start); i < end; i += 1) if (x[i - 1] <= 0 && x[i] > 0) c += 1;
  return c / ((end - Math.max(1, start)) / SR);
}

/** f0 estimate by Goertzel grid scan (harmonic material, not pure tones). */
function f0Estimate(x, start, length = 8192) {
  let best = { freq: NaN, amp: -1 };
  for (let f = 150; f <= 500; f += 5) {
    const a = goertzel(x, start, length, f);
    if (a > best.amp) best = { freq: f, amp: a };
  }
  return best.freq;
}

/** Smoothed-parabolic F1 estimate (the S6 method; sub-harmonic resolution). */
function f1Parabolic(x, start, length, f0) {
  const amps = [];
  for (let k = 1; k * f0 < 3400; k += 1) amps.push(goertzel(x, start, length, k * f0));
  const logA = amps.map((a) => Math.log(Math.max(1e-12, a)));
  const smooth = logA.map((v, i) => {
    let s = 0;
    let n = 0;
    for (let j = i - 2; j <= i + 2; j += 1) {
      if (j >= 0 && j < logA.length) { s += logA[j]; n += 1; }
    }
    return s / n;
  });
  let best = -1;
  for (let i = 0; i < smooth.length; i += 1) {
    const f = (i + 1) * f0;
    if (f < 400 || f > 1200) continue;
    if (best < 0 || smooth[i] > smooth[best]) best = i;
  }
  if (best < 1 || best >= smooth.length - 1) return NaN;
  const [a, b, c] = [smooth[best - 1], smooth[best], smooth[best + 1]];
  const denom = a - 2 * b + c;
  let delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  // Clamp to half a harmonic step: with few in-band harmonics the parabola
  // can run away, which is an estimator artefact, not a formant movement.
  delta = Math.max(-0.5, Math.min(0.5, delta));
  return (best + 1 + delta) * f0;
}

function goertzel(x, start, length, freq) {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i += 1) {
    const s0 = x[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / length;
}

function envelopePeakHz(x, start, length, f0, band) {
  let best = { freq: NaN, amp: -1 };
  for (let k = 1; k * f0 < 3400; k += 1) {
    const f = k * f0;
    if (f < band[0] || f > band[1]) continue;
    const a = goertzel(x, start, length, f);
    if (a > best.amp) best = { freq: f, amp: a };
  }
  return best.freq;
}

function maxSlope(x, around, radius = Math.round(0.005 * SR)) {
  let m = 0;
  for (let i = Math.max(1, around - radius); i < Math.min(x.length, around + radius); i += 1) {
    m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  }
  return m;
}

function envelopeLagMs(ref, test, searchMs = 500) {
  // Coarse envelope cross-correlation: 1 ms RMS envelopes, ±searchMs.
  const hop = Math.round(0.001 * SR);
  const env = (x) => {
    const out = [];
    for (let i = 0; i + hop <= x.length; i += hop) {
      let s = 0;
      for (let j = i; j < i + hop; j += 1) s += x[j] * x[j];
      out.push(Math.sqrt(s / hop));
    }
    return out;
  };
  const a = env(ref);
  const b = env(test);
  const search = searchMs;
  let best = { lagMs: 0, score: -Infinity };
  for (let lag = -search; lag <= search; lag += 1) {
    let score = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      score += a[i] * b[j];
      n += 1;
    }
    if (n > 100 && score / n > best.score) best = { lagMs: lag, score: score / n };
  }
  return best.lagMs;
}

function check(name, passed, detail) {
  results.checks.push({ name, passed, detail });
}

// ---------- arrangement construction (the real edit API) ----------

function buildArrangement(stems, fixtureChords, fixturePerc, fixtureSide) {
  const engine = new EditEngine({ project: { ...makeProjectState(), transport: { ...makeProjectState().transport, masterBpm: BPM } } });
  // ONE arrangement script, shared with the node regression tests.
  const channelsByName = {
    'drums': stems.drums,
    'bass': stems.bass,
    'chords-100bpm': fixtureChords,
    'lead-vowel': stems.lead,
    'pad': stems.pad,
    'arp': stems.arp,
    'perc-140bpm': fixturePerc,
    'side-texture': fixtureSide,
  };
  const sizes = Object.fromEntries(
    Object.entries(channelsByName).map(([name, ch]) => [name, ch[0].length / SR]),
  );
  const { ids } = applyHarnessArrangement(engine, {
    drumsSec: sizes['drums'], bassSec: sizes['bass'], chordsSec: sizes['chords-100bpm'],
    leadSec: sizes['lead-vowel'], padSec: sizes['pad'], arpSec: sizes['arp'],
    percSec: sizes['perc-140bpm'], sideSec: sizes['side-texture'],
  });
  // bufferReference per clip (split children share their asset's reference).
  const refs = {};
  for (const { clipId } of Object.values(ids)) {
    const clip = engine.state.clips.find((c) => c.id === clipId);
    const name = engine.state.assets[clip.assetId].name;
    refs[clipId] = { bufferReference: `synth:${name}`, channels: channelsByName[name] };
  }
  return { engine, refs, ids };
}

function makeProjectState() {
  // A default project (120 BPM / 48 kHz) via the engine's own factory.
  return new EditEngine().state;
}

// ---------- main ----------

async function main() {
  const stems = buildStems();
  const fixtureChords = await loadFixture('/tests/fixtures/c_major_100.wav');
  const fixturePerc = await loadFixture('/tests/fixtures/a_minor_140.wav');
  const fixtureSide = await loadFixture('/tests/fixtures/side_tone.wav');

  const { engine, refs, ids } = buildArrangement(stems, fixtureChords, fixturePerc, fixtureSide);
  results.measurements.stateClips = engine.state.clips.length;

  const tailFrames = Math.round(0.3 * SR);

  // ---- optional defective mode (?breakFades=1) ----
  // Strips every fade from EVERY compiled plan (main, solo, variant and
  // negative-control renders) so the ordinary acceptance gates run against a
  // representative broken-fade implementation and genuinely FAIL it (the
  // harness then exits nonzero). Demonstration mode only.
  const breakFades = new URLSearchParams(location.search).has('breakFades');
  results.measurements.breakFadesMode = breakFades;
  const compilePlan = (state, opts) => {
    const p = compileRenderPlan(state, opts);
    if (breakFades) {
      for (const c of p.clips) { c.fadeInFrames = 0; c.fadeOutFrames = 0; }
    }
    return p;
  };

  const plan = compilePlan(engine.state, { tailFrames });
  results.measurements.planClips = plan.clips.length;
  results.measurements.limiterLatencyFrames = 240;

  // ---- duration truthfulness (Grok C2) ----
  // The arrangement end is recomputed here from raw state with plain
  // arithmetic (independent of the plan compiler) and must agree with the
  // plan and, below, with the exported WAV's frame count. The end is a
  // MUSICAL fact — the 140 BPM texture's beat-synced extent (18.6667 beats =
  // 9.3333 s at the 120 master) — and is never trimmed to match prose.
  const spbSec = 60 / engine.state.transport.masterBpm;
  let independentEndFrame = 0;
  for (const clip of engine.state.clips) {
    independentEndFrame = Math.max(independentEndFrame,
      Math.round((clip.timelineStartBeat + clip.durationBeats) * spbSec * SR));
  }
  results.measurements.independentEndFrame = independentEndFrame;
  results.measurements.arrangementEndSec = plan.output.arrangementEndFrame / SR;
  check('plan end equals the independently computed arrangement end',
    plan.output.arrangementEndFrame === independentEndFrame,
    { planEnd: plan.output.arrangementEndFrame, independentEndFrame });
  check('plan total = arrangement end + documented tail (limiter lookahead is trimmed inside renderOffline)',
    plan.output.totalFrames === plan.output.arrangementEndFrame + tailFrames,
    { totalFrames: plan.output.totalFrames, arrangementEndFrame: plan.output.arrangementEndFrame, tailFrames });

  const buffers = {};
  for (const rec of Object.values(refs)) buffers[rec.bufferReference] = { channels: rec.channels };

  const stretchFactory = (ctx, opts) => SignalsmithStretch(ctx, opts);
  const baseOptions = {
    StretchFactory: stretchFactory,
    limiterModuleUrl: '/src/twobecomeone/studio_static/js/arrangement/limiter-worklet.js',
    captureModuleUrl: '/src/twobecomeone/studio_static/js/arrangement/capture-worklet.js',
  };

  // ---- GATE 3: the full bounce ----
  const { audioBuffer, limiterStats, wallMs } = await renderOffline(plan, buffers, baseOptions);
  const L = audioBuffer.getChannelData(0);
  const R = audioBuffer.getChannelData(1);
  results.measurements.renderWallMs = Math.round(wallMs);
  results.measurements.audioSeconds = audioBuffer.duration;
  results.measurements.outputFrames = audioBuffer.length;
  results.measurements.sampleRate = audioBuffer.sampleRate;

  // ---- GATE 4: measurements ----
  const peak = Math.max(peakOf(L), peakOf(R));
  results.measurements.samplePeak = peak;
  results.measurements.ceiling = plan.limiter.ceilingLinear;
  check('limiter sample-peak ceiling (-0.3 dBFS)', peak <= plan.limiter.ceilingLinear + 1e-4, { peak });

  // Intersample peaks: linear interpolation cannot exceed neighbouring
  // samples, so no oversampled measurement is claimed here at all (Sol
  // IMPROVE). The ceiling claim is sample-peak only.
  results.measurements.truePeakClaimed = false;
  results.measurements.intersampleAssessment =
    'no oversampled true-peak measurement was performed; true-peak protection is NOT claimed';

  const gr = limiterStats.length ? limiterStats[limiterStats.length - 1].maxReductionDb : 0;
  results.measurements.limiterMaxReductionDb = gr;
  check('limiter engaged measurably', gr < -0.5, { maxReductionDb: gr });

  // Stereo integrity: fixture stems are mono-centred; panned tracks must show
  // directional imbalance in their solo renders (checked below).
  let lrDiff = 0;
  for (let i = 0; i < L.length; i += 1) lrDiff = Math.max(lrDiff, Math.abs(L[i] - R[i]));
  results.measurements.maxChannelDifference = lrDiff;
  check('stereo channel integrity (channels differ where panned)', lrDiff > 1e-4, { lrDiff });

  // ---- solo renders: contribution + per-track measurement ----
  // Each solo render builds ONE stretch instance (clipFilter), not nine.
  const soloRenders = [];
  const soloOf = (trackIndex) => renderOffline(
    compilePlan(withOnlyTrack(engine.state, trackIndex), { tailFrames: Math.round(0.3 * SR) }),
    buffers,
    { ...baseOptions, clipFilter: (c) => c.trackIndex === trackIndex },
  );
  for (let trackIndex = 0; trackIndex < 8; trackIndex += 1) {
    const { audioBuffer: soloBuf } = await soloOf(trackIndex);
    soloRenders.push(soloBuf.getChannelData(0));
    await new Promise((r) => setTimeout(r, 60));
  }
  const contributions = soloRenders.map((x) => rmsOf(x));
  results.measurements.trackRms = contributions;
  check('eight contributing stems (every track audible)', contributions.every((r) => r > 1e-4), contributions);

  // Presence in the FULL mix (Sol B12): the un-limited master is the sum of
  // the solo renders, so removing track i from that sum must degrade its
  // agreement with the real (limited) master for every i.
  const sumAll = new Float32Array(L.length);
  for (const s of soloRenders) {
    for (let i = 0; i < sumAll.length; i += 1) sumAll[i] += s[i] ?? 0;
  }
  const env10 = (x) => {
    const out = [];
    const hop = 480;
    for (let i = 0; i + hop < x.length; i += hop) {
      let s = 0;
      for (let j = i; j < i + hop; j += 1) s += x[j] ** 2;
      out.push(Math.sqrt(s / hop));
    }
    return out;
  };
  const corr = (a, b) => {
    const n = Math.min(a.length, b.length);
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let c = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i += 1) {
      c += (a[i] - ma) * (b[i] - mb);
      va += (a[i] - ma) ** 2;
      vb += (b[i] - mb) ** 2;
    }
    return c / Math.sqrt(Math.max(1e-12, va * vb));
  };
  const envFull = env10(L);
  const envSum = env10(sumAll);
  const corrAll = corr(envFull, envSum);
  const presenceMargins = [];
  for (let t = 0; t < 8; t += 1) {
    const without = new Float32Array(L.length);
    for (let i = 0; i < without.length; i += 1) {
      without[i] = sumAll[i] - (soloRenders[t][i] ?? 0);
    }
    const corrWithout = corr(envFull, env10(without));
    presenceMargins.push(corrAll - corrWithout);
  }
  results.measurements.mixPresenceMargins = presenceMargins;
  check('every track measurably shapes the full mix (leave-one-out of the sum)',
    presenceMargins.every((m) => m > 0), presenceMargins);

  // Solo law through the STATE (Sol B12): a render whose plan says "solo
  // track 0" (no clipFilter) must equal the physically filtered solo render.
  const stateSoloPlan = compilePlan(withOnlyTrack(engine.state, 0), { tailFrames: Math.round(0.3 * SR) });
  const { audioBuffer: stateSoloBuf } = await renderOffline(stateSoloPlan, buffers, baseOptions);
  const stateSolo = stateSoloBuf.getChannelData(0);
  let soloDiff = 0;
  let soloEnergy = 0;
  for (let i = 0; i < stateSolo.length; i += 1) {
    soloDiff += (stateSolo[i] - (soloRenders[0][i] ?? 0)) ** 2;
    soloEnergy += stateSolo[i] ** 2;
  }
  const soloLawDiff = Math.sqrt(soloDiff / Math.max(1e-9, soloEnergy));
  results.measurements.soloLawDiff = soloLawDiff;
  check('mute/solo law enforced by the graph itself (state solo == filtered solo)',
    soloLawDiff < 0.05, { soloLawDiff });

  // Mute/Solo behaviour: a solo render contains ONLY that track.
  const solo0Ratio = rmsOf(soloRenders[0]) / Math.max(1e-9, rmsOf(L));
  results.measurements.soloIsolationRatio = solo0Ratio;
  check('solo isolation (solo render is quieter than the full mix)', solo0Ratio < 0.9, { solo0Ratio });

  // Effective stretch ratio on the chords clip (100 BPM -> 120 master).
  const chordPlan = compilePlan(withOnlyTrack(engine.state, 2), { tailFrames: Math.round(0.3 * SR) });
  const chordClip = chordPlan.clips.find((c) => c.trackIndex === 2);
  const chordOnset = onsetSample(soloRenders[2], 0.01);
  let chordOffset = soloRenders[2].length - 1;
  while (chordOffset > 0 && Math.abs(soloRenders[2][chordOffset]) < 0.005) chordOffset -= 1;
  const measuredOutSec = (chordOffset - chordOnset) / SR;
  const sourceSliceSec = chordClip.sourceSpanFrames / SR;
  results.measurements.stretch = {
    rate: chordClip.rate,
    expectedOutputMultiplier: chordClip.outputDurationMultiplier,
    sourceSliceSec,
    measuredOutputSec: measuredOutSec,
    measuredMultiplier: measuredOutSec / sourceSliceSec,
  };
  check('effective stretch ratio (100 BPM source at 120 master)',
    Math.abs(measuredOutSec / sourceSliceSec - 1 / chordClip.rate) < 0.08,
    results.measurements.stretch);

  // Pitch ratio on the lead (+7 formant-preserved) vs a pitch-0 variant.
  const noPitchState = cloneStateWithoutPitch(engine.state, ids.lead.clipId);
  const noPitchPlan = compilePlan(noPitchState, { tailFrames: Math.round(0.3 * SR) });
  const { audioBuffer: noPitchBuf } = await renderOffline(noPitchPlan, buffers,
    { ...baseOptions, clipFilter: (c) => c.trackIndex === 3 });
  const leadStart = Math.round(8 * beat * SR) + 2400;
  const fShifted = f0Estimate(soloRenders[3], leadStart);
  const fBase = f0Estimate(noPitchBuf.getChannelData(0), leadStart);
  results.measurements.pitch = {
    semitones: 7,
    baseFreqHz: fBase,
    shiftedFreqHz: fShifted,
    measuredRatio: fShifted / fBase,
    expectedRatio: 2 ** (7 / 12),
  };
  check('pitch frequency ratio (+7 independent of duration)',
    Math.abs(fShifted / fBase - 2 ** (7 / 12)) < 0.03, results.measurements.pitch);

  const leadOnset = onsetSample(soloRenders[3], 0.01);
  const leadOnsetBase = onsetSample(noPitchBuf.getChannelData(0), 0.01);
  results.measurements.pitchDurationUnchanged = { leadOnset, leadOnsetBase };
  // Duration claim needs the END as well as the start (Sol B10).
  const leadOffset = offsetSample(soloRenders[3], 0.01);
  const leadOffsetBase = offsetSample(noPitchBuf.getChannelData(0), 0.01);
  results.measurements.pitchDurationUnchanged.leadOffset = leadOffset;
  results.measurements.pitchDurationUnchanged.leadOffsetBase = leadOffsetBase;
  check('pitch without duration change (onsets and offsets agree)',
    Math.abs(leadOnset - leadOnsetBase) < 0.03 * SR
      && Math.abs(leadOffset - leadOffsetBase) < 0.03 * SR,
    results.measurements.pitchDurationUnchanged);

  // Formant behaviour on the vocal-like lead (constant-vowel segment), using
  // the smoothed-parabolic method from spike S6 (sub-harmonic resolution).
  const noCompState = cloneStateWithoutFormants(engine.state, ids.lead.clipId);
  const noCompPlan = compilePlan(noCompState, { tailFrames: Math.round(0.3 * SR) });
  const { audioBuffer: noCompBuf } = await renderOffline(noCompPlan, buffers,
    { ...baseOptions, clipFilter: (c) => c.trackIndex === 3 });
  const winStart = leadStart;
  const winLen = 8192;
  const f1Base = f1Parabolic(noPitchBuf.getChannelData(0), winStart, winLen, fBase);
  const f1Shifted = f1Parabolic(soloRenders[3], winStart, winLen, fShifted);
  const f1NoComp = f1Parabolic(noCompBuf.getChannelData(0), winStart, winLen, fShifted);
  results.measurements.formants = {
    f1Base, f1Shifted, f1NoComp,
    compensatedDeltaHz: Math.abs(f1Shifted - f1Base),
    uncompensatedDeltaHz: Math.abs(f1NoComp - f1Base),
    method: 'smoothed-parabolic harmonic envelope (S6 method)',
  };
  check('formant envelope held under +7 (preserveFormants strictly nearer than uncompensated)',
    Math.abs(f1Shifted - f1Base) < Math.abs(f1NoComp - f1Base),
    results.measurements.formants);

  // Clip placement: the lead was moved to beat 8. Absolute pipeline delay is
  // bounded tightly (stretch residual + the micro-fade threshold crossing),
  // and RELATIVE placement (shifted vs unshifted variant, which share one
  // schedule) must be near-exact (Sol B10).
  const expectedLeadFrame = Math.round(8 * beat * SR);
  const pipelineDelay = leadOnset - expectedLeadFrame;
  results.measurements.clipPlacement = {
    leadOnset,
    expectedLeadFrame,
    pipelineDelayFrames: pipelineDelay,
    relativePlacementErrorFrames: leadOnset - leadOnsetBase,
  };
  check('sample-accurate clip placement (bounded pipeline delay + exact relative placement)',
    pipelineDelay >= 0 && pipelineDelay <= 480 && Math.abs(leadOnset - leadOnsetBase) <= 60,
    results.measurements.clipPlacement);

  // ---- clip boundary discontinuities (BDI gate — Grok C1) ----
  // Every region edge is scored on its own track's solo render with the
  // boundary-local detector. The old global slope gate is kept as evidence
  // only: it conflates musical transients with clicks (a hi-hat burst's own
  // sample slope raises the threshold until a gross hard cut passes).
  const splitFrame = Math.round(8 * beat * SR);
  const cutFrame = Math.round(18.001515 * beat * SR); // the sine-peak trim cut
  results.measurements.clicks = {
    legacySlopes: {
      clickSplit: maxSlope(soloRenders[0], splitFrame + 99),
      clickCut: maxSlope(soloRenders[3], cutFrame + 99, Math.round(0.01 * SR)),
      steadyReference: maxSlope(soloRenders[0], Math.round(2 * SR)),
      note: 'legacy global gate (slope < 4x steady) recorded for continuity; it is NOT the acceptance gate',
    },
  };
  const edgeBoundaries = [];
  for (const clip of plan.clips) {
    // A region is half-open [start, end); a missing fade steps exactly at its
    // gain automation, which is sample-accurate at these frames. A region
    // starting at frame 0 has no before-context and is skipped.
    if (clip.timelineStartFrame > 0) {
      edgeBoundaries.push({ clipId: clip.clipId, trackIndex: clip.trackIndex, edge: 'start', frame: clip.timelineStartFrame });
    }
    edgeBoundaries.push({ clipId: clip.clipId, trackIndex: clip.trackIndex, edge: 'end', frame: clip.timelineEndFrame });
  }
  const edgeEntries = edgeBoundaries.map((e) => ({
    ...e, ...boundaryDiscontinuity(soloRenders[e.trackIndex], e.frame),
  }));
  const edgeGate = boundaryGate(edgeEntries);
  results.measurements.boundaryGate = {
    threshold: BDI_THRESHOLD,
    worstIndex: edgeGate.worstIndex,
    worstBoundary: edgeGate.worstBoundary,
    boundaries: edgeEntries.map((e) => ({
      clipId: e.clipId, edge: e.edge, frame: e.boundary,
      index: Number(e.index.toFixed(3)),
      envStep: Number(e.envelope.step.toFixed(5)),
      envRoughness: Number(e.envelope.roughness.toFixed(5)),
      waveBreak: Number(e.waveform.junctionBreak.toFixed(5)),
    })),
  };
  check('no click at any clip boundary (BDI gate over every region edge)', edgeGate.passed,
    results.measurements.boundaryGate);

  // Saved signals for independent re-audit: ±14 ms mono windows around the
  // representative boundaries (4-decimal sample values). The excerpt is wider
  // than the detector's own ±13.4 ms context, so rescoring these bytes in
  // isolation reproduces the in-run index exactly.
  const windowOf = (x, at, ms = 14) => Array.from(
    x.slice(Math.max(0, at - Math.round(ms * 0.001 * SR)), at + Math.round(ms * 0.001 * SR)),
    (v) => Number(v.toFixed(4)),
  );
  const leadEndFrame = edgeBoundaries.find((e) => e.clipId === ids.lead.clipId && e.edge === 'end').frame;
  const leadStartFrame = edgeBoundaries.find((e) => e.clipId === ids.lead.clipId && e.edge === 'start').frame;
  results.clickEvidence.note = '±14 ms mono windows around key region edges (4-decimal sample values), wider than the detector context so they rescore to the in-run indices. Gain automation is sample-accurate, so a missing fade steps exactly at `frame`.';
  results.clickEvidence.clean = {
    leadCutFrame: leadEndFrame,
    leadCutWindow: windowOf(soloRenders[3], leadEndFrame),
    leadStartFrame,
    leadStartWindow: windowOf(soloRenders[3], leadStartFrame),
    drumsSplitFrame: splitFrame,
    drumsSplitWindow: windowOf(soloRenders[0], splitFrame),
  };

  // Musical fades on the pad: the 2-beat fade-out runs beats 14..16 = 7..8 s.
  const padA = rmsOf(soloRenders[4].slice(Math.round(6.4 * SR), Math.round(6.7 * SR)));
  const padB = rmsOf(soloRenders[4].slice(Math.round(7.55 * SR), Math.round(7.75 * SR)));
  results.measurements.fades = { padBefore: padA, padDuringFade: padB };
  check('audible musical fades (RMS falls across the pad fade-out)', padB < padA * 0.8, results.measurements.fades);

  // Silence outside clip regions (drums gap beats 7..8 = 3.5..4.0 s on the
  // solo render; the full mix legitimately sounds there).
  const gapFrom = Math.round((3.5 + 0.05) * SR);
  const gapTo = Math.round((4.0 - 0.05) * SR);
  const gapSeg = L.slice(gapFrom, gapTo);
  results.measurements.drumsGapRms = rmsOf(gapSeg);
  const drumsGap = rmsOf(soloRenders[0].slice(gapFrom, gapTo));
  results.measurements.drumsGapRmsSolo = drumsGap;
  check('silence outside clip regions (drums trim gap)', drumsGap < 1e-4, { drumsGap });

  // DSP tail: ring-out after the last region (arrangement end).
  const arrEnd = plan.output.arrangementEndFrame;
  const tailSeg = L.slice(arrEnd, Math.min(L.length, arrEnd + Math.round(0.3 * SR)));
  results.measurements.tailRmsAfterArrangement = rmsOf(tailSeg);

  // ---- negative controls: each defective render must FAIL its check ----
  const nc = (name, baseState, trackIndex, mutatePlan, probe) => {
    const badPlan = compilePlan(baseState(), { tailFrames: Math.round(0.3 * SR) });
    mutatePlan(badPlan);
    return renderOffline(badPlan, buffers, {
      ...baseOptions,
      clipFilter: (c) => c.trackIndex === trackIndex,
    }).then(({ audioBuffer: badBuf }) => {
      const out = probe(badBuf.getChannelData(0));
      results.negativeControls.push({ name, detected: !out.passed, check: out });
      return new Promise((r) => setTimeout(r, 60));
    });
  };
  const soloTrack = (i) => () => withOnlyTrack(engine.state, i);

  await nc('incorrect source-offset calculation', soloTrack(2), 2, (p) => {
    p.clips.find((c) => c.trackIndex === 2).sourceStartFrame += Math.round(0.25 * SR);
  }, (x) => {
    const lag = envelopeLagMs(soloRenders[2], x);
    const passed = Math.abs(lag) < 12;
    return { name: 'chords content alignment', passed, measuredLagMs: lag };
  });

  await nc('ignored latency compensation', soloTrack(3), 3, (p) => {
    // Shift by exactly the limiter lookahead (240 frames) — the same scale the
    // gate protects, not a coarse 50 ms probe (Sol B10).
    for (const c of p.clips) c.timelineStartFrame += 240;
  }, (x) => {
    const onset = onsetSample(x, 0.01);
    const passed = Math.abs(onset - leadOnset) <= 150;
    return { name: 'clip placement', passed, measuredOnset: onset, referenceOnset: leadOnset };
  });

  await nc('pitch applied as playback speed', soloTrack(3), 3, (p) => {
    const c = p.clips.find((cl) => cl.trackIndex === 3);
    c.rate *= c.pitchFactor;
    c.pitchSemitones = 0;
    c.pitchFactor = 1;
  }, (x) => {
    const f = f0Estimate(x, leadStart);
    const passed = Math.abs(f / fBase - 2 ** (7 / 12)) < 0.03;
    return { name: 'pitch ratio', passed, measuredFreqHz: f, expectedFreqHz: fBase * 2 ** (7 / 12) };
  });

  await nc('broken clip fades (detector effectiveness)', soloTrack(3), 3, (p) => {
    for (const c of p.clips) { c.fadeInFrames = 0; c.fadeOutFrames = 0; }
  }, (x) => {
    // The ORDINARY boundary gate must reject the unfaded render at the same
    // edges — this is the negative control that proves the detector remains
    // effective (Grok C1). The mid-vowel cut steps at full sustain amplitude.
    const brokenGate = boundaryGate([
      boundaryDiscontinuity(x, leadStartFrame),
      boundaryDiscontinuity(x, leadEndFrame),
    ]);
    results.clickEvidence.broken = {
      leadCutFrame: leadEndFrame,
      leadCutWindow: windowOf(x, leadEndFrame),
      leadStartFrame,
      leadStartWindow: windowOf(x, leadStartFrame),
      gate: brokenGate,
    };
    return {
      name: 'BDI gate rejects the unfaded boundaries',
      passed: brokenGate.passed, // nc inverts: detected when the gate rejects
      worstIndex: brokenGate.worstIndex,
      flagged: brokenGate.flagged,
    };
  });

  // ---- GATE 5: minimal real-time AudioWorklet proof ----
  try {
    const rtCtx = new AudioContext({ sampleRate: SR });
    const startDelaySec = 0.25;
    const rt = await startRealtime(plan, buffers, {
      ...baseOptions,
      ctx: rtCtx,
      listenSeconds: 4,
      startDelaySec,
    });
    await rtCtx.close();
    const lagMs = envelopeLagMs(L.slice(0, 4 * SR), rt.l, 700);
    const offset = Math.round(lagMs * 0.001 * SR);
    // The capture is delayed by `offset` relative to the bounce: compare
    // L[i] with rt[i + offset].
    const n = Math.min(L.length, rt.l.length - offset, 4 * SR);
    let diff = 0;
    let energy = 0;
    // Envelope-domain parity (1 ms RMS envelopes): the fair tolerance for a
    // stretch DSP whose block scheduling differs between hosts. Raw waveform
    // difference is reported but is not the pass criterion.
    const envOf = (x, from) => {
      const out = [];
      const hop = 48;
      for (let i = 0; i + hop < n; i += hop) {
        let s = 0;
        for (let j = 0; j < hop; j += 1) s += x[from + i + j] ** 2;
        out.push(Math.sqrt(s / hop));
      }
      return out;
    };
    const envA = envOf(L, 0);
    const envB = envOf(rt.l, offset);
    let envDiff = 0;
    let envEnergy = 0;
    for (let i = 0; i < Math.min(envA.length, envB.length); i += 1) {
      envDiff += (envA[i] - envB[i]) ** 2;
      envEnergy += envA[i] ** 2;
    }
    const envCorrAt = (hopMs) => {
      const hop = Math.round((hopMs / 1000) * SR);
      const corrFor = (chA, chB) => {
        const ea = [];
        const eb = [];
        for (let i = 0; i + hop < n; i += hop) {
          let sa = 0;
          let sb = 0;
          for (let j = 0; j < hop; j += 1) {
            sa += chA[i + j] ** 2;
            sb += chB[i + offset + j] ** 2;
          }
          ea.push(Math.sqrt(sa / hop));
          eb.push(Math.sqrt(sb / hop));
        }
        const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
        const ma = mean(ea);
        const mb = mean(eb);
        let c = 0;
        let va = 0;
        let vb = 0;
        for (let i = 0; i < ea.length; i += 1) {
          c += (ea[i] - ma) * (eb[i] - mb);
          va += (ea[i] - ma) ** 2;
          vb += (eb[i] - mb) ** 2;
        }
        return c / Math.sqrt(Math.max(1e-12, va * vb));
      };
      // Both channels must agree (Sol IMPROVE): report the worse of the two.
      return Math.min(corrFor(L, rt.l), corrFor(R, rt.r));
    };
    const envCorrelation1ms = envCorrAt(1);
    const envCorrelation10ms = envCorrAt(10);
    let meanA = 0;
    let meanB = 0;
    const mEnv = Math.min(envA.length, envB.length);
    for (let i = 0; i < mEnv; i += 1) { meanA += envA[i]; meanB += envB[i]; }
    meanA /= mEnv;
    meanB /= mEnv;
    for (let i = Math.round(0.3 * SR); i < n; i += 1) {
      const a = L[i];
      const b = rt.l[i + offset];
      diff += (a - b) * (a - b);
      energy += a * a;
    }
    results.gate5 = {
      capturedChunks: rt.capturedChunks,
      capturedFrames: rt.l.length,
      measuredLagMs: lagMs,
      expectedLagMs: startDelaySec * 1000,
      normalizedRmsDiffRaw: Math.sqrt(diff / Math.max(1e-9, energy)),
      normalizedRmsDiffEnvelope: Math.sqrt(envDiff / Math.max(1e-9, envEnergy)),
      envelopeCorrelation1ms: envCorrelation1ms,
      envelopeCorrelation10ms: envCorrelation10ms,
      envelopeMeanRatio: meanB / Math.max(1e-9, meanA),
      limiterStatsSeen: rt.limiterStats.length,
      finding: 'fine-scale (1 ms) envelopes decorrelate where 10 ms musical envelopes match: stretch transient smears land at different micro-positions under live block scheduling versus offline rendering. Levels and timing match. Complete parity is NOT claimed (Milestone C: transport, seeking, looping).',
    };
    check('GATE 5 real-time proof captures the same arrangement at the expected latency',
      Math.abs(lagMs - startDelaySec * 1000) < 15
        && Math.abs(results.gate5.envelopeMeanRatio - 1) < 0.1
        && envCorrelation10ms > 0.8,
      results.gate5);
  } catch (err) {
    results.gate5.error = String(err);
    results.errors.push(`gate5: ${err}`);
  }

  // ---- GATE 7 artifact (renderOffline already trims limiter latency) ----
  // The artifact is the exact arrangement extent [0, arrangementEndFrame):
  // the DSP tail (tailFrames) is deliberately excluded and the limiter's
  // lookahead delay was trimmed inside renderOffline, so WAV frame 0 is
  // arrangement frame 0. Its frame count must equal the computed end.
  const outL = L.slice(0, plan.output.arrangementEndFrame);
  const outR = R.slice(0, plan.output.arrangementEndFrame);
  const wav = encodeWav24([outL, outR], SR);
  results.measurements.artifactFrames = outL.length;
  results.measurements.artifactDurationSec = outL.length / SR;
  check('WAV frame count equals the computed arrangement end (tail excluded, lookahead trimmed)',
    outL.length === independentEndFrame
      && outL.length === plan.output.arrangementEndFrame
      && outL.length !== plan.output.totalFrames,
    {
      artifactFrames: outL.length,
      independentEndFrame,
      totalFrames: plan.output.totalFrames,
      artifactDurationSec: outL.length / SR,
    });
  // The artifact is only meaningful for the clean render — never overwrite it
  // from the defective demonstration mode.
  if (!breakFades) await post('/artifact', wav);
  await post('/results', JSON.stringify(results));
  window.__bounceDone = true;
}

function withOnlyTrack(state, trackIndex) {
  const s = JSON.parse(JSON.stringify(state));
  for (const t of s.tracks) {
    t.mute = t.trackIndex !== trackIndex;
    t.solo = t.trackIndex === trackIndex;
  }
  return s;
}

function cloneStateWithoutPitch(state, clipId) {
  const s = JSON.parse(JSON.stringify(state));
  const clip = s.clips.find((c) => c.id === clipId);
  clip.pitchSemitones = 0;
  clip.preserveFormants = false;
  return s;
}

function cloneStateWithoutFormants(state, clipId) {
  const s = JSON.parse(JSON.stringify(state));
  const clip = s.clips.find((c) => c.id === clipId);
  clip.preserveFormants = false;
  return s;
}

main().catch((err) => {
  results.errors.push(String(err && err.stack ? err.stack : err));
  fetch('/results', { method: 'POST', body: JSON.stringify(results) }).finally(() => {
    window.__bounceDone = true;
    window.__bounceError = String(err);
  });
});
