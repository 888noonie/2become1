// components/stem-desk-panel.js — Stem Performance Desk.
//
// Two separated tracks (groups A and B), up to four stem lanes each, one
// transport and one equal-power crossfader. Lanes are decoded by stem-desk.js
// and started together on a single AudioContext, so mute/solo/gain are exact
// gain-node values rather than UI-only state.
//
// Bounded by design: the panel loads each group on demand, aborts a stale
// request for that group, and disposes its desk (and its own AudioContext) on
// unmount. It reuses existing read-only stem endpoints; it never writes a
// stem, project or render.

import { createElement, replaceChildren } from '../dom.js';
import { listTracks, listStems } from '../api.js';
import { StemDesk, STEM_DESK_LIMITS } from '../runtime/stem-desk.js';

const STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'center', 'sides'];
const GROUP_IDS = ['A', 'B'];
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
 * no Demucs lane exists, and never exceed the per-track lane limit.
 */
function selectLanes(variants) {
  const usable = variants.filter((variant) => variant && variant.name && variant.name !== 'full');
  const byName = new Map(usable.map((variant) => [variant.name, variant]));
  const demucs = ['vocals', 'drums', 'bass', 'other']
    .filter((name) => byName.has(name))
    .map((name) => byName.get(name));
  const chosen = demucs.length ? demucs : usable.slice(0, STEM_DESK_LIMITS.maxLanesPerTrack);
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
  const withDevice = variant.device ? `${method} · ${variant.device}` : method;
  // The stem set id is what proves which separation produced this lane; two
  // tracks both have a "vocals", so the set is part of the identity.
  return variant.stemSetId
    ? `${withDevice} · set ${String(variant.stemSetId).slice(0, 8)}`
    : withDevice;
}

/** Group level is a second gain layer, independent of the crossfader. */
function groupLevelRow(groupId, onChange) {
  const input = createElement('input', {
    type: 'range',
    min: String(STEM_DESK_LIMITS.minLevelDb),
    max: String(STEM_DESK_LIMITS.maxLevelDb),
    step: '1',
    value: '0',
    class: 'stem-desk__level',
    'aria-label': `Group ${groupId} level`,
  });
  const text = createElement('span', { class: 'stem-desk__meta', text: '0 dB' });
  const row = createElement('div', { class: 'stem-desk__level-row' }, [
    createElement('span', { class: 'stem-desk__group-label', text: 'level' }),
    input,
    text,
  ]);
  input.addEventListener('input', (event) => {
    text.textContent = `${event.target.value} dB`;
    onChange?.(event.target.value);
  });
  return { row, input, text };
}

