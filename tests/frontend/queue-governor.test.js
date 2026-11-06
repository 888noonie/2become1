// Queue governor: arming, deck choice, and validated queue-progress events.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NEAR_END_SECONDS, validateQueueEvent } from '../../src/twobecomeone/studio_static/js/mashup/contracts.js';
import {
  createQueueState,
  decide,
  enqueueUrl,
  noteAsset,
  noteJob,
  removeItem,
  setArmed,
} from '../../src/twobecomeone/studio_static/js/mashup/queue-governor.js';

const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function ended() {
  return { playing: false, ended: true, time: 180, duration: 180 };
}

function idle() {
  return { playing: false, ended: false, time: 0, duration: 0 };
}

function playing(time, duration) {
  return { playing: true, ended: false, time, duration };
}

function armedWith(url = URL) {
  const queued = enqueueUrl(setArmed(createQueueState(), true), url);
  assert.equal(queued.error, null);
  return queued.state;
}

function assertValid(events) {
  for (const event of events) {
    assert.deepEqual(validateQueueEvent(event), event);
  }
}

test('disarmed decide emits nothing even if A ended and a pending url exists', () => {
  const queued = enqueueUrl(createQueueState(), URL);
  assert.equal(queued.state.armed, false);
  assert.equal(queued.state.items.length, 1);
  const result = decide(queued.state, { A: ended(), B: idle() });
  assert.equal(result.state, queued.state);
  assert.deepEqual(result.events, []);
});

test('armed, A ended, B idle imports onto B once', () => {
  const state = armedWith();
  const playheads = { A: ended(), B: idle() };
  const first = decide(state, playheads);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'import_next');
  assert.equal(first.events[0].deck, 'B');
  assert.equal(first.events[0].url, URL);
  assert.equal(first.events[0].itemId, state.items[0].id);
  assert.equal(first.state.items[0].status, 'importing');
  assert.equal(first.state.items[0].targetDeck, 'B');
  assert.equal(first.state.items[0].jobId, null);
  assert.equal(first.state.activeImportId, state.items[0].id);
  assertValid(first.events);

  const second = decide(first.state, playheads);
  assert.equal(second.state, first.state);
  assert.deepEqual(second.events, []);
});

test('armed, both playing, A near end and B healthy waits', () => {
  assert.equal(NEAR_END_SECONDS, 8);
  const state = armedWith();
  const result = decide(state, {
    A: playing(95, 100),
    B: playing(40, 100),
  });
  assert.equal(result.state, state);
  assert.deepEqual(result.events, []);
  assert.equal(state.items[0].status, 'pending');
});

test('armed, A ended, B playing with 60s replaces the dead deck', () => {
  const state = armedWith();
  const result = decide(state, {
    A: ended(),
    B: playing(40, 100),
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'import_next');
  assert.equal(result.events[0].deck, 'A');
  assert.equal(result.state.items[0].status, 'importing');
  assert.equal(result.state.items[0].targetDeck, 'A');
  assert.equal(result.state.activeImportId, state.items[0].id);
  assertValid(result.events);
});

test('armed, A ended, empty queue blocks once', () => {
  const state = setArmed(createQueueState(), true);
  const playheads = { A: ended(), B: idle() };
  const first = decide(state, playheads);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'blocked');
  assert.equal(first.events[0].code, 'QUEUE_EMPTY');
  assert.equal(first.events[0].message, 'Queue is empty.');
  assert.equal(first.state.endNotified.A, true);
  assert.equal(first.state.endNotified.B, false);
  assertValid(first.events);

  const second = decide(first.state, playheads);
  assert.equal(second.state, first.state);
  assert.deepEqual(second.events, []);
});

