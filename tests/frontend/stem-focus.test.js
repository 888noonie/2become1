// tests/frontend/stem-focus.test.js — OPERATION STUDIO SURGEON, Act I.
// One Stem-Focus panel opens from a Library stem, a Crate stem and an
// Arrangement clip. Opening plays and decodes nothing; audition goes through
// the ONE shared preview controller and yields to (and reports) other sounds;
// the In/Out window bounds what is heard; asset mode renames and places a
// selection; clip mode edits the clip through the one edit history; the stem
// file and its route never change. Role identity is shared and never colour
// alone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import {
  createStemList, offerStem, resetStemSleeveForTests, stemOffer, stemsFromVariants, clearStemOffer,
} from '../../src/twobecomeone/studio_static/js/stem-sleeve.js';
import {
  activeStemFocus, closeStemFocus, openStemFocus, sectionForWindow, stemWaveformPath, useFocusAudio,
} from '../../src/twobecomeone/studio_static/js/stem-focus.js';
import { ROLE_TOKENS, roleChip, roleToken } from '../../src/twobecomeone/studio_static/js/stem-roles.js';
import { createCrateSource } from '../../src/twobecomeone/studio_static/js/record-crate.js';
import { mountRecordCrate } from '../../src/twobecomeone/studio_static/js/components/record-crate-panel.js';
import { mountArrangementPanel } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

const SET = 'set-lanterns';
const url = (set, role) => `/api/stems/${set}/audio?name=${role}`;
const flush = () => new Promise((r) => setTimeout(r, 0));
const frames = (n = 3) => new Promise((r) => setTimeout(r, 20 * n));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const dblclick = (el) => el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
const key = (el, k, extra = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
const byText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const panelEl = () => document.querySelector('dialog.stem-focus');
const status = () => panelEl().querySelector('[data-field="status"]').textContent;

/** The AudioController interface (audio.js), observable. */
class FakeAudio {
  constructor() { this._l = new Set(); this._cur = null; this._paused = true; this.time = 0; this.calls = []; }
  on(fn) { this._l.add(fn); return () => this._l.delete(fn); }
  emit(type, payload) { for (const fn of [...this._l]) fn(type, payload); }
  get current() { return this._cur ? { ...this._cur } : null; }
  get playing() { return !this._paused; }
  play(source) {
    this.calls.push(['play', source.url]);
    if (this._cur) this.stop();
    this._cur = { ...source };
    this._paused = false;
    this.emit('play', { ...source });
  }
  resume() { this.calls.push(['resume']); this._paused = false; this.emit('play', { ...this._cur }); return true; }
  pause() { this.calls.push(['pause']); this._paused = true; this.emit('pause', {}); }
  stop() { this.calls.push(['stop']); this._paused = true; this._cur = null; this.time = 0; this.emit('stop', null); }
  seek(t) { this.calls.push(['seek', Math.round(t * 1000) / 1000]); this.time = t; this.emit('seek', t); }
}

const variants = (names = {}) => ({
  track_id: 't-lan',
  variants: [
    { name: 'full', stem_set_id: null, audio_url: '/api/tracks/t-lan/audio' },
    ...['vocals', 'drums', 'bass', 'other'].map((role) => ({
      name: role, display_name: names[role] ?? role, custom_name: Boolean(names[role]),
      stem_set_id: SET, method: 'demucs', model_name: 'htdemucs', audio_url: url(SET, role),
    })),
  ],
});
const card = (names = {}) => ({
  stem_set_id: SET, track_id: 't-lan', track_name: 'Paper Lanterns', bpm: 95, bpm_source: 'measured', method: 'demucs', model_name: 'htdemucs',
  stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ name: role, display_name: names[role] ?? role, custom_name: Boolean(names[role]), audio_url: url(SET, role) })),
});
const wavePayload = (role, duration = 200) => ({
  version: 1, bins: 1200, duration_sec: duration, stem_set_id: SET, role,
  peaks: Array.from({ length: 1200 }, (_, i) => [-0.1 - (i % 7) / 20, 0.1 + (i % 5) / 20]),
});

