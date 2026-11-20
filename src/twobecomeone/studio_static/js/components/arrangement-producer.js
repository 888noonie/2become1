// js/components/arrangement-producer.js — the AI Producer inside the arrangement.
//
// OPERATION FULL HOUSE, Stage D. The accepted Hear it / Hear mine / Keep /
// Undo interaction (OPERATION TWO BECOME ONE) on the arrangement's own data:
//
//   * A suggestion is a list of ordinary edit commands. It is dry-run through
//     EditEngine.propose() first; an invalid one is never shown as playable.
//   * Hear it / Hear mine / Keep / Undo each apply ONE validated batch through
//     the same DawSession.apply path as a hand edit. There is no second
//     snapshot or project system: the captured "before" is just the values of
//     the fields the suggestion touches, read from ProjectState.
//   * Human edits win. A field the musician changes after the idea arrived is
//     theirs: no flip, Keep or Undo writes it again.
//   * Nothing here starts playback.

import { createElement as h, replaceChildren } from '../dom.js';
import { GROUP_BASE, ROLES, SAMPLE_RATE, peaksFor } from '../arrangement/daw-session.js';
import { beatsToSourceSeconds, sourceAdvanceRate } from '../arrangement/time-math.js';
import { MIN_CLIP_DURATION_BEATS } from '../arrangement/time-math.js';

/**
 * The same musical rule as the accepted Stem Desk suggester, as arrangement
 * commands: A keeps drums and bass, B keeps vocals and other. Lanes with no
 * clips are left alone.
 */
export function suggestArrangementIdea(state) {
  const keep = new Set([GROUP_BASE.A + ROLES.indexOf('drums'), GROUP_BASE.A + ROLES.indexOf('bass'),
    GROUP_BASE.B + ROLES.indexOf('vocals'), GROUP_BASE.B + ROLES.indexOf('other')]);
  const used = new Set(state.clips.map((c) => c.trackIndex));
  const fields = [];
  for (const track of state.tracks) {
    if (!used.has(track.trackIndex)) continue;
    fields.push({ trackIndex: track.trackIndex, field: 'mute', value: !keep.has(track.trackIndex) });
  }
  return {
    rationale: 'A keeps its drums and bass; B brings its vocals and other parts over them.',
    fields,
  };
}

// A proposal is a list of FIELDS. A field names one value in ProjectState, how
// to read it, and the ordinary edit command that writes it. The same shape
// serves the mix idea (track mutes) and the clip idea (position, source
// in-point, length, gain, fades), so Hear it / Hear mine / Keep / Undo and the
// "your moves win" rule are one piece of code.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clipOf = (state, id) => state.clips.find((c) => c.id === id);

function trackField(f) {
  return {
    key: `${f.trackIndex}:${f.field}`,
    value: f.value,
    label: (state) => state.tracks[f.trackIndex].name,
    read: (state) => state.tracks[f.trackIndex][f.field],
    command: (_state, value) => (f.field === 'mute'
      ? { name: 'setTrackMute', args: { trackIndex: f.trackIndex, mute: value } }
      : { name: 'setTrackVolume', args: { trackIndex: f.trackIndex, volumeDb: value } }),
    show: (value) => (f.field === 'mute' ? (value ? 'muted' : 'playing') : `${value} dB`),
  };
}

const fmtSec = (v) => `${Number(v).toFixed(3)} s`;
const fmtBar = (beat, bpb) => `bar ${Math.floor(beat / bpb) + 1} · beat ${Math.floor(beat % bpb) + 1}`;

/**
 * Where each phrase of a stem begins, in source seconds, found from the
 * decoded loudness peaks: a phrase starts when sound returns after at least
 * `gapSec` of near-silence. This is a loudness heuristic, not lyric or note
 * recognition.
 */
export function phraseStarts(peaks, { gapSec = 0.4, floorRatio = 0.08 } = {}) {
  if (!peaks?.max?.length) return [];
  const level = (i) => Math.max(Math.abs(peaks.min[i]), Math.abs(peaks.max[i]));
  let top = 0;
  for (let i = 0; i < peaks.max.length; i += 1) top = Math.max(top, level(i));
  if (top <= 0) return [];
  const floor = top * floorRatio;
  const gapBuckets = Math.ceil((gapSec * SAMPLE_RATE) / peaks.bucketFrames);
  const starts = [];
  let quiet = gapBuckets; // the stem start counts as preceded by silence
  for (let i = 0; i < peaks.max.length; i += 1) {
    if (level(i) >= floor) {
      if (quiet >= gapBuckets) starts.push((i * peaks.bucketFrames) / SAMPLE_RATE);
      quiet = 0;
    } else quiet += 1;
  }
  return starts;
}

