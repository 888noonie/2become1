// js/router.js — hash router and view lifecycle.
//
// Phase 4.4: hashchange-based routing. Unknown/empty hashes normalize safely.
// Back/forward work without reloading FastAPI. Each view exposes a mount()
// returning a disposer that removes listeners, aborts requests, closes job
// watchers, and clears timers.
//
// OPERATION NEVER LOSE THE MIX: a view named in `keepAlive` is mounted ONCE,
// into its own pane, when the router starts (even if the first route is
// another section). Leaving it hides the pane and calls its `hide()`;
// returning shows the same pane and calls `show()`. It is disposed only by
// `stop()` (page unload). The Studio is kept alive this way, so leaving it
// for Library, Activity or Engine no longer closes the desk's AudioContext,
// unloads the banks or throws away the Arrangement's EditEngine and history.
// Every other view is still mounted on entry and disposed on exit.

const ROUTES = ['studio', 'library', 'activity', 'engine'];

/** A mount may return a disposer, or { dispose, show?, hide? }. */
function asHandle(result) {
  if (!result) return { dispose: null, show: null, hide: null };
  if (typeof result === 'function') {
    return {
      dispose: result,
      show: typeof result.show === 'function' ? result.show : null,
      hide: typeof result.hide === 'function' ? result.hide : null,
    };
  }
  return {
    dispose: typeof result.dispose === 'function' ? result.dispose.bind(result) : null,
    show: typeof result.show === 'function' ? result.show.bind(result) : null,
    hide: typeof result.hide === 'function' ? result.hide.bind(result) : null,
  };
}

export class Router {
  /**
   * @param {object} deps
   * @param {import('./state.js').StateStore} deps.store
   * @param {HTMLElement} deps.container - the main view container.
   * @param {Record<string, (ctx: object) => any>} deps.views - route -> mount fn.
   * @param {string[]} [deps.keepAlive] - routes mounted once and kept.
   */
  constructor({ store, container, views, keepAlive = [] }) {
    this.store = store;
    this.container = container;
    this.views = views;
    this.keepAlive = new Set(keepAlive.filter((route) => ROUTES.includes(route) && views[route]));
    this._disposer = null;
    this._route = null;
    this._kept = new Map(); // route -> { pane, handle }
    this._transientPane = null;
    this._onHashChange = this._onHashChange.bind(this);
  }

  start() {
    if (this.keepAlive.size > 0) {
      const doc = this.container.ownerDocument;
      this._transientPane = doc.createElement('div');
      this._transientPane.className = 'view-pane';
      this._transientPane.dataset.pane = 'transient';
      this._transientPane.hidden = true;
      this.container.replaceChildren(this._transientPane);
      for (const route of this.keepAlive) {
        const pane = doc.createElement('div');
        pane.className = 'view-pane';
        pane.dataset.pane = route;
        pane.hidden = true;
        this.container.appendChild(pane);
        const ctx = { store: this.store, container: pane, route };
        this._kept.set(route, { pane, handle: asHandle(this.views[route](ctx)) });
      }
    }
    window.addEventListener('hashchange', this._onHashChange);
    this._onHashChange();
  }

  stop() {
    window.removeEventListener('hashchange', this._onHashChange);
    this._dispose();
    for (const { handle } of this._kept.values()) {
      try { handle.dispose?.(); } catch (err) { console.error('view disposer error', err); }
    }
    this._kept.clear();
    this._route = null;
  }

  _normalize(hash) {
    const raw = (hash || '').replace(/^#\/?/, '').trim();
    const route = raw.split('/')[0];
    return ROUTES.includes(route) ? route : 'studio';
  }

  _onHashChange() {
    const route = this._normalize(window.location.hash);
    this.store.dispatch({ type: 'route/set', route });
    this._render(route);
  }

  _render(route) {
    // Update aria-current on nav links.
    document.querySelectorAll('.nav__link[data-route]').forEach((link) => {
      if (link.dataset.route === route) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    const previous = this._route;
    this._route = route;
    const kept = this._kept.get(route);

    if (kept && previous === route) {
      // Same section, new sub-hash (#/studio -> #/studio/arrangement).
      try { kept.handle.show?.({ hash: window.location.hash, reentered: false }); } catch (err) { console.error('view show error', err); }
      return;
    }

    // Leave the previous section: dispose a transient view, hide a kept one.
    this._dispose();
    const leaving = previous ? this._kept.get(previous) : null;
    if (leaving) {
      leaving.pane.hidden = true;
      try { leaving.handle.hide?.(); } catch (err) { console.error('view hide error', err); }
    }

    if (kept) {
      if (this._transientPane) {
        this._transientPane.hidden = true;
        this._transientPane.replaceChildren();
      }
      kept.pane.hidden = false;
      try { kept.handle.show?.({ hash: window.location.hash, reentered: previous !== null }); } catch (err) { console.error('view show error', err); }
      return;
    }

    const mount = this.views[route];
    const target = this._transientPane || this.container;
    if (this._transientPane) this._transientPane.hidden = false;
    if (!mount) {
      target.replaceChildren();
      return;
    }
    const ctx = { store: this.store, container: target, route };
    this._disposer = asHandle(mount(ctx)).dispose;
  }

  _dispose() {
    if (this._disposer) {
      try {
        this._disposer();
      } catch (err) {
        console.error('view disposer error', err);
      }
      this._disposer = null;
    }
  }
}
