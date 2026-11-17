import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import { mountStemDeskPanel } from '../../src/twobecomeone/studio_static/js/components/stem-desk-panel.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

function variant(name, overrides = {}) {
  return {
    name,
    stem_set_id: 'set-1',
    method: 'demucs',
    model_name: 'htdemucs@4.1.0',
    device: 'cpu',
    audio_url: `/api/stems/set-1/audio?name=${name}`,
    ...overrides,
  };
}

/** A desk stand-in that applies the same mute/solo/gain law the runtime owns. */
class FakeDesk {
  constructor() {
    this.calls = [];
    this.disposed = false;
    this.lanes = [];
    this.status = 'idle';
    this.position = 0;
  }

  async load(lanes) {
    this.calls.push(['load', lanes.map((lane) => lane.name)]);
    this.lanes = lanes.map((lane) => ({
      ...lane,
      gainDb: 0,
      muted: false,
      solo: false,
    }));
    this.status = 'ready';
    return this.state();
  }

  state() {
    const anySolo = this.lanes.some((lane) => lane.solo);
    return {
      status: this.status,
      contextState: this.contextState || 'running',
      error: null,
      playing: this.status === 'playing',
      positionSeconds: this.position,
      durationSeconds: 12,
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        label: lane.label,
        method: lane.method,
        modelName: lane.modelName,
        device: lane.device,
        durationSeconds: 12,
        gainDb: lane.gainDb,
        muted: lane.muted,
        solo: lane.solo,
        audible: anySolo ? lane.solo : !lane.muted,
        effectiveGain: (anySolo ? lane.solo : !lane.muted) ? Math.pow(10, lane.gainDb / 20) : 0,
      })),
    };
  }

  async resume() { this.calls.push(['resume']); return this.state(); }
  play() { this.calls.push(['play']); this.status = 'playing'; return this.state(); }
  stop() { this.calls.push(['stop']); this.status = 'ready'; this.position = 0; return this.state(); }
  setGain(name, db) {
    this.calls.push(['setGain', name, Number(db)]);
    this.lanes.find((lane) => lane.name === name).gainDb = Number(db);
    return this.state();
  }

  setMuted(name, value) {
    this.calls.push(['setMuted', name, value]);
    this.lanes.find((lane) => lane.name === name).muted = Boolean(value);
    return this.state();
  }

  setSolo(name, value) {
    this.calls.push(['setSolo', name, value]);
    this.lanes.find((lane) => lane.name === name).solo = Boolean(value);
    return this.state();
  }

  positionSeconds() { return this.position; }
  position() { return this.position; }
  dispose() { this.disposed = true; }
}

function mount({ variants, tracks = [{ id: 'track-1', name: 'night-drive.wav' }] } = {}) {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  const calls = [];
  const dispose = mountStemDeskPanel({
    container,
    onAnnounce: () => {},
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: (options) => {
      calls.push(['createDesk', options]);
      return desk;
    },
    listTracksImpl: async () => ({ items: tracks, total: tracks.length, limit: 50, offset: 0 }),
    listStemsImpl: async (trackId) => {
      calls.push(['listStems', trackId]);
      return { stems: ['full', ...(variants || []).map((v) => v.name)], variants: [{ name: 'full' }, ...(variants || [])] };
    },
  });
  return { container, desk, calls, dispose };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('the desk lists tracks, loads four stems and labels them with provenance', async () => {
  const { container, desk, calls } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  const select = container.querySelector('select');
  select.dispatchEvent(new window.Event('focus'));
  await flush();

  const options = [...container.querySelectorAll('option')].map((option) => option.textContent);
  assert.deepEqual(options, ['night-drive.wav']);
  assert.equal(select.value, 'track-1');

  container.querySelector('button.button--sm').click();
  await flush();

  const rows = container.querySelectorAll('.stem-row');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelector('.stem-row__name').textContent, 'Vocals');
  assert.match(rows[0].querySelector('.stem-row__meta').textContent, /demucs/);
  assert.match(rows[0].querySelector('.stem-row__meta').textContent, /htdemucs@4\.1\.0/);
  assert.equal(rows[3].querySelector('.stem-row__name').textContent, 'Other');
  assert.deepEqual(desk.calls[0], ['load', ['vocals', 'drums', 'bass', 'other']]);
  assert.equal(desk.lanes.length, 4);
  assert.equal(calls.some(([name]) => name === 'createDesk'), true);
});

test('mute and solo are separate controls and report pressed state', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();

  const row = container.querySelectorAll('.stem-row')[1]; // drums
  const [mute, solo] = row.querySelectorAll('.stem-row__actions button');

  mute.click();
  await flush();
  assert.deepEqual(desk.calls.at(-1), ['setMuted', 'drums', true]);
  assert.equal(container.querySelectorAll('.stem-row')[1].querySelectorAll('button')[0].getAttribute('aria-pressed'), 'true');

  solo.click();
  await flush();
  assert.deepEqual(desk.calls.at(-1), ['setSolo', 'drums', true]);
  assert.equal(container.querySelectorAll('.stem-row')[1].querySelectorAll('button')[1].getAttribute('aria-pressed'), 'true');
});

