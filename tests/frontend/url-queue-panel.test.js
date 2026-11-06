import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupDom, teardownDom } from './helpers/dom.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PYTHON = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));

function pythonJson(code, arg) {
  const raw = execFileSync(PYTHON, ['-c', code, arg], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

function stubStore(state) {
  const listeners = [];
  return {
    getState: () => state,
    subscribe(fn) {
      listeners.push(fn);
      return () => {};
    },
    emit() {
      for (const fn of listeners) fn(state);
    },
  };
}

function mountContainer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

test('plus enqueues a library track and the queue has no YouTube paste', async () => {
  const { mountUrlQueuePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
  );
  const track = { id: 'track-1', name: 'Night Drive' };
  const calls = [];
  const container = mountContainer();
  mountUrlQueuePanel({
    container,
    store: stubStore({
      library: { items: [track] },
      urlQueue: { armed: false, items: [] },
    }),
    onEnqueueTrack: (item) => calls.push(item),
    onRemove: () => {},
    onArm: () => {},
  });
  assert.equal(container.querySelector('textarea'), null);
  assert.equal(container.querySelector('[aria-label="YouTube links"]'), null);
  assert.equal(container.textContent.includes('Drop YouTube links'), false);
  const plus = container.querySelector('[aria-label="Add a library track"]');
  assert.equal(plus.textContent, '+');
  const choice = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Night Drive');
  choice.click();
  assert.deepEqual(calls, [track]);
  assert.equal(container.querySelector('.mashup-queue').getAttribute('aria-label'), 'Upcoming tracks');
  assert.match(container.textContent, /No tracks queued\./);
  assert.equal(container.textContent.includes('One video per link'), false);
  assert.match(container.textContent, /Add a track from your library/);
});

test('an empty library plus does not enqueue a track', async () => {
  const { mountUrlQueuePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
  );
  const calls = [];
  const container = mountContainer();
  mountUrlQueuePanel({
    container,
    store: stubStore({ library: { items: [] }, urlQueue: { armed: false, items: [] } }),
    onEnqueueTrack: (item) => calls.push(item),
  });
  assert.match(container.textContent, /No library tracks yet\./);
  assert.equal(container.querySelector('.mashup-queue__library-track'), null);
  assert.deepEqual(calls, []);
});

test('Auto mix checkbox calls onArm(true)', async () => {
  const { mountUrlQueuePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
  );
  const armed = [];
  const container = mountContainer();
  mountUrlQueuePanel({
    container,
    store: stubStore({ urlQueue: { armed: false, items: [] } }),
    onArm: (value) => armed.push(value),
  });
  const checkbox = container.querySelector('input[type="checkbox"]');
  assert.equal(checkbox.checked, false);
  checkbox.click();
  assert.deepEqual(armed, [true]);
});

test('a failed queue item shows the url, status, and error as separate text', async () => {
  const { mountUrlQueuePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
  );
  const container = mountContainer();
  const url = 'not-a-youtube-link';
  const message = 'enter a valid youtube.com or youtu.be URL';
  mountUrlQueuePanel({
    container,
    store: stubStore({
      urlQueue: {
        armed: true,
        items: [{
          id: 'bad',
          url,
          status: 'failed',
          error: { code: 'BAD_URL', message },
        }],
      },
    }),
  });
  const row = container.querySelector('li.mashup-queue__item');
  const urlLine = row.querySelector('.mashup-queue__url');
  const statusLine = row.querySelector('.mashup-queue__status');
  const errorLine = row.querySelector('.mashup-queue__error');
  assert.equal(urlLine.childNodes.length, 1);
  assert.equal(urlLine.childNodes[0].nodeType, Node.TEXT_NODE);
  assert.equal(urlLine.childNodes[0].nodeValue, url);
  assert.equal(statusLine.childNodes[0].nodeValue, 'failed');
  assert.equal(errorLine.childNodes[0].nodeValue, message);
  assert.equal(new Set([
    urlLine.childNodes[0],
    statusLine.childNodes[0],
    errorLine.childNodes[0],
  ]).size, 3);
  assert.equal(urlLine.getAttribute('aria-label'), `Queued track ${url}`);
  assert.equal(statusLine.getAttribute('aria-label'), 'Status failed');
  assert.equal(errorLine.getAttribute('aria-label'), `Import error ${message}`);
  assert.equal([...row.childNodes].some((node) => (
    node.nodeType === Node.TEXT_NODE && node.nodeValue.includes(`${url}failed`)
  )), false);
});

test('importing item has no Remove; pending Remove calls onRemove', async () => {
  const { mountUrlQueuePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
  );
  const removed = [];
  const container = mountContainer();
  mountUrlQueuePanel({
    container,
    store: stubStore({
      urlQueue: {
        armed: false,
        items: [
          { id: 'imp', url: 'https://youtu.be/importing', status: 'importing', error: null },
          { id: 'pend', url: 'https://youtu.be/pending', status: 'pending', error: null },
        ],
      },
    }),
    onRemove: (id) => removed.push(id),
  });
  const rows = [...container.querySelectorAll('li')];
  const importing = rows.find((row) => row.textContent.includes('https://youtu.be/importing'));
  const pending = rows.find((row) => row.textContent.includes('https://youtu.be/pending'));
  assert.match(importing.textContent, /importing/);
  assert.equal([...importing.querySelectorAll('button')].some((button) => button.textContent === 'Remove'), false);
  assert.match(pending.textContent, /pending/);
  [...pending.querySelectorAll('button')].find((button) => button.textContent === 'Remove').click();
  assert.deepEqual(removed, ['pend']);
});

test('mix command submit calls onCommand and empty submit does not', async () => {
  const { mountDawCommandBar } = await import(
    '../../src/twobecomeone/studio_static/js/components/daw-command-bar.js'
  );
  const commands = [];
  const container = mountContainer();
  mountDawCommandBar({
    container,
    store: stubStore({}),
    onCommand: (value) => commands.push(value),
    onDirective: () => {},
  });
  const form = container.querySelector('form');
  const input = container.querySelector('input[aria-label="Mix command"]');
  assert.equal(input.getAttribute('placeholder'), 'drop the bass on deck A');
  input.value = 'drop the bass on deck A';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(commands, ['drop the bass on deck A']);
  input.value = '';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(commands, ['drop the bass on deck A']);
});

test('Deck A Low range -12 calls onDirective with an eq op', async () => {
  const { mountDawCommandBar } = await import(
    '../../src/twobecomeone/studio_static/js/components/daw-command-bar.js'
  );
  const directives = [];
  const container = mountContainer();
  mountDawCommandBar({
    container,
    store: stubStore({
      daw: {
        lastDirective: null,
        lastError: null,
        eq: {
          A: { low: 0, mid: 0, high: 0 },
          B: { low: 0, mid: 0, high: 0 },
        },
      },
    }),
    onDirective: (directive) => directives.push(directive),
  });
  const deckA = container.querySelector('[aria-label="Deck A"]');
  const low = [...deckA.querySelectorAll('input[type="range"]')].find((input) => input.getAttribute('aria-label') === 'Low');
  assert.equal(low.min, '-12');
  assert.equal(low.max, '12');
  assert.equal(low.step, '1');
  low.value = '-12';
  low.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(directives.length, 1);
  assert.deepEqual(directives[0], {
    schema: 'playback-directive/v1',
    ok: true,
    tier: 'deterministic',
    source: 'grammar',
    model: null,
    ops: [{ op: 'eq', deck: 'A', band: 'low', db: -12 }],
    declined: [],
    error: null,
  });
});

test('lastError message No renders in the command bar', async () => {
  const { mountDawCommandBar } = await import(
    '../../src/twobecomeone/studio_static/js/components/daw-command-bar.js'
  );
  const container = mountContainer();
  mountDawCommandBar({
    container,
    store: stubStore({
      daw: {
        lastDirective: null,
        lastError: { code: 'X', message: 'No' },
      },
    }),
  });
  const error = container.querySelector('p.mashup-daw__error');
  assert.equal(error.textContent, 'No');
  assert.equal(container.querySelector('[aria-label="Agent output"]').textContent, '');
});

test('sidebar plus enqueues a library track and the bass drop reports the cue', async () => {
  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  const { createMashupController } = await import(
    '../../src/twobecomeone/studio_static/js/mashup/session.js'
  );
  const { mountUrlQueuePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/url-queue-panel.js'
  );
  const { mountDawCommandBar } = await import(
    '../../src/twobecomeone/studio_static/js/components/daw-command-bar.js'
  );
  const { LiveMixer } = await import(
    '../../src/twobecomeone/studio_static/js/runtime/live-mixer.js'
  );
  const store = registerReducers(new StateStore());
  const track = {
    id: 'track-1',
    name: 'Night Drive',
    duration: 12,
    audio_url: '/api/tracks/track-1/audio',
  };
  store.dispatch({
    type: 'library/set',
    items: [track],
    total: 1,
    limit: 50,
    offset: 0,
  });
  const played = [];
  const mixer = new LiveMixer({
    audioContextFactory: { create() { throw new Error('AudioContext is not used for this EQ cut'); } },
    mediaElementFactory: { create: () => new Audio() },
  });
  const liveMixer = {
    snapshot: () => mixer.snapshot(),
    on: (listener) => mixer.on(listener),
    getMixerState: () => mixer.getMixerState(),
    getDeck: (deck) => mixer.getDeck(deck),
    setCrossfader: (position) => mixer.setCrossfader(position),
    setDeckEq: (deck, band, db) => mixer.setDeckEq(deck, band, db),
    setDeckTrim: () => ({ ok: true }),
    setDeckFilter: () => ({ ok: true }),
    setDeckLoop: () => ({ ok: true }),
    pause: () => ({ ok: true }),
    play(deck, descriptor) {
      played.push({ deck, descriptor });
      return { ok: true };
    },
  };
  const controller = createMashupController({
    store,
    liveMixer,
    projectManager: { assign() {} },
    async getTrack(trackId) {
      return { ...track, id: trackId };
    },
    interpret: (text) => pythonJson(
      'import json,sys; from twobecomeone.mashup_intent import interpret; print(json.dumps(interpret(sys.argv[1])))',
      text,
    ),
  });
  const queue = mountContainer();
  const bar = mountContainer();
  mountUrlQueuePanel({
    container: queue,
    store,
    onEnqueueTrack: (item) => controller.enqueueTrack(item),
    onRemove: (id) => controller.remove(id),
    onArm: (armed) => controller.setArmed(armed),
  });
  mountDawCommandBar({
    container: bar,
    store,
    onCommand: (text) => { void controller.command(text); },
    onDirective: (directive) => controller.directive(directive),
  });

  assert.equal(queue.querySelector('textarea'), null);
  assert.equal(queue.querySelector('[aria-label="YouTube links"]'), null);
  assert.equal(queue.textContent.includes('Drop YouTube links'), false);
  assert.equal(bar.querySelector('[aria-label="Agent output"]').textContent, '');
  assert.match(bar.textContent, /Instructions/);

  [...queue.querySelectorAll('button')].find((button) => button.textContent === 'Night Drive').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(queue.textContent, /Night Drive/);
  assert.equal(played.length, 1);
  assert.equal(played[0].deck, 'A');
  assert.equal(played[0].descriptor.trackId, 'track-1');

  const input = bar.querySelector('input[aria-label="Mix command"]');
  input.value = 'drop the bass on deck A';
  bar.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const agentText = bar.querySelector('[aria-label="Agent output"]').textContent;
  assert.equal(agentText, 'I have dropped the bass to come in on the next suitable cue');
  const deckA = bar.querySelector('[aria-label="Deck A"]');
  const low = [...deckA.querySelectorAll('input[type="range"]')].find((input) => input.getAttribute('aria-label') === 'Low');
  assert.equal(low.value, '-12');
  assert.equal(mixer.getDeck('A').eq.low, -12);
  console.log(`agent output=${JSON.stringify(agentText)} deck A low=${low.value} mixer=${mixer.getDeck('A').eq.low}`);
  controller.stop();
});