test('noteAsset complete assigns the deck and transitions when the other deck is playing', () => {
  const state = armedWith();
  const playheads = {
    A: playing(10, 120),
    B: ended(),
  };
  const decided = decide(state, playheads);
  assert.equal(decided.events[0].deck, 'B');
  const itemId = decided.state.activeImportId;
  const noted = noteAsset(decided.state, itemId, {
    ok: true,
    status: 'complete',
    trackId: 'track-1',
    jobId: 'job-1',
    error: null,
  }, playheads);
  assert.equal(noted.events.length, 2);
  assert.equal(noted.events[0].type, 'assign_deck');
  assert.equal(noted.events[0].deck, 'B');
  assert.equal(noted.events[0].trackId, 'track-1');
  assert.equal(noted.events[0].itemId, itemId);
  assert.equal(noted.events[1].type, 'transition');
  assert.equal(noted.events[1].fromDeck, 'A');
  assert.equal(noted.events[1].toDeck, 'B');
  assert.equal(noted.state.items[0].status, 'loaded');
  assert.equal(noted.state.items[0].trackId, 'track-1');
  assert.equal(noted.state.activeImportId, null);
  assert.equal(decided.state.items[0].status, 'importing');
  assertValid(noted.events);
});

test('noteAsset failure fails the item, clears the import, and blocks', () => {
  const state = armedWith();
  const decided = decide(state, { A: ended(), B: idle() });
  const itemId = decided.state.activeImportId;
  const noted = noteAsset(decided.state, itemId, {
    ok: false,
    status: 'failed',
    trackId: null,
    jobId: 'job-9',
    error: { code: 'YT_UNAVAILABLE', message: 'Video unavailable.' },
  }, { A: ended(), B: idle() });
  assert.equal(noted.state.items[0].status, 'failed');
  assert.deepEqual(noted.state.items[0].error, { code: 'YT_UNAVAILABLE', message: 'Video unavailable.' });
  assert.equal(noted.state.activeImportId, null);
  assert.equal(noted.events.length, 1);
  assert.equal(noted.events[0].type, 'blocked');
  assert.equal(noted.events[0].code, 'YT_UNAVAILABLE');
  assert.equal(noted.events[0].message, 'Video unavailable.');
  assertValid(noted.events);
});

test('enqueue duplicate pending url does not add a second row', () => {
  const first = enqueueUrl(createQueueState(), `  ${URL}  `);
  assert.equal(first.error, null);
  assert.equal(first.state.items.length, 1);
  assert.equal(first.state.items[0].url, URL);
  assert.equal(first.state.items[0].id, `q1-${URL.length}`);
  assert.equal(first.state.items[0].status, 'pending');
  const second = enqueueUrl(first.state, URL);
  assert.equal(second.state, first.state);
  assert.equal(second.error, null);
  assert.equal(second.state.items.length, 1);
  const empty = enqueueUrl(first.state, '   ');
  assert.equal(empty.state, first.state);
  assert.deepEqual(empty.error, { code: 'EMPTY_URL', message: 'URL is empty.' });
});

test('remove importing item is a no-op', () => {
  const state = armedWith();
  const decided = decide(state, { A: ended(), B: idle() });
  assert.equal(decided.state.items[0].status, 'importing');
  const removed = removeItem(decided.state, decided.state.items[0].id);
  assert.equal(removed, decided.state);
  assert.equal(removed.activeImportId, decided.state.items[0].id);
});

test('noteJob failure clears the active import and queued stays importing', () => {
  const state = armedWith();
  const decided = decide(state, { A: ended(), B: idle() });
  const itemId = decided.state.items[0].id;
  const running = noteJob(decided.state, itemId, { id: 'job-2', status: 'running' });
  assert.equal(running.items[0].status, 'importing');
  assert.equal(running.items[0].jobId, 'job-2');
  assert.equal(running.activeImportId, itemId);
  const failed = noteJob(running, itemId, { id: 'job-2', status: 'cancelled' });
  assert.equal(failed.items[0].status, 'failed');
  assert.deepEqual(failed.items[0].error, { code: 'JOB_FAILED', message: 'cancelled' });
  assert.equal(failed.activeImportId, null);
  assert.equal(noteJob(failed, itemId, { id: 'job-3', status: 'failed' }), failed);
});

test('events validate', () => {
  const state = armedWith();
  const imported = decide(state, { A: ended(), B: idle() });
  assertValid(imported.events);
  const loaded = noteAsset(imported.state, imported.state.activeImportId, {
    ok: true,
    status: 'complete',
    trackId: 'track-2',
    jobId: 'job-2',
    error: null,
  }, { A: ended(), B: idle() });
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].type, 'assign_deck');
  assertValid(loaded.events);
  const blocked = decide(setArmed(createQueueState(), true), { A: ended() });
  assertValid(blocked.events);
});