function backend() {
  const names = {};
  const calls = [];
  const fetched = [];
  return {
    names, calls, fetched,
    patchJson: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      for (const [role, value] of Object.entries(body.names)) { if (value === null) delete names[role]; else names[role] = value; }
      return card(names);
    },
    fetchJson: async (path) => {
      fetched.push(path);
      const m = path.match(/^\/api\/stems\/([^/]+)\/waveform\?name=(\w+)$/);
      if (m) return wavePayload(m[2]);
      if (path === `/api/stem-sets/${SET}`) return card(names);
      if (path.startsWith('/api/tracks/')) return variants(names);
      return null;
    },
  };
}

let dom;
let audio;
const panels = [];
test.beforeEach(() => {
  dom = setupDom();
  resetStemSleeveForTests();
  audio = new FakeAudio();
  useFocusAudio(audio);
});
test.afterEach(() => {
  closeStemFocus();
  while (panels.length) panels.pop().dispose();
  useFocusAudio(null);
  teardownDom(dom);
});

const vocalsStem = (names) => stemsFromVariants(variants(names), { trackId: 't-lan', trackName: 'Paper Lanterns' })[0];

// ------------------------------------------------------------ role identity

test('role identity: four instrument roles have their own token, glyph and written name; center/sides and unknown are neutral', () => {
  assert.deepEqual(Object.keys(ROLE_TOKENS).slice(0, 4), ['drums', 'bass', 'vocals', 'other']);
  const glyphs = new Set(['drums', 'bass', 'vocals', 'other'].map((r) => roleToken(r).glyph));
  assert.equal(glyphs.size, 4, 'each instrument role has its own glyph');
  assert.equal(roleToken('center').token, 'split');
  assert.equal(roleToken('sides').token, 'split');
  assert.equal(roleToken('center').neutral, true);
  assert.equal(roleToken('kazoo').token, 'unknown');
  const chip = roleChip('vocals');
  assert.equal(chip.dataset.roleToken, 'vocals');
  assert.equal(chip.textContent, 'Vocals', 'the role is written, not colour alone');
  assert.equal(chip.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(roleChip('kazoo').textContent, 'kazoo', 'an unknown role is named honestly');
});

test('the role colours are tokens in studio.css, and the component styles use them without literal colours', async () => {
  const { readFileSync } = await import('node:fs');
  const tokens = readFileSync(new URL('../../src/twobecomeone/studio_static/studio.css', import.meta.url), 'utf8');
  for (const [role, hex] of [['drums', '#e5984b'], ['bass', '#5c7cfa'], ['vocals', '#eb5e7c'], ['other', '#38b2a6']]) {
    assert.match(tokens, new RegExp(`--color-role-${role}: ${hex};`));
  }
  const css = readFileSync(new URL('../../src/twobecomeone/studio_static/styles/stem-focus.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  const html = readFileSync(new URL('../../src/twobecomeone/studio_static/index.html', import.meta.url), 'utf8');
  assert.match(html, /styles\/stem-focus\.css/);
});

// ------------------------------------------------------------ opening

test('Library/Crate stem list: a visible Focus button and a double-click both open the panel; opening plays and decodes nothing', async () => {
  const api = backend();
  const opened = [];
  const list = createStemList({ label: 'Stems', api, onUse: () => {}, onFocus: (stem, trigger) => opened.push([stem.key, trigger]) });
  document.getElementById('main').append(list.el);
  list.setStems(stemsFromVariants(variants(), { trackId: 't-lan', trackName: 'Paper Lanterns' }));
  const row = list.el.querySelector(`[data-stem-key="${SET}:drums"]`);
  assert.equal(row.dataset.roleToken, 'drums');
  assert.equal(row.querySelector('.role-chip').textContent, 'Drums');
  const focusBtn = byText(row, 'Focus');
  assert.ok(focusBtn, 'touch screens get a visible button');
  assert.equal(focusBtn.getAttribute('aria-haspopup'), 'dialog');
  click(focusBtn);
  dblclick(row.querySelector('.stem-sleeve__facts'));
  dblclick(byText(row, 'Rename')); // a double-click on a button is that button's, not Focus
  assert.deepEqual(opened.map(([k]) => k), [`${SET}:drums`, `${SET}:drums`]);
  assert.equal(opened[0][1], focusBtn);
  list.dispose();
});

test('asset mode shows the authoritative identity, draws the stored file\'s peaks, and plays nothing until Play', async () => {
  const api = backend();
  const trigger = document.createElement('button');
  document.getElementById('main').append(trigger);
  trigger.focus();
  openStemFocus({ mode: 'asset', stem: vocalsStem({ vocals: 'Lantern Lead' }), api, trigger });
  await flush();
  const el = panelEl();
  assert.ok(el.open, 'a modal dialog');
  assert.equal(el.dataset.mode, 'asset');
  assert.equal(el.dataset.roleToken, 'vocals');
  assert.equal(el.querySelector('.stem-focus__title').textContent, 'Lantern Lead');
  const text = el.textContent;
  assert.match(text, /Vocals stem, renamed by you/);
  assert.match(text, /From“Paper Lanterns”/);
  assert.match(text, /set-lant · role token vocals/);
  assert.match(text, /Demucs · htdemucs/);
  assert.match(text, /stem audio available/);
  assert.deepEqual(api.fetched, [stemWaveformPath(SET, 'vocals')], 'only the waveform route is read');
  const wave = el.querySelector('[data-testid="focus-wave"]');
  assert.equal(wave.dataset.source, 'stem-file');
  assert.equal(wave.dataset.bins, '1200');
  assert.deepEqual(audio.calls, [], 'opening plays nothing');
  assert.match(status(), /Nothing is playing/);
  // Essentials first; the rest under Details and tools.
  assert.equal(el.querySelector('[data-testid="focus-tools"]').open, false);
  key(el, 'Escape');
  el.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  assert.equal(panelEl(), null, 'Escape closes');
  assert.equal(document.activeElement, trigger, 'focus returns to what opened it');
});

// ------------------------------------------------------------ audition

test('audition: Play uses the ONE shared preview at In; Out stops it, Loop returns to In; Pause resumes without reloading', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  const h = activeStemFocus();
  h.setWindow(10, 12);
  click(byText(panelEl(), 'Play'));
  assert.deepEqual(audio.calls.slice(0, 2), [['play', url(SET, 'vocals')], ['seek', 10]], 'plays the stem route from In');
  assert.equal(audio.current.kind, 'stem');
  audio.time = 11;
  await frames();
  assert.equal(h.state().playing, true);
  audio.time = 12.01; // past Out, no loop
  await frames();
  assert.equal(h.state().playing, false, 'stopped at Out');
  assert.match(status(), /Reached Out/);
  assert.equal(h.state().cursor, 10);
  // Loop on: Out jumps back to In.
  click(panelEl().querySelector('.stem-focus__check input'));
  audio.calls.length = 0;
  click(byText(panelEl(), 'Play'));
  assert.deepEqual(audio.calls.slice(0, 2), [['seek', 10], ['resume']], 'same source: no reload');
  audio.time = 12.2;
  await frames();
  assert.equal(h.state().playing, true, 'still playing');
  assert.ok(audio.calls.some(([k, v]) => k === 'seek' && v === 10), 'looped back to In');
  click(byText(panelEl(), 'Pause'));
  assert.equal(h.state().playing, false);
  assert.equal(audio.calls.filter(([k]) => k === 'play').length, 0, 'never a second source');
});

test('audition yields to the Arrangement, the desk and a Library preview, and says which one', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  click(byText(panelEl(), 'Play'));
  // app.js pauses the preview on another owner's exclusive-play; the panel hears both.
  window.dispatchEvent(new window.CustomEvent('twobecomeone:exclusive-play', { detail: { owner: 'arrangement' } }));
  audio.pause();
  assert.equal(activeStemFocus().state().playing, false);
  assert.match(status(), /Paused: the Arrangement started playing\. One sound plays at a time/);
  click(byText(panelEl(), 'Play'));
  window.dispatchEvent(new window.CustomEvent('twobecomeone:exclusive-play', { detail: { owner: 'desk' } }));
  assert.match(status(), /the Performance Desk started playing/);
  click(byText(panelEl(), 'Play'));
  audio.play({ kind: 'track', url: '/api/tracks/t-mid/audio', trackId: 't-mid' });
  assert.equal(activeStemFocus().state().playing, false);
  assert.match(status(), /the Library preview started playing/);
  // Closing does not stop a sound the panel no longer owns.
  audio.calls.length = 0;
  closeStemFocus();
  assert.deepEqual(audio.calls, [], 'the Library preview keeps playing');
});

test('closing the panel stops its own preview', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  click(byText(panelEl(), 'Play'));
  closeStemFocus();
  assert.equal(audio.current, null);
  assert.equal(audio.calls.at(-1)[0], 'stop');
});

