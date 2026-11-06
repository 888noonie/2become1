// components/url-queue-panel.js — library queue. No network.

import { createElement } from '../dom.js';

const RIGHTS = 'Add a track from your library. Only queue audio you have the right to use.';

function queueSlice(state) {
  const slice = state?.urlQueue;
  return {
    armed: Boolean(slice?.armed),
    items: Array.isArray(slice?.items) ? slice.items : [],
  };
}

function libraryTracks(state) {
  const items = state?.library?.items;
  return Array.isArray(items) ? items : [];
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return '';
}

function labelledLine(className, text, label) {
  const line = createElement('p', { class: className, text });
  line.setAttribute('aria-label', label);
  return line;
}

function itemTitle(item) {
  const name = typeof item?.name === 'string' ? item.name.trim() : '';
  if (name) return { text: name, label: `Queued track ${name}` };
  const url = item?.url == null ? '' : String(item.url);
  return { text: url, label: url ? `Queued track ${url}` : 'Queued track' };
}

function itemRow(item, onRemove) {
  const status = item?.status == null ? '' : String(item.status);
  const title = itemTitle(item);
  const note = errorText(item?.error);
  const children = [
    labelledLine('mashup-queue__url', title.text, title.label),
    labelledLine('mashup-queue__status', status, status ? `Status ${status}` : 'Status'),
  ];
  if (note) {
    children.push(labelledLine('mashup-queue__error', note, `Import error ${note}`));
  }
  if (status !== 'importing') {
    const remove = createElement('button', {
      type: 'button',
      class: 'mashup-queue__remove',
      text: 'Remove',
    });
    remove.addEventListener('click', () => onRemove?.(item?.id));
    children.push(remove);
  }
  return createElement('li', { class: 'mashup-queue__item' }, children);
}

function libraryAdder(tracks, onEnqueueTrack) {
  const choices = tracks.length
    ? tracks.map((track) => {
      const label = typeof track?.name === 'string' && track.name.trim()
        ? track.name.trim()
        : (track?.id || 'Untitled');
      const button = createElement('button', {
        type: 'button',
        class: 'button mashup-queue__library-track',
        text: label,
      });
      button.addEventListener('click', () => onEnqueueTrack?.(track));
      return button;
    })
    : [createElement('p', { class: 'mashup-queue__empty-library', text: 'No library tracks yet.' })];
  return createElement('details', { class: 'mashup-queue__adder' }, [
    createElement('summary', {
      class: 'button mashup-queue__plus',
      'aria-label': 'Add a library track',
      text: '+',
    }),
    createElement('div', { class: 'mashup-queue__library' }, choices),
  ]);
}

/**
 * Paint the queue into `container`.
 * @param {{container: HTMLElement, state?: object, onEnqueueTrack?: Function, onRemove?: Function, onArm?: Function}} options
 */
export function renderUrlQueuePanel({
  container,
  state = {},
  onEnqueueTrack,
  onRemove,
  onArm,
} = {}) {
  if (!container) throw new Error('renderUrlQueuePanel requires a container');
  const { armed, items } = queueSlice(state);
  const wasOpen = Boolean(container.querySelector('details.mashup-queue__adder')?.open);

  const checkbox = createElement('input', { type: 'checkbox' });
  checkbox.checked = armed;
  checkbox.addEventListener('change', () => {
    onArm?.(checkbox.checked);
  });

  const adder = libraryAdder(libraryTracks(state), onEnqueueTrack);
  if (wasOpen) adder.open = true;

  const list = items.length
    ? createElement('ol', { class: 'mashup-queue__items' }, items.map((item) => itemRow(item, onRemove)))
    : createElement('p', { class: 'mashup-queue__empty', text: 'No tracks queued.' });

  const section = createElement('section', {
    class: 'mashup-queue',
    'aria-label': 'Upcoming tracks',
  }, [
    createElement('h2', { text: 'Queue' }),
    createElement('p', { class: 'mashup-queue__rights', text: RIGHTS }),
    adder,
    createElement('label', { class: 'mashup-queue__arm' }, [checkbox, 'Auto mix']),
    list,
  ]);
  container.replaceChildren(section);
  return section;
}

/**
 * @param {{container: HTMLElement, store?: {getState: Function, subscribe?: Function, subscribeSlice?: Function}, onEnqueueTrack?: Function, onRemove?: Function, onArm?: Function}} options
 * @returns {() => void}
 */
export function mountUrlQueuePanel({
  container,
  store,
  onEnqueueTrack,
  onRemove,
  onArm,
} = {}) {
  if (!container) throw new Error('mountUrlQueuePanel requires a container');
  const draw = () => renderUrlQueuePanel({
    container,
    state: typeof store?.getState === 'function' ? store.getState() : {},
    onEnqueueTrack,
    onRemove,
    onArm,
  });
  draw();
  const unsubs = [];
  if (typeof store?.subscribeSlice === 'function') {
    unsubs.push(store.subscribeSlice('urlQueue', draw));
    unsubs.push(store.subscribeSlice('library', draw));
  } else if (typeof store?.subscribe === 'function') {
    const unsub = store.subscribe(draw);
    if (typeof unsub === 'function') unsubs.push(unsub);
  }
  return () => {
    for (const unsub of unsubs) unsub();
  };
}
