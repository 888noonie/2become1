// components/ghost-card.js — the truthful Ghost status card + decorative
// tether (Phase 10C, Studio route only).
//
// A11: the tether is derived view geometry computed from current DOM bounds;
// it is never dispatched and never enters the store. The status CARD is the
// accessible truth (source/destination/phase/launch/gain + Release/Retry);
// the tether is aria-hidden decoration with pointer-events: none, static
// under prefers-reduced-motion, and collapses to an accent edge at 390px.

import { createElement, replaceChildren } from '../dom.js';
import { ghostErrorMessage } from './ghost-phrase.js';

const PHASE_COPY = {
  idle: '',
  preparing: 'Preparing Ghost preview…',
  armed: 'Ghost armed — launches at the next phrase boundary.',
  auditioning: 'Ghost auditioning over Lead.',
  ended: 'Ghost preview finished.',
  failed: 'Ghost preview failed.',
  blocked: 'A Ghost preview is already active.',
  releasing: 'Releasing Ghost preview…',
  interrupted: 'Ghost preview interrupted.',
  conflict: 'Several Ghost previews need Release.',
};

function fmt(n, digits = 1) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : '—';
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {import('../state.js').StateStore} opts.store
 * @param {() => HTMLElement|null} opts.anchorCardEl - Foundation deck element
 * @param {() => HTMLElement|null} opts.leadCardEl - Lead deck element
 * @param {(action: 'release'|'retry') => void} opts.onAction
 */
