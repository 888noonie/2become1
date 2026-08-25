// components/toast.js — safe toast notifications.
//
// Phase 4.6: toasts use safe text nodes, avoid stealing focus, and carry
// suitable status semantics via role/aria-live.

let toastTimer = null;

/**
 * Show a toast message.
 * @param {string} message
 * @param {'default'|'danger'|'success'} [kind]
 */
export function showToast(message, kind = 'default') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast${kind !== 'default' ? ` toast--${kind}` : ''}`;
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}
