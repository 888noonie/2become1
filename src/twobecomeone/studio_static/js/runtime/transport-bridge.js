// js/runtime/transport-bridge.js — derives live Deck B transport facts.
//
// Phase 10B. Pure module: no DOM, no Web Audio, no timers, no fetch. The
// Ghost controller calls it on demand (exactly once per proposal generation
// after decode — never in a render/tick loop; Sol amendment 12).
//
// Amendment 3 (server grid identity): the transport's gridRevision is NOT
// invented here. When a preview's transformSpec is available, the transport
// carries the SERVER-authored `destinationGridRevision` (grid-v1:<sha256>) and
// the bridge refuses to schedule if the live Lead identity/BPM/origin/interval
// facts diverge from the server's `destinationGrid` (a stale-grid failure).
// Without an asset (e.g. tests), a deterministic local identity is used only
// for pure math tests and is never accepted for real scheduling.
//
// Amendment 7 (ownership proof): playing===true is not enough. Prove the
// singleton player currently owns the project's LEAD track:
//   provider returns { trackId, playing, elementSeconds } and the caller
//   passes expectTrackId (the project's current lead_track_id).
//
// Amendment 6/plan: secondsToBeats is the EXACT inverse of the server slice
// formula (ghost_assets.py):
//   offset = first_beat + beat * 60 / bpm
//   => beat = (seconds - first_beat) * bpm / 60
// The tolerance for cross-language comparisons matches the server's
// six-decimal ffmpeg argument serialization (see SOL audit amendment 3).

export const BRIDGE_LANGUAGE_TOLERANCE_SECONDS = 5e-7;

export const BRIDGE_POLICY = Object.freeze({
  beatsPerBar: 4,
  phraseBars: 8,
});

/**
 * Convert element seconds to source beats on the track's grid.
 * Exact inverse of the server formula; override BPM vs grid interval
 * mismatch is preserved (bpm is the effective BPM, interval is the grid's).
 * @param {number} seconds
 * @param {{first_beat: number}} beatGrid
 * @param {number} bpm effective BPM (override ?? detected)
 * @returns {number}
 */
export function secondsToBeats(seconds, beatGrid, bpm) {
  return (seconds - Number(beatGrid.first_beat)) * (bpm / 60);
}

/**
 * Derive the deterministic local grid revision string (fallback identity).
 * Real scheduling carries the SERVER revision instead (A3).
 */