export function mountGhostCard({ container, store, anchorCardEl, leadCardEl, onAction }) {
  const root = createElement('section', {
    class: 'ghost-card',
    'aria-label': 'Ghost preview status',
    // The card is hidden unless the ghost slice has something to say.
    hidden: true,
  });
  container.appendChild(root);

  // Tether: decorative SVG overlay between the deck slots (A11 — geometry
  // stays local; aria-hidden; pointer-events none via CSS).
  const tether = createElement('div', {
    class: 'ghost-tether',
    'aria-hidden': 'true',
  });
  const tetherSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  tetherSvg.setAttribute('class', 'ghost-tether__svg');
  const tetherPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tetherPath.setAttribute('class', 'ghost-tether__path');
  tetherSvg.appendChild(tetherPath);
  tether.appendChild(tetherSvg);
  // The tether overlays the space between the two deck slots, which is a
  // sibling of this card's container. Append it to the document body and
  // position it with fixed coordinates computed from live DOM bounds (A11).
  document.body.appendChild(tether);

  const phaseEl = createElement('p', { class: 'ghost-card__phase', text: '' });
  const summaryEl = createElement('p', { class: 'ghost-card__summary' });
  const receiptEl = createElement('p', { class: 'ghost-card__receipt' });
  const errorEl = createElement('p', {
    class: 'ghost-card__error',
    role: 'status',
    'aria-live': 'polite',
  });
  const releaseBtn = createElement('button', {
    class: 'button button--danger', type: 'button', text: 'Release',
    'aria-label': 'Release the Ghost preview',
    onclick: () => onAction('release'),
  });
  const retryBtn = createElement('button', {
    class: 'button', type: 'button', text: 'Retry',
    'aria-label': 'Retry the Ghost preview',
    onclick: () => onAction('retry'),
  });

  const body = createElement('div', { class: 'ghost-card__body' }, [
    phaseEl,
    summaryEl,
    receiptEl,
    errorEl,
    createElement('div', { class: 'ghost-card__actions' }, [releaseBtn, retryBtn]),
  ]);
  replaceChildren(root, [body]);

  let tetherFrame = null;

  /** Recompute tether endpoints from current DOM bounds (resize/layout moves). */
  const drawTether = () => {
    tetherFrameCancel();
    const status = store.getState().ghostStatus;
    const show = ['armed', 'auditioning', 'preparing'].includes(status.phase)
      && Boolean(status.activeProposalId);
    tether.dataset.visible = show ? 'true' : 'false';
    root.dataset.tethered = show ? 'true' : 'false';
    if (!show) {
      tetherSvg.removeAttribute('viewBox');
      tetherSvg.removeAttribute('width');
      tetherSvg.removeAttribute('height');
      tetherPath.removeAttribute('d');
      return;
    }
    const anchored = anchorCardEl?.() || null;
    const target = leadCardEl?.() || null;
    // Narrow fallback (A11): no off-screen SVG hitbox — the CSS turns the
    // tether into an accent edge on the Lead deck below 700px.
    if (!anchored || !target || window.innerWidth < 700) {
      tetherSvg.removeAttribute('viewBox');
      tetherSvg.removeAttribute('width');
      tetherSvg.removeAttribute('height');
      tetherPath.removeAttribute('d');
      return;
    }
    const a = anchored.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const x1 = a.right;
    const y1 = a.top + a.height / 2;
    const x2 = b.left;
    const y2 = b.top + b.height / 2;
    const midX = (x1 + x2) / 2;
    const left = Math.min(x1, midX, x2);
    const top = Math.min(y1, y2);
    const width = Math.max(x1, midX, x2) - left;
    const height = Math.max(y1, y2) - top;
    tether.style.left = `${left}px`;
    tether.style.top = `${top}px`;
    tether.style.width = `${width}px`;
    tether.style.height = `${height}px`;
    // A gentle S-curve (static; CSS animates dash only, disabled under
    // prefers-reduced-motion).
    const d = `M ${x1 - left} ${y1 - top} C ${midX - left} ${y1 - top}, ${midX - left} ${y2 - top}, ${x2 - left} ${y2 - top}`;
    tetherSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    tetherSvg.setAttribute('width', String(width));
    tetherSvg.setAttribute('height', String(height));
    tetherPath.setAttribute('d', d);
  };

  const tetherFrameCancel = () => {
    if (tetherFrame !== null) {
      cancelAnimationFrame(tetherFrame);
      tetherFrame = null;
    }
  };
  const scheduleTether = () => {
    tetherFrameCancel();
    tetherFrame = requestAnimationFrame(() => {
      tetherFrame = null;
      drawTether();
    });
  };

  const onResize = () => scheduleTether();
  window.addEventListener('resize', onResize);

  const render = (status) => {
    const phase = status?.phase || 'idle';
    // Visible when anything non-idle or an error/hydration signal exists.
    const visible = phase !== 'idle' || status.error !== null || status.hydrating === true;
    root.hidden = !visible;
    if (!visible) {
      tether.dataset.visible = 'false';
      tether.dataset.active = 'false';
      return;
    }
    phaseEl.textContent = status.hydrating
      ? 'Restoring Ghost state…'
      : (PHASE_COPY[phase] || phase);
    if (status.summary) {
      summaryEl.textContent = `Foundation vocals ${fmt(status.summary.startBeat)}–${fmt(status.summary.endBeat)} beats, gain ${fmt(status.summary.gainDb)} dB, over Lead.`;
    } else {
      summaryEl.textContent = '';
    }
    if (status.receipt) {
      receiptEl.textContent = `Launch: beat ${fmt(status.receipt.launchBeat)} (phrase ${Number(status.receipt.phraseIndex) + 1}).`;
    } else {
      receiptEl.textContent = '';
    }
    if (status.error) {
      errorEl.textContent = ghostErrorMessage(status.error);
    } else {
      errorEl.textContent = '';
    }
    // Controls appear whenever a human action is meaningful (A8: hydrated
    // interrupted proposals are releasable; retry pre-fills the same params).
    const actionable = [
      'preparing', 'armed', 'auditioning', 'failed', 'blocked', 'interrupted',
      'releasing', 'conflict', 'ended',
    ].includes(phase) || Boolean(status.error);
    releaseBtn.hidden = !actionable;
    retryBtn.hidden = !actionable;
    // Tether activity class: armed/auditioning only.
    tether.dataset.active = ['armed', 'auditioning'].includes(phase) ? 'true' : 'false';
    tether.dataset.visible = ['armed', 'auditioning', 'preparing'].includes(phase) ? 'true' : 'false';
    scheduleTether();
  };

  const unsubscribe = store.subscribeSlice('ghostStatus', render);
  render(store.getState().ghostStatus);

  return function dispose() {
    unsubscribe();
    window.removeEventListener('resize', onResize);
    tetherFrameCancel();
    if (tether.isConnected) tether.remove();
  };
}
