// tests/frontend/project.test.js — Phase 5 project lifecycle & autosave tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function load() {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js');
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js');
  const store = registerReducers(new StateStore());
  return { store, manager: new ProjectManager(store) };
}

/** Install a fetch stub driven by a handler map: method+path-prefix -> fn. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    // Sort by specificity (longest prefix first) so '/api/projects/p2' wins
    // over '/api/projects'.
    const entries = Object.entries(routes).sort(
      (a, b) => b[0].split(' ')[1].length - a[0].split(' ')[1].length,
    );
    for (const [key, handler] of entries) {
      const [m, prefix] = key.split(' ');
      if (method === m && path.startsWith(prefix)) {
        return handler({ path, options, calls });
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return calls;
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

test('boot creates Untitled mix when no projects exist', async () => {
  const { store, manager } = await load();
  const created = {
    id: 'p1', name: 'Untitled mix', anchor_track_id: null, lead_track_id: null,
    anchor_variant: null, lead_variant: null, settings: {}, created_at: 1, updated_at: 1,
  };
  stubFetch({
    'GET /api/projects': () => jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }),
    'POST /api/projects': () => jsonResponse(created, 201),
  });
  await manager.boot();
  const state = store.getState();
  assert.equal(state.currentProject.id, 'p1');
  assert.equal(state.currentProject.name, 'Untitled mix');
  assert.equal(state.projects.total, 1);
});

test('boot loads the most recently updated project and resolves decks', async () => {
  const { store, manager } = await load();
  const track = { id: 't1', name: 'Track One', bpm: 100 };
  const project = {
    id: 'p1', name: 'Mix A', anchor_track_id: 't1', lead_track_id: 'missing-x',
    anchor_variant: 'full', lead_variant: 'full', settings: {}, created_at: 1, updated_at: 2,
  };
  stubFetch({
    'GET /api/projects': () => jsonResponse({ items: [project], total: 1, limit: 20, offset: 0 }),
    'GET /api/tracks/t1': () => jsonResponse(track),
    'GET /api/tracks/missing-x': () => jsonResponse({ error: { code: 'not_found', message: 'unknown track', detail: null } }, 404),
  });
  await manager.boot();
  const state = store.getState();
  assert.equal(state.currentProject.id, 'p1');
  // Deck track resolved by ID even though the library list is empty.
  assert.equal(state.deckTracks['t1'].name, 'Track One');
  // Missing selections become an explicit recoverable null — never substituted.
  assert.equal(state.deckTracks['missing-x'], null);
});

test('autosave debounces, coalesces fields, and persists via PATCH', async () => {
  const { store, manager } = await load();
  const project = {
    id: 'p1', name: 'Mix', anchor_track_id: null, lead_track_id: null,
    anchor_variant: null, lead_variant: null, settings: {}, created_at: 1, updated_at: 1,
  };
  const calls = stubFetch({
    'PATCH /api/projects/p1': ({ options }) => {
      const body = JSON.parse(options.body);
      return jsonResponse({ ...project, ...body, updated_at: Date.now() });
    },
  });
  store.dispatch({ type: 'project/set', project });

  manager.save({ anchor_track_id: 'a' });
  manager.save({ lead_track_id: 'l' });
  assert.equal(store.getState().save.status, 'saving');

  await manager.flushNow();
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { anchor_track_id: 'a', lead_track_id: 'l' });
  assert.equal(store.getState().save.status, 'saved');
});

test('failed saves keep local edits and expose a retryable error', async () => {
  const { store, manager } = await load();
  const project = {
    id: 'p1', name: 'Mix', anchor_track_id: null, lead_track_id: null,
    anchor_variant: null, lead_variant: null, settings: {}, created_at: 1, updated_at: 1,
  };
  let failures = 1;
  const calls = stubFetch({
    'PATCH /api/projects/p1': ({ options }) => {
      if (failures > 0) {
        failures -= 1;
        return jsonResponse({ error: { code: 'x', message: 'network down', detail: null } }, 500);
      }
      const body = JSON.parse(options.body);
      return jsonResponse({ ...project, ...body, updated_at: Date.now() });
    },
  });
  store.dispatch({ type: 'project/set', project });
  manager.save({ anchor_track_id: 'a' });
  await manager.flushNow();
  assert.equal(store.getState().save.status, 'error');
  assert.equal(store.getState().save.lastError, 'network down');

  await manager.retry();
  assert.equal(store.getState().save.status, 'saved');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
});

test('swap exchanges tracks, variants, cues, and gains in one save', async () => {
  const { store, manager } = await load();
  const project = {
    id: 'p1', name: 'Mix', anchor_track_id: 'a', lead_track_id: 'l',
    anchor_variant: 'full', lead_variant: 'vocals',
    settings: { anchor_start: 3, lead_start: 9, anchor_gain: 0.7, lead_gain: 1.2 },
    created_at: 1, updated_at: 1,
  };
  const calls = stubFetch({
    'PATCH /api/projects/p1': ({ options }) => {
      const body = JSON.parse(options.body);
      return jsonResponse({ ...project, ...body, updated_at: Date.now() });
    },
    'GET /api/tracks/a': () => jsonResponse({ id: 'a', name: 'A' }),
    'GET /api/tracks/l': () => jsonResponse({ id: 'l', name: 'L' }),
  });
  store.dispatch({ type: 'project/set', project });
  manager.swap();

  // Optimistic local swap happened immediately.
  let state = store.getState();
  assert.equal(state.currentProject.anchor_track_id, 'l');
  assert.equal(state.currentProject.lead_track_id, 'a');
  assert.equal(state.currentProject.anchor_variant, 'vocals');
  assert.equal(state.currentProject.lead_variant, 'full');

  await manager.flushNow();
  const patch = calls.filter((c) => c.method === 'PATCH').pop();
  assert.deepEqual(patch.body, {
    anchor_track_id: 'l',
    lead_track_id: 'a',
    anchor_variant: 'vocals',
    lead_variant: 'full',
    settings: { anchor_start: 9, lead_start: 3, anchor_gain: 1.2, lead_gain: 0.7 },
  });
});

test('clear removes one deck without disturbing the other', async () => {
  const { store, manager } = await load();
  const project = {
    id: 'p1', name: 'Mix', anchor_track_id: 'a', lead_track_id: 'l',
    anchor_variant: 'full', lead_variant: 'vocals',
    settings: {}, created_at: 1, updated_at: 1,
  };
  const calls = stubFetch({
    'PATCH /api/projects/p1': ({ options }) => {
      const body = JSON.parse(options.body);
      return jsonResponse({ ...project, ...body, updated_at: Date.now() });
    },
  });
  store.dispatch({ type: 'project/set', project });
  manager.clear('lead');
  assert.equal(store.getState().currentProject.lead_track_id, null);
  await manager.flushNow();
  const patch = calls.filter((c) => c.method === 'PATCH').pop();
  assert.deepEqual(patch.body, { lead_track_id: null, lead_variant: null });
  assert.equal(store.getState().currentProject.anchor_track_id, 'a');
});

test('server response is authoritative after a successful save', async () => {
  const { store, manager } = await load();
  const project = {
    id: 'p1', name: 'Old', anchor_track_id: null, lead_track_id: null,
    anchor_variant: null, lead_variant: null, settings: {}, created_at: 1, updated_at: 1,
  };
  stubFetch({
    'PATCH /api/projects/p1': ({ options }) => {
      const body = JSON.parse(options.body);
      return jsonResponse({ ...project, ...body, updated_at: 42 });
    },
  });
  store.dispatch({ type: 'project/set', project });
  manager.rename('New name');
  assert.equal(store.getState().currentProject.name, 'New name'); // optimistic
  await manager.flushNow();
  const saved = store.getState().currentProject;
  assert.equal(saved.name, 'New name');
  assert.equal(saved.updated_at, 42); // server-authored timestamp applied
});

test('state remains serializable (no timers/requests/abort controllers)', async () => {
  const { store, manager } = await load();
  stubFetch({
    'GET /api/projects': () => jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }),
    'POST /api/projects': () => jsonResponse({
      id: 'p1', name: 'Untitled mix', anchor_track_id: null, lead_track_id: null,
      anchor_variant: null, lead_variant: null, settings: {}, created_at: 1, updated_at: 1,
    }, 201),
  });
  await manager.boot();
  // structuredClone throws on functions/nodes/requests; getState() uses it.
  const snapshot = store.getState();
  assert.equal(snapshot.currentProject.id, 'p1');
});

test('switchTo and newProject swap projects cleanly', async () => {
  const { store, manager } = await load();
  const p1 = {
    id: 'p1', name: 'First', anchor_track_id: null, lead_track_id: null,
    anchor_variant: null, lead_variant: null, settings: {}, created_at: 1, updated_at: 2,
  };
  const p2 = { ...p1, id: 'p2', name: 'Second', updated_at: 1 };
  stubFetch({
    'GET /api/projects': () => jsonResponse({ items: [p1, p2], total: 2, limit: 20, offset: 0 }),
    'GET /api/projects/p2': () => jsonResponse(p2),
    'POST /api/projects': () => jsonResponse({ ...p1, id: 'p3', name: 'Untitled mix' }, 201),
  });
  await manager.boot();
  assert.equal(store.getState().currentProject.id, 'p1');

  await manager.switchTo('p2');
  assert.equal(store.getState().currentProject.id, 'p2');

  await manager.newProject();
  assert.equal(store.getState().currentProject.id, 'p3');
  assert.equal(store.getState().currentProject.anchor_track_id, null);
});
