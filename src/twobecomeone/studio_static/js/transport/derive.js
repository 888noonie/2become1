// js/transport/derive.js — derived position and next-phrase resolution.
//
// Part of the V1 Action and DeckTransport foundation (Phase 8B).
// Pure numerical planning: no Web Audio, timers, rAF, or live clock.
//
// Formulas:
//   beatsPerSecond = tempoBpm / 60
//   beatAt(t) = beatAtStart + (t - startedAtAudioTime) * beatsPerSecond
//   phraseBeats = beatsPerBar * phraseBars
//
// resolveNextPhrase always returns the *following* phrase boundary. If the
// supplied nowAudioTime is exactly on a boundary, the next (not current)
// phrase is chosen. A tiny epsilon (PHRASE_EPSILON) is used only to keep
// FP-stable comparisons deterministic; no audio is scheduled.

import { buildFailure, buildSuccess, ERROR_CODES } from '../actions/errors.js';
import { normalizeTransport } from './normalize.js';

export const PHRASE_EPSILON = 1e-9;

export function beatsPerSecond(tempoBpm) {
  return tempoBpm / 60;
}

export function phraseBeats(beatsPerBar, phraseBars) {
  return beatsPerBar * phraseBars;
}

export function beatAtTime(transport, nowAudioTime) {
  const bps = beatsPerSecond(transport.tempoBpm);
  return transport.beatAtStart + (nowAudioTime - transport.startedAtAudioTime) * bps;
}

export function derivedPosition(transport, nowAudioTime) {
  const beat = beatAtTime(transport, nowAudioTime);
  const pb = phraseBeats(transport.beatsPerBar, transport.phraseBars);
  const phraseIndex = Math.floor(beat / pb);
  const phrasePosition = beat - phraseIndex * pb;
  const beatPhase = phrasePosition % transport.beatsPerBar;
  return Object.freeze({
    nowAudioTime,
    beat,
    beatPhase,
    phraseIndex,
    phrasePosition,
    phraseBeats: pb,
    gridRevision: transport.gridRevision,
  });
}

export function resolveNextPhrase(rawTransport, nowAudioTime) {
  const norm = normalizeTransport(rawTransport);
  if (!norm.ok) return norm;
  const transport = norm.value;
  if (!transport.playing) {
    return buildFailure(ERROR_CODES.T_TRANSPORT_NOT_PLAYING);
  }
  if (!Number.isFinite(nowAudioTime)) {
    return buildFailure(ERROR_CODES.T_INVALID_TIME, { value: nowAudioTime, field: 'nowAudioTime' });
  }

  const beat = beatAtTime(transport, nowAudioTime);
  const pb = phraseBeats(transport.beatsPerBar, transport.phraseBars);

  // Always the following phrase. If exactly on a boundary, advance to the
  // next one. Epsilon is applied before floor so tiny FP jitter around a
  // mathematically exact boundary lands deterministically on the boundary.
  const adjustedBeat = Math.abs(beat - Math.round(beat / pb) * pb) < PHRASE_EPSILON
    ? Math.round(beat / pb) * pb
    : beat;
  const currentPhraseIndex = Math.floor(adjustedBeat / pb);
  const nextPhraseIndex = currentPhraseIndex + 1;

  const launchBeat = nextPhraseIndex * pb;
  const launchAudioTime = transport.startedAtAudioTime
    + (launchBeat - transport.beatAtStart) / beatsPerSecond(transport.tempoBpm);

  return buildSuccess(Object.freeze({
    deck: transport.deck,
    launchAudioTime,
    launchBeat,
    phraseIndex: nextPhraseIndex,
    phraseBeats: pb,
    gridRevision: transport.gridRevision,
    requestedAt: nowAudioTime,
    source: Object.freeze({
      beat,
      tempoBpm: transport.tempoBpm,
      beatsPerBar: transport.beatsPerBar,
      phraseBars: transport.phraseBars,
      beatAtStart: transport.beatAtStart,
      startedAtAudioTime: transport.startedAtAudioTime,
    }),
  }));
}
