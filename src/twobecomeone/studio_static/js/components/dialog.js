// components/dialog.js — accessible dialog using the native <dialog> element.
//
// Phase 4.6: use <dialog>.showModal() so the browser handles the focus trap,
// inert background (::backdrop), and Escape dismissal natively. We manage only
// DOM cleanup on close and focus restoration to the triggering element.

import { createElement } from '../dom.js';

let activeDialog = null;

/**
 * Open a modal dialog.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {Array<HTMLElement>} [opts.body] - body nodes.
 * @param {Array<{label: string, value: string, kind?: string, onClick?: Function}>} opts.actions
 * @param {HTMLElement} [opts.trigger] - element to restore focus to on close.
 * @returns {Promise<string|null>} resolves with the action value, or null on dismiss.
 */
export function openDialog({ title, description, body = [], actions = [], trigger = null }) {
  const focusTarget = trigger || (
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  // One active dialog at a time.
  if (activeDialog) {
    activeDialog.close();
  }

  const dialog = createElement('dialog', {});
  const bodyEl = createElement('div', { class: 'dialog__body' });

  bodyEl.appendChild(createElement('h2', { class: 'dialog__title', text: title }));
  if (description) {
    bodyEl.appendChild(createElement('p', { class: 'dialog__description', text: description }));
  }
  for (const node of body) {
    bodyEl.appendChild(node);
  }

  const actionsEl = createElement('div', { class: 'dialog__actions' });
  for (const action of actions) {
    const btn = createElement('button', {
      type: 'button',
      class: `button ${action.kind === 'danger' ? 'button--danger' : action.kind === 'primary' ? 'button--primary' : ''}`,
      text: action.label,
      onclick: () => {
        dialog.close(action.value);
      },
    });
    actionsEl.appendChild(btn);
  }
  bodyEl.appendChild(actionsEl);
  dialog.appendChild(bodyEl);

  document.getElementById('dialog-layer').appendChild(dialog);
  activeDialog = dialog;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const onClose = () => {
      const value = dialog.returnValue || null;
      dialog.removeEventListener('cancel', onCancel);
      dialog.remove();
      if (activeDialog === dialog) activeDialog = null;
      if (focusTarget && typeof focusTarget.focus === 'function' && focusTarget.isConnected) {
        focusTarget.focus();
      }
      finish(value);
    };

    const onCancel = (event) => {
      // Escape: dismiss without a value.
      event.preventDefault();
      dialog.close();
    };

    dialog.addEventListener('close', onClose, { once: true });
    dialog.addEventListener('cancel', onCancel);

    dialog.showModal();
  });
}

/**
 * Convenience: a confirm dialog with Cancel / Confirm actions.
 * @param {object} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, description, confirmLabel = 'Confirm', danger = false, trigger = null }) {
  return openDialog({
    title,
    description,
    trigger,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: confirmLabel, value: 'confirm', kind: danger ? 'danger' : 'primary' },
    ],
  }).then((value) => value === 'confirm');
}
