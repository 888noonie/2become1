// Phase 6 slice A: render bodies, save gating, monitoring, and compact results.

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
    name: 'Saved project',
    anchor_track_id: 'anchor-1',
    lead_track_id: 'lead-1',
    anchor_variant: 'center',
    lead_variant: 'vocals',
    settings: {
      anchor_start: 1.25,
      lead_start: 2.5,
      duration: 30,
      anchor_gain: 0.75,
      lead_gain: 0.9,
      snap: true,
      pitch_mode: 'preserve',
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

test('RenderBody is an exact backend allowlist and Preview 12s never exceeds twelve', async () => {
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const full = buildRenderBody(project(), { preview: false });
  assert.deepEqual(full, {
    anchor_id: 'anchor-1',
    lead_id: 'lead-1',
    anchor_start: 1.25,
    lead_start: 2.5,
    duration: 30,
    anchor_gain: 0.75,
    lead_gain: 0.9,
    preview: false,
    anchor_variant: 'center',
    lead_variant: 'vocals',
    pitch_mode: 'preserve',
    tempo_mode: 'foundation',
    target_bpm: null,
    arrangement_mode: 'overlay',
    transition_start: 0,
    crossfade_duration: 0,
    crossfade_curve: 'equal_power',
    anchor_pan: 0,
    lead_pan: 0,
    anchor_eq: { low: 0, mid: 0, high: 0 },
    lead_eq: { low: 0, mid: 0, high: 0 },
  });
  assert.equal(Object.hasOwn(full, 'snap'), false);
  assert.equal(Object.hasOwn(full, 'hostile_ui_only'), false);

  assert.equal(buildRenderBody(project(), { preview: true }).duration, 12);
  assert.equal(buildRenderBody(project({ duration: 5 }), { preview: true }).duration, 5);
  assert.equal(buildRenderBody(project({ duration: null }), { preview: true }).duration, 12);
  assert.equal(buildRenderBody(project({ duration: null }), { preview: false }).duration, null);
});

test('canonical submitRender helper posts only to /api/renders', async () => {
  const { submitRender } = await import(
    '../../src/twobecomeone/studio_static/js/api.js'
  );
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    return jsonResponse({ id: 'render-1', kind: 'render', status: 'queued' }, 202);
  };
  const body = { anchor_id: 'a', lead_id: 'l', preview: false };
  const job = await submitRender(body);
  assert.equal(job.id, 'render-1');
  assert.deepEqual(calls, [{ path: '/api/renders', method: 'POST', body }]);
});

test('submission flushes save first, then posts and tracks the queued job', async () => {
  const { submitCurrentRender } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { JobCoordinator } = await import(
    '../../src/twobecomeone/studio_static/js/job-coordinator.js'
  );
  const store = await makeStore();
  store.dispatch({ type: 'project/set', project: project() });
  const order = [];
  const projectManager = {
    async flushNow() {
      order.push('flush');
      store.dispatch({ type: 'save/status', status: 'saved', pending: [], lastError: null });
      return true;
    },
  };
  globalThis.fetch = async (path, options) => {
    order.push('submit');
    assert.equal(path, '/api/renders');
    assert.equal(JSON.parse(options.body).duration, 12);
    return jsonResponse({ id: 'preview-1', kind: 'preview', status: 'queued' }, 202);
  };
  const watched = [];
  const coordinator = new JobCoordinator(store, (jobId) => {
    watched.push(jobId);
    return () => {};
  });
  const job = await submitCurrentRender({
    store,
    projectManager,
    jobCoordinator: coordinator,
    preview: true,
  });
  assert.deepEqual(order, ['flush', 'submit']);
  assert.equal(job.id, 'preview-1');
  assert.equal(store.getState().jobs.items[0].id, 'preview-1');
  assert.equal(store.getState().jobs.activeCount, 1);
  assert.deepEqual(watched, ['preview-1']);
  coordinator.dispose();
});

test('submission refuses after an unresolved autosave error', async () => {
  const { submitCurrentRender } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const store = await makeStore();
  store.dispatch({ type: 'project/set', project: project() });
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return jsonResponse({}); };
  const projectManager = {
    async flushNow() {
      store.dispatch({
        type: 'save/status', status: 'error', pending: ['settings'],
        lastError: 'Settings are still offline',
      });
      return false;
    },
  };
  await assert.rejects(
    submitCurrentRender({
      store, projectManager, jobCoordinator: { track() {} }, preview: false,
    }),
    /Settings are still offline/,
  );
  assert.equal(fetched, false);
});

