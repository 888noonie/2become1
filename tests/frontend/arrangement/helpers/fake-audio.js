// tests/frontend/arrangement/helpers/fake-audio.js — a simulated Web Audio host
// for ENGINE-LEVEL tests of js/realtime-engine.js (OPERATION THE GOLDEN EAR II).
//
// This is not a DSP simulator. It reproduces the parts of the Web Audio API the
// real engine drives so lifecycle, timing and graph-ownership contracts can be
// proven deterministically in Node:
//
//   * a settable device clock (`ctx.currentTime`), advanced only by the test;
//   * AudioParam automation with the Web Audio evaluation rules the engine uses
//     (setValueAtTime, linearRampToValueAtTime, cancelScheduledValues,
//     cancelAndHoldAtTime) so a test can ask "what is this gate's gain at t?";
//   * a node registry with real connect/disconnect edges, so a test can count
//     the processors that are ACTUALLY connected (not the bookkeeping count);
//   * a fake Signalsmith node whose schedule() follows the vendored wrapper's
//     pop rule (SignalsmithStretch.mjs:91-94) against the context clock;
//   * a fake limiter AudioWorkletNode whose port can deliver stats messages.
//
// A simulated context establishes lifecycle correctness only. It is NOT proof
// of audible correctness; the bounded Chromium checks cover real worklets.

export class FakeAudioParam {
  constructor(ctx, value = 0) {
    this.ctx = ctx;
    this.initial = value;
    this.events = []; // { type: 'set'|'linear', t, v, seq }
    this._seq = 0;
    this.valueWritesWhileConnected = 0;
    this.owner = null;
  }

  get value() { return this.valueAt(this.ctx.currentTime); }

  set value(v) {
    if (this.owner && this.owner.outputs.size > 0) this.valueWritesWhileConnected += 1;
    if (this.events.length === 0) this.initial = v;
    else this.setValueAtTime(v, this.ctx.currentTime);
  }

  #check(t, v) {
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`automation time ${t} must be finite and >= 0`);
    if (!Number.isFinite(v)) throw new RangeError(`automation value ${v} must be finite`);
  }

  #insert(e) {
    e.seq = (this._seq += 1);
    this.events.push(e);
    this.events.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
  }

  setValueAtTime(v, t) { this.#check(t, v); this.#insert({ type: 'set', t, v }); return this; }

  linearRampToValueAtTime(v, t) { this.#check(t, v); this.#insert({ type: 'linear', t, v }); return this; }

  cancelScheduledValues(t) {
    this.#check(t, 0);
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }

  /**
   * Chromium-faithful cancelAndHoldAtTime (observed on real worklets, Golden
   * Ear II): a RAMP in progress across t is truncated to end at t with the held
   * value, but when no event lies after t NO hold point is inserted — a later
   * linearRampToValueAtTime then ramps from the previous event, not from t.
   */
  cancelAndHoldAtTime(t) {
    this.#check(t, 0);
    const held = this.valueAt(t);
    const after = this.events.filter((e) => e.t >= t);
    this.events = this.events.filter((e) => e.t < t);
    if (after.length && after[0].type === 'linear') this.#insert({ type: 'linear', t, v: held });
    return this;
  }

  /** Web Audio value at time t (set = step, linear = ramp from the previous event). */
  valueAt(t) {
    let prevV = this.initial;
    let prevT = 0;
    for (const e of this.events) {
      if (e.t > t) {
        if (e.type === 'linear') {
          const span = e.t - prevT;
          return span <= 0 ? e.v : prevV + ((e.v - prevV) * (t - prevT)) / span;
        }
        return prevV;
      }
      prevV = e.v;
      prevT = e.t;
    }
    return prevV;
  }
}

let nodeSeq = 0;

export class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = (nodeSeq += 1);
    this.outputs = new Set();
    this.inputs = new Set();
    this.disconnected = false;
    ctx.nodes.add(this);
  }

  connect(dest) {
    if (!dest || !(dest instanceof FakeNode)) throw new TypeError('connect() needs a node');
    this.outputs.add(dest);
    dest.inputs.add(this);
    this.disconnected = false;
    return dest;
  }

  disconnect() {
    for (const d of this.outputs) d.inputs.delete(this);
    this.outputs.clear();
    this.disconnected = true;
  }

  param(value) {
    const p = new FakeAudioParam(this.ctx, value);
    p.owner = this;
    return p;
  }
}

