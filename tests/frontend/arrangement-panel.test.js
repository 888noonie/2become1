// tests/frontend/arrangement-panel.test.js — OPERATION FULL HOUSE.
// The Studio arrangement panel and its Producer over jsdom: controls reach the
// ONE ProjectState through DawSession, nothing plays on mount, and the
// Producer's Hear it / Hear mine / Keep / Undo writes the same project data
// while the musician's own moves stay theirs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import { mountArrangementPanel, completeQuad, formatPosition } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { mountArrangementProducer, suggestArrangementIdea } from '../../src/twobecomeone/studio_static/js/components/arrangement-producer.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

const SR = 48000;
const decodeAudio = async () => {
  const length = 10 * SR;
  const ch = [new Float32Array(length).fill(0.1), new Float32Array(length).fill(0.1)];
  return { sampleRate: SR, numberOfChannels: 2, length, getChannelData: (c) => ch[c] };
};

function session(extra = {}) {
  const made = { contexts: 0 };
  const s = new DawSession({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudio,
    createContext: () => { made.contexts += 1; throw new Error('no audio in this test'); },
    RealtimeEngine: class {},
    renderOffline: async () => { throw new Error('not used'); },
    StretchFactory: () => null,
    modules: {},
    ...extra,
  });
  return { s, made };
}

const variants = (set) => ['vocals', 'drums', 'bass', 'other', 'full'].map((name) => ({
  name, stem_set_id: set, method: 'imported', audio_url: `/api/stems/${set}/audio?name=${name}`,
}));

async function mounted() {
  const { s, made } = session();
  const container = document.getElementById('main');
  const api = mountArrangementPanel({
    container, session: s,
    listTracks: async () => ({ items: [{ id: 't1', name: 'Midnight Circuit', bpm: 96.8 }, { id: 't2', name: 'Paper Lanterns', bpm: 84.3 }] }),
    listStems: async (id) => ({ variants: variants(`set-${id}`) }),
    producer: mountArrangementProducer,
  });
  await s.importGroup('A', {
    trackId: 't1', title: 'Midnight Circuit', bpm: 96.8, section: { startSec: 0, seconds: 30 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/a/audio?name=${role}&start=0&duration=30` })),
  });
  await s.importGroup('B', {
    trackId: 't2', title: 'Paper Lanterns', bpm: 84.3, section: { startSec: 0, seconds: 30 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/b/audio?name=${role}&start=0&duration=30` })),
  });
  api.render();
  return { api, s, made, container };
}

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const setRange = (input, value) => {
  input.value = String(value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
};

test('position readout is bar · beat · tick, 1-based', () => {
  assert.equal(formatPosition(0, 4), '1 · 1 · 000');
  assert.equal(formatPosition(9.5, 4), '3 · 2 · 480');
});

test('completeQuad picks one stem set holding all four roles', () => {
  assert.equal(completeQuad(variants('x')).length, 4);
  assert.equal(completeQuad(variants('x').filter((v) => v.name !== 'bass')), null);
});

test('mounting and editing never create an AudioContext', async () => {
  const { api, made, container } = await mounted();
  assert.equal(container.querySelectorAll('.daw__clip').length, 8);
  assert.equal(container.querySelectorAll('.daw__head').length, 8);
  click(container.querySelector('button[aria-label="Mute A Drums"]'));
  assert.equal(made.contexts, 0);
  api.dispose();
});

test('lane header Mute/Solo and fader edit the project and show pressed state', async () => {
  const { s, container } = await mounted();
  click(container.querySelector('button[aria-label="Solo B Vocals"]'));
  assert.equal(s.state.tracks[4].solo, true);
  assert.equal(container.querySelector('button[aria-label="Solo B Vocals"]').getAttribute('aria-pressed'), 'true');
  const depth = s.edit.historyDepth.past;
  const fader = container.querySelector('input[aria-label="A Bass level"]');
  for (const v of [-2, -4, -6]) { fader.value = String(v); fader.dispatchEvent(new window.Event('input', { bubbles: true })); }
  fader.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(s.state.tracks[2].volumeDb, -6);
  assert.equal(s.edit.historyDepth.past, depth + 1, 'one drag, one undo step');
});

test('the clip inspector edits gain, fades, pitch, formants and stretch through the edit API', async () => {
  const { api, s, container } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 4);
  api.select(clip.id);
  const q = (label) => container.querySelector(`.daw__inspector input[aria-label="${label}"]`);
  setRange(q('Gain'), -3);
  setRange(q('Fade in'), 1);
  setRange(q('Semitones'), -2);
  const formants = q('Keep formants');
  formants.checked = true;
  formants.dispatchEvent(new window.Event('change', { bubbles: true }));
  click([...container.querySelectorAll('.daw__inspector button')].find((b) => b.textContent === 'Fit to project tempo'));
  const c = s.state.clips.find((x) => x.id === clip.id);
  assert.equal(c.clipGainDb, -3);
  assert.equal(c.fadeInBeats, 1);
  assert.equal(c.pitchSemitones, -2);
  assert.equal(c.preserveFormants, true);
  assert.equal(c.stretchMode, 'beat_sync');
  assert.ok(Math.abs(c.durationBeats - clip.durationBeats * (84.3 / 96.8)) < 1e-6);
});

test('Split, Duplicate and Delete act on the selected clip; keyboard undo/redo walk the history', async () => {
  const { api, s, container } = await mounted();
  const clip = s.state.clips.find((c) => c.trackIndex === 0);
  api.select(clip.id);
  s.seek(8);
  click([...container.querySelectorAll('.daw__inspector button')].find((b) => b.textContent === 'Split at playhead'));
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 0).length, 2);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 0).length, 3);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 0).length, 2);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 0).length, 3);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 0).length, 2);
});

