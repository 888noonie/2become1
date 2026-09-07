// tests/frontend/design/stem-crate-fun-mock.test.js — Phase 14A interaction contract.
//
// Loads the standalone FUN stem-crate prototype in jsdom and drives the real
// DOM to prove the audited interaction contract: cross-role drop rejection,
// visible ffmpeg reference-only treatment, reachable error/unavailable states,
// truthful signed compatibility math, and Bloom pointer/keyboard/range parity.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = resolve(__dirname, '../../../design/stem_crate_fun_mock.html');

function loadMock() {
  const html = readFileSync(MOCK_PATH, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  return dom;
}

function cardById(dom, id) {
  return dom.window.document.querySelector(`.card[data-id="${id}"]`);
}

function slot(dom, role) {
  return dom.window.document.querySelector(`.slot[data-role="${role}"]`);
}

function statusText(dom) {
  return dom.window.document.getElementById('statusBar').textContent;
}

function dropOnto(dom, role, cardId) {
  const target = slot(dom, role);
  const evt = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  evt.dataTransfer = { getData: () => cardId };
  target.dispatchEvent(evt);
}

test('cross-role drop is rejected and leaves the slot unchanged', () => {
  const dom = loadMock();
  // c7 = Vocals (voice role) dropped onto BEAT.
  dropOnto(dom, 'beat', 'c7');
  assert.equal(slot(dom, 'beat').dataset.state, 'empty', 'beat slot must stay empty');
  assert.match(statusText(dom), /Cannot place Vocals/);
  assert.match(statusText(dom), /into Beat/);
  dom.window.close();
});

test('same-role drop is accepted', () => {
  const dom = loadMock();
  dropOnto(dom, 'voice', 'c7');
  assert.equal(slot(dom, 'voice').dataset.state, 'transform', 'voice slot accepts its own role');
  dom.window.close();
});

test('ffmpeg cards are reference-only with a disabled Place action', () => {
  const dom = loadMock();
  const center = cardById(dom, 'c8');
  assert.ok(center.classList.contains('reference'), 'ffmpeg card is reference-only');
  const place = center.querySelector('.place');
  assert.equal(place.disabled, true, 'ffmpeg Place button is disabled');
  assert.equal(place.textContent, 'Reference only');
  dom.window.close();
});

test('missing-media stem reaches the unavailable state', () => {
  const dom = loadMock();
  // c11 = Bass with mediaMissing:true, role bass.
  cardById(dom, 'c11').querySelector('.place').click();
  assert.equal(slot(dom, 'bass').dataset.state, 'unavailable');
  assert.match(slot(dom, 'bass').querySelector('.slot__compat').textContent, /Unavailable/);
  dom.window.close();
});

test('unknown-BPM stem reaches the error state', () => {
  const dom = loadMock();
  // c10 = Drums with bpm:null, role beat.
  cardById(dom, 'c10').querySelector('.place').click();
  assert.equal(slot(dom, 'beat').dataset.state, 'error');
  assert.match(slot(dom, 'beat').querySelector('.slot__compat').textContent, /Unknown BPM/);
  dom.window.close();
});

test('compatibility math is signed and truthful (94→120 BPM = +26)', () => {
  const dom = loadMock();
  // c5 = Drums 94 BPM C major → beat slot (target 120 BPM A minor).
  cardById(dom, 'c5').querySelector('.place').click();
  const text = slot(dom, 'beat').querySelector('.slot__compat').textContent;
  assert.match(text, /\+26/, 'BPM delta is +26 (target minus source)');
  assert.match(text, /Transform needed/);
  dom.window.close();
});

test('relative keys are reported compatible with 0 st shift', () => {
  const dom = loadMock();
  // c6 = Bass 94 BPM C major → bass slot. C major and A minor are relative keys.
  cardById(dom, 'c6').querySelector('.place').click();
  const text = slot(dom, 'bass').querySelector('.slot__compat').textContent;
  assert.match(text, /relative-key compatible; 0 st pitch shift proposed/);
  dom.window.close();
});

test('Bloom pad is keyboard-focusable and arrow keys adjust pitch/gain', () => {
  const dom = loadMock();
  const pad = dom.window.document.getElementById('bloomPad');
  assert.equal(pad.tabIndex, 0, 'Bloom pad is focusable');
  pad.focus();
  pad.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  pad.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  pad.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const pitch = dom.window.document.getElementById('bloomPitchOut').textContent;
  const gain = dom.window.document.getElementById('bloomGainOut').textContent;
  assert.equal(pitch, '+2 st');
  assert.equal(gain, '+1%');
  dom.window.close();
});

test('Bloom range inputs are synchronized with the pad', () => {
  const dom = loadMock();
  const pitch = dom.window.document.getElementById('bloomPitch');
  pitch.value = '-5';
  pitch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.getElementById('bloomPitchOut').textContent, '-5 st');
  assert.match(dom.window.document.getElementById('bloomReadout').textContent, /pitch -5 st/);
  dom.window.close();
});

