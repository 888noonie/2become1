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

function mount({ variants, tracks = [{ id: 'track-1', title: 'Night Drive' }] } = {}) {
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
    listTracksImpl: async () => ({ tracks, total: tracks.length }),
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
  assert.deepEqual(options, ['Night Drive']);
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
