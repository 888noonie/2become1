// tests/browser/signalsmith/spike.js — GATE 1 feasibility spike, browser side.
//
// OPERATION THE LIVING DAYLIGHTS. Proves Signalsmith Stretch capabilities in
// real Chromium before any renderer is designed. Each experiment returns an
// honest record: what was measured, what the numbers are, and what remains
// unmeasurable in this environment. Nothing here is a listening test.
//
// Experiments:
//   S1  AudioWorklet-backed node in a live AudioContext + API surface probe
//   S2  the same implementation in an OfflineAudioContext (renders)
//   S3  passthrough render: onset, length, frequency integrity
//   S4  duration stretch with preserved pitch (rate 0.5 and 2.0)
//   S5  pitch shift without duration change (+7 and -12 semitones)
//   S6  formant compensation on synthetic vowel material
//   S7  latency, pre-roll, tails, seek/flush behaviour
//   S8  eight simultaneous instances: wall time and memory
//   S9  real-time load, renderCapacity underruns, callback jitter
//   S10 incremental buffer feeding and disposal (bounded memory)

import SignalsmithStretch from '/src/twobecomeone/studio_static/vendor/signalsmith-stretch/SignalsmithStretch.mjs';

const RATE = 48000;
const results = [];

function record(id, ok, metrics, notes = []) {
  results.push({ id, ok, metrics, notes });
}

// ---------- signal generation (original synthetic material) ----------

function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE));
}

function sine(seconds, freq, amp = 0.5, fade = 0.01) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const fadeN = Math.round(fade * RATE);
  for (let i = 0; i < n; i += 1) {
    const env = Math.min(1, i / fadeN, (n - 1 - i) / fadeN);
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE) * Math.max(0, env);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Synthetic vowel: harmonic source shaped by a three-formant envelope. */
function vowel(seconds, f0, formants, amp = 0.4) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const fadeN = Math.round(0.02 * RATE);
  const envelope = (f) => formants.reduce((sum, [fc, bw, gain]) => {
    const d = (f - fc) / bw;
    return sum + gain * Math.exp(-0.5 * d * d);
  }, 0.02);
  const harmonics = [];
  for (let k = 1; k * f0 < 3400; k += 1) {
    harmonics.push([k * f0, (envelope(k * f0) / k)]);
  }
  const norm = Math.max(...harmonics.map(([, a]) => a));
  for (let i = 0; i < n; i += 1) {
    const env = Math.min(1, i / fadeN, (n - 1 - i) / fadeN);
    let s = 0;
    for (const [f, a] of harmonics) s += (a / norm) * Math.sin((2 * Math.PI * f * i) / RATE);
    out[i] = amp * s * Math.max(0, env);
  }
  return out;
}

const VOWEL_A = [[730, 80, 1], [1090, 90, 0.7], [2440, 120, 0.25]];

// ---------- measurement helpers ----------

function peakOf(ch) {
  let p = 0;
  for (const v of ch) p = Math.max(p, Math.abs(v));
  return p;
}

function onsetSample(ch, threshold = 0.02) {
  for (let i = 0; i < ch.length; i += 1) {
    if (Math.abs(ch[i]) > threshold) {
      // Confirm it is a real onset, not a spike.
      let sustained = 0;
      for (let j = i; j < Math.min(i + 100, ch.length); j += 1) {
        if (Math.abs(ch[j]) > threshold) sustained += 1;
      }
      if (sustained > 50) return i;
    }
  }
  return -1;
}

function offsetSample(ch, threshold = 0.02) {
  for (let i = ch.length - 1; i >= 0; i -= 1) {
    if (Math.abs(ch[i]) > threshold) return i;
  }
  return -1;
}

/** Frequency of a near-pure tone by rising zero crossings over a window. */
function toneFrequency(ch, startSample, seconds = 0.5) {
  const end = Math.min(ch.length, startSample + Math.round(seconds * RATE));
  let crossings = 0;
  for (let i = Math.max(1, startSample); i < end; i += 1) {
    if (ch[i - 1] <= 0 && ch[i] > 0) crossings += 1;
  }
  return crossings / ((end - Math.max(1, startSample)) / RATE);
}

