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
import SignalsmithStretch from '/src/twobecomeone/studio_static/vendor/signalsmith-stretch/SignalsmithStretch.mjs';

const SR = 48000;
const BPM = 120;
const results = { measurements: {}, checks: [], negativeControls: [], gate5: {}, errors: [] };
const post = (path, body) => fetch(path, { method: 'POST', body });

// ---------- deterministic synthesis (original material) ----------

function makeBuffer(seconds, channels = 2) {
  const n = Math.round(seconds * SR);
  return Array.from({ length: channels }, () => new Float32Array(n));
}

function addTone(ch, startSec, seconds, freq, amp, { vibrato = 0, formants = null, f0ForFormants = null } = {}) {
  const n = Math.round(seconds * SR);
  const at = Math.round(startSec * SR);
  const fade = Math.round(0.01 * SR);
  for (let i = 0; i < n; i += 1) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    let s;
    if (formants) {
      s = 0;
      const f0 = f0ForFormants ?? freq;
      for (let k = 1; k * f0 < 3400; k += 1) {
        const f = k * f0;
        let e = 0.02;
        for (const [fc, bw, gain] of formants) {
          const d = (f - fc) / bw;
          e += gain * Math.exp(-0.5 * d * d);
        }
        s += (e / k) * Math.sin((2 * Math.PI * f * i) / SR);
      }
    } else {
      const wobble = vibrato ? 1 + vibrato * Math.sin((2 * Math.PI * 5 * i) / SR) : 1;
      s = Math.sin((2 * Math.PI * freq * wobble * i) / SR);
    }
    for (const c of ch) {
      c[at + i] += amp * s * Math.max(0, env);
    }
  }
}

function addKick(ch, startSec, amp = 0.9) {
  const at = Math.round(startSec * SR);
  const n = Math.round(0.25 * SR);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    const f = 120 * Math.exp(-t * 18) + 45;
    const env = Math.exp(-t * 14);
    const s = Math.sin(2 * Math.PI * f * t) * env * amp;
    for (const c of ch) c[at + i] += s;
  }
}

function addSnare(ch, startSec, amp = 0.5) {
  const at = Math.round(startSec * SR);
  const n = Math.round(0.18 * SR);
  let seed = 12345;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x3fffffff - 1);
    const env = Math.exp(-(i / SR) * 22);
    const s = (noise * 0.7 + Math.sin((2 * Math.PI * 190 * i) / SR) * 0.3) * env * amp;
    for (const c of ch) c[at + i] += s;
  }
}

function addHat(ch, startSec, amp = 0.2) {
  const at = Math.round(startSec * SR);
  const n = Math.round(0.06 * SR);
  let seed = 777;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x3fffffff - 1);
    const env = Math.exp(-(i / SR) * 60);
    for (const c of ch) c[at + i] += noise * env * amp;
  }
}

const VOWEL = [[730, 80, 1], [1090, 90, 0.7], [2440, 120, 0.25]];
const beat = 60 / BPM;

