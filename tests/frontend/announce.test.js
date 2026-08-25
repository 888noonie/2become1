// tests/frontend/announce.test.js — debounced aria-live announcements.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

test('important announcements fire immediately', async () => {
  const { announce, _resetForTest } = await import('../../src/twobecomeone/studio_static/js/announce.js');
  _resetForTest();

  announce('Stage changed to separating', { important: true });
  const region = document.querySelector('.sr-only');
  assert.ok(region);
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.textContent, 'Stage changed to separating');
});

test('percentage announcements are debounced to at most every 2s', async () => {
  const { announce, _resetForTest } = await import('../../src/twobecomeone/studio_static/js/announce.js');
  _resetForTest();

  // First announcement fires immediately.
  announce('Downloading 10%');
  const region = document.querySelector('.sr-only');
  assert.equal(region.textContent, 'Downloading 10%');

  // A rapid follow-up within 2s is debounced (not immediately applied).
  announce('Downloading 20%');
  assert.equal(region.textContent, 'Downloading 10%', 'rapid update is debounced');

  // After the debounce window, the latest message is applied.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(region.textContent, 'Downloading 20%');
});
