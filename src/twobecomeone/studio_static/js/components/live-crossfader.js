// components/live-crossfader.js — Phase 15B live equal-power crossfader + master.
//
// Routes deck-bus gains through the LiveMixer. Render-plan blend in FUN mode
// remains separate and edits project settings only.

import { createElement, replaceChildren } from '../dom.js';
import { store as globalStore, liveMixer as globalLiveMixer } from '../app-context.js';

export function mountLiveCrossfader({
  container,
  store = globalStore,
  liveMixer = globalLiveMixer,
  onAnnounce = null,
}) {
  if (!container) throw new Error('mountLiveCrossfader requires a container');

  const root = createElement('div', { class: 'live-crossfader', role: 'group', 'aria-label': 'Live crossfader' });
  container.replaceChildren(root);

  function render(state) {
    const mixer = state.mixer || {};
    const masterDeck = mixer.masterDeck || 'A';
    const position = mixer.crossfaderPosition ?? 50;

    const masterA = createElement('button', {
      class: `button button--sm live-crossfader__master ${masterDeck === 'A' ? 'button--primary' : ''}`,
      type: 'button',
      text: 'Master A',
      'aria-pressed': masterDeck === 'A' ? 'true' : 'false',
      onclick: () => {
        liveMixer.setMasterDeck('A');
        onAnnounce?.('Foundation deck is master.');
      },
    });
    const masterB = createElement('button', {
      class: `button button--sm live-crossfader__master ${masterDeck === 'B' ? 'button--primary' : ''}`,
      type: 'button',
      text: 'Master B',
      'aria-pressed': masterDeck === 'B' ? 'true' : 'false',
      onclick: () => {
        liveMixer.setMasterDeck('B');
        onAnnounce?.('Lead deck is master.');
      },
    });

    const labelA = createElement('span', { class: 'live-crossfader__label', text: 'A' });
    const labelB = createElement('span', { class: 'live-crossfader__label', text: 'B' });
    const slider = createElement('input', {
      class: 'live-crossfader__slider',
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(position),
      'aria-label': 'Live crossfader',
      'aria-valuetext': `${position}%`,
    });
    slider.addEventListener('input', (event) => {
      liveMixer.setCrossfader(event.target.value);
    });

    const ratioText = [];
    if (mixer.tempoRatioA && mixer.tempoRatioA !== 1) ratioText.push(`A ×${mixer.tempoRatioA.toFixed(3)}`);
    if (mixer.tempoRatioB && mixer.tempoRatioB !== 1) ratioText.push(`B ×${mixer.tempoRatioB.toFixed(3)}`);
    const tempoEl = createElement('span', {
      class: 'live-crossfader__tempo',
      text: ratioText.length ? ratioText.join(' · ') : '',
    });

    const headroom = mixer.headroom || {};
    const headroomEl = createElement('span', {
      class: `live-crossfader__headroom ${headroom.clipping ? 'live-crossfader__headroom--clip' : ''}`,
      text: headroom.clipping
        ? 'Clipping — lower gains'
        : (headroom.attenuationRecommended ? `Headroom ${headroom.headroomDb} dB` : ''),
      role: headroom.clipping || headroom.attenuationRecommended ? 'status' : null,
    });

    replaceChildren(root, [
      createElement('div', { class: 'live-crossfader__masters' }, [masterA, masterB]),
      createElement('div', { class: 'live-crossfader__track' }, [labelA, slider, labelB]),
      createElement('div', { class: 'live-crossfader__meta' }, [tempoEl, headroomEl]),
    ]);
  }

  const unsubscribe = store.subscribeSlice('mixer', () => render(store.getState()));
  render(store.getState());

  return function dispose() {
    unsubscribe();
  };
}
