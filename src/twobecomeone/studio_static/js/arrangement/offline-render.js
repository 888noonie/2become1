// js/arrangement/offline-render.js — arrangement graph builder + offline bounce.
//
// OPERATION THE LIVING DAYLIGHTS GATE 3/5, extended by OPERATION CLOCKWORK (C1).
// Builds the mandatory signal flow from a render plan and executes it in an
// OfflineAudioContext (bounce) or a live AudioContext (real-time transport).
// ONE shared downstream serves both hosts so their signal flow cannot diverge
// (Milestone C1 GATE 6): the track EQ -> volume/pan/mute-solo -> master -> limiter
// chain is built ONCE here and reused by the live engine. The stretch DSP is the
// vendored Signalsmith module in both, and the limiter is the single
// limiter-worklet.js.
//
// Flow per clip: Source Slice -> Stretch/Pitch DSP (or bypass) -> Clip Gain +
// Micro-Fade -> 3-Band Track EQ -> Track Volume/Pan/Mute-Solo -> Master -> Limiter
// -> out.
//
// Latency: the lookahead limiter delays every sample by its lookahead window.
// renderOffline renders that much extra and trims it from the head, so the
// returned buffer starts exactly at arrangement frame 0. The real-time path
// keeps the delay visible (live output is physically delayed) and reports it.
//
// Nothing here writes to ProjectState; the plan is the only input.

import { scheduleGainEnvelope, schedulePanEnvelope } from './automation.js';
import { createTransportMap } from './transport.js';
import { clipNeedsDsp, clipRoute } from './time-math.js';

const EQ_LOW_HZ = 250;
const EQ_MID_HZ = 1000;
const EQ_HIGH_HZ = 4000;
/** Instance budget: one stretch WASM instance per rendered clip/voice. */
export const MAX_CLIPS_PER_GRAPH = 32;

function limiterLookaheadFrames(plan) {
  return Math.max(2, Math.round((plan.limiter.lookaheadMs / 1000) * plan.sampleRate));
}

/** Frames of limiter lookahead delay renderOffline trims from the returned
 *  buffer, so sample 0 == arrangement frame 0 for every caller. */
export { limiterLookaheadFrames };

/**
 * Build the SHARED downstream (Milestone C1 GATE 6): the limiter, optional
 * capture tap, master gain and the eight track chains (EQ -> volume -> pan).
 * Both the offline bounce and the live engine build voices INTO this backbone,
 * so gain, EQ, pan, summing and the limiter contracts are identical in both.
 *
 * @param {BaseAudioContext} ctx OfflineAudioContext or AudioContext
 * @param {object} plan from compileRenderPlan
 * @param {{StretchFactory: Function, limiterModuleUrl: string,
 *          captureModuleUrl?: string, capture?: boolean}} options
 * @returns {Promise<{master, limiter, limiterStats, captureNode, trackInputs,
 *   limiterLatencyFrames, dispose}>}
 */