test('keyboard parity: Space plays, I and O set the window at the cursor, L loops; typing in a field is left alone', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  const el = panelEl();
  const h = activeStemFocus();
  h.moveCursor(5);
  key(el.querySelector('.stem-focus__wave'), 'i');
  h.moveCursor(9);
  key(el.querySelector('.stem-focus__wave'), 'o');
  assert.deepEqual([h.state().inSec, h.state().outSec], [5, 9]);
  key(el.querySelector('.stem-focus__wave'), 'l');
  assert.equal(h.state().loop, true);
  key(el.querySelector('.stem-focus__wave'), ' ');
  assert.equal(h.state().playing, true);
  key(el.querySelector('input[aria-label^="Selection start"]'), 'o');
  assert.equal(h.state().outSec, 9, 'a key typed into a number field is not a shortcut');
});

// ------------------------------------------------------------ asset tools

test('asset mode: Rename sends only the label; the role, set and audio route are unchanged', async () => {
  const api = backend();
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api });
  await flush();
  const el = panelEl();
  el.querySelector('[data-testid="focus-tools"]').open = true;
  const input = el.querySelector('[data-focus-field="name"]');
  input.value = '  Lantern   Lead ';
  el.querySelector('.stem-focus__rename').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(api.calls, [{ path: `/api/stem-sets/${SET}/names`, body: { names: { vocals: 'Lantern Lead' } } }]);
  assert.equal(el.querySelector('.stem-focus__title').textContent, 'Lantern Lead');
  assert.equal(activeStemFocus().state().stem.audioUrl, url(SET, 'vocals'));
  assert.match(status(), /The audio file is unchanged/);
});

