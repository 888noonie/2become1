// tests/frontend/audio.test.js — AudioController singleton behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

test('playing B while A is active pauses A, resets it, leaves only B active', async () => {
  const { audioController } = await import('../../src/twobecomeone/studio_static/js/audio.js');

  const events = [];
  audioController.on((type, payload) => events.push({ type, payload }));

  audioController.play('A', '/api/tracks/A/audio');
  assert.equal(audioController.current.trackId, 'A');
  assert.equal(audioController.playing, true);

  // Play B: A is stopped/reset, B becomes current.
  audioController.play('B', '/api/tracks/B/audio');
  assert.equal(audioController.current.trackId, 'B');
  assert.equal(audioController.playing, true);

  // A stop event fired before B's play.
  const stopIndex = events.findIndex((e) => e.type === 'stop');
  const playBIndex = events.findIndex((e) => e.type === 'play' && e.payload.trackId === 'B');
  assert.ok(stopIndex >= 0);
  assert.ok(playBIndex > stopIndex);
});

test('stop resets current and pauses', async () => {
  const { audioController } = await import('../../src/twobecomeone/studio_static/js/audio.js');
  audioController.play('A', '/api/tracks/A/audio');
  audioController.stop();
  assert.equal(audioController.current, null);
  assert.equal(audioController.playing, false);
});

test('play() AbortError is caught (no unhandled rejection)', async () => {
  const { audioController } = await import('../../src/twobecomeone/studio_static/js/audio.js');
  // Force the underlying audio.play() to reject with AbortError.
  const originalPlay = audioController._audio.play;
  audioController._audio.play = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  // Should not throw.
  audioController.play('A', '/api/tracks/A/audio');
  audioController._audio.play = originalPlay;
});

test('seek emits an ownership-changing event for Ghost cancellation', async () => {
  const { audioController } = await import('../../src/twobecomeone/studio_static/js/audio.js');
  const events = [];
  const unsubscribe = audioController.on((type, payload) => events.push({ type, payload }));
  audioController.seek(12.5);
  unsubscribe();
  assert.deepEqual(events.at(-1), { type: 'seek', payload: 12.5 });
});