/** Goertzel magnitude at an exact frequency over a sample window. */
function goertzel(ch, start, length, freq) {
  const w = (2 * Math.PI * freq) / RATE;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i += 1) {
    s0 = ch[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / length;
}

/** Peak of the harmonic-amplitude envelope within a frequency band. */
function envelopePeak(ch, start, length, f0, band) {
  const points = [];
  for (let k = 1; k * f0 < 3400; k += 1) {
    const f = k * f0;
    if (f >= band[0] && f <= band[1]) {
      points.push([f, Math.max(1e-12, goertzel(ch, start, length, f))]);
    }
  }
  if (points.length < 2) return { freq: NaN, points };
  let best = points[0];
  for (const p of points) if (p[1] > best[1]) best = p;
  return { freq: best[0], points };
}

// ---------- graph helpers ----------

async function offlineNode(seconds) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE);
  const node = await SignalsmithStretch(ctx, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(ctx.destination);
  return { ctx, node };
}

async function renderWithBuffer(node, ctx, mono, scheduleObj) {
  await node.addBuffers([mono, mono]);
  node.schedule(scheduleObj);
  return ctx.startRendering();
}

// ---------- experiments ----------

async function s1_workletLive() {
  const ctx = new AudioContext({ sampleRate: RATE });
  const node = await SignalsmithStretch(ctx, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const api = {};
  for (const m of ['schedule', 'addBuffers', 'dropBuffers', 'start', 'stop', 'latency',
    'inputLatency', 'outputLatency', 'seek', 'flush', 'reset', 'configure',
    'setFormantFactor', 'setFormantSemitones', 'process']) {
    api[m] = typeof node[m];
  }
  const latencyValue = typeof node.latency === 'function' ? await node.latency() : null;
  const metrics = {
    nodeConstructor: node.constructor.name,
    isAudioNode: node instanceof AudioNode,
    workletAvailable: typeof ctx.audioWorklet === 'object',
    renderCapacityAvailable: typeof ctx.renderCapacity === 'object',
    latencySec: latencyValue == null ? null : JSON.parse(JSON.stringify(latencyValue)),
    api,
  };
  node.disconnect();
  await ctx.close();
  record('S1-live-audio-worklet', metrics.isAudioNode && metrics.workletAvailable, metrics,
    metrics.isAudioNode ? [] : ['node is not an AudioNode']);
}

async function s2_offlineRenders() {
  const { ctx, node } = await offlineNode(1.5);
  const mono = sine(1, 440);
  const rendered = await renderWithBuffer(node, ctx, mono, {
    output: 0, active: true, input: 0, rate: 1, semitones: 0,
  });
  const out = rendered.getChannelData(0);
  const metrics = { peak: peakOf(out), frames: out.length, sampleRate: ctx.sampleRate };
  record('S2-offline-audio-context', metrics.peak > 0.05, metrics,
    metrics.peak > 0.05 ? [] : ['offline render produced no signal']);
}

async function s3_passthrough() {
  const mono = concat(silence(0.25), sine(1, 440), silence(1));
  const { ctx, node } = await offlineNode(2.4);
  const rendered = await renderWithBuffer(node, ctx, mono, {
    output: 0, active: true, input: 0, rate: 1, semitones: 0,
  });
  const out = rendered.getChannelData(0);
  const onset = onsetSample(out);
  const offset = offsetSample(out);
  const expectedOnset = Math.round(0.25 * RATE);
  const metrics = {
    onsetSample: onset,
    expectedOnsetSample: expectedOnset,
    onsetErrorSamples: onset - expectedOnset,
    toneLengthSec: (offset - onset) / RATE,
    expectedToneLengthSec: 1,
    frequencyHz: toneFrequency(out, onset + RATE * 0.1),
    expectedFrequencyHz: 440,
    peak: peakOf(out),
  };
  const ok = Math.abs(metrics.onsetErrorSamples) < 0.01 * RATE
    && Math.abs(metrics.toneLengthSec - 1) < 0.05
    && Math.abs(metrics.frequencyHz - 440) < 5;
  record('S3-passthrough', ok, metrics);
}

async function s4_stretchPreservesPitch() {
  const mono = concat(silence(0.25), sine(1, 440), silence(2.5));
  for (const rate of [0.5, 2.0]) {
    const seconds = 0.25 + 1 * (1 / rate) + 1;
    const { ctx, node } = await offlineNode(seconds + 0.5);
    const rendered = await renderWithBuffer(node, ctx, mono, {
      output: 0, active: true, input: 0, rate, semitones: 0,
    });
    const out = rendered.getChannelData(0);
    const onset = onsetSample(out);
    const offset = offsetSample(out);
    const expectedToneSec = 1 / rate;
    const metrics = {
      rate,
      outputDurationMultiplier: 1 / rate,
      toneLengthSec: (offset - onset) / RATE,
      expectedToneLengthSec: expectedToneSec,
      frequencyHz: toneFrequency(out, onset + Math.round(0.05 * RATE), Math.min(0.5, expectedToneSec / 2)),
      expectedFrequencyHz: 440,
    };
    const ok = Math.abs(metrics.toneLengthSec - expectedToneSec) < 0.08
      && Math.abs(metrics.frequencyHz - 440) < 6;
    record(`S4-stretch-rate-${rate}`, ok, metrics);
  }
}

async function s5_pitchPreservesDuration() {
  const mono = concat(silence(0.25), sine(1, 440), silence(1));
  for (const semitones of [7, -12]) {
    const { ctx, node } = await offlineNode(2.6);
    const rendered = await renderWithBuffer(node, ctx, mono, {
      output: 0, active: true, input: 0, rate: 1, semitones,
    });
    const out = rendered.getChannelData(0);
    const onset = onsetSample(out);
    const offset = offsetSample(out);
    const expectedFreq = 440 * 2 ** (semitones / 12);
    const metrics = {
      semitones,
      toneLengthSec: (offset - onset) / RATE,
      expectedToneLengthSec: 1,
      frequencyHz: toneFrequency(out, onset + Math.round(0.1 * RATE)),
      expectedFrequencyHz: expectedFreq,
      measuredFrequencyRatio: null,
    };
    metrics.measuredFrequencyRatio = metrics.frequencyHz / 440;
    const ok = Math.abs(metrics.toneLengthSec - 1) < 0.08
      && Math.abs(metrics.frequencyHz - expectedFreq) < 0.02 * expectedFreq;
    record(`S5-pitch-${semitones > 0 ? 'plus' : 'minus'}${Math.abs(semitones)}`, ok, metrics);
  }
}

async function s6_formants() {
  const mono = concat(silence(0.25), vowel(2, 110, VOWEL_A), silence(1));
  const windowStart = Math.round((0.25 + 0.6) * RATE);
  const windowLen = 16384;
  // Harmonic-amplitude envelope of the shifted fundamental, with parabolic
  // interpolation of the smoothed log envelope for sub-harmonic peak location.
  const envelope = (out, f0) => {
    const amps = [];
    for (let k = 1; k * f0 < 3400; k += 1) amps.push(goertzel(out, windowStart, windowLen, k * f0));
    const logA = amps.map((a) => Math.log(Math.max(1e-12, a)));
    const smooth = logA.map((v, i) => {
      let sum = 0;
      let count = 0;
      for (let j = i - 2; j <= i + 2; j += 1) {
        if (j >= 0 && j < logA.length) { sum += logA[j]; count += 1; }
      }
      return sum / count;
    });
    const peakIn = (band) => {
      let best = -1;
      for (let i = 0; i < smooth.length; i += 1) {
        const f = (i + 1) * f0;
        if (f < band[0] || f > band[1]) continue;
        if (best < 0 || smooth[i] > smooth[best]) best = i;
      }
      if (best < 1 || best >= smooth.length - 1) return { freq: NaN };
      // parabolic interpolation across neighbouring harmonics
      const [a, b, c] = [smooth[best - 1], smooth[best], smooth[best + 1]];
      const denom = a - 2 * b + c;
      const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
      return { freq: (best + 1 + delta) * f0 };
    };
    return { f1: peakIn([400, 1000]).freq, f2: peakIn([1000, 2000]).freq, amps };
  };

  const run = async (scheduleExtra) => {
    const { ctx, node } = await offlineNode(3.5);
    const rendered = await renderWithBuffer(node, ctx, mono, {
      output: 0, active: true, input: 0, rate: 1, formantBaseHz: 110, ...scheduleExtra,
    });
    return rendered.getChannelData(0);
  };

  const baseOut = await run({ semitones: 0 });
  const shift7 = { semitones: 7 };
  const noCompOut = await run({ ...shift7, formantCompensation: false });
  const compOut = await run({ ...shift7, formantCompensation: true });
  const explicitOut = await run({ ...shift7, formantSemitones: 0 });

  // Bit-level comparison settles whether the compensation flag changes output.
  let maxDiffNoCompVsComp = 0;
  let maxDiffNoCompVsExplicit = 0;
  for (let i = 0; i < noCompOut.length; i += 1) {
    maxDiffNoCompVsComp = Math.max(maxDiffNoCompVsComp, Math.abs(noCompOut[i] - compOut[i]));
    maxDiffNoCompVsExplicit = Math.max(maxDiffNoCompVsExplicit, Math.abs(noCompOut[i] - explicitOut[i]));
  }

  const shiftedF0 = 110 * 2 ** (7 / 12);
  const rows = [
    { name: 'unshifted', semitones: 0, ...envelope(baseOut, 110) },
    { name: 'shift7-no-compensation', semitones: 7, ...envelope(noCompOut, shiftedF0) },
    { name: 'shift7-formantCompensation-true', semitones: 7, ...envelope(compOut, shiftedF0) },
    { name: 'shift7-formantSemitones-0', semitones: 7, ...envelope(explicitOut, shiftedF0) },
  ].map(({ name, semitones, f1, f2 }) => ({ name, semitones, f1, f2 }));

  const metrics = {
    sourceFormantsHz: { f1: 730, f2: 1090 },
    harmonicResolutionNote: 'formants measured on the harmonic grid of the (shifted) f0 with parabolic interpolation',
    rows,
    maxDiffNoCompVsComp,
    maxDiffNoCompVsExplicit,
  };

  // PASS requires that some compensation setting demonstrably holds the
  // formant envelope nearer the unshifted peaks than the shifted ones move.
  const base = rows[0];
  const shiftedExpectedF1 = 730 * 2 ** (7 / 12);
  const moves = (row) => Math.abs(row.f1 - base.f1);
  const compHolds = rows.slice(2).some((row) => moves(row) + 30 < Math.abs(shiftedExpectedF1 - base.f1))
    && (maxDiffNoCompVsComp > 1e-4 || maxDiffNoCompVsExplicit > 1e-4);
  const ok = compHolds;
  record('S6-formant-compensation', ok, metrics,
    ok ? [] : [
      'no compensation setting demonstrably held the formant envelope',
      `no-comp vs comp max sample diff: ${maxDiffNoCompVsComp}`,
    ]);
}

async function s7_latencySeekTail() {
  const metrics = {};
  const probe = await offlineNode(1);
  const latencyValue = probe.node.latency ? await probe.node.latency() : null;
  metrics.latencySec = latencyValue == null ? null : JSON.parse(JSON.stringify(latencyValue));
  metrics.hasSeekFlush = typeof probe.node.seek === 'function' && typeof probe.node.flush === 'function';

  // Click at source 0.5 s: where does it land in the output?
  const click = concat(silence(0.5), sine(0.02, 1000, 0.9, 0.001), sine(1.2, 220, 0.3), silence(1));
  const { ctx, node } = await offlineNode(3);
  const rendered = await renderWithBuffer(node, ctx, click, {
    output: 0, active: true, input: 0, rate: 1, semitones: 0,
  });
  const out = rendered.getChannelData(0);
  const onset = onsetSample(out, 0.1);
  metrics.markerOnsetSample = onset;
  metrics.markerExpectedSample = Math.round(0.5 * RATE);
  metrics.markerErrorSamples = onset - Math.round(0.5 * RATE);

  // Tail: 1 s tone ends at source 1.5 s; how far does output ring past the
  // expected end (rate 1: output end = 1.5 s)?
  const offset = offsetSample(out, 0.001);
  metrics.tailSecAfterExpectedEnd = (offset - Math.round(1.5 * RATE)) / RATE;

  // Pre-roll: silence before the marker in the output.
  metrics.preRollSec = onset / RATE - 0.5;

  const ok = Math.abs(metrics.markerErrorSamples) < 0.02 * RATE && metrics.tailSecAfterExpectedEnd < 1;
  record('S7-latency-tail-seek', ok, metrics,
    metrics.hasSeekFlush ? ['seek/flush exposed on the web node'] : ['seek/flush not exposed on the web node; fixed-length alignment measured empirically']);
}

let rssWatcher = null;

async function s8_eightInstances(onSampleRss) {
  const tones = [220, 277, 330, 392, 440, 523, 587, 659];
  const rates = [0.5, 0.667, 0.75, 1, 1.333, 1.5, 1.75, 2];
  const semis = [0, 2, -2, 5, -5, 7, -7, 12];
  const seconds = 3;
  const ctx = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE);
  const master = ctx.createGain();
  master.gain.value = 0.1;
  master.connect(ctx.destination);
  const memBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
  const nodes = [];
  for (let i = 0; i < 8; i += 1) {
    const node = await SignalsmithStretch(ctx, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    await node.addBuffers([sine(1, tones[i]), sine(1, tones[i])]);
    node.schedule({
      output: 0, active: true, input: 0, rate: rates[i], semitones: semis[i],
    });
    node.connect(master);
    nodes.push(node);
  }
  const memLoaded = performance.memory ? performance.memory.usedJSHeapSize : null;
  if (onSampleRss) rssWatcher = onSampleRss(true);
  const t0 = performance.now();
  const rendered = await ctx.startRendering();
  const wallMs = performance.now() - t0;
  if (rssWatcher) {
    rssWatcher.stop();
    rssWatcher = null;
  }
  const memAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
  const out = rendered.getChannelData(0);
  const metrics = {
    instances: 8,
    audioSeconds: seconds,
    renderWallMs: Math.round(wallMs),
    cpuLoadFactor: wallMs / (seconds * 1000),
    peak: peakOf(out),
    // Physics: 8 coherent tones at amp 0.5 through a 0.1 master can reach 0.4.
    worstCaseCoherentPeak: 8 * 0.5 * 0.1,
    jsHeapBeforeBytes: memBefore,
    jsHeapLoadedBytes: memLoaded,
    jsHeapAfterRenderBytes: memAfter,
  };
  const ok = metrics.peak > 0.01 && metrics.peak <= metrics.worstCaseCoherentPeak + 0.02;
  record('S8-eight-instances', ok, metrics,
    ['JS heap excludes the WASM linear memory inside the worklet thread; see driver RSS samples']);
}

async function s9_realtimeLoad(onSampleRss) {
  const ctx = new AudioContext({ sampleRate: RATE });
  const metrics = { renderCapacityAvailable: typeof ctx.renderCapacity === 'object' };
  const underruns = [];
  if (ctx.renderCapacity) {
    ctx.renderCapacity.addEventListener('rendercapacitychange', (e) => underruns.push(e.underrunRatio));
  }
  const nodes = [];
  for (let i = 0; i < 8; i += 1) {
    const node = await SignalsmithStretch(ctx, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    await node.addBuffers([sine(2, 220 * (i + 1)), sine(2, 220 * (i + 1))]);
    node.schedule({
      output: ctx.currentTime, active: true, input: 0,
      rate: 0.5 + i * 0.2, semitones: i - 4,
      loopStart: 0, loopEnd: 2,
    });
    node.connect(ctx.destination);
    nodes.push(node);
  }
  const jitters = [];
  let last = performance.now();
  node_setInterval_shim(50, () => {
    const now = performance.now();
    jitters.push(now - last - 50);
    last = now;
  });
  const stopRss = onSampleRss ? onSampleRss(true) : null;
  await sleep(5000);
  if (stopRss) stopRss.stop();
  for (const n of nodes) n.disconnect();
  metrics.underrunSamples = underruns.length;
  metrics.maxUnderrunRatio = underruns.length ? Math.max(...underruns) : 0;
  metrics.meanUnderrunRatio = underruns.length
    ? underruns.reduce((a, b) => a + b, 0) / underruns.length : 0;
  metrics.callbackJitterMs = {
    mean: jitters.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, jitters.length),
    max: Math.max(...jitters.map(Math.abs)),
    samples: jitters.length,
  };
  metrics.soakSeconds = 5;
  await ctx.close();
  record('S9-realtime-load', true, metrics,
    ['headless Chromium has no physical output device; underrunRatio comes from AudioRenderCapacity, callback jitter is main-thread only']);
}

async function s10_boundedMemory(onSampleRss) {
  const ctx = new AudioContext({ sampleRate: RATE });
  const node = await SignalsmithStretch(ctx, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
  });
  const chunk = () => sine(5, 220, 0.3);
  const heapAfterLoad = [];
  const extents = [];
  const stopRss = onSampleRss ? onSampleRss(true) : null;
  // Feed a 60 s virtual stream in 5 s chunks while disposing anything older
  // than a 10 s window — the bounded-memory pattern for long recordings.
  for (let i = 0; i < 12; i += 1) {
    await node.addBuffers([chunk(), chunk()]);
    if (i >= 2) {
      const extent = await node.dropBuffers((i - 1) * 5);
      extents.push(extent);
    }
    if (performance.memory) heapAfterLoad.push(performance.memory.usedJSHeapSize);
    await sleep(30);
  }
  if (stopRss) stopRss.stop();
  node.disconnect();
  await ctx.close();
  const metrics = {
    fedSeconds: 60,
    retainedWindowSeconds: 10,
    extentSamples: extents.length,
    firstExtent: extents[0] ?? null,
    lastExtent: extents[extents.length - 1] ?? null,
    jsHeapSamples: heapAfterLoad.length,
    jsHeapFirst: heapAfterLoad[0] ?? null,
    jsHeapLast: heapAfterLoad[heapAfterLoad.length - 1] ?? null,
  };
  const windowHeld = metrics.lastExtent
    && (metrics.lastExtent.end - metrics.lastExtent.start) <= 15 * RATE + RATE;
  record('S10-bounded-memory', Boolean(windowHeld), metrics,
    windowHeld ? [] : ['dropBuffers did not keep the retained window bounded']);
}

// ---------- tiny runtime shims ----------

function sleep(ms) {
  return new Promise((resolve) => {
    const t = globalThis.constructor.name === 'Window' ? window : globalThis;
    t.setTimeout(resolve, ms);
  });
}

function node_setInterval_shim(ms, fn) {
  window.setInterval(fn, ms);
}

// ---------- run all ----------

window.__spikeRssHook = null; // driver installs an RSS sampler factory here

async function main() {
  const onSampleRss = window.__spikeRssHook;
  await s1_workletLive();
  await s2_offlineRenders();
  await s3_passthrough();
  await s4_stretchPreservesPitch();
  await s5_pitchPreservesDuration();
  await s6_formants();
  await s7_latencySeekTail();
  await s8_eightInstances(onSampleRss);
  await s9_realtimeLoad(onSampleRss);
  await s10_boundedMemory(onSampleRss);
  window.__spikeResults = results;
  window.__spikeDone = true;
}

main().catch((err) => {
  window.__spikeResults = results;
  window.__spikeError = String(err && err.stack ? err.stack : err);
  window.__spikeDone = true;
});
