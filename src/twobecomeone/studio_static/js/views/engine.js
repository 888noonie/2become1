// views/engine.js — Engine view (read-only status).
//
// Phase 4.9: display only backend-reported facts — versions/capabilities,
// preferred/current device, queue state, storage/data directory, and network
// binding status with a prominent no-auth warning if exposed beyond loopback.

import { createElement } from '../dom.js';
import { getHealth } from '../api.js';
import { formatBytes } from '../format.js';

export function mountEngine({ store, container }) {
  let abortController = null;

  const render = (health) => {
    if (!health) {
      container.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('div', { class: 'spinner' }),
        createElement('p', { text: 'Reading engine status…' }),
      ]));
      return;
    }

    const nodes = [];

    // Warn only when the unauthenticated service is reachable beyond this
    // machine. Loopback-only is the intended safe local configuration.
    const exposure = health.network_exposure || {};
    const loopbackOnly = exposure.loopback_only === true;
    if (!exposure.authenticated && !loopbackOnly) {
      nodes.push(createElement('div', { class: 'engine-warning', role: 'alert', text: exposure.warning || 'This Studio has no authentication.' }));
    }

    const grid = createElement('div', { class: 'engine-grid' });

    const card = (label, value) => createElement('div', { class: 'engine-card' }, [
      createElement('div', { class: 'engine-card__label', text: label }),
      createElement('div', { class: 'engine-card__value', text: value }),
    ]);

    grid.appendChild(card('App version', health.version || '—'));
    grid.appendChild(card('Preferred device', (health.preferred_device || '—').toUpperCase()));
    grid.appendChild(card('Current device', (health.current_device || 'not loaded').toUpperCase()));
    grid.appendChild(card('ffmpeg', health.ffmpeg ? 'Available' : 'Missing'));
    grid.appendChild(card('yt-dlp', health.yt_dlp ? 'Available' : 'Missing'));
    grid.appendChild(card('Demucs', health.demucs_available ? `Available (${health.demucs_version || '?'})` : 'Unavailable'));
    grid.appendChild(card('PyTorch', health.torch_version || '—'));
    grid.appendChild(card('Network access', loopbackOnly ? 'Local machine only' : 'Network exposed'));
    grid.appendChild(card('Authentication', exposure.authenticated ? 'Enabled' : 'Not configured'));

    const queue = health.queue || {};
    grid.appendChild(card('Active jobs', String(queue.active ?? 0)));
    grid.appendChild(card('Queued', String(queue.queued ?? 0)));
    grid.appendChild(card('Running', String(queue.running ?? 0)));

    const storage = health.storage || {};
    grid.appendChild(card('Storage used', formatBytes(storage.bytes)));
    grid.appendChild(card('Data directory', storage.data_dir || '—'));

    nodes.push(grid);
    container.replaceChildren(...nodes);
  };

  const load = async () => {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    try {
      const health = await getHealth(abortController.signal);
      store.dispatch({ type: 'health/set', health });
    } catch (err) {
      if (err.name === 'AbortError') return;
      container.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('p', { class: 'state__title', text: 'Engine is offline' }),
        createElement('p', { text: err.message }),
      ]));
    }
  };

  const unsubscribe = store.subscribeSlice('health', render);
  // Paint the boot-time snapshot before refreshing it. An identical refresh
  // does not emit a slice change, by design.
  render(store.getState().health);
  load();

  return () => {
    unsubscribe();
    if (abortController) abortController.abort();
  };
}
