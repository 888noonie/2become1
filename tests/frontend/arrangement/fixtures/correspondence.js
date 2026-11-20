// tests/frontend/arrangement/fixtures/correspondence.js — independent reference
// for timeline/source correspondence.
//
// This checker deliberately re-derives the documented conventions with plain
// arithmetic instead of importing the engine's time-math helpers. It decides
// one boundary question only: does each clip's recorded region match what the
// operation log implies? Full semantics stay with the engine tests.

/**
 * Replay an operation log and compare every clip region with the engine state.
 * Ops: load, move, trimStart, trimEnd, split, stretch.
 * Returns { ok, mismatches }.
 */
export function checkSourceCorrespondence(engine, log) {
  const state = engine.state;
  const masterBpm = state.transport.masterBpm;
  // Independent reference model: id -> { start, dur, offset, mode, ratio, nativeBpm, durationSec }
  const ref = new Map();

  const rateOf = (r) => (r.mode === 'beat_sync' ? masterBpm / r.nativeBpm : r.ratio);
  const beatsToSource = (beats, r) => beats * (60 / masterBpm) * rateOf(r);

  for (const entry of log) {
    if (entry.op === 'load') {
      ref.set(entry.clipId, {
        start: 0,
        dur: entry.durationBeats,
        offset: 0,
        mode: entry.mode,
        ratio: entry.mode === 'manual' ? 1 : null,
        nativeBpm: entry.nativeBpm ?? null,
        durationSec: entry.durationSec,
      });
    } else if (entry.op === 'move') {
      const r = ref.get(entry.clipId);
      r.start = entry.newStartBeat;
    } else if (entry.op === 'trimStart') {
      const r = ref.get(entry.clipId);
      r.offset += beatsToSource(entry.deltaBeats, r);
      r.start += entry.deltaBeats;
      r.dur -= entry.deltaBeats;
    } else if (entry.op === 'trimEnd') {
      const r = ref.get(entry.clipId);
      r.dur += entry.deltaBeats;
    } else if (entry.op === 'split') {
      const r = ref.get(entry.clipId);
      const rel = entry.at - r.start;
      ref.set(entry.rightId, {
        ...r,
        start: entry.at,
        dur: r.dur - rel,
        offset: r.offset + beatsToSource(rel, r),
      });
      r.dur = rel;
    } else if (entry.op === 'stretch') {
      const r = ref.get(entry.clipId);
      if (entry.ratioOrAuto === 'auto') {
        r.mode = 'beat_sync';
        r.ratio = null;
      } else {
        r.mode = 'manual';
        r.ratio = entry.ratioOrAuto;
      }
    }
  }

  const mismatches = [];
  for (const [id, r] of ref) {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip) {
      mismatches.push({ id, field: 'presence', expected: 'clip exists', actual: 'missing' });
      continue;
    }
    const fields = {
      timelineStartBeat: r.start,
      durationBeats: r.dur,
      sourceOffsetSec: r.offset,
    };
    for (const [field, expected] of Object.entries(fields)) {
      const actual = clip[field];
      if (Math.abs(actual - expected) > 1e-6) {
        mismatches.push({ id, field, expected, actual });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
