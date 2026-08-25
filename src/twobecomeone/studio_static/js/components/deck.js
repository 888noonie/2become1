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
import { store, projectManager } from '../app-context.js';
import { openAnalysisDialog } from './analysis-dialog.js';
import { openStemDialog } from './stem-dialog.js';

export function mountDeck({ container, role, onAnnounce }) {
  const disposers = [];
  let waveformDisposer = null;
  let currentTrackId = null;
  let currentTrack = null;

  const root = createElement('section', {
    class: `deck deck--${role}`,
    'aria-label': `${role === 'anchor' ? 'Foundation' : 'Lead'} Deck`,
  });
  container.replaceChildren(root);

  function render(state) {
    const project = state.currentProject || {};
    const trackId = role === 'anchor' ? project.anchor_track_id : project.lead_track_id;
    const variant = (role === 'anchor' ? project.anchor_variant : project.lead_variant) || 'full';
    const track = trackId ? state.deckTracks[trackId] : null;

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

    if (track === null && trackId) {
      // Explicit missing/trashed state (recoverable, not substituted)
      if (waveformDisposer) {
        waveformDisposer();
        waveformDisposer = null;
      }
      currentTrackId = trackId;
      currentTrack = null;

      const missingBody = createElement('div', { class: 'deck__missing' }, [
        createElement('p', {
          class: 'deck__missing-text',
          text: 'Track unavailable (missing or moved to trash).',
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
          // Play full or variant
          const url = variant === 'full'
            ? track.audio_url
            : `/api/stems/by-track/${encodeURIComponent(track.id)}/audio?name=${encodeURIComponent(variant)}`;
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

    // Waveform container
    const waveformWrapper = createElement('div', { class: 'deck__waveform-wrapper' });

    replaceChildren(root, [
      createElement('div', { class: 'deck__header' }, [roleBadge, provenanceEl]),
      createElement('div', { class: 'deck__info' }, [artEl, createElement('div', { class: 'deck__details' }, [titleEl, metaRow, variantRow])]),
      transport,
      waveformWrapper,
      actionsBar,
    ]);

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

    if (waveformDisposer) {
      waveformDisposer();
      waveformDisposer = null;
    }

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
    });
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
