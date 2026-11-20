// tests/frontend/arrangement/click-guard.test.js — qualification of the
// boundary-local discontinuity detector (GATE 6 corrective action, Grok C1).
//
// What is qualified here:
//   1. Reproduction of Grok's finding: the old global slope gate accepts a
//      gross broken-fade cut (pinned as regression context).
//   2. Sensitivity: clean vs deliberately defective cuts on vocal, pad, drum
//      and silence-transition material — the ordinary gate must pass the clean
//      cuts and fail the broken ones (the acceptance path really rejects the
//      representative broken-fade cases).
//   3. False-positive behaviour: clean cuts at many phases, content-continuous
//      splits, musical onsets and long musical fades must NOT be flagged.
//   4. Detection floors (phase-jump sweep and amplitude-step sweep).
//   5. Scale invariance and a negative control against the legacy gate.
//
// The probes mirror the harness's synthesised classes (tests/browser/daw/synth.js)
// and the clip-gain law of js/arrangement/offline-render.js: a clean region
// edge multiplies content by a linear 360-sample (0.015-beat) ramp, a broken
// edge steps in one sample.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BDI_THRESHOLD,
  boundaryDiscontinuity,
  boundaryGate,
} from '../../../src/twobecomeone/studio_static/js/arrangement/click-guard.js';
import { SR, addTone, VOWEL } from '../../browser/daw/synth.js';

const MICRO_FADE = 360; // 0.015 beats at 120 BPM
const EDGE = 24000;
const N = 48000;

/** Linear micro-fade over the region edges (the clip-gain law). */
function applyMicroFade(x, fadeIn = MICRO_FADE, fadeOut = MICRO_FADE) {
  for (let i = 0; i < fadeIn && i < x.length; i += 1) x[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut && i < x.length; i += 1) x[x.length - 1 - i] *= i / fadeOut;
  return x;
}

function mono() {
  return [new Float32Array(N)];
}

// ---------- content classes (cut at EDGE, content lives on both sides) ----------

function vocalSustain() {
  const ch = mono();
  addTone(ch, 0, N / SR, 220, 0.4, { formants: VOWEL, f0ForFormants: 220 });
  return ch[0];
}

function padStack() {
  const ch = mono();
  for (const f of [220, 261.6, 329.6]) addTone(ch, 0, N / SR, f, 0.12, { vibrato: 0.002 });
  return ch[0];
}

function drumBurst() {
  // Live drum-class noise burst: onset 30 ms before the cut (outside the
  // detector's ±11 ms context) with a slow decay, so it is still sounding at
  // full character across the cut.
  const x = new Float32Array(N);
  const onset = EDGE - 1440;
  let seed = 4242;
  for (let i = onset; i < N; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = (seed / 0x3fffffff - 1) * 0.3 * Math.exp(-((i - onset) / SR) * 12);
  }
  return x;
}

function hatBurst() {
  // The hi-hat transient class (the legacy gate's "steady reference"): a fast
  // noise burst whose own sample slopes are steep musical content.
  const x = new Float32Array(N);
  let seed = 777;
  for (let i = EDGE; i < EDGE + 2880; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = (seed / 0x3fffffff - 1) * 0.2 * Math.exp(-((i - EDGE) / SR) * 60);
  }
  return x;
}

function silenceOnset() {
  // Silence then a drum-class noise onset AT the edge (start edge).
  const x = new Float32Array(N);
  let seed = 999;
  for (let i = EDGE; i < N; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = (seed / 0x3fffffff - 1) * 0.3 * Math.exp(-((i - EDGE) / SR) * 30);
  }
  return x;
}

function toneOnset() {
  // Silence then a sustained tone arriving at the edge (start edge).
  const x = new Float32Array(N);
  for (let i = EDGE; i < N; i += 1) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 330 * (i - EDGE)) / SR + Math.PI / 2);
  }
  return x;
}

const CLASSES = {
  vocal: vocalSustain,
  pad: padStack,
  drum: drumBurst,
  'silence-transition (onset)': silenceOnset,
  'silence-transition (tone)': toneOnset,
};

/** End-edge pair: broken = hard cut to silence at EDGE, clean = faded. */
function endEdge(content, { fade = true, offset = 0 } = {}) {
  const x = Float32Array.from(content);
  const at = EDGE + offset;
  if (fade) for (let i = at - MICRO_FADE; i < at; i += 1) x[i] *= (at - i) / MICRO_FADE;
  x.fill(0, at);
  return { samples: x, boundary: at };
}

