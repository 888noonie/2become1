// components/ghost-phrase.js — the visible "Select phrase" Ghost UX (Phase 10C).
//
// Studio-route only. Owns:
//   - the friendly server-error -> copy map (codes never shown raw);
//   - honest client-side preconditions (convenience, never authority);
//   - the "Preview vocal phrase over Lead" dialog (numeric beat inputs are
//     the full keyboard/AT parity path for the waveform drag);
//   - Invoke/Release/Retry through the GhostController (never WITHOUT the
//     explicit Preview/Retry gesture).
//
// The server's beat↔seconds math is mirrored EXACTLY (inverse on the client):
//   server: offsetSeconds = first_beat + beat * 60 / effectiveBpm
//   client: beat = (seconds - first_beat) * effectiveBpm / 60

import { createElement } from '../dom.js';
import { openDialog } from './dialog.js';
import { showToast } from './toast.js';
import { openStemDialog } from './stem-dialog.js';
import { listStems } from '../api.js';
import { secondsToBeats } from '../runtime/transport-bridge.js';

// Plan limits (server-enforced; client checks are convenience only).
export const MIN_GHOST_REGION_BEATS = 1;
export const MAX_GHOST_REGION_BEATS = 64;
export const GAIN_MIN_DB = -24;
export const GAIN_MAX_DB = 12;
// Same stretch bounds as the server's bound atempo chain.
export const MIN_TEMPO_RATIO = 0.25;
export const MAX_TEMPO_RATIO = 4.0;

// Server error code -> friendly copy. Codes are NEVER shown raw to the user;
// they ARE console-logged for diagnosis.
const FRIENDLY_ERRORS = {
  S_STEM_UNAVAILABLE: 'Separate vocals on Foundation first.',
  S_STEM_NOT_VOCAL: 'Only a completed vocals stem can be previewed.',
  S_GRID_MISSING: 'Edit analysis first — BPM/beat grid is missing.',
  S_REGION_INCOMPLETE: 'Choose a phrase region between 1 and 64 beats.',
  S_REGION_OUT_OF_RANGE: 'Choose a phrase region between 1 and 64 beats.',
  S_REGION_BEYOND_MEDIA: 'That phrase runs past the end of the track.',
  S_DECK_NOT_TRACK: 'Choose a Foundation track first.',
  S_DESTINATION_INVALID: 'Choose a Lead track first.',
  S_TEMPO_RATIO_OUT_OF_RANGE: 'The tracks\' tempos are too far apart to preview.',
  S_ASSET_EXPIRED: 'That preview expired. Preview the phrase again.',
  S_PREPARATION_FAILED: 'The preview could not be prepared. Try again.',
  L_UNKNOWN_PROPOSAL: 'That preview no longer exists. Preview it again.',
  L_INVALID_TRANSITION: 'The preview is no longer active.',
  L_NOT_AUDITIONING: 'The preview is not running right now.',
  P_ACTOR_NOT_ALLOWED: 'Only a human can drive a Ghost preview.',
  P_PRODUCER_PREVIEW_DENIED: 'Only a human can drive a Ghost preview.',
  T_TRANSPORT_NOT_PLAYING: 'Start Lead playback first, then preview again.',
  GHOST_ACTIVE: 'A Ghost preview is already active. Release or Retry it first.',
  GHOST_STATE_CONFLICT: 'Several Ghost previews need Release. Release each one.',
  GHOST_HYDRATION_FAILED: 'Could not restore Ghost state. Try again.',
  GHOST_INTERRUPTED: 'An interrupted Ghost preview was restored. Release or Retry it.',
  LEAD_NOT_PLAYING: 'Start Lead playback first, then preview again.',
  LEAD_STOPPED: 'Lead playback changed. Release or Retry the Ghost.',
};

/** Map a server/controller error to friendly copy. Never throws. */
export function ghostErrorMessage(err) {
  const code = typeof err === 'object' && err !== null
    ? (err.code || null)
    : null;
  if (code && FRIENDLY_ERRORS[code]) {
    const message = FRIENDLY_ERRORS[code];
    if (typeof console !== 'undefined') console.log(`[ghost] ${code}`);
    return message;
  }
  const fallback = typeof err === 'object' && err !== null && typeof err.message === 'string'
    ? err.message
    : 'The Ghost preview could not be started.';
  if (typeof console !== 'undefined' && code) console.log(`[ghost] ${code}`);
  return fallback;
}