function groupLabel(trackId) {
  return String(trackId);
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
  const status = createElement('p', { class: 'stem-desk__status', role: 'status', text: 'Choose separated tracks for group A and group B.' });
  const groupControls = createElement('div', { class: 'stem-desk__groups' });
  const groupSelects = {};
  const groupButtons = {};
  for (const groupId of GROUP_IDS) {
    const select = createElement('select', {
      class: 'stem-desk__select',
      'aria-label': `Track for group ${groupId}`,
    }, [createElement('option', { value: '', text: 'Choose a track…' })]);
    const loadButton = createElement('button', {
      class: 'button button--sm stem-desk__load',
      type: 'button',
      text: `Load ${groupId}`,
      'aria-label': `Load stems ${groupId}`,
      dataset: { group: groupId },
    });
    const row = createElement('div', { class: 'stem-desk__group-controls', dataset: { group: groupId } }, [
      createElement('span', { class: 'stem-desk__group-label', text: `Group ${groupId}` }),
      select,
      loadButton,
    ]);
    groupSelects[groupId] = select;
    groupButtons[groupId] = loadButton;
    groupControls.appendChild(row);
  }
  const playButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Play', disabled: 'true' });
  const stopButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Stop', disabled: 'true' });
  const positionLabel = createElement('span', { class: 'stem-desk__meta', text: '0.0 s' });
  const transport = createElement('div', { class: 'stem-desk__actions stem-desk__transport' }, [playButton, stopButton, positionLabel]);
  const crossfaderInput = createElement('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: '50',
    class: 'stem-desk__crossfader',
    'aria-label': 'Crossfader A to B',
  });
  const crossfaderGains = createElement('span', { class: 'stem-desk__meta stem-desk__crossfader-gains', text: 'gainA 1.00 · gainB 0.00' });
  const crossfader = createElement('div', { class: 'stem-desk__crossfader-row' }, [
    createElement('span', { class: 'stem-desk__group-label', text: 'A / B' }),
    crossfaderInput,
    crossfaderGains,
  ]);
  const lanesMount = createElement('div', { class: 'stem-desk__lanes' });
  const note = createElement('p', { class: 'stem-desk__note', hidden: 'true' });
  const policy = createElement('p', {
    class: 'stem-desk__meta stem-desk__policy',
    text: 'Solo applies across both tracks. The crossfader and each group level still apply on top, so a soloed lane on a closed track is silent.',
  });

  container.replaceChildren(root);
  replaceChildren(root, [
    title,
    groupControls,
    status,
    transport,
    crossfader,
    policy,
    lanesMount,
    note,
  ]);

  let desk = null;
  const aborts = new Map();
  let positionTimer = null;
  let disposed = false;
  let tracksLoaded = false;
  let tracksPending = null;
  const rowViews = new Map();
  const groupViews = new Map();

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

  function trackTitle(trackId) {
    for (const groupId of GROUP_IDS) {
      const select = groupSelects[groupId];
      if (select.value !== trackId) continue;
      const option = [...select.options].find((entry) => entry.value === trackId);
      if (option) return option.textContent;
    }
    const option = [...groupSelects.A.options].find((entry) => entry.value === trackId);
    return option ? option.textContent : trackId;
  }

  function createRowView(key) {
    const nameEl = createElement('div', { class: 'stem-desk__name' });
    const metaEl = createElement('div', { class: 'stem-desk__meta' });
    const silentEl = createElement('div', { class: 'stem-desk__meta stem-desk__silent' });
    const mute = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'M',
    });
    const solo = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'S',
    });
    const gain = createElement('input', {
      type: 'range',
      min: String(STEM_DESK_LIMITS.minGainDb),
      max: String(STEM_DESK_LIMITS.maxGainDb),
      step: '1',
      value: '0',
    });
    const gainText = createElement('span', { class: 'stem-desk__meta', text: '0 dB' });
    const row = createElement('div', { class: 'stem-desk__row', dataset: { key } }, [
      createElement('div', {}, [nameEl, metaEl, silentEl]),
      createElement('div', { class: 'stem-desk__actions' }, [mute, solo, gain, gainText]),
    ]);
    const view = { key, row, nameEl, metaEl, silentEl, mute, solo, gain, gainText, lane: null };

    mute.addEventListener('click', () => {
      if (!view.lane) return;
      const label = `${groupLabel(view.lane.trackId)} · ${stemLabel(view.lane.name)}`;
      const next = !view.lane.muted;
      const nextState = desk.setMuted(view.lane.key, next);
      say(`${label} ${next ? 'muted' : 'unmuted'}.`);
      renderLanes(nextState);
    });
    solo.addEventListener('click', () => {
      if (!view.lane) return;
      const label = `${groupLabel(view.lane.trackId)} · ${stemLabel(view.lane.name)}`;
      const next = !view.lane.solo;
      const nextState = desk.setSolo(view.lane.key, next);
      const stateLane = nextState.lanes.find((entry) => entry.key === view.lane.key);
      const silentNote = next && stateLane?.silent
        ? ' This stem is effectively silent in this separation.'
        : '';
      say(`${next ? 'Solo' : 'Solo released for'} ${label}.${silentNote}`);
      renderLanes(nextState);
    });
    gain.addEventListener('input', (event) => {
      if (!view.lane) return;
      const nextState = desk.setGain(view.lane.key, event.target.value);
      const stateLane = nextState.lanes.find((entry) => entry.key === view.key);
      if (stateLane) view.lane = stateLane;
      // The row itself is deliberately not rebuilt: only its own readout and
      // live gain-node state change while the user drags.
      gainText.textContent = `${event.target.value} dB`;
    });

    rowViews.set(key, view);
    return view;
  }

  function updateRowView(view, lane) {
    view.lane = lane;
    const label = `${groupLabel(lane.trackId)} · ${stemLabel(lane.name)}`;
    view.nameEl.textContent = stemLabel(lane.name);
    view.metaEl.textContent = provenanceLabel(lane);
    view.silentEl.textContent = lane.silent ? 'effectively silent in this separation' : '';
    view.silentEl.hidden = !lane.silent;
    view.mute.setAttribute('aria-label', `Mute ${label}`);
    view.mute.setAttribute('aria-pressed', lane.muted ? 'true' : 'false');
    view.solo.setAttribute('aria-label', `Solo ${label}`);
    view.solo.setAttribute('aria-pressed', lane.solo ? 'true' : 'false');
    view.gain.setAttribute('aria-label', `${label} gain`);
    view.gain.value = String(lane.gainDb);
    view.gainText.textContent = `${lane.gainDb} dB`;
  }

  function renderLanes(state) {
    const lanes = state?.lanes || [];
    const groups = state?.groups || [];
    const anyFallback = lanes.some((lane) => lane.name === 'center' || lane.name === 'sides');
    note.hidden = !anyFallback;
    note.textContent = anyFallback ? FALLBACK_NOTE : '';

    const liveGroupIds = new Set(groups.map((group) => group.trackId));
    for (const [groupId, view] of groupViews) {
      if (!liveGroupIds.has(groupId)) {
        view.section.remove();
        groupViews.delete(groupId);
      }
    }

    for (const group of groups) {
      let view = groupViews.get(group.trackId);
      if (!view) {
        const heading = createElement('h3', { class: 'stem-desk__group-title' });
        const rows = createElement('div', { class: 'stem-desk__group-rows' });
        const level = groupLevelRow(group.trackId, (value) => {
          if (!desk) return;
          const next = desk.setTrackLevel(group.trackId, value);
          refreshTransport(next);
          say(`Group ${group.trackId} level ${value} dB.`);
        });
        const section = createElement('section', {
          class: 'stem-desk__group',
          dataset: { group: group.trackId },
        }, [heading, level.row, rows]);
        view = { section, heading, rows, level };
        groupViews.set(group.trackId, view);
        lanesMount.appendChild(section);
      }
      view.heading.textContent = `Group ${group.trackId} · ${group.title}`;
      view.level.input.value = String(group.levelDb ?? 0);
      view.level.text.textContent = `${group.levelDb ?? 0} dB`;
      const groupLanes = lanes.filter((lane) => lane.trackId === group.trackId);
      const rows = groupLanes.map((lane) => {
        const rowView = rowViews.get(lane.key) || createRowView(lane.key);
        updateRowView(rowView, lane);
        return rowView.row;
      });
      // replaceChildren moves the existing row nodes instead of recreating
      // them, so a gain drag keeps the same element and focus.
      replaceChildren(view.rows, rows);
    }

    const liveKeys = new Set(lanes.map((lane) => lane.key));
    for (const [key, view] of rowViews) {
      if (!liveKeys.has(key)) {
        view.row.remove();
        rowViews.delete(key);
      }
    }
  }

  function updateCrossfader(state) {
    const value = state?.crossfader || { position: 50, gainA: 0, gainB: 0, disabled: true };
    crossfaderInput.value = String(value.position);
    crossfaderInput.disabled = Boolean(value.disabled);
    crossfaderGains.textContent = `gainA ${value.gainA.toFixed(2)} · gainB ${value.gainB.toFixed(2)}`;
    crossfaderInput.setAttribute(
      'aria-valuetext',
      `gainA ${value.gainA.toFixed(2)}, gainB ${value.gainB.toFixed(2)}`,
    );
  }

  function refreshTransport(state = desk?.state()) {
    const playing = state?.status === 'playing';
    const hasLanes = Boolean(state?.lanes?.length);
    playButton.disabled = !hasLanes || (!playing && state.status !== 'ready') ? 'true' : undefined;
    stopButton.disabled = playing ? undefined : 'true';
    playButton.textContent = playing ? 'Restart' : 'Play';
    if (!playing) positionLabel.textContent = '0.0 s';
    if (state) updateCrossfader(state);
  }

  function startPositionTimer() {
    window.clearInterval(positionTimer);
    positionTimer = window.setInterval(() => {
      if (!desk) return;
      const state = desk.state();
      if (state.status !== 'playing') {
        window.clearInterval(positionTimer);
        positionTimer = null;
        positionLabel.textContent = '0.0 s';
        refreshTransport(state);
        renderLanes(state);
        if (state.status === 'ready') say('The stem desk reached the end.');
        return;
      }
      positionLabel.textContent = `${state.positionSeconds.toFixed(1)} s`;
    }, 200);
  }

  playButton.addEventListener('click', async () => {
    try {
      const before = await desk.resume();
      // The accepted single-track desk loops, so preserve that exactly.
      // Two tracks are a performance mix: play once, stop at the longest lane,
      // because looping unequal-length tracks would wrap them out of phase.
      const groups = desk.state().groups || [];
      const loop = groups.length <= 1;
      const state = desk.play({ loop });
      renderLanes(state);
      refreshTransport(state);
      startPositionTimer();
      if (before.contextState && before.contextState !== 'running' && before.contextState !== 'unknown') {
        say('The browser is still blocking audio. Press Play again to allow sound.');
      } else if (loop) {
        say(`Looping ${state.lanes.length} lanes started on one clock.`);
      } else {
        say(
          `Started ${state.lanes.length} lanes on one clock. Playback ends with the longest lane; ` +
          'this is a shared start, not tempo or beat matching.',
        );
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
    refreshTransport(state);
    say('Stem desk stopped.');
  });

  crossfaderInput.addEventListener('input', (event) => {
    if (!desk) return;
    const state = desk.setCrossfader(event.target.value);
    updateCrossfader(state);
    say(`Crossfader A ${state.crossfader.gainA.toFixed(2)} / B ${state.crossfader.gainB.toFixed(2)}.`);
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
        for (const groupId of GROUP_IDS) {
          const select = groupSelects[groupId];
          const previous = select.value;
          replaceChildren(select, options.length
            ? options.map((option) => option.cloneNode(true))
            : [createElement('option', { value: '', text: 'No tracks in the library' })]);
          select.disabled = options.length === 0 ? 'true' : undefined;
          if (previous && options.some((option) => option.value === previous)) select.value = previous;
          else if (options.length) select.value = options[0].value;
        }
        tracksLoaded = options.length > 0;
        say(options.length
          ? 'Choose separated tracks for A and B, then load each group.'
          : 'No tracks are available.');
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

  for (const groupId of GROUP_IDS) {
    const select = groupSelects[groupId];
    select.addEventListener('focus', () => { void ensureTracks(); });
    select.addEventListener('pointerdown', () => { void ensureTracks(); });

    groupButtons[groupId].addEventListener('click', async () => {
      if (!tracksLoaded) await ensureTracks();
      const trackId = select.value;
      if (!trackId) {
        say(`Choose a track for group ${groupId} first.`);
        return;
      }
      aborts.get(groupId)?.abort();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (controller) aborts.set(groupId, controller);
      const button = groupButtons[groupId];
      button.disabled = 'true';
      say(`Loading separated stems for group ${groupId}...`);
      try {
        const stems = await listStemsImpl(trackId, controller?.signal);
        if (disposed) return;
        const variants = Array.isArray(stems?.variants) ? stems.variants : [];
        const lanes = selectLanes(variants);
        if (!lanes.length) {
          refreshTransport();
          say(`Group ${groupId}: this track has no separated stems yet. Separate it in the Stem dialog first.`);
          return;
        }
        const state = await ensureDesk().loadGroups([{
          trackId: groupId,
          title: trackTitle(trackId),
          lanes: lanes.map((variant) => ({
            name: variant.name,
            label: stemLabel(variant.name),
            audioUrl: variant.audio_url,
            method: variant.method,
            modelName: variant.model_name,
            device: variant.device,
            stemSetId: variant.stem_set_id,
          })),
        }], { signal: controller?.signal });
        if (disposed) return;
        renderLanes(state);
        refreshTransport(state);
        const groupLanes = state.lanes.filter((entry) => entry.trackId === groupId);
        if (!groupLanes.length) {
          say(`Group ${groupId} was refused: ${state.error?.message || 'no playable media'}`);
        } else if (state.error?.code === 'S_DESK_FULL') {
          say(`Group ${groupId} was refused by the memory budget. The other group is unchanged.`);
        } else if (state.error?.code === 'S_STEM_PARTIAL') {
          const missing = (state.error.failures || [])
            .filter((entry) => entry.name !== groupId)
            .map((entry) => entry.name)
            .join(', ');
          say(`Loaded ${groupLanes.length} stems into group ${groupId}. Unavailable: ${missing || 'some stems'}.`);
        } else {
          const silent = groupLanes
            .filter((entry) => entry.silent)
            .map((entry) => stemLabel(entry.name));
          say(
            silent.length
              ? `Loaded ${groupLanes.length} stems into group ${groupId}. ${silent.join(', ')} ` +
                `${silent.length === 1 ? 'is' : 'are'} effectively silent in this separation.`
              : `Loaded ${groupLanes.length} stems into group ${groupId} on one transport.`,
          );
        }
      } catch (err) {
        say(`Could not load group ${groupId}: ${err?.message || 'request failed'}`);
      } finally {
        if (!controller || aborts.get(groupId) === controller) aborts.delete(groupId);
        button.disabled = undefined;
      }
    });
  }

  return function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of aborts.values()) controller.abort();
    aborts.clear();
    window.clearInterval(positionTimer);
    positionTimer = null;
    desk?.dispose();
    desk = null;
    container.replaceChildren();
  };
}