test('a refused edit is reported and leaves the arrangement unchanged', async () => {
  const { s, container } = await mounted();
  const before = s.edit.serialize();
  const bpm = container.querySelector('input[aria-label="Project tempo (BPM)"]');
  bpm.value = '40'; // ratio-1 clips would run past their 30 s sources
  bpm.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(s.edit.serialize(), before);
  assert.ok(container.querySelector('.daw__msg--refused'), 'the reason is shown');
});

test('the idea is the accepted desk rule, as arrangement mutes', async () => {
  const { s } = await mounted();
  const idea = suggestArrangementIdea(s.state);
  assert.deepEqual(idea.fields.map((f) => [f.trackIndex, f.value]),
    [[0, true], [1, false], [2, false], [3, true], [4, false], [5, true], [6, true], [7, false]]);
});

test('Producer: Hear it / Hear mine / Keep / Undo write the same ProjectState; human moves win', async () => {
  const { s, container } = await mounted();
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const mutes = () => s.state.tracks.map((t) => t.mute);
  const before = mutes();
  click(btn('Ask for an idea'));
  assert.deepEqual(mutes(), before, 'asking changes nothing');
  click(btn('Hear it'));
  assert.deepEqual(mutes(), [true, false, false, true, false, true, true, false]);
  // The musician unmutes B Drums while hearing the idea: that lane is theirs.
  s.apply({ name: 'setTrackMute', args: { trackIndex: 5, mute: false } });
  click(btn('Hear mine'));
  assert.deepEqual(mutes(), before, 'back to the captured mix (B Drums already matched)');
  s.apply({ name: 'setTrackMute', args: { trackIndex: 6, mute: true } }); // another human move, on mine
  click(btn('Hear it'));
  assert.equal(s.state.tracks[5].mute, false, 'B Drums stays where the musician put it');
  click(btn('Keep it'));
  assert.equal(btn('Undo')?.textContent, 'Undo');
  click(btn('Undo'));
  assert.deepEqual(mutes(), [...before.slice(0, 6), true, before[7]], 'Undo returns to before, keeping both human moves');
  assert.equal(s.phase(), 'audio off', 'the Producer never starts playback');
});

test('arrow keys edit the focused level point and leave a focused fader alone', async () => {
  const { s, container, api } = await mounted();
  assert.equal(s.apply({
    name: 'setTrackGainEnvelope',
    args: { trackIndex: 4, points: [{ beat: 4, db: -6 }] },
  }).ok, true);
  api.render();
  const handle = container.querySelector('.daw__lane[data-track="4"] [data-env-point]');
  assert.ok(handle, 'the point has a button');
  handle.focus();
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(s.state.tracks[4].gainPoints[0].db, -5, 'keyboard focus on the point raises that point');
  const still = document.activeElement;
  still.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(s.state.tracks[4].gainPoints[0].db, -4, 'a second arrow keeps editing that point');
  assert.equal(document.activeElement?.dataset?.envPoint, '1');
  const master = container.querySelector('[aria-label="Master level (exported)"]');
  const before = s.edit.serialize();
  master.focus();
  const ev = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  master.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'the master fader keeps the key');
  assert.equal(s.state.tracks[4].gainPoints[0].db, -4, 'the point does not move while the fader is focused');
  assert.equal(s.edit.serialize(), before);
});

test('Producer Keep mine sets the unheard idea aside without applying it', async () => {
  const { s, container } = await mounted();
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const before = s.edit.serialize();
  click(btn('Ask for an idea'));
  click(btn('Keep mine'));
  assert.equal(s.edit.serialize(), before);
  assert.equal(btn('Keep it').disabled, true);
});

test('Draw levels adds, moves and removes points over a clip without touching the clip', async () => {
  const { s, container } = await mounted();
  const lane = container.querySelector('.daw__lane[data-track="4"]');
  const clip = lane.querySelector('.daw__clip');
  const freshClip = () => container.querySelector('.daw__lane[data-track="4"] .daw__clip');
  assert.ok(clip, 'the lane has a clip under the curve');
  const clipsBefore = JSON.stringify(s.state.clips);
  const press = (el, type, init) => {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    el.dispatchEvent(ev);
  };
  const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Draw levels');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  key('g');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'G turns Draw levels on');
  assert.ok(container.querySelector('.is-drawing-levels') || container.classList.contains('is-drawing-levels'));
  press(clip, 'pointerdown', { clientX: 200, clientY: 30 });
  press(window, 'pointerup', {});
  assert.equal(s.state.tracks[4].gainPoints.length, 1, 'a click over the clip adds a point');
  assert.equal(JSON.stringify(s.state.clips), clipsBefore, 'the clip did not move, trim, slip or fade');
  assert.ok(container.querySelector('.daw__env-readout')?.textContent.includes('dB'), 'the point shows bar and dB');
  assert.equal(document.activeElement?.dataset?.envPoint, '1', 'keyboard focus follows the point');
  key('ArrowUp');
  assert.equal(s.state.tracks[4].gainPoints.length, 1);
  const handle = container.querySelector('.daw__lane[data-track="4"] [data-env-point]');
  handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  assert.equal(s.state.tracks[4].gainPoints?.length ?? 0, 0, 'double-click removes the point');
  s.undo();
  assert.equal(s.state.tracks[4].gainPoints.length, 1, 'Undo brings it back');
  assert.equal(JSON.stringify(s.state.clips), clipsBefore);
  key('g');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});
