// components/deck.js — accessible Deck component for Foundation and Lead.
//
// Phase 5 (Tasks 3–5): artwork, safe display title, provenance, effective
// BPM/key/confidence, duration, selected source variant, transport,
// waveform, and Choose/Replace, Edit analysis, Separate, Open in Library, and
// Clear actions.

import { createElement, replaceChildren } from '../dom.js';
import { audioController } from '../audio.js';
import { openSourcePicker } from './source-picker.js';
import { mountWaveform } from '../waveform.js';
import { formatBpm, formatKey, formatTime, sourceLabel } from '../format.js';
import { store as globalStore, projectManager as globalProjectManager } from '../app-context.js';
import { openAnalysisDialog } from './analysis-dialog.js';
import { openStemDialog } from './stem-dialog.js';
import { showToast } from './toast.js';
import { listStems } from '../api.js';

// Module cache for per-track variant URL lookups used by deck playback.
const stemFetchControllers = new Map();

function getVariantAudioUrl(state, trackId, variant) {
  if (variant === 'full') return null;
  const cached = state.stems?.[trackId];
  if (cached?.variants) {
    const v = cached.variants.find((entry) => entry.name === variant);
    return v?.audio_url || null;
  }
  return null;
}

async function loadStemsForTrack(trackId, store) {
  const previous = stemFetchControllers.get(trackId);
  if (previous) previous.abort();
  const controller = new AbortController();
  stemFetchControllers.set(trackId, controller);
  try {
    const data = await listStems(trackId, controller.signal);
    store.dispatch({ type: 'stems/set', trackId, data });
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    console.error('failed to load stems for deck', err);
    return null;
  } finally {
    if (stemFetchControllers.get(trackId) === controller) {
      stemFetchControllers.delete(trackId);
    }
  }
}

