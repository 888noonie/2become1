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
import { applyIntent, buildIdea, clipObject, entranceRequest, halfBeatOnly, laneIndex, localCommand, mmss, projectSummary, refusalText } from '../arrangement/producer-intent.js';
import { arrangementBeatForSource, arrangementPlans, bedDipPoints, chorusUtterance, deckChoice, descriptorFrom, entrancePoints, explainCandidate, measurePlan, pickPlan, pitchFor, playbackSpeed, scoredRows, stylePlan, targetSection } from '../arrangement/chorus-fit.js';

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


const SECTION_LABELS = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'instrumental', 'breakdown', 'outro', 'section'];
const flat = (cmd) => [].concat(cmd ?? []);

/**
 * The AI Producer card: the accepted Hear it / Hear mine / Keep / Undo
 * interaction, the typed examples, and (OPERATION THE LISTENING ROOM) a
 * conversation with a language model about the songs on the lanes.
 *
 * Returns {dispose, preview}; `preview()` lists the idea's clips that are not
 * on the lanes yet so the timeline can draw them as outlines.
 */
export function mountArrangementProducer({ container, session, onAnnounce = () => {}, rerender = () => {}, selectedClipId = () => null, fetchImpl = null }) {
  /** idea: { fields, before: Map, last: Map, touched: Set, hearing: 'idea'|'mine'|'kept', spec? } */
  let idea = null;
  const fetcher = fetchImpl ?? session.deps?.fetchImpl ?? ((...a) => fetch(...a));
  const conv = { spec: null, history: [], analyses: {}, busy: false, model: null, absorbed: null, pending: null, mode: 'jam', harmony: null, decks: null, epoch: 0 };

  const status = h('p', { class: 'daw__producer-status', role: 'status', 'aria-live': 'polite' });
  const youPlay = h('button', { type: 'button', class: 'button', text: 'You play', 'aria-pressed': 'false' });
  const jam = h('button', { type: 'button', class: 'button is-on', text: 'Jam together', 'aria-pressed': 'true' });
  const decks = h('button', { type: 'button', class: 'button', text: 'Take the decks', 'aria-pressed': 'false' });
  const takeBack = h('button', { type: 'button', class: 'button', text: 'Take back' });
  const ask = h('button', { type: 'button', class: 'button', text: 'Ask for an idea' });
  const askClip = h('button', { type: 'button', class: 'button', text: 'Ask for a clip idea' });
  const hear = h('button', { type: 'button', class: 'button', text: 'Hear it' });
  const keep = h('button', { type: 'button', class: 'button button--primary', text: 'Keep it' });
  const reject = h('button', { type: 'button', class: 'button', text: 'Reject' });
  const details = h('ul', { class: 'daw__producer-list' });
  const input = h('input', {
    type: 'text', class: 'daw__talk-input', maxlength: '400', autocomplete: 'off', spellcheck: 'true',
    'aria-label': 'Tell the Producer', placeholder: 'e.g. find the second chorus in the other song and put its vocals at bar 17',
  });
  const send = h('button', { type: 'submit', class: 'button button--primary', text: 'Send' });
  const talk = h('form', { class: 'daw__talk', 'aria-label': 'Talk to the Producer' }, [input, send]);
  const log = h('ol', { class: 'daw__talk-log', 'aria-label': 'Conversation with the Producer' });
  const modelLine = h('p', { class: 'daw__hint daw__talk-model', text: 'Checking the Producer’s model…' });
  const heardBox = h('details', { class: 'daw__heard' }, [h('summary', { text: 'What I heard in the songs' })]);
  container.replaceChildren(h('section', { class: 'daw__producer-card', 'aria-label': 'AI Producer' }, [
    h('h3', { class: 'daw__ins-title', text: 'AI Producer' }),
    h('p', { class: 'daw__ins-sub', text: 'You play, jam together, or hand me the decks. Hear it, compare it with yours, then keep it or go back. Your own moves always win.' }),
    h('div', { class: 'daw__ins-actions daw__modes' }, [youPlay, jam, decks, takeBack]),
    talk,
    modelLine,
    log,
    h('div', { class: 'daw__ins-actions' }, [hear, keep, reject]),
    details,
    status,
    heardBox,
    h('div', { class: 'daw__ins-actions daw__producer-examples' }, [ask, askClip]),
  ]));

  function say(text) { status.textContent = text; onAnnounce(text); }

  function line(role, text, extra = '') {
    log.append(h('li', { class: `daw__talk-${role}${extra ? ` ${extra}` : ''}`, text }));
    log.dataset.lines = String(Number(log.dataset.lines || 0) + 1); // the log shows only the last 8
    while (log.children.length > 8) log.firstElementChild.remove();
    conv.history.push({ role: role === 'you' ? 'musician' : 'producer', text });
    if (conv.history.length > 16) conv.history.splice(0, conv.history.length - 16);
  }

  /** Fields the musician changed since we last wrote them become theirs. */
  function noteHumanMoves() {
    if (!idea) return;
    const state = session.state;
    const drop = [];
    const touchedBefore = idea.touched.size;
    for (const f of idea.fields) {
      if (f.envelope) {
        const tr = state.tracks[f.trackIndex];
        const pointsNow = tr?.gainPoints ?? [];
        if (tr && (tr.volumeDb !== f.anchorVolumeDb || !same(pointsNow, idea.last.get(f.key)))) drop.push(f);
        continue;
      }
      if (!idea.touched.has(f.key) && !same(f.read(state), idea.last.get(f.key))) idea.touched.add(f.key);
    }
    if (drop.length || idea.touched.size > touchedBefore) {
      conv.yieldedTracks ??= new Set();
      for (const f of drop) conv.yieldedTracks.add(f.trackIndex);
      if (conv.mode === 'decks') {
        conv.mode = 'jam';
        conv.epoch += 1;
        say('You moved that. I have left the decks.');
      }
    }
    if (!drop.length) return;
    // A hand edit of that entrance replaces the pending curve. Hear it must not write it back.
    idea.fields = idea.fields.filter((f) => !drop.includes(f));
    if (conv.spec?.envelopes) for (const f of drop) delete conv.spec.envelopes[f.trackIndex];
    if (!idea.fields.length) {
      idea = null;
      conv.spec = null;
      say('Your edit stands. That level move is set aside.');
    }
    rerender(); // the lane stops marking that curve as an idea
  }

  /**
   * Write `values(f)` to every field the musician has not touched, as ONE
   * edit (or one step of a gesture). Going back runs the commands in reverse
   * so a lengthened clip is restored only after its in-point has moved back.
   */
  function writeAll(values, reverse = false, gestureKey = null) {
    const commands = [];
    const wrote = [];
    const ordered = reverse ? [...idea.fields].reverse() : idea.fields;
    let state = session.state;
    for (const f of ordered) {
      if (idea.touched.has(f.key)) continue;
      const v = values(f);
      if (!same(f.read(state), v)) commands.push(...flat(f.command(state, v)));
      wrote.push(f);
    }
    const ok = commands.length ? session.apply({ name: 'batch', args: { commands } }, gestureKey).ok : true;
    // Remember what the project now holds (the edit API may round or clamp),
    // so only a real human move counts as one.
    state = session.state;
    if (ok) for (const f of wrote) idea.last.set(f.key, f.read(state));
    return ok;
  }

  function sync() {
    noteHumanMoves();
    const ready = session.state.clips.length > 0;
    ask.disabled = !ready;
    askClip.disabled = !ready;
    for (const [button, on] of [[youPlay, conv.mode === 'you-play'], [jam, conv.mode === 'jam'], [decks, conv.mode === 'decks']]) {
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    send.disabled = conv.busy;
    input.disabled = conv.busy;
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
  function offer(proposal, empty, spec = null) {
    if (!proposal.fields.length) { say(proposal.refusal ?? empty); return false; }
    const commands = proposal.fields.flatMap((f) => flat(f.command(session.state, f.value)));
    const dry = commands.length ? session.edit.propose({ name: 'batch', args: { commands } }) : { status: 'pending' };
    if (dry.status !== 'pending') { say(`The idea did not validate: ${dry.errors?.[0]?.message ?? 'refused'}.`); return false; }
    const state = session.state;
    for (const f of proposal.fields) f.clip = proposal.clipId !== undefined || f.key.endsWith(':clip');
    idea = {
      fields: proposal.fields,
      before: new Map(proposal.fields.map((f) => [f.key, f.read(state)])),
      last: new Map(proposal.fields.map((f) => [f.key, f.read(state)])),
      touched: new Set(),
      hearing: 'mine',
      spec,
      rationale: proposal.rationale,
    };
    say(`Idea: ${proposal.rationale} Nothing changes until you press Hear it.`);
    sync();
    rerender();
    return true;
  }

  function hearToggle() {
    if (!idea || idea.hearing === 'kept') return false;
    noteHumanMoves();
    if (!idea || idea.hearing === 'kept') return false;
    if (idea.hearing === 'idea') {
      if (writeAll((f) => idea.before.get(f.key), true)) idea.hearing = 'mine';
      say('Hearing your version.');
    } else {
      if (writeAll((f) => f.value)) idea.hearing = 'idea';
      else { say('The idea could not be applied as it stands; nothing changed.'); }
      if (idea.hearing === 'idea') say('Hearing the idea. Move anything you like; your moves stay yours.');
    }
    if (conv.spec) {
      conv.spec.heard = idea.hearing === 'idea';
      if (idea.hearing === 'idea') delete conv.spec.fresh;
    }
    sync();
    rerender();
    return true;
  }

  function keepOrUndo() {
    if (!idea) return false;
    noteHumanMoves();
    if (!idea) return false;
    if (idea.hearing === 'kept') {
      writeAll((f) => idea.before.get(f.key), true);
      idea = null;
      conv.spec = null;
      say('Back to your version from before the idea. Your own moves were kept.');
    } else if (idea.hearing === 'mine') {
      idea = null;
      conv.spec = null;
      say('Kept your version. The idea was set aside.');
    } else {
      const owned = idea.fields.filter((f) => f.key.endsWith(':clip')).map((f) => f.key.slice(0, -5));
      conv.musicianClips = new Set([...(conv.musicianClips ?? []), ...owned]);
      conv.partIds = (conv.partIds ?? []).filter((id) => !conv.musicianClips.has(id));
      idea.hearing = 'kept';
      conv.spec = null;
      say('Kept the idea. Undo returns to your version from before it.');
    }
    sync();
    rerender();
    return true;
  }

  function rejectIdea() {
    if (!idea) return;
    noteHumanMoves();
    if (!idea) return;
    if (idea.hearing === 'idea') writeAll((f) => idea.before.get(f.key), true);
    idea = null;
    conv.spec = null;
    say('Idea rejected. Your arrangement is as it was.');
    sync();
    rerender();
  }

  youPlay.addEventListener('click', () => {
    conv.cancelled = true;
    conv.epoch += 1;
    if (typeof session.stop === 'function') session.stop();
    setMode('you-play');
    say('You play. The lanes stay yours.');
  });
  jam.addEventListener('click', () => {
    conv.cancelled = false;
    setMode('jam');
    say('Jam together. An idea waits until you press Hear it.');
  });
  decks.addEventListener('click', () => {
    input.value = 'Take the decks';
    talk.dispatchEvent(new container.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  });
  takeBack.addEventListener('click', () => {
    input.value = 'Take back';
    talk.dispatchEvent(new container.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  });

  ask.addEventListener('click', () => {
    const proposal = suggestArrangementIdea(session.state);
    conv.spec = null;
    offer({ rationale: proposal.rationale, fields: proposal.fields.map(trackField) }, 'Bring stems onto the lanes first.');
  });

  askClip.addEventListener('click', () => {
    const state = session.state;
    const bVocals = GROUP_BASE.B + ROLES.indexOf('vocals');
    const clip = state.clips.find((c) => c.id === selectedClipId()) ?? state.clips.find((c) => c.trackIndex === bVocals) ?? state.clips[0];
    if (!clip) { say('Bring stems onto the lanes first.'); return; }
    conv.spec = null;
    offer(suggestClipIdea(state, { clipId: clip.id, startBar: 9, phrase: 2, fadeInBeats: 1, gainDb: -3 }),
      'That clip already matches the idea.');
  });

  hear.addEventListener('click', () => { void commitIdea(); });
  keep.addEventListener('click', () => { keepOrUndo(); if (keep.isConnected) keep.focus(); });
  reject.addEventListener('click', rejectIdea);

  // ------------------------------------------------------------ listening

  async function json(url, init) {
    const res = await fetcher(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(body?.error?.message || `${url} answered ${res.status}`);
      err.code = body?.error?.code;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** The analysis of every song on the lanes (cached by the server per recording). */
  async function analysesFor(groups, { compute = false } = {}) {
    for (const [g, info] of Object.entries(groups)) {
      if (conv.analyses[g]?.trackId === info.trackId) continue;
      try {
        conv.analyses[g] = await json(`/api/tracks/${encodeURIComponent(info.trackId)}/listening`, compute ? { method: 'POST' } : undefined);
      } catch (err) {
        if (err.status !== 404) throw err;
        delete conv.analyses[g];
      }
    }
    for (const g of Object.keys(conv.analyses)) if (!groups[g]) delete conv.analyses[g];
    renderHeard(groups);
    return conv.analyses;
  }

  function renderHeard(groups) {
    const rows = [h('summary', { text: 'What I heard in the songs' })];
    for (const [g, info] of Object.entries(groups)) {
      const a = conv.analyses[g];
      if (!a) {
        const go = h('button', { type: 'button', class: 'button', text: `Listen to ${g}` });
        go.addEventListener('click', async () => {
          go.disabled = true;
          go.textContent = 'Listening…';
          try { await analysesFor({ [g]: info }, { compute: true }); } catch (err) { say(`Could not listen to ${info.title}: ${err.message}`); }
        });
        rows.push(h('div', { class: 'daw__heard-song' }, [h('p', { class: 'daw__ins-sub', text: `${g} · ${info.title}: not listened to yet.` }), go]));
        continue;
      }
      const items = a.sections.map((s) => {
        const select = h('select', { 'aria-label': `${g} ${s.name}, bars ${s.startBar} to ${s.startBar + s.bars - 1}: name this part` },
          SECTION_LABELS.map((label) => h('option', { value: label, text: label, selected: label === s.label ? 'selected' : undefined })));
        select.value = s.label;
        select.addEventListener('change', () => { void relabel(g, s.id, select.value); });
        const words = s.lyrics?.text ? ` · heard (rough): “${s.lyrics.text.slice(0, 70)}${s.lyrics.text.length > 70 ? '…' : ''}”` : '';
        return h('li', { class: s.basis === 'musician' ? 'is-yours' : '' }, [
          select,
          h('span', { text: ` ${s.name} · song bars ${s.startBar}–${s.startBar + s.bars - 1} · ${mmss(s.startSec)}–${mmss(s.endSec)} · ${s.basis === 'musician' ? 'named by you' : `estimate ${Math.round(s.confidence * 100)}%`}${words}` }),
        ]);
      });
      rows.push(h('div', { class: 'daw__heard-song' }, [
        h('p', { class: 'daw__ins-sub', text: `${g} · ${a.title} · ${a.bpm} BPM · ${a.lyrics?.available ? a.lyrics.note : `no lyrics: ${a.lyrics?.note ?? ''}`}` }),
        h('ol', { class: 'daw__heard-list' }, items),
      ]));
    }
    replaceChildren(heardBox, rows);
  }

  async function relabel(song, sectionId, label) {
    const a = conv.analyses[song];
    if (!a) return;
    const sections = a.sections.map((s) => ({ startSec: s.startSec, endSec: s.endSec, label: s.id === sectionId ? label : s.label }));
    try {
      conv.analyses[song] = await json(`/api/tracks/${encodeURIComponent(a.trackId)}/listening/sections`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sections }),
      });
      renderHeard(session.groups());
      const named = conv.analyses[song].sections.find((s) => s.startSec === a.sections.find((x) => x.id === sectionId)?.startSec);
      const text = `Noted: that part of ${a.title} is ${named?.name ?? label} now. I'll remember it for this recording.`;
      say(text);
      return text;
    } catch (err) {
      say(`Could not rename it: ${err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------ conversation

  function mineGroup() {
    const clip = session.state.clips.find((c) => c.id === selectedClipId());
    if (clip) return clip.trackIndex < 4 ? 'A' : 'B';
    return session.groups().A ? 'A' : null;
  }

  /** The musician's own moves on the idea become the base of the next version. */
  function absorbHumanMoves(spec) {
    if (!idea || !spec?.main) return spec;
    const main = idea.fields.find((f) => f.main);
    if (main && idea.touched.has(main.key)) {
      const now = clipObject(session.state, spec.main.clipId);
      if (now.exists) {
        Object.assign(spec.main, {
          startBeat: now.startBeat, pitch: now.pitch, fadeIn: now.fadeIn, fadeOut: now.fadeOut, gainDb: now.gainDb,
          sourceOffsetSec: now.sourceOffsetSec, durationBeats: now.durationBeats,
        });
        // Their move is now part of the idea: the refined version keeps it,
        // and Hear mine / Undo still return to the arrangement from before.
        conv.absorbed = main.key;
      }
    }
    return spec;
  }

  function stale(guard) {
    return conv.cancelled === true || Boolean(guard && (guard.epoch !== conv.epoch || conv.mode !== guard.mode));
  }

  /** Turn a spec into fields, decode its passage (silently) if needed, then offer or re-hear it. */
  async function realise(spec, guard = null) {
    const stopped = () => ({
      ok: false,
      text: conv.mode === 'you-play' ? 'You play is on, so I have not placed it.' : 'The decks are yours, so I have not placed it.',
    });
    const replaced = () => ({ ok: false, text: 'A new arrangement is open, so I have not placed it.' });
    const engine = session.edit;
    const bank = bankStamp();
    const groups = session.groups();
    const ctx = { analyses: conv.analyses, groups, records: session.buffers };
    let built = buildIdea(session.state, spec, ctx);
    let loads = 0;
    while (built.needsSource && loads < 6) {
      say('Fetching that passage of the stem…');
      try { await session.loadSource(built.needsSource); } catch (err) { return { ok: false, text: `I couldn't load that passage: ${err.message}` }; }
      if (session.edit !== engine) return replaced();
      if (bankStamp() !== bank) {
        return { ok: false, text: 'The songs on the lanes changed, so I have not placed it.' };
      }
      if (stale(guard)) return stopped();
      loads += 1;
      built = buildIdea(session.state, spec, ctx);
    }
    if (session.edit !== engine) return replaced();
    if (stale(guard)) return stopped();
    spec = followTempo(spec);
    built = buildIdea(session.state, spec, ctx);
    if (built.refusal) return { ok: false, text: built.refusal };
    const wasHearing = idea?.hearing === 'idea';
    const old = idea;
    const key = `producer-${Date.now()}`;
    if (wasHearing && conv.absorbed) idea.touched.delete(conv.absorbed);
    conv.absorbed = null;
    const beforeWrite = editingSerial();
    const beforeRevision = session.edit.revision;
    if (wasHearing) {
      // Swap the heard version for the refined one as ONE undo step.
      writeAll((f) => idea.before.get(f.key), true, key);
      built = buildIdea(session.state, spec, ctx);
      if (built.refusal || built.needsSource) { idea = old; writeAll((f) => f.value, false, key); session.endGesture(); return { ok: false, text: built.refusal ?? 'Try that again.' }; }
    }
    const commands = built.fields.flatMap((f) => flat(f.command(session.state, f.value)));
    const dry = commands.length ? session.edit.propose({ name: 'batch', args: { commands } }) : { status: 'pending' };
    if (dry.status !== 'pending') {
      if (wasHearing) { idea = old; writeAll((f) => f.value, false, key); session.endGesture(); }
      return { ok: false, text: refusalText(dry.errors?.[0] ?? dry.error) };
    }
    if (!commands.length && !wasHearing) return { ok: true, text: 'That is already how it sounds.' };
    conv.spec = spec;
    offer(built, 'Nothing to change.', spec);
    if (wasHearing) {
      if (writeAll((f) => f.value, false, key)) idea.hearing = 'idea';
      session.endGesture();
      spec.heard = true;
      delete spec.fresh;
      say(`Hearing the new version: ${built.rationale}`);
    }
    sync();
    rerender();
    conv.bank = bankStamp();
    return { ok: true, wrote: wasHearing, before: beforeWrite, revision: beforeRevision, text: `${wasHearing ? 'Now playing' : 'Idea'}: ${built.rationale}.${wasHearing ? '' : ' Press Hear it to listen.'}` };
  }

  async function commitIdea() {
    if (conv.mode === 'you-play') { say('You play is on, so I have not placed it.'); return false; }
    if (conv.bank && bankStamp() !== conv.bank) {
      idea = null;
      conv.spec = null;
      rerender();
      say('The songs on the lanes changed, so I have not placed it.');
      return false;
    }
    if (idea && idea.hearing !== 'idea' && idea.hearing !== 'kept') {
      const next = followTempo(conv.spec);
      if (next && next !== conv.spec) {
        const heard = await realise(next);
        if (!heard.ok) { say(heard.text); return false; }
      }
    }
    return hearToggle();
  }

  async function control(kind) {
    if (!idea) return 'There is no idea to do that with yet.';
    if (kind === 'hear_idea') {
      if (conv.mode === 'you-play') return 'You play is on, so I have not placed it.';
      if (conv.bank && bankStamp() !== conv.bank) {
        idea = null;
        conv.spec = null;
        rerender();
        return 'The songs on the lanes changed, so I have not placed it.';
      }
      if (idea.hearing !== 'idea' && idea.hearing !== 'kept') {
        return (await commitIdea()) ? 'Hearing the idea.' : 'The idea could not be applied as it stands; nothing changed.';
      }
      return 'Hearing the idea.';
    }
    if (kind === 'hear_mine') {
      if (idea.hearing === 'idea') {
        return hearToggle() ? 'Hearing your version.' : 'Your edit stands. That level move is set aside.';
      }
      // Kept means their mix is no longer what is playing. Undo for real, or the words are a lie.
      if (idea.hearing === 'kept') { keepOrUndo(); return 'Back to your version from before the idea.'; }
      return 'Hearing your version.';
    }
    // While the preview is still theirs, Keep mine discards the idea. It must not apply it.
    if (kind === 'keep') {
      if (idea.hearing === 'mine') { keepOrUndo(); return 'Kept your version. The idea was set aside.'; }
      if (idea.hearing === 'idea') { keepOrUndo(); return 'Kept it.'; }
      return 'There is nothing new to keep.';
    }
    if (kind === 'reject') { rejectIdea(); return 'Rejected. Your arrangement is as it was.'; }
    if (kind === 'undo_idea') {
      if (idea.hearing === 'kept') keepOrUndo(); else rejectIdea();
      return 'Undone. Back to your version.';
    }
    return '';
  }

  /** Say the outcome of applyIntent. `via` is set only when a model answered. */
  async function settle(outcome, via) {
    conv.pending = outcome.pending ?? null;
    let reply;
    if (outcome.control === 'relabel') {
      reply = (await relabel(outcome.song, outcome.sectionId, outcome.label)) ?? 'I could not rename that part.';
    } else if (outcome.control) {
      reply = await control(outcome.control);
    } else if (outcome.ask) {
      if (outcome.spec) conv.spec = outcome.spec;
      reply = outcome.ask;
    } else if (outcome.say) {
      reply = outcome.say;
    } else if (outcome.spec) {
      if (outcome.spec.fresh && idea && idea.hearing === 'idea') writeAll((f) => idea.before.get(f.key), true);
      if (outcome.spec.fresh) { idea = null; delete outcome.spec.fresh; }
      reply = (await realise(outcome.spec)).text;
    }
    const spoken = reply || via?.reply || 'OK.';
    line('producer', spoken, via ? `is-${via.action}` : 'is-local');
    if (via?.model) {
      log.lastElementChild.title = `${via.model.name} (${via.model.local ? 'on this machine' : 'external'}) chose “${via.action}” in ${via.model.elapsedMs} ms`;
    }
    say(spoken);
  }

  function editingSerial() {
    const copy = JSON.parse(session.edit.serialize());
    if (copy.transport) {
      delete copy.transport.playheadBeat;
      delete copy.transport.isPlaying;
    }
    return JSON.stringify(copy);
  }

  function setMode(mode) {
    if (conv.mode !== mode) conv.epoch += 1;
    conv.mode = mode;
    sync();
  }

  function clipSpeed(applyStretch, song) {
    const sourceBpm = Number(session.groups()[song]?.bpm);
    const projectRatio = sourceBpm > 0 ? session.state.transport.masterBpm / sourceBpm : null;
    return playbackSpeed(applyStretch ?? null, projectRatio);
  }

  function currentFitSpeed() {
    const row = conv.harmony?.rank ? scoredRows(conv.harmony.rank)[conv.harmony.index ?? 0] : null;
    if (!row || !conv.harmony) return null;
    const sourceBpm = Number(session.groups()[conv.harmony.sourceSong]?.bpm) || row.tempo?.sourceBpm;
    const projectRatio = sourceBpm > 0 ? session.state.transport.masterBpm / sourceBpm : null;
    return playbackSpeed(row.tempo?.applyStretch ?? null, projectRatio);
  }

  function slideCurves(spec) {
    if (!spec?.main || spec.main.startBeat == null || !spec.envelopes) return;
    const bpb = session.state.transport.timeSignature[0];
    const start = spec.main.startBeat;
    const yielded = conv.yieldedTracks ?? new Set();
    const vocal = laneIndex(spec.main.song, spec.main.stem || 'vocals');
    if (!yielded.has(vocal) && spec.envelopes[vocal]) spec.envelopes[vocal] = entrancePoints(start, bpb);
    const bed = laneIndex(spec.main.song === 'A' ? 'B' : 'A', 'vocals');
    if (!yielded.has(bed) && spec.envelopes[bed]) {
      const bars = Number(conv.harmony?.target?.bars) || 4;
      spec.envelopes[bed] = bedDipPoints(start, bars * bpb);
    }
  }

  /** Re-read tempo and the heard chorus after a wait. A bar the musician named stays put. */
  function followTempo(spec) {
    if (!spec?.main || !conv.harmony) return spec;
    const mainField = idea?.fields?.find((field) => field.main);
    if (mainField && idea.touched.has(mainField.key)) return spec;
    const speed = spec.main.speedLock ? null : currentFitSpeed();
    let start = spec.main.startBeat;
    if (spec.main.chorusAlign && conv.harmony.target?.startSec != null) {
      const beat = arrangementBeatForSource(session.state, conv.harmony.targetSong, conv.harmony.target.startSec);
      if (beat != null) start = Math.round(beat * 1e9) / 1e9;
    }
    const partsNeed = Array.isArray(spec.parts) && spec.parts.some((part) => part.applyStretch !== undefined && clipSpeed(part.applyStretch, part.song) !== part.speed);
    if ((!speed || spec.main.speed === speed) && start === spec.main.startBeat && !partsNeed) return spec;
    const next = structuredClone(spec);
    const previous = spec.main.startBeat;
    if (speed) next.main.speed = speed;
    next.main.startBeat = start;
    if (Array.isArray(next.parts)) {
      const delta = Number.isFinite(previous) ? start - previous : 0;
      next.parts = next.parts.map((part) => ({
        ...part,
        speed: part.applyStretch !== undefined ? clipSpeed(part.applyStretch, part.song) : part.speed,
        startBeat: part.afterVocal ? part.startBeat : part.startBeat + delta,
      }));
    }
    slideCurves(next);
    return next;
  }

  function bankStamp() {
    return ['A', 'B'].map((key) => {
      const group = session.groups()[key];
      return `${group?.trackId ?? ''}:${group?.stemSetId ?? ''}`;
    }).join('|');
  }

  function rememberWrite(beforeWrite, beforeRevision, count) {
    const after = editingSerial();
    const revision = session.edit.revision;
    if (!conv.decks) {
      conv.decks = { before: beforeWrite, after, revision, steps: count ? 1 : 0 };
      return;
    }
    // Same values can hide a fader edit that was put back. The revision catches it.
    if (beforeWrite !== conv.decks.after || beforeRevision !== conv.decks.revision) conv.decks.before = beforeWrite;
    conv.decks.after = after;
    conv.decks.revision = revision;
    if (count) conv.decks.steps += 1;
  }

  async function rankedFit(request) {
    const stamp = bankStamp();
    const groups = session.groups();
    await analysesFor(groups, { compute: true });
    if (bankStamp() !== stamp) return { say: 'The songs on the lanes changed, so I have not placed it.' };
    const targetSong = conv.harmony?.targetSong ?? request.targetSong ?? 'A';
    const sourceSong = conv.harmony?.sourceSong ?? request.sourceSong ?? 'B';
    const targetAnalysis = conv.analyses[targetSong];
    const sourceAnalysis = conv.analyses[sourceSong];
    if (!targetAnalysis || !sourceAnalysis) return { say: 'I need a fresh listen to both songs before I can compare them.' };
    const label = request.label ?? conv.harmony?.label ?? 'chorus';
    const target = request.kind === 'choose' && conv.harmony?.target
      ? targetAnalysis.sections.find((s) => s.id === conv.harmony.target.id) ?? targetSection(targetAnalysis, label)
      : targetSection(targetAnalysis, label);
    if (!target) return { say: `I can't find a ${label} in song ${targetSong}. Name the passage and I'll use that.` };
    if (bankStamp() !== stamp) return { say: 'The songs on the lanes changed, so I have not placed it.' };
    const rank = await json('/api/chorus-fit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: descriptorFrom(targetAnalysis, target),
        candidates: sourceAnalysis.sections.map((section) => descriptorFrom(sourceAnalysis, section)),
      }),
    });
    if (bankStamp() !== stamp) return { say: 'The songs on the lanes changed, so I have not placed it.' };
    return { groups: session.groups(), targetSong, sourceSong, target, targetAnalysis, sourceAnalysis, rank };
  }

  function rowAt(rank, index) {
    const rows = scoredRows(rank);
    if (!rows.length) return null;
    const at = Math.max(0, Math.min(index, rows.length - 1));
    return { row: rows[at], index: at, rows };
  }

  async function offerHarmony(found, { index, commit }) {
    const picked = rowAt(found.rank, index);
    if (!picked) return 'I do not have a chroma match to offer. Missing evidence is not a low score.';
    const section = found.sourceAnalysis.sections.find((s) => s.id === picked.row.id);
    if (!section) return 'That section is no longer in the analysis.';
    const previous = conv.harmony;
    const sameTarget = previous && previous.target?.id === found.target.id && previous.sourceSong === found.sourceSong;
    const pitch = pitchFor(picked.row, { auto: commit });
    const sourceBpm = Number(found.groups[found.sourceSong]?.bpm) || picked.row.tempo?.sourceBpm;
    const projectRatio = sourceBpm > 0 ? session.state.transport.masterBpm / sourceBpm : null;
    const speed = playbackSpeed(picked.row.tempo?.applyStretch, projectRatio);
    const intent = {
      action: 'propose', song: found.sourceSong, stem: previous?.stem || 'vocals', section: `${found.sourceSong}:${section.id}`, speed,
    };
    const placeOnChorus = !sameTarget || conv.spec?.main?.startBeat == null;
    const chorusBeat = placeOnChorus ? arrangementBeatForSource(session.state, found.targetSong, found.target.startSec) : null;
    if (placeOnChorus && chorusBeat == null) {
      intent.bar = found.target.startBar || 1;
      intent.beat = 1;
    }
    const spec = absorbHumanMoves(conv.spec ? structuredClone(conv.spec) : null);
    const mainField = idea?.fields?.find((field) => field.main);
    const handsOnClip = Boolean(mainField && idea.touched.has(mainField.key));
    if (!handsOnClip) intent.pitch = pitch.semitones;
    if (commit) intent.fade_in = 1;
    const outcome = applyIntent(spec, intent, {
      state: session.state, analyses: conv.analyses, groups: found.groups, sentence: '', mine: mineGroup(),
    });
    if (!outcome.spec) return outcome.ask || outcome.say || 'I could not place that passage.';
    if (placeOnChorus && chorusBeat != null && outcome.spec.main) {
      outcome.spec.main.startBeat = Math.round(chorusBeat * 1e9) / 1e9;
      outcome.spec.main.chorusAlign = true;
    }
    if (commit && outcome.spec.main) {
      const bpb = session.state.transport.timeSignature[0];
      const start = outcome.spec.main.startBeat ?? 0;
      const length = (section.bars || 4) * bpb;
      const vocal = laneIndex(found.sourceSong, outcome.spec.main.stem);
      const yielded = conv.yieldedTracks ?? new Set();
      outcome.spec.envelopes = { ...(outcome.spec.envelopes ?? {}) };
      if (!yielded.has(vocal)) outcome.spec.envelopes[vocal] = entrancePoints(start, bpb);
      const bedSong = found.sourceSong === 'A' ? 'B' : 'A';
      const bed = laneIndex(bedSong, 'vocals');
      if (!yielded.has(bed) && session.state.clips.some((c) => c.trackIndex === bed)) {
        outcome.spec.envelopes[bed] = bedDipPoints(start, length);
      }
    }
    const pitchNote = pitch.note && pitch.note !== picked.row.pitch?.note ? ` ${pitch.note}` : '';
    conv.harmony = {
      targetSong: found.targetSong, sourceSong: found.sourceSong, target: found.target, label: found.target.label,
      stem: outcome.spec.main?.stem || 'vocals', rank: found.rank, index: picked.index,
    };
    const text = explainCandidate(picked.row, {
      targetName: `${found.target.name || found.target.label} of song ${found.targetSong}`,
      sourceTitle: found.groups[found.sourceSong]?.title || `song ${found.sourceSong}`,
      rank: found.rank,
    });
    const runner = picked.rows[picked.index + 1];
    const alt = runner?.harmonic?.cosine != null
      ? ` Next is ${runner.label || runner.id} (cosine ${runner.harmonic.cosine.toFixed(2)}).`
      : '';
    const qualified = picked.row.tempo?.applyStretch;
    const tempoNote = speed === 'natural' && typeof qualified === 'number'
      ? ` The project tempo would play this at ${projectRatio == null ? 'an unknown rate' : projectRatio.toFixed(3)} rather than the qualified ${qualified.toFixed(3)}, so the passage keeps its own speed.`
      : '';
    if (commit) {
      const guard = { epoch: conv.epoch, mode: 'decks' };
      const engine = session.edit;
      const heard = await realise(outcome.spec, guard);
      if (!heard.ok) return `${text}${pitchNote}${alt}${tempoNote} ${heard.text}`.trim();
      if (session.edit !== engine) return 'A new arrangement is open, so I have not placed it.';
      if (!idea || idea.hearing === 'kept') return heard.text || text;
      if (heard.wrote) rememberWrite(heard.before, heard.revision, true);
      else {
        const beforeWrite = editingSerial();
        const beforeRevision = session.edit.revision;
        if (idea.hearing !== 'idea') hearToggle();
        if (!idea || idea.hearing !== 'idea') return `${text}${pitchNote}${alt} The arrangement did not change.`;
        rememberWrite(beforeWrite, beforeRevision, true);
      }
      const playing = typeof session.play === 'function' ? await session.play() : false;
      const surprise = deckChoice(found.rank);
      const extra = surprise?.adventurous ? ' I took a playable neighbour of the closest chroma match, not only the safest one.' : '';
      const unsure = found.rank.ask ? ' The readings were close, so this is a choice, not a proof.' : '';
      const heardWord = playing ? "It's playing." : "It's on the lanes.";
      return `${text}${pitchNote}${alt}${tempoNote}${extra}${unsure} ${heardWord} Take back returns the decks, or change anything and I will leave that control alone.`;
    }
    const heard = await realise(outcome.spec);
    return `${text}${pitchNote}${alt}${tempoNote} ${heard.text || ''}`.trim();
  }

  function relinquish() {
    conv.cancelled = true;
    conv.epoch += 1;
    if (typeof session.stop === 'function') session.stop();
    if (conv.mode !== 'jam') setMode('jam');
  }

  function arrangementDirty() {
    return !conv.decks || editingSerial() !== conv.decks.after || session.edit.revision !== conv.decks.revision;
  }

  function restoreTake() {
    if (!conv.decks?.before) return 'I have not taken the decks in this session.';
    if (arrangementDirty()) return 'The decks are yours. I will not take that away. Undo walks one step when you want it to.';
    const checkpoint = conv.decks.before;
    const started = editingSerial();
    let guard = 0;
    while (editingSerial() !== checkpoint && guard < 32) {
      if (!session.undo()) break;
      guard += 1;
    }
    if (editingSerial() !== checkpoint) {
      while (editingSerial() !== started) { if (!session.redo()) break; }
      return 'I could not restore the arrangement from before I played.';
    }
    conv.decks = null;
    idea = null;
    conv.spec = null;
    rerender();
    return 'The decks are yours. That experiment is put back.';
  }

  async function commitArrangement(found, style, options = {}) {
    const bpb = session.state.transport.timeSignature[0];
    const chorusBeat = arrangementBeatForSource(session.state, found.targetSong, found.target.startSec);
    if (chorusBeat == null) return 'I cannot see where that chorus sits on the lanes yet.';
    const sections = found.sourceAnalysis.sections ?? [];
    const choruses = sections.filter((section) => section.label === 'chorus').sort((a, b) => a.startSec - b.startSec);
    const secondId = choruses[1]?.id ?? null;
    const built = arrangementPlans({
      rank: found.rank,
      sections,
      chorusBeat: Math.round(chorusBeat * 1e9) / 1e9,
      bpb,
      secondChorusId: style === 'second' ? secondId : null,
    });
    if (!built.plans.length) return built.note;
    const index = style === 'another' ? (conv.planIndex ?? 1) : 0;
    let plan = options.plan ?? pickPlan(built.plans, { surprise: style === 'surprise', index });
    if (!options.plan) plan = stylePlan(plan, style === 'energy' ? 'energy' : style === 'transition' ? 'transition' : null, { bpb });
    if (options.vocalSectionId) {
      plan = structuredClone(plan);
      plan.vocal.sectionId = options.vocalSectionId;
      plan.vocal.stem = 'vocals';
    }
    if (style === 'second' && !secondId) plan.issues = [...plan.issues, 'Song B has no second chorus in the analysis, so the vocal choice stays.'];
    const reading = measurePlan(plan);
    const section = sections.find((item) => item.id === plan.vocal.sectionId);
    if (!section) return 'That section is no longer in the analysis.';
    const outcome = applyIntent(null, {
      action: 'propose', song: plan.vocal.song, stem: plan.vocal.stem,
      section: `${plan.vocal.song}:${section.id}`, speed: plan.vocal.speed, pitch: 0,
      fade_in: 1, fade_out: plan.vocal.fadeOut || 0,
    }, {
      state: session.state, analyses: conv.analyses, groups: found.groups, sentence: '', mine: mineGroup(),
    });
    if (!outcome.spec?.main) return outcome.ask || outcome.say || 'I could not place that passage.';
    const placed = Number.isFinite(plan.vocal.startBeat) ? plan.vocal.startBeat : chorusBeat;
    outcome.spec.main.startBeat = Math.round(placed * 1e9) / 1e9;
    outcome.spec.main.chorusAlign = Math.abs(outcome.spec.main.startBeat - chorusBeat) < 1e-6;
    outcome.spec.parts = [];
    const takenIds = new Set(session.state.clips.map((clip) => clip.id));
    if (outcome.spec.main?.clipId) takenIds.add(outcome.spec.main.clipId);
    const freshId = () => {
      let n = 1;
      while (takenIds.has(`idea-${n}`)) n += 1;
      const id = `idea-${n}`;
      takenIds.add(id);
      return id;
    };
    for (const part of plan.parts) {
      const source = sections.find((item) => item.id === part.sectionId);
      if (!source) continue;
      outcome.spec.parts.push({
        song: part.song, stem: part.stem, passage: { ...source, evidence: source.evidence ?? [] },
        startBeat: part.startBeat, pitch: 0, fadeIn: Math.min(part.fadeIn, bpb), fadeOut: part.fadeOut || 0,
        gainDb: 0, speed: clipSpeed(part.applyStretch, part.song), applyStretch: part.applyStretch ?? null,
        afterVocal: part.afterVocal === true, clipId: freshId(),
      });
    }
    outcome.spec.trims = plan.trims;
    const kept = new Set([outcome.spec.main.clipId, ...outcome.spec.parts.map((part) => part.clipId)]);
    const mine = conv.musicianClips ?? new Set();
    outcome.spec.protect = [...mine];
    outcome.spec.drop = (conv.partIds ?? []).filter((id) => !kept.has(id) && !mine.has(id));
    const start = outcome.spec.main.startBeat;
    const length = (section.bars || 4) * bpb;
    const vocal = laneIndex(plan.vocal.song, plan.vocal.stem);
    const yielded = conv.yieldedTracks ?? new Set();
    outcome.spec.envelopes = {};
    if (!yielded.has(vocal)) outcome.spec.envelopes[vocal] = entrancePoints(start, bpb, plan.entranceBars || 4);
    const bed = laneIndex(plan.vocal.song === 'A' ? 'B' : 'A', 'vocals');
    if (!yielded.has(bed) && session.state.clips.some((clip) => clip.trackIndex === bed)) {
      outcome.spec.envelopes[bed] = bedDipPoints(start, length);
    }
    conv.harmony = {
      targetSong: found.targetSong, sourceSong: found.sourceSong, target: found.target, label: found.target.label,
      stem: plan.vocal.stem, rank: found.rank, index: 0,
    };
    conv.partIds = [...kept];
    conv.plan = plan;
    conv.planStyle = style;
    conv.vocalChoices = conv.vocalChoices ?? [];
    if (conv.vocalChoices.at(-1) !== plan.vocal.sectionId) conv.vocalChoices.push(plan.vocal.sectionId);
    if (conv.cancelled || conv.mode !== 'decks') return 'The decks are yours, so I have not placed it.';
    const guard = { epoch: conv.epoch, mode: 'decks' };
    const engine = session.edit;
    const heard = await realise(outcome.spec, guard);
    if (conv.mode === 'you-play') return heard.text || 'You play is on, so I have not placed it.';
    if (conv.cancelled || conv.mode !== 'decks') return heard.ok ? 'The decks are yours. I have stopped.' : 'The decks are yours, so I have not placed it.';
    if (!heard.ok) return heard.text;
    if (session.edit !== engine) return 'A new arrangement is open, so I have not placed it.';
    if (!idea || idea.hearing === 'kept') return heard.text || plan.title;
    if (heard.wrote) rememberWrite(heard.before, heard.revision, true);
    else {
      const beforeWrite = editingSerial();
      const beforeRevision = session.edit.revision;
      if (idea.hearing !== 'idea') hearToggle();
      if (!idea || idea.hearing !== 'idea') return `${plan.title} The arrangement did not change.`;
      rememberWrite(beforeWrite, beforeRevision, true);
    }
    if (conv.mode === 'you-play') return 'You play is on, so I have not placed it.';
    if (conv.cancelled || conv.mode !== 'decks') return 'The decks are yours. I have stopped.';
    const playing = typeof session.play === 'function' ? await session.play() : false;
    if (conv.mode !== 'decks' || conv.cancelled) {
      if (typeof session.stop === 'function') session.stop();
      return conv.mode === 'you-play' ? 'You play is on, so I have not placed it.' : 'The decks are yours. I have stopped.';
    }
    const issue = plan.issues[0] ? ` ${plan.issues[0]}` : '';
    const unsure = found.rank.ask ? ' The readings were close, so this is a choice, not a proof.' : '';
    const heardWord = playing ? "It's playing." : "It's on the lanes.";
    const handoff = plan.transition ? 'the handoff is a real edit' : 'this sketch has no later handoff';
    return `${plan.title}. ${reading.count} measurable checks held: both songs are in it, ${handoff}, and no pitch was applied. I did not audition the audio.${issue}${unsure} ${heardWord} Say “try another arrangement”, or take back.`;
  }

  async function harmonyTurn(request) {
    if (request.kind === 'you-play') {
      conv.cancelled = true;
      conv.epoch += 1;
      if (typeof session.stop === 'function') session.stop();
      setMode('you-play');
      return 'You play. I will not move a clip until you jam with me or hand me the decks.';
    }
    if (request.kind === 'jam') { setMode('jam'); return 'Jam together. I will show an idea, and nothing is written until you press Hear it.'; }
    if (request.kind === 'take-over') {
      relinquish();
      return 'The decks are yours. The arrangement stays as it is.';
    }
    if (request.kind === 'take-back') {
      const had = Boolean(conv.decks?.before);
      relinquish();
      if (!had) return 'I have not taken the decks in this session.';
      return restoreTake();
    }
    if (request.kind === 'restore') return restoreTake();
    if (request.kind === 'previous-vocal') {
      if (conv.mode !== 'decks') return 'Take the decks when you want me to change the vocal.';
      if ((conv.decks?.steps ?? 0) >= 4) return 'I have revised this four times. Take back, or tell me the one change you want.';
      const earlier = (conv.vocalChoices ?? []).slice(0, -1).at(-1);
      if (!earlier) return 'I have only placed one vocal so far.';
      const found = await rankedFit({ kind: 'fit', targetSong: 'A', sourceSong: 'B', label: 'chorus' });
      if (found.say) return found.say;
      if (!conv.plan) return 'I do not have an arrangement to keep.';
      return commitArrangement(found, conv.planStyle || 'lock', { plan: conv.plan, vocalSectionId: earlier });
    }
    if (request.kind === 'another-plan') {
      if (conv.mode === 'you-play') return 'You play is on, so I will not write another arrangement.';
      if (conv.mode !== 'decks') return 'Take the decks when you want me to write a different arrangement.';
      if ((conv.decks?.steps ?? 0) >= 4) return 'I have revised this four times. Take back, or tell me the one change you want.';
      const found = await rankedFit({ kind: 'fit', targetSong: 'A', sourceSong: 'B', label: 'chorus' });
      if (found.say) return found.say;
      conv.planIndex = (conv.planIndex ?? 0) + 1;
      return commitArrangement(found, 'another');
    }
    if (request.kind === 'decks') {
      if ((conv.decks?.steps ?? 0) >= 4) return 'I have revised this four times. Take back, or tell me the one change you want.';
      if ((request.style === 'energy' || request.style === 'transition') && conv.mode === 'decks' && conv.plan) {
        const found = await rankedFit({ kind: 'fit', targetSong: 'A', sourceSong: 'B', label: 'chorus' });
        if (found.say) return found.say;
        if (conv.cancelled || conv.mode !== 'decks') return 'The decks are yours, so I have not placed it.';
        return commitArrangement(found, request.style, { plan: stylePlan(conv.plan, request.style, { bpb: session.state.transport.timeSignature[0] }) });
      }
      conv.cancelled = false;
      setMode('decks');
      const found = await rankedFit({ kind: 'fit', targetSong: 'A', sourceSong: 'B', label: 'chorus' });
      if (found.say) return found.say;
      if (conv.cancelled || conv.mode !== 'decks') return 'The decks are yours, so I have not placed it.';
      conv.planIndex = request.style === 'surprise' ? 1 : 0;
      return commitArrangement(found, request.style || 'lock');
    }
    if (conv.mode === 'you-play' && (request.kind === 'place' || request.kind === 'gentler' || request.kind === 'nudge' || request.kind === 'choose')) {
      return 'You play is on, so I will not move that. Say “jam together” when you want an idea.';
    }
    if (request.kind === 'speed') {
      if (conv.bank && bankStamp() !== conv.bank) return 'The songs on the lanes changed, so I have not moved that passage.';
      if (conv.mode === 'you-play') return 'You play is on, so I will not move that. Say “jam together” when you want an idea.';
      if (!conv.spec?.main) return 'I do not have a passage in mind yet. Ask which part of B fits this chorus.';
      const spec = absorbHumanMoves(structuredClone(conv.spec));
      spec.main.speed = request.speed;
      spec.main.speedLock = true;
      const heard = await realise(spec);
      if (conv.decks && heard.ok && heard.wrote) rememberWrite(heard.before, heard.revision, false);
      return heard.ok ? 'The passage keeps its own speed.' : heard.text;
    }
    if (request.kind === 'place' || request.kind === 'gentler' || request.kind === 'nudge') {
      if (conv.bank && bankStamp() !== conv.bank) return 'The songs on the lanes changed, so I have not moved that passage.';
      if (!conv.spec?.main && !conv.harmony) return 'I do not have a passage in mind yet. Ask which part of B fits this chorus.';
      const intent = { action: 'adjust' };
      if (request.kind === 'place') { intent.bar = request.bar; intent.beat = 1; }
      if (request.kind === 'gentler') intent.fade_in_change = 4;
      if (request.kind === 'nudge') intent.shift_beats = request.beats;
      const outcome = applyIntent(absorbHumanMoves(conv.spec ? structuredClone(conv.spec) : null), intent, {
        state: session.state, analyses: conv.analyses, groups: session.groups(), sentence: '', mine: mineGroup(),
      });
      if (!outcome.spec) return outcome.ask || outcome.say || 'I could not change that.';
      if (outcome.spec.main && (request.kind === 'place' || request.kind === 'nudge')) {
        outcome.spec.main.chorusAlign = false;
        slideCurves(outcome.spec);
      }
      const heard = await realise(outcome.spec);
      if (conv.decks && heard.ok) {
        if (heard.wrote) rememberWrite(heard.before, heard.revision, false);
        else if (idea && idea.hearing !== 'idea' && idea.hearing !== 'kept') {
          const beforeWrite = editingSerial();
          const beforeRevision = session.edit.revision;
          hearToggle();
          rememberWrite(beforeWrite, beforeRevision, false);
        }
      }
      return heard.text;
    }
    const found = await rankedFit(request);
    if (found.say) return found.say;
    if (conv.mode === 'you-play') {
      conv.harmony = {
        targetSong: found.targetSong, sourceSong: found.sourceSong, target: found.target, label: found.target.label,
        stem: 'vocals', rank: found.rank, index: 0,
      };
      const top = scoredRows(found.rank)[0];
      const said = explainCandidate(top, {
        targetName: found.target.name || 'the chorus',
        sourceTitle: found.groups[found.sourceSong]?.title || 'song B',
        rank: found.rank,
      });
      return `${said} You play is on, so I have not placed it.`;
    }
    if (request.kind === 'fit' && request.another && conv.harmony?.rank) {
      return offerHarmony(found, { index: (conv.harmony.index ?? 0) + 1, commit: conv.mode === 'decks' });
    }
    if (request.kind === 'fit' && found.rank.ask && conv.mode !== 'decks') {
      conv.harmony = { targetSong: found.targetSong, sourceSong: found.sourceSong, target: found.target, label: found.target.label, stem: 'vocals', rank: found.rank, index: 0 };
      const names = scoredRows(found.rank).slice(0, 2).map((row) => row.label || row.id).join(' or ');
      return `${explainCandidate(found.rank.candidates[0], { targetName: found.target.name || 'the chorus', sourceTitle: found.groups[found.sourceSong]?.title || 'song B', rank: found.rank })} Say “try the strongest match” or name ${names}.`;
    }
    if (request.kind === 'choose') {
      if (!conv.harmony?.rank && !found.rank) return 'Ask which part fits, and then I can try the next one.';
      const index = request.index === 'next' ? (conv.harmony?.index ?? 0) + 1 : 0;
      if (request.stem) conv.harmony = { ...(conv.harmony || {}), stem: request.stem };
      return offerHarmony(found, { index, commit: conv.mode === 'decks' });
    }
    const choice = conv.mode === 'decks' ? deckChoice(found.rank) : { index: 0 };
    return offerHarmony(found, { index: choice?.index ?? 0, commit: conv.mode === 'decks' });
  }

  async function converse(text) {
    const urgent = chorusUtterance(text);
    if (conv.busy) {
      if (urgent?.kind === 'take-back' || urgent?.kind === 'take-over' || urgent?.kind === 'you-play') {
        conv.cancelled = true;
        conv.epoch += 1;
        if (typeof session.stop === 'function') session.stop();
        if (urgent.kind === 'you-play') setMode('you-play');
        else if (conv.mode !== 'jam') setMode('jam');
        const reply = urgent.kind === 'you-play'
          ? 'You play. I have stopped.'
          : 'The decks are yours. I have stopped. I will not place anything else.';
        line('you', text.trim());
        line('producer', reply, 'is-local');
        say(reply);
      }
      return;
    }
    if (urgent?.kind !== 'take-back' && urgent?.kind !== 'take-over' && urgent?.kind !== 'you-play') conv.cancelled = false;
    const message = text.trim();
    if (!message) return;
    conv.busy = true;
    sync();
    line('you', message);
    try {
      const groups = session.groups();
      noteHumanMoves();
      const spec = absorbHumanMoves(conv.spec ? structuredClone(conv.spec) : null);
      const project = projectSummary(session.state, {
        groups: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, { trackId: v.trackId, title: v.title, bpm: v.bpm }])),
        selectedClipId: selectedClipId(), spec, mine: mineGroup(),
      });
      const local = localCommand(message, project);
      if (local?.transport && typeof session[local.transport] === 'function') {
        let reply;
        if (local.transport === 'play') reply = (await session.play()) ? 'Playing.' : 'Play did not start.';
        else { session.stop(); reply = 'Stopped.'; }
        line('producer', reply, 'is-local');
        say(reply);
        return;
      }
      if (local?.control) {
        const reply = await control(local.control);
        line('producer', reply, 'is-local');
        say(reply);
        return;
      }
      if (!Object.keys(groups).length) { line('producer', 'Bring a song onto the lanes first, then tell me what to do with it.'); return; }
      const intentCtx = () => ({
        state: session.state, analyses: conv.analyses, groups, selectedClipId: selectedClipId(), pending: conv.pending,
        sentence: message, mine: project.mine,
      });
      // A curve, a refused effect on that curve, or a half-beat nudge we can
      // already name must not wait on the model. The matcher says the effect
      // is unavailable and does not offer Hear it.
      const chorusNudge = halfBeatOnly(message);
      if (chorusNudge !== null && conv.mode === 'you-play') {
        const reply = 'You play is on, so I will not move that. Say “jam together” when you want an idea.';
        line('producer', reply, 'is-local');
        say(reply);
        return;
      }
      if (chorusNudge !== null && (conv.harmony || conv.decks)) {
        conv.spec = spec;
        const reply = await harmonyTurn({ kind: 'nudge', beats: chorusNudge });
        line('producer', reply, 'is-local');
        say(reply);
        return;
      }
      if (entranceRequest(message) || chorusNudge !== null) {
        const outcome = applyIntent(spec, { action: 'adjust' }, { ...intentCtx(), resolved: {} });
        if (entranceRequest(message)?.refused && idea && idea.hearing !== 'idea' && idea.hearing !== 'kept') {
          idea = null;
          conv.spec = null;
        }
        await settle(outcome, null);
        return;
      }
      const musical = chorusUtterance(message);
      if (musical) {
        conv.spec = spec;
        const reply = await harmonyTurn(musical);
        line('producer', reply, 'is-local');
        say(reply);
        return;
      }
      if (conv.mode === 'decks') {
        const moves = {
          energy: { kind: 'decks', style: 'energy' },
          different: { kind: 'another-plan' },
          'previous-vocal': { kind: 'previous-vocal' },
          'take-over': { kind: 'take-over' },
          gentle: { kind: 'gentler' },
          surprise: { kind: 'decks', style: 'surprise' },
        };
        try {
          const epoch = conv.epoch;
          const classified = await json('/api/producer/creative', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, project }),
          });
          if (conv.cancelled || conv.epoch !== epoch || conv.mode !== 'decks') {
            const reply = 'The decks are yours, so I have not placed it.';
            line('producer', reply, 'is-local');
            say(reply);
            return;
          }
          const mapped = moves[classified.move];
          if (!mapped) {
            const reply = 'I did not map that onto a musical change. I can give it more energy, try a different structure, bring the previous vocal back, or hand the decks back.';
            line('producer', reply, 'is-local');
            say(reply);
            return;
          }
          const reply = await harmonyTurn(mapped);
          const heardBy = classified.local ? ` The local model ${classified.model} chose that move. The edit itself was checked here.` : '';
          line('producer', `${reply}${heardBy}`, 'is-local');
          say(`${reply}${heardBy}`);
          return;
        } catch (err) {
          const reply = `The local model did not classify that (${err.message}). I can give it more energy, try a different structure, bring the previous vocal back, or hand the decks back.`;
          line('producer', reply, 'is-local');
          say(reply);
          return;
        }
      }
      say('Thinking…');
      const answer = await json('/api/producer/converse', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, project, history: conv.history.slice(-8) }),
      });
      await analysesFor(groups);
      const { intent, resolved, model } = answer;
      const outcome = applyIntent(spec, intent, { ...intentCtx(), analyses: conv.analyses, resolved });
      await settle(outcome, { action: intent.action, reply: intent.reply, model });
    } catch (err) {
      const text = err.status === 503
        ? `The Producer's model isn't answering (${err.message}). Every edit still works by hand.`
        : `Something went wrong: ${err.message}`;
      line('producer', text, 'is-error');
      say(text);
    } finally {
      conv.busy = false;
      sync();
    }
  }

  talk.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value;
    input.value = '';
    void converse(text).then(() => { if (input.isConnected) input.focus(); });
  });

  void json('/api/producer/model').then((m) => {
    conv.model = m;
    modelLine.textContent = m.available
      ? `Producer model: ${m.model} via Ollama, ${m.local ? 'on this machine; nothing leaves it' : 'external: lyrics are not sent'}.`
      : `Producer model unavailable: ${m.note}. Every edit still works by hand.`;
  }).catch(() => { modelLine.textContent = 'The Producer’s model could not be reached. Every edit still works by hand.'; });

  sync();
  let lastGroups = '';
  const timer = container.ownerDocument.defaultView.setInterval(() => {
    if (!container.isConnected) return;
    sync();
    const groups = session.groups();
    const sig = JSON.stringify(groups);
    if (sig !== lastGroups) { lastGroups = sig; void analysesFor(groups).catch(() => {}); }
  }, 500);
  return {
    dispose: () => container.ownerDocument.defaultView.clearInterval(timer),
    /** The idea's clips that are not playing yet, for the timeline outline. */
    preview: () => (idea && idea.hearing === 'mine' ? idea.fields.filter((f) => f.preview && !idea.touched.has(f.key)).map((f) => f.preview) : []),
    /**
     * The idea's gain curves while they are still an idea, so the lane can
     * draw them apart from the musician's own: 'proposed' before Hear it (not
     * in the project), 'hearing' while Hear it has written them. Kept, rejected
     * or hand-edited curves are the musician's and are not listed.
     */
    envelopes: () => (idea && (idea.hearing === 'mine' || idea.hearing === 'idea')
      ? idea.fields.filter((f) => f.envelope).map((f) => ({
        trackIndex: f.trackIndex,
        points: f.value.map((p) => ({ beat: p.beat, db: p.db })),
        status: idea.hearing === 'idea' ? 'hearing' : 'proposed',
      }))
      : []),
    /** The lane calls this after a point or fader edit, before the next poll. */
    dropEnvelopePreview(trackIndex) {
      if (!idea) return;
      const field = idea.fields.find((f) => f.envelope && f.trackIndex === trackIndex);
      if (!field) return;
      sync(); // notes the hand move and refreshes Hear it / Keep at once
    },
    converse,
    get idea() { return idea; },
    get spec() { return conv.spec; },
  };
}
