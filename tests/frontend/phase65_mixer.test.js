// Phase 6.5 frontend tests: strict RenderBody mixer fields, new-mix
// allowlisting, plan-request parity, and stale-plan gating on mixer changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(async () => {
  const api = await import('../../src/twobecomeone/studio_static/js/api.js');
  api.closeAllMonitors();
  teardownDom(dom);
});

async function makeStore() {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  return registerReducers(new StateStore());
}

function project(settings = {}) {
  return {
    id: 'project-1',
    name: 'Mixer test',
    anchor_track_id: 'anchor-1',
    lead_track_id: 'lead-1',
    anchor_variant: 'full',
    lead_variant: 'vocals',
    settings: {
      anchor_start: 1.25,
      lead_start: 2.5,
      duration: 30,
      anchor_gain: 0.75,
      lead_gain: 0.9,
      snap: true,
      pitch_mode: 'preserve',
      tempo_mode: 'custom',
      target_bpm: 128,
      arrangement_mode: 'transition',
      transition_start: 3,
      crossfade_duration: 2,
      crossfade_curve: 'linear',
      anchor_pan: -0.5,
      lead_pan: 0.5,
      anchor_eq: { low: 1.5, mid: 0, high: -1 },
      lead_eq: { low: 0, mid: 2, high: -3 },
      ...settings,
    },
    hostile_ui_only: '<img src=x onerror=alert(1)>',
  };
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

test('RenderBody carries every new mixer field and drops UI-only junk', async () => {
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const body = buildRenderBody(project(), { preview: false });
  assert.equal(body.tempo_mode, 'custom');
  assert.equal(body.target_bpm, 128);
  assert.equal(body.arrangement_mode, 'transition');
  assert.equal(body.transition_start, 3);
  assert.equal(body.crossfade_duration, 2);
  assert.equal(body.crossfade_curve, 'linear');
  assert.equal(body.anchor_pan, -0.5);
  assert.equal(body.lead_pan, 0.5);
  assert.deepEqual(body.anchor_eq, { low: 1.5, mid: 0, high: -1 });
  assert.deepEqual(body.lead_eq, { low: 0, mid: 2, high: -3 });
  assert.equal(Object.hasOwn(body, 'snap'), false);
  assert.equal(Object.hasOwn(body, 'hostile_ui_only'), false);
});

test('RenderBody defaults to foundation/overlay and omits target when not custom', async () => {
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const base = project({ tempo_mode: 'foundation', target_bpm: null });
  const body = buildRenderBody(base, { preview: false });
  assert.equal(body.tempo_mode, 'foundation');
  assert.equal(body.target_bpm, null);
  assert.equal(body.arrangement_mode, 'transition'); // arrangement is independent
});

test('RenderBody rejects malformed EQ and out-of-range mixer values', async () => {
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  assert.throws(
    () => buildRenderBody(project({ anchor_eq: { low: 99, mid: 0, high: 0 } })),
    /EQ/,
  );
  assert.throws(
    () => buildRenderBody(project({ anchor_eq: { low: 0 } })),
    /EQ/,
  );
  assert.throws(
    () => buildRenderBody(project({ anchor_eq: { low: 0, mid: 0, high: 0, x: 1 } })),
    /EQ/,
  );
  assert.throws(
    () => buildRenderBody(project({ lead_pan: true })),
    /Lead pan/,
  );
  assert.throws(
    () => buildRenderBody(project({ transition_start: '3' })),
    /Transition start/,
  );
  assert.throws(
    () => buildRenderBody(project({ target_bpm: 500 })),
    /Target BPM/,
  );
  assert.throws(
    () => buildRenderBody(project({ crossfade_duration: 31 })),
    /Crossfade duration/,
  );
  assert.throws(
    () => buildRenderBody(project({ lead_pan: 5 })),
    /Lead pan/,
  );
  assert.throws(
    () => buildRenderBody(project({ arrangement_mode: 'solo' })),
    /arrangement mode/,
  );
});

test('newProjectFromRender copies every new allowlisted field and rejects malformed history', async () => {
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js'
  );
  const store = await makeStore();
  let created = null;
  let patched = null;
  const manager = new ProjectManager(store);
  manager.flushNow = async () => true;
  globalThis.fetch = async (path, opts) => {
    const url = String(path);
    if (url === '/api/projects' && (!opts || opts.method !== 'PATCH')) {
      const body = JSON.parse(opts?.body || '{}');
      created = { id: 'new-mix', name: body.name || 'New mix', settings: {} };
      return jsonResponse(created, 201);
    }
    if (url.includes('/api/tracks/')) {
      const id = url.split('/')[3];
      return jsonResponse({ id, name: 'Track', status: 'active', bpm: 120 });
    }
    if (url === '/api/projects/new-mix') {
      patched = JSON.parse(opts.body);
      return jsonResponse({ ...created, ...patched });
    }
    return jsonResponse([]);
  };

  const request = {
    anchor_id: 'anchor-1', lead_id: 'lead-1',
    anchor_variant: 'full', lead_variant: 'vocals',
    anchor_start: 1.25, lead_start: 2.5, duration: 30,
    anchor_gain: 0.75, lead_gain: 0.9,
    pitch_mode: 'preserve',
    tempo_mode: 'custom', target_bpm: 128,
    arrangement_mode: 'transition', transition_start: 3,
    crossfade_duration: 2, crossfade_curve: 'linear',
    anchor_pan: -0.5, lead_pan: 0.5,
    anchor_eq: { low: 1.5, mid: 0, high: -1 },
    lead_eq: { low: 0, mid: 2, high: -3 },
    result_display_name: 'Not copied',
    source_names: { anchor: 'Foundation', lead: 'Lead' },
  };
  const saved = await manager.newProjectFromRender(request);
  assert.ok(saved);
  assert.equal(patched.settings.tempo_mode, 'custom');
  assert.equal(patched.settings.target_bpm, 128);
  assert.equal(patched.settings.arrangement_mode, 'transition');
  assert.equal(patched.settings.crossfade_curve, 'linear');
  assert.equal(patched.settings.anchor_pan, -0.5);
  assert.deepEqual(patched.settings.lead_eq, { low: 0, mid: 2, high: -3 });
  assert.equal(Object.hasOwn(patched.settings, 'result_display_name'), false);

  // Malformed history (invalid tempo mode) must be rejected before mutating.
  await assert.rejects(
    manager.newProjectFromRender({ ...request, tempo_mode: 'solo' }),
    /output BPM mode is invalid/i,
  );
});

