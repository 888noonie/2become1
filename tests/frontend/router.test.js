// tests/frontend/router.test.js — hash navigation and disposer execution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

test('unknown/empty hash normalizes to studio', async () => {
  const { Router } = await import('../../src/twobecomeone/studio_static/js/router.js');
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');

  const store = registerReducers(new StateStore());
  const container = document.getElementById('main');
  const mounted = [];
  const views = {
    studio: () => { mounted.push('studio'); return () => {}; },
    library: () => { mounted.push('library'); return () => {}; },
    activity: () => { mounted.push('activity'); return () => {}; },
    engine: () => { mounted.push('engine'); return () => {}; },
  };

  const router = new Router({ store, container, views });
  router.start();

  assert.equal(store.getState().route, 'studio');
  assert.deepEqual(mounted, ['studio']);
  router.stop();
});

test('route change disposes previous view and mounts new', async () => {
  const { Router } = await import('../../src/twobecomeone/studio_static/js/router.js');
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');

  const store = registerReducers(new StateStore());
  const container = document.getElementById('main');
  const disposed = [];
  const views = {
    studio: () => { return () => disposed.push('studio'); },
    library: () => { return () => disposed.push('library'); },
    activity: () => { return () => disposed.push('activity'); },
    engine: () => { return () => disposed.push('engine'); },
  };

  const router = new Router({ store, container, views });
  router.start();

  // Navigate to library.
  window.location.hash = '#/library';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.equal(store.getState().route, 'library');
  assert.deepEqual(disposed, ['studio']);

  // Navigate to engine.
  window.location.hash = '#/engine';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.equal(store.getState().route, 'engine');
  assert.deepEqual(disposed, ['studio', 'library']);

  router.stop();
});

test('aria-current is set on the active nav link', async () => {
  const { Router } = await import('../../src/twobecomeone/studio_static/js/router.js');
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');

  // Add nav links to the DOM.
  const nav = document.createElement('nav');
  for (const route of ['studio', 'library', 'activity', 'engine']) {
    const link = document.createElement('a');
    link.className = 'nav__link';
    link.dataset.route = route;
    nav.appendChild(link);
  }
  document.body.appendChild(nav);

  const store = registerReducers(new StateStore());
  const container = document.getElementById('main');
  const views = { studio: () => () => {}, library: () => () => {}, activity: () => () => {}, engine: () => () => {} };

  const router = new Router({ store, container, views });
  router.start();

  window.location.hash = '#/activity';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));

  const current = document.querySelector('.nav__link[aria-current="page"]');
  assert.ok(current);
  assert.equal(current.dataset.route, 'activity');

  router.stop();
});
