// tests/frontend/state.test.js — StateStore reducer immutability, slice
// notifications, job upserts, library deduplication, project-slot assignment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function loadState() {
  // Import after globals are installed.
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  return { StateStore, registerReducers };
}

test('reducers return new objects (immutability)', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());
  const before = store.getState();

  store.dispatch({ type: 'route/set', route: 'library' });
  const after = store.getState();

  assert.notEqual(after, before);
  assert.equal(after.route, 'library');
  assert.equal(before.route, 'studio'); // original untouched
});

test('slice subscription fires only on relevant slice change', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());
  let libraryCalls = 0;
  let routeCalls = 0;

  store.subscribeSlice('library', () => { libraryCalls += 1; });
  store.subscribeSlice('route', () => { routeCalls += 1; });

  store.dispatch({ type: 'route/set', route: 'engine' });
  assert.equal(routeCalls, 1);
  assert.equal(libraryCalls, 0);

  store.dispatch({ type: 'library/set', items: [{ id: 't1' }], total: 1, limit: 50, offset: 0 });
  assert.equal(libraryCalls, 1);
  assert.equal(routeCalls, 1);
});

test('subscriber receives a deep copy (cannot mutate state)', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());
  let received = null;
  store.subscribe((state) => { received = state; });

  store.dispatch({ type: 'route/set', route: 'library' });
  received.route = 'HACKED';

  assert.equal(store.getState().route, 'library');
});

test('dispatch result and action payload cannot mutate internal state', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());
  const health = { queue: { active: 1 } };

  const returned = store.dispatch({ type: 'health/set', health });
  returned.health.queue.active = 99;
  health.queue.active = 77;

  assert.equal(store.getState().health.queue.active, 1);
});

test('job upsert replaces by id and inserts new', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({ type: 'jobs/set', items: [{ id: 'a', status: 'running' }], total: 1, activeCount: 1 });
  store.dispatch({ type: 'jobs/upsert', job: { id: 'a', status: 'complete' } });
  assert.equal(store.getState().jobs.items.length, 1);
  assert.equal(store.getState().jobs.items[0].status, 'complete');
  assert.equal(store.getState().jobs.activeCount, 0);

  store.dispatch({ type: 'jobs/upsert', job: { id: 'b', status: 'queued' } });
  assert.equal(store.getState().jobs.items.length, 2);
  assert.equal(store.getState().jobs.activeCount, 1);
});

test('library append deduplicates by id', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({ type: 'library/set', items: [{ id: 't1' }, { id: 't2' }], total: 2, limit: 50, offset: 0 });
  store.dispatch({ type: 'library/append', items: [{ id: 't2' }, { id: 't3' }], total: 3, offset: 2 });

  const ids = store.getState().library.items.map((t) => t.id);
  assert.deepEqual(ids, ['t1', 't2', 't3']);
});

test('library upsert-track deduplicates a completed import', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({ type: 'library/set', items: [{ id: 't1' }], total: 1, limit: 50, offset: 0 });
  store.dispatch({ type: 'library/upsert-track', track: { id: 't1', name: 'renamed' } });
  assert.equal(store.getState().library.items.length, 1);
  assert.equal(store.getState().library.items[0].name, 'renamed');

  store.dispatch({ type: 'library/upsert-track', track: { id: 't2' } });
  assert.equal(store.getState().library.items.length, 2);
});

test('project slot assignment', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({ type: 'project/assign-slot', slot: 'anchor', trackId: 'a1' });
  assert.equal(store.getState().currentProject.anchor_track_id, 'a1');
  assert.equal(store.getState().currentProject.lead_track_id, null);

  store.dispatch({ type: 'project/assign-slot', slot: 'lead', trackId: 'l1' });
  assert.equal(store.getState().currentProject.lead_track_id, 'l1');
  assert.equal(store.getState().currentProject.anchor_track_id, 'a1');
});

test('library source filter can be reset to all sources', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({ type: 'library/filter', source: 'youtube' });
  store.dispatch({ type: 'library/filter', source: null });

  assert.equal(store.getState().library.source, null);
});

test('playback actions do not leak the action type into state', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({ type: 'playback/set', trackId: 'track-1', playing: true });

  assert.equal(store.getState().playback.trackId, 'track-1');
  assert.equal(Object.hasOwn(store.getState().playback, 'type'), false);
});

test('ghostStatus accepts only plain semantic JSON', async () => {
  const { StateStore, registerReducers } = await loadState();
  const store = registerReducers(new StateStore());

  store.dispatch({
    type: 'v1/ghost-status/set',
    patch: { phase: 'armed', receipt: { launchBeat: 32, phraseIndex: 1 } },
  });
  assert.equal(store.getState().ghostStatus.phase, 'armed');

  class RuntimeHandle {}
  const before = store.getState().ghostStatus;
  store.dispatch({
    type: 'v1/ghost-status/set',
    patch: { receipt: { node: new RuntimeHandle() } },
  });
  assert.deepEqual(store.getState().ghostStatus, before);

  store.dispatch({ type: 'v1/ghost-status/set', patch: { geometry: { x: 1 } } });
  assert.deepEqual(store.getState().ghostStatus, before);
});