/**
 * A structured clip idea: put `clipId` at `startBar`, play the stem from
 * `sourceOffsetSec` (or from the start of detected phrase number `phrase`),
 * fade in over `fadeInBeats` and change the clip gain to `gainDb`. Each part
 * is optional. Natural-language requests are NOT interpreted here: the caller
 * supplies typed values. When the later in-point leaves too little stem for the
 * clip's current length, the idea also shortens the clip's end, and says so.
 */
export function suggestClipIdea(state, spec, { peaks } = {}) {
  const clip = clipOf(state, spec.clipId);
  if (!clip) return { refusal: 'That clip is not on the lanes.', fields: [] };
  const asset = state.assets[clip.assetId];
  const bpm = state.transport.masterBpm;
  const bpb = state.transport.timeSignature[0];
  const parts = [];
  const fields = [];
  let offset = clip.sourceOffsetSec;
  let duration = clip.durationBeats;
  const name = state.tracks[clip.trackIndex].name;

  if (Number.isFinite(spec.phrase) && spec.sourceOffsetSec == null) {
    const starts = phraseStarts(peaks ?? peaksFor(asset.bufferReference));
    if (starts.length < spec.phrase) {
      return { refusal: `Only ${starts.length} phrase${starts.length === 1 ? '' : 's'} found in this stem, so there is no phrase ${spec.phrase}.`, fields: [] };
    }
    spec = { ...spec, sourceOffsetSec: Math.round(starts[spec.phrase - 1] * 1000) / 1000 };
  }
  if (Number.isFinite(spec.sourceOffsetSec)) {
    offset = spec.sourceOffsetSec;
    if (offset !== clip.sourceOffsetSec) {
      // Keep the clip inside the stem: shorten its end only if it must.
      const rate = sourceAdvanceRate(clip, asset, bpm);
      const maxSpan = Math.max(0, asset.durationSec - offset);
      const maxBeats = Math.floor((maxSpan / rate / (60 / bpm)) * 1e6) / 1e6;
      if (beatsToSourceSeconds(duration, clip, asset, bpm) > maxSpan + 1e-9) {
        duration = Math.max(MIN_CLIP_DURATION_BEATS, maxBeats);
        fields.push({
          key: `${clip.id}:length`, value: duration,
          label: () => `${name} length`,
          read: (st) => clipOf(st, clip.id).durationBeats,
          command: (st, v) => ({ name: 'trimClip', args: { clipId: clip.id, edge: 'end', deltaBeats: v - clipOf(st, clip.id).durationBeats } }),
          show: (v) => `${(v / bpb).toFixed(2)} bars`,
        });
        parts.push('shortened to fit the rest of the stem');
      }
      fields.push({
        key: `${clip.id}:slip`, value: offset,
        label: () => `${name} source in-point`,
        read: (st) => clipOf(st, clip.id).sourceOffsetSec,
        command: (_st, v) => ({ name: 'slipClip', args: { clipId: clip.id, sourceOffsetSec: v } }),
        show: fmtSec,
      });
      parts.push(`starting from ${fmtSec(offset)} of the stem`);
    }
  }
  if (Number.isFinite(spec.startBar)) {
    const beat = (spec.startBar - 1) * bpb;
    if (beat !== clip.timelineStartBeat) {
      fields.push({
        key: `${clip.id}:position`, value: beat,
        label: () => `${name} position`,
        read: (st) => clipOf(st, clip.id).timelineStartBeat,
        command: (st, v) => ({ name: 'moveClip', args: { clipId: clip.id, newTrackIndex: clipOf(st, clip.id).trackIndex, newStartBeat: v } }),
        show: (v) => fmtBar(v, bpb),
      });
      parts.push(`at bar ${spec.startBar}`);
    }
  }
  if (Number.isFinite(spec.gainDb) && spec.gainDb !== clip.clipGainDb) {
    fields.push({
      key: `${clip.id}:gain`, value: spec.gainDb,
      label: () => `${name} clip gain`,
      read: (st) => clipOf(st, clip.id).clipGainDb,
      command: (_st, v) => ({ name: 'setClipGain', args: { clipId: clip.id, gainDb: v } }),
      show: (v) => `${v > 0 ? '+' : ''}${v} dB`,
    });
    parts.push(`${spec.gainDb} dB`);
  }
  if (Number.isFinite(spec.fadeInBeats) || Number.isFinite(spec.fadeOutBeats)) {
    const want = {
      in: Number.isFinite(spec.fadeInBeats) ? spec.fadeInBeats : clip.fadeInBeats,
      out: Number.isFinite(spec.fadeOutBeats) ? spec.fadeOutBeats : clip.fadeOutBeats,
    };
    if (want.in !== clip.fadeInBeats || want.out !== clip.fadeOutBeats) {
      fields.push({
        key: `${clip.id}:fades`, value: want,
        label: () => `${name} fades`,
        read: (st) => { const c = clipOf(st, clip.id); return { in: c.fadeInBeats, out: c.fadeOutBeats }; },
        command: (_st, v) => ({ name: 'setClipFades', args: { clipId: clip.id, fadeInBeats: v.in, fadeOutBeats: v.out } }),
        show: (v) => `in ${v.in} · out ${v.out} beats`,
      });
      parts.push(`fade in ${want.in} beat${want.in === 1 ? '' : 's'}`);
    }
  }
  return { rationale: `${name}: ${parts.join(', ') || 'nothing to change'}.`, fields, clipId: clip.id };
}