export async function buildBackbone(ctx, plan, options) {
  const {
    limiterModuleUrl, captureModuleUrl, capture = false, destination = null,
  } = options;
  if (ctx.sampleRate !== plan.sampleRate) {
    throw new Error(
      `context sample rate ${ctx.sampleRate} does not match the plan (${plan.sampleRate}); `
      + 'feeding plan-domain PCM at another rate would change timing and pitch',
    );
  }
  await ctx.audioWorklet.addModule(limiterModuleUrl);
  if (capture) await ctx.audioWorklet.addModule(captureModuleUrl);

  const limiter = new AudioWorkletNode(ctx, 'lookahead-limiter', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      ceiling: plan.limiter.ceilingLinear,
      lookaheadMs: plan.limiter.lookaheadMs,
      releaseMs: plan.limiter.releaseMs,
    },
  });
  const limiterStats = [];
  limiter.port.onmessage = (e) => {
    if (e.data && e.data.type === 'stats') limiterStats.push(e.data);
  };

  let tailNode = limiter;
  let captureNode = null;
  if (capture) {
    captureNode = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    limiter.connect(captureNode);
    tailNode = captureNode;
  }
  // `destination` lets a live host insert its own monitor-level stage (the
  // audition page's conservative output level). Offline bounces omit it.
  tailNode.connect(destination ?? ctx.destination);

  const master = ctx.createGain();
  master.gain.value = plan.master.gainLinear;
  master.connect(limiter);

  // Track chains (build all eight; plan.audible decides their gain).
  const trackInputs = [];
  for (const track of plan.tracks) {
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = EQ_LOW_HZ;
    low.gain.value = track.eq.lowGainDb;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = EQ_MID_HZ;
    mid.Q.value = 1;
    mid.gain.value = track.eq.midGainDb;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = EQ_HIGH_HZ;
    high.gain.value = track.eq.highGainDb;
    const gain = ctx.createGain();
    const hasGainCurve = Array.isArray(track.gainPoints) && track.gainPoints.length > 0;
    // Assigning .value inserts setValueAtTime at currentTime. On an offline
    // context that time is 0, the same sample as the first breakpoint, and
    // whichever write lands last owns the downbeat. When points exist, leave
    // the parameter alone; scheduleOfflineEnvelopes writes the breakpoint.
    if (!hasGainCurve) gain.gain.value = track.audible ? track.volumeLinear : 0;
    const panner = ctx.createStereoPanner();
    const hasPanCurve = Array.isArray(track.panPoints) && track.panPoints.length > 0;
    if (!hasPanCurve) panner.pan.value = track.pan;
    low.connect(mid).connect(high).connect(gain).connect(panner).connect(master);
    trackInputs[track.trackIndex] = low;
    trackInputs[`gain-${track.trackIndex}`] = gain; // for ramped live mute/solo
    trackInputs[`pan-${track.trackIndex}`] = panner;
    trackInputs[`eq-${track.trackIndex}`] = { low, mid, high }; // live EQ moves
  }

  function dispose() {
    limiter.disconnect();
    master.disconnect();
    captureNode?.disconnect();
    if (captureNode) captureNode.port.onmessage = null;
  }

  return {
    master,
    limiter,
    limiterStats,
    captureNode,
    tailNode,
    trackInputs,
    limiterLatencyFrames: limiterLookaheadFrames(plan),
    dispose,
  };
}

/**
 * The musical clip envelope (gain + micro-fades) on [t0, t1), shared by the
 * offline bounce (inside buildClipVoice) and the live engine (at arm time).
 * The call sequence is exactly the Milestone B one.
 */
export function applyClipEnvelope(param, clip, t0, t1, sr) {
  const lin = clip.clipGainLinear;
  const fadeInSec = clip.fadeInFrames / sr;
  const fadeOutSec = clip.fadeOutFrames / sr;
  param.setValueAtTime(0, 0);
  if (fadeInSec > 0) {
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(lin, t0 + fadeInSec);
  } else {
    param.setValueAtTime(lin, t0);
  }
  if (fadeOutSec > 0) {
    let fadeDownStart = t1 - fadeOutSec;
    const fadeUpEnd = t0 + fadeInSec;
    if (fadeDownStart < fadeUpEnd) fadeDownStart = fadeUpEnd;
    param.setValueAtTime(lin, fadeDownStart);
    param.linearRampToValueAtTime(0, t1);
  } else {
    param.setValueAtTime(0, t1);
  }
}

/**
 * Build one clip's source -> DSP/bypass -> clipGain chain feeding `dest`.
 * Shared by the offline per-clip build and the live per-occurrence voice so the
 * bypass decision (clipNeedsDsp) and the clip-gain law are identical.
 *
 * `dspBypass` selects whether a no-stretch/no-pitch clip uses a sample-exact
 * AudioBufferSourceNode (true) or the stretch path (false). The accepted offline
 * bounce passes dspBypass:false (all-stretch, byte-compatible with the audited
 * artifact); the live engine passes dspBypass:true to exploit the shared
 * predicate. clipNeedsDsp is the single decision in both.
 */