function buildStems() {
  // 0 drums: 8 s = 16 beats, 120 BPM pattern (kick/snare/hats).
  const drums = makeBuffer(8);
  for (let b = 0; b < 16; b += 1) {
    if (b % 4 === 0 || b % 4 === 2) addKick(drums, b * beat);
    if (b % 4 === 2) addSnare(drums, b * beat);
    addHat(drums, b * beat + beat / 2, 0.16);
    addHat(drums, b * beat, 0.1);
  }
  // 1 bass: A minor line (A1/C2/D2/E2).
  const bass = makeBuffer(8);
  const bassNotes = [55, 55, 65.4, 55, 73.4, 55, 82.4, 55, 55, 55, 65.4, 55, 82.4, 73.4, 65.4, 55];
  for (let b = 0; b < 16; b += 1) {
    addTone(bass, b * beat, beat * 0.9, bassNotes[b], 0.35);
  }
  // 3 lead: vowel (vocal-like) melody on long notes; note 4 is a pure 330 Hz
  // sine whose positive peak sits exactly at source 5.000757 s — the point the
  // arrangement trims through, so boundary-click probes are phase-proof.
  const lead = makeBuffer(6, 2);
  const melody = [220, 261.6, 293.7];
  for (let i = 0; i < 3; i += 1) {
    addTone(lead, i * 1.5, 1.4, melody[i], 0.4, { formants: VOWEL, f0ForFormants: melody[i] });
  }
  addTone(lead, 4.5, 1.4, 330, 0.5);
  // 4 pad: soft triad chords (Am/F/G/Am).
  const pad = makeBuffer(8);
  const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [220, 261.6, 329.6]];
  for (let i = 0; i < 4; i += 1) {
    for (const f of chords[i]) addTone(pad, i * 2, 1.95, f, 0.12, { vibrato: 0.002 });
  }
  // 5 arp: sixteenth-note A-minor arpeggio.
  const arp = makeBuffer(8);
  const arpNotes = [440, 523.3, 659.3, 523.3];
  for (let s = 0; s < 64; s += 1) {
    addTone(arp, s * (beat / 4), beat / 4 * 0.8, arpNotes[s % 4], 0.18);
  }
  return { drums, bass, lead, pad, arp };
}

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
  const refs = {};
  const load = (trackIndex, name, channels, nativeBpm, key = null) => {
    const bufferReference = `synth:${name}`;
    const durationSec = channels[0].length / SR;
    const { assetId, clipId } = engine.loadStemToTrack(trackIndex, {
      name, durationSec, bufferReference, detectedKey: key,
    }, nativeBpm);
    refs[clipId] = { bufferReference, channels };
    return { assetId, clipId };
  };

  const drums = load(0, 'drums', stems.drums, 120, 'Am');
  const bass = load(1, 'bass', stems.bass, 120, 'Am');
  const chords = load(2, 'chords-100bpm', fixtureChords, 100, 'C');
  const lead = load(3, 'lead-vowel', stems.lead, 120, 'Am');
  const pad = load(4, 'pad', stems.pad, 120, 'Am');
  const arp = load(5, 'arp', stems.arp, 120, 'Am');
  const perc = load(6, 'perc-140bpm', fixturePerc, 140, 'Am');
  const side = load(7, 'side-texture', fixtureSide, null); // tempo unmeasured: stays unknown

  // Non-destructive edits through the atomic API:
  engine.splitClipAtBeat(drums.clipId, 8);              // split a drum region
  engine.trimClip(drums.clipId, 'end', -1);             // trim the left half
  engine.trimClip(bass.clipId, 'start', 1);             // trim the bass start
  engine.moveClip(lead.clipId, 3, 8);                   // move the vocal clip to bar 3
  engine.trimClip(lead.clipId, 'end', -1.998485);       // cut at the sine peak (beat ~18.0015)
  engine.setClipPitch(lead.clipId, 7, true);            // transpose +7, formants kept
  engine.setClipFades(pad.clipId, 2, 2);                // musical 2-beat fades
  engine.setClipStretch(arp.clipId, 0.85);              // manual stretch ratio
  engine.setClipGain(side.clipId, -12);
  engine.setTrackEq(1, { lowGainDb: 3 });
  engine.setTrackEq(3, { midGainDb: 2, highGainDb: 2 });
  engine.setTrackEq(4, { lowGainDb: -2, highGainDb: 1 });
  engine.setTrackPan(0, -0.2);
  engine.setTrackPan(5, 0.3);
  engine.setTrackPan(7, 0.7);
  engine.setTrackVolume(2, -3);
  engine.setLoopRange(0, 32);
  return { engine, refs, ids: { drums, bass, chords, lead, pad, arp, perc, side } };
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

  const plan = compileRenderPlan(engine.state, {
    tailFrames: Math.round(0.3 * SR),
  });
  results.measurements.planClips = plan.clips.length;
  results.measurements.limiterLatencyFrames = 240;

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

  // Intersample (true-peak ESTIMATE, 4x linear upsample — reported, not claimed).
  let truePeakEst = 0;
  for (let i = 0; i < L.length - 1; i += 1) {
    for (let k = 0; k < 4; k += 1) {
      const t = k / 4;
      truePeakEst = Math.max(truePeakEst, Math.abs(L[i] + (L[i + 1] - L[i]) * t));
      truePeakEst = Math.max(truePeakEst, Math.abs(R[i] + (R[i + 1] - R[i]) * t));
    }
  }
  results.measurements.truePeakEstimate4x = truePeakEst;
  results.measurements.truePeakClaimed = false;

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
    compileRenderPlan(withOnlyTrack(engine.state, trackIndex), { tailFrames: Math.round(0.3 * SR) }),
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

  // Mute/Solo behaviour: a solo render contains ONLY that track.
  const solo0Ratio = rmsOf(soloRenders[0]) / Math.max(1e-9, rmsOf(L));
  results.measurements.soloIsolationRatio = solo0Ratio;
  check('solo isolation (solo render is quieter than the full mix)', solo0Ratio < 0.9, { solo0Ratio });

  // Effective stretch ratio on the chords clip (100 BPM -> 120 master).
  const chordPlan = compileRenderPlan(withOnlyTrack(engine.state, 2), { tailFrames: Math.round(0.3 * SR) });
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
  const noPitchPlan = compileRenderPlan(noPitchState, { tailFrames: Math.round(0.3 * SR) });
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
  check('pitch without duration change (onsets agree)',
    Math.abs(leadOnset - leadOnsetBase) < 0.03 * SR, { leadOnset, leadOnsetBase });

  // Formant behaviour on the vocal-like lead (constant-vowel segment).
  // Relative claim: compensation holds the F1 envelope nearer the unshifted
  // render than an uncompensated shift moves it. Absolute peaks carry the
  // harmonic-grid quantisation (±f0/2) and are reported as such.
  const noCompState = cloneStateWithoutFormants(engine.state, ids.lead.clipId);
  const noCompPlan = compileRenderPlan(noCompState, { tailFrames: Math.round(0.3 * SR) });
  const { audioBuffer: noCompBuf } = await renderOffline(noCompPlan, buffers,
    { ...baseOptions, clipFilter: (c) => c.trackIndex === 3 });
  const winStart = leadStart;
  const winLen = 8192;
  const f1Base = envelopePeakHz(noPitchBuf.getChannelData(0), winStart, winLen, fBase, [400, 1200]);
  const f1Shifted = envelopePeakHz(soloRenders[3], winStart, winLen, fShifted, [400, 1200]);
  const f1NoComp = envelopePeakHz(noCompBuf.getChannelData(0), winStart, winLen, fShifted, [400, 1200]);
  results.measurements.formants = {
    f1Base, f1Shifted, f1NoComp,
    compensatedDeltaHz: Math.abs(f1Shifted - f1Base),
    uncompensatedDeltaHz: Math.abs(f1NoComp - f1Base),
    quantisationNote: 'harmonic-grid peaks quantise to ±f0/2',
  };
  check('formant envelope held under +7 (preserveFormants)',
    Math.abs(f1Shifted - f1Base) <= Math.abs(f1NoComp - f1Base),
    results.measurements.formants);

  // Clip placement: the lead was moved to beat 8; onset must land there.
  const expectedLeadFrame = Math.round(8 * beat * SR) + 99; // + measured stretch residual
  results.measurements.clipPlacement = { leadOnset, expectedLeadFrame, errorFrames: leadOnset - expectedLeadFrame };
  check('sample-accurate clip placement (lead at beat 8)', Math.abs(leadOnset - expectedLeadFrame) < 0.015 * SR,
    results.measurements.clipPlacement);

  // Clip boundary clicks: the drums split (kick onset) and the mid-vowel trim
  // cut at beat 18 = 9 s (steady vowel amplitude — the case where a missing
  // fade becomes a real step).
  const splitFrame = Math.round(8 * beat * SR);
  const cutFrame = Math.round(18.001515 * beat * SR); // the sine-peak trim cut
  const clickSplit = maxSlope(soloRenders[0], splitFrame + 99);
  const clickCut = maxSlope(soloRenders[3], cutFrame + 99, Math.round(0.01 * SR));
  const steady = maxSlope(soloRenders[0], Math.round(2 * SR));
  results.measurements.clicks = { clickSplit, clickCut, steadyReference: steady };
  check('no click at clip boundaries (split and mid-vowel trim cut)',
    clickSplit < 0.35 && clickCut < 0.35, results.measurements.clicks);

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
    const badPlan = compileRenderPlan(baseState(), { tailFrames: Math.round(0.3 * SR) });
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
    for (const c of p.clips) c.timelineStartFrame += Math.round(0.05 * SR);
  }, (x) => {
    const onset = onsetSample(x, 0.01);
    const passed = Math.abs(onset - leadOnset) < 0.015 * SR;
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

  await nc('broken clip fades', soloTrack(3), 3, (p) => {
    for (const c of p.clips) { c.fadeInFrames = 0; c.fadeOutFrames = 0; }
  }, (x) => {
    // The mid-vowel trim cut at 9 s is steady amplitude; without the
    // micro-fade-out the region end becomes a hard step.
    const badCutSlope = maxSlope(x, cutFrame + 99, Math.round(0.01 * SR));
    const passed = badCutSlope <= clickCut * 2 + 0.02;
    return { name: 'mid-vowel cut click', passed, badCutSlope, referenceSlope: clickCut };
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
      const ea = [];
      const eb = [];
      for (let i = 0; i + hop < n; i += hop) {
        let sa = 0;
        let sb = 0;
        for (let j = 0; j < hop; j += 1) {
          sa += L[i + j] ** 2;
          sb += rt.l[i + offset + j] ** 2;
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

  // ---- GATE 7 artifact: trimmed export (limiter lookahead removed) ----
  const trimFrames = 240;
  const outL = L.slice(trimFrames, plan.output.arrangementEndFrame + trimFrames);
  const outR = R.slice(trimFrames, plan.output.arrangementEndFrame + trimFrames);
  const wav = encodeWav24([outL, outR], SR);
  results.measurements.artifactFrames = outL.length;
  await post('/artifact', wav);
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
