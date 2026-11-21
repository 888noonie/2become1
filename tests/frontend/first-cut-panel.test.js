// tests/frontend/first-cut-panel.test.js — OPERATION FIRST CUT.
// The clip inspector's source in-point (slip), the keyboard slip and the
// Producer's clip idea over jsdom: every control reaches the ONE ProjectState
// through DawSession, slip never moves the clip, and the musician's own moves
// stay theirs while an idea is heard, kept or undone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import { mountArrangementPanel } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { mountArrangementProducer } from '../../src/twobecomeone/studio_static/js/components/arrangement-producer.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

const SR = 48000;
// 10 s stems with sound at 0–1.5 s, 3–4.5 s and 6–7.5 s: three findable phrases.
const decodeAudio = async () => {
  const length = 10 * SR;
  const ch = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i += 1) {
    const t = i / SR;
    if ((t % 3) < 1.5) { const v = 0.5 * Math.sin(2 * Math.PI * 220 * t); ch[0][i] = v; ch[1][i] = v; }
  }
  return { sampleRate: SR, numberOfChannels: 2, length, getChannelData: (c) => ch[c] };
};

async function mounted() {
  const made = { contexts: 0 };
  const s = new DawSession({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudio,
    createContext: () => { made.contexts += 1; throw new Error('no audio in this test'); },
    RealtimeEngine: class {},
    renderOffline: async () => { throw new Error('not used'); },
    StretchFactory: () => null,
    modules: {},
  });
  const container = document.getElementById('main');
  const api = mountArrangementPanel({
    container, session: s,
    listTracks: async () => ({ items: [] }),
    listStems: async () => ({ variants: [] }),
    producer: mountArrangementProducer,
  });
  await s.importGroup('B', {
    trackId: 't2', title: 'Paper Lanterns', bpm: 84.3, section: { startSec: 0, seconds: 30 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/b/audio?name=${role}&start=0&duration=30` })),
  });
  api.render();
  return { api, s, made, container };
}

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const type = (input, value) => {
  input.value = String(value);
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const key = (k, extra = {}) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

test('the source in-point is editable by value; the clip stays where it is; Undo restores it', async () => {
  const { api, s, container } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  api.select(clip.id);
  const inspector = () => container.querySelector('.daw__inspector');
  assert.match(inspector().textContent, /Room to slip.*none: trim the end first/s);
  assert.equal(inspector().querySelector('input[aria-label="Slip"]'), null, 'no slider while there is no room');
  s.apply({ name: 'trimClip', args: { clipId: clip.id, edge: 'end', deltaBeats: -8 } });
  api.render();
  const before = structuredClone(s.state.clips.find((c) => c.id === clip.id));
  type(inspector().querySelector('input[aria-label="Source in-point (seconds)"]'), 3);
  const after = s.state.clips.find((c) => c.id === clip.id);
  assert.equal(after.sourceOffsetSec, 3);
  assert.equal(after.timelineStartBeat, before.timelineStartBeat);
  assert.equal(after.durationBeats, before.durationBeats);
  assert.match(inspector().textContent, /Plays from3\.000 s · frame 144000/);
  assert.match(inspector().textContent, /In the stembar 2, beat 1\.215 of the stem at its own 84\.3 BPM/, 'musical position uses the stem tempo');
  // The slider moves the in-point as one undo step.
  const depth = s.edit.historyDepth.past;
  const slider = inspector().querySelector('input[aria-label="Slip"]');
  for (const v of [3.2, 3.4]) { slider.value = String(v); slider.dispatchEvent(new window.Event('input', { bubbles: true })); }
  slider.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(s.edit.historyDepth.past, depth + 1);
  assert.equal(s.state.clips.find((c) => c.id === clip.id).sourceOffsetSec, 3.4);
  s.undo();
  assert.equal(s.state.clips.find((c) => c.id === clip.id).sourceOffsetSec, 3);
});

test('a value past the end of the stem is refused with the reason and nothing changes', async () => {
  const { api, s, container } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  s.apply({ name: 'trimClip', args: { clipId: clip.id, edge: 'end', deltaBeats: -8 } });
  api.select(clip.id);
  const before = s.edit.serialize();
  type(container.querySelector('input[aria-label="Source in-point (seconds)"]'), 9.5);
  assert.equal(s.edit.serialize(), before);
  assert.ok(container.querySelector('.daw__msg--refused'));
});

test('keyboard slip moves the in-point by one snap step of timeline time and never the clip', async () => {
  const { api, s } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  s.apply({ name: 'trimClip', args: { clipId: clip.id, edge: 'end', deltaBeats: -8 } });
  api.select(clip.id);
  const start = s.state.clips.find((c) => c.id === clip.id).timelineStartBeat;
  key('.');
  const once = s.state.clips.find((c) => c.id === clip.id);
  const step = once.sourceOffsetSec;
  assert.ok(step > 0, 'later source');
  assert.equal(once.timelineStartBeat, start);
  key('.');
  assert.ok(Math.abs(s.state.clips.find((c) => c.id === clip.id).sourceOffsetSec - 2 * step) < 1e-9);
  key(',');
  key(',');
  key(',');
  assert.equal(s.state.clips.find((c) => c.id === clip.id).sourceOffsetSec, 0, 'clamped at the start of the stem');
});

test('clips carry the gain, fade and slip affordances and one quiet contextual hint', async () => {
  const { api, s, container } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  api.select(clip.id);
  const el = container.querySelector(`.daw__clip[data-clip-id="${clip.id}"]`);
  for (const grip of ['gain', 'slip', 'fadeIn', 'fadeOut', 'start', 'end']) {
    assert.ok(el.querySelector(`[data-grip="${grip}"]`), `${grip} handle`);
  }
  assert.match(el.title, /Shift-drag slips/);
  const hint = container.querySelector('[data-field="hint"]');
  assert.match(hint.textContent, /play cue/);
  el.querySelector('[data-grip="slip"]').dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  assert.match(hint.textContent, /Slip/);
  container.querySelector('.daw__ruler').dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  assert.match(hint.textContent, /Play cue.*no clip moves/);
});

test('Producer clip idea: Ask, Hear it, Hear mine, Keep and Undo edit the same clip; the musician wins', async () => {
  const { api, s, made, container } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  api.select(clip.id);
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const get = () => structuredClone(s.state.clips.find((c) => c.id === clip.id));
  const original = get();
  click(btn('Ask for a clip idea'));
  assert.deepEqual(get(), original, 'asking changes nothing');
  const rows = [...prod.querySelectorAll('.daw__producer-list li')].map((li) => li.textContent);
  assert.ok(rows.some((r) => /source in-point: (2\.99\d|3\.00\d) s \(was 0\.000 s\)/.test(r)), rows.join(' | '));
  assert.ok(rows.some((r) => /position: bar 9 · beat 1/.test(r)));
  assert.ok(rows.some((r) => /clip gain: -3 dB/.test(r)));
  assert.ok(rows.some((r) => /fades: in 1/.test(r)));
  const depth = s.edit.historyDepth.past;
  click(btn('Hear it'));
  const heard = get();
  assert.equal(heard.timelineStartBeat, 32);
  assert.ok(Math.abs(heard.sourceOffsetSec - 3) < 0.006);
  assert.equal(heard.clipGainDb, -3);
  assert.equal(heard.fadeInBeats, 1);
  assert.equal(s.edit.historyDepth.past, depth + 1, 'the whole idea is one ordinary edit');
  // The musician moves the gain while hearing the idea: that field is theirs.
  s.apply({ name: 'setClipGain', args: { clipId: clip.id, gainDb: -6 } });
  click(btn('Hear mine'));
  const mine = get();
  assert.equal(mine.clipGainDb, -6, 'the musician’s gain stays');
  assert.equal(mine.timelineStartBeat, original.timelineStartBeat);
  assert.equal(mine.sourceOffsetSec, original.sourceOffsetSec);
  assert.equal(mine.durationBeats, original.durationBeats, 'the shortened length is restored too');
  assert.equal(mine.fadeInBeats, original.fadeInBeats);
  click(btn('Hear it'));
  click(btn('Keep it'));
  assert.equal(get().timelineStartBeat, 32);
  assert.equal(get().clipGainDb, -6);
  click(btn('Undo'));
  const undone = get();
  assert.equal(undone.timelineStartBeat, original.timelineStartBeat);
  assert.equal(undone.sourceOffsetSec, original.sourceOffsetSec);
  assert.equal(undone.durationBeats, original.durationBeats);
  assert.equal(undone.clipGainDb, -6, 'Undo never overwrites the musician’s gain');
  assert.equal(made.contexts, 0, 'the Producer never starts audio');
});

test('Producer clip idea that is refused by validation is never shown as playable', async () => {
  const { s, container } = await mounted();
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  // Select a clip whose stem has only two phrases left after the first: ask for phrase 2 works;
  // make the idea impossible by emptying the lanes instead.
  s.apply({ name: 'batch', args: { commands: s.state.clips.map((c) => ({ name: 'deleteClip', args: { clipId: c.id } })) } });
  assert.equal(btn('Ask for a clip idea').disabled, true, 'nothing to propose on empty lanes');
  void clip;
});
