// tests/frontend/backoff.test.js — backoff timing, retry ceiling, polling
// fallback, and source-picker close-without-cancel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

test('backoff sequence is 1s -> 2s -> 5s -> 10s then polling fallback', async () => {
  const api = await import('../../src/twobecomeone/studio_static/js/api.js');

  // Stub fetch for the polling fallback.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ id: 'job-x', status: 'running' }),
  });

  // Make setTimeout fire synchronously so the reconnect chain actually runs,
  // while recording the requested delays.
  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay) => {
    delays.push(delay);
    fn();
    return 0;
  };

  const unsubscribe = api.watchJob('job-x', () => {});

  // First error -> schedules 1000ms reconnect, which fires immediately and
  // opens a new EventSource. Repeat to walk the ladder.
  let es = globalThis.EventSource.instances[0];
  es.error(); // -> 1000ms
  es = globalThis.EventSource.instances[1];
  es.error(); // -> 2000ms
  es = globalThis.EventSource.instances[2];
  es.error(); // -> 5000ms
  es = globalThis.EventSource.instances[3];
  es.error(); // -> 10000ms

  assert.deepEqual(delays.slice(0, 4), [1000, 2000, 5000, 10000]);
  assert.equal(globalThis.EventSource.instances.length, 4, 'retry ceiling falls back instead of opening a fifth SSE');

  globalThis.setTimeout = originalSetTimeout;
  unsubscribe();
});

test('source picker close does not cancel active imports', async () => {
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());

  // Simulate an active import job in state.
  store.dispatch({ type: 'jobs/set', items: [{ id: 'imp-1', status: 'running', kind: 'import' }], total: 1, activeCount: 1 });

  // Open the picker, then close it.
  store.dispatch({ type: 'sourcePicker/open', slot: 'anchor' });
  assert.equal(store.getState().sourcePicker.open, true);

  store.dispatch({ type: 'sourcePicker/close' });
  assert.equal(store.getState().sourcePicker.open, false);

  // The import job is untouched.
  assert.equal(store.getState().jobs.items[0].status, 'running');
  assert.equal(store.getState().jobs.activeCount, 1);
});
