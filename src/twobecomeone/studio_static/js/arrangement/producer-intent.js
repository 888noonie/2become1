// js/arrangement/producer-intent.js — OPERATION THE LISTENING ROOM.
//
// The conversational Producer's deterministic half. The language model (server
// side, producer_brain.py) reads the musician's words and answers with ONE
// structured intent. Everything here is plain, testable code that turns that
// intent into ordinary edit-API commands on the ONE ProjectState:
//
//   intent  ──applyIntent──▶  spec (the idea, kept across the conversation)
//   spec    ──buildIdea────▶  fields (value, read, command) for Hear it /
//                             Hear mine / Keep / Undo, dry-run by propose()
//
// A follow-up ("half a beat earlier") changes the spec, never the project
// directly, so pitch, fades and the chosen passage survive every refinement.
// Source passages become exact source frames: the section's start in the
// recording is a sample index of the stem file, the in-point inside the cut is
// the section start minus the cut start, and the clip length follows the
// shared time-math (fit to project tempo or the stem's own speed).

import { GROUP_BASE, ROLES, ROLE_LABEL } from './daw-session.js';
import { MIN_VOLUME_DB } from './project-state.js';
import { MIN_CLIP_DURATION_BEATS, beatsToSourceSeconds, sourceAdvanceRate } from './time-math.js';

export const LEAD_BARS = 1; // source kept before the passage, so it can be slipped earlier
export const SECTION_CHOICES = Object.freeze([30, 60, 90]);
const ROUND = 1e9;
const rt = (x) => Math.round(x * ROUND) / ROUND;
const r3 = (x) => Math.round(x * 1000) / 1000;
export const mmss = (sec) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;
const signed = (n) => `${n > 0 ? '+' : ''}${n}`;

export function laneIndex(song, stem) {
  const base = GROUP_BASE[song];
  const role = ROLES.indexOf(stem);
  return base === undefined || role < 0 ? -1 : base + role;
}

export function barBeat(beat, bpb) {
  const bar = Math.floor(beat / bpb + 1e-9) + 1;
  const inBar = r3(beat - (bar - 1) * bpb) + 1;
  return { bar, beat: inBar };
}

export const fmtPos = (beat, bpb) => {
  const p = barBeat(beat, bpb);
  return `bar ${p.bar}${p.beat === 1 ? '' : ` beat ${p.beat}`}`;
};

/** Where a clip's sound comes from in its original recording (seconds). */
export function clipSourceRange(state, clip) {
  const asset = state.assets[clip.assetId];
  const base = typeof asset?.source?.section === 'object' && asset.source.section ? Number(asset.source.section.startSec) || 0 : 0;
  const start = base + clip.sourceOffsetSec;
  return { start, end: start + beatsToSourceSeconds(clip.durationBeats, clip, asset, state.transport.masterBpm) };
}

// ------------------------------------------------------------------ context

/** A short, accurate description of the session for the language model. */
export function projectSummary(state, { groups = {}, selectedClipId = null, spec = null, mine = null } = {}) {
  const bpb = state.transport.timeSignature[0];
  const end = state.clips.reduce((m, c) => Math.max(m, c.timelineStartBeat + c.durationBeats), 0);
  return {
    bpm: state.transport.masterBpm,
    beatsPerBar: bpb,
    bars: Math.ceil(end / bpb),
    mine,
    groups,
    selectedClipId: state.clips.some((c) => c.id === selectedClipId) ? selectedClipId : null,
    idea: spec ? describeSpec(state, spec) : null,
    lanes: state.tracks.map((t) => ({
      name: t.name, mute: t.mute, solo: t.solo, volumeDb: t.volumeDb,
      ...(Array.isArray(t.gainPoints) && t.gainPoints.length ? { gainPoints: t.gainPoints } : {}),
      clips: state.clips.filter((c) => c.trackIndex === t.trackIndex).map((c) => {
        const asset = state.assets[c.assetId];
        const src = clipSourceRange(state, c);
        return {
          id: c.id,
          startBar: r3(1 + c.timelineStartBeat / bpb),
          endBar: r3(1 + (c.timelineStartBeat + c.durationBeats) / bpb),
          source: `${asset?.source?.title ?? asset?.name ?? 'a recording'} ${asset?.source?.role ?? ''} ${mmss(src.start)}-${mmss(src.end)}`.replace(/\s+/g, ' '),
          pitch: c.pitchSemitones, gainDb: c.clipGainDb, fadeIn: Math.round(c.fadeInBeats * 100) / 100, fadeOut: Math.round(c.fadeOutBeats * 100) / 100,
          speed: c.stretchMode === 'beat_sync' ? 'fitted to project tempo' : c.customStretchRatio === 1 ? 'natural speed' : `speed ×${c.customStretchRatio}`,
        };
      }),
    })),
  };
}

export function describeSpec(state, spec) {
  const bpb = state.transport.timeSignature[0];
  const parts = [];
  if (spec.main) {
    const m = spec.main;
    parts.push(`${m.song} ${ROLE_LABEL[m.stem]} from ${m.song}:${m.passage.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')} (${m.passage.name} of song ${m.song}), placed at ${fmtPos(m.startBeat, bpb)}, pitch ${signed(m.pitch)}, fade in ${m.fadeIn} / out ${m.fadeOut} beats, gain ${m.gainDb} dB, ${m.speed === 'fit' ? 'fitted to tempo' : 'own speed'}`);
  }
  for (const [id, c] of Object.entries(spec.clips ?? {})) parts.push(`${id} changed: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [i, m] of Object.entries(spec.mixer ?? {})) parts.push(`${state.tracks[i]?.name}: ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [i, points] of Object.entries(spec.envelopes ?? {})) {
    const name = state.tracks[i]?.name ?? `track ${i}`;
    const end = points[points.length - 1];
    parts.push(`${name} level from ${points[0].db} dB offset at beat ${points[0].beat} to ${end.db} dB offset at beat ${end.beat}, fader unchanged`);
  }
  return `${parts.join('; ')}${spec.heard ? ' (being heard)' : ' (not heard yet)'}`;
}