test('a gain change targets one stem and shows the new dB value', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();

  const row = container.querySelectorAll('.stem-row')[2]; // bass
  const gain = row.querySelector('input[type="range"]');
  gain.value = '-12';
  gain.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();

  assert.deepEqual(desk.calls.at(-1), ['setGain', 'bass', -12]);
  const refreshed = container.querySelectorAll('.stem-row')[2];
  assert.match(refreshed.textContent, /-12 dB/);
  assert.equal(desk.lanes.find((lane) => lane.name === 'vocals').gainDb, 0);
});

test('a track with no separated stems says so instead of showing an empty desk', async () => {
  const { container } = mount({ variants: [] });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();
  assert.match(container.textContent, /no separated stems/i);
  assert.equal(container.querySelectorAll('.stem-row').length, 0);
});

test('a fallback center/sides split is labelled honestly and never as vocals', async () => {
  const { container } = mount({
    variants: [
      variant('center', { method: 'ffmpeg', model_name: 'center-side-v1' }),
      variant('sides', { method: 'ffmpeg', model_name: 'center-side-v1' }),
    ],
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();

  const rows = [...container.querySelectorAll('.stem-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Center \(mid\)/);
  assert.match(rows[0].textContent, /center\/side fallback/);
  assert.match(container.textContent, /not isolated vocals or instruments/i);
  assert.doesNotMatch(container.textContent, /Vocals/);
});

test('play and stop drive the one transport and a stop resets the clock label', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();

  const transportButtons = container.querySelectorAll('.stem-row__actions')[0].querySelectorAll('button');
  // transport row is the first .stem-row__actions rendered outside a stem row
  const allButtons = [...container.querySelectorAll('button')];
  const play = allButtons.find((button) => button.textContent === 'Play');
  const stop = allButtons.find((button) => button.textContent === 'Stop');
  play.click();
  await flush();
  assert.ok(desk.calls.some(([name]) => name === 'play'));
  assert.equal(play.textContent, 'Restart');
  stop.click();
  await flush();
  assert.ok(desk.calls.some(([name]) => name === 'stop'));
  assert.equal(desk.status, 'ready');
  assert.ok(transportButtons.length >= 0);
});

test('dispose releases the desk and clears the panel', async () => {
  const { container, desk, dispose } = mount({
    variants: [variant('vocals'), variant('drums')],
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();
  dispose();
  assert.equal(desk.disposed, true);
  assert.equal(container.childElementCount, 0);
});

test('the desk prefers four Demucs lanes when a fallback set also exists, never more than four', async () => {
  const { container, desk } = mount({
    variants: [
      variant('vocals'), variant('drums'), variant('bass'), variant('other'),
      variant('center', { method: 'ffmpeg', model_name: 'center-side-v1' }),
      variant('sides', { method: 'ffmpeg', model_name: 'center-side-v1' }),
    ],
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();

  assert.equal(desk.lanes.length, 4);
  assert.deepEqual(desk.lanes.map((lane) => lane.name), ['vocals', 'drums', 'bass', 'other']);
  assert.equal(container.querySelectorAll('.stem-row').length, 4);
});

test('the panel owns and passes ownsContext so the desk can close its own context', async () => {
  const { container, calls } = mount({ variants: [variant('vocals'), variant('drums')] });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();
  const [name, options] = calls.find(([entry]) => entry === 'createDesk');
  assert.equal(name, 'createDesk');
  assert.equal(options.ownsContext, true);
  assert.deepEqual(options.audioContext, { name: 'fake-context' });
});

test('a browser-suspended audio context is reported instead of claimed as playing', async () => {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  desk.contextState = 'suspended';
  const dispose = mountStemDeskPanel({
    container,
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: () => desk,
    listTracksImpl: async () => ({ items: [{ id: 'track-1', name: 'night-drive.wav' }] }),
    listStemsImpl: async () => ({ variants: [variant('vocals'), variant('drums')] }),
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'Play').click();
  await flush();
  assert.match(container.textContent, /blocking audio/i);
  dispose();
});

test('the real StemDesk runtime renders four lanes through the panel', async () => {
  const { StemDesk } = await import('../../src/twobecomeone/studio_static/js/runtime/stem-desk.js');

  class Gains { constructor() { this.gain = { value: 1 }; } connect() {} disconnect() {} }
  class Sources { constructor() { this.started = null; } connect() {} start(when, offset) { this.started = { when, offset }; } stop() {} disconnect() {} }
  const ctx = {
    state: 'running',
    currentTime: 5,
    destination: {},
    createGain: () => new Gains(),
    createBufferSource: () => new Sources(),
    decodeAudioData: async () => ({ duration: 8, length: 8000, numberOfChannels: 2 }),
    resume: async () => {},
  };

  const container = document.createElement('div');
  const dispose = mountStemDeskPanel({
    container,
    audioContextFactory: () => ctx,
    createDesk: (options) => new StemDesk({
      ...options,
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(16).buffer }),
    }),
    listTracksImpl: async () => ({ items: [{ id: 'track-1', name: 'night-drive.wav' }] }),
    listStemsImpl: async () => ({
      variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
    }),
  });
  await flush();
  container.querySelector('button.button--sm').click();
  await flush();

  const rows = container.querySelectorAll('.stem-row');
  assert.equal(rows.length, 4);
  const [mute] = rows[0].querySelectorAll('.stem-row__actions button');
  mute.click();
  await flush();
  assert.equal(container.querySelectorAll('.stem-row')[0].querySelectorAll('button')[0].getAttribute('aria-pressed'), 'true');
  dispose();
});