test('ProjectManager clears retry state after flushNow recovers a failed save', async () => {
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js'
  );
  const store = await makeStore();
  const base = project();
  store.dispatch({ type: 'project/set', project: base });
  let attempts = 0;
  globalThis.fetch = async (_path, options) => {
    attempts += 1;
    if (attempts === 1) {
      return jsonResponse({ error: { message: 'offline' } }, 500);
    }
    return jsonResponse({ ...base, ...JSON.parse(options.body), updated_at: attempts });
  };
  const manager = new ProjectManager(store);
  manager.save({ name: 'Recovered' });
  assert.equal(await manager.flushNow(), false);
  assert.equal(store.getState().save.status, 'error');
  assert.equal(await manager.flushNow(), true);
  assert.equal(store.getState().save.status, 'saved');

  manager.save({ name: 'Still healthy' });
  assert.equal(await manager.flushNow(), true);
  assert.equal(store.getState().currentProject.name, 'Still healthy');
  assert.equal(attempts, 3);
});

test('global coordinator restores active jobs, survives routes, and tears down once', async () => {
  const { JobCoordinator } = await import(
    '../../src/twobecomeone/studio_static/js/job-coordinator.js'
  );
  const store = await makeStore();
  store.dispatch({
    type: 'jobs/set',
    items: [{ id: 'restored-1', kind: 'render', status: 'running', created_at: 1 }],
    total: 1,
    activeCount: 1,
  });
  const subscriptions = [];
  const closed = [];
  const coordinator = new JobCoordinator(store, (jobId, callback) => {
    subscriptions.push({ jobId, callback });
    return () => closed.push(jobId);
  });
  coordinator.start();
  coordinator.start();
  coordinator.restore(store.getState().jobs.items);
  store.dispatch({ type: 'route/set', route: 'library' });
  store.dispatch({ type: 'route/set', route: 'studio' });
  assert.equal(subscriptions.length, 1, 'one monitor across start/restore/route changes');

  subscriptions[0].callback({
    id: 'restored-1', kind: 'render', status: 'complete', created_at: 1,
    result: { display_name: 'Restored full' },
  });
  assert.equal(store.getState().jobs.latestRender.result.display_name, 'Restored full');
  assert.deepEqual(closed, ['restored-1'], 'terminal state closes the coordinator subscription');
  coordinator.dispose();
  assert.deepEqual(closed, ['restored-1'], 'teardown does not double-close a terminal monitor');
});

test('coordinator and a view share one EventSource for the same active job', async () => {
  const api = await import('../../src/twobecomeone/studio_static/js/api.js');
  const { JobCoordinator } = await import(
    '../../src/twobecomeone/studio_static/js/job-coordinator.js'
  );
  const store = await makeStore();
  store.dispatch({
    type: 'jobs/set',
    items: [{ id: 'shared-1', kind: 'preview', status: 'queued' }],
    total: 1,
    activeCount: 1,
  });
  const coordinator = new JobCoordinator(store);
  coordinator.start();
  const disposeView = api.watchJob('shared-1', () => {});
  assert.equal(globalThis.EventSource.instances.length, 1);
  disposeView();
  assert.equal(globalThis.EventSource.instances[0].closed, undefined);
  coordinator.dispose();
  assert.equal(globalThis.EventSource.instances[0].closed, true);
});

test('latest preview and full render stay distinct across later iterations', async () => {
  const store = await makeStore();
  const full = {
    id: 'full-1', kind: 'render', status: 'complete', created_at: 10,
    result: { display_name: 'Full one' },
  };
  const preview = {
    id: 'preview-1', kind: 'preview', status: 'complete', created_at: 20,
    result: { display_name: 'Preview one' },
  };
  store.dispatch({ type: 'jobs/set', items: [preview, full], total: 2, activeCount: 0 });
  store.dispatch({
    type: 'jobs/upsert',
    job: {
      id: 'preview-2', kind: 'preview', status: 'complete', created_at: 30,
      result: { display_name: 'Preview two' },
    },
  });
  const jobs = store.getState().jobs;
  assert.equal(jobs.latestPreview.id, 'preview-2');
  assert.equal(jobs.latestRender.id, 'full-1');
});

