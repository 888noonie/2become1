// js/router.js — hash router and view lifecycle.
//
// Phase 4.4: hashchange-based routing. Unknown/empty hashes normalize safely.
// Back/forward work without reloading FastAPI. Each view exposes a mount()
// returning a disposer that removes listeners, aborts requests, closes job
// watchers, and clears timers.

const ROUTES = ['studio', 'library', 'activity', 'engine'];

export class Router {
  /**
   * @param {object} deps
   * @param {import('./state.js').StateStore} deps.store
   * @param {HTMLElement} deps.container - the main view container.
   * @param {Record<string, (ctx: object) => () => void>} deps.views - route -> mount fn.
   */
  constructor({ store, container, views }) {
    this.store = store;
    this.container = container;
    this.views = views;
    this._disposer = null;
    this._onHashChange = this._onHashChange.bind(this);
  }

  start() {
    window.addEventListener('hashchange', this._onHashChange);
    this._onHashChange();
  }

  stop() {
    window.removeEventListener('hashchange', this._onHashChange);
    this._dispose();
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
    // Dispose the previous view (listeners, requests, watchers, timers).
    this._dispose();

    // Update aria-current on nav links.
    document.querySelectorAll('.nav__link[data-route]').forEach((link) => {
      if (link.dataset.route === route) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    const mount = this.views[route];
    if (!mount) {
      this.container.replaceChildren();
      return;
    }
    const ctx = { store: this.store, container: this.container };
    this._disposer = mount(ctx) || null;
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