test('focus returns to the rebuilt Focus button when a rename re-rendered the row behind the panel', async () => {
  const api = backend();
  const list = createStemList({ label: 'Stems', api, onUse: () => {}, onFocus: (stem, trigger) => openStemFocus({ mode: 'asset', stem, api, trigger }) });
  document.getElementById('main').append(list.el);
  list.setStems(stemsFromVariants(variants(), { trackId: 't-lan', trackName: 'Paper Lanterns' }));
  const focusOf = () => byText(list.el.querySelector(`[data-stem-key="${SET}:vocals"]`), 'Focus');
  const first = focusOf();
  first.focus();
  click(first);
  await flush();
  const el = panelEl();
  el.querySelector('[data-focus-field="name"]').value = 'Lead';
  el.querySelector('.stem-focus__rename').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(first.isConnected, false, 'the row was rebuilt by the rename');
  closeStemFocus();
  assert.equal(document.activeElement, focusOf(), 'focus is on the same stem\'s new Focus button');
  list.dispose();
});

test('asset mode: Place selection hands In/Out to the Arrangement; a window over 90 s is explained, not placed', async () => {
  const placed = [];
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend(), onPlace: (s, w) => { placed.push([s.key, w]); return true; } });
  await flush();
  const h = activeStemFocus();
  h.setWindow(0, 95);
  const placeBtn = () => panelEl().querySelector('[data-focus-action="place"]');
  assert.equal(placeBtn().disabled, true);
  assert.match(panelEl().querySelector('[data-field="place-why"]').textContent, /longer than 90 s cannot be placed from here/);
  h.setWindow(4.5, 9.75);
  assert.equal(placeBtn().disabled, false);
  click(placeBtn());
  assert.deepEqual(placed, [[`${SET}:vocals`, { startSec: 4.5, endSec: 9.75 }]]);
  assert.equal(panelEl(), null, 'the panel closes once the selection is handed over');
  assert.deepEqual(sectionForWindow(4.5, 9.75), { startSec: 4.5, seconds: 30, lengthSec: 5.25 });
  assert.equal(sectionForWindow(0, 61).seconds, 90);
});

