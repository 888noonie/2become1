// components/performance-deck.js — dual-mode Studio surface.
//
// DJ mode preserves the detailed waveform/editor workflow. FUN mode is a
// touch-first projection of the same project: its launch pads use the one
// authoritative audio player and its mix controls edit the real render plan.

import { createElement, replaceChildren } from '../dom.js';
import { audioController } from '../audio.js';
import { listStems } from '../api.js';
import { showToast } from './toast.js';

const MODE_KEY = '2become1.deck-mode';
const BAR_COUNTS = [1, 2, 4, 8];

export function normalizeDeckMode(value) {
  return value === 'fun' ? 'fun' : 'dj';
}

export function durationForBars(bars, bpm) {
  const safeBars = BAR_COUNTS.includes(Number(bars)) ? Number(bars) : 4;
  const safeBpm = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Number(bpm) : 120;
  return Number((safeBars * 4 * 60 / safeBpm).toFixed(3));
}

export function gainsForBlend(value) {
  const position = Math.max(0, Math.min(100, Number(value))) / 100;
  return {
    anchor_gain: Number(Math.cos(position * Math.PI / 2).toFixed(3)),
    lead_gain: Number(Math.sin(position * Math.PI / 2).toFixed(3)),
  };
}

function effectiveBpm(track) {
  const value = track?.bpm?.effective ?? track?.bpm?.override ?? track?.bpm?.detected ?? track?.bpm;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function findBlend(settings) {
  const anchor = Number(settings.anchor_gain ?? 0.8);
  const lead = Number(settings.lead_gain ?? 0.8);
  if (anchor <= 0 && lead <= 0) return 50;
  return Math.round(Math.atan2(Math.max(0, lead), Math.max(0, anchor)) / (Math.PI / 2) * 100);
}

async function playSlot({ track, variant, store }) {
  let url = track.audio_url;
  let kind = 'track';
  if (variant && variant !== 'full') {
    let data = store.getState().stems?.[track.id];
    if (!data?.variants) {
      data = await listStems(track.id);
      store.dispatch({ type: 'stems/set', trackId: track.id, data });
    }
    const selected = data?.variants?.find((entry) => entry.name === variant);
    if (!selected?.audio_url) {
      throw new Error(`The ${variant} source is not ready. Open Separate on the DJ deck.`);
    }
    url = selected.audio_url;
    kind = 'stem';
  }
  audioController.play({
    trackId: track.id,
    url,
    kind,
    stemName: kind === 'stem' ? variant : null,
    variant: variant || 'full',
  });
}

function trackForRole(state, role) {
  const project = state.currentProject || {};
  const id = role === 'anchor' ? project.anchor_track_id : project.lead_track_id;
  return id ? state.deckTracks[id] : null;
}

function performanceSlot({ role, state, store, onAnnounce }) {
  const project = state.currentProject || {};
  const track = trackForRole(state, role);
  const label = role === 'anchor' ? 'Foundation' : 'Lead';
  const variant = (role === 'anchor' ? project.anchor_variant : project.lead_variant) || 'full';
  const isPlaying = Boolean(track && state.playback.playing && (
    state.playback.source?.trackId === track.id || state.playback.trackId === track.id
  ));

  if (!track) {
    return createElement('article', { class: `performance-pad performance-pad--empty performance-pad--${role}` }, [
      createElement('span', { class: 'performance-pad__index', text: role === 'anchor' ? '01' : '02' }),
      createElement('div', { class: 'performance-pad__orb', 'aria-hidden': 'true', text: '+' }),
      createElement('strong', { text: `${label} empty` }),
      createElement('a', { class: 'button', href: '#/library', text: 'Choose track' }),
    ]);
  }

  const bpm = effectiveBpm(track);
  const title = track.name || `${label} track`;
  const playButton = createElement('button', {
    class: `performance-pad__launch ${isPlaying ? 'performance-pad__launch--active' : ''}`,
    type: 'button',
    'aria-pressed': isPlaying ? 'true' : 'false',
    'aria-label': `${isPlaying ? 'Pause' : 'Play'} ${label}: ${title}`,
    onclick: async () => {
      if (isPlaying) {
        audioController.pause();
        onAnnounce?.(`${label} paused.`);
        return;
      }
      try {
        await playSlot({ track, variant, store });
        onAnnounce?.(`${label} playing ${variant === 'full' ? 'full mix' : variant}.`);
      } catch (err) {
        showToast(err.message || 'Audio is unavailable.', 'danger');
      }
    },
  }, [
    createElement('span', { class: 'performance-pad__pulse', 'aria-hidden': 'true' }),
    createElement('span', { class: 'performance-pad__icon', 'aria-hidden': 'true', text: isPlaying ? 'Ⅱ' : '▶' }),
  ]);

  return createElement('article', { class: `performance-pad performance-pad--${role} ${isPlaying ? 'is-playing' : ''}` }, [
    createElement('span', { class: 'performance-pad__index', text: role === 'anchor' ? '01' : '02' }),
    playButton,
    createElement('div', { class: 'performance-pad__copy' }, [
      createElement('span', { class: 'performance-pad__role', text: label }),
      createElement('strong', { class: 'performance-pad__title', text: title }),
      createElement('span', {
        class: 'performance-pad__meta',
        text: `${bpm ? `${Math.round(bpm)} BPM · ` : ''}${variant === 'full' ? 'Full mix' : variant}`,
      }),
    ]),
  ]);
}

function ghostSlot(layer, index) {
  const name = layer?.acceptedAsset?.transformSpec?.sourceLabel
    || layer?.placement?.source
    || `Committed Ghost ${index + 1}`;
  return createElement('article', { class: 'performance-pad performance-pad--ghost' }, [
    createElement('span', { class: 'performance-pad__index', text: String(index + 3).padStart(2, '0') }),
    createElement('div', { class: 'performance-pad__orb performance-pad__orb--ghost', 'aria-hidden': 'true', text: 'G' }),
    createElement('div', { class: 'performance-pad__copy' }, [
      createElement('span', { class: 'performance-pad__role', text: 'Solid Ghost' }),
      createElement('strong', { class: 'performance-pad__title', text: name }),
      createElement('span', { class: 'performance-pad__meta', text: 'Committed · render layer' }),
    ]),
  ]);
}

function emptySlot(index) {
  return createElement('article', { class: 'performance-pad performance-pad--empty' }, [
    createElement('span', { class: 'performance-pad__index', text: String(index + 1).padStart(2, '0') }),
    createElement('div', { class: 'performance-pad__orb', 'aria-hidden': 'true', text: '·' }),
    createElement('span', { class: 'performance-pad__meta', text: 'Open slot' }),
  ]);
}

export function mountPerformanceDeck({ container, store, projectManager, onModeChange, onAnnounce }) {
  let mode = 'dj';
  try { mode = normalizeDeckMode(window.localStorage.getItem(MODE_KEY)); } catch (_) { /* storage may be unavailable */ }

  const root = createElement('section', { class: 'performance-deck', 'aria-label': 'Ultimate deck view' });
  container.replaceChildren(root);

  function setMode(next, announce = true) {
    mode = normalizeDeckMode(next);
    try { window.localStorage.setItem(MODE_KEY, mode); } catch (_) { /* harmless preference only */ }
    root.dataset.mode = mode;
    onModeChange?.(mode);
    if (announce) onAnnounce?.(`${mode === 'fun' ? 'FUN performance' : 'DJ precision'} view active.`);
    render(store.getState());
  }

  function render(state) {
    const settings = state.currentProject?.settings || {};
    const anchor = trackForRole(state, 'anchor');
    const lead = trackForRole(state, 'lead');
    const bpm = settings.tempo_mode === 'custom'
      ? Number(settings.target_bpm)
      : (effectiveBpm(anchor) || effectiveBpm(lead) || 120);

    const djButton = createElement('button', {
      class: `deck-mode__button ${mode === 'dj' ? 'is-active' : ''}`,
      type: 'button', 'aria-pressed': mode === 'dj' ? 'true' : 'false',
      text: '◐ DJ', onclick: () => setMode('dj'),
    });
    const funButton = createElement('button', {
      class: `deck-mode__button ${mode === 'fun' ? 'is-active' : ''}`,
      type: 'button', 'aria-pressed': mode === 'fun' ? 'true' : 'false',
      text: '◎ FUN', onclick: () => setMode('fun'),
    });
    const header = createElement('div', { class: 'performance-deck__header' }, [
      createElement('div', {}, [
        createElement('span', { class: 'performance-deck__eyebrow', text: '2BECOME1 / ULTIMATE DECK' }),
        createElement('h2', { text: mode === 'fun' ? 'Play the meld' : 'Shape the meld' }),
        createElement('p', {
          class: 'performance-deck__lede',
          text: mode === 'fun'
            ? 'Touch-first launch pads. Live audition and render controls are labelled separately.'
            : 'Waveform precision, phrase selection, stems, timing, harmony and an exact render plan.',
        }),
      ]),
      createElement('div', { class: 'deck-mode', role: 'group', 'aria-label': 'Deck view' }, [djButton, funButton]),
    ]);

    const children = [header];
    if (mode === 'fun') {
      const layers = state.session?.committedLayers || [];
      const pads = [
        performanceSlot({ role: 'anchor', state, store, onAnnounce }),
        performanceSlot({ role: 'lead', state, store, onAnnounce }),
        ...layers.slice(0, 5).map(ghostSlot),
      ];
      while (pads.length < 7) pads.push(emptySlot(pads.length));

      const bars = createElement('div', { class: 'performance-control__options', role: 'group', 'aria-label': 'Render length in bars' },
        BAR_COUNTS.map((count) => createElement('button', {
          class: 'performance-chip', type: 'button', text: String(count),
          title: `${count} bar render length at ${Math.round(bpm)} BPM`,
          onclick: () => {
            const duration = durationForBars(count, bpm);
            projectManager.save({ settings: { ...settings, duration } });
            onAnnounce?.(`Render length set to ${count} bars, ${duration} seconds.`);
          },
        })),
      );

      const blendValue = findBlend(settings);
      const blendOutput = createElement('output', { class: 'performance-control__value', text: `${blendValue}%` });
      const blend = createElement('input', {
        class: 'performance-blend', type: 'range', min: '0', max: '100', value: String(blendValue),
        'aria-label': 'Render blend between Foundation and Lead',
        oninput: (event) => { blendOutput.textContent = `${event.target.value}%`; },
        onchange: (event) => {
          const gains = gainsForBlend(event.target.value);
          projectManager.save({ settings: { ...settings, ...gains } });
          onAnnounce?.(`Render blend: Foundation ${gains.anchor_gain}, Lead ${gains.lead_gain}.`);
        },
      });

      const overlay = createElement('button', {
        class: `performance-chip ${settings.arrangement_mode !== 'transition' ? 'is-active' : ''}`,
        type: 'button', text: 'Overlay',
        onclick: () => projectManager.save({ settings: { ...settings, arrangement_mode: 'overlay' } }),
      });
      const transition = createElement('button', {
        class: `performance-chip ${settings.arrangement_mode === 'transition' ? 'is-active' : ''}`,
        type: 'button', text: 'A → B',
        onclick: () => projectManager.save({ settings: { ...settings, arrangement_mode: 'transition' } }),
      });

      children.push(
        createElement('div', { class: 'performance-stage', 'aria-label': 'Performance pads' }, pads),
        createElement('div', { class: 'performance-controls' }, [
          createElement('div', { class: 'performance-control' }, [
            createElement('span', { class: 'performance-control__label', text: 'RENDER · LENGTH / BARS' }), bars,
            createElement('span', { class: 'performance-control__hint', text: `${Math.round(bpm)} BPM grid` }),
          ]),
          createElement('div', { class: 'performance-control performance-control--blend' }, [
            createElement('span', { class: 'performance-control__label', text: 'RENDER · BLEND' }),
            createElement('div', { class: 'performance-blend__labels' }, [
              createElement('span', { text: 'Foundation' }), blendOutput, createElement('span', { text: 'Lead' }),
            ]),
            blend,
          ]),
          createElement('div', { class: 'performance-control' }, [
            createElement('span', { class: 'performance-control__label', text: 'RENDER · ARRANGEMENT' }),
            createElement('div', { class: 'performance-control__options' }, [overlay, transition]),
          ]),
        ]),
        createElement('p', {
          class: 'performance-deck__truth',
          text: 'LIVE pads use the single local audition player. RENDER controls change the saved mash plan. Multi-source live mixing, loops, stutter and reverse unlock only with a future engine boundary.',
        }),
      );
    } else {
      children.push(createElement('div', { class: 'performance-deck__signal-row' }, [
        createElement('span', { text: anchor ? '● Foundation armed' : '○ Choose Foundation' }),
        createElement('span', { text: lead ? '● Lead armed' : '○ Choose Lead' }),
        createElement('span', { text: `${Math.round(bpm)} BPM working grid` }),
      ]));
    }
    replaceChildren(root, children);
  }

  const unsubscribe = store.subscribe((state) => render(state));
  setMode(mode, false);
  return () => unsubscribe();
}
