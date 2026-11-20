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
import { GROUP_BASE, ROLES } from '../arrangement/daw-session.js';

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

const read = (state, f) => state.tracks[f.trackIndex][f.field];
const commandFor = (f, value) => (f.field === 'mute'
  ? { name: 'setTrackMute', args: { trackIndex: f.trackIndex, mute: value } }
  : { name: 'setTrackVolume', args: { trackIndex: f.trackIndex, volumeDb: value } });
const keyOf = (f) => `${f.trackIndex}:${f.field}`;

export function mountArrangementProducer({ container, session, onAnnounce = () => {}, rerender = () => {} }) {
  /** idea: { fields, before: Map, last: Map (what we last wrote), touched: Set, hearing: 'idea'|'mine'|'kept' } */
  let idea = null;

  const status = h('p', { class: 'daw__producer-status', role: 'status', 'aria-live': 'polite' });
  const ask = h('button', { type: 'button', class: 'button', text: 'Ask for an idea' });
  const hear = h('button', { type: 'button', class: 'button', text: 'Hear it' });
  const keep = h('button', { type: 'button', class: 'button button--primary', text: 'Keep it' });
  const reject = h('button', { type: 'button', class: 'button', text: 'Reject' });
  const details = h('ul', { class: 'daw__producer-list' });
  container.replaceChildren(h('section', { class: 'daw__producer-card', 'aria-label': 'AI Producer' }, [
    h('h3', { class: 'daw__ins-title', text: 'AI Producer' }),
    h('p', { class: 'daw__ins-sub', text: 'Hear an idea, compare it with yours, then keep it or go back. Your own moves always win.' }),
    h('div', { class: 'daw__ins-actions' }, [ask, hear, keep, reject]),
    details,
    status,
  ]));

  function say(text) { status.textContent = text; onAnnounce(text); }

  /** Fields the musician changed since we last wrote them become theirs. */
  function noteHumanMoves() {
    if (!idea) return;
    const state = session.state;
    for (const f of idea.fields) {
      const k = keyOf(f);
      if (!idea.touched.has(k) && read(state, f) !== idea.last.get(k)) idea.touched.add(k);
    }
  }

  /** Write `values(f)` to every field the musician has not touched, as ONE edit. */
  function writeAll(values) {
    const commands = [];
    const wrote = [];
    for (const f of idea.fields) {
      const k = keyOf(f);
      if (idea.touched.has(k)) continue;
      const v = values(f);
      if (read(session.state, f) !== v) commands.push(commandFor(f, v));
      wrote.push([k, v]);
    }
    const ok = commands.length ? session.apply({ name: 'batch', args: { commands } }).ok : true;
    if (ok) for (const [k, v] of wrote) idea.last.set(k, v);
    return ok;
  }

  function sync() {
    noteHumanMoves();
    const ready = session.state.clips.length > 0;
    ask.disabled = !ready;
    hear.disabled = !idea || idea.hearing === 'kept';
    keep.disabled = !idea;
    reject.disabled = !idea || idea.hearing === 'kept';
    hear.textContent = idea?.hearing === 'idea' ? 'Hear mine' : 'Hear it';
    keep.textContent = !idea ? 'Keep it' : idea.hearing === 'kept' ? 'Undo' : idea.hearing === 'mine' ? 'Keep mine' : 'Keep it';
    replaceChildren(details, idea ? idea.fields.map((f) => h('li', {
      class: idea.touched.has(keyOf(f)) ? 'is-yours' : '',
      text: `${session.state.tracks[f.trackIndex].name}: ${f.value ? 'muted' : 'playing'}${idea.touched.has(keyOf(f)) ? ' — yours now' : ''}`,
    })) : []);
  }

  ask.addEventListener('click', () => {
    const proposal = suggestArrangementIdea(session.state);
    if (!proposal.fields.length) { say('Bring stems onto the lanes first.'); return; }
    const dry = session.edit.propose({ name: 'batch', args: { commands: proposal.fields.map((f) => commandFor(f, f.value)) } });
    if (dry.status !== 'pending') { say(`The idea did not validate: ${dry.errors?.[0]?.message ?? 'refused'}.`); return; }
    const state = session.state;
    idea = {
      fields: proposal.fields,
      before: new Map(proposal.fields.map((f) => [keyOf(f), read(state, f)])),
      last: new Map(proposal.fields.map((f) => [keyOf(f), read(state, f)])),
      touched: new Set(),
      hearing: 'mine',
    };
    say(`Idea: ${proposal.rationale} Nothing changes until you press Hear it.`);
    sync();
  });

  hear.addEventListener('click', () => {
    if (!idea || idea.hearing === 'kept') return;
    noteHumanMoves();
    if (idea.hearing === 'idea') {
      if (writeAll((f) => idea.before.get(keyOf(f)))) idea.hearing = 'mine';
      say('Hearing your mix.');
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
      // Undo: back to the mix from before the idea, except what you moved.
      writeAll((f) => idea.before.get(keyOf(f)));
      idea = null;
      say('Back to your mix from before the idea. Your own moves were kept.');
    } else if (idea.hearing === 'mine') {
      idea = null;
      say('Kept your mix. The idea was set aside.');
    } else {
      idea.hearing = 'kept';
      say('Kept the idea. Undo returns to your mix from before it.');
    }
    sync();
    rerender();
    if (keep.isConnected) keep.focus();
  });

  reject.addEventListener('click', () => {
    if (!idea) return;
    noteHumanMoves();
    if (idea.hearing === 'idea') writeAll((f) => idea.before.get(keyOf(f)));
    idea = null;
    say('Idea rejected. Your mix is as it was.');
    sync();
    rerender();
  });

  sync();
  const timer = container.ownerDocument.defaultView.setInterval(() => { if (container.isConnected) sync(); }, 500);
  return () => container.ownerDocument.defaultView.clearInterval(timer);
}