// ------------------------------------------------------------ Crate

test('Crate: Focus on an expanded row opens the same panel, reading the stem waveform route', async () => {
  const api = backend();
  const raw = { track_id: 't-lan', name: 'Paper Lanterns', duration: 200, stems: { status: 'quad', quad: true, roles: ['vocals', 'drums', 'bass', 'other'], method: 'demucs' }, actions: [] };
  const source = createCrateSource({
    fetchJson: async (u) => (u.startsWith('/api/crate') ? { items: [raw], total: 1, limit: 20, offset: 0 } : api.fetchJson(u)),
    patchJson: api.patchJson,
  });
  const bridge = { session: () => ({ banks: {}, loading: null }), subscribe: () => () => {} };
  const crate = mountRecordCrate({ container: document.getElementById('main'), source, bridge, searchDelayMs: 0 });
  crate.activate();
  await flush(); await flush();
  click(crate.root.querySelector('.record-crate__item'));
  await flush(); await flush();
  const bassRow = crate.root.querySelector(`[data-stem-key="${SET}:bass"]`);
  const focusBtn = byText(bassRow, 'Focus');
  focusBtn.focus();
  click(focusBtn);
  await flush();
  const el = panelEl();
  assert.equal(el.dataset.mode, 'asset');
  assert.equal(el.dataset.roleToken, 'bass');
  assert.ok(api.fetched.includes(stemWaveformPath(SET, 'bass')));
  assert.deepEqual(audio.calls, []);
  closeStemFocus();
  assert.equal(document.activeElement, focusBtn, 'focus returns to the Crate row');
  assert.ok(crate.root.querySelector(`[data-stem-key="${SET}:bass"]`), 'the Crate row stayed open');
  crate.dispose?.();
});

// ------------------------------------------------------------ Arrangement

const SR = 48000;
async function arrangementWithClip() {
  const fetched = [];
  const api = backend();
  const s = new DawSession({
    fetchImpl: async (u) => { fetched.push(u); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; },
    decodeAudio: async () => {
      const length = 30 * SR;
      const ch = [new Float32Array(length).fill(0.2), new Float32Array(length).fill(0.2)];
      return { sampleRate: SR, numberOfChannels: 2, length, getChannelData: (c) => ch[c] };
    },
    createContext: () => { throw new Error('no AudioContext: Focus must not create one'); },
    RealtimeEngine: class {},
    renderOffline: async () => { throw new Error('not used'); },
    StretchFactory: () => null,
    modules: {},
  });
  const panel = mountArrangementPanel({
    container: document.getElementById('main'), session: s,
    listTracks: async () => ({ items: [] }), listStems: async () => ({ variants: [] }), fetchJson: api.fetchJson,
  });
  panels.push(panel);
  return { s, panel, fetched, api };
}