/** Start-edge pair: content resumes at EDGE (broken) or over a fade (clean). */
function startEdge(content, { fade = true, offset = 0 } = {}) {
  const x = Float32Array.from(content);
  const at = EDGE + offset;
  for (let i = 0; i < at; i += 1) x[i] = 0;
  if (fade) for (let i = at; i < at + MICRO_FADE; i += 1) x[i] *= (i - at) / MICRO_FADE;
  return { samples: x, boundary: at };
}

const isStartClass = (name) => name.startsWith('silence-transition');
const makeCase = (name, opts) => (isStartClass(name) ? startEdge(CLASSES[name](), opts) : endEdge(CLASSES[name](), opts));

const score = ({ samples, boundary }) => boundaryDiscontinuity(samples, boundary);

// ---------- legacy gate (kept to reproduce and pin Grok's finding) ----------

function maxSlope(x, around, radius = Math.round(0.005 * SR)) {
  let m = 0;
  for (let i = Math.max(1, around - radius); i < Math.min(x.length, around + radius); i += 1) {
    m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  }
  return m;
}

test('Grok reproduction: the old global slope gate accepts a gross broken cut', () => {
  // From-signal reproduction of the audited run's numbers (steady 0.1848,
  // threshold 0.7393, broken 0.2009 -> "passes"). The global steady reference
  // is a musical hi-hat burst; its own noise slope inflates the threshold
  // until a hard cut slides under it.
  const steady = maxSlope(hatBurst(), EDGE + 500, 240);
  const threshold = 4 * steady;

  const broken = endEdge(CLASSES.vocal(), { fade: false });
  const clean = endEdge(CLASSES.vocal(), { fade: true });
  const brokenSlope = maxSlope(broken.samples, EDGE, 480);
  const cleanSlope = maxSlope(clean.samples, EDGE, 480);

  assert.ok(steady > 0.1, 'the hi-hat reference must be a real musical transient');
  assert.ok(brokenSlope < threshold,
    `Grok finding pinned: the broken cut (${brokenSlope.toFixed(3)}) passes the old gate (threshold ${threshold.toFixed(3)})`);
  assert.ok(cleanSlope < threshold, 'the clean cut also passes — the old gate cannot separate them');

  // The detector separates what the old gate throws away.
  assert.equal(score(broken).flagged, true);
  assert.equal(score(clean).flagged, false);
});

// ---------- sensitivity: clean and defective cuts, four fixture classes ----------

test('clean cuts pass the ordinary gate on vocal, pad, drum and silence transitions', () => {
  // False-positive suite: 13 cut phases per class must ALL pass. Measured
  // worst: pad 2.10 (its slow beating rivals the fade ramp — the limiting
  // class), all others <= 1.0 against a 2.5 threshold.
  const report = {};
  for (const name of Object.keys(CLASSES)) {
    let worst = 0;
    for (let offset = 0; offset < 37; offset += 3) {
      const s = score(makeCase(name, { fade: true, offset }));
      worst = Math.max(worst, s.index);
      assert.equal(s.flagged, false, `false positive on clean ${name} cut (offset ${offset}): BDI ${s.index.toFixed(2)}`);
    }
    report[name] = Number(worst.toFixed(3));
    assert.ok(worst < BDI_THRESHOLD * 0.9, `clean ${name} needs margin under the threshold: ${worst.toFixed(2)}`);
  }
});

test('broken cuts FAIL the ordinary gate on vocal, pad, drum and silence transitions', () => {
  // Sensitivity suite: 13 cut phases per class must ALL fail the gate. The
  // claim is per-class minimum margin (the hardest cut phase still detected):
  // vocal 3.56, pad 3.26 (limiting), drum 15.3, silence transitions 10-16.
  const report = {};
  for (const name of Object.keys(CLASSES)) {
    let easiest = 0;
    let hardest = Infinity;
    for (let offset = 0; offset < 37; offset += 3) {
      const s = score(makeCase(name, { fade: false, offset }));
      easiest = Math.max(easiest, s.index);
      hardest = Math.min(hardest, s.index);
    }
    report[name] = { min: Number(hardest.toFixed(2)), max: Number(easiest.toFixed(2)) };
    assert.ok(hardest > BDI_THRESHOLD,
      `every broken ${name} cut must FAIL acceptance (hardest phase BDI ${hardest.toFixed(2)})`);
  }
  // The representative single-cut cases clear the threshold outright.
  for (const name of Object.keys(CLASSES)) {
    const s = score(makeCase(name, { fade: false }));
    assert.equal(s.flagged, true,
      `the representative broken-fade case must FAIL acceptance on ${name} (BDI ${s.index.toFixed(2)})`);
  }
});

