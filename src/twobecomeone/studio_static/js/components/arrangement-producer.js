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
import { applyIntent, buildIdea, clipObject, entranceRequest, halfBeatOnly, localCommand, mmss, projectSummary, refusalText } from '../arrangement/producer-intent.js';

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
  const conv = { spec: null, history: [], analyses: {}, busy: false, model: null, absorbed: null, pending: null };

  const status = h('p', { class: 'daw__producer-status', role: 'status', 'aria-live': 'polite' });
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
    h('p', { class: 'daw__ins-sub', text: 'Say what you want to hear. Hear it, compare it with yours, then keep it or go back. Your own moves always win.' }),
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
    for (const f of idea.fields) {
      if (f.envelope) {
        const tr = state.tracks[f.trackIndex];
        const pointsNow = tr?.gainPoints ?? [];
        if (tr && (tr.volumeDb !== f.anchorVolumeDb || !same(pointsNow, idea.last.get(f.key)))) drop.push(f);
        continue;
      }
      if (!idea.touched.has(f.key) && !same(f.read(state), idea.last.get(f.key))) idea.touched.add(f.key);
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
    return true;
  }

  function hearToggle() {
    if (!idea || idea.hearing === 'kept') return;
    noteHumanMoves();
    if (idea.hearing === 'idea') {
      if (writeAll((f) => idea.before.get(f.key), true)) idea.hearing = 'mine';
      say('Hearing your version.');
    } else {
      if (writeAll((f) => f.value)) idea.hearing = 'idea';
      else { say('The idea could not be applied as it stands; nothing changed.'); }
      if (idea.hearing === 'idea') say('Hearing the idea. Move anything you like; your moves stay yours.');
    }
    if (conv.spec) conv.spec.heard = idea.hearing === 'idea';
    sync();
    rerender();
  }

  function keepOrUndo() {
    if (!idea) return;
    noteHumanMoves();
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
      idea.hearing = 'kept';
      conv.spec = null;
      say('Kept the idea. Undo returns to your version from before it.');
    }
    sync();
    rerender();
  }

  function rejectIdea() {
    if (!idea) return;
    noteHumanMoves();
    if (idea.hearing === 'idea') writeAll((f) => idea.before.get(f.key), true);
    idea = null;
    conv.spec = null;
    say('Idea rejected. Your arrangement is as it was.');
    sync();
    rerender();
  }

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

  hear.addEventListener('click', hearToggle);
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

  /** Turn a spec into fields, decode its passage (silently) if needed, then offer or re-hear it. */
  async function realise(spec) {
    const groups = session.groups();
    const ctx = { analyses: conv.analyses, groups, records: session.buffers };
    let built = buildIdea(session.state, spec, ctx);
    if (built.needsSource) {
      say('Fetching that passage of the stem…');
      try { await session.loadSource(built.needsSource); } catch (err) { return { text: `I couldn't load that passage: ${err.message}` }; }
      built = buildIdea(session.state, spec, ctx);
    }
    if (built.refusal) return { text: built.refusal };
    const wasHearing = idea?.hearing === 'idea';
    const old = idea;
    const key = `producer-${Date.now()}`;
    if (wasHearing && conv.absorbed) idea.touched.delete(conv.absorbed);
    conv.absorbed = null;
    if (wasHearing) {
      // Swap the heard version for the refined one as ONE undo step.
      writeAll((f) => idea.before.get(f.key), true, key);
      built = buildIdea(session.state, spec, ctx);
      if (built.refusal || built.needsSource) { idea = old; writeAll((f) => f.value, false, key); session.endGesture(); return { text: built.refusal ?? 'Try that again.' }; }
    }
    const commands = built.fields.flatMap((f) => flat(f.command(session.state, f.value)));
    const dry = commands.length ? session.edit.propose({ name: 'batch', args: { commands } }) : { status: 'pending' };
    if (dry.status !== 'pending') {
      if (wasHearing) { idea = old; writeAll((f) => f.value, false, key); session.endGesture(); }
      return { text: refusalText(dry.errors?.[0] ?? dry.error) };
    }
    if (!commands.length && !wasHearing) return { text: 'That is already how it sounds.' };
    conv.spec = spec;
    offer(built, 'Nothing to change.', spec);
    if (wasHearing) {
      if (writeAll((f) => f.value, false, key)) idea.hearing = 'idea';
      session.endGesture();
      spec.heard = true;
      say(`Hearing the new version: ${built.rationale}`);
    }
    sync();
    rerender();
    return { text: `${wasHearing ? 'Now playing' : 'Idea'}: ${built.rationale}.${wasHearing ? '' : ' Press Hear it to listen.'}` };
  }

  async function control(kind) {
    if (!idea) return 'There is no idea to do that with yet.';
    if (kind === 'hear_idea') { if (idea.hearing !== 'idea' && idea.hearing !== 'kept') hearToggle(); return 'Hearing the idea.'; }
    if (kind === 'hear_mine') {
      if (idea.hearing === 'idea') { hearToggle(); return 'Hearing your version.'; }
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

  async function converse(text) {
    if (conv.busy) return;
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
      // A curve or a half-beat nudge we can already name must not wait on the model.
      if (entranceRequest(message) || halfBeatOnly(message) !== null) {
        const outcome = applyIntent(spec, { action: 'adjust' }, { ...intentCtx(), resolved: {} });
        await settle(outcome, null);
        return;
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
    converse,
    get idea() { return idea; },
    get spec() { return conv.spec; },
  };
}