test('Arrangement: a Focus selection is placed as ONE clip with exactly that in-point and length; Undo removes it', async () => {
  const { s, panel, fetched } = await arrangementWithClip();
  assert.ok(offerStem(vocalsStem(), { startSec: 4.5, endSec: 9.75 }));
  const place = panel.elements.place;
  assert.equal(place.length.value, 'selection');
  assert.match(place.length.selectedOptions[0].textContent, /Focus selection \(5\.25 s from 0:04\.5\)/);
  place.lane.value = '1';
  place.bar.value = '3';
  const revision = s.edit.revision;
  await panel.placeOffered();
  assert.deepEqual(fetched, [`${url(SET, 'vocals')}&start=4.5&duration=30`], 'the 30 s section that holds the selection');
  assert.equal(s.edit.revision, revision + 1, 'one undoable step');
  const [clip] = s.state.clips;
  assert.equal(clip.timelineStartBeat, 8);
  assert.equal(clip.sourceOffsetSec, 0);
  assert.ok(Math.abs(clip.durationBeats - 5.25 * (s.state.transport.masterBpm / 60)) < 1e-6, 'exactly the selection at its own speed');
  assert.equal(stemOffer(), null);
  assert.ok(s.undo());
  assert.equal(s.state.clips.length, 0);
});

async function placedClip(selection) {
  const t = await arrangementWithClip();
  offerStem(vocalsStem(), selection);
  t.panel.elements.place.lane.value = '0';
  t.panel.elements.place.bar.value = '1';
  t.panel.elements.place.length.value = selection ? 'selection' : '30';
  await t.panel.placeOffered();
  clearStemOffer();
  const clip = t.s.state.clips[0];
  const clipNode = () => document.querySelector(`.daw__clip[data-clip-id="${clip.id}"]`);
  return { ...t, clip, clipNode };
}

test('Arrangement: a double-click, the F key and the inspector Focus button open clip mode with the role identity; no engine is made', async () => {
  const { s, clipNode, panel } = await placedClip();
  assert.equal(clipNode().dataset.roleToken, 'vocals', 'the clip carries the role token');
  assert.ok(clipNode().querySelector('.daw__clip-role svg'), 'and its glyph');
  assert.match(clipNode().className, /daw__clip--A/, 'the A/B bank identity is unchanged');
  dblclick(clipNode());
  let el = panelEl();
  assert.equal(el.dataset.mode, 'clip');
  assert.equal(el.dataset.roleToken, 'vocals');
  assert.match(el.textContent, /Clip in the Arrangement/);
  assert.match(el.textContent, /lane 1, bank A/);
  const wave = el.querySelector('[data-testid="focus-wave"]');
  assert.equal(wave.dataset.source, 'decoded-clip', 'peaks the Arrangement already decoded; nothing new is fetched');
  assert.deepEqual(audio.calls, []);
  assert.equal(s.engine ?? null, null);
  closeStemFocus();
  assert.equal(document.activeElement, clipNode(), 'focus returns to the clip');
  key(clipNode(), 'f');
  assert.equal(panelEl()?.dataset.mode, 'clip', 'F opens it from the keyboard');
  closeStemFocus();
  click(panel.elements.inspector.querySelector('[data-action="focus-clip"]'));
  assert.equal(panelEl()?.dataset.mode, 'clip', 'the inspector button opens it too');
});

test('clip mode: the preview plays the clip source span through the shared preview, and Hear it in place uses the Arrangement', async () => {
  const { clip, clipNode, s } = await placedClip();
  dblclick(clipNode());
  const h = activeStemFocus();
  const st = h.state();
  assert.equal(st.inSec, 0);
  assert.ok(Math.abs(st.outSec - 30) < 1e-6, 'the selection starts as the span the clip plays');
  click(byText(panelEl(), 'Play'));
  assert.equal(audio.calls[0][1], url(SET, 'vocals'), 'use the seekable source of the clip');
  assert.match(status(), /at its own speed and level \(no clip gain, fades, speed or pitch\)/);
});

