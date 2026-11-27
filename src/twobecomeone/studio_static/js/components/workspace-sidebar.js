// js/components/workspace-sidebar.js — the Producer/Crate sidebar in the
// application shell (OPERATION NEVER LOSE THE MIX, Phase B).
//
// There is ONE Producer and ONE Crate: the rail the Performance desk builds.
// The desk hands that rail to this host (`railHost.attach`), and the host
// only moves the same DOM node between two places:
//
// - wider than 1100 px: a right-hand sidebar beside every section (Studio,
//   Library, Activity, Engine). Hide collapses it to a slim reopen tab and
//   gives the width back; the rail stays in the DOM, so search text, the
//   selected tab, open rows and the Producer's idea are untouched.
// - 1100 px and narrower: the sidebar is not drawn. "Producer & Crate" in the
//   top bar (or the desk's Crate button) opens the same rail in a modal
//   full-height sheet. Done or Escape puts it back and returns focus.
//
// Opening, hiding or moving the rail never starts, stops or loads audio.

import { createElement } from '../dom.js';

const COLLAPSED_KEY = 'twobecomeone.sidebar.collapsed';

export function mountWorkspaceSidebar({
  aside,
  openButton = null,
  store = null,
  storage = (() => { try { return window.localStorage; } catch { return null; } })(),
} = {}) {
  if (!aside) throw new Error('mountWorkspaceSidebar requires an aside');
  const doc = aside.ownerDocument;
  const win = doc.defaultView;

  const bodyId = 'workspace-sidebar-body';
  const hideButton = createElement('button', {
    type: 'button', class: 'button button--sm workspace-sidebar__hide', text: 'Hide',
    'aria-expanded': 'true', 'aria-controls': bodyId,
    'aria-label': 'Hide Producer and Crate',
  });
  const contextLine = createElement('p', { class: 'workspace-sidebar__context', hidden: 'true' });
  const head = createElement('div', { class: 'workspace-sidebar__head' }, [
    // An h2, so the Producer's own h3 follows a section heading on every page.
    createElement('h2', { class: 'workspace-sidebar__title', text: 'Producer & Crate' }),
    hideButton,
  ]);
  const body = createElement('div', { id: bodyId, class: 'workspace-sidebar__body' }, [contextLine]);
  const reopenDot = createElement('span', { class: 'workspace-sidebar__dot', 'aria-hidden': 'true' });
  const reopenText = createElement('span', { class: 'sr-only' });
  const reopenButton = createElement('button', {
    type: 'button', class: 'workspace-sidebar__reopen', hidden: 'true',
    'aria-expanded': 'false', 'aria-controls': bodyId,
  }, [createElement('span', { class: 'workspace-sidebar__reopen-label', text: 'Producer & Crate' }), reopenDot, reopenText]);
  aside.replaceChildren(head, body, reopenButton);
  aside.hidden = true; // until a rail arrives

  let rail = null;
  let railApi = null;
  let route = store?.getState?.().route || 'studio';
  let surface = 'performance';
  let sheet = null;
  let sheetTrigger = null;
  let pendingObserver = null;
  let collapsed = false;
  const narrowQuery = win.matchMedia ? win.matchMedia('(max-width: 1100px)') : null;
  const narrow = () => Boolean(narrowQuery?.matches);
  try { collapsed = storage?.getItem(COLLAPSED_KEY) === 'true'; } catch { collapsed = false; }

  function mirror() {
    // Desk messages are only on screen in Studio. Anywhere else, and in the
    // sheet, the Crate repeats them so Load/Separate are never silent.
    const inline = narrow() && deskOnScreen();
    railApi?.crate?.setMirrorDeskMessages?.(Boolean(sheet) || !deskOnScreen() || (collapsed && !inline));
  }

  const deskOnScreen = () => route === 'studio' && surface === 'performance';

  /** Where the one rail lives now: the sheet, under the desk, or the sidebar. */
  function place() {
    if (!rail || sheet) return;
    const inline = narrow() && deskOnScreen() && railApi?.inlineSlot;
    const target = inline ? railApi.inlineSlot : body;
    if (rail.parentNode !== target) target.appendChild(rail);
    if (inline) railApi?.setExpanded?.(false);
  }
  narrowQuery?.addEventListener?.('change', () => { place(); mirror(); });

  function syncContext() {
    const arranging = route === 'studio' && surface === 'arrangement';
    const away = !deskOnScreen();
    contextLine.hidden = !away;
    contextLine.textContent = !away ? '' : arranging
      ? 'The Crate loads into the Performance desk, which keeps your banks and mix. The Arrangement has its own Producer on the page.'
      : 'These act on the Performance desk in Studio. It keeps your banks and mix while you are here.';
    aside.dataset.route = route;
    aside.dataset.context = arranging ? 'arrangement' : route;
    // One Producer per page: on the Arrangement surface the page has its own,
    // so the desk Producer's controls step aside. Its idea and Undo are kept.
    railApi?.setProducerAway?.(arranging
      ? 'The Arrangement has its own Producer on the page. The Performance desk’s Producer, and any idea it is holding, is here again on Performance or in Library, Activity and Engine.'
      : '');
    place();
    mirror();
  }
  const onSurface = (event) => {
    surface = event?.detail?.surface === 'arrangement' ? 'arrangement' : 'performance';
    syncContext();
  };
  win.addEventListener('twobecomeone:studio-surface', onSurface);

  function syncPending() {
    const tab = rail?.querySelector('.desk-rail__tab[data-tab="producer"]');
    const pending = tab?.dataset.pending === 'true';
    reopenButton.dataset.pending = pending ? 'true' : 'false';
    reopenText.textContent = pending ? ' (idea pending)' : '';
    if (openButton) openButton.dataset.pending = pending ? 'true' : 'false';
  }

  function applyCollapsed({ focus = false } = {}) {
    aside.dataset.collapsed = collapsed ? 'true' : 'false';
    doc.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'open';
    body.hidden = collapsed;
    head.hidden = collapsed;
    reopenButton.hidden = !collapsed;
    hideButton.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) railApi?.setExpanded?.(false);
    mirror();
    if (focus) {
      if (collapsed) reopenButton.focus();
      else rail?.querySelector('.desk-rail__tab[aria-selected="true"]')?.focus();
    }
  }

  function setCollapsed(value, { focus = false } = {}) {
    collapsed = Boolean(value);
    try { storage?.setItem(COLLAPSED_KEY, String(collapsed)); } catch { /* per-viewer convenience only */ }
    applyCollapsed({ focus });
  }

  hideButton.addEventListener('click', () => setCollapsed(true, { focus: true }));
  reopenButton.addEventListener('click', () => setCollapsed(false, { focus: true }));

  function closeSheet() {
    if (!sheet) return;
    if (sheet.open && typeof sheet.close === 'function') sheet.close();
    else {
      sheet.removeAttribute('open');
      sheet.dispatchEvent(new win.Event('close'));
    }
  }

  function openSheet({ tab = null, trigger = null } = {}) {
    if (!rail || sheet) return;
    railApi?.setExpanded?.(false);
    sheetTrigger = trigger || openButton;
    const titleId = 'workspace-sheet-title';
    const done = createElement('button', { type: 'button', class: 'button button--sm', text: 'Done' });
    const sheetBody = createElement('div', { class: 'workspace-sheet__body' });
    sheet = createElement('dialog', { class: 'workspace-sheet', 'aria-labelledby': titleId }, [
      createElement('div', { class: 'workspace-sheet__head' }, [
        createElement('h2', { id: titleId, class: 'workspace-sheet__title', text: 'Producer & Crate' }),
        done,
      ]),
      sheetBody,
    ]);
    if (route !== 'studio') {
      sheetBody.appendChild(createElement('p', { class: 'workspace-sidebar__context', text: contextLine.textContent }));
    }
    sheetBody.appendChild(rail);
    done.addEventListener('click', closeSheet);
    sheet.addEventListener('close', () => {
      const closing = sheet;
      sheet = null;
      body.appendChild(rail);
      place();
      closing.remove();
      mirror();
      const back = sheetTrigger;
      sheetTrigger = null;
      if (back?.isConnected && !back.closest('[hidden]')) back.focus();
      else openButton?.focus();
    });
    doc.body.appendChild(sheet);
    mirror();
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
    if (tab) railApi?.selectTab?.(tab);
    if (railApi?.tab?.() === 'crate') {
      railApi.crate?.activate?.();
      railApi.crate?.focusSearch?.();
    } else {
      rail.querySelector('.desk-rail__tab[aria-selected="true"]')?.focus();
    }
  }

  openButton?.addEventListener('click', () => openSheet({ trigger: openButton }));

  const unsubscribeRoute = store?.subscribeSlice?.('route', (next) => {
    route = typeof next === 'string' ? next : store.getState().route;
    syncContext();
  }) || null;

  const host = {
    aside,
    attach(nextRail, api) {
      rail = nextRail;
      railApi = api || null;
      body.appendChild(rail);
      aside.hidden = false;
      if (openButton) openButton.hidden = false;
      pendingObserver?.disconnect();
      const producerTab = rail.querySelector('.desk-rail__tab[data-tab="producer"]');
      if (producerTab && win.MutationObserver) {
        pendingObserver = new win.MutationObserver(syncPending);
        pendingObserver.observe(producerTab, { attributes: true, attributeFilter: ['data-pending'] });
      }
      syncPending();
      applyCollapsed();
      syncContext();
      return () => {
        if (rail !== nextRail) return;
        closeSheet();
        pendingObserver?.disconnect();
        pendingObserver = null;
        rail.remove();
        rail = null;
        railApi = null;
        aside.hidden = true;
        if (openButton) openButton.hidden = true;
      };
    },
    openSheet,
    closeSheet,
    setCollapsed,
    isCollapsed: () => collapsed,
    dispose() {
      closeSheet();
      unsubscribeRoute?.();
      win.removeEventListener('twobecomeone:studio-surface', onSurface);
      pendingObserver?.disconnect();
      aside.replaceChildren();
    },
  };
  return host;
}
