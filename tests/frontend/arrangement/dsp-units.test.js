// tests/frontend/arrangement/dsp-units.test.js — node-side units for the shared
// limiter DSP and the WAV encoder. The limiter file is the SAME one loaded by
// both rendering hosts; these tests stub only the AudioWorklet globals.

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeWav24, readWavHeader } from '../../../src/twobecomeone/studio_static/js/arrangement/wav.js';

globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {} };
  }
};
const mod = await import('../../../src/twobecomeone/studio_static/js/arrangement/limiter-worklet.js');
const { LookaheadLimiter } = mod;

function runLimiter(chunks, options = {}) {
  const sr = options.sampleRate ?? 48000;
  const limiter = new LookaheadLimiter(sr, options);
  const outL = [];
  const outR = [];
  for (const [l, r] of chunks) {
    const ol = new Float32Array(l.length);
    const or_ = new Float32Array(r.length);
    limiter.processBlock(l, r, ol, or_);
    outL.push(ol);
    outR.push(or_);
  }
  return {
    l: Float32Array.from({ length: outL.reduce((n, c) => n + c.length, 0) }, (_, i) => {
      let at = i;
      for (const c of outL) {
        if (at < c.length) return c[at];
        at -= c.length;
      }
      return 0;
    }),
    r: Float32Array.from({ length: outR.reduce((n, c) => n + c.length, 0) }, (_, i) => {
      let at = i;
      for (const c of outR) {
        if (at < c.length) return c[at];
        at -= c.length;
      }
      return 0;
    }),
    limiter,
  };
}

function sine(n, freq, amp, sr = 48000) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

test('the limiter enforces the sample-peak ceiling on a hot tone', () => {
  const n = 48000;
  const tone = sine(n, 220, 1.5); // pre-limiter float sum may exceed full scale
  const { l, limiter } = runLimiter([[tone, tone]]);
  let peak = 0;
  for (const v of l) peak = Math.max(peak, Math.abs(v));
  const ceiling = 10 ** (-0.3 / 20);
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak} must not exceed ${ceiling}`);
  assert.ok(limiter.stats().maxReductionDb < -3, 'the hot tone must actually be reduced');
});

test('the limiter is transparent below the ceiling', () => {
  const n = 24000;
  const tone = sine(n, 330, 0.25);
  const { l, limiter } = runLimiter([[tone, tone]]);
  const delay = limiter.stats().latencyFrames;
  for (let i = delay + 1024; i < n; i += 1) {
    assert.ok(Math.abs(l[i] - tone[i - delay]) < 1e-4, 'quiet audio passes bit-close to unchanged');
  }
  assert.equal(limiter.stats().minGain, 1);
});

test('a transient cannot leak past the ceiling (brickwall)', () => {
  const n = 4800;
  const quiet = new Float32Array(n); // silence
  quiet[2400] = 1.2;                // single-sample transient over full scale
  const { l } = runLimiter([[quiet, quiet]]);
  const ceiling = 10 ** (-0.3 / 20);
  for (const v of l) assert.ok(Math.abs(v) <= ceiling + 1e-6);
});

test('gain reduction ramps smoothly: no sample-to-sample step from the limiter', () => {
  const n = 9600;
  const step = new Float32Array(n).fill(0.99); // square-ish hot signal
  const { l } = runLimiter([[step, step]]);
  // After the attack ramp settles, consecutive-sample deltas stay small.
  for (let i = 1200; i < n - 1; i += 1) {
    assert.ok(Math.abs(l[i + 1] - l[i]) < 0.05, `limiter introduced a step at ${i}`);
  }
});

test('the limiter reports its lookahead latency', () => {
  const { limiter } = runLimiter([[sine(256, 100, 0.1), sine(256, 100, 0.1)]], { lookaheadMs: 5, sampleRate: 48000 });
  assert.equal(limiter.stats().latencyFrames, 240); // 5 ms = 240 samples of lookahead delay
});

test('WAV encoding produces a canonical 24-bit PCM container', () => {
  const frames = 1000;
  const l = sine(frames, 440, 0.5, 48000);
  const r = sine(frames, 440, 0.25, 48000);
  const wav = encodeWav24([l, r], 48000);
  const h = readWavHeader(wav);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.data, 'data');
  assert.equal(h.audioFormat, 1);
  assert.equal(h.channels, 2);
  assert.equal(h.sampleRate, 48000);
  assert.equal(h.bitsPerSample, 24);
  assert.equal(h.dataSize, frames * 2 * 3);
  assert.equal(h.riffSize, 36 + h.dataSize);
  assert.equal(wav.byteLength, 44 + h.dataSize);
});

test('WAV encoding clamps beyond-full-scale samples instead of wrapping', () => {
  const wav = encodeWav24([Float32Array.from([1.5, -1.5])], 48000);
  const view = new DataView(wav);
  const sample = (at) => {
    const b0 = view.getUint8(at);
    const b1 = view.getUint8(at + 1);
    const b2 = view.getUint8(at + 2);
    let v = b0 | (b1 << 8) | (b2 << 16);
    if (v & 0x800000) v -= 16777216;
    return v;
  };
  assert.equal(sample(44), 8388607);   // clamped +full scale
  assert.equal(sample(47), -8388608);  // clamped -full scale
});

test('WAV encoding word-aligns odd data chunks (mono 24-bit)', () => {
  // One mono 24-bit frame is 3 data bytes: the file carries a pad byte, the
  // RIFF size counts it, and the data chunk size does not (Sol B8 regression).
  const wav = encodeWav24([Float32Array.from([0.5])], 48000);
  const h = readWavHeader(wav);
  assert.equal(h.dataSize, 3);
  assert.equal(h.riffSize, 40); // 36 + 3 + 1 pad
  assert.equal(wav.byteLength, 48); // 44 + 3 + 1 pad
});

test('WAV encoding rejects malformed channel input', () => {
  assert.throws(() => encodeWav24([], 48000), RangeError);
  assert.throws(() => encodeWav24([new Float32Array(10), new Float32Array(9)], 48000), RangeError);
  assert.throws(() => encodeWav24([new Float32Array(1), new Float32Array(1), new Float32Array(1)], 48000), RangeError);
});
