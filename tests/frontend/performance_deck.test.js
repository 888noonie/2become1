// Ultimate Deck frontend-only boundary: dual-mode UI and truthful render controls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => {
  dom = setupDom();
  window.localStorage.clear();
});
test.afterEach(() => teardownDom(dom));

test('performance math resolves bar duration and equal-power render blend', async () => {
  const { durationForBars, gainsForBlend, normalizeDeckMode } = await import(
    '../../src/twobecomeone/studio_static/js/components/performance-deck.js'
  );

  assert.equal(durationForBars(8, 120), 16);
  assert.equal(durationForBars(4, 96), 10);
  assert.deepEqual(gainsForBlend(0), { anchor_gain: 1, lead_gain: 0 });
  assert.deepEqual(gainsForBlend(50), { anchor_gain: 0.707, lead_gain: 0.707 });
  assert.deepEqual(gainsForBlend(100), { anchor_gain: 0, lead_gain: 1 });
  assert.equal(normalizeDeckMode('fun'), 'fun');
  assert.equal(normalizeDeckMode('unexpected'), 'dj');
});

test('FUN view renders seven pads and writes real project settings', async () => {
  const { mountPerformanceDeck } = await import(
    '../../src/twobecomeone/studio_static/js/components/performance-deck.js'
  );
  const state = {
    currentProject: {
      id: 'project-1', anchor_track_id: 'track-a', lead_track_id: 'track-b',
      anchor_variant: 'full', lead_variant: 'full',
      settings: { anchor_gain: 0.8, lead_gain: 0.8, arrangement_mode: 'overlay' },
    },
    deckTracks: {
      'track-a': { id: 'track-a', name: 'Foundation Song', bpm: 120, audio_url: '/a.mp3' },
      'track-b': { id: 'track-b', name: 'Lead Song', bpm: 100, audio_url: '/b.mp3' },
    },
    playback: { playing: false, trackId: null, source: null },
    session: { committedLayers: [] },
    stems: {},
  };
  const listeners = new Set();
  const store = {
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    dispatch: () => {},
  };
  const saves = [];
  const projectManager = { save: (patch) => saves.push(patch) };
  const container = document.createElement('div');
  document.body.appendChild(container);

  const dispose = mountPerformanceDeck({ container, store, projectManager });
  const funButton = [...container.querySelectorAll('.deck-mode__button')]
    .find((button) => button.textContent.includes('FUN'));
  funButton.click();

  assert.equal(container.querySelectorAll('.performance-pad').length, 7);
  assert.match(container.textContent, /Foundation Song/);
  assert.match(container.textContent, /Lead Song/);
  assert.match(container.textContent, /single local audition player/);
  assert.equal(window.localStorage.getItem('2become1.deck-mode'), 'fun');

  const eightBars = [...container.querySelectorAll('.performance-chip')]
    .find((button) => button.textContent === '8');
  eightBars.click();
  assert.equal(saves.at(-1).settings.duration, 16);

  const blend = container.querySelector('.performance-blend');
  blend.value = '100';
  blend.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(saves.at(-1).settings.anchor_gain, 0);
  assert.equal(saves.at(-1).settings.lead_gain, 1);

  const transition = [...container.querySelectorAll('.performance-chip')]
    .find((button) => button.textContent === 'A → B');
  transition.click();
  assert.equal(saves.at(-1).settings.arrangement_mode, 'transition');
  dispose();
});