test('plan request matches project deep-equal even with fresh EQ objects', async () => {
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { planMatchesProject } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const cp = project();
  const { preview: _preview, ...request } = buildRenderBody(cp);
  // Simulate a plan request whose EQ blobs are fresh object references.
  const requestCopy = {
    ...request,
    anchor_eq: { ...request.anchor_eq },
    lead_eq: { ...request.lead_eq },
  };
  assert.equal(
    planMatchesProject({ data: {}, loading: false, error: null, request: requestCopy }, cp),
    true,
  );
  // A changed mixer value must make the plan stale.
  const changed = { ...requestCopy, crossfade_duration: 4 };
  assert.equal(
    planMatchesProject({ data: {}, loading: false, error: null, request: changed }, cp),
    false,
  );
});

test('stale plan disables actions on any mixer change in the same turn', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  const cp = project();
  store.dispatch({ type: 'project/set', project: cp });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(cp);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  const container = document.createElement('div');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track() {} },
  });
  assert.equal(
    [...container.querySelectorAll('button')].every((b) => !b.disabled),
    true,
    'actions enabled when plan matches',
  );

  // Change a mixer field locally -> plan becomes stale synchronously.
  store.dispatch({
    type: 'project/set',
    project: { ...cp, settings: { ...cp.settings, crossfade_duration: 6 } },
  });
  assert.equal(
    [...container.querySelectorAll('button')].every((b) => b.disabled),
    true,
    'actions lock in the same turn as the mixer change',
  );
  dispose();
});