test('the ordinary acceptance gate fails a representative broken-fade render end to end', () => {
  // The exact acceptance shape of the bounce harness: gate all region edges of
  // one render. Clean -> pass. The same edges unfaded -> the SAME gate fails.
  const clean = [
    boundaryDiscontinuity(endEdge(CLASSES.vocal(), { fade: true }).samples, EDGE),
    boundaryDiscontinuity(endEdge(CLASSES.drum(), { fade: true }).samples, EDGE),
    boundaryDiscontinuity(startEdge(CLASSES['silence-transition (onset)'](), { fade: true }).samples, EDGE),
  ];
  const broken = [
    boundaryDiscontinuity(endEdge(CLASSES.vocal(), { fade: false }).samples, EDGE),
    boundaryDiscontinuity(endEdge(CLASSES.drum(), { fade: false }).samples, EDGE),
    boundaryDiscontinuity(startEdge(CLASSES['silence-transition (onset)'](), { fade: false }).samples, EDGE),
  ];
  assert.equal(boundaryGate(clean).passed, true);
  assert.equal(boundaryGate(broken).passed, false);
});

// ---------- false positives: expected musical transients and smooth structure ----------

test('musical onsets inside a region are never flagged (only edges are probed)', () => {
  // A hi-hat onset mid-region is content: identical to any boundary onset but
  // not a region edge. The detector is only ever asked about edges.
  const x = silenceOnset(); // onset at EDGE...
  const interior = boundaryDiscontinuity(x, EDGE + 2000); // ...probed 2 000 samples later
  assert.equal(interior.flagged, false);
  assert.ok(interior.index < BDI_THRESHOLD);
});

test('content-continuous splits are not flagged', () => {
  // Split children abut on identical source content: no gain edge, no break.
  for (const content of [CLASSES.vocal(), CLASSES.pad(), CLASSES.drum()]) {
    const s = boundaryDiscontinuity(content, EDGE);
    assert.equal(s.flagged, false, 'a content-continuous abutment must not be flagged');
  }
});

test('long musical fades are not flagged at either end', () => {
  // The pad's 2-beat (0.5 s = 24 000 samples) fades.
  const LONG = 24000;
  const content = CLASSES.pad();
  for (const offset of [0, 17, 41]) {
    const out = endEdge(content, { fade: true, offset });
    for (let i = out.boundary - LONG; i < out.boundary; i += 1) {
      out.samples[i] = content[i] * ((out.boundary - i) / LONG);
    }
    assert.equal(score(out).flagged, false, 'a long fade-out end must not be flagged');
    const incoming = startEdge(content, { fade: true, offset });
    for (let i = incoming.boundary; i < incoming.boundary + LONG; i += 1) {
      incoming.samples[i] = content[i] * ((i - incoming.boundary) / LONG);
    }
    assert.equal(score(incoming).flagged, false, 'a long fade-in start must not be flagged');
  }
});

test('a decayed region edge into silence is not flagged (nothing to click)', () => {
  const x = drumBurst().fill(0, EDGE - 4800); // burst decayed away long before the edge
  const s = boundaryDiscontinuity(endEdge(x, { fade: false }).samples, EDGE);
  assert.equal(s.flagged, false);
  assert.ok(s.index < 1, `near-silent edges score ~0, got ${s.index}`);
});

// ---------- detection floors ----------

test('waveform-step sensitivity: phase jumps at an envelope-continuous boundary', () => {
  // Same tone continuing at the same amplitude with a phase jump phi applied at
  // the tone's PEAK (where a phase jump is a pure value step). The waveform
  // term compares the junction's value step against the content's own
  // per-sample slope (a masking model: steps inside the waveform's own
  // per-sample movement are inaudible). Measured floor: junction steps >= ~10%
  // of the content amplitude are detected on a 330 Hz tone; the sweep pins the
  // transition band (7% passes, 15% fails).
  const A = 0.5;
  const floors = {};
  for (const phiDeg of [180, 90, 45, 22, 11, 2]) {
    const x = new Float32Array(N);
    const phi = (phiDeg * Math.PI) / 180;
    for (let i = 0; i < N; i += 1) {
      const phase = (2 * Math.PI * 330 * i) / SR + Math.PI / 2 + (i >= EDGE ? phi : 0);
      x[i] = A * Math.sin(phase);
    }
    const s = boundaryDiscontinuity(x, EDGE);
    floors[phiDeg] = {
      flagged: s.flagged,
      waveRatio: Number(s.waveform.ratio.toFixed(2)),
      junctionStepOfA: Number((Math.abs(x[EDGE] - x[EDGE - 1]) / A).toFixed(3)),
    };
  }
  assert.equal(floors[180].flagged, true, JSON.stringify(floors));
  assert.equal(floors[45].flagged, true, 'a junction step of 15% of A must be detected');
  assert.equal(floors[22].flagged, false, 'a junction step of 7% of A is inside the masking band');
  assert.equal(floors[2].flagged, false, 'a 0.9% step is far below the floor (documented)');
});