export function mountArrangementProducer({ container, session, onAnnounce = () => {}, rerender = () => {}, selectedClipId = () => null }) {
  /** idea: { fields, before: Map, last: Map (what we last wrote), touched: Set, hearing: 'idea'|'mine'|'kept' } */
  let idea = null;

  const status = h('p', { class: 'daw__producer-status', role: 'status', 'aria-live': 'polite' });
  const ask = h('button', { type: 'button', class: 'button', text: 'Ask for an idea' });
  const askClip = h('button', { type: 'button', class: 'button', text: 'Ask for a clip idea' });
  const hear = h('button', { type: 'button', class: 'button', text: 'Hear it' });
  const keep = h('button', { type: 'button', class: 'button button--primary', text: 'Keep it' });
  const reject = h('button', { type: 'button', class: 'button', text: 'Reject' });
  const details = h('ul', { class: 'daw__producer-list' });
  container.replaceChildren(h('section', { class: 'daw__producer-card', 'aria-label': 'AI Producer' }, [
    h('h3', { class: 'daw__ins-title', text: 'AI Producer' }),
    h('p', { class: 'daw__ins-sub', text: 'Hear an idea, compare it with yours, then keep it or go back. Your own moves always win.' }),
    h('div', { class: 'daw__ins-actions' }, [ask, askClip]),
    h('p', { class: 'daw__hint', text: 'A clip idea is a typed example for the selected clip (bar 9, second phrase, 1-beat fade-in, −3 dB). The Producer does not read free text yet.' }),
    h('div', { class: 'daw__ins-actions' }, [hear, keep, reject]),
    details,
    status,
  ]));

  function say(text) { status.textContent = text; onAnnounce(text); }

  /** Fields the musician changed since we last wrote them become theirs. */
  function noteHumanMoves() {
    if (!idea) return;
    const state = session.state;
    for (const f of idea.fields) {
      if (!idea.touched.has(f.key) && !same(f.read(state), idea.last.get(f.key))) idea.touched.add(f.key);
    }
  }

  /**
   * Write `values(f)` to every field the musician has not touched, as ONE
   * edit. Going back runs the commands in reverse so a lengthened clip is
   * restored only after its in-point has moved back.
   */
  function writeAll(values, reverse = false) {
    const commands = [];
    const wrote = [];
    const ordered = reverse ? [...idea.fields].reverse() : idea.fields;
    for (const f of ordered) {
      if (idea.touched.has(f.key)) continue;
      const v = values(f);
      if (!same(f.read(session.state), v)) commands.push(f.command(session.state, v));
      wrote.push([f.key, v]);
    }
    const ok = commands.length ? session.apply({ name: 'batch', args: { commands } }).ok : true;
    if (ok) for (const [k, v] of wrote) idea.last.set(k, v);
    return ok;
  }

  function sync() {
    noteHumanMoves();
    const ready = session.state.clips.length > 0;
    ask.disabled = !ready;
    askClip.disabled = !ready;
    hear.disabled = !idea || idea.hearing === 'kept';
    keep.disabled = !idea;
    reject.disabled = !idea || idea.hearing === 'kept';
    hear.textContent = idea?.hearing === 'idea' ? 'Hear mine' : 'Hear it';
    keep.textContent = !idea ? 'Keep it' : idea.hearing === 'kept' ? 'Undo' : idea.hearing === 'mine' ? 'Keep mine' : 'Keep it';
    replaceChildren(details, idea ? idea.fields.map((f) => h('li', {
      class: idea.touched.has(f.key) ? 'is-yours' : '',
      dataset: { field: f.key },
      text: `${f.label(session.state)}: ${f.show(f.value)}${f.clip ? ` (was ${f.show(idea.before.get(f.key))})` : ''}${idea.touched.has(f.key) ? ' — yours now' : ''}`,
    })) : []);
  }

  /** Dry-run the idea through propose(); only a valid one becomes an idea. */
  function offer(proposal, empty) {
    if (!proposal.fields.length) { say(proposal.refusal ?? empty); return; }
    const commands = proposal.fields.map((f) => f.command(session.state, f.value));
    const dry = session.edit.propose({ name: 'batch', args: { commands } });
    if (dry.status !== 'pending') { say(`The idea did not validate: ${dry.errors?.[0]?.message ?? 'refused'}.`); return; }
    const state = session.state;
    for (const f of proposal.fields) f.clip = proposal.clipId !== undefined;
    idea = {
      fields: proposal.fields,
      before: new Map(proposal.fields.map((f) => [f.key, f.read(state)])),
      last: new Map(proposal.fields.map((f) => [f.key, f.read(state)])),
      touched: new Set(),
      hearing: 'mine',
    };
    say(`Idea: ${proposal.rationale} Nothing changes until you press Hear it.`);
    sync();
  }

  ask.addEventListener('click', () => {
    const proposal = suggestArrangementIdea(session.state);
    offer({ rationale: proposal.rationale, fields: proposal.fields.map(trackField) }, 'Bring stems onto the lanes first.');
  });

  askClip.addEventListener('click', () => {
    const state = session.state;
    const bVocals = GROUP_BASE.B + ROLES.indexOf('vocals');
    const clip = state.clips.find((c) => c.id === selectedClipId()) ?? state.clips.find((c) => c.trackIndex === bVocals) ?? state.clips[0];
    if (!clip) { say('Bring stems onto the lanes first.'); return; }
    offer(suggestClipIdea(state, { clipId: clip.id, startBar: 9, phrase: 2, fadeInBeats: 1, gainDb: -3 }),
      'That clip already matches the idea.');
  });

  hear.addEventListener('click', () => {
    if (!idea || idea.hearing === 'kept') return;
    noteHumanMoves();
    if (idea.hearing === 'idea') {
      if (writeAll((f) => idea.before.get(f.key), true)) idea.hearing = 'mine';
      say('Hearing your version.');
    } else {
      if (writeAll((f) => f.value)) idea.hearing = 'idea';
      say('Hearing the idea. Move anything you like; your moves stay yours.');
    }
    sync();
    rerender();
  });

  keep.addEventListener('click', () => {
    if (!idea) return;
    noteHumanMoves();
    if (idea.hearing === 'kept') {
      // Undo: back to what it was before the idea, except what you moved.
      writeAll((f) => idea.before.get(f.key), true);
      idea = null;
      say('Back to your version from before the idea. Your own moves were kept.');
    } else if (idea.hearing === 'mine') {
      idea = null;
      say('Kept your version. The idea was set aside.');
    } else {
      idea.hearing = 'kept';
      say('Kept the idea. Undo returns to your version from before it.');
    }
    sync();
    rerender();
    if (keep.isConnected) keep.focus();
  });

  reject.addEventListener('click', () => {
    if (!idea) return;
    noteHumanMoves();
    if (idea.hearing === 'idea') writeAll((f) => idea.before.get(f.key), true);
    idea = null;
    say('Idea rejected. Your arrangement is as it was.');
    sync();
    rerender();
  });

  sync();
  const timer = container.ownerDocument.defaultView.setInterval(() => { if (container.isConnected) sync(); }, 500);
  return () => container.ownerDocument.defaultView.clearInterval(timer);
}