test('clip mode: Trim to selection, gain and Split are ordinary undoable edits; Undo restores; the stem reference never changes', async () => {
  const { s, clip, clipNode } = await placedClip();
  const ref = s.state.assets[clip.assetId].bufferReference;
  dblclick(clipNode());
  const el = panelEl();
  el.querySelector('[data-testid="focus-tools"]').open = true;
  const h = activeStemFocus();
  h.setWindow(6, 14);
  let rev = s.edit.revision;
  click(el.querySelector('[data-focus-action="trim"]'));
  assert.equal(s.edit.revision, rev + 1, 'one step');
  let now = s.state.clips[0];
  assert.equal(now.sourceOffsetSec, 6);
  assert.ok(Math.abs(now.durationBeats - 8 * (s.state.transport.masterBpm / 60)) < 1e-6);
  assert.equal(now.timelineStartBeat, clip.timelineStartBeat, 'it stays where it starts');
  assert.match(status(), /Trimmed/);
  // Gain: one drag is one step.
  const depth = s.edit.historyDepth.past;
  const gain = el.querySelector('input[aria-label="Clip gain"]');
  for (const v of ['-1', '-2', '-3']) { gain.value = v; gain.dispatchEvent(new window.Event('input', { bubbles: true })); }
  gain.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(s.state.clips[0].clipGainDb, -3);
  assert.equal(s.edit.historyDepth.past, depth + 1, 'a gain drag is one undo step');
  // Split at the cursor inside the span.
  h.moveCursor(10);
  rev = s.edit.revision;
  click(el.querySelector('[data-focus-action="split"]'));
  assert.equal(s.state.clips.length, 2);
  assert.equal(s.edit.revision, rev + 1);
  // Undo, three times, from the panel.
  for (let i = 0; i < 3; i += 1) click(el.querySelector('[data-focus-action="undo"]'));
  now = s.state.clips[0];
  assert.equal(s.state.clips.length, 1);
  assert.deepEqual([now.sourceOffsetSec, now.durationBeats, now.clipGainDb], [clip.sourceOffsetSec, clip.durationBeats, clip.clipGainDb]);
  assert.equal(s.state.assets[now.assetId].bufferReference, ref, 'the stem reference is the same');
  assert.equal(Object.keys(s.state.assets).length, 1, 'no new asset was made');
});

test('clip mode: keys inside the panel are the panel\'s, not Arrangement shortcuts; Delete closes it with the clip gone', async () => {
  const { s, clipNode } = await placedClip();
  dblclick(clipNode());
  const el = panelEl();
  const loopBefore = s.state.transport.loopRange;
  key(el.querySelector('.stem-focus__wave'), 'l');
  key(el.querySelector('.stem-focus__wave'), 'Delete');
  key(el.querySelector('.stem-focus__wave'), 's');
  assert.equal(s.state.clips.length, 1, 'Delete and S in the panel did not edit the arrangement');
  assert.equal(s.state.transport.loopRange, loopBefore, 'L toggled the panel loop, not the Arrangement loop');
  assert.equal(activeStemFocus().state().loop, true);
  el.querySelector('[data-testid="focus-tools"]').open = true;
  click(byText(el, 'Delete'));
  assert.equal(s.state.clips.length, 0);
  assert.equal(panelEl(), null);
  assert.ok(s.undo());
  assert.equal(s.state.clips.length, 1, 'Undo brings it back');
});