export function mountDeck({ container, role, onAnnounce, store = globalStore, projectManager = globalProjectManager, onSelectPhrase = null, onRegionSelected = null }) {
  if (!container) {
    throw new Error('mountDeck requires a container');
  }
  const disposers = [];
  let waveformDisposer = null;
  let currentTrackId = null;
  let currentTrack = null;
  // Phase 10C: the id of the track whose waveform is currently MOUNTED. This
  // is distinct from currentTrackId (the deck's assigned track) so the mount
  // guard can detect a real track change even though currentTrackId is set
  // early in render().
  let mountedWaveformKey = null;
  // Phase 10C: the waveform wrapper is hoisted to module scope so it persists
  // across renders. Recreating it inside render() would discard the mounted
  // waveform (and any in-progress region drag) on every store change.
  const waveformWrapper = createElement('div', { class: 'deck__waveform-wrapper' });
  // Phase 10C: per-deck component state (never application state): region
  // mode armed flag. The waveform region hooks are built here so they survive
  // re-renders (the deck owns deckState.regionArmed).
  const deckState = { regionArmed: false };
  // Region hooks factory: armed only when the user pressed "Select phrase".
  const regionHooksFactory = () => ({
    isArmed: () => deckState.regionArmed,
    onRegionSelected: ({ startSeconds, endSeconds }) => {
      deckState.regionArmed = false; // single-shot
      render(store.getState());
      if (onRegionSelected) onRegionSelected({ startSeconds, endSeconds });
    },
    onRegionCancelled: () => {
      deckState.regionArmed = false;
      render(store.getState());
    },
  });

  const root = createElement('section', {
    class: `deck deck--${role}`,
    'aria-label': `${role === 'anchor' ? 'Foundation' : 'Lead'} Deck`,
  });
  container.replaceChildren(root);

  let lastState = null;

  function render(state) {
    lastState = state;
    const project = state.currentProject || {};
    const trackId = role === 'anchor' ? project.anchor_track_id : project.lead_track_id;
    const variant = (role === 'anchor' ? project.anchor_variant : project.lead_variant) || 'full';
    // Treat explicit null (unresolvable) and undefined (not yet resolved) as
    // missing until we have a real track record. This avoids throwing on
    // undefined during boot/refresh.
    const track = trackId ? (state.deckTracks[trackId] ?? undefined) : null;

    // Header / role label
    const roleBadge = createElement('span', {
      class: `deck__role-badge deck__role-badge--${role}`,
      text: role === 'anchor' ? 'Foundation' : 'Lead',
    });

    if (!trackId) {
      // Empty state
      if (waveformDisposer) {
        waveformDisposer();
        waveformDisposer = null;
      }
      currentTrackId = null;
      currentTrack = null;
      mountedWaveformKey = null;
      const emptyBody = createElement('div', { class: 'deck__empty' }, [
        createElement('p', {
          class: 'deck__empty-text',
          text: `No track chosen for ${role === 'anchor' ? 'Foundation' : 'Lead'}.`,
        }),
        createElement('button', {
          class: 'button button--primary',
          type: 'button',
          text: 'Choose Track',
          onclick: () => openSourcePicker(store, role),
        }),
      ]);

      replaceChildren(root, [
        createElement('div', { class: 'deck__header' }, [roleBadge]),
        emptyBody,
      ]);
      return;
    }

    if (track === null || track === undefined) {
      // Explicit missing/trashed state or still resolving (recoverable, not substituted)
      if (waveformDisposer) {
        waveformDisposer();
        waveformDisposer = null;
      }
      // Reset currentTrackId so a later resolution of the SAME track id still
      // counts as a change and mounts the waveform (the guard compares ids).
      currentTrackId = null;
      currentTrack = null;
      mountedWaveformKey = null;

      const isResolving = track === undefined;
      const missingBody = createElement('div', { class: 'deck__missing' }, [
        createElement('p', {
          class: 'deck__missing-text',
          text: isResolving
            ? 'Resolving track…'
            : 'Track unavailable (missing or moved to trash).',
        }),
        createElement('div', { class: 'deck__missing-actions' }, [
          createElement('button', {
            class: 'button button--primary',
            type: 'button',
            text: 'Replace Track',
            onclick: () => openSourcePicker(store, role),
          }),
          createElement('button', {
            class: 'button',
            type: 'button',
            text: 'Clear',
            onclick: () => projectManager.clear(role),
          }),
        ]),
      ]);

      replaceChildren(root, [
        createElement('div', { class: 'deck__header' }, [roleBadge]),
        missingBody,
      ]);
      return;
    }

    // Populated track state
    currentTrackId = trackId;
    currentTrack = track;

    // Artwork
    const artEl = createElement('div', { class: 'deck__art' });
    if (track.artwork_url) {
      artEl.appendChild(createElement('img', {
        src: track.artwork_url,
        alt: '',
        class: 'deck__art-img',
      }));
    } else {
      artEl.appendChild(createElement('div', {
        class: 'deck__art-placeholder',
        text: (track.name || '?').slice(0, 2).toUpperCase(),
      }));
    }

    // Metadata
    const titleEl = createElement('h3', { class: 'deck__title', text: track.name });
    const provenanceEl = createElement('span', {
      class: 'deck__provenance',
      text: sourceLabel(track.source_kind),
    });

    const bpmText = `${formatBpm(track)} BPM`;
    const keyText = formatKey(track);
    const durationText = formatTime(track.duration);

    const confidenceVal = track.confidence ?? track.key?.confidence;
    const confidenceText = typeof confidenceVal === 'number' && confidenceVal < 0.6
      ? 'Check this'
      : (typeof confidenceVal === 'number' ? `${Math.round(confidenceVal * 100)}%` : null);

    const badges = [
      createElement('span', { class: 'badge', text: bpmText }),
      createElement('span', { class: 'badge', text: keyText }),
      createElement('span', { class: 'badge', text: durationText }),
    ];
    if (confidenceText) {
      badges.push(createElement('span', {
        class: `badge ${confidenceText === 'Check this' ? 'badge--warning' : ''}`,
        text: `Conf: ${confidenceText}`,
      }));
    }

    const metaRow = createElement('div', { class: 'deck__meta-row' }, badges);

    // Selected variant label
    const variantRow = createElement('div', { class: 'deck__variant-row' }, [
      createElement('span', { class: 'deck__variant-label', text: 'Variant:' }),
      createElement('span', {
        class: 'badge badge--variant',
        text: variant === 'full' ? 'Full Mix' : variant,
      }),
    ]);

    // Transport (Play / Pause / Stop)
    const playback = state.playback;
    const isThisPlaying = playback.playing && (
      (playback.source && playback.source.trackId === track.id) ||
      (playback.trackId === track.id)
    );

    const playBtn = createElement('button', {
      class: `button ${isThisPlaying ? 'button--primary' : ''}`,
      type: 'button',
      text: isThisPlaying ? 'Pause' : 'Play',
      'aria-label': `${isThisPlaying ? 'Pause' : 'Play'} ${role === 'anchor' ? 'Foundation' : 'Lead'}`,
      onclick: () => {
        if (isThisPlaying) {
          audioController.pause();
        } else {
          // Use the structured server-authored audio URL. For full mix it is
          // the track audio endpoint; for stems it comes from the stem tray.
          let url = track.audio_url;
          if (variant !== 'full') {
            const variantUrl = getVariantAudioUrl(store.getState(), track.id, variant);
            if (variantUrl) {
              url = variantUrl;
            } else {
              // Load stems once, then retry the click by re-rendering.
              loadStemsForTrack(track.id, store).then(() => {
                const freshUrl = getVariantAudioUrl(store.getState(), track.id, variant);
                if (freshUrl) {
                  audioController.play({
                    trackId: track.id,
                    url: freshUrl,
                    kind: 'stem',
                    stemName: variant,
                    variant,
                  });
                } else {
                  showToast?.(`Variant "${variant}" is not available for playback.`, 'danger');
                }
              });
              return;
            }
          }
          audioController.play({
            trackId: track.id,
            url,
            kind: variant === 'full' ? 'track' : 'stem',
            stemName: variant === 'full' ? null : variant,
            variant,
          });
        }
      },
    });

    const stopBtn = createElement('button', {
      class: 'button',
      type: 'button',
      text: 'Stop',
      'aria-label': `Stop ${role === 'anchor' ? 'Foundation' : 'Lead'} playback`,
      onclick: () => {
        audioController.stop();
      },
    });

    const transport = createElement('div', { class: 'deck__transport' }, [playBtn, stopBtn]);

    // Actions bar
    const actionsBar = createElement('div', { class: 'deck__actions' }, [
      createElement('button', {
        class: 'button',
        type: 'button',
        text: 'Replace',
        onclick: () => openSourcePicker(store, role),
      }),
      createElement('button', {
        class: 'button',
        type: 'button',
        text: 'Edit Analysis',
        onclick: () => openAnalysisDialog({ track, store, onAnnounce }),
      }),
      createElement('button', {
        class: 'button',
        type: 'button',
        text: 'Separate',
        onclick: () => openStemDialog({ track, role, store, onAnnounce }),
      }),
      createElement('button', {
        class: 'button',
        type: 'button',
        text: 'Library',
        title: 'Open in Library',
        onclick: () => {
          window.location.hash = '#/library';
        },
      }),
      createElement('button', {
        class: 'button',
        type: 'button',
        text: 'Clear',
        onclick: () => projectManager.clear(role),
      }),
    ]);

    // Waveform container (hoisted to module scope so it persists across
    // renders — see the declaration above).

    // Phase 10C: "Select phrase" — visible only on the Foundation deck.
    // Clicking opens the dialog directly (keyboard/AT parity path). The
    // waveform drag is an alternative that pre-fills the dialog: the button
    // toggles drag-arming; when armed, dragging on the waveform opens the
    // dialog with the dragged region pre-filled. The Lead deck never shows it.
    let selectPhraseBtn = null;
    if (role === 'anchor') {
      selectPhraseBtn = createElement('button', {
        class: `button deck__select-phrase ${deckState.regionArmed ? 'button--primary' : ''}`,
        type: 'button',
        text: deckState.regionArmed ? 'Select phrase on waveform…' : 'Select phrase',
        'aria-pressed': deckState.regionArmed ? 'true' : 'false',
        'aria-label': 'Select a vocal phrase region on the Foundation waveform',
        onclick: () => {
          if (deckState.regionArmed) {
            // Already armed: open the dialog directly (keyboard path).
            deckState.regionArmed = false;
            if (onSelectPhrase) onSelectPhrase();
          } else {
            deckState.regionArmed = true;
            onAnnounce?.('Region selection armed. Drag across the waveform to choose a phrase, or click again to type beats; Escape cancels.');
          }
          render(store.getState());
        },
      });
    }

    const cardChildren = [
      createElement('div', { class: 'deck__header' }, [roleBadge, provenanceEl]),
      createElement('div', { class: 'deck__info' }, [artEl, createElement('div', { class: 'deck__details' }, [titleEl, metaRow, variantRow])]),
      transport,
      waveformWrapper,
      actionsBar,
    ];
    if (selectPhraseBtn) {
      // Insert above the waveform for a natural top-to-bottom flow.
      cardChildren.splice(3, 0, selectPhraseBtn);
    }

    replaceChildren(root, cardChildren);

    // Mount or refresh waveform
    const getCue = () => {
      const proj = store.getState().currentProject || {};
      const s = proj.settings || {};
      return role === 'anchor'
        ? (s.anchor_start ?? 0)
        : (s.lead_start ?? 0);
    };

    const onSetCue = (seconds) => {
      const proj = store.getState().currentProject || {};
      const s = proj.settings || {};
      const key = role === 'anchor' ? 'anchor_start' : 'lead_start';
      const settings = { ...s, [key]: seconds };
      projectManager.save({ settings });
    };

    const isSnapEnabled = () => {
      const proj = store.getState().currentProject || {};
      return (proj.settings || {}).snap !== false;
    };

    const getTime = () => {
      const p = store.getState().playback;
      if (p.playing && ((p.source && p.source.trackId === track.id) || p.trackId === track.id)) {
        return audioController.time;
      }
      return getCue() || 0;
    };

    const onSeek = (seconds) => {
      const p = store.getState().playback;
      if (p.playing && ((p.source && p.source.trackId === track.id) || p.trackId === track.id)) {
        audioController.seek(seconds);
      }
    };

    // Mount or refresh waveform. Guard: only re-mount when the track identity
    // changes, NOT on every render (audio timeupdate ticks fire render() and
    // would otherwise destroy an in-progress region drag — Sol amendment 11).
    const grid = track?.beat_grid || {};
    const waveformKey = track ? [
      track.id, track.name, track.duration, track.bpm,
      grid.first_beat, grid.interval, grid.suggested_downbeat,
    ].join('|') : null;
    const waveformChanged = waveformKey !== mountedWaveformKey;
    if (waveformChanged) {
      if (waveformDisposer) {
        waveformDisposer();
        waveformDisposer = null;
      }
      mountedWaveformKey = waveformKey;
    }
    if (waveformChanged && track) {
      try {
        waveformDisposer = mountWaveform({
          container: waveformWrapper,
          track,
          role,
          getTime,
          onSeek,
          getCue,
          onSetCue,
          isSnapEnabled,
          onAnnounce,
          // Phase 10C OPTIONAL region hooks: only armed when the user pressed
          // "Select phrase". When un-armed, pointer behaviour is identical to V0.3.
          regionHooks: role === 'anchor' && regionHooksFactory
            ? regionHooksFactory()
            : null,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[deck] mountWaveform failed', err);
      }
    }
    const mountedCanvas = waveformWrapper.querySelector('.waveform__canvas');
    if (mountedCanvas) {
      if (deckState.regionArmed) mountedCanvas.setAttribute('data-region-mode', 'true');
      else mountedCanvas.removeAttribute('data-region-mode');
    }
  }
  const unsubscribe = store.subscribe((state) => {
    render(state);
  });
  disposers.push(unsubscribe);

  // Audio timeupdate -> tick active waveform playhead
  const audioUnsub = audioController.on((type, payload) => {
    if (type === 'time') {
      const waveformRoot = root.querySelector('.waveform');
      if (waveformRoot && typeof waveformRoot.__tick === 'function') {
        waveformRoot.__tick();
      }
    }
  });
  disposers.push(audioUnsub);

  render(store.getState());

  return function dispose() {
    if (waveformDisposer) {
      waveformDisposer();
      waveformDisposer = null;
    }
    for (const d of disposers) d();
  };
}