class FakeGain extends FakeNode {
  constructor(ctx) { super(ctx, 'gain'); this.gain = this.param(1); }
}

class FakeBiquad extends FakeNode {
  constructor(ctx) {
    super(ctx, 'biquad');
    this.type = 'lowpass';
    this.frequency = this.param(350);
    this.Q = this.param(1);
    this.gain = this.param(0);
  }
}

class FakePanner extends FakeNode {
  constructor(ctx) { super(ctx, 'panner'); this.pan = this.param(0); }
}

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }

  copyToChannel(src, c) { this.data[c].set(src.subarray(0, this.length)); }

  getChannelData(c) { return this.data[c]; }
}

class FakeBufferSource extends FakeNode {
  constructor(ctx) {
    super(ctx, 'bufferSource');
    this.buffer = null;
    this.startCalls = [];
    this.stopCalls = [];
  }

  start(when = 0, offset = 0) {
    if (this.startCalls.length) throw new Error('InvalidStateError: start() called twice');
    this.startCalls.push({ when, offset, calledAt: this.ctx.currentTime });
  }

  stop(when = 0) { this.stopCalls.push({ when, calledAt: this.ctx.currentTime }); }
}

/**
 * Fake Signalsmith node. schedule() follows the vendored wrapper's pop rule with
 * the CONTEXT clock as the anchor (the wrapper reads `currentTime` inside the
 * worklet when `outputTime` is absent), and records every call so a test can
 * prove what the engine actually sent.
 */
export class FakeStretchNode extends FakeNode {
  constructor(ctx) {
    super(ctx, 'stretch');
    this.calls = [];
    this.timeMap = [{ active: false, input: 0, output: 0, rate: 0 }];
    this.bufferFrames = 0;
    this.dropped = false;
  }

  async addBuffers(channels) {
    this.bufferFrames = channels[0].length;
    return this.bufferFrames;
  }

  schedule(objIn) {
    const anchor = ('outputTime' in objIn) ? objIn.outputTime : this.ctx.currentTime;
    let latest = this.timeMap[this.timeMap.length - 1];
    const popped = [];
    while (this.timeMap.length && this.timeMap[this.timeMap.length - 1].output >= anchor) {
      latest = this.timeMap.pop();
      popped.push(latest);
    }
    const obj = { ...latest, input: null, output: anchor, ...objIn };
    if (obj.input === null) {
      const rate = latest.active ? latest.rate : 0;
      obj.input = latest.input + (obj.output - latest.output) * rate;
    }
    this.timeMap.push(obj);
    this.calls.push({ obj: { ...objIn }, calledAt: this.ctx.currentTime, popped });
    return obj;
  }

  /** The segment governing output time t, and the input (seconds) it reads there. */
  inputAt(t) {
    let cur = this.timeMap[0];
    for (const s of this.timeMap) { if (s.output <= t) cur = s; }
    const rate = cur.active ? (cur.rate ?? 1) : 0;
    return { active: !!cur.active, input: cur.input + (t - cur.output) * rate };
  }

  dropBuffers() { this.dropped = true; }
}

export class FakeLimiterNode extends FakeNode {
  constructor(ctx, name, options) {
    super(ctx, `worklet:${name}`);
    this.name = name;
    this.options = options;
    this.port = { onmessage: null, postMessage() {} };
  }

  /** Deliver a stats message exactly as the limiter worklet posts it. */
  emitStats(stats) {
    this.port.onmessage?.({ data: { type: 'stats', ...stats } });
  }
}