test('envelope-step sensitivity: amplitude steps on noise at a boundary', () => {
  // The same noise continues at gain g after the edge: the envelope term must
  // catch the amplitude step even though the waveform term is masked by the
  // noise. Measured floor: envelope steps >= ~20% of the content RMS.
  const x0 = drumBurst();
  const floors = {};
  for (const g of [0.9, 0.8, 0.7, 0.5]) {
    const x = Float32Array.from(x0);
    for (let i = EDGE; i < N; i += 1) x[i] = x0[i] * g;
    const s = boundaryDiscontinuity(x, EDGE);
    floors[g] = { flagged: s.flagged, envRatio: Number(s.envelope.ratio.toFixed(2)) };
  }
  assert.equal(floors[0.8].flagged, true, `a 20% envelope step must be detected: ${JSON.stringify(floors)}`);
  assert.equal(floors[0.5].flagged, true, 'an 50% envelope step must be detected');
  assert.equal(floors[0.9].flagged, false, 'a 10% envelope step is below the floor (documented)');
});

test('the detector is scale-invariant (a step is judged against its content)', () => {
  const big = endEdge(CLASSES.vocal(), { fade: false });
  const small = endEdge(CLASSES.vocal(), { fade: false });
  for (let i = 0; i < small.samples.length; i += 1) small.samples[i] *= 0.01;
  const a = score(big);
  const b = score(small);
  assert.equal(a.flagged, b.flagged, 'the verdict must not depend on absolute level');
  assert.ok(Math.abs(a.index - b.index) / a.index < 0.2,
    `index must be scale-invariant: ${a.index.toFixed(2)} vs ${b.index.toFixed(2)}`);
});

test('negative control: the legacy gate cannot see what the detector rejects', () => {
  // Detector-effectiveness control against the OLD gate: the same broken
  // vocal cut must be flagged by BDI while sailing under the legacy slope
  // threshold measured on drum-class transients.
  const threshold = 4 * maxSlope(hatBurst(), EDGE + 500, 240);
  const broken = endEdge(CLASSES.vocal(), { fade: false });
  const brokenSlope = maxSlope(broken.samples, EDGE, 480);
  assert.ok(brokenSlope < threshold, 'legacy gate accepts the broken cut (the defect we are fixing)');
  const s = score(broken);
  assert.equal(s.flagged, true, 'BDI must reject it');
  // Qualified margin on this class is ~1.5x the threshold (the limiting class,
  // slow-beating pad content, measures 1.30x — see the per-class suite).
  assert.ok(s.index > BDI_THRESHOLD * 1.2, `real margin expected, got ${s.index.toFixed(2)}`);
});

test('a boundary near the buffer start scores without NaN (regression)', () => {
  // Saved-signal windows are small arrays; a boundary within the context span
  // of sample 0 must not read out of bounds and poison the score.
  const win = Float32Array.from(CLASSES.vocal().slice(0, 960));
  for (const b of [1, 64, 200, 480]) {
    const s = boundaryDiscontinuity(win, b);
    assert.ok(Number.isFinite(s.index), `index must be finite at boundary ${b}`);
    assert.ok(Number.isFinite(s.waveform.roughness), `waveform roughness must be finite at boundary ${b}`);
  }
});

test('documented blind spot: an incoming region with its own fast attack masks a missing fade-in', () => {
  // A region whose source begins with its own attack ramp (the synthesised
  // bass/kick notes carry a 10 ms attack) starts gently even WITHOUT the
  // micro-fade: the defect is locally invisible and perceptually masked. This
  // is the named remaining blocker in the docs — not claimed detected.
  const note = new Float32Array(N);
  addTone([note], 0, N / SR, 55, 0.35); // 10 ms attack at sample 0
  const shifted = new Float32Array(N);
  for (let i = EDGE; i < N; i += 1) shifted[i] = note[i - EDGE]; // attack lands on the edge
  const s = boundaryDiscontinuity(shifted, EDGE);
  assert.equal(s.flagged, false, 'masked by the source attack — documented, not claimed detected');
});