test('audition: repeated Out boundaries and native end restart the owned source at In', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  const h = activeStemFocus();
  h.setWindow(34, 44);
  click(panelEl().querySelector('.stem-focus__check input'));
  h.play();
  for (let i = 0; i < 2; i += 1) {
    assert.equal(audio.time, 34);
    audio.time = 44;
    await frames();
    assert.equal(h.state().playing, true);
  }
  assert.equal(audio.time, 34);

  // The media can end before the next animation frame checks Out.
  h.setWindow(34, h.state().duration);
  audio.time = h.state().duration;
  audio._paused = true;
  audio.emit('ended');
  assert.equal(audio.playing, true, 'native end must resume the shared player');
  assert.equal(audio.time, 34);
  assert.equal(h.state().cursor, 34);
  assert.equal(audio.calls.filter(([kind]) => kind === 'play').length, 1);

  click(panelEl().querySelector('.stem-focus__check input'));
  audio.time = h.state().duration;
  audio._paused = true;
  audio.emit('ended');
  assert.equal(audio.playing, false);
  assert.equal(h.state().playing, false);
  assert.equal(audio.time, 34, 'native end also parks at In when Loop is off');
});

test('audition: Stop and selection changes park or seek to the latest In', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  const h = activeStemFocus();
  h.setWindow(10, 20);
  h.play();
  h.stop();
  assert.equal(h.state().cursor, 10);
  assert.equal(audio.time, 10, 'Stop must park the media, not just the panel');
  assert.equal(audio.playing, false);

  const setInput = (label, value) => {
    const input = panelEl().querySelector(`input[aria-label^="Selection ${label}"]`);
    input.value = String(value);
    input.dispatchEvent(new window.Event('change'));
  };
  setInput('start', 34);
  setInput('end', 44);
  assert.deepEqual([h.state().inSec, h.state().outSec, h.state().cursor], [34, 44, 34]);
  h.play();
  assert.equal(audio.time, 34);

  h.setWindow(36, 40);
  assert.equal(audio.time, 36, 'moving In past the playhead seeks inside the new region');
  audio.time = 40;
  await frames();
  assert.equal(audio.playing, false);
  assert.equal(audio.time, 36, 'Loop off uses the new In and does not restart');
});

test('audition: full-stem looping and Stop still return to zero when In is zero', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  const h = activeStemFocus();
  click(panelEl().querySelector('.stem-focus__check input'));
  h.play();
  audio.time = h.state().duration;
  audio._paused = true;
  audio.emit('ended');
  assert.equal(audio.playing, true);
  assert.equal(audio.time, 0);
  h.stop();
  assert.equal(audio.playing, false);
  assert.equal(audio.time, 0);
});

test('clip audition: loop and Stop use the seekable stem with clip-local timing', async () => {
  const { clip, clipNode, s } = await placedClip({ startSec: 34, endSec: 44 });
  const ref = s.state.assets[clip.assetId].bufferReference;
  assert.equal(ref, `${url(SET, 'vocals')}&start=34&duration=30`);
  dblclick(clipNode());
  const h = activeStemFocus();
  h.setWindow(4, 5);
  click(panelEl().querySelector('.stem-focus__check input'));
  h.play();
  assert.equal(audio.current.url, url(SET, 'vocals'));
  assert.equal(audio.time, 38);
  audio.time = 39;
  await frames();
  assert.equal(audio.time, 38);
  assert.equal(h.state().cursor, 4);
  h.stop();
  assert.equal(audio.playing, false);
  assert.equal(audio.time, 38);
  assert.equal(h.state().cursor, 4);
  assert.equal(s.state.assets[clip.assetId].bufferReference, ref);
});

test('audition: closing a stopped panel leaves another preview of the same stem alone', async () => {
  openStemFocus({ mode: 'asset', stem: vocalsStem(), api: backend() });
  await flush();
  const h = activeStemFocus();
  h.setWindow(34, 44);
  h.play();
  h.stop();
  audio.play({ kind: 'stem', url: url(SET, 'vocals') });
  closeStemFocus();
  assert.equal(audio.playing, true);
});