export class FakeAudioContext {
  constructor({ sampleRate = 48000, currentTime = 0, offline = false, outputLatency = 0.032, baseLatency = 0 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = currentTime;
    this.outputLatency = outputLatency;
    this.baseLatency = baseLatency;
    this.state = 'running';
    this.nodes = new Set();
    this.listeners = new Map();
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = { modules: [], addModule: async (url) => { this.audioWorklet.modules.push(url); } };
    if (offline) this.startRendering = async () => null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }

  async resume() { this.resumeCalls = (this.resumeCalls ?? 0) + 1; if (this.state !== 'closed') this.setState('running'); }

  async suspend() { this.suspendCalls = (this.suspendCalls ?? 0) + 1; if (this.state !== 'closed') this.setState('suspended'); }

  async close() { this.setState('closed'); }

  /** Test hook: move the context to a new state and fire `statechange`. */
  setState(state) {
    this.state = state;
    for (const fn of this.listeners.get('statechange') ?? []) fn({ type: 'statechange' });
  }

  createGain() { return new FakeGain(this); }

  createBiquadFilter() { return new FakeBiquad(this); }

  createStereoPanner() { return new FakePanner(this); }

  createBuffer(channels, length, sampleRate) { return new FakeBuffer(channels, length, sampleRate); }

  createBufferSource() { return new FakeBufferSource(this); }

  /** Sound-producing nodes (bypass sources + stretch processors) still connected. */
  connectedProcessors() {
    let n = 0;
    for (const node of this.nodes) {
      if ((node.kind === 'stretch' || node.kind === 'bufferSource') && node.outputs.size > 0) n += 1;
    }
    return n;
  }

  stretchNodes() { return [...this.nodes].filter((n) => n.kind === 'stretch'); }

  bufferSources() { return [...this.nodes].filter((n) => n.kind === 'bufferSource'); }
}

/** Install the global AudioWorkletNode the shared backbone constructs. */
export function installFakeWorkletGlobal() {
  globalThis.AudioWorkletNode = FakeLimiterNode;
}

/**
 * A StretchFactory over FakeStretchNode. `beforeResolve(ctx)` runs inside the
 * async construction (e.g. to advance the clock and simulate slow construction,
 * or to return a promise the test resolves later).
 */
export function fakeStretchFactory({ beforeResolve = null } = {}) {
  const made = [];
  const factory = async (ctx) => {
    const node = new FakeStretchNode(ctx);
    made.push(node);
    if (beforeResolve) await beforeResolve(ctx, node);
    return node;
  };
  factory.made = made;
  return factory;
}

/** Flush pending promise jobs (several rounds, for chained awaits). */
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// ---------- plan fixtures ----------

export const SR = 48000;

/** A flat render plan (transparent EQ/pan) in the exact compileRenderPlan shape. */
export function flatPlan({ tracks = 8, clips = [], arrangementEndFrame = null, loopRange = null, masterBpm = 120 } = {}) {
  const end = arrangementEndFrame ?? clips.reduce((m, c) => Math.max(m, c.timelineEndFrame), 0);
  return {
    sampleRate: SR,
    masterBpm,
    loopRange,
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

/** One plan clip. Source frames are explicit; rate is source frames per output frame. */
export function planClip({ clipId, trackIndex = 0, start = 0, length, sourceStart = 0, rate = 1, pitch = 0, ref = 'src', fadeIn = 0, fadeOut = 0, gain = 1 }) {
  return {
    clipId,
    assetId: `asset-${ref}`,
    trackIndex,
    bufferReference: ref,
    timelineStartFrame: start,
    timelineEndFrame: start + length,
    sourceStartFrame: sourceStart,
    sourceEndFrame: sourceStart + Math.round(length * rate),
    rate,
    pitchSemitones: pitch,
    preserveFormants: false,
    clipGainLinear: gain,
    fadeInFrames: fadeIn,
    fadeOutFrames: fadeOut,
  };
}

export function silentSource(frames) {
  return { channels: [new Float32Array(frames), new Float32Array(frames)] };
}

/** Manual wake timers: the test decides when the scheduler wakes. */
export function manualTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout(fn, ms) { id += 1; pending.set(id, { fn, ms }); return id; },
    clearTimeout(i) { pending.delete(i); },
    /** Fire every currently pending wake (not ones scheduled while firing). */
    async fireAll() {
      const due = [...pending.entries()];
      for (const [i, t] of due) { pending.delete(i); await t.fn(); }
    },
  };
}
