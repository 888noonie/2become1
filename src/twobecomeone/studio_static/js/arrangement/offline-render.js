// js/arrangement/offline-render.js — arrangement graph builder + offline bounce.
//
// THE LIVING DAYLIGHTS GATE 3/5. Builds the mandatory signal flow from a render
// plan and executes it in an OfflineAudioContext (bounce) or a live
// AudioContext (real-time proof). ONE builder serves both hosts so their
// signal flow cannot diverge; the stretch DSP is the vendored Signalsmith
// module in both, and the limiter is the single limiter-worklet.js.
//
// Flow per clip: Source Slice -> Stretch/Pitch DSP -> Clip Gain + Micro-Fade
// -> 3-Band Track EQ -> Track Volume/Pan/Mute-Solo -> Master -> Limiter -> out.
//
// Nothing here writes to ProjectState; the plan is the only input.

const EQ_LOW_HZ = 250;
const EQ_MID_HZ = 1000;
const EQ_HIGH_HZ = 4000;

/**
 * @param {BaseAudioContext} ctx OfflineAudioContext or AudioContext
 * @param {object} plan from compileRenderPlan
 * @param {Record<string, {channels: Float32Array[]}>} buffers bufferReference -> PCM at plan.sampleRate
 * @param {{StretchFactory: Function, limiterModuleUrl: string,
 *          captureModuleUrl?: string, capture?: boolean,
 *          startDelaySec?: number, clipFilter?: (clip) => boolean}} options
 */
export async function buildArrangementGraph(ctx, plan, buffers, options) {
  const {
    StretchFactory,
    limiterModuleUrl,
    captureModuleUrl,
    capture = false,
    startDelaySec = 0,
    clipFilter = null,
  } = options;

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
  for (const clip of plan.clips) {
    if (clipFilter && !clipFilter(clip)) continue;
    const source = buffers[clip.bufferReference];
    if (!source) throw new Error(`no buffer for ${clip.bufferReference}`);
    const slice = source.channels.map((ch) => ch.subarray(clip.sourceStartFrame, clip.sourceEndFrame));

    const stretch = await StretchFactory(ctx, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    await stretch.addBuffers([slice[0], slice[1] ?? slice[0]]);

    const t0 = clip.timelineStartFrame / sr + startDelaySec;
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

    // Clip gain + fades (linear ramps; deterministic triangle when the fades
    // meet). Scheduled on the AudioParam clock, never on wall time.
    const clipGain = ctx.createGain();
    const lin = clip.clipGainLinear;
    const fadeInSec = clip.fadeInFrames / sr;
    const fadeOutSec = clip.fadeOutFrames / sr;
    let fadeDownStart = t1 - fadeOutSec;
    const fadeUpEnd = t0 + fadeInSec;
    if (fadeInSec > 0) {
      clipGain.gain.setValueAtTime(0, t0);
      clipGain.gain.linearRampToValueAtTime(lin, fadeUpEnd);
    } else {
      clipGain.gain.setValueAtTime(lin, t0);
    }
    if (fadeOutSec > 0) {
      if (fadeDownStart < fadeUpEnd) fadeDownStart = fadeUpEnd;
      clipGain.gain.setValueAtTime(lin, fadeDownStart);
      clipGain.gain.linearRampToValueAtTime(0, t1);
    } else {
      clipGain.gain.setValueAtTime(lin, t1);
    }
    // Region boundary: hold silence after the region (tails are faded out,
    // never left ringing under the next clip).
    clipGain.gain.setValueAtTime(0, t1 + 1 / sr);

    stretch.connect(clipGain).connect(trackInputs[clip.trackIndex]);
    stretchNodes.push(stretch);
  }

  return { master, limiter, limiterStats, captureNode, stretchNodes };
}

/** Offline bounce: render the plan to an AudioBuffer. */
export async function renderOffline(plan, buffers, options) {
  const frames = plan.output.totalFrames;
  const ctx = new OfflineAudioContext(plan.output.channels, frames, plan.sampleRate);
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const graph = await buildArrangementGraph(ctx, plan, buffers, options);
  const audioBuffer = await ctx.startRendering();
  const wallMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  // Release DSP instances and their buffers deterministically.
  for (const node of graph.stretchNodes) {
    node.disconnect();
    node.dropBuffers?.();
  }
  graph.limiter.disconnect();
  graph.master.disconnect();
  return { audioBuffer, limiterStats: graph.limiterStats, wallMs };
}

/**
 * Minimal real-time proof (GATE 5): the same builder on a live AudioContext,
 * captured at the master output. Transport/looping stay Milestone C.
 */
export async function startRealtime(plan, buffers, options) {
  const { ctx, listenSeconds = 4, startDelaySec = 0.25 } = options;
  const chunks = [];
  const graph = await buildArrangementGraph(ctx, plan, buffers, {
    ...options,
    capture: true,
    startDelaySec,
  });
  graph.captureNode.port.onmessage = (e) => {
    if (e.data && e.data.type === 'chunk') chunks.push(e.data);
  };
  await ctx.resume();
  await new Promise((resolve) => {
    setTimeout(resolve, (startDelaySec + listenSeconds) * 1000);
  });
  for (const node of graph.stretchNodes) node.stop?.();
  const frames = chunks.reduce((n, c) => n + c.l.length, 0);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let at = 0;
  for (const c of chunks) {
    l.set(c.l, at);
    r.set(c.r, at);
    at += c.l.length;
  }
  return { l, r, limiterStats: graph.limiterStats, capturedChunks: chunks.length };
}