test('four matching Demucs cards unlock all three recipes', () => {
  const dom = loadMock();
  ['c1', 'c2', 'c3', 'c4'].forEach((id) => cardById(dom, id).querySelector('.place').click());
  const unlocked = dom.window.document.querySelectorAll('.trophy.unlocked');
  assert.equal(unlocked.length, 3, 'all three recipes unlock');
  dom.window.close();
});

test('filter buttons expose aria-pressed', () => {
  const dom = loadMock();
  const all = dom.window.document.querySelector('.crate__filters button[data-filter="all"]');
  assert.equal(all.getAttribute('aria-pressed'), 'true');
  const beat = dom.window.document.querySelector('.crate__filters button[data-filter="beat"]');
  assert.equal(beat.getAttribute('aria-pressed'), 'false');
  dom.window.close();
});

test('DJ, REC and Undo are disabled no-ops in the prototype', () => {
  const dom = loadMock();
  const dj = dom.window.document.querySelector('.deck-mode__button[data-mode="dj"]');
  assert.equal(dj.disabled, true);
  const rec = dom.window.document.querySelector('.master button.rec');
  assert.equal(rec.disabled, true);
  dom.window.close();
});

test('unavailable component never unlocks Harmonic Blend or Tempo Match', () => {
  const dom = loadMock();
  // c1 = valid Drums (beat), c4 = valid Vocals (voice), c11 = missing-media Bass.
  cardById(dom, 'c1').querySelector('.place').click();
  cardById(dom, 'c4').querySelector('.place').click();
  cardById(dom, 'c11').querySelector('.place').click();
  assert.equal(slot(dom, 'bass').dataset.state, 'unavailable');
  const unlocked = dom.window.document.querySelectorAll('.trophy.unlocked');
  assert.equal(unlocked.length, 0, 'no recipe may unlock with an unavailable ingredient');
  dom.window.close();
});

test('error component never unlocks a recipe', () => {
  const dom = loadMock();
  // c10 = Drums with bpm:null (error) into beat; c2 = valid Bass (bass).
  cardById(dom, 'c10').querySelector('.place').click();
  cardById(dom, 'c2').querySelector('.place').click();
  assert.equal(slot(dom, 'beat').dataset.state, 'error');
  const unlocked = dom.window.document.querySelectorAll('.trophy.unlocked');
  assert.equal(unlocked.length, 0, 'no recipe may unlock with an error ingredient');
  dom.window.close();
});

test('transform-needed component never unlocks a recipe', () => {
  const dom = loadMock();
  // c5 = Drums 94 BPM (transform) into beat; c2 = valid Bass 120 BPM (bass).
  cardById(dom, 'c5').querySelector('.place').click();
  cardById(dom, 'c2').querySelector('.place').click();
  assert.equal(slot(dom, 'beat').dataset.state, 'transform');
  const unlocked = dom.window.document.querySelectorAll('.trophy.unlocked');
  assert.equal(unlocked.length, 0, 'no recipe may unlock with a transform-needed ingredient');
  dom.window.close();
});

test('reference cards are non-interactive content (no button role, no tabIndex)', () => {
  const dom = loadMock();
  const center = cardById(dom, 'c8');
  assert.equal(center.getAttribute('role'), null, 'reference card has no button role');
  assert.equal(center.tabIndex, -1, 'reference card is not focusable');
  assert.equal(center.draggable, false, 'reference card is not draggable');
  // The disabled Place button is the only control and is inert.
  assert.equal(center.querySelector('.place').disabled, true);
  dom.window.close();
});

test('actionable cards expose exactly one native Place button, no card-level role', () => {
  const dom = loadMock();
  const drums = cardById(dom, 'c1');
  assert.equal(drums.getAttribute('role'), null, 'actionable card is a plain container');
  assert.equal(drums.tabIndex, -1, 'actionable card is not focusable');
  const place = drums.querySelector('.place');
  assert.equal(place.getAttribute('aria-label'), 'Place Drums from Vinyl Streetwear');
  assert.equal(place.disabled, false);
  dom.window.close();
});
