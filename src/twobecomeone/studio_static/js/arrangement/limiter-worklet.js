// js/arrangement/limiter-worklet.js — lookahead brickwall limiter.
//
// THE LIVING DAYLIGHTS GATE 3/5. This file is the single limiter implementation
// and is loaded into BOTH the OfflineAudioContext (bounce) and the real-time
// AudioWorklet path (Milestone C). There is deliberately no offline-only copy.
//
// Algorithm (stereo-linked, sample-accurate):
//   - input is delayed by L = lookahead samples (ring buffer);
//   - need[i] = ceiling / peak over the L-sample window just pushed, i.e. the
//     gain that must be in effect when the loudest of those samples is output;
//   - f[i] = min(need[i], f[i-1] + releaseStep): instant drop (safe: the peak
//     is still ahead) and gradual release;
//   - applied gain g[i] = mean(f[i-L+1 .. i]). Because a peak's need enters f
//     exactly L samples before that peak is output, every f value averaged at
//     the peak's output moment is <= ceiling/peak: the sample-peak ceiling is
//     mathematically guaranteed while the attack stays a smooth ramp (no
//     click from instant gain steps).
//
// Guarantee scope: SAMPLE-peak <= ceiling at every output sample. Intersample
// (true) peaks are a separate measurement and are NOT claimed as protected.
//
// Gain-reduction statistics are posted to the main thread for measurement.

export const LIMITER_CEILING_DB = -0.3;

function defaultCeiling() {
  return 10 ** (LIMITER_CEILING_DB / 20);
}

export class LookaheadLimiter {
  constructor(sampleRate, options = {}) {
    const {
      ceiling = defaultCeiling(),
      lookaheadMs = 5,
      releaseMs = 50,
    } = options;
    this.sampleRate = sampleRate;
    this.ceiling = ceiling;
    this.lookahead = Math.max(2, Math.round((lookaheadMs / 1000) * sampleRate));
    this.releaseStep = 1 / Math.max(1, Math.round((releaseMs / 1000) * sampleRate));
    const L = this.lookahead;
    this.delayL = new Float32Array(L);
    this.delayR = new Float32Array(L);
    this.fWindow = new Float32Array(L).fill(1); // last L raw need-follow values
    this.pos = 0;
    this.f = 1;
    this.fSum = L; // running sum of fWindow
    this.minGain = 1;
    this.latencyFrames = L;
    this.sampleCursor = 0;
    /** Non-finite samples seen and zeroed (Gate 7). Reported through stats(). */
    this.nonFiniteCount = 0;
    this.firstNonFiniteIndex = -1;
  }

  /** Process one block of per-channel samples. Writes outL/outR in place. */
  processBlock(inL, inR, outL, outR) {
    const L = this.lookahead;
    for (let i = 0; i < inL.length; i += 1) {
      // Non-finite guard (Gate 7): a NaN or Infinity in the chain is an invalid
      // numerical result, not audio. Replace it with 0 BEFORE it can reach the
      // output or poison the gain computer, count it, and remember the first
      // index. This runs on the output path and is bounded (O(1) per sample).
      let sL = inL[i];
      let sR = inR[i];
      if (!Number.isFinite(sL)) {
        if (this.firstNonFiniteIndex < 0) this.firstNonFiniteIndex = this.sampleCursor + i;
        this.nonFiniteCount += 1;
        sL = 0;
      }
      if (!Number.isFinite(sR)) {
        if (this.firstNonFiniteIndex < 0) this.firstNonFiniteIndex = this.sampleCursor + i;
        this.nonFiniteCount += 1;
        sR = 0;
      }
      const p = this.pos;
      // Sliding peak of the window being pushed (O(L); L is 5 ms by default
      // and this stays deterministic across offline and real-time hosts).
      let peak = 0;
      for (let k = 0; k < L; k += 1) {
        const idx = (p + k) % L;
        let v = this.delayL[idx];
        if (v < 0) v = -v;
        if (v > peak) peak = v;
        v = this.delayR[idx];
        if (v < 0) v = -v;
        if (v > peak) peak = v;
      }
      let v = sL;
      if (v < 0) v = -v;
      if (v > peak) peak = v;
      v = sR;
      if (v < 0) v = -v;
      if (v > peak) peak = v;

      const need = peak > this.ceiling ? this.ceiling / peak : 1;
      this.f = need < this.f ? need : Math.min(need, this.f + this.releaseStep);

      // Smoothed gain: mean of the last L raw values (linear attack ramp).
      this.fSum -= this.fWindow[p];
      this.fWindow[p] = this.f;
      this.fSum += this.f;
      const gain = this.fSum / L;
      if (gain < this.minGain) this.minGain = gain;

      // Output the delayed sample; every averaged f value already covers it.
      outL[i] = this.delayL[p] * gain;
      outR[i] = this.delayR[p] * gain;
      this.delayL[p] = sL;
      this.delayR[p] = sR;
      this.pos = (p + 1) % L;
    }
    this.sampleCursor += inL.length;
  }

  stats() {
    return {
      minGain: this.minGain,
      maxReductionDb: this.minGain < 1 ? 20 * Math.log10(this.minGain) : 0,
      latencyFrames: this.latencyFrames,
      nonFiniteCount: this.nonFiniteCount,
      firstNonFiniteIndex: this.firstNonFiniteIndex,
    };
  }
}

// AudioWorklet registration (real-time + offline).
class LimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.limiter = new LookaheadLimiter(sampleRate, p);
    this.blocks = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inL = input && input[0] ? input[0] : new Float32Array(output[0].length);
    const inR = input && input[1] ? input[1] : inL;
    this.limiter.processBlock(inL, inR, output[0], output[1] || output[0]);
    this.blocks += 1;
    if (this.blocks % 256 === 0) {
      this.port.postMessage({ type: 'stats', ...this.limiter.stats() });
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('lookahead-limiter', LimiterProcessor);
}

// Node-side test seam (harmless inside the worklet scope).
globalThis.__LookaheadLimiter = LookaheadLimiter;
