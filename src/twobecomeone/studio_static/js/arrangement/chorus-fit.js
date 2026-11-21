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
  if (n === 'take the decks' || n === 'make something beautiful from these two songs' || n === 'make a mashup from these two songs') return { kind: 'decks' };
  if (n === 'take the decks and surprise me') return { kind: 'decks', style: 'surprise' };
  if (n === 'try another arrangement') return { kind: 'another-plan' };
  if (n === 'let the second chorus of b take over') return { kind: 'decks', style: 'second' };
  if (n === 'keep a s drums but use b s vocals') return { kind: 'decks', style: 'lock' };
  if (n === 'find a more interesting transition') return { kind: 'decks', style: 'transition' };
  if (n === 'give the build more energy') return { kind: 'decks', style: 'energy' };
  if (n === 'stop i ll take it from here' || n === 'stop ill take it from here') return { kind: 'take-back' };
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
  if (n === 'make the fade gentler' || n === 'make the entrance gentler' || n === 'make the vocals come in more gently') return { kind: 'gentler' };
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

function speedFor(row) {
  if (!row) return 'natural';
  if (row.tempo?.qualified === true && (row.pitch?.suggested ?? 0) === 0) return 'fit';
  return 'natural';
}

/**
 * Two sketches for the same readings. The count is measurable structure
 * (both songs, a handoff, pitch left alone). It is not a judgement of taste.
 */
export function arrangementPlans({ rank, sections = [], chorusBeat, bpb = 4, secondChorusId = null } = {}) {
  const rows = scoredRows(rank);
  if (!rows.length || !Number.isFinite(chorusBeat)) {
    return { plans: [], note: 'There is no placed chorus to build on.' };
  }
  const playable = (row) => row.tempo?.qualified === true && (row.pitch?.suggested ?? 0) === 0 && row.vocal?.status !== 'low';
  const vocal = rows.find(playable) ?? rows[0];
  const other = rows.find((row) => row !== vocal) ?? null;
  const section = (row) => sections.find((item) => item.id === row?.id);
  const shared = [];
  if (rank?.ask) shared.push('The closest readings sit inside the ambiguity gap, so this is a choice.');
  if ((vocal.pitch?.suggested ?? 0) !== 0) shared.push('A pitch shift was in the reading and was left unused.');
  if (speedFor(vocal) === 'natural') shared.push('The passage keeps its own speed.');
  const second = secondChorusId ? rows.find((row) => row.id === secondChorusId) ?? null : null;
  const vocalRow = second ?? vocal;
  const bars = section(vocalRow)?.bars || 4;
  const handoff = chorusBeat + bars * bpb;
  const handoffRow = other && other.id !== vocalRow.id ? other : null;
  const vocalOf = (row, fadeBars) => ({
    song: 'B', sectionId: row.id, stem: 'vocals', startBeat: chorusBeat,
    fadeIn: fadeBars * bpb, fadeOut: 1, speed: speedFor(row), pitch: 0,
  });
  const lock = {
    id: 'lock',
    title: 'A keeps the drums and bass, B sings',
    adventurous: vocalRow.id !== rows[0].id,
    vocal: vocalOf(vocalRow, 4),
    parts: handoffRow ? [{
      song: 'B', sectionId: handoffRow.id, stem: 'drums', startBeat: handoff,
      fadeIn: 2 * bpb, fadeOut: 0, speed: speedFor(handoffRow), pitch: 0,
    }] : [],
    trims: [
      { song: 'A', stem: 'vocals', endBeat: chorusBeat },
      ...(handoffRow ? [{ song: 'A', stem: 'drums', endBeat: handoff }] : []),
    ],
    entranceBars: 4,
    bothSongs: true,
    transition: Boolean(handoffRow),
    issues: shared.slice(),
  };
  const swapRow = other ?? vocal;
  const swap = {
    id: 'swap',
    title: 'B’s drums take the bed',
    adventurous: true,
    vocal: {
      song: 'B', sectionId: swapRow.id, stem: 'drums', startBeat: chorusBeat,
      fadeIn: 2 * bpb, fadeOut: 0, speed: speedFor(swapRow), pitch: 0,
    },
    parts: [],
    trims: [{ song: 'A', stem: 'drums', endBeat: chorusBeat }],
    entranceBars: 2,
    bothSongs: true,
    transition: true,
    issues: ['This changes the rhythm bed. It is a different sketch, not a higher score.'],
  };
  return { plans: [lock, swap] };
}

export function measurePlan(plan) {
  const flags = {
    bothSongs: plan?.bothSongs === true,
    transition: plan?.transition === true,
    pitchLeftAlone: (plan?.vocal?.pitch ?? 0) === 0 && (plan?.parts ?? []).every((part) => (part.pitch ?? 0) === 0),
  };
  return { flags, count: Object.values(flags).filter(Boolean).length, issues: plan?.issues ?? [] };
}

export function pickPlan(plans, { surprise = false, index = 0 } = {}) {
  if (!plans?.length) return null;
  if (surprise) return plans.find((plan) => plan.adventurous && plan.id !== 'lock') ?? plans[plans.length - 1];
  const at = ((index % plans.length) + plans.length) % plans.length;
  return plans[at];
}

export function stylePlan(plan, style, { bpb = 4 } = {}) {
  if (!plan || !style) return plan;
  const next = structuredClone(plan);
  if (style === 'energy') {
    next.vocal.fadeIn = bpb;
    next.entranceBars = 1;
    next.issues = [...next.issues, 'The entrance is one bar. That is a shorter fade, not a measurement of energy.'];
  }
  if (style === 'transition' && next.parts[0]) {
    next.parts[0].fadeIn = 8 * bpb;
    next.issues = [...next.issues, 'The handoff fade is eight bars.'];
  }
  if (style === 'gentle') {
    next.vocal.fadeIn = 8 * bpb;
    next.entranceBars = 8;
  }
  return next;
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

export function entrancePoints(startBeat, beatsPerBar, bars = 4) {
  const rise = (Number.isFinite(bars) && bars > 0 ? bars : 4) * beatsPerBar;
  return [
    { beat: startBeat, db: MIN_VOLUME_DB },
    { beat: startBeat + rise, db: 0 },
  ];
}

export function bedDipPoints(startBeat, lengthBeats) {
  return [
    { beat: startBeat, db: 0 },
    { beat: startBeat + Math.min(lengthBeats, 4), db: -4 },
    { beat: startBeat + lengthBeats, db: 0 },
  ];
}
