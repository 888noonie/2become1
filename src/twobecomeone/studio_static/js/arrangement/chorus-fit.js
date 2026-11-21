// Chorus Fit and Take the Decks.
//
// The rank itself stays in chorus_fit.py. This module only reads that result,
// names what it means, and turns a chosen section into the same idea the
// Producer already hears, keeps and throws away.

import { MIN_VOLUME_DB } from './project-state.js';
import { secondsToBeats, sourceAdvanceRate } from './time-math.js';

export const AUTO_PITCH_LIMIT = 2;
export const DECK_REVISIONS = 4;

export function normPhrase(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Deterministic musical requests. Anything else returns null and can go to the model. */
export function chorusUtterance(text) {
  const n = normPhrase(text);
  if (n === 'you play') return { kind: 'you-play' };
  if (n === 'jam together') return { kind: 'jam' };
  if (n === 'take the decks' || n === 'make something beautiful from these two songs') return { kind: 'decks' };
  if (n === 'take back') return { kind: 'take-back' };
  if (n === 'which part of b fits this chorus' || n === 'which part of song b fits this chorus') {
    return { kind: 'fit', targetSong: 'A', sourceSong: 'B', label: 'chorus' };
  }
  if (n === 'find another section that would work with a' || n === 'find another section that would work with song a') {
    return { kind: 'fit', targetSong: 'A', sourceSong: 'B', another: true };
  }
  if (n === 'try the strongest match' || n === 'try that one') return { kind: 'choose', index: 0 };
  if (n === 'use the second best option' || n === 'try the next best match' || n === 'try the next best match instead' || n === 'try the next best') {
    return { kind: 'choose', index: 'next' };
  }
  if (n === 'keep the chorus but choose a different vocal phrase') return { kind: 'choose', index: 'next', stem: 'vocals' };
  const bar = n.match(/^put it at bar (\d+)$/);
  if (bar) return { kind: 'place', bar: Number(bar[1]) };
  if (n === 'move it half a beat earlier' || n === 'move the idea half a beat earlier' || n === 'half a beat earlier') return { kind: 'nudge', beats: -0.5 };
  if (n === 'play the idea at its own speed' || n === 'play it at its own speed') return { kind: 'speed', speed: 'natural' };
  if (n === 'make the fade gentler' || n === 'make the entrance gentler') return { kind: 'gentler' };
  return null;
}

export function targetSection(analysis, label) {
  const sections = analysis?.sections ?? [];
  const pool = label ? sections.filter((s) => s.label === label) : sections;
  if (!pool.length) return null;
  const named = pool.filter((s) => s.basis === 'musician');
  const rows = named.length ? named : pool;
  return rows.slice().sort((a, b) => (b.vocalPresence ?? -1) - (a.vocalPresence ?? -1))[0];
}

/** The numbers rank_fit reads. Start and end are copied, never rewritten. */
export function descriptorFrom(analysis, section) {
  return {
    id: section.id,
    label: section.name || section.label,
    meanChroma: section.meanChroma ?? null,
    bars: section.bars,
    vocalPresence: section.vocalPresence ?? null,
    bpm: analysis?.bpm ?? null,
    swing: section.swingRatio ?? null,
    key: analysis?.key ?? null,
    startSec: section.startSec,
    endSec: section.endSec,
    downbeatSec: section.startSec,
  };
}

export function scoredRows(rank) {
  return (rank?.candidates ?? []).filter((row) => row.evidence !== 'missing' && row.harmonic?.cosine != null);
}

/**
 * `fit` only when both ratios sit inside 0.857–1.2 and they are the same ratio.
 * A project tempo of 1.21 must not sneak in beside a qualified 1.2.
 */
export function playbackSpeed(qualifiedStretch, projectRatio) {
  if (typeof qualifiedStretch !== 'number' || typeof projectRatio !== 'number') return 'natural';
  if (!Number.isFinite(qualifiedStretch) || !Number.isFinite(projectRatio)) return 'natural';
  const inside = (value) => value >= 0.857 && value <= 1.2;
  if (!inside(qualifiedStretch) || !inside(projectRatio)) return 'natural';
  if (Math.abs(projectRatio - qualifiedStretch) > 0.02) return 'natural';
  return 'fit';
}

/**
 * Where `sourceSec` of `song` is heard on the current timeline.
 * The clip's own rate is the mapping. A source bar number is not a project bar.
 */
export function arrangementBeatForSource(state, song, sourceSec) {
  if (!state || !Number.isFinite(sourceSec)) return null;
  const base = song === 'B' ? 4 : 0;
  const clips = state.clips.filter((clip) => clip.trackIndex >= base && clip.trackIndex < base + 4);
  const ordered = [...clips.filter((clip) => clip.trackIndex === base), ...clips.filter((clip) => clip.trackIndex !== base)];
  for (const clip of ordered) {
    const asset = state.assets[clip.assetId];
    if (!asset) continue;
    const section = asset.source?.section;
    const sectionStart = section && typeof section === 'object' ? Number(section.startSec) || 0 : 0;
    const rangeStart = sectionStart + (Number(clip.sourceOffsetSec) || 0);
    let rate;
    try { rate = sourceAdvanceRate(clip, asset, state.transport.masterBpm); } catch { continue; }
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const rangeEnd = rangeStart + clip.durationBeats * (60 / state.transport.masterBpm) * rate;
    if (sourceSec < rangeStart - 1e-6 || sourceSec > rangeEnd + 1e-6) continue;
    return clip.timelineStartBeat + secondsToBeats((sourceSec - rangeStart) / rate, state.transport.masterBpm);
  }
  return null;
}

export function deckChoice(rank) {
  const rows = scoredRows(rank);
  if (!rows.length) return null;
  const best = rows[0].harmonic.cosine;
  const gap = Number(rank.ambiguityGap ?? 0.05);
  const pool = rows.filter((row) => best - row.harmonic.cosine < gap + 1e-9);
  const playable = (row) => row.tempo?.qualified === true && (row.pitch?.suggested ?? 0) === 0 && row.vocal?.status !== 'low';
  const adventurous = pool.find((row) => row !== rows[0] && playable(row) && !playable(rows[0]));
  const pick = adventurous || pool.find(playable) || rows[0];
  return { id: pick.id, index: rows.indexOf(pick), adventurous: pick.id !== rows[0].id, uncertain: Boolean(rank.ask), row: pick };
}

export function pitchFor(row, { auto = false } = {}) {
  const note = row?.pitch?.note ?? 'The pitch stays where it is.';
  if (!row?.pitch?.autoApply) return { semitones: 0, note, unqualified: false, applied: false };
  const suggested = Number(row.pitch.suggested ?? 0);
  if (!auto || suggested === 0) return { semitones: suggested, note, unqualified: suggested !== 0, applied: suggested !== 0 };
  if (Math.abs(suggested) > AUTO_PITCH_LIMIT) {
    return {
      semitones: 0,
      note: `${note} I am leaving the pitch alone: ${suggested} semitones is a large shift outside the qualified range.`,
      unqualified: true,
      applied: false,
    };
  }
  return { semitones: suggested, note, unqualified: true, applied: true };
}

export function explainCandidate(row, { targetName, sourceTitle, rank }) {
  if (!row || row.evidence === 'missing') {
    return 'I do not have section chroma for that comparison, so I will not invent a match.';
  }
  const cosine = row.harmonic.cosine;
  const signed = row.harmonic.signedSemitones;
  const stretch = row.tempo?.relationships?.find((item) => item.kind === 'as_read');
  const parts = [
    `${row.label || row.id} of “${sourceTitle}” is a pitch-class reading of ${targetName}`,
    `(cosine ${cosine.toFixed(2)}, rotation ${signed > 0 ? '+' : ''}${signed}). That rotation is not a chord-by-chord proof.`,
  ];
  if (row.swing?.status === 'measured') {
    parts.push(`Swing ${row.swing.source.toFixed(2)} against the target ${row.swing.target.toFixed(2)}.`);
  }
  if (stretch) {
    parts.push(stretch.apply
      ? `Stretch ${stretch.stretch.toFixed(3)} is inside 0.857–1.2 at zero semitones.`
      : `The as-read stretch is ${stretch.stretch.toFixed(3)}, outside 0.857–1.2, so I will not fit the tempo that way.`);
  }
  const half = row.tempo?.relationships?.find((item) => item.kind === 'half_time' || item.kind === 'double_time');
  if (half && !half.apply) parts.push(`${half.kind.replace('_', ' ')} is listed and not applied.`);
  parts.push(row.pitch?.note ?? '');
  if (rank?.ask) parts.push(rank.askReason);
  parts.push('This is an estimate from the recording. You decide whether it sounds right.');
  return parts.filter(Boolean).join(' ');
}

export function entrancePoints(startBeat, beatsPerBar) {
  return [
    { beat: startBeat, db: MIN_VOLUME_DB },
    { beat: startBeat + 4 * beatsPerBar, db: 0 },
  ];
}

export function bedDipPoints(startBeat, lengthBeats) {
  return [
    { beat: startBeat, db: 0 },
    { beat: startBeat + Math.min(lengthBeats, 4), db: -4 },
    { beat: startBeat + lengthBeats, db: 0 },
  ];
}