test('sticky actions require a plan and render hostile result names literally', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  store.dispatch({
    type: 'jobs/set',
    items: [
      {
        id: 'p', kind: 'preview', status: 'complete', created_at: 2,
        result: { display_name: '<img src=x onerror=alert(1)> Preview', duration: 12 },
      },
      {
        id: 'r', kind: 'render', status: 'complete', created_at: 1,
        result: { display_name: '<script>alert(1)</script> Full', duration: 90 },
      },
    ],
    total: 2,
    activeCount: 0,
  });
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container,
    store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track() {} },
  });
  const buttons = [...container.querySelectorAll('button')];
  const primary = buttons.filter((b) => ['Preview 12s', 'Render full mix'].includes(b.textContent));
  assert.deepEqual(primary.map((button) => button.textContent), ['Preview 12s', 'Render full mix']);
  assert.equal(primary.every((button) => !button.disabled), true);
  assert.equal(container.querySelector('img'), null);
  assert.equal(container.querySelector('script'), null);
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)> Preview/);
  assert.match(container.textContent, /<script>alert\(1\)<\/script> Full/);

  store.dispatch({ type: 'plan/set', loading: true, data: null, error: null });
  const submitButtons = [...container.querySelectorAll('button')].filter(
    (b) => ['Preview 12s', 'Render full mix'].includes(b.textContent),
  );
  assert.equal(submitButtons.every((button) => button.disabled), true);
  dispose();
});

test('plan matching is deep, property-order independent, and exact', async () => {
  const { planMatchesProject } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const currentProject = project();
  const { preview: _preview, ...request } = buildRenderBody(currentProject);
  const reversed = Object.fromEntries(Object.entries(request).reverse());

  assert.equal(planMatchesProject({ data: {}, loading: false, error: null, request: reversed }, currentProject), true);
  assert.equal(planMatchesProject({ data: {}, loading: false, error: null, request: { ...reversed, duration: 31 } }, currentProject), false);
  assert.equal(planMatchesProject({ data: {}, loading: false, error: null, request: { ...reversed, extra: true } }, currentProject), false);
});

test('project setting changes disable actions immediately until a current plan returns', async () => {
  const { mountPlan } = await import(
    '../../src/twobecomeone/studio_static/js/components/plan.js'
  );
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  store.dispatch({ type: 'project/set', project: project() });
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/renders/plan');
    return jsonResponse({
      tempo_ratio: 1,
      bpm_change_percent: 0,
      semitone_shift: 0,
      pitch_mode: 'preserve',
      anchor_variant: 'center',
      lead_variant: 'vocals',
      duration: { output: 30 },
      warnings: [],
    });
  };
  const planContainer = document.createElement('div');
  const actionContainer = document.createElement('div');
  const manager = { save() {}, flushNow: async () => true };
  const disposePlan = mountPlan({ container: planContainer, store, projectManager: manager });
  const disposeActions = mountRenderActions({
    container: actionContainer, store, projectManager: manager,
    jobCoordinator: { track() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    [...actionContainer.querySelectorAll('button')].every((button) => !button.disabled),
    true,
  );

  const changed = {
    ...store.getState().currentProject,
    settings: { ...store.getState().currentProject.settings, duration: 45 },
  };
  store.dispatch({ type: 'project/set', project: changed });
  assert.equal(store.getState().plan.loading, true);
  assert.equal(store.getState().plan.data, null);
  assert.equal(
    [...actionContainer.querySelectorAll('button')].every((button) => button.disabled),
    true,
    'buttons lock in the same turn as the arrangement change',
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(store.getState().plan.request.duration, 45);
  assert.equal(
    [...actionContainer.querySelectorAll('button')].every((button) => !button.disabled),
    true,
  );
  disposeActions();
  disposePlan();
});

test('active render exposes accessible cancel and tracks the returned snapshot', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  store.dispatch({
    type: 'jobs/set',
    items: [{ id: 'active-render', kind: 'render', status: 'running', created_at: 1 }],
    total: 1,
    activeCount: 1,
  });
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method });
    return jsonResponse({
      id: 'active-render', kind: 'render', status: 'running',
      cancel_requested: true, created_at: 1,
    });
  };
  const tracked = [];
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track: (job) => tracked.push(job) },
  });
  const cancel = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Cancel full render',
  );
  assert.ok(cancel);
  assert.equal(cancel.getAttribute('aria-label'), 'Cancel full render');
  cancel.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{
    path: '/api/jobs/active-render/cancel', method: 'POST',
  }]);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].cancel_requested, true);
  assert.match(container.textContent, /Cancellation requested/);

  globalThis.fetch = async () => jsonResponse({
    error: { code: 'conflict', message: 'Engine already stopped', detail: null },
  }, 409);
  const cancelAgain = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Cancel full render',
  );
  cancelAgain.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(container.textContent, /Could not cancel: Engine already stopped/);
  dispose();
});