// ------------------------------------------------------------------ intent → spec

function clipBase(state, clipId) {
  const c = state.clips.find((x) => x.id === clipId);
  return c ? clipObject(state, c.id) : null;
}

function nextClipId(state, taken = []) {
  let n = 1;
  const ids = new Set([...state.clips.map((c) => c.id), ...taken]);
  while (ids.has(`idea-${n}`)) n += 1;
  return `idea-${n}`;
}

const NUMBER = (v) => typeof v === 'number' && Number.isFinite(v);

/** Relative and absolute changes from an intent onto one value set. */
function applyChanges(target, intent, { bpb, allowPosition = true }) {
  const out = { ...target };
  if (allowPosition) {
    // An absolute bar wins: a shift in the same answer is a contradiction.
    if (NUMBER(intent.bar)) out.startBeat = (intent.bar - 1) * bpb + (NUMBER(intent.beat) ? intent.beat - 1 : 0);
    else if (NUMBER(intent.shift_beats)) out.startBeat = rt(out.startBeat + intent.shift_beats);
  }
  if (NUMBER(intent.pitch)) out.pitch = intent.pitch;
  if (NUMBER(intent.pitch_change)) out.pitch = (out.pitch ?? 0) + intent.pitch_change;
  if (NUMBER(intent.fade_in)) out.fadeIn = intent.fade_in;
  if (NUMBER(intent.fade_in_change)) out.fadeIn = Math.max(0, (out.fadeIn ?? 0) + intent.fade_in_change);
  if (NUMBER(intent.fade_out)) out.fadeOut = intent.fade_out;
  if (NUMBER(intent.fade_out_change)) out.fadeOut = Math.max(0, (out.fadeOut ?? 0) + intent.fade_out_change);
  if (NUMBER(intent.gain_db)) out.gainDb = intent.gain_db;
  if (NUMBER(intent.gain_change_db)) out.gainDb = rt((out.gainDb ?? 0) + intent.gain_change_db);
  if (intent.speed === 'fit' || intent.speed === 'natural') out.speed = intent.speed;
  if (NUMBER(intent.length_bars)) out.lengthBars = intent.length_bars;
  return out;
}

function passageFromSection(analysis, sectionId) {
  const s = analysis?.sections?.find((x) => x.id === sectionId);
  if (!s) return null;
  return {
    sectionId: s.id, name: s.name, label: s.label, startSec: s.startSec, endSec: s.endSec,
    startBar: s.startBar, bars: s.bars, basis: s.basis, confidence: s.confidence, evidence: s.evidence ?? [],
  };
}

// Whole utterances only. A substring of "play" must not start transport.
const UTTERANCE = new Map([
  ['hear mine', 'hear_mine'],
  ['hear my version', 'hear_mine'],
  ['let me hear mine', 'hear_mine'],
  ['let me hear mine again', 'hear_mine'],
  ['play mine', 'hear_mine'],
  ['hear the idea', 'hear_idea'],
  ['hear it', 'hear_idea'],
  ['hear that idea', 'hear_idea'],
  ['keep it', 'keep'],
  ['keep that', 'keep'],
  ['keep this version', 'keep'],
  ['reject that', 'reject'],
  ['reject it', 'reject'],
  ['throw it away', 'reject'],
  ['undo that', 'undo_idea'],
  ['undo it', 'undo_idea'],
  ['undo that idea', 'undo_idea'],
  ['play', 'play'],
  ['stop', 'stop'],
]);

