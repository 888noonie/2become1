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

function deckGroup(deck, eq, onDirective) {
  const inputs = {};
  const bands = BANDS.map(([band, label]) => {
    const input = createElement('input', {
      type: 'range',
      min: '-12',
      max: '12',
      step: '1',
      'aria-label': label,
    });
    input.value = String(bandValue(eq, deck, band));
    inputs[band] = input;
    let sent = null;
    const emit = () => {
      const levels = {
        low: Number(inputs.low.value),
        mid: Number(inputs.mid.value),
        high: Number(inputs.high.value),
      };
      const db = levels[band];
      if (sent === db) return;
      sent = db;
      onDirective?.(directive({ op: 'eq', deck, band, db }));
    };
    input.addEventListener('input', emit);
    input.addEventListener('change', emit);
    return createElement('label', { class: 'mashup-daw__band' }, [label, input]);
  });

  const loops = LOOP_BARS.map((bars) => {
    const button = createElement('button', {
      type: 'button',
      class: 'mashup-daw__loop',
      text: String(bars),
    });
    button.addEventListener('click', () => {
      onDirective?.(directive({ op: 'loop', deck, bars, enabled: true }));
    });
    return button;
  });
  const loopOff = createElement('button', {
    type: 'button',
    class: 'mashup-daw__loop-off',
    text: 'Loop off',
  });
  loopOff.addEventListener('click', () => {
    onDirective?.(directive({ op: 'loop', deck, bars: 4, enabled: false }));
  });

  return createElement('fieldset', {
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
}

/**
 * Paint the command bar into `container`. A typed command is kept across calls.
 * @param {{container: HTMLElement, state?: object, onCommand?: Function, onDirective?: Function}} options
 */
export function renderDawCommandBar({
  container,
  state = {},
  onCommand,
  onDirective,
} = {}) {
  if (!container) throw new Error('renderDawCommandBar requires a container');
  const daw = state?.daw ?? {};
  const previous = container.querySelector('input[aria-label="Mix command"]');
  const draft = previous ? previous.value : '';

  const command = createElement('input', {
    type: 'text',
    class: 'mashup-daw__command',
    'aria-label': 'Mix command',
    placeholder: 'drop the bass on deck A',
  });
  command.value = draft;

  const apply = createElement('button', {
    type: 'submit',
    class: 'mashup-daw__apply',
    text: 'Apply',
  });

  const message = errorMessage(daw.lastError);
  const declined = declinedMessages(daw.lastDirective);
  const agentReply = typeof daw.agentReply === 'string' ? daw.agentReply : '';
  const form = createElement('form', {
    class: 'mashup-daw',
    'aria-label': 'Mix commands',
  }, [
    createElement('label', { class: 'mashup-daw__instructions' }, ['Instructions', command]),
    apply,
    message ? createElement('p', { class: 'mashup-daw__error', text: message }) : null,
    declined.length
      ? createElement('ul', { class: 'mashup-daw__declined' }, declined.map((text) => (
        createElement('li', { text })
      )))
      : null,
    createElement('p', {
      class: 'mashup-daw__agent',
      'aria-label': 'Agent output',
      text: agentReply,
    }),
    ...DECKS.map((deck) => deckGroup(deck, daw.eq, onDirective)),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = command.value;
    if (value === '') return;
    onCommand?.(value);
  });
  container.replaceChildren(form);
  return form;
}

/**
 * @param {{container: HTMLElement, store?: {getState: Function, subscribe?: Function}, onCommand?: Function, onDirective?: Function}} options
 * @returns {() => void}
 */
export function mountDawCommandBar({ container, store, onCommand, onDirective } = {}) {
  if (!container) throw new Error('mountDawCommandBar requires a container');
  const draw = () => renderDawCommandBar({
    container,
    state: typeof store?.getState === 'function' ? store.getState() : {},
    onCommand,
    onDirective,
  });
  draw();
  const listen = typeof store?.subscribeSlice === 'function'
    ? (fn) => store.subscribeSlice('daw', fn)
    : store?.subscribe;
  if (typeof listen !== 'function') return () => {};
  const unsub = listen(draw);
  return typeof unsub === 'function' ? unsub : () => {};
}