test('sticky status reports every render lifecycle terminal honestly', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track() {} },
  });
  for (const status of ['queued', 'running', 'cancelled', 'interrupted', 'failed', 'complete']) {
    store.dispatch({
      type: 'jobs/set',
      items: [{ id: status, kind: 'preview', status, created_at: 1 }],
      total: 1,
      activeCount: ['queued', 'running'].includes(status) ? 1 : 0,
    });
    assert.match(container.querySelector('[role="status"]').textContent.toLowerCase(), new RegExp(status));
  }
  dispose();
});

// ---------------------------------------------------------------------------
// Phase 6 slice B: playback, download, rename, retry/resume, new-mix, detail.
// ---------------------------------------------------------------------------

function completedJob(overrides = {}) {
  return {
    id: 'render-1',
    kind: 'render',
    status: 'complete',
    created_at: 1,
    audio_url: '/api/jobs/render-1/audio',
    download_url: '/api/jobs/render-1/audio?download=true',
    download_name: 'safe-name.mp3',
    request: {
      anchor_id: 'anchor-1',
      lead_id: 'lead-1',
      anchor_start: 1.25,
      lead_start: 2.5,
      duration: 30,
      anchor_gain: 0.75,
      lead_gain: 0.9,
      anchor_variant: 'center',
      lead_variant: 'vocals',
      pitch_mode: 'preserve',
      source_names: { anchor: 'Foundation Track', lead: 'Lead Track' },
    },
    result: {
      display_name: 'My Mashup',
      duration: 30,
      tempo_ratio: 1.5,
      semitone_shift: 2,
      true_peak_db: -1.2,
    },
    recovery: { can_retry: false, action: null },
    ...overrides,
  };
}

test('completed result exposes Play/Stop, Download, Rename, and new-mix actions', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  store.dispatch({
    type: 'jobs/set',
    items: [completedJob()],
    total: 1,
    activeCount: 0,
  });
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true, newProjectFromRender: async () => ({}) },
    jobCoordinator: { track() {} },
  });
  const text = container.textContent;
  assert.ok(text.includes('My Mashup'), 'shows durable display name');
  assert.ok(text.includes('Foundation Track'), 'shows Foundation source name');
  assert.ok(text.includes('Lead Track'), 'shows Lead source name');
  assert.ok(text.includes('Play'), 'Play action present');
  assert.ok(text.includes('Download'), 'Download action present');
  assert.ok(text.includes('Rename'), 'Rename action present');
  assert.ok(text.includes('Use these settings in a new mix'), 'new-mix action present');
  assert.ok(text.includes('1.5x'), 'tempo ratio shown');
  assert.ok(text.includes('+2'), 'semitone shift shown');
  assert.ok(text.includes('-1.2 dBFS'), 'true peak shown');
  assert.equal(container.querySelector('a[download]').getAttribute('href'), '/api/jobs/render-1/audio?download=true');
  assert.equal(container.querySelector('a[download]').getAttribute('download'), 'safe-name.mp3');
  dispose();
});

