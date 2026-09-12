// components/live-mixer-strip.js — Phase 15B live equal-power crossfader.
// Live bus gains only. Does not write render-plan blend settings.

import { createElement, replaceChildren } from '../dom.js';
import { store as globalStore, liveMixer as globalLiveMixer } from '../app-context.js';

export function mountLiveMixerStrip({
  container,
  store = globalStore,
  liveMixer = globalLiveMixer,
  onAnnounce,
} = {}) {
  if (!container) throw new Error('mountLiveMixerStrip requires a container');
  const root = createElement('section', {
    class: 'live-mixer-strip',
    'aria-label': 'Live mixer',
  });
  container.replaceChildren(root);

  function render(state) {
    const mixer = state.mixer || {};
    const xfader = Number.isFinite(mixer.xfader) ? mixer.xfader : 0.5;
    const master = mixer.master === 'B' ? 'B' : 'A';
    const clip = mixer.clipping === true;
    const pctA = Math.round((1 - xfader) * 100);
    const pctB = Math.round(xfader * 100);
    const xfaderPct = String(Math.round(xfader * 100));

    if (root.dataset.ready === '1') {
      const label = root.querySelector('.live-mixer-strip__fader .live-mixer-strip__label');
      if (label) label.textContent = `Live crossfader  A ${pctA}%  B ${pctB}%`;
      const input = root.querySelector('input[type="range"]');
      if (input && document.activeElement !== input) {
        input.value = xfaderPct;
        input.setAttribute('aria-valuenow', xfaderPct);
      }
      for (const btn of root.querySelectorAll('[role="radio"]')) {
        const deck = btn.textContent === 'Lead' ? 'B' : 'A';
        const selected = master === deck;
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
        btn.classList.toggle('button--primary', selected);
      }
      const clipEl = root.querySelector('.live-mixer-strip__clip');
      if (clip && !clipEl) {
        root.querySelector('.live-mixer-strip__status')?.appendChild(
          createElement('span', { class: 'live-mixer-strip__clip', text: 'Peak ≥ 0.99 (limiter off)' }),
        );
      } else if (!clip && clipEl) {
        clipEl.remove();
      }
      return;
    }

    const masterField = createElement('div', { class: 'live-mixer-strip__master' }, [
      createElement('span', { class: 'live-mixer-strip__label', text: 'Master' }),
      createElement('div', { class: 'live-mixer-strip__master-options', role: 'radiogroup', 'aria-label': 'Master deck' }, [
        masterButton('A', 'Foundation', master, liveMixer, onAnnounce),
        masterButton('B', 'Lead', master, liveMixer, onAnnounce),
      ]),
    ]);

    const fader = createElement('label', { class: 'live-mixer-strip__fader' }, [
      createElement('span', { class: 'live-mixer-strip__label', text: `Live crossfader  A ${pctA}%  B ${pctB}%` }),
      createElement('input', {
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        value: String(Math.round(xfader * 100)),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(xfader * 100)),
        'aria-label': 'Live equal-power crossfader',
        oninput: (event) => {
          const next = Number(event.target.value) / 100;
          liveMixer.setCrossfader(next);
        },
      }),
    ]);

    const statusBits = [
      createElement('span', {
        class: 'live-mixer-strip__note',
        text: 'Live bus only — not the render blend.',
      }),
    ];
    if (clip) {
      statusBits.push(createElement('span', {
        class: 'live-mixer-strip__clip',
        text: 'Peak ≥ 0.99 (limiter off)',
      }));
    }
    statusBits.push(createElement('span', {
      class: 'live-mixer-strip__note',
      text: `Class C loopback: ${mixer.classC || 'unmeasured'}`,
    }));

    replaceChildren(root, [masterField, fader, createElement('div', { class: 'live-mixer-strip__status' }, statusBits)]);
    root.dataset.ready = '1';
  }

  render(store.getState());
  const unsub = store.subscribeSlice('mixer', () => render(store.getState()));
  return () => unsub();
}

function masterButton(deck, label, current, liveMixer, onAnnounce) {
  const selected = current === deck;
  return createElement('button', {
    class: `button${selected ? ' button--primary' : ''}`,
    type: 'button',
    role: 'radio',
    'aria-checked': selected ? 'true' : 'false',
    text: label,
    onclick: () => {
      liveMixer.setMaster(deck);
      onAnnounce?.(`Master set to ${label}`);
    },
  });
}
