// tests/frontend/dialog.test.js — dialog focus trap, Escape, focus restoration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

test('openDialog uses native showModal and resolves on close', async () => {
  const { openDialog } = await import('../../src/twobecomeone/studio_static/js/components/dialog.js');

  const trigger = document.createElement('button');
  document.body.appendChild(trigger);

  const promise = openDialog({
    title: 'Confirm',
    description: 'Are you sure?',
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'OK', value: 'ok', kind: 'primary' },
    ],
    trigger,
  });

  const dialog = document.querySelector('dialog');
  assert.ok(dialog, 'a native <dialog> was created');
  assert.equal(dialog.open, true, 'dialog is open (showModal)');
  assert.equal(dialog.querySelector('.dialog__title').textContent, 'Confirm');

  // Simulate clicking OK.
  dialog.close('ok');

  const value = await promise;
  assert.equal(value, 'ok');
  assert.equal(document.querySelector('dialog'), null, 'dialog removed on close');
});

test('Escape dismisses with null and restores focus', async () => {
  const { openDialog } = await import('../../src/twobecomeone/studio_static/js/components/dialog.js');

  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  const promise = openDialog({
    title: 'Dismiss me',
    actions: [{ label: 'Close', value: 'close' }],
    trigger,
  });

  const dialog = document.querySelector('dialog');
  // Simulate Escape via the cancel event.
  dialog.dispatchEvent(new window.Event('cancel'));

  const value = await promise;
  assert.equal(value, null);
  assert.equal(document.activeElement, trigger, 'focus restored to trigger');
});

test('one active dialog at a time', async () => {
  const { openDialog } = await import('../../src/twobecomeone/studio_static/js/components/dialog.js');

  const p1 = openDialog({ title: 'First', actions: [{ label: 'X', value: 'x' }] });
  const p2 = openDialog({ title: 'Second', actions: [{ label: 'Y', value: 'y' }] });

  // Only one dialog remains in the DOM.
  assert.equal(document.querySelectorAll('dialog').length, 1);
  assert.equal(document.querySelector('dialog .dialog__title').textContent, 'Second');

  document.querySelector('dialog').close('y');
  await p2;
  await p1;
});

test('focus returns to the active trigger by default', async () => {
  const { openDialog } = await import('../../src/twobecomeone/studio_static/js/components/dialog.js');
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  const promise = openDialog({ title: 'Default focus', actions: [{ label: 'Close', value: 'close' }] });
  document.querySelector('dialog').close('close');
  await promise;

  assert.equal(document.activeElement, trigger);
});