test('Play/Stop for a result routes through the singleton AudioController', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const { audioController } = await import(
    '../../src/twobecomeone/studio_static/js/audio.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  store.dispatch({
    type: 'jobs/set',
    items: [completedJob()],
    total: 1,
    activeCount: 0,
  });
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track() {} },
  });

  const playBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Play');
  playBtn.click();
  assert.equal(audioController.current.jobId, 'render-1');
  assert.equal(audioController.current.kind, 'render');
  assert.equal(audioController.current.url, '/api/jobs/render-1/audio');
  assert.equal(audioController.current.title, 'My Mashup');

  // The UI is reactive to the controller: Play becomes Stop.
  assert.ok([...container.querySelectorAll('button')].some((b) => b.textContent === 'Stop'));

  // Starting a track stops the render (singleton).
  audioController.play('track-A', '/api/tracks/A/audio');
  assert.equal(audioController.current.trackId, 'track-A');
  assert.equal(audioController.current.jobId, null);
  assert.ok([...container.querySelectorAll('button')].some((b) => b.textContent === 'Play'));

  audioController.stop();
  dispose();
});

test('rename uses the native dialog and updates job state from the response', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  store.dispatch({
    type: 'jobs/set',
    items: [completedJob()],
    total: 1,
    activeCount: 0,
  });
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    return jsonResponse(completedJob({
      result: { ...completedJob().result, display_name: 'Renamed Mix' },
    }));
  };
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track() {} },
  });

  const renameBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Rename');
  renameBtn.click();
  const dialog = document.querySelector('dialog');
  assert.ok(dialog, 'native dialog opened');
  const input = dialog.querySelector('input');
  input.value = 'Renamed Mix';
  const saveBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Rename');
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(calls, [{ path: '/api/renders/render-1', method: 'PATCH', body: { display_name: 'Renamed Mix' } }]);
  assert.equal(store.getState().jobs.latestRender.result.display_name, 'Renamed Mix');
  assert.ok(container.textContent.includes('Renamed Mix'));
  dispose();
});

test('Escape closes rename dialog, clears its draft, and permits a fresh reopen', async () => {
  const { renderResultActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-result.js'
  );
  const store = await makeStore();
  const actions = renderResultActions({
    job: completedJob(), store,
    projectManager: { newProjectFromRender: async () => ({}) },
    jobCoordinator: { track() {} },
  });
  document.getElementById('main').appendChild(actions);
  const rename = [...actions.querySelectorAll('button')].find((button) => button.textContent === 'Rename');

  rename.click();
  let dialog = document.querySelector('dialog');
  dialog.querySelector('input').value = 'Unsaved draft';
  dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.querySelector('dialog'), null, 'Escape cleans up the closed dialog');

  rename.click();
  dialog = document.querySelector('dialog');
  assert.equal(dialog.querySelector('input').value, 'My Mashup', 'reopen starts from persisted state');
  dialog.close('cancel');
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('render actions release their AudioController subscription on teardown', async () => {
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const { audioController } = await import(
    '../../src/twobecomeone/studio_static/js/audio.js'
  );
  const store = await makeStore();
  const before = audioController._listeners.size;
  const dispose = mountRenderActions({
    container: document.getElementById('main'), store,
    projectManager: {}, jobCoordinator: { track() {} },
  });
  assert.equal(audioController._listeners.size, before + 1);
  dispose();
  assert.equal(audioController._listeners.size, before);
});

test('retry vs resume: Resume only when recovery.action === resume', async () => {
  const { renderResultActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-result.js'
  );
  const store = await makeStore();

  const retryJob = completedJob({
    id: 'failed-render', status: 'failed',
    audio_url: null, download_url: null, download_name: null,
    recovery: { can_retry: true, action: 'retry' },
  });
  const resumeJob = completedJob({
    id: 'interrupted-import', kind: 'import', status: 'interrupted',
    audio_url: null, download_url: null, download_name: null,
    recovery: { can_retry: true, action: 'resume' },
  });

  const retryEl = renderResultActions({ job: retryJob, store, projectManager: {}, jobCoordinator: {} });
  assert.ok(retryEl.textContent.includes('Retry'));
  assert.ok(!retryEl.textContent.includes('Resume'));

  const resumeEl = renderResultActions({ job: resumeJob, store, projectManager: {}, jobCoordinator: {} });
  assert.ok(resumeEl.textContent.includes('Resume'));
  assert.ok(!resumeEl.textContent.includes('Retry'));
});

test('retry upserts and monitors the cloned job returned by the server', async () => {
  const { renderResultActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-result.js'
  );
  const store = await makeStore();
  const failed = completedJob({
    id: 'failed-render', status: 'failed',
    audio_url: null, download_url: null, download_name: null,
    recovery: { can_retry: true, action: 'retry' },
  });
  const cloned = { id: 'cloned-1', kind: 'render', status: 'queued', created_at: 2 };
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/jobs/failed-render/retry');
    assert.equal(options.method, 'POST');
    return jsonResponse(cloned, 202);
  };
  const tracked = [];
  const el = renderResultActions({
    job: failed, store,
    projectManager: {},
    jobCoordinator: { track: (job) => tracked.push(job) },
  });
  const retryBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
  retryBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(tracked, [cloned]);
  assert.equal(store.getState().jobs.items.some((j) => j.id === 'cloned-1'), true);
});