function normUtterance(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The whole utterance is only “half a beat earlier/later”. Punctuation is ignored. */
export function halfBeatOnly(text) {
  const n = normUtterance(text);
  if (n === 'half a beat earlier') return -0.5;
  if (n === 'half a beat later') return 0.5;
  return null;
}

/**
 * Deterministic front door. `text` must be the whole utterance: "play the
 * second chorus" is not Play, and "let me hear mine again" is hear_mine.
 */
export function localCommand(text, project) {
  void project;
  const hit = UTTERANCE.get(normUtterance(text));
  if (!hit) return null;
  if (hit === 'play' || hit === 'stop') return { transport: hit };
  return { control: hit };
}

function namedSong(sentence) {
  const m = String(sentence).match(/\bsong\s+([ab])\b/i);
  return m ? m[1].toUpperCase() : null;
}

function saysOtherSong(sentence) {
  return /\bthe other song\b/i.test(sentence);
}

function halfBeatShift(sentence) {
  const m = String(sentence).match(/\bhalf a beat (earlier|later)\b/i);
  if (!m) return null;
  return m[1].toLowerCase() === 'later' ? 0.5 : -0.5;
}

function songsWithVocals(state, groups) {
  return ['A', 'B'].filter((g) => groups[g] && state.clips.some((c) => c.trackIndex === laneIndex(g, 'vocals')));
}

/** Said when a four-bar vocal entrance also asks for an effect the DAW cannot do. */
export const EFFECT_ENTRANCE_REPLY = "I can't add that effect yet. Ask for the vocal entrance on its own and I can shape the level.";

/** A level move over time, not a clip fade. Null when the sentence is not one. */
export function entranceRequest(sentence) {
  const n = normUtterance(sentence);
  if (!/\b(?:bring|fade)\b/.test(n) || !/\bvocals?\b/.test(n) || !/\bin\b/.test(n)) return null;
  if (!/\b(?:four|4) bars\b/.test(n) || !/\b(?:gradually|across|over)\b/.test(n)) return null;
  if (/\b(?:reverb|echo|delay|distortion|reverse|reversing)\b/.test(n)) return { refused: true };
  return { first: /\bfirst (?:four|4) bars\b/.test(n) };
}

function vocalEntrance(sentence, entrance, ctx) {
  const { state, groups = {} } = ctx;
  let song = namedSong(sentence);
  if (!song && saysOtherSong(sentence)) {
    if (ctx.mine !== 'A' && ctx.mine !== 'B') return { ask: 'Which song is yours? I will not guess the other one.' };
    song = ctx.mine === 'A' ? 'B' : 'A';
    if (!groups[song]) return { ask: 'I only see one song on the lanes. Which song do you mean?' };
  }
  if (!song) {
    const present = songsWithVocals(state, groups);
    if (present.length !== 1) {
      return { ask: present.length ? "Which song's vocals should come in, A or B?" : "I can't see a vocal lane to bring in." };
    }
    song = present[0];
  }
  if (!groups[song]) return { ask: `Song ${song} isn't on the lanes yet.` };
  const trackIndex = laneIndex(song, 'vocals');
  if (trackIndex < 0) return { ask: "I can't see a vocal lane to bring in." };
  const clips = state.clips.filter((c) => c.trackIndex === trackIndex);
  if (!clips.length && !entrance.first) return { ask: "I can't see that vocal clip, so I won't invent a bar." };
  const bpb = state.transport.timeSignature[0];
  const start = entrance.first ? 0 : Math.min(...clips.map((c) => c.timelineStartBeat));
  const points = [
    { beat: rt(start), db: MIN_VOLUME_DB },
    { beat: rt(start + 4 * bpb), db: 0 },
  ];
  return {
    spec: {
      main: null, clips: {}, mixer: {}, envelopes: { [trackIndex]: points }, heard: false, fresh: true,
    },
  };
}

/**
 * The model does not get the last word on the phrases it has already missed.
 * The raw sentence is what the musician typed.
 */
function applySentence(intentIn, ctx) {
  const sentence = ctx.sentence;
  if (!sentence) return { intent: intentIn };
  const entrance = entranceRequest(sentence);
  if (entrance?.refused) return { say: EFFECT_ENTRANCE_REPLY };
  if (entrance) return vocalEntrance(sentence, entrance, ctx);
  const intent = { ...intentIn };
  const explicit = namedSong(sentence);
  if (explicit) intent.song = explicit;
  else if (saysOtherSong(sentence)) {
    if (ctx.mine !== 'A' && ctx.mine !== 'B') return { ask: 'Which song is yours? I will not guess the other one.' };
    const other = ctx.mine === 'A' ? 'B' : 'A';
    if (!ctx.groups?.[other]) return { ask: 'I only see one song on the lanes. Which song do you mean?' };
    intent.song = other;
  }
  if (intent.song && intent.section && !String(intent.section).startsWith(`${intent.song}:`)) delete intent.section;
  if (/\bsecond chorus\b/i.test(sentence) && intent.action !== 'unsupported') {
    const song = intent.song || (intent.section ? String(intent.section).split(':')[0] : null);
    if (!song) return { ask: "Which song's second chorus do you mean?" };
    const choruses = (ctx.analyses?.[song]?.sections ?? []).filter((s) => s.label === 'chorus');
    const second = choruses[1];
    if (!second) return { ask: `I can't find a second chorus in song ${song}. Which part do you mean?` };
    intent.song = song;
    intent.section = `${song}:${second.id}`;
    if (intent.action !== 'propose' && intent.action !== 'adjust') intent.action = 'propose';
  }
  const nudge = halfBeatShift(sentence);
  if (nudge !== null) {
    delete intent.bar;
    delete intent.beat;
    intent.shift_beats = nudge;
    if (!/\b(pitch|semitone|fade|louder|quieter|gain|db)\b/i.test(sentence)) {
      for (const k of ['pitch', 'pitch_change', 'fade_in', 'fade_out', 'fade_in_change', 'fade_out_change', 'gain_db', 'gain_change_db']) delete intent[k];
    }
    intent._halfBeat = true;
    if (!/\b(chorus|verse|bridge|intro|outro|section)\b/i.test(sentence)) {
      intent.action = 'adjust';
      delete intent.section;
      delete intent.lyric;
    }
  }
  return { intent };
}

/**
 * Fold one model intent into the conversation's idea. Returns
 * {spec} (a new or refined idea), {ask} (a short question), {say} (an honest
 * answer with no edit), or {control} (hear/keep/reject/undo/relabel).
 * `ctx.sentence` is the musician's raw sentence, used after the model answers.
 */
export function applyIntent(prev, intentIn, ctx) {
  const read = applySentence(intentIn, ctx);
  if (read.ask) return { ask: read.ask };
  if (read.say) return { say: read.say };
  if (read.spec) return { spec: read.spec };
  let intent = read.intent;
  const { state, analyses = {}, groups = {}, resolved = {}, selectedClipId = null, pending = null } = ctx;
  // The answer to our own question ("which part of song B?") completes what
  // the musician already said: song, stem and bar carry over.
  if (pending && (intent.action === 'propose' || intent.action === 'adjust' || intent.action === 'clarify') && (intent.section || intent.lyric)) {
    intent = { ...intent, action: 'propose' };
    for (const k of ['song', 'stem', 'bar', 'beat']) if (intent[k] === undefined && pending[k] !== undefined) intent[k] = pending[k];
  }
  const bpb = state.transport.timeSignature[0];
  let action = intent.action;
  // An answer to "where should it come in?" is a refinement, however phrased.
  if (action === 'propose' && prev?.main && prev.main.startBeat === null && !intent.section && !intent.lyric) action = 'adjust';
  if (['hear_idea', 'hear_mine', 'keep', 'reject', 'undo_idea'].includes(action)) return { control: action };
  if (action === 'relabel') {
    const [song, sid] = String(intent.section ?? '').split(':');
    if (!song || !sid || !intent.label) return { ask: 'Which part should I rename, and to what?' };
    return { control: 'relabel', song, sectionId: sid, label: intent.label };
  }
  if (action === 'clarify') return { ask: intent.question || intent.reply || 'Which part do you mean?' };
  if (action === 'unsupported' || action === 'answer') return { say: intent.reply };
  if (action !== 'propose' && action !== 'adjust') return { say: intent.reply };

  let spec = prev ? structuredClone(prev) : { main: null, clips: {}, mixer: {}, heard: false };
  let touched = false;

  // A new part of a song with no part named: ask which, never edit another clip.
  if (action === 'propose' && !intent.section && !intent.lyric && !intent.lane && !intent.clip) {
    const song = intent.song ?? (Object.keys(groups).length === 1 ? Object.keys(groups)[0] : null);
    const names = song && analyses[song] ? analyses[song].sections.filter((s) => s.label !== 'section').map((s) => s.name) : [];
    const keep = Object.fromEntries(['song', 'stem', 'bar', 'beat'].filter((k) => intent[k] !== undefined).map((k) => [k, intent[k]]));
    return {
      ask: song && names.length ? `Which part of song ${song}: ${names.slice(0, 8).join(', ')}?` : 'Which song, and which part of it?',
      pending: keep,
    };
  }

  // A passage of a song: a named section, or where certain words were heard.
  const wantsPassage = action === 'propose' && (intent.section || intent.lyric);
  const changesPassage = action === 'adjust' && intent.section && spec.main;
  if (wantsPassage || changesPassage) {
    const song = intent.song ?? (intent.section ? String(intent.section).split(':')[0] : null) ?? spec.main?.song;
    if (!song) return { ask: 'Which song should that come from?' };
    if (!groups[song]) return { say: `Song ${song} isn't on the lanes yet. Bring it in first.` };
    if (intent.section && String(intent.section).split(':')[0] !== song) {
      return { ask: `That section belongs to song ${String(intent.section).split(':')[0]}, not song ${song}. Which song do you mean?` };
    }
    const analysis = analyses[song];
    if (!analysis) return { say: `I haven't listened to song ${song} yet.` };
    let passage = null;
    let heardNote = null;
    if (intent.section) {
      const sid = String(intent.section).split(':')[1];
      passage = passageFromSection(analysis, sid);
      if (!passage) return { say: `I can't find that part of song ${song}.` };
    } else {
      const matches = resolved.lyricMatches ?? [];
      if (!resolved.lyricsAvailable) {
        return { ask: `I don't have the words for song ${song} (${analysis.lyrics?.note ?? 'no transcription'}). Which section do you mean?` };
      }
      if (!matches.length) return { ask: `I didn't hear “${intent.lyric}” in song ${song}. Which section do you mean?` };
      const nth = NUMBER(intent.occurrence) ? intent.occurrence : null;
      const pick = nth ? matches[nth - 1] : matches.find((m) => m.certain) ?? matches[0];
      if (!pick) return { ask: `I only heard “${intent.lyric}” ${plural(matches.length, 'time')} in song ${song}. Which one do you mean?` };
      const sid = pick.sectionId ? pick.sectionId.split(':')[1] : null;
      if (!pick.certain) {
        return { ask: `The closest I heard is “${pick.heard}” at ${mmss(pick.startSec)}${sid ? ` (in ${passageFromSection(analysis, sid)?.name})` : ''}, and I'm not sure it's the line you mean. Is that it?` };
      }
      passage = sid ? passageFromSection(analysis, sid) : null;
      if (!passage) return { ask: `I heard “${pick.heard}” at ${mmss(pick.startSec)}, but not inside a section I can place. Which section do you mean?` };
      heardNote = `where it sounds like “${pick.heard}” at ${mmss(pick.startSec)}`;
    }
    const stem = intent.stem ?? spec.main?.stem;
    if (!stem) return { ask: `Which part of ${passage.name} do you want: vocals, drums, bass or other?` };
    const keep = action === 'adjust' || (spec.main && spec.main.song === song && spec.main.stem === stem);
    if (!keep) spec = { main: null, clips: {}, mixer: {}, heard: false, fresh: true };
    const base = keep && spec.main ? spec.main : {
      startBeat: null, pitch: 0, fadeIn: 0, fadeOut: 0, gainDb: 0, speed: 'fit', lengthBars: null,
      clipId: nextClipId(state, prev?.main ? [prev.main.clipId] : []),
    };
    spec.main = { ...base, song, stem, passage, heardNote, lengthBars: action === 'adjust' ? base.lengthBars : null };
    // A new passage has its own in-point. A relative move keeps the one the clip already has.
    if (!(action === 'adjust' && !intent.section)) {
      delete spec.main.sourceOffsetSec;
      delete spec.main.durationBeats;
    }
    if (!NUMBER(intent.bar) && spec.main.startBeat === null) {
      spec.main = applyChanges(spec.main, intent, { bpb });
      return { spec, ask: `Where should ${passage.name} come in? Tell me a bar.` , pendingPosition: true };
    }
    spec.main = applyChanges(spec.main, intent, { bpb });
    touched = true;
  }

  // The mixer: mute, solo or a lane level.
  if (intent.lane && (typeof intent.mute === 'boolean' || typeof intent.solo === 'boolean' || NUMBER(intent.volume_db))) {
    const i = state.tracks.findIndex((t) => t.name === intent.lane);
    if (i < 0) return { ask: 'Which lane do you mean?' };
    const m = { ...(spec.mixer[i] ?? {}) };
    if (typeof intent.mute === 'boolean') m.mute = intent.mute;
    if (typeof intent.solo === 'boolean') m.solo = intent.solo;
    if (NUMBER(intent.volume_db)) m.volumeDb = intent.volume_db;
    spec.mixer[i] = m;
    touched = true;
  }

  // Refining the idea, or changing one existing clip.
  const hasClipChange = ['bar', 'shift_beats', 'pitch', 'pitch_change', 'fade_in', 'fade_in_change', 'fade_out',
    'fade_out_change', 'gain_db', 'gain_change_db', 'speed', 'length_bars'].some((k) => intent[k] !== undefined);
  if (!touched && hasClipChange) {
    const named = intent.clip && intent.clip !== 'idea' && intent.clip !== spec.main?.clipId ? intent.clip : null;
    if (named || (!spec.main && !named)) {
      const clipId = named ?? (prev?.main ? null : selectedClipId);
      if (!clipId) return { ask: spec.main ? 'Which clip do you mean?' : 'Which clip do you mean? Select it, or tell me which song and part.' };
      const base = clipBase(state, clipId);
      if (!base) return { say: 'That clip is not on the lanes any more.' };
      const current = { ...base, ...(spec.clips[clipId] ?? {}) };
      spec.clips[clipId] = applyChanges(current, intent, { bpb });
    } else {
      // A position was pending: a bar answers the question.
      spec.main = applyChanges(spec.main, intent, { bpb });
    }
    touched = true;
  }
  if (!touched) return { say: "I couldn't turn that into a change. I can choose a part of a song, place or move it, pitch it, fade it, change its level or speed, and mute or solo lanes." };
  // "Half a beat earlier" must not rebuild the in-point from the passage.
  if (intent._halfBeat && spec.main) {
    const clip = state.clips.find((c) => c.id === spec.main.clipId);
    if (clip) {
      spec.main.sourceOffsetSec = clip.sourceOffsetSec;
      spec.main.durationBeats = clip.durationBeats;
    }
  }
  if (spec.main && spec.main.startBeat !== null && spec.main.startBeat < -1e-9) return { say: 'That would start before bar 1.' };
  return { spec };
}

// ------------------------------------------------------------------ spec → fields

const CLIP_KEYS = ['exists', 'ref', 'trackIndex', 'startBeat', 'sourceOffsetSec', 'durationBeats', 'pitch', 'fadeIn', 'fadeOut', 'gainDb', 'speed'];

export function clipObject(state, clipId) {
  const c = state.clips.find((x) => x.id === clipId);
  if (!c) return { exists: false };
  return {
    exists: true, ref: state.assets[c.assetId]?.bufferReference ?? null, trackIndex: c.trackIndex, startBeat: c.timelineStartBeat, sourceOffsetSec: c.sourceOffsetSec,
    durationBeats: c.durationBeats, pitch: c.pitchSemitones, fadeIn: c.fadeInBeats, fadeOut: c.fadeOutBeats,
    gainDb: c.clipGainDb, speed: c.stretchMode === 'beat_sync' ? 'fit' : c.customStretchRatio === 1 ? 'natural' : `x${c.customStretchRatio}`,
  };
}

function ordered(v) {
  if (!v.exists) return { exists: false };
  const o = {};
  for (const k of CLIP_KEYS) o[k] = v[k];
  return o;
}

/** The ordinary edit commands that take a clip from what it is to `want`. */
function clipCommands(state, clipId, want, load) {
  const have = clipObject(state, clipId);
  const cmds = [];
  if (!want.exists) return have.exists ? [{ name: 'deleteClip', args: { clipId } }] : [];
  if (have.exists && load && want.ref && have.ref !== want.ref) {
    // A different passage: the clip takes its new source (same id, so the
    // idea stays one thing on the timeline).
    cmds.push({ name: 'deleteClip', args: { clipId } });
    return cmds.concat(clipCommands({ ...state, clips: state.clips.filter((c) => c.id !== clipId) }, clipId, want, load));
  }
  if (!have.exists) {
    if (!load) return [];
    cmds.push({
      name: 'loadStemToTrack',
      args: {
        trackIndex: want.trackIndex, newClipId: clipId, startBeat: want.startBeat, reuseAsset: true,
        naturalSpeed: want.speed === 'natural', sourceOffsetSec: want.sourceOffsetSec, durationBeats: want.durationBeats,
        audioFile: load,
      },
    });
    if (want.pitch) cmds.push({ name: 'setClipPitch', args: { clipId, semitones: want.pitch, preserveFormants: true } });
    if (want.gainDb) cmds.push({ name: 'setClipGain', args: { clipId, gainDb: want.gainDb } });
    if (want.fadeIn || want.fadeOut) cmds.push({ name: 'setClipFades', args: { clipId, fadeInBeats: want.fadeIn, fadeOutBeats: want.fadeOut } });
    return cmds;
  }
  if (want.speed !== have.speed && (want.speed === 'fit' || want.speed === 'natural')) {
    cmds.push({ name: 'stretchClipKeepingSource', args: { clipId, ratioOrAuto: want.speed === 'fit' ? 'auto' : 1 } });
  }
  if (want.trackIndex !== have.trackIndex || want.startBeat !== have.startBeat) {
    cmds.push({ name: 'moveClip', args: { clipId, newTrackIndex: want.trackIndex, newStartBeat: want.startBeat } });
  }
  if (want.sourceOffsetSec !== have.sourceOffsetSec || want.durationBeats !== have.durationBeats) {
    // Shrink first, then slip, then grow: every step stays inside the asset.
    const shortest = Math.min(have.durationBeats, want.durationBeats);
    if (shortest !== have.durationBeats) cmds.push({ name: 'trimClip', args: { clipId, edge: 'end', deltaBeats: rt(shortest - have.durationBeats) } });
    if (want.sourceOffsetSec !== have.sourceOffsetSec) cmds.push({ name: 'slipClip', args: { clipId, sourceOffsetSec: want.sourceOffsetSec } });
    if (want.durationBeats !== shortest) cmds.push({ name: 'trimClip', args: { clipId, edge: 'end', deltaBeats: rt(want.durationBeats - shortest) } });
  }
  if (want.pitch !== have.pitch) cmds.push({ name: 'setClipPitch', args: { clipId, semitones: want.pitch, preserveFormants: true } });
  if (want.gainDb !== have.gainDb) cmds.push({ name: 'setClipGain', args: { clipId, gainDb: want.gainDb } });
  if (want.fadeIn !== have.fadeIn || want.fadeOut !== have.fadeOut) {
    cmds.push({ name: 'setClipFades', args: { clipId, fadeInBeats: want.fadeIn, fadeOutBeats: want.fadeOut } });
  }
  return cmds;
}

/**
 * Where a passage lives as a Studio source: the stem cut (a sample-exact
 * start in the stem file), the in-point inside it and the source length.
 */
export function passageSource(analysis, group, stem, passage, { lengthBars = null } = {}) {
  const rate = analysis.stemSampleRate;
  if (!Number.isInteger(rate) || rate <= 0) return { refusal: "I can't place that exactly: the stem's sample rate is unknown." };
  const stemSetId = group.stemSetId ?? analysis.stemSetId;
  if (!stemSetId) return { refusal: 'That song has no separated stems to take a part from.' };
  const bar = analysis.barSec;
  const lead = Math.min(LEAD_BARS * bar, passage.startSec);
  const startFrame = Math.round((passage.startSec - lead) * rate);
  const cutStart = startFrame / rate;
  let lengthSec = passage.endSec - passage.startSec;
  if (NUMBER(lengthBars) && lengthBars > 0) lengthSec = Math.min(lengthSec, lengthBars * bar);
  const inPoint = passage.startSec - cutStart;
  const need = inPoint + lengthSec + 0.25 * bar;
  const seconds = SECTION_CHOICES.find((s) => s >= need) ?? SECTION_CHOICES[SECTION_CHOICES.length - 1];
  lengthSec = Math.min(lengthSec, seconds - inPoint - 0.01);
  const url = `/api/stems/${encodeURIComponent(stemSetId)}/audio?name=${encodeURIComponent(stem)}&start=${cutStart}&duration=${seconds}`;
  return { url, rate, startFrame, cutStart, seconds, inPoint, lengthSec, stemSetId };
}

function trackFieldFor(index, key, value) {
  const cmd = {
    mute: (v) => ({ name: 'setTrackMute', args: { trackIndex: index, mute: v } }),
    solo: (v) => ({ name: 'setTrackSolo', args: { trackIndex: index, solo: v } }),
    volumeDb: (v) => ({ name: 'setTrackVolume', args: { trackIndex: index, volumeDb: v } }),
  }[key];
  return {
    key: `${index}:${key}`, value,
    label: (state) => `${state.tracks[index].name} ${key === 'volumeDb' ? 'level' : key}`,
    read: (state) => state.tracks[index][key],
    command: (_state, v) => cmd(v),
    show: (v) => (key === 'volumeDb' ? `${v} dB` : key === 'mute' ? (v ? 'muted' : 'playing') : (v ? 'solo' : 'not solo')),
  };
}

function showClip(bpb) {
  return (v) => (v?.exists
    ? `${fmtPos(v.startBeat, bpb)}, ${r3(v.durationBeats / bpb)} bars, pitch ${signed(v.pitch)}, fade in ${r3(v.fadeIn)} beats, ${v.gainDb} dB`
    : 'not on the lanes');
}

/**
 * The idea as fields. `records` maps a source URL to its decoded record
 * ({durationSec}); a passage whose cut is not decoded yet comes back as
 * {needsSource: url} so the caller can decode it (no sound) and ask again.
 */
export function buildIdea(state, spec, { analyses = {}, groups = {}, records = {} } = {}) {
  const bpb = state.transport.timeSignature[0];
  const bpm = state.transport.masterBpm;
  const fields = [];
  const notes = [];
  const passages = [];
  if (spec.main && spec.main.startBeat !== null) passages.push(spec.main);
  for (const part of spec.parts ?? []) if (part && part.startBeat !== null) passages.push(part);
  let vocalEnd = null;
  for (const m of passages) {
    const analysis = analyses[m.song];
    const group = groups[m.song];
    if (!analysis || !group) return { refusal: `Song ${m.song} is no longer on the lanes.`, fields: [] };
    const src = passageSource(analysis, group, m.stem, m.passage, { lengthBars: m.lengthBars });
    if (src.refusal) return { refusal: src.refusal, fields: [] };
    const record = records[src.url];
    if (!record) return { needsSource: src.url, fields: [] };
    const nativeBpm = Number(group.bpm) || analysis.bpm;
    // A remembered in-point (a slip, or a half-beat nudge) is the clip's own.
    // Rebuilding it from the passage lead would slip the lyric.
    const inPoint = NUMBER(m.sourceOffsetSec) ? m.sourceOffsetSec : src.inPoint;
    const asset = { nativeBpm, durationSec: record.durationSec };
    const fake = { stretchMode: m.speed === 'fit' ? 'beat_sync' : 'manual', customStretchRatio: m.speed === 'fit' ? null : 1 };
    const rate = sourceAdvanceRate(fake, asset, bpm);
    let durationBeats;
    if (NUMBER(m.sourceOffsetSec) && NUMBER(m.durationBeats) && !NUMBER(m.lengthBars)) {
      durationBeats = m.durationBeats;
    } else {
      const lengthSec = Math.min(src.lengthSec, record.durationSec - inPoint);
      if (lengthSec <= 0) return { refusal: 'That passage is past the end of the stem.', fields: [] };
      // Floor to the nanobeat so the clip never asks for a sample past the cut.
      durationBeats = Math.floor((lengthSec / rate) * (bpm / 60) * ROUND) / ROUND;
      // Section times are bar-grid estimates rounded to 0.1 ms: a length within
      // a thousandth of a beat of a whole beat IS that many beats (rounded down,
      // so the clip still ends inside the cut).
      if (durationBeats - Math.floor(durationBeats) < 1e-3) durationBeats = Math.floor(durationBeats);
      durationBeats = Math.max(MIN_CLIP_DURATION_BEATS, durationBeats);
    }
    const trackIndex = laneIndex(m.song, m.stem);
    const startBeat = m.afterVocal && vocalEnd != null ? vocalEnd : m.startBeat;
    const want = ordered({
      exists: true, ref: src.url, trackIndex, startBeat: rt(startBeat), sourceOffsetSec: rt(inPoint), durationBeats,
      pitch: m.pitch, fadeIn: m.fadeIn, fadeOut: m.fadeOut, gainDb: m.gainDb, speed: m.speed,
    });
    const load = {
      name: `${group.title} — ${ROLE_LABEL[m.stem]} (${m.passage.name})`,
      durationSec: record.durationSec,
      bufferReference: src.url,
      nativeBpm,
      nativeBpmSource: 'analysis',
      source: {
        trackId: group.trackId, title: group.title, role: m.stem, group: m.song, stemSetId: src.stemSetId,
        section: { startSec: src.cutStart, seconds: src.seconds, startFrame: src.startFrame, sampleRate: src.rate },
        passage: { name: m.passage.name, startSec: m.passage.startSec, endSec: m.passage.endSec, basis: m.passage.basis, confidence: m.passage.confidence },
      },
    };
    // A clip already on that lane under the idea's start is shortened so the
    // idea is heard on its own (Hear mine and Undo give it back).
    const ideaEnd = want.startBeat + want.durationBeats;
    for (const c of state.clips) {
      if (c.id === m.clipId || c.trackIndex !== trackIndex) continue;
      const end = c.timelineStartBeat + c.durationBeats;
      if (c.timelineStartBeat < want.startBeat - 1e-9 && end > want.startBeat + 1e-9) {
        const shorter = rt(want.startBeat - c.timelineStartBeat);
        if (shorter >= MIN_CLIP_DURATION_BEATS) {
          const before = clipObject(state, c.id);
          fields.push({
            key: `${c.id}:clip`, value: { ...before, durationBeats: shorter },
            label: (st) => `${st.tracks[c.trackIndex].name} clip under the idea`,
            read: (st) => clipObject(st, c.id),
            command: (st, v) => clipCommands(st, c.id, v, null),
            show: showClip(bpb),
          });
          notes.push(`the ${state.tracks[trackIndex].name} clip underneath now ends at ${fmtPos(want.startBeat, bpb)}`);
        }
      } else if (c.timelineStartBeat >= want.startBeat - 1e-9 && c.timelineStartBeat < ideaEnd - 1e-9) {
        notes.push(`another ${state.tracks[trackIndex].name} clip also plays from ${fmtPos(c.timelineStartBeat, bpb)}`);
      }
    }
    if (spec.main && m.clipId === spec.main.clipId) vocalEnd = want.startBeat + want.durationBeats;
    fields.push({
      key: `${m.clipId}:clip`, value: want, main: Boolean(spec.main && m.clipId === spec.main.clipId),
      label: () => `${m.song} ${ROLE_LABEL[m.stem]} idea`,
      read: (st) => clipObject(st, m.clipId),
      command: (st, v) => clipCommands(st, m.clipId, v, load),
      show: showClip(bpb),
      preview: { trackIndex, startBeat: want.startBeat, durationBeats: want.durationBeats, label: `${m.song} ${ROLE_LABEL[m.stem]} · ${m.passage.name}`, clipId: m.clipId },
    });
    const evidence = m.passage.basis === 'musician' ? 'as you named it' : `estimated: ${m.passage.evidence.slice(0, 2).join(', ') || 'from the audio'}`;
    const fit = m.speed === 'fit' && Math.abs(nativeBpm - bpm) > 1e-6 ? `, fitted from ${nativeBpm} to ${bpm} BPM` : m.speed === 'natural' ? ', at its own speed' : '';
    const extras = [m.pitch ? `${signed(m.pitch)} semitones` : null, m.fadeIn ? `fade in ${plural(r3(m.fadeIn), 'beat')}` : null,
      m.fadeOut ? `fade out ${plural(r3(m.fadeOut), 'beat')}` : null, m.gainDb ? `${signed(m.gainDb)} dB` : null].filter(Boolean);
    notes.unshift(`${m.song} ${ROLE_LABEL[m.stem]}: ${m.passage.name} of “${group.title}” (song bars ${m.passage.startBar}–${m.passage.startBar + m.passage.bars - 1}, ${mmss(m.passage.startSec)}–${mmss(m.passage.endSec)}; ${evidence})${m.heardNote ? `, ${m.heardNote}` : ''}, at ${fmtPos(want.startBeat, bpb)}${fit}${extras.length ? `, ${extras.join(', ')}` : ''}`);
  }
  for (const trim of spec.trims ?? []) {
    const lane = laneIndex(trim.song, trim.stem);
    const clip = state.clips.find((item) => item.trackIndex === lane && !String(item.id).startsWith('idea-'));
    if (!clip) continue;
    const endBeat = trim.atVocalEnd && vocalEnd != null ? vocalEnd : trim.endBeat;
    const duration = rt(endBeat - clip.timelineStartBeat);
    if (!(duration >= 1) || duration >= clip.durationBeats - 0.05) continue;
    spec.clips = { ...(spec.clips ?? {}), [clip.id]: { durationBeats: duration, fadeOut: duration >= 4 ? 2 : 0 } };
  }
  for (const clipId of spec.drop ?? []) {
    const before = clipObject(state, clipId);
    if (!before.exists) continue;
    const c = state.clips.find((x) => x.id === clipId);
    fields.push({
      key: `${clipId}:clip`,
      value: { exists: false },
      label: (st) => `${st.tracks[c.trackIndex].name} clip`,
      read: (st) => clipObject(st, clipId),
      command: (st, v) => clipCommands(st, clipId, v, null),
      show: showClip(bpb),
    });
    notes.push(`${state.tracks[c.trackIndex].name} leaves the arrangement`);
  }
  for (const [clipId, changes] of Object.entries(spec.clips ?? {})) {
    const before = clipObject(state, clipId);
    if (!before.exists) return { refusal: 'A clip in the idea is not on the lanes any more.', fields: [] };
    const want = ordered({ ...before, ...changes, startBeat: rt(changes.startBeat ?? before.startBeat), gainDb: changes.gainDb ?? before.gainDb });
    const c = state.clips.find((x) => x.id === clipId);
    fields.push({
      key: `${clipId}:clip`, value: want,
      label: (st) => `${st.tracks[c.trackIndex].name} clip`,
      read: (st) => clipObject(st, clipId),
      command: (st, v) => clipCommands(st, clipId, v, null),
      show: showClip(bpb),
      preview: { trackIndex: want.trackIndex, startBeat: want.startBeat, durationBeats: want.durationBeats, label: `${state.tracks[c.trackIndex].name} (idea)`, clipId },
    });
    notes.push(`${state.tracks[c.trackIndex].name}: ${showClip(bpb)(want)}`);
  }
  for (const [i, m] of Object.entries(spec.mixer ?? {})) {
    for (const [key, value] of Object.entries(m)) {
      fields.push(trackFieldFor(Number(i), key, value));
      notes.push(`${state.tracks[i].name} ${key === 'volumeDb' ? `level ${value} dB` : key === 'mute' ? (value ? 'muted' : 'unmuted') : (value ? 'solo' : 'not solo')}`);
    }
  }
  for (const [i, points] of Object.entries(spec.envelopes ?? {})) {
    const index = Number(i);
    const track = state.tracks[index];
    if (!track || !Array.isArray(points) || points.length < 2) return { refusal: "I can't see that vocal lane.", fields: [] };
    const end = points[points.length - 1];
    fields.push({
      key: `${index}:gainEnvelope`,
      envelope: true,
      trackIndex: index,
      anchorVolumeDb: track.volumeDb,
      value: points,
      label: (st) => `${st.tracks[index].name} entrance`,
      read: (st) => (st.tracks[index].gainPoints ?? []).map((p) => ({ beat: p.beat, db: p.db })),
      command: (_st, v) => ({ name: 'setTrackGainEnvelope', args: { trackIndex: index, points: v ?? [] } }),
      show: (v) => (Array.isArray(v) && v.length ? v.map((p) => `${fmtPos(p.beat, bpb)} ${p.db === 0 ? 'at the fader' : `${Math.abs(p.db)} dB ${p.db < 0 ? 'under' : 'over'} the fader`}`).join(' → ') : 'cleared'),
    });
    notes.push(`${track.name} rises from ${Math.abs(points[0].db)} dB under its fader at ${fmtPos(points[0].beat, bpb)} to the fader by ${fmtPos(end.beat, bpb)}. The fader stays at ${track.volumeDb} dB`);
  }
  return { fields, rationale: notes.join('; '), clipId: spec.main?.clipId };
}

/** A refused dry-run, in the musician's words. */
export function refusalText(error) {
  const msg = error?.message ?? String(error ?? 'refused');
  if (/semitones must be/.test(msg)) return 'That is further than a clip can be pitched (12 semitones either way).';
  if (/gainDb|gain/.test(msg) && /must be/.test(msg)) return 'That is more gain than a clip can take (±24 dB).';
  if (/BEYOND_ASSET|runs past the end/.test(msg)) return 'There is not enough of that recording left for it.';
  if (/startBeat|newStartBeat/.test(msg)) return 'That would start before bar 1.';
  return `The DAW refused it: ${msg}.`;
}
