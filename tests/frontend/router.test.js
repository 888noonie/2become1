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

// OPERATION NEVER LOSE THE MIX: a kept-alive view is mounted once and hidden.
function keptViews(log) {
  const view = (name) => () => {
    log.push(`mount ${name}`);
    return () => log.push(`dispose ${name}`);
  };
  const studio = () => {
    log.push('mount studio');
    const dispose = () => log.push('dispose studio');
    dispose.show = ({ hash }) => log.push(`show studio ${hash}`);
    dispose.hide = () => log.push('hide studio');
    return dispose;
  };
  return { studio, library: view('library'), activity: view('activity'), engine: view('engine') };
}

test('keepAlive: the Studio is mounted once, hidden on leave and shown on return; others still dispose', async () => {
  const { Router } = await import('../../src/twobecomeone/studio_static/js/router.js');
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());
  const container = document.getElementById('main');
  const log = [];
  window.location.hash = '#/studio';
  const router = new Router({ store, container, views: keptViews(log), keepAlive: ['studio'] });
  router.start();
  const pane = container.querySelector('.view-pane[data-pane="studio"]');
  assert.equal(pane.hidden, false);
  for (const route of ['library', 'activity', 'engine']) {
    window.location.hash = `#/${route}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    assert.equal(pane.hidden, true);
  }
  window.location.hash = '#/studio';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.equal(pane.hidden, false);
  assert.equal(container.querySelector('.view-pane[data-pane="studio"]'), pane, 'the same pane');
  assert.deepEqual(log, [
    'mount studio', 'show studio #/studio',
    'hide studio', 'mount library',
    'dispose library', 'mount activity',
    'dispose activity', 'mount engine',
    'dispose engine', 'show studio #/studio',
  ]);
  assert.equal(log.filter((entry) => entry === 'mount studio').length, 1);
  // A Studio sub-hash is the same section: shown again, not hidden or remounted.
  window.location.hash = '#/studio/arrangement';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.equal(log.at(-1), 'show studio #/studio/arrangement');
  router.stop();
  assert.equal(log.at(-1), 'dispose studio', 'only stop() disposes a kept view');
});

test('keepAlive: landing on another section still mounts the Studio once, hidden', async () => {
  const { Router } = await import('../../src/twobecomeone/studio_static/js/router.js');
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());
  const container = document.getElementById('main');
  const log = [];
  window.location.hash = '#/library';
  const router = new Router({ store, container, views: keptViews(log), keepAlive: ['studio'] });
  router.start();
  assert.deepEqual(log, ['mount studio', 'mount library']);
  assert.equal(container.querySelector('.view-pane[data-pane="studio"]').hidden, true);
  assert.equal(container.querySelector('.view-pane[data-pane="transient"]').hidden, false);
  window.location.hash = '#/studio';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.deepEqual(log.slice(2), ['dispose library', 'show studio #/studio']);
  router.stop();
});