test('Use these settings in a new mix copies only validated fields and reverts on failure', async () => {
  const { renderResultActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-result.js'
  );
  const store = await makeStore();
  const job = completedJob();
  let captured = null;
  let fail = false;
  const projectManager = {
    async newProjectFromRender(request) {
      if (fail) throw new Error('Track is missing');
      captured = request;
      return { id: 'new-project' };
    },
  };
  const el = renderResultActions({ job, store, projectManager, jobCoordinator: {} });
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Use these settings'));
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(captured, 'new-mix invoked with the request');
  assert.equal(captured.anchor_id, 'anchor-1');
  assert.equal(captured.lead_id, 'lead-1');
  assert.equal(captured.anchor_variant, 'center');
  assert.equal(captured.lead_variant, 'vocals');
  assert.equal(captured.pitch_mode, 'preserve');
  assert.equal(captured.duration, 30);
  assert.equal(btn.disabled, false, 'loading state reverts after success');

  // Failure path: loading state must revert and the error surface.
  fail = true;
  btn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(btn.disabled, false, 'loading state reverts after failure');
  assert.equal(btn.textContent.includes('Use these settings'), true, 'label restored');
});

test('ProjectManager.newProjectFromRender allowlists fields and resolves decks', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js'
  );
  const store = registerReducers(new StateStore());
  const calls = [];
  globalThis.fetch = async (path, options) => {
    const method = options.method || 'GET';
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'POST' && path === '/api/projects') {
      return jsonResponse({ id: 'np', name: 'New', anchor_track_id: null, lead_track_id: null, settings: {}, updated_at: 1 }, 201);
    }
    if (method === 'PATCH' && path === '/api/projects/np') {
      return jsonResponse({ id: 'np', name: 'New', ...JSON.parse(options.body), updated_at: 2 });
    }
    if (method === 'GET' && path === '/api/projects') {
      return jsonResponse({ items: [{ id: 'np', name: 'New', updated_at: 2 }], total: 1 });
    }
    if (method === 'GET' && path.startsWith('/api/tracks/')) {
      const id = path.split('/')[3];
      return jsonResponse({ id, name: `Track ${id}`, duration: 60 });
    }
    return jsonResponse({});
  };
  const pm = new ProjectManager(store);
  const request = {
    anchor_id: 'a1',
    lead_id: 'l1',
    anchor_start: 1,
    lead_start: 2,
    duration: 30,
    anchor_gain: 0.7,
    lead_gain: 0.8,
    anchor_variant: 'center',
    lead_variant: 'vocals',
    pitch_mode: 'preserve',
    preview: true,
    snap: true,
    result_display_name: 'ignored',
    source_names: { anchor: 'A', lead: 'L' },
  };
  const saved = await pm.newProjectFromRender(request);
  assert.equal(saved.anchor_track_id, 'a1');
  assert.equal(saved.lead_track_id, 'l1');
  assert.equal(saved.anchor_variant, 'center');
  assert.equal(saved.lead_variant, 'vocals');
  assert.equal(saved.settings.duration, 30);
  assert.equal(saved.settings.pitch_mode, 'preserve');
  assert.equal(Object.hasOwn(saved.settings, 'snap'), false, 'snap not copied');
  assert.equal(Object.hasOwn(saved.settings, 'preview'), false, 'preview not copied');
  // Both decks resolved.
  assert.equal(store.getState().deckTracks.a1.name, 'Track a1');
  assert.equal(store.getState().deckTracks.l1.name, 'Track l1');
});