export async function buildClipVoice(ctx, clip, source, options) {
  const {
    StretchFactory, dspBypass = false, startDelaySec = 0, timeOriginSec = 0,
    arm = true,
  } = options;
  const sr = clip.sampleRate ?? options.sampleRate ?? 48000;
  const l = source.channels[0].slice(clip.sourceStartFrame, clip.sourceEndFrame);
  const r = (source.channels[1] ?? source.channels[0]).slice(clip.sourceStartFrame, clip.sourceEndFrame);

  const t0 = clip.timelineStartFrame / sr + startDelaySec + timeOriginSec;
  const durSec = clip.timelineDurationFrames / sr;
  const t1 = t0 + durSec;

  // Clip gain + fades: half-open region [t0, t1). Zero from the origin (no
  // pre-ring before the region), ramps over the fade, exactly zero at the end.
  // With `arm: false` (live engine) the envelope is applied by the caller at arm
  // time through applyClipEnvelope, so an epoch can still be re-anchored.
  const clipGain = ctx.createGain();
  if (arm) applyClipEnvelope(clipGain.gain, clip, t0, t1, sr);

  const needsDsp = clipNeedsDsp(clip.rate, clip.pitchSemitones);
  let head;
  let stretch = null;
  // The ONE routing decision (time-math.js clipRoute): `dspBypass` selects the
  // host policy — live 'bypass-unity' or the accepted offline 'stretch-all'.
  if (clipRoute(clip.rate, clip.pitchSemitones, dspBypass ? 'live' : 'offline') === 'bypass') {
    // Bypass: sample-exact AudioBufferSourceNode (no algorithmic latency/priming).
    const buf = ctx.createBuffer(2, l.length, sr);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    head = ctx.createBufferSource();
    head.buffer = buf;
    if (arm) head.start(t0, 0);
  } else {
    // Stretch/pitch path (the vendored Signalsmith node).
    stretch = await StretchFactory(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    await stretch.addBuffers([l, r]);
  }
  // `arm: false` (the live engine): the caller measures the real lead to t0
  // and sends the start itself — the legal Signalsmith arm-now + one-future-
  // stop pair, or the bypass start/stop — or refuses a late voice. The offline
  // bounce keeps `arm: true`: one future arm, unchanged from Milestone B.
  if (arm && stretch) {
    stretch.schedule({
      output: t0,
      active: true,
      input: 0,
      rate: clip.rate,
      semitones: clip.pitchSemitones,
      formantCompensation: clip.preserveFormants,
      formantBaseHz: 0,
    });
  }
  if (stretch) head = stretch;
  head.connect(clipGain);
  return {
    head, stretch, clipGain, needsDsp, t0, t1, sliceFrames: l.length,
  };
}

/**
 * One offline timeline. `plan.loopRange` is ignored: the bounce does not
 * unroll the live loop. Times are `originSec + frame / sampleRate`, the same
 * clock as the clips (`startDelaySec + timeOriginSec`, both 0 in renderOffline).
 * The limiter lookahead is not added here.
 */
export function scheduleOfflineEnvelopes(backbone, plan, originSec) {
  const map = createTransportMap({ startFrame: 0, loop: null, sampleRate: plan.sampleRate });
  for (const track of plan.tracks) {
    if (!track.gainPoints?.length) continue;
    const param = backbone.trackInputs[`gain-${track.trackIndex}`]?.gain;
    if (!param) continue;
    scheduleGainEnvelope(param, track, {
      originSec,
      map,
      sampleRate: plan.sampleRate,
      bpm: plan.masterBpm,
      audible: track.audible,
      now: originSec,
      fullTimeline: true,
    });
  }
  for (const track of plan.tracks) {
    if (!track.panPoints?.length) continue;
    const param = backbone.trackInputs[`pan-${track.trackIndex}`]?.pan;
    if (!param) continue;
    schedulePanEnvelope(param, track, {
      originSec,
      map,
      sampleRate: plan.sampleRate,
      bpm: plan.masterBpm,
      now: originSec,
      fullTimeline: true,
    });
  }
}

/**
 * @param {BaseAudioContext} ctx OfflineAudioContext or AudioContext
 * @param {object} plan from compileRenderPlan
 * @param {Record<string, {channels: Float32Array[]}>} buffers bufferReference -> PCM at plan.sampleRate
 * @param {{StretchFactory: Function, limiterModuleUrl: string,
 *          captureModuleUrl?: string, capture?: boolean,
 *          startDelaySec?: number, timeOriginSec?: number,
 *          clipFilter?: (clip) => boolean, dspBypass?: boolean}} options
 */
export async function buildArrangementGraph(ctx, plan, buffers, options) {
  const {
    StretchFactory, startDelaySec = 0, timeOriginSec = 0, clipFilter = null,
    dspBypass = false,
  } = options;

  const clips = plan.clips.filter((c) => !clipFilter || clipFilter(c));
  if (clips.length > MAX_CLIPS_PER_GRAPH) {
    throw new Error(
      `${clips.length} clips would construct ${clips.length} stretch instances; `
      + `the bounded budget is ${MAX_CLIPS_PER_GRAPH}`,
    );
  }

  const backbone = await buildBackbone(ctx, plan, options);
  // One timeline. plan.loopRange is not unrolled into the bounce, and events
  // are not shifted by the limiter lookahead. The trim in renderOffline is
  // what makes sample 0 equal arrangement frame 0.
  scheduleOfflineEnvelopes(backbone, plan, startDelaySec + timeOriginSec);
  const { trackInputs, limiterLatencyFrames } = backbone;

  const stretchNodes = [];
  try {
    for (const clip of clips) {
      const source = buffers[clip.bufferReference];
      if (!source) throw new Error(`no buffer for ${clip.bufferReference}`);
      // Reject an incomplete source instead of silently truncating it.
      for (const ch of source.channels) {
        if (ch.length < clip.sourceEndFrame) {
          throw new Error(
            `buffer ${clip.bufferReference} holds ${ch.length} frames but its plan region `
            + `ends at ${clip.sourceEndFrame}`,
          );
        }
      }
      const voice = await buildClipVoice(ctx, { ...clip, sampleRate: plan.sampleRate }, source, {
        StretchFactory, dspBypass, startDelaySec, timeOriginSec, sampleRate: plan.sampleRate,
      });
      if (voice.stretch) stretchNodes.push(voice.stretch);
      voice.clipGain.connect(trackInputs[clip.trackIndex]);
    }
  } catch (err) {
    // A partially built graph must not leak instances or buffers.
    for (const node of stretchNodes) {
      node.disconnect();
      node.dropBuffers?.();
    }
    backbone.dispose();
    throw err;
  }

  return {
    master: backbone.master,
    limiter: backbone.limiter,
    limiterStats: backbone.limiterStats,
    captureNode: backbone.captureNode,
    stretchNodes,
    trackInputs,
    limiterLatencyFrames,
  };
}

/** Release every runtime resource a finished graph holds. */
function disposeGraph(graph) {
  for (const node of graph.stretchNodes) {
    node.disconnect();
    node.dropBuffers?.();
  }
  graph.limiter.disconnect();
  graph.master.disconnect();
  graph.captureNode?.disconnect();
  if (graph.captureNode) graph.captureNode.port.onmessage = null;
}

/**
 * Offline bounce: render the plan to an AudioBuffer that starts exactly at
 * arrangement frame 0 (the limiter's lookahead delay is rendered and trimmed).
 */
export async function renderOffline(plan, buffers, options) {
  const frames = plan.output.totalFrames;
  const latency = limiterLookaheadFrames(plan);
  const ctx = new OfflineAudioContext(plan.output.channels, frames + latency, plan.sampleRate);
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const graph = await buildArrangementGraph(ctx, plan, buffers, options);
  const rendered = await ctx.startRendering();
  const wallMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  // Trim the limiter's lookahead delay from the head: the caller receives
  // sample 0 == arrangement frame 0, with the plan's tail at the end.
  const audioBuffer = ctx.createBuffer(2, frames, plan.sampleRate);
  for (let c = 0; c < rendered.numberOfChannels; c += 1) {
    audioBuffer.copyToChannel(rendered.getChannelData(c).slice(latency, latency + frames), c);
  }
  disposeGraph(graph);
  return { audioBuffer, limiterStats: graph.limiterStats, wallMs, limiterLatencyFrames: latency };
}

/**
 * Minimal real-time proof (GATE 5): the same builder on a live AudioContext,
 * captured at the master output. Schedules against the context's own clock
 * (timeOriginSec = ctx.currentTime). Transport/looping live in realtime-engine.js.
 */
export async function startRealtime(plan, buffers, options) {
  const { ctx, listenSeconds = 4, startDelaySec = 0.25 } = options;
  const chunks = [];
  const graph = await buildArrangementGraph(ctx, plan, buffers, {
    ...options,
    capture: true,
    startDelaySec,
    timeOriginSec: ctx.currentTime,
  });
  graph.captureNode.port.onmessage = (e) => {
    if (e.data && e.data.type === 'chunk') chunks.push(e.data);
  };
  await ctx.resume();
  await new Promise((resolve) => {
    setTimeout(resolve, (startDelaySec + listenSeconds) * 1000);
  });
  for (const node of graph.stretchNodes) node.stop?.();
  // Stop the capture and release the graph before returning: nothing keeps
  // accumulating after this call.
  graph.captureNode.port.onmessage = null;
  const frames = chunks.reduce((n, c) => n + c.l.length, 0);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let at = 0;
  for (const c of chunks) {
    l.set(c.l, at);
    r.set(c.r, at);
    at += c.l.length;
  }
  disposeGraph(graph);
  return {
    l,
    r,
    limiterStats: graph.limiterStats,
    capturedChunks: chunks.length,
    limiterLatencyFrames: graph.limiterLatencyFrames,
    startDelaySec,
  };
}
