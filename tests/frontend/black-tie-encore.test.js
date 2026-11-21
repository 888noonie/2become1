// tests/frontend/black-tie-encore.test.js — OPERATION BLACK TIE ENCORE.
//
// Draw levels as an instrument: points land on the Snap grid, a press that
// does not travel never moves a point or adds history, a finger that pans
// never leaves a stray point, G and Escape behave around text fields and the
// transport, positions read as bars and beats, and the Producer's four-bar
// entrance is drawn apart from the musician's curve until it is kept.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import {
  mountArrangementPanel, musicalPosition, pointLevelText, ZOOM_LEVELS,
} from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { mountArrangementProducer } from '../../src/twobecomeone/studio_static/js/components/arrangement-producer.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

const SR = 48000;
const SHARED = new Float32Array(30 * SR).fill(0.1);
const decodeAudio = async () => ({ sampleRate: SR, numberOfChannels: 2, length: SHARED.length, getChannelData: () => SHARED });
const PPB = ZOOM_LEVELS[3]; // the panel opens at this zoom; jsdom lanes sit at x = 0

async function mounted() {
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });
  const fetchImpl = async (url) => {
    if (url === '/api/producer/model') return reply(200, { provider: 'ollama', model: 'test', local: true, available: true, note: '' });
    if (String(url).includes('/listening')) return reply(404, { error: { code: 'NOT_ANALYSED', message: 'not yet' } });
    return reply(200, {});
  };
  const s = new DawSession({
    fetchImpl, decodeAudio,
    createContext: () => { throw new Error('no audio in this test'); },
    RealtimeEngine: class {}, renderOffline: async () => { throw new Error('not used'); }, StretchFactory: () => null, modules: {},
  });
  const container = document.getElementById('main');
  const api = mountArrangementPanel({
    container, session: s, listTracks: async () => ({ items: [] }), listStems: async () => ({ variants: [] }),
    producer: mountArrangementProducer,
  });
  for (const [g, trackId, title, bpm] of [['A', 'tA', 'Looking For Love', 120], ['B', 'tB', 'Need To Feel Loved', 120]]) {
    await s.importGroup(g, {
      trackId, title, bpm, section: { startSec: 0, seconds: 30 },
      stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/set${g}/audio?name=${role}`, stemSetId: `set${g}` })),
    });
  }
  api.render();
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const tell = async (text) => {
    const input = prod.querySelector('.daw__talk-input');
    input.value = text;
    prod.querySelector('.daw__talk').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && prod.querySelector('.daw__talk-input').disabled; i += 1) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));
    return [...prod.querySelectorAll('.daw__talk-log li')].at(-1)?.textContent ?? '';
  };
  return { api, s, container, prod, btn, tell };
}

function pointer(el, type, init = {}) {
  const { pointerType = 'mouse', pointerId = 1, ...rest } = init;
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...rest });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  el.dispatchEvent(ev);
  return ev;
}
const key = (k, init = {}, target = document) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const lane = (c, i) => c.querySelector(`.daw__lane[data-track="${i}"]`);
const handles = (c, i) => [...lane(c, i).querySelectorAll('[data-env-point]')];
const levelsOn = (c) => [...c.querySelectorAll('button')].find((b) => b.textContent === 'Draw levels').getAttribute('aria-pressed') === 'true';

test('positions read as bars and beats, with fractions a musician would say', () => {
  assert.equal(musicalPosition(0, 4), 'bar 1');
  assert.equal(musicalPosition(16, 4), 'bar 5');
  assert.equal(musicalPosition(18, 4), 'bar 5, beat 3');
  assert.equal(musicalPosition(13.5, 4), 'bar 4, beat 2½');
  assert.equal(musicalPosition(12.75, 4), 'bar 4, beat 1¾');
  assert.equal(musicalPosition(12 + 1 / 3, 4), 'bar 4, beat 1⅓');
  assert.equal(musicalPosition(15.999999999, 4), 'bar 5', 'float noise is not shown as beat 4.999');
  assert.equal(musicalPosition(4.215, 4), 'bar 2, beat 1.215', 'off-grid positions keep their precision');
  assert.equal(musicalPosition(9, 3), 'bar 4', 'three-four time counts three beats a bar');
  assert.equal(pointLevelText(-9, -3), '-9.0 dB, 3.0 dB under the fader');
  assert.equal(pointLevelText(-6, 0), '-6.0 dB, at the fader');
  assert.equal(pointLevelText(-4.5, 1.5), '-4.5 dB, 1.5 dB over the fader');
});

test('a new point lands on the Snap grid; Alt places it freely', async () => {
  const { s, container } = await mounted();
  key('g');
  assert.ok(levelsOn(container));
  const clip = lane(container, 4).querySelector('.daw__clip');
  pointer(clip, 'pointerdown', { clientX: 4.4 * PPB, clientY: 30 });
  pointer(window, 'pointerup');
  assert.equal(s.state.tracks[4].gainPoints[0].beat, 4.5, 'snapped to the ¼-beat grid');
  pointer(lane(container, 4), 'pointerdown', { clientX: 9.13 * PPB, clientY: 20, altKey: true });
  pointer(window, 'pointerup');
  assert.ok(Math.abs(s.state.tracks[4].gainPoints[1].beat - 9.13) < 1e-9, 'Alt keeps the exact pointer position');
});

test('pressing a point without moving it keeps it exactly and adds no undo step', async () => {
  const { s, container } = await mounted();
  assert.equal(s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: [{ beat: 4.37, db: -7.3 }] } }).ok, true);
  key('g');
  const depth = s.edit.historyDepth.past;
  const h = handles(container, 4)[0];
  pointer(h, 'pointerdown', { clientX: 4.37 * PPB + 1, clientY: 30 });
  pointer(window, 'pointermove', { clientX: 4.37 * PPB + 2, clientY: 31 });
  pointer(window, 'pointerup');
  assert.deepEqual(s.state.tracks[4].gainPoints, [{ beat: 4.37, db: -7.3 }], 'a press is a selection, not a move');
  assert.equal(s.edit.historyDepth.past, depth, 'Undo still means the last real edit');
  assert.ok(handles(container, 4)[0].classList.contains('is-selected'));
  assert.equal(handles(container, 4)[0].getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, handles(container, 4)[0], 'the selected point has keyboard focus');
});

test('dragging a point follows the Snap grid and is one undo step', async () => {
  const { s, container } = await mounted();
  s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: [{ beat: 4, db: -6 }] } });
  key('g');
  const depth = s.edit.historyDepth.past;
  pointer(handles(container, 4)[0], 'pointerdown', { clientX: 4 * PPB, clientY: 30 });
  for (const x of [5.1, 6.3, 8.12]) pointer(window, 'pointermove', { clientX: x * PPB, clientY: 30 });
  pointer(window, 'pointerup');
  assert.equal(s.state.tracks[4].gainPoints[0].beat, 8, 'the drag lands on the grid');
  assert.equal(s.edit.historyDepth.past, depth + 1);
  s.undo();
  assert.deepEqual(s.state.tracks[4].gainPoints, [{ beat: 4, db: -6 }]);
  s.redo();
  assert.equal(s.state.tracks[4].gainPoints[0].beat, 8);
});

test('a level-only drag keeps an off-grid point on its exact beat', async () => {
  const { s, container } = await mounted();
  s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: [{ beat: 4.37, db: -6 }] } });
  key('g');
  pointer(handles(container, 4)[0], 'pointerdown', { clientX: 4.37 * PPB, clientY: 30 });
  pointer(window, 'pointermove', { clientX: 4.37 * PPB + 1, clientY: 20 });
  pointer(window, 'pointermove', { clientX: 4.37 * PPB + 2, clientY: 12 });
  pointer(window, 'pointerup');
  const [p] = s.state.tracks[4].gainPoints;
  assert.equal(p.beat, 4.37, 'no sideways jump onto the grid');
  assert.ok(p.db > -6, 'the level moved');
});

test('a finger that pans the timeline never leaves a point behind', async () => {
  const { s, container } = await mounted();
  key('g');
  const before = s.edit.serialize();
  // Touch down on empty lane, then the browser takes the gesture as a pan.
  pointer(lane(container, 4), 'pointerdown', { clientX: 100, clientY: 30, pointerType: 'touch', pointerId: 7 });
  assert.equal(s.state.tracks[4].gainPoints, undefined, 'nothing is placed while the finger may still pan');
  pointer(window, 'pointercancel', { pointerType: 'touch', pointerId: 7 });
  assert.equal(s.edit.serialize(), before);
  // A finger that travels before lifting is a pan too.
  pointer(lane(container, 4), 'pointerdown', { clientX: 100, clientY: 30, pointerType: 'touch', pointerId: 8 });
  pointer(window, 'pointermove', { clientX: 160, clientY: 30, pointerType: 'touch', pointerId: 8 });
  pointer(window, 'pointerup', { pointerType: 'touch', pointerId: 8 });
  assert.equal(s.edit.serialize(), before);
  // A tap places one point, on the grid.
  pointer(lane(container, 4), 'pointerdown', { clientX: 2.1 * PPB, clientY: 30, pointerType: 'touch', pointerId: 9 });
  pointer(window, 'pointerup', { pointerType: 'touch', pointerId: 9 });
  assert.equal(s.state.tracks[4].gainPoints.length, 1);
  assert.equal(s.state.tracks[4].gainPoints[0].beat, 2);
  // A point drag the browser cancels is taken back, not committed.
  const placed = s.edit.serialize();
  pointer(handles(container, 4)[0], 'pointerdown', { clientX: 2 * PPB, clientY: 30, pointerType: 'touch', pointerId: 10 });
  pointer(window, 'pointermove', { clientX: 6 * PPB, clientY: 10, pointerType: 'touch', pointerId: 10 });
  assert.notEqual(s.edit.serialize(), placed);
  pointer(window, 'pointercancel', { pointerType: 'touch', pointerId: 10 });
  assert.equal(s.edit.serialize(), placed, 'a cancelled drag returns the point');
});

test('Shift gives fine keyboard steps and Delete keeps focus on the lane’s next point', async () => {
  const { s, container } = await mounted();
  s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: [{ beat: 0, db: -12 }, { beat: 8, db: -6 }, { beat: 16, db: 0 }] } });
  const second = handles(container, 4)[1];
  second.focus();
  key('ArrowUp', { shiftKey: true }, second);
  key('ArrowRight', { shiftKey: true }, document.activeElement);
  assert.deepEqual(s.state.tracks[4].gainPoints[1], { beat: 8.0625, db: -5.9 });
  key('ArrowRight', {}, document.activeElement);
  assert.equal(s.state.tracks[4].gainPoints[1].beat, 8.3125, 'one Snap step (¼ beat)');
  key('Delete', {}, document.activeElement);
  assert.equal(s.state.tracks[4].gainPoints.length, 2);
  const focused = document.activeElement;
  assert.equal(focused?.dataset?.envPoint, '1', 'focus stays on a point');
  assert.equal(focused.getAttribute('aria-label'), 'B Vocals level point at bar 5: 0.0 dB, at the fader', 'the nearest neighbour in time');
  key('Delete', {}, focused);
  assert.equal(s.state.tracks[4].gainPoints.length, 1, 'a second Delete works without reaching for the mouse');
});

test('G is ignored while typing to the Producer or working elsewhere; Escape leaves the mode without stopping', async () => {
  const { s, container, prod } = await mounted();
  const input = prod.querySelector('.daw__talk-input');
  input.focus();
  key('g', {}, input);
  assert.equal(levelsOn(container), false, 'typing “g” to the Producer is just a letter');
  const elsewhere = document.createElement('button');
  document.body.append(elsewhere);
  key('g', {}, elsewhere);
  assert.equal(levelsOn(container), false, 'G on another panel is not a levels gesture');
  key('g');
  assert.equal(levelsOn(container), true);
  let stops = 0;
  const stop = s.stop.bind(s);
  s.stop = () => { stops += 1; return stop(); };
  key('Escape');
  assert.equal(levelsOn(container), false, 'Escape returns to clip editing');
  assert.equal(stops, 0, 'and does not stop the music');
  key('Escape');
  assert.equal(stops, 1, 'a second Escape stops as before');
});

test('the inspector names a point in bars, beats and dB against the fader', async () => {
  const { s, container } = await mounted();
  s.apply({ name: 'setTrackVolume', args: { trackIndex: 4, volumeDb: -6 } });
  s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: [{ beat: 13.5, db: -3 }] } });
  key('g');
  pointer(handles(container, 4)[0], 'pointerdown', { clientX: 13.5 * PPB, clientY: 30 });
  pointer(window, 'pointerup');
  const text = container.querySelector('.daw__inspector').textContent;
  assert.match(text, /Level point at bar 4, beat 2½ · -9\.0 dB, 3\.0 dB under the fader/);
  assert.doesNotMatch(text, /· 480|absolute/, 'no ticks or engineering words');
  assert.match(container.querySelector('.daw__env-readout').textContent, /^bar 4, beat 2½ · -9\.0 dB$/);
});

test('the Producer’s entrance is drawn as an idea until it is kept, and a hand edit makes it yours', async () => {
  const { s, container, btn, tell, prod } = await mounted();
  const vocal = s.state.clips.find((c) => c.trackIndex === 4);
  s.apply({ name: 'moveClip', args: { clipId: vocal.id, newTrackIndex: 4, newStartBeat: 64 } });
  const mine = s.edit.serialize();
  const said = await tell('bring song B vocals in gradually across four bars');
  assert.match(said, /rises from 60 dB under its fader at bar 17 to the fader by bar 21/);
  assert.match(prod.querySelector('.daw__producer-list').textContent, /bar 17 60 dB under the fader → bar 21 at the fader/);
  // Proposed: a dashed curve on the lane, nothing in the project.
  assert.ok(lane(container, 4).querySelector('.daw__env-line--idea'), 'the proposed curve is visible before Hear it');
  assert.match(lane(container, 4).querySelector('.daw__env-idea').textContent, /Idea · not playing/);
  assert.equal(s.edit.serialize(), mine);
  // Hearing: the curve sounds, and is marked as not kept.
  btn('Hear it').click();
  assert.deepEqual(s.state.tracks[4].gainPoints, [{ beat: 64, db: -60 }, { beat: 80, db: 0 }]);
  assert.ok(lane(container, 4).querySelector('.daw__env-line.is-idea'));
  assert.match(lane(container, 4).querySelector('.daw__env-idea').textContent, /playing, not kept/);
  // Reject: the project is exactly the musician's again, no idea drawn.
  btn('Reject').click();
  assert.equal(s.edit.serialize(), mine);
  assert.equal(lane(container, 4).querySelector('.daw__env-idea'), null);
  assert.equal(lane(container, 4).querySelector('.daw__env-line--idea'), null);

  // Again, then the musician moves the end point by hand while hearing it.
  await tell('bring song B vocals in gradually across four bars');
  btn('Hear it').click();
  key('g');
  const end = handles(container, 4)[1];
  pointer(end, 'pointerdown', { clientX: 80 * PPB, clientY: 5 });
  pointer(window, 'pointermove', { clientX: 72 * PPB, clientY: 5 });
  pointer(window, 'pointerup');
  const theirs = s.state.tracks[4].gainPoints.map((p) => ({ ...p }));
  assert.equal(theirs[1].beat, 72);
  assert.equal(lane(container, 4).querySelector('.daw__env-idea'), null, 'the hand-edited curve is no longer marked as an idea');
  assert.equal(lane(container, 4).querySelector('.daw__env-line.is-idea'), null);
  assert.equal(btn('Hear it').disabled, true, 'nothing to hear: the idea was set aside');
  btn('Hear it').click();
  btn('Reject').click();
  assert.deepEqual(s.state.tracks[4].gainPoints, theirs, 'the musician’s curve is never overwritten by the idea');

  // Keep: the curve becomes plain project automation.
  s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: [] } });
  await tell('bring song B vocals in gradually across four bars');
  btn('Hear it').click();
  btn('Keep it').click();
  assert.deepEqual(s.state.tracks[4].gainPoints, [{ beat: 64, db: -60 }, { beat: 80, db: 0 }]);
  assert.equal(lane(container, 4).querySelector('.daw__env-idea'), null, 'a kept curve is the musician’s');
});