test('ProjectManager.newProjectFromRender surfaces missing/trashed-track failures', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js'
  );
  const store = registerReducers(new StateStore());
  globalThis.fetch = async (path, options) => {
    const method = options.method || 'GET';
    if (method === 'POST' && path === '/api/projects') {
      return jsonResponse({ id: 'np', name: 'New', settings: {}, updated_at: 1 }, 201);
    }
    if (method === 'PATCH' && path === '/api/projects/np') {
      return jsonResponse({ id: 'np', name: 'New', ...JSON.parse(options.body), updated_at: 2 });
    }
    if (method === 'GET' && path === '/api/projects') {
      return jsonResponse({ items: [], total: 0 });
    }
    if (method === 'GET' && path.startsWith('/api/tracks/')) {
      return jsonResponse({ error: { code: 'not_found', message: 'Track is trashed', detail: null } }, 404);
    }
    return jsonResponse({});
  };
  const pm = new ProjectManager(store);
  await assert.rejects(
    pm.newProjectFromRender({ anchor_id: 'a1', lead_id: 'l1', anchor_variant: 'full', lead_variant: 'full' }),
    /missing or trashed/,
  );
});

test('ProjectManager rejects malformed historic render data before creating or mutating state', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  const { ProjectManager } = await import(
    '../../src/twobecomeone/studio_static/js/project.js'
  );
  const store = registerReducers(new StateStore());
  const original = project();
  store.dispatch({ type: 'project/set', project: original });
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    return jsonResponse({});
  };

  const pm = new ProjectManager(store);
  await assert.rejects(
    pm.newProjectFromRender({
      anchor_id: 'a1', lead_id: 'l1', duration: 'not-a-number',
      anchor_variant: 'full', lead_variant: 'full',
    }),
    /Duration is invalid/,
  );
  assert.deepEqual(calls, [], 'invalid history never reaches a project or track endpoint');
  assert.deepEqual(store.getState().currentProject, original, 'live project remains untouched');
});

test('Activity detail renders hostile content literally and expandable request/result/error', async () => {
  const { mountActivity } = await import(
    '../../src/twobecomeone/studio_static/js/views/activity.js'
  );
  const store = await makeStore();
  const hostile = completedJob({
    id: 'hostile',
    result: {
      display_name: '<img src=x onerror=alert(1)> Hostile',
      duration: 30,
    },
    request: {
      ...completedJob().request,
      source_names: { anchor: '<script>alert(1)</script>', lead: 'Lead' },
    },
    error: 'failed <b>bold</b>',
  });
  store.dispatch({
    type: 'jobs/set',
    items: [hostile],
    total: 1,
    activeCount: 0,
  });
  const container = document.getElementById('main');
  const dispose = mountActivity({ store, container });
  assert.equal(container.querySelector('img'), null);
  assert.equal(container.querySelector('script'), null);
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)> Hostile/);
  assert.match(container.textContent, /<script>alert\(1\)<\/script>/);

  // Expand technical detail.
  const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('technical details'));
  toggle.click();
  assert.ok(container.textContent.includes('"anchor_id"'), 'request JSON shown');
  assert.ok(container.textContent.includes('failed <b>bold</b>'), 'error shown literally');
  dispose();
});

test('Activity shows reveal instructions from health.data_dir without inventing filesystem access', async () => {
  const { mountActivity } = await import(
    '../../src/twobecomeone/studio_static/js/views/activity.js'
  );
  const store = await makeStore();
  store.dispatch({
    type: 'jobs/set',
    items: [completedJob()],
    total: 1,
    activeCount: 0,
  });
  store.dispatch({
    type: 'health/set',
    health: { data_dir: '/home/richardn/.local/share/2become1' },
  });
  const container = document.getElementById('main');
  const dispose = mountActivity({ store, container });
  assert.ok(container.textContent.includes('renders'));
  assert.ok(container.textContent.includes('/home/richardn/.local/share/2become1'));
  dispose();
});