/** Effective BPM for a track record (override ?? detected — server parity). */
export function trackEffectiveBpm(track) {
  const bpm = Number(track?.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

/** Convert element seconds to source beats (inverse of the server formula). */
export function secondsToBeatsForTrack(seconds, track) {
  const bpm = trackEffectiveBpm(track);
  if (bpm === null || !track?.beat_grid) return null;
  return secondsToBeats(seconds, track.beat_grid, bpm);
}

/** Duration of one beat in seconds for a track (grid interval independent). */
export function beatSeconds(track) {
  const bpm = trackEffectiveBpm(track);
  return bpm === null ? null : 60 / bpm;
}

/**
 * Honest client-side preconditions BEFORE opening the dialog. Returns
 * { ok: true } or { ok: false, message, action? } where action names the
 * honest fix chosen by the user (never automatic).
 */
export function checkGhostPreconditions({ project, anchorTrack, leadTrack, playback }) {
  if (!project?.id) {
    return { ok: false, message: 'Create a mix first.' };
  }
  if (!anchorTrack) {
    return { ok: false, message: 'Choose a Foundation track first.' };
  }
  const anchorBpm = trackEffectiveBpm(anchorTrack);
  if (anchorBpm === null) {
    return { ok: false, message: 'Edit analysis first — Foundation BPM is missing.' };
  }
  if (!anchorTrack.beat_grid || !Number.isFinite(Number(anchorTrack.beat_grid?.first_beat))) {
    return { ok: false, message: 'Edit analysis first — Foundation beat grid is missing.' };
  }
  if (!leadTrack) {
    return { ok: false, message: 'Choose a Lead track first.' };
  }
  const leadBpm = trackEffectiveBpm(leadTrack);
  if (leadBpm === null) {
    return { ok: false, message: 'Edit analysis first — Lead BPM is missing.' };
  }
  if (!leadTrack.beat_grid || !Number.isFinite(Number(leadTrack.beat_grid?.interval))) {
    return { ok: false, message: 'Edit analysis first — Lead beat grid is missing.' };
  }
  const ratio = leadBpm / anchorBpm;
  if (ratio < MIN_TEMPO_RATIO || ratio > MAX_TEMPO_RATIO) {
    return { ok: false, message: FRIENDLY_ERRORS.S_TEMPO_RATIO_OUT_OF_RANGE };
  }
  if (!playback?.playing) {
    return { ok: false, message: FRIENDLY_ERRORS.T_TRANSPORT_NOT_PLAYING };
  }
  return { ok: true };
}

/**
 * Does a completed Demucs vocals stem exist for this track? Convenience
 * cache check only — the server re-validates authoritatively.
 */
export async function ensureVocalsStemKnown(trackId, store) {
  const cached = store.getState().stems?.[trackId];
  if (cached?.variants?.some((v) => v.name === 'vocals')) return true;
  try {
    const data = await listStems(trackId);
    store.dispatch({ type: 'stems/set', trackId, data });
    return Boolean(data?.variants?.some((v) => v.name === 'vocals'));
  } catch {
    return false; // honest unknown: the server will decide on submit
  }
}

/**
 * Open the "Preview vocal phrase over Lead" dialog.
 *
 * @param {object} opts
 * @param {object} opts.anchorTrack live Foundation track record
 * @param {object} opts.leadTrack live Lead track record
 * @param {{startSeconds?: number, endSeconds?: number}} [opts.preSelection]
 *   seconds from the waveform drag (converted to beats here).
 * @param {(region: {id?: string, startBeat: number, endBeat: number}, gainDb: number) => Promise<{ok: boolean, code?: string, error?: {code?: string, message?: string}}>} opts.onPreview
 * @param {HTMLElement} [opts.trigger]
 * @param {(message: string) => void} [opts.onAnnounce]
 * @returns {Promise<'previewed'|'cancelled'>}
 */
export async function openGhostPhraseDialog({
  anchorTrack,
  leadTrack,
  preselected = null,
  onPreview,
  trigger = null,
  onAnnounce,
}) {
  const bpm = trackEffectiveBpm(anchorTrack);
  const durationBeats = Math.floor(
    Math.max(0, (Number(anchorTrack.duration) || 0) - Number(anchorTrack.beat_grid?.first_beat) || 0) * (bpm / 60),
  );
  const maxEndBeat = Math.max(1, durationBeats);

  const startInput = createElement('input', {
    class: 'input', type: 'number', min: '0', step: '0.5', value: '0',
    'aria-label': 'Start beat',
  });
  const endInput = createElement('input', {
    class: 'input', type: 'number', min: '1', step: '0.5',
    'aria-label': 'End beat',
  });
  const gainInput = createElement('input', {
    class: 'input', type: 'number', min: String(GAIN_MIN_DB), max: String(GAIN_MAX_DB), step: '0.5', value: '-3',
    'aria-label': 'Preview gain in decibels',
  });

  // Bars helpers (8/16 bars at 4/4 from the current start).
  const barsRow = createElement('div', { class: 'ghost-dialog__bars' }, [
    createElement('button', {
      class: 'button', type: 'button', text: '8 bars',
      onclick: () => {
        const start = Number(startInput.value) || 0;
        startInput.value = String(start);
        endInput.value = String(Math.min(start + 32, maxEndBeat));
      },
    }),
    createElement('button', {
      class: 'button', type: 'button', text: '16 bars',
      onclick: () => {
        const start = Number(startInput.value) || 0;
        endInput.value = String(Math.min(start + 64, maxEndBeat));
      },
    }),
  ]);

  // Prefill from a waveform drag (seconds -> beats, exact inverse math).
  if (preselected) {
    const startBeats = secondsToBeatsForTrack(preselected.startSeconds, anchorTrack);
    const endBeats = secondsToBeatsForTrack(preselected.endSeconds, anchorTrack);
    if (startBeats !== null && endBeats !== null) {
      startInput.value = String(Math.max(0, Math.round(startBeats * 2) / 2));
      endInput.value = String(Math.max(1, Math.round(endBeats * 2) / 2));
    }
  } else {
    endInput.value = String(Math.min(8, maxEndBeat));
  }

  const form = createElement('div', { class: 'ghost-dialog' }, [
    createElement('p', {
      class: 'ghost-dialog__hint',
      text: `Foundation: ${anchorTrack.name || 'track'} (beats on its own grid). Lead: ${leadTrack.name || 'track'}.`,
    }),
    createElement('div', { class: 'ghost-dialog__grid' }, [
      createElement('label', { class: 'ghost-dialog__field' }, [
        createElement('span', { text: 'Start beat' }),
        startInput,
      ]),
      createElement('label', { class: 'ghost-dialog__field' }, [
        createElement('span', { text: 'End beat' }),
        endInput,
      ]),
      createElement('label', { class: 'ghost-dialog__field' }, [
        createElement('span', { text: 'Gain (dB)' }),
        gainInput,
      ]),
    ]),
    barsRow,
  ]);

  const result = await openDialog({
    title: 'Preview vocal phrase over Lead',
    description: 'The Ghost borrows Foundation vocals and auditions them over Lead at the next phrase boundary. Nothing is committed.',
    body: [form],
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Preview', value: 'preview', kind: 'primary' },
    ],
    trigger,
  });

  if (result !== 'preview') return 'cancelled';

  // Convenience validation (never authority). Every message is honest copy;
  // failures toast once and the dialog closes (the user reopens to correct).
  const startBeat = Number(startInput.value);
  const endBeat = Number(endInput.value);
  const gainDb = Number(gainInput.value);
  const rejectWith = (message) => {
    onAnnounce?.(message);
    showToast(message, 'danger');
    return 'cancelled';
  };

  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || !Number.isFinite(gainDb)) {
    return rejectWith('Enter numbers for start beat, end beat, and gain.');
  }
  if (startBeat < 0) {
    return rejectWith('Start beat cannot be negative.');
  }
  if (endBeat <= startBeat) {
    return rejectWith('End beat must be after the start beat.');
  }
  if (endBeat - startBeat < MIN_GHOST_REGION_BEATS || endBeat - startBeat > MAX_GHOST_REGION_BEATS) {
    return rejectWith(FRIENDLY_ERRORS.S_REGION_OUT_OF_RANGE);
  }
  if (endBeat > maxEndBeat) {
    return rejectWith(FRIENDLY_ERRORS.S_REGION_BEYOND_MEDIA);
  }
  if (gainDb < GAIN_MIN_DB || gainDb > GAIN_MAX_DB) {
    return rejectWith(`Gain must be between ${GAIN_MIN_DB} and ${GAIN_MAX_DB} dB.`);
  }

  const previewResult = await onPreview({
    id: `ghost-region-${startBeat}-${endBeat}`,
    startBeat,
    endBeat,
  }, gainDb);
  if (!previewResult.ok) {
    showToast(ghostErrorMessage(previewResult), 'danger');
    return 'cancelled';
  }
  return 'previewed';
}