export function localGridRevision(track, bpm, policy = BRIDGE_POLICY) {
  const grid = track?.beat_grid || {};
  const parts = [
    'grid-v1-local',
    String(track?.id ?? ''),
    Number.isFinite(Number(bpm)) ? String(bpm) : '',
    Number.isFinite(Number(grid.first_beat)) ? String(grid.first_beat) : '',
    Number.isFinite(Number(grid.interval)) ? String(grid.interval) : '',
    String(policy.beatsPerBar),
    String(policy.phraseBars),
  ];
  return parts.join(':');
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Compare live Lead grid facts against the server's destinationGrid facts.
 * The server's destinationGrid carries intervalSeconds/originSeconds but NOT
 * bpm (bpm lives in transformSpec.targetBpm), so the caller passes targetBpm.
 * Returns null when compatible, or a stable failure code string.
 * @returns {'GRID_STALE'|null}
 */
export function checkGridParity(liveTrack, destinationGrid, targetBpm, tolerance) {
  const tol = finiteNumber(tolerance) ? tolerance : BRIDGE_LANGUAGE_TOLERANCE_SECONDS;
  if (!liveTrack || typeof liveTrack !== 'object' || !liveTrack.id) return 'GRID_STALE';
  if (!liveTrack.beat_grid || typeof liveTrack.beat_grid !== 'object') return 'GRID_STALE';
  const bpm = Number(liveTrack.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) return 'GRID_STALE';
  const firstBeat = Number(liveTrack.beat_grid.first_beat);
  const interval = Number(liveTrack.beat_grid.interval);
  if (!Number.isFinite(firstBeat) || !Number.isFinite(interval) || interval <= 0) {
    return 'GRID_STALE';
  }
  if (!destinationGrid || typeof destinationGrid !== 'object') return 'GRID_STALE';
  const serverBpm = Number(targetBpm);
  const serverOrigin = Number(destinationGrid.originSeconds);
  const serverInterval = Number(destinationGrid.intervalSeconds);
  if (!Number.isFinite(serverBpm) || !Number.isFinite(serverOrigin) || !Number.isFinite(serverInterval)) {
    return 'GRID_STALE';
  }
  if (Math.abs(firstBeat - serverOrigin) > tol) return 'GRID_STALE';
  if (Math.abs(interval - serverInterval) > tol) return 'GRID_STALE';
  if (Math.abs(bpm - serverBpm) > Math.max(tol, 1e-9)) return 'GRID_STALE';
  return null;
}

/**
 * Build a DeckTransport-shaped object for resolveNextPhrase().
 *
 * @param {object} args
 * @param {string} args.deck 'A' | 'B' (always 'B' in production Ghost flow)
 * @param {object} args.track the live Lead track record (id, bpm, beat_grid)
 * @param {number} args.elementSeconds current HTMLAudioElement time (s) — owned
 * @param {boolean} args.playing whether the element is audibly playing
 * @param {number} args.audioClockNow current AudioContext.currentTime
 * @param {string|null} [args.serverGridRevision] transformSpec.destinationGridRevision (A3)
 * @param {string} [args.expectTrackId] project's current lead_track_id (A7)
 * @returns {{ ok: true, value: object } | { ok: false, code: string }}
 */
export function buildDeckTransport({
  deck,
  track,
  elementSeconds,
  playing,
  audioClockNow,
  serverGridRevision = null,
  expectTrackId = null,
}) {
  if (deck !== 'A' && deck !== 'B') return { ok: false, code: 'T_INVALID_DECK' };
  if (!track || typeof track !== 'object') return { ok: false, code: 'T_TRACK_MISSING' };
  // A7: the transport must describe the LEAD track the project currently has.
  if (expectTrackId !== null && track.id !== expectTrackId) {
    return { ok: false, code: 'T_NOT_DESTINATION_TRACK' };
  }
  const bpm = Number(track.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) return { ok: false, code: 'T_INVALID_TEMPO' };
  const grid = track.beat_grid;
  if (!grid || typeof grid !== 'object') return { ok: false, code: 'T_GRID_MISSING' };
  const firstBeat = Number(grid.first_beat);
  const interval = Number(grid.interval);
  if (!Number.isFinite(firstBeat) || firstBeat < 0) return { ok: false, code: 'T_GRID_MISSING' };
  if (!Number.isFinite(interval) || interval <= 0) return { ok: false, code: 'T_GRID_MISSING' };
  if (!finiteNumber(elementSeconds) || elementSeconds < 0) {
    return { ok: false, code: 'T_ELEMENT_TIME_INVALID' };
  }
  if (!playing) return { ok: false, code: 'T_TRANSPORT_NOT_PLAYING' };
  if (!finiteNumber(audioClockNow)) return { ok: false, code: 'T_INVALID_TIME' };

  const beatAtStart = secondsToBeats(elementSeconds, grid, bpm);
  if (!Number.isFinite(beatAtStart)) return { ok: false, code: 'T_GRID_MISSING' };

  // A3: carry the server-authored revision when provided. The local string is
  // only a deterministic fallback for pure tests — the controller refuses to
  // schedule without the server revision (see ghost-controller.js).
  return {
    ok: true,
    value: {
      deck,
      playing: true,
      tempoBpm: bpm,
      beatsPerBar: BRIDGE_POLICY.beatsPerBar,
      phraseBars: BRIDGE_POLICY.phraseBars,
      beatAtStart,
      startedAtAudioTime: audioClockNow,
      gridRevision: serverGridRevision || localGridRevision(track, bpm),
    },
  };
}