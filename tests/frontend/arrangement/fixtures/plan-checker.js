// tests/frontend/arrangement/fixtures/plan-checker.js — independent reference
// for render-plan numbers. Plain arithmetic over the ProjectState; imports
// nothing from the engine. Decides one boundary question: do the plan's frame
// numbers match what the documented conventions imply?

/**
 * Recompute expected per-clip frames from the state and compare.
 * Returns { ok, mismatches }.
 */
export function checkRenderPlan(state, plan, options = {}) {
  const latency = options.latencyCompensationFrames ?? 0;
  const mismatches = [];
  const spb = 60 / state.transport.masterBpm;
  const sr = state.transport.sampleRate;

  for (const clip of state.clips) {
    const entry = plan.clips.find((c) => c.clipId === clip.id);
    if (!entry) {
      mismatches.push({ clipId: clip.id, field: 'presence', expected: 'in plan', actual: 'missing' });
      continue;
    }
    const asset = state.assets[clip.assetId];
    const rate = clip.stretchMode === 'beat_sync'
      ? state.transport.masterBpm / asset.nativeBpm
      : clip.customStretchRatio;

    const startSec = clip.timelineStartBeat * spb;
    const durSec = clip.durationBeats * spb;
    const spanSec = clip.durationBeats * spb * rate;

    // Region edges are quantised once (boundary convention, render-plan.js).
    const startFrame = Math.round((startSec + latency / sr) * sr);
    const endFrame = Math.round((startSec + durSec + latency / sr) * sr);
    const srcStart = Math.round(clip.sourceOffsetSec * sr);
    const srcEnd = Math.round(clip.sourceOffsetSec * sr + spanSec * sr);

    const expected = {
      timelineStartFrame: startFrame,
      timelineDurationFrames: endFrame - startFrame,
      sourceStartFrame: srcStart,
      sourceSpanFrames: srcEnd - srcStart,
      fadeInFrames: Math.round(clip.fadeInBeats * spb * sr),
      fadeOutFrames: Math.round(clip.fadeOutBeats * spb * sr),
    };
    for (const [field, want] of Object.entries(expected)) {
      const got = entry[field];
      if (Math.abs(got - want) > 1) {
        mismatches.push({ clipId: clip.id, field, expected: want, actual: got });
      }
    }
    // Pitch must be expressed as a frequency factor, never as a rate change.
    const wantFactor = 2 ** (clip.pitchSemitones / 12);
    if (Math.abs(entry.pitchFactor - wantFactor) > 1e-9) {
      mismatches.push({ clipId: clip.id, field: 'pitchFactor', expected: wantFactor, actual: entry.pitchFactor });
    }
    if (Math.abs(entry.rate - rate) > 1e-9) {
      mismatches.push({ clipId: clip.id, field: 'rate', expected: rate, actual: entry.rate });
    }
  }

  for (const track of state.tracks) {
    const entry = plan.tracks.find((t) => t.trackIndex === track.trackIndex);
    const anySolo = state.tracks.some((t) => t.solo);
    const wantAudible = anySolo ? track.solo : !track.mute;
    if (!entry || entry.audible !== wantAudible) {
      mismatches.push({
        clipId: `track-${track.trackIndex}`,
        field: 'audible',
        expected: wantAudible,
        actual: entry ? entry.audible : 'missing',
      });
    }
  }

  let end = 0;
  for (const clip of state.clips) {
    const asset = state.assets[clip.assetId];
    const rate = clip.stretchMode === 'beat_sync'
      ? state.transport.masterBpm / asset.nativeBpm
      : clip.customStretchRatio;
    const spb2 = 60 / state.transport.masterBpm;
    end = Math.max(end,
      Math.round((clip.timelineStartBeat * spb2 + clip.durationBeats * spb2) * sr));
  }
  if (plan.output.arrangementEndFrame !== end + latency) {
    // placement compensation shifts clip frames, so the end shifts too
    mismatches.push({ clipId: 'output', field: 'arrangementEndFrame', expected: end + latency, actual: plan.output.arrangementEndFrame });
  }
  return { ok: mismatches.length === 0, mismatches };
}
