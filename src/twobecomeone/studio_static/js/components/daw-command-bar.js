// components/daw-command-bar.js — mix command, EQ, and loop directives. No network.

import { createElement } from '../dom.js';

const DECKS = ['A', 'B'];
const BANDS = [
  ['low', 'Low'],
  ['mid', 'Mid'],
  ['high', 'High'],
];
const LOOP_BARS = [1, 2, 4, 8];

function directive(op) {
  return {
    schema: 'playback-directive/v1',
    ok: true,
    tier: 'deterministic',
    source: 'grammar',
    model: null,
    ops: [op],
    declined: [],
    error: null,
  };
}

function bandValue(eq, deck, band) {
  const value = Number(eq?.[deck]?.[band]);
  return Number.isFinite(value) ? value : 0;
}

function errorMessage(lastError) {
  if (!lastError) return '';
  if (typeof lastError === 'string') return lastError;
  if (typeof lastError.message === 'string') return lastError.message;
  return '';
}

function declinedMessages(lastDirective) {
  const declined = lastDirective?.declined;
  if (!Array.isArray(declined)) return [];
  return declined.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry.message === 'string') return entry.message;
    return '';
  }).filter(Boolean);
}

function deckGroup(deck, onDirective) {
  const updateBand = [];
  const bands = BANDS.map(([band, label]) => {
    const input = createElement('input', {
      type: 'range',
      min: '-12',
      max: '12',
      step: '1',
      'aria-label': label,
    });
    const readout = createElement('span', { class: 'mashup-daw__readout', 'aria-hidden': 'true' });
    const showValue = (db) => {
      readout.textContent = `${db} dB`;
      input.setAttribute('aria-valuetext', `${db} decibels`);
    };
    let sent = null;
    const emit = () => {
      const db = Number(input.value);
      if (sent === db) return;
      sent = db;
      showValue(db);
      onDirective?.(directive({ op: 'eq', deck, band, db }));
    };
    input.addEventListener('input', emit);
    input.addEventListener('change', emit);
    updateBand.push((eq) => {
      const db = bandValue(eq, deck, band);
      if (Number(input.value) !== db) {
        input.value = String(db);
        sent = null;
      }
      showValue(db);
    });
    return createElement('label', { class: 'mashup-daw__band' }, [
      createElement('span', { class: 'mashup-daw__band-label' }, [label, readout]),
      input,
    ]);
  });

  const loops = LOOP_BARS.map((bars) => {
    const button = createElement('button', {
      type: 'button',
      class: 'button button--sm mashup-daw__loop',
      text: String(bars),
    });
    button.addEventListener('click', () => {
      onDirective?.(directive({ op: 'loop', deck, bars, enabled: true }));
    });
    return button;
  });
  const loopOff = createElement('button', {
    type: 'button',
    class: 'button button--sm mashup-daw__loop-off',
    text: 'Loop off',
  });
  loopOff.addEventListener('click', () => {
    onDirective?.(directive({ op: 'loop', deck, bars: 4, enabled: false }));
  });

  const element = createElement('fieldset', {
    class: 'mashup-daw__deck',
    'aria-label': `Deck ${deck}`,
  }, [
    createElement('legend', { text: `Deck ${deck}` }),
    createElement('div', { class: 'mashup-daw__bands' }, bands),
    createElement('div', {
      class: 'mashup-daw__loops',
      role: 'group',
      'aria-label': `Deck ${deck} loop`,
    }, [...loops, loopOff]),
  ]);
  return { element, update: (eq) => updateBand.forEach((apply) => apply(eq)) };
}

function createCommandBar(container, onCommand, onDirective) {
  if (!container) throw new Error('renderDawCommandBar requires a container');
  const draft = container.querySelector('input[aria-label="Mix command"]')?.value || '';
  const command = createElement('input', {
    type: 'text',
    class: 'input mashup-daw__command',
    'aria-label': 'Mix command',
    placeholder: 'drop the bass on deck A',
  });
  command.value = draft;

  const apply = createElement('button', {
    type: 'submit',
    class: 'button button--primary mashup-daw__apply',
    text: 'Apply',
  });

  const error = createElement('p', { class: 'mashup-daw__error', role: 'status' });
  const declined = createElement('ul', { class: 'mashup-daw__declined' });
  const reply = createElement('p', { class: 'mashup-daw__agent', 'aria-label': 'Agent output', role: 'status' });
  const decks = DECKS.map((deck) => deckGroup(deck, onDirective));
  const form = createElement('form', {
    class: 'mashup-daw',
    'aria-label': 'Mix commands',
  }, [
    createElement('label', { class: 'mashup-daw__instructions' }, ['Instructions', command]),
    apply, declined, reply,
    ...decks.map((deck) => deck.element),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = command.value;
    if (value === '') return;
    onCommand?.(value);
  });
  container.replaceChildren(form);
  const update = (daw = {}) => {
    const message = errorMessage(daw.lastError);
    const notices = declinedMessages(daw.lastDirective);
    const agentReply = typeof daw.agentReply === 'string' ? daw.agentReply : '';
    if (error.textContent !== message) {
      error.textContent = message;
      if (message && !error.isConnected) apply.after(error);
      if (!message) error.remove();
    }
    if (reply.textContent !== agentReply) reply.textContent = agentReply;
    if (notices.length !== declined.childElementCount
        || notices.some((text, index) => declined.children[index].textContent !== text)) {
      declined.replaceChildren(...notices.map((text) => createElement('li', { text })));
    }
    decks.forEach((deck) => deck.update(daw.eq));
  };
  return { form, update };
}

/** Paint the command bar into a container and preserve any typed command. */
export function renderDawCommandBar({ container, state = {}, onCommand, onDirective } = {}) {
  const { form, update } = createCommandBar(container, onCommand, onDirective);
  update(state?.daw);
  return form;
}

/**
 * @param {{container: HTMLElement, store?: {getState: Function, subscribe?: Function}, onCommand?: Function, onDirective?: Function}} options
 * @returns {() => void}
 */
export function mountDawCommandBar({ container, store, onCommand, onDirective } = {}) {
  if (!container) throw new Error('mountDawCommandBar requires a container');
  const { update } = createCommandBar(container, onCommand, onDirective);
  const draw = () => update(store?.getState?.()?.daw);
  draw();
  const listen = typeof store?.subscribeSlice === 'function'
    ? (fn) => store.subscribeSlice('daw', fn)
    : store?.subscribe;
  if (typeof listen !== 'function') return () => {};
  const unsub = listen(draw);
  return typeof unsub === 'function' ? unsub : () => {};
}
