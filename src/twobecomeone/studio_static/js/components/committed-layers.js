// components/committed-layers.js — durable Phase 11 Ghost layers and Undo.
//
// This view derives presentation from the serializable session projection.
// Its only local state is the set of in-flight button identities; no DOM or
// request object enters StateStore.

import { createElement, replaceChildren } from '../dom.js';
import { confirmDialog } from './dialog.js';
import { showToast } from './toast.js';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatBeat(value) {
  return finite(value) ? Number(value).toFixed(1) : '—';
}

function layerSummary(layer) {
  const region = layer?.sourceRegionRef || layer?.transformSpec?.semanticRegion || {};
  const gain = layer?.placement?.gainDb;
  const launch = layer?.launchReceipt?.launchBeat;
  return `Foundation beats ${formatBeat(region.startBeat)}–${formatBeat(region.endBeat)} · `
    + `gain ${finite(gain) ? Number(gain).toFixed(1) : '—'} dB · `
    + `Lead launch beat ${formatBeat(launch)}`;
}

/** Mount the durable committed/reverted Ghost history. */
export function mountCommittedLayers({ container, store, onUndo, onAnnounce = () => {} }) {
  const root = createElement('section', {
    class: 'committed-layers',
    'aria-labelledby': 'committed-layers-title',
    hidden: true,
  });
  container.replaceChildren(root);
  const busy = new Set();
  const errors = new Map();

  async function undo(layer, trigger) {
    const commitActionId = layer?.actionId;
    if (!commitActionId || busy.has(commitActionId)) return;
    const confirmed = await confirmDialog({
      title: 'Undo committed Ghost?',
      description: 'This removes the layer from future previews and renders. Its immutable history and pinned audio are retained.',
      confirmLabel: 'Undo Ghost',
      danger: true,
      trigger,
    });
    if (!confirmed || busy.has(commitActionId)) return;
    busy.add(commitActionId);
    errors.delete(commitActionId);
    render(store.getState().session);
    try {
      const result = await onUndo(commitActionId);
      if (!result?.ok) {
        const message = result?.error?.message || 'Undo could not be confirmed. Try again.';
        errors.set(commitActionId, message);
        showToast(message, 'danger');
        onAnnounce(message);
      } else {
        showToast('Committed Ghost undone. Its history is retained.', 'success');
        onAnnounce('Committed Ghost undone. It will be excluded from future previews and renders.');
      }
    } catch (error) {
      const message = error?.message || 'Undo could not be confirmed. Try again.';
      errors.set(commitActionId, message);
      showToast(message, 'danger');
      onAnnounce(message);
    } finally {
      busy.delete(commitActionId);
      render(store.getState().session);
    }
  }

  function committedItem(layer, index) {
    const actionId = layer.actionId;
    const undoing = busy.has(actionId);
    const undoBtn = createElement('button', {
      class: 'button button--danger',
      type: 'button',
      text: undoing ? 'Undoing…' : 'Undo',
      'aria-label': `Undo committed Ghost ${index + 1}`,
      disabled: undoing ? 'true' : null,
    });
    undoBtn.onclick = () => undo(layer, undoBtn);
    const error = errors.get(actionId);
    return createElement('li', { class: 'committed-layer' }, [
      createElement('div', { class: 'committed-layer__copy' }, [
        createElement('strong', { text: `Committed Ghost ${index + 1}` }),
        createElement('span', { text: layerSummary(layer) }),
        createElement('span', {
          class: 'committed-layer__truth',
          text: 'Included in the next preview/render.',
        }),
        error ? createElement('span', {
          class: 'committed-layer__error', role: 'status', 'aria-live': 'polite', text: error,
        }) : null,
      ]),
      undoBtn,
    ]);
  }

  function render(session) {
    const committed = Array.isArray(session?.committedLayers) ? session.committedLayers : [];
    const reverted = Array.isArray(session?.revertedLayers) ? session.revertedLayers : [];
    root.hidden = committed.length === 0 && reverted.length === 0;
    if (root.hidden) {
      replaceChildren(root, []);
      return;
    }
    const nodes = [
      createElement('div', { class: 'committed-layers__heading' }, [
        createElement('h2', { id: 'committed-layers-title', text: 'Solid Ghost layers' }),
        createElement('p', {
          text: 'Committed layers are durable and enter the existing preview/render pipeline.',
        }),
      ]),
    ];
    if (committed.length) {
      nodes.push(createElement('ul', { class: 'committed-layers__list' },
        committed.map(committedItem)));
    }
    if (reverted.length) {
      nodes.push(createElement('p', {
        class: 'committed-layers__history',
        text: `${reverted.length} undone Ghost ${reverted.length === 1 ? 'layer is' : 'layers are'} retained in session history.`,
      }));
    }
    replaceChildren(root, nodes);
  }

  const unsubscribe = store.subscribeSlice('session', render);
  render(store.getState().session);
  return () => unsubscribe();
}
