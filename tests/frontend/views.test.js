// tests/frontend/views.test.js — route initial-paint regressions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function makeStore() {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  return registerReducers(new StateStore());
}

test('Activity paints jobs already loaded by app boot', async () => {
  const store = await makeStore();
  store.dispatch({
    type: 'jobs/set',
    items: [{
      id: 'job-1', kind: 'import', status: 'complete',
      stage: 'complete', message: 'Import complete', progress: 100,
    }],
    total: 1,
    activeCount: 0,
  });
  // Keep the refresh pending so this assertion tests the initial snapshot.
  globalThis.fetch = () => new Promise(() => {});

  const { mountActivity } = await import(
    '../../src/twobecomeone/studio_static/js/views/activity.js'
  );
  const dispose = mountActivity({ store, container: document.getElementById('main') });

  assert.match(document.getElementById('main').textContent, /Import/);
  assert.match(document.getElementById('main').textContent, /Complete/);
  dispose();
});

test('Engine paints cached health and treats loopback as safe', async () => {
  const store = await makeStore();
  store.dispatch({
    type: 'health/set',
    health: {
      version: '0.3.0', preferred_device: 'cuda', current_device: null,
      ffmpeg: true, yt_dlp: true, demucs_available: true,
      demucs_version: '4.1.0', torch_version: '2.13.0',
      queue: { active: 0, queued: 0, running: 0 },
      storage: { bytes: 1024, data_dir: '/managed/data' },
      network_exposure: { authenticated: false, loopback_only: true },
    },
  });
  globalThis.fetch = () => new Promise(() => {});

  const { mountEngine } = await import(
    '../../src/twobecomeone/studio_static/js/views/engine.js'
  );
  const dispose = mountEngine({ store, container: document.getElementById('main') });

  const text = document.getElementById('main').textContent;
  assert.match(text, /CUDA/);
  assert.match(text, /Local machine only/);
  assert.equal(document.querySelector('.engine-warning'), null);
  dispose();
});

test('Engine warns when an unauthenticated service is network exposed', async () => {
  const store = await makeStore();
  store.dispatch({
    type: 'health/set',
    health: {
      queue: {}, storage: {},
      network_exposure: {
        authenticated: false,
        loopback_only: false,
        warning: 'Anyone on the network can reach this Studio.',
      },
    },
  });
  globalThis.fetch = () => new Promise(() => {});

  const { mountEngine } = await import(
    '../../src/twobecomeone/studio_static/js/views/engine.js'
  );
  const dispose = mountEngine({ store, container: document.getElementById('main') });

  assert.equal(
    document.querySelector('.engine-warning').textContent,
    'Anyone on the network can reach this Studio.',
  );
  dispose();
});

test('Source picker renders its selected tab on first open', async () => {
  const store = await makeStore();
  store.dispatch({
    type: 'library/set',
    items: [{
      id: 'track-1', name: 'Band <3 You', duration: 120,
      bpm: 100, key: { tonic: 'F', mode: 'major' }, source: { kind: 'youtube' },
    }],
    total: 1,
    limit: 50,
    offset: 0,
  });

  const { openSourcePicker } = await import(
    '../../src/twobecomeone/studio_static/js/components/source-picker.js'
  );
  const result = openSourcePicker(store, 'anchor');

  const panel = document.querySelector('.picker__panel');
  assert.match(panel.textContent, /Band <3 You/);
  assert.equal(panel.querySelector('img'), null);

  document.querySelector('dialog').close('close');
  await result;
});
