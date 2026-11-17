// components/stem-desk-panel.js — Stem Performance Desk.
//
// One separated track, up to four stem lanes, one transport. Lanes are
// decoded by stem-desk.js and started together on a single AudioContext, so
// mute/solo/gain are exact gain-node values rather than UI-only state.
//
// Bounded by design: the panel loads one track on demand, aborts a stale
// request, and disposes its desk (and its own AudioContext) on unmount. It
// reuses existing stem endpoints; it never writes a stem, project or render.

import { createElement, replaceChildren } from '../dom.js';
import { listTracks, listStems } from '../api.js';
import { StemDesk, STEM_DESK_LIMITS } from '../runtime/stem-desk.js';

const STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'center', 'sides'];
const FALLBACK_NOTE = 'Fallback split: center and sides are channel separations, not isolated vocals or instruments.';

function sortLanes(variants) {
  return [...variants].sort((a, b) => {
    const left = STEM_ORDER.indexOf(a.name);
    const right = STEM_ORDER.indexOf(b.name);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
}

/**
 * A track can legitimately have both a Demucs set and an ffmpeg fallback set.
 * Prefer the four isolated Demucs stems; only fall back to other variants when
 * no Demucs lane exists, and never exceed the desk's four lanes.
 */
function selectLanes(variants) {
  const usable = variants.filter((variant) => variant && variant.name && variant.name !== 'full');
  const byName = new Map(usable.map((variant) => [variant.name, variant]));
  const demucs = ['vocals', 'drums', 'bass', 'other']
    .filter((name) => byName.has(name))
    .map((name) => byName.get(name));
  const chosen = demucs.length ? demucs : usable.slice(0, STEM_DESK_LIMITS.maxLanes);
  return sortLanes(chosen);
}

function stemLabel(name) {
  switch (name) {
    case 'vocals': return 'Vocals';
    case 'drums': return 'Drums';
    case 'bass': return 'Bass';
    case 'other': return 'Other';
    case 'center': return 'Center (mid)';
    case 'sides': return 'Sides';
    default: return name;
  }
}

function provenanceLabel(variant) {
  const method = variant.method === 'demucs'
    ? `demucs${variant.modelName ? ` · ${variant.modelName}` : ''}`
    : variant.method === 'ffmpeg'
      ? 'ffmpeg · center/side fallback'
      : (variant.method || 'unknown method');
  return variant.device ? `${method} · ${variant.device}` : method;
}

export function mountStemDeskPanel({
  container,
  listTracksImpl = listTracks,
  listStemsImpl = listStems,
  createDesk = (options) => new StemDesk(options),
  audioContextFactory = () => new AudioContext(),
  onAnnounce = null,
} = {}) {
  if (!container) throw new Error('mountStemDeskPanel requires a container');

  const root = createElement('section', {
    class: 'stem-desk',
    'aria-label': 'Stem Performance Desk',
  });
  const title = createElement('h2', { class: 'stem-desk__title', text: 'Stem Performance Desk' });
  const status = createElement('p', { class: 'stem-desk__status', role: 'status', text: 'Choose a separated track.' });
  const trackSelect = createElement('select', { class: 'stem-desk__select', 'aria-label': 'Track with separated stems' }, [
    createElement('option', { value: '', text: 'Choose a track…' }),
  ]);
  const loadButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Load stems' });
  const playButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Play', disabled: 'true' });
  const stopButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Stop', disabled: 'true' });
  const positionLabel = createElement('span', { class: 'stem-desk__meta', text: '0.0 s' });
  const transport = createElement('div', { class: 'stem-desk__actions' }, [playButton, stopButton, positionLabel]);
  const lanesMount = createElement('div', {});
  const note = createElement('p', { class: 'stem-desk__note', hidden: 'true' });

  container.replaceChildren(root);
  replaceChildren(root, [
    title,
    createElement('div', { class: 'stem-desk__toolbar' }, [trackSelect, loadButton]),
    status,
    transport,
    lanesMount,
    note,
  ]);

  let desk = null;
  let abort = null;
  let positionTimer = null;
  let disposed = false;
  let tracksLoaded = false;
  let tracksPending = null;

  function say(message) {
    status.textContent = message;
    onAnnounce?.(message);
  }

  function ensureDesk() {
    if (desk) return desk;
    // The panel owns this context; LiveMixer's context is never reused or
    // closed here, and this one is closed when the panel is disposed.
    desk = createDesk({ audioContext: audioContextFactory(), ownsContext: true });
    return desk;
  }

  function renderLanes(state) {
    const lanes = state?.lanes || [];
    if (!lanes.length) {
      replaceChildren(lanesMount, []);
      return;
    }
    const anyFallback = lanes.some((lane) => lane.name === 'center' || lane.name === 'sides');
    note.hidden = !anyFallback;
    note.textContent = anyFallback ? FALLBACK_NOTE : '';
    replaceChildren(lanesMount, lanes.map((lane) => {
      const mute = createElement('button', {
        class: 'button button--sm',
        type: 'button',
        text: 'M',
        'aria-label': `Mute ${stemLabel(lane.name)}`,
        'aria-pressed': lane.muted ? 'true' : 'false',
      });
      const solo = createElement('button', {
        class: 'button button--sm',
        type: 'button',
        text: 'S',
        'aria-label': `Solo ${stemLabel(lane.name)}`,
        'aria-pressed': lane.solo ? 'true' : 'false',
      });
      const gain = createElement('input', {
        type: 'range',
        min: String(STEM_DESK_LIMITS.minGainDb),
        max: String(STEM_DESK_LIMITS.maxGainDb),
        step: '1',
        value: String(lane.gainDb),
        'aria-label': `${stemLabel(lane.name)} gain`,
      });
      const gainText = createElement('span', { class: 'stem-desk__meta', text: `${lane.gainDb} dB` });

      mute.addEventListener('click', () => {
        const next = !lane.muted;
        const nextState = desk.setMuted(lane.name, next);
        say(`${stemLabel(lane.name)} ${next ? 'muted' : 'unmuted'}.`);
        renderLanes(nextState);
      });
      solo.addEventListener('click', () => {
        const next = !lane.solo;
        const nextState = desk.setSolo(lane.name, next);
        const stateLane = nextState.lanes.find((entry) => entry.name === lane.name);
        const silentNote = next && stateLane?.silent
          ? ' This stem is effectively silent in this separation.'
          : '';
        say(`${next ? 'Solo' : 'Solo released for'} ${stemLabel(lane.name)}.${silentNote}`);
        renderLanes(nextState);
      });
      gain.addEventListener('input', (event) => {
        const nextState = desk.setGain(lane.name, event.target.value);
        gainText.textContent = `${event.target.value} dB`;
        renderLanes(nextState);
      });

      return createElement('div', { class: 'stem-desk__row' }, [
        createElement('div', {}, [
          createElement('div', { class: 'stem-desk__name', text: stemLabel(lane.name) }),
          createElement('div', { class: 'stem-desk__meta', text: provenanceLabel(lane) }),
          ...(lane.silent
            ? [createElement('div', {
              class: 'stem-desk__meta stem-desk__silent',
              text: 'effectively silent in this separation',
            })]
            : []),
        ]),
        createElement('div', { class: 'stem-desk__actions' }, [mute, solo, gain, gainText]),
      ]);
    }));
  }

  function refreshTransport() {
    const state = desk?.state();
    const playing = state?.status === 'playing';
    playButton.disabled = !state || (!playing && state.status !== 'ready') ? 'true' : undefined;
    stopButton.disabled = playing ? undefined : 'true';
    playButton.textContent = playing ? 'Restart' : 'Play';
    if (!playing) positionLabel.textContent = '0.0 s';
  }

  function startPositionTimer() {
    window.clearInterval(positionTimer);
    positionTimer = window.setInterval(() => {
      if (!desk) return;
      positionLabel.textContent = `${desk.position().toFixed(1)} s`;
    }, 200);
  }

  playButton.addEventListener('click', async () => {
    try {
      const before = await desk.resume();
      const state = desk.play({ loop: true });
      renderLanes(state);
      refreshTransport();
      startPositionTimer();
      if (before.contextState && before.contextState !== 'running' && before.contextState !== 'unknown') {
        say('The browser is still blocking audio. Press Play again to allow sound.');
      } else {
        say(`Playing ${state.lanes.length} stems together.`);
      }
    } catch (err) {
      say(err?.message || 'The stem desk could not start.');
    }
  });

  stopButton.addEventListener('click', () => {
    if (!desk) return;
    window.clearInterval(positionTimer);
    positionTimer = null;
    const state = desk.stop();
    renderLanes(state);
    positionLabel.textContent = '0.0 s';
    refreshTransport();
    say('Stem desk stopped.');
  });

  // Fetched on demand, never on mount: mounting the Studio must not add a
  // request to every page load or to unrelated component tests.
  function ensureTracks() {
    if (tracksLoaded) return Promise.resolve(true);
    if (tracksPending) return tracksPending;
    tracksPending = (async () => {
      try {
        const page = await listTracksImpl({ limit: 50 });
      const tracks = Array.isArray(page?.items)
        ? page.items
        : Array.isArray(page?.tracks)
          ? page.tracks
          : (Array.isArray(page) ? page : []);
      const options = tracks.map((track) => createElement('option', {
        value: track.id,
        text: track.title || track.name || track.originalName || track.id,
      }));
        replaceChildren(trackSelect, options.length
          ? options
          : [createElement('option', { value: '', text: 'No tracks in the library' })]);
        trackSelect.disabled = options.length === 0 ? 'true' : undefined;
        tracksLoaded = options.length > 0;
        say(options.length ? 'Choose a separated track, then load its stems.' : 'No tracks are available.');
        return options.length > 0;
      } catch (err) {
        say(`Could not list tracks: ${err?.message || 'request failed'}`);
        return false;
      } finally {
        tracksPending = null;
      }
    })();
    return tracksPending;
  }

  trackSelect.addEventListener('focus', () => { void ensureTracks(); });
  trackSelect.addEventListener('pointerdown', () => { void ensureTracks(); });

  loadButton.addEventListener('click', async () => {
    if (!tracksLoaded) await ensureTracks();
    const trackId = trackSelect.value;
    if (!trackId) {
      say('Choose a track first.');
      return;
    }
    abort?.abort();
    abort = typeof AbortController === 'function' ? new AbortController() : null;
    loadButton.disabled = 'true';
    say('Loading separated stems...');
    try {
      const stems = await listStemsImpl(trackId, abort?.signal);
      if (disposed) return;
      const variants = Array.isArray(stems?.variants) ? stems.variants : [];
      const lanes = selectLanes(variants);
      if (!lanes.length) {
        replaceChildren(lanesMount, []);
        refreshTransport();
        say('This track has no separated stems yet. Separate it in the Stem dialog first.');
        return;
      }
      const state = await ensureDesk().load(lanes.map((variant) => ({
        name: variant.name,
        label: stemLabel(variant.name),
        audioUrl: variant.audio_url,
        method: variant.method,
        modelName: variant.model_name,
        device: variant.device,
      })), { signal: abort?.signal });
      if (disposed) return;
      renderLanes(state);
      refreshTransport();
      if (state.status === 'unavailable') {
        say(`Stems unavailable: ${state.error?.message || 'no playable media'}`);
      } else if (state.error?.code === 'S_STEM_PARTIAL') {
        const missing = (state.error.failures || []).map((entry) => entry.name).join(', ');
        say(`Loaded ${state.lanes.length} stems. Unavailable: ${missing || 'some stems'}.`);
      } else {
        const silent = state.lanes
          .filter((entry) => entry.silent)
          .map((entry) => stemLabel(entry.name));
        say(
          silent.length
            ? `Loaded ${state.lanes.length} separated stems. ${silent.join(', ')} ` +
              `${silent.length === 1 ? 'is' : 'are'} effectively silent in this separation.`
            : `Loaded ${state.lanes.length} separated stems on one transport.`,
        );
      }
    } catch (err) {
      say(`Could not load stems: ${err?.message || 'request failed'}`);
    } finally {
      loadButton.disabled = undefined;
    }
  });

  return function dispose() {
    if (disposed) return;
    disposed = true;
    abort?.abort();
    window.clearInterval(positionTimer);
    positionTimer = null;
    desk?.dispose();
    desk = null;
    container.replaceChildren();
  };
}
