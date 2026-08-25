// js/waveform.js — accessible waveform canvas with explicit cue controls.
//
// Phase 5 (Tasks 3–4): fetch the versioned 1,200-bin payload explicitly with
// per-request abort, cache immutable payloads by track ID outside render
// state (bounded), draw min/max peaks on a DPR-aware canvas via
// ResizeObserver, and always ship a labeled native fallback control so every
// canvas action has a keyboard/AT equivalent. Pointer input seeks the
// playhead only — it never mutates a saved cue. `Set cue here` is the only
// cue-writing action, with optional beat snapping and an explicit unsnapped
// escape.

const WAVEFORM_CACHE_LIMIT = 12;

// Module-level bounded caches: payloads are immutable once fetched, so they
// are shared across decks instead of stored per-component (not app state).
const payloadCache = new Map(); // trackId -> payload
const inflight = new Map();     // trackId -> { controller, promise }

/** Fetch the versioned waveform payload for a track (cached, abortable). */
export async function fetchWaveform(trackId, fetchImpl) {
  if (payloadCache.has(trackId)) return payloadCache.get(trackId);
  if (inflight.has(trackId)) return inflight.get(trackId).promise;

  const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
  const controller = new AbortController();
  const promise = (async () => {
    const response = await doFetch(
      `/api/tracks/${encodeURIComponent(trackId)}/waveform`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const err = new Error(`waveform unavailable (${response.status})`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    if (!data || data.version !== 1 || data.bins !== 1200 || !Array.isArray(data.peaks)) {
      throw new Error('unexpected waveform payload');
    }
    // Immutable, cacheable payload.
    Object.freeze(data);
    Object.freeze(data.peaks);
    if (payloadCache.size >= WAVEFORM_CACHE_LIMIT) {
      payloadCache.delete(payloadCache.keys().next().value);
    }
    payloadCache.set(trackId, data);
    return data;
  })();
  inflight.set(trackId, { controller, promise });
  try {
    return await promise;
  } finally {
    if (inflight.get(trackId)?.promise === promise) inflight.delete(trackId);
  }
}

/** Abort any in-flight waveform fetch for a track (replacement/unmount). */
export function abortWaveform(trackId) {
  const entry = inflight.get(trackId);
  if (entry) entry.controller.abort();
  inflight.delete(trackId);
}

/** Compute the nearest snapped beat >= 0, clamped to duration. */
export function snapToBeat(seconds, beatGrid, duration) {
  const first = Number(beatGrid?.first_beat);
  const interval = Number(beatGrid?.interval);
  if (!Number.isFinite(first) || !Number.isFinite(interval) || interval <= 0) {
    return clamp(seconds, 0, duration);
  }
  const n = Math.round((seconds - first) / interval);
  return clamp(first + Math.max(0, n) * interval, 0, duration);
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Mount a waveform region.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container - replaced with the waveform region.
 * @param {object} opts.track - resolved track (has id, duration, beat_grid).
 * @param {string} opts.role - 'anchor' | 'lead' (labeling only).
 * @param {() => number} opts.getTime - current playhead seconds.
 * @param {(seconds: number) => void} opts.onSeek - seek the playhead.
 * @param {() => number|null} opts.getCue - current saved cue seconds.
 * @param {(seconds: number) => void} opts.onSetCue - persist a new cue.
 * @param {() => boolean} opts.isSnapEnabled - project snap setting.
 * @param {(seconds: number) => void} [opts.onAnnounce] - polite announcements.
 * @returns {() => void} disposer (aborts fetches, disconnects observers).
 */
export function mountWaveform({
  container,
  track,
  role,
  getTime,
  onSeek,
  getCue,
  onSetCue,
  isSnapEnabled,
  onAnnounce,
  fetchImpl,
}) {
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'waveform';
  root.dataset.role = role;
  container.replaceChildren(root);

  const canvas = doc.createElement('canvas');
  canvas.className = 'waveform__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${role === 'anchor' ? 'Foundation' : 'Lead'} waveform for ${track.name}`);
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onSeek(fraction * track.duration);
  });

  const status = doc.createElement('div');
  status.className = 'waveform__status';

  // Keyboard/AT equivalents: a labeled native range slider seeks the same
  // playhead; cue-setting is only ever via the explicit buttons below.
  const slider = doc.createElement('input');
  slider.type = 'range';
  slider.className = 'waveform__slider';
  slider.min = '0';
  slider.max = String(Math.max(1, Math.round((track.duration || 1) * 10)));
  slider.step = '1';
  slider.setAttribute('aria-label', `Seek ${role === 'anchor' ? 'foundation' : 'lead'} playhead`);
  slider.addEventListener('input', () => {
    onSeek(Number(slider.value) / 10);
  });
  slider.addEventListener('change', () => {
    onAnnounce?.(`Playhead at ${(Number(slider.value) / 10).toFixed(1)} seconds`);
  });

  const cueSetBtn = doc.createElement('button');
  cueSetBtn.type = 'button';
  cueSetBtn.className = 'button waveform__cue-set';
  cueSetBtn.textContent = 'Set cue here';
  cueSetBtn.addEventListener('click', () => {
    let seconds = getTime();
    if (isSnapEnabled()) {
      seconds = snapToBeat(seconds, track.beat_grid, track.duration);
    }
    seconds = Math.round(seconds * 10) / 10;
    onSetCue(seconds);
    onAnnounce?.(`Cue set at ${seconds.toFixed(1)} seconds`);
  });

  const cueUnsnappedBtn = doc.createElement('button');
  cueUnsnappedBtn.type = 'button';
  cueUnsnappedBtn.className = 'button waveform__cue-set';
  cueUnsnappedBtn.textContent = 'Set cue here (unsnapped)';
  cueUnsnappedBtn.addEventListener('click', () => {
    const seconds = Math.round(clamp(getTime(), 0, track.duration) * 10) / 10;
    onSetCue(seconds);
    onAnnounce?.(`Cue set unsnapped at ${seconds.toFixed(1)} seconds`);
  });

  const downbeatBtn = doc.createElement('button');
  downbeatBtn.type = 'button';
  downbeatBtn.className = 'button waveform__cue-set';
  downbeatBtn.textContent = 'Use suggested downbeat';
  downbeatBtn.addEventListener('click', () => {
    const suggested = Number(track.beat_grid?.suggested_downbeat);
    if (!Number.isFinite(suggested)) return;
    const seconds = Math.round(clamp(suggested, 0, track.duration) * 10) / 10;
    onSetCue(seconds);
    onAnnounce?.(`Cue set to the suggested downbeat at ${seconds.toFixed(1)} seconds`);
  });

  // Numeric cue input with 0.1s precision and validation. Invalid input must
  // never save or poison project state.
  const cueInput = doc.createElement('input');
  cueInput.type = 'number';
  cueInput.className = 'input waveform__cue-input';
  cueInput.min = '0';
  cueInput.step = '0.1';
  cueInput.setAttribute('aria-label', `Cue position in seconds (${role === 'anchor' ? 'foundation' : 'lead'})`);
  cueInput.addEventListener('change', () => {
    const seconds = Number(cueInput.value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > track.duration) {
      cueInput.setAttribute('aria-invalid', 'true');
      onAnnounce?.('Invalid cue: enter a time within the track duration.');
      return;
    }
    cueInput.removeAttribute('aria-invalid');
    let snapped = seconds;
    if (isSnapEnabled()) {
      snapped = snapToBeat(seconds, track.beat_grid, track.duration);
    }
    snapped = Math.round(snapped * 10) / 10;
    cueInput.value = String(snapped);
    onSetCue(snapped);
    onAnnounce?.(`Cue set at ${snapped.toFixed(1)} seconds`);
  });

  root.appendChild(canvas);
  root.appendChild(status);

  const controls = doc.createElement('div');
  controls.className = 'waveform__controls';
  controls.appendChild(slider);
  controls.appendChild(cueSetBtn);
  controls.appendChild(cueUnsnappedBtn);
  controls.appendChild(downbeatBtn);
  controls.appendChild(cueInput);
  root.appendChild(controls);

  let peaks = null;
  let disposed = false;
  let observer = null;

  const draw = () => {
    if (disposed || !peaks) return;
    const dpr = doc.defaultView?.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    const width = Math.round(w * dpr);
    const height = Math.round(h * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const styles = doc.defaultView?.getComputedStyle(root);
    const color = (styles && styles.getPropertyValue('--waveform-color')) || '#5bd7ff';
    const cueColor = (styles && styles.getPropertyValue('--color-focus')) || '#ffd166';
    ctx.fillStyle = color;
    const mid = height / 2;
    const count = data.peaks.length;
    const barWidth = width / count;
    for (let i = 0; i < count; i += 1) {
      const [lo, hi] = data.peaks[i];
      const x = i * barWidth;
      const top = mid - (hi * mid);
      const bottom = mid - (lo * mid);
      ctx.fillRect(x, top, Math.max(barWidth * 0.8, 1 / dpr), Math.max(bottom - top, 1));
    }
    // Cue marker (static; the waveform itself never animates).
    const cue = getCue();
    if (cue != null && track.duration > 0) {
      const x = (cue / track.duration) * width;
      ctx.fillStyle = cueColor;
      ctx.fillRect(x - dpr, 0, 2 * dpr, height);
    }
  };

  const setStatus = (text, state) => {
    status.textContent = text || '';
    root.dataset.waveformState = state;
  };

  // Loading state does not disable the rest of the deck.
  setStatus('Loading waveform…', 'loading');

  let data = null;
  fetchWaveform(track.id, fetchImpl)
    .then((payload) => {
      if (disposed) return;
      data = payload;
      peaks = payload.peaks;
      setStatus('', 'ready');
      draw();
    })
    .catch((err) => {
      if (disposed) return;
      if (err && err.name === 'AbortError') return;
      setStatus('Waveform unavailable; sliders and buttons still work.', 'error');
    });

  // Redraw the playhead cheaply without refetching. Returned as part of the
  // disposer closure via `root._tick` so the deck can drive it on timeupdate.
  const playheadTick = () => {
  if (disposed || !data) return;
  const t = Number(getTime());
  if (Number.isFinite(t)) {
    slider.value = String(Math.round(clamp(t, 0, track.duration) * 10));
    drawPlayhead(t);
  }
  };
  root.__tick = playheadTick;

  let playheadLayer = null;
  const drawPlayhead = (t) => {
    if (!data) return;
    // Draw the playhead as a positioned overlay line instead of re-rendering
    // the peak buffer every timeupdate frame.
    if (!playheadLayer) {
      playheadLayer = doc.createElement('div');
      playheadLayer.className = 'waveform__playhead';
      root.appendChild(playheadLayer);
    }
    const fraction = track.duration > 0 ? clamp(t / track.duration, 0, 1) : 0;
    playheadLayer.style.left = `${fraction * 100}%`;
  };

  if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
    observer = new ResizeObserver(() => draw());
    observer.observe(root);
  }

  // Sync cue input with the persisted cue.
  const cue = getCue();
  if (cue != null) cueInput.value = String(cue);

  return function dispose() {
    disposed = true;
    abortWaveform(track.id);
    if (observer) observer.disconnect();
  };
}
