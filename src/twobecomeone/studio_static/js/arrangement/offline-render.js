// js/arrangement/offline-render.js — arrangement graph builder + offline bounce.
//
// OPERATION THE LIVING DAYLIGHTS GATE 3/5. Builds the mandatory signal flow from a render
// plan and executes it in an OfflineAudioContext (bounce) or a live
// AudioContext (real-time proof). ONE builder serves both hosts so their
// signal flow cannot diverge; the stretch DSP is the vendored Signalsmith
// module in both, and the limiter is the single limiter-worklet.js.
//
// Flow per clip: Source Slice -> Stretch/Pitch DSP -> Clip Gain + Micro-Fade
// -> 3-Band Track EQ -> Track Volume/Pan/Mute-Solo -> Master -> Limiter -> out.
//
// Latency: the lookahead limiter delays every sample by its lookahead window.
// renderOffline renders that much extra and trims it from the head, so the
// returned buffer starts exactly at arrangement frame 0. The real-time path
// keeps the delay visible (live output is physically delayed) and reports it.
//
// Nothing here writes to ProjectState; the plan is the only input.

const EQ_LOW_HZ = 250;
const EQ_MID_HZ = 1000;
const EQ_HIGH_HZ = 4000;
/** Instance budget: one stretch WASM instance per rendered clip. */
export const MAX_CLIPS_PER_GRAPH = 32;

function limiterLookaheadFrames(plan) {
  return Math.max(2, Math.round((plan.limiter.lookaheadMs / 1000) * plan.sampleRate));
}

/** Frames of limiter lookahead delay renderOffline trims from the returned
 *  buffer, so sample 0 == arrangement frame 0 for every caller. */
export { limiterLookaheadFrames };

/**
 * @param {BaseAudioContext} ctx OfflineAudioContext or AudioContext
 * @param {object} plan from compileRenderPlan
 * @param {Record<string, {channels: Float32Array[]}>} buffers bufferReference -> PCM at plan.sampleRate
 * @param {{StretchFactory: Function, limiterModuleUrl: string,
 *          captureModuleUrl?: string, capture?: boolean,
 *          startDelaySec?: number, timeOriginSec?: number,
 *          clipFilter?: (clip) => boolean}} options
 */
export async function buildArrangementGraph(ctx, plan, buffers, options) {
  const {
    StretchFactory,
    limiterModuleUrl,
    captureModuleUrl,
    capture = false,
    startDelaySec = 0,
    timeOriginSec = 0,
    clipFilter = null,
  } = options;

  if (ctx.sampleRate !== plan.sampleRate) {
    throw new Error(
      `context sample rate ${ctx.sampleRate} does not match the plan (${plan.sampleRate}); `
      + 'feeding plan-domain PCM at another rate would change timing and pitch',
    );
  }
  const clips = plan.clips.filter((c) => !clipFilter || clipFilter(c));
  if (clips.length > MAX_CLIPS_PER_GRAPH) {
    throw new Error(
      `${clips.length} clips would construct ${clips.length} stretch instances; `
      + `the bounded budget is ${MAX_CLIPS_PER_GRAPH}`,
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

  let tail = limiter;
  let captureNode = null;
  if (capture) {
    captureNode = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    limiter.connect(captureNode);
    tail = captureNode;
  }
  tail.connect(ctx.destination);

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
    gain.gain.value = track.audible ? track.volumeLinear : 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan;
    low.connect(mid).connect(high).connect(gain).connect(panner).connect(master);
    trackInputs[track.trackIndex] = low;
  }

  const sr = plan.sampleRate;
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
      // Copied slices: a short slice must not retain (or ship) the full
      // backing buffer of a long source.
      const l = source.channels[0].slice(clip.sourceStartFrame, clip.sourceEndFrame);
      const r = (source.channels[1] ?? source.channels[0]).slice(clip.sourceStartFrame, clip.sourceEndFrame);

      const stretch = await StretchFactory(ctx, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      stretchNodes.push(stretch);
      await stretch.addBuffers([l, r]);

      const t0 = clip.timelineStartFrame / sr + startDelaySec + timeOriginSec;
      const durSec = clip.timelineDurationFrames / sr;
      const t1 = t0 + durSec;
      stretch.schedule({
        output: t0,
        active: true,
        input: 0,
        rate: clip.rate,
        semitones: clip.pitchSemitones,
        formantCompensation: clip.preserveFormants,
        formantBaseHz: 0,
      });

      // Clip gain + fades: half-open region [t0, t1). The gain is zero from
      // the origin (so no pre-ring can leak before the region), ramps over the
      // fade, and is exactly zero at the exclusive end (no one-sample overlap
      // into a neighbour).
      const clipGain = ctx.createGain();
      const lin = clip.clipGainLinear;
      const fadeInSec = clip.fadeInFrames / sr;
      const fadeOutSec = clip.fadeOutFrames / sr;
      clipGain.gain.setValueAtTime(0, 0);
      if (fadeInSec > 0) {
        clipGain.gain.setValueAtTime(0, t0);
        clipGain.gain.linearRampToValueAtTime(lin, t0 + fadeInSec);
      } else {
        clipGain.gain.setValueAtTime(lin, t0);
      }
      if (fadeOutSec > 0) {
        let fadeDownStart = t1 - fadeOutSec;
        const fadeUpEnd = t0 + fadeInSec;
        if (fadeDownStart < fadeUpEnd) fadeDownStart = fadeUpEnd;
        clipGain.gain.setValueAtTime(lin, fadeDownStart);
        clipGain.gain.linearRampToValueAtTime(0, t1);
      } else {
        clipGain.gain.setValueAtTime(0, t1);
      }

      stretch.connect(clipGain).connect(trackInputs[clip.trackIndex]);
    }
  } catch (err) {
    // A partially built graph must not leak instances or buffers.
    for (const node of stretchNodes) {
      node.disconnect();
      node.dropBuffers?.();
    }
    limiter.disconnect();
    master.disconnect();
    captureNode?.disconnect();
    throw err;
  }

  return {
    master,
    limiter,
    limiterStats,
    captureNode,
    stretchNodes,
    limiterLatencyFrames: limiterLookaheadFrames(plan),
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
  const latency = Math.max(2, Math.round((plan.limiter.lookaheadMs / 1000) * plan.sampleRate));
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
 * (timeOriginSec = ctx.currentTime). Transport/looping stay Milestone C.
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