test('singleton playback: starting a render resets a playing stem and vice versa', async () => {
  const { audioController } = await import(
    '../../src/twobecomeone/studio_static/js/audio.js'
  );
  // Play a stem first.
  audioController.play({ trackId: 't1', url: '/api/stems/s1/audio?name=vocals', kind: 'stem', stemName: 'vocals', variant: 'vocals' });
  assert.equal(audioController.current.kind, 'stem');
  // Starting a render stops the stem.
  audioController.play({ trackId: null, url: '/api/jobs/r1/audio', kind: 'render', jobId: 'r1', title: 'Mix' });
  assert.equal(audioController.current.kind, 'render');
  assert.equal(audioController.current.jobId, 'r1');
  // Starting a track stops the render.
  audioController.play('t2', '/api/tracks/t2/audio');
  assert.equal(audioController.current.kind, 'track');
  assert.equal(audioController.current.jobId, null);
  audioController.stop();
});

test('route teardown closes monitors and does not duplicate EventSource/announcements', async () => {
  const api = await import('../../src/twobecomeone/studio_static/js/api.js');
  const { JobCoordinator } = await import(
    '../../src/twobecomeone/studio_static/js/job-coordinator.js'
  );
  const store = await makeStore();
  store.dispatch({
    type: 'jobs/set',
    items: [{ id: 'active-1', kind: 'render', status: 'running', created_at: 1 }],
    total: 1,
    activeCount: 1,
  });
  const coordinator = new JobCoordinator(store);
  coordinator.start();
  assert.equal(globalThis.EventSource.instances.length, 1);
  coordinator.dispose();
  assert.equal(globalThis.EventSource.instances[0].closed, true);
  assert.equal(globalThis.EventSource.instances.length, 1, 'no duplicate EventSource created');
  api.closeAllMonitors();
});

test('replaceChildren helper filters null placeholders instead of stringifying them', async () => {
  // Some DOM implementations stringify null instead of ignoring it; our helper
  // must filter so stale ternary fallbacks never render the literal "null".
  const { replaceChildren, createElement } = await import(
    '../../src/twobecomeone/studio_static/js/dom.js'
  );
  const root = createElement('section', {}, []);
  const keep1 = createElement('span', { text: 'a' });
  const keep2 = createElement('span', { text: 'b' });
  replaceChildren(root, [keep1, null, undefined, false, keep2]);
  const textNodes = [...root.childNodes].filter((n) => n.nodeType === 3);
  assert.deepEqual(textNodes.map((n) => n.nodeValue), []);
  assert.equal([...root.querySelectorAll('span')].length, 2);
  // And the inline pattern that triggered the bug.
  const root2 = createElement('div', {}, []);
  replaceChildren(root2, [
    createElement('span', { text: 'x' }),
    false ? createElement('span', { text: 'never' }) : null,
    createElement('span', { text: 'y' }),
  ]);
  assert.equal([...root2.querySelectorAll('span')].length, 2);
  assert.equal(root2.textContent, 'xy');
});

test('sticky render-actions card never renders a literal "null" text node', async () => {
  // Regression for the bug found at 390px where actionFeedback === null and
  // jsdom/Chromium stringified the value into a text node.
  const { mountRenderActions } = await import(
    '../../src/twobecomeone/studio_static/js/components/render-actions.js'
  );
  const store = await makeStore();
  const currentProject = project();
  store.dispatch({ type: 'project/set', project: currentProject });
  const { buildRenderBody } = await import(
    '../../src/twobecomeone/studio_static/js/render.js'
  );
  const { preview: _preview, ...planRequest } = buildRenderBody(currentProject);
  store.dispatch({
    type: 'plan/set', loading: false, error: null,
    data: { tempo_ratio: 1 }, request: planRequest,
  });
  store.dispatch({
    type: 'jobs/set', items: [], total: 0, activeCount: 0,
  });
  const container = document.getElementById('main');
  const dispose = mountRenderActions({
    container, store,
    projectManager: { flushNow: async () => true },
    jobCoordinator: { track() {} },
  });
  // Walk every text node in the section; none may be "null" or "undefined".
  const root = container.querySelector('.render-actions');
  const strays = [...root.querySelectorAll('*')].flatMap((el) =>
    [...el.childNodes].filter((n) => n.nodeType === 3 && /^(null|undefined|false)$/.test((n.nodeValue || '').trim())),
  );
  assert.equal(strays.length, 0, `unexpected placeholder text nodes: ${strays.length}`);
  dispose();
});
