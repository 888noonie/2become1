// js/transport/normalize.js — deterministic DeckTransport normalizer.
//
// Part of the V1 Action and DeckTransport foundation (Phase 8B).
// Pure: no DOM/Web Audio/timer/fetch imports. Validates and normalizes a
// raw DeckTransport shape so every derived-position function operates on
// a fully typed, finite numeric description.
//
// Frozen transport shape:
//   {
//     deck: 'A' | 'B',
//     playing: boolean,
//     tempoBpm: 20..300,
//     beatsPerBar: 1..16,
//     phraseBars: 1..64,
//     beatAtStart: finite number,
//     startedAtAudioTime: finite number (audio-time seconds),
//     gridRevision: non-empty string,
//   }

import { buildFailure, buildSuccess, ERROR_CODES } from '../actions/errors.js';

export const TRANSPORT_DEFAULTS = Object.freeze({
  deck: 'A',
  playing: false,
  tempoBpm: 120,
  beatsPerBar: 4,
  phraseBars: 8,
  beatAtStart: 0,
  startedAtAudioTime: 0,
  gridRevision: 'grid-default',
});

const DECKS = Object.freeze(['A', 'B']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateTransport(raw) {
  if (!isPlainObject(raw)) {
    return buildFailure(ERROR_CODES.T_INVALID_TRANSPORT, { reason: 'not an object' });
  }
  if (!DECKS.includes(raw.deck)) {
    return buildFailure(ERROR_CODES.T_INVALID_DECK, { value: raw.deck });
  }
  if (typeof raw.playing !== 'boolean') {
    return buildFailure(ERROR_CODES.T_INVALID_PLAYING, { value: raw.playing });
  }
  if (!isFiniteNumber(raw.tempoBpm) || raw.tempoBpm < 20 || raw.tempoBpm > 300) {
    return buildFailure(ERROR_CODES.T_INVALID_TEMPO, { value: raw.tempoBpm });
  }
  if (!isFiniteNumber(raw.beatsPerBar) || raw.beatsPerBar < 1 || raw.beatsPerBar > 16
      || !Number.isInteger(raw.beatsPerBar)) {
    return buildFailure(ERROR_CODES.T_INVALID_SIGNATURE, { value: raw.beatsPerBar, field: 'beatsPerBar' });
  }
  if (!isFiniteNumber(raw.phraseBars) || raw.phraseBars < 1 || raw.phraseBars > 64
      || !Number.isInteger(raw.phraseBars)) {
    return buildFailure(ERROR_CODES.T_INVALID_SIGNATURE, { value: raw.phraseBars, field: 'phraseBars' });
  }
  if (!isFiniteNumber(raw.beatAtStart)) {
    return buildFailure(ERROR_CODES.T_INVALID_BEAT, { value: raw.beatAtStart, field: 'beatAtStart' });
  }
  if (!isFiniteNumber(raw.startedAtAudioTime)) {
    return buildFailure(ERROR_CODES.T_INVALID_TIME, { value: raw.startedAtAudioTime, field: 'startedAtAudioTime' });
  }
  if (!isNonEmptyString(raw.gridRevision)) {
    return buildFailure(ERROR_CODES.T_INVALID_GRID_REVISION, { value: raw.gridRevision });
  }
  return buildSuccess(raw);
}

export function normalizeTransport(raw, defaults = TRANSPORT_DEFAULTS) {
  const v = validateTransport(raw);
  if (!v.ok) return v;
  return buildSuccess(Object.freeze({
    deck: v.value.deck,
    playing: v.value.playing,
    tempoBpm: v.value.tempoBpm,
    beatsPerBar: v.value.beatsPerBar,
    phraseBars: v.value.phraseBars,
    beatAtStart: v.value.beatAtStart,
    startedAtAudioTime: v.value.startedAtAudioTime,
    gridRevision: v.value.gridRevision,
  }));
}
