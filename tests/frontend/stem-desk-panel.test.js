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

function equalPower(position) {
  const angle = Math.max(0, Math.min(100, Number(position))) * Math.PI / 200;
  return { gainA: Math.cos(angle), gainB: Math.sin(angle) };
}

/** A desk stand-in that applies the same two-group mute/solo/gain law as the runtime. */
class FakeDesk {
  constructor() {
    this.calls = [];
    this.disposed = false;
    this.groups = [];
    this.silentNames = [];
    this.status = 'idle';
    this.position = 0;
    this.crossfaderPosition = 50;
    this.error = null;
  }

  setLanes(trackId, title, lanes) {
    return {
      trackId,
      title,
      lanes: lanes.map((lane) => ({
        ...lane,
        key: `${trackId}:${lane.name}`,
        trackId,
        gainDb: 0,
        muted: false,
        solo: false,
        silent: this.silentNames.includes(lane.name),
        rmsDb: this.silentNames.includes(lane.name) ? -68 : -24,
      })),
    };
  }

  async load(lanes) {
    this.calls.push(['load', lanes.map((lane) => lane.name)]);
    this.groups = [];
    return this.loadGroups([{ trackId: 'A', title: 'Load', lanes }]);
  }

  async loadGroups(groups) {
    for (const group of groups) {
      const trackId = group.trackId || 'A';
      const title = group.title || trackId;
      this.calls.push(['loadGroups', trackId, group.lanes.map((lane) => lane.name)]);
      const next = this.setLanes(trackId, title, group.lanes);
      const index = this.groups.findIndex((entry) => entry.trackId === trackId);
      if (index >= 0) this.groups[index] = next;
      else this.groups.push(next);
    }
    this.status = this.groups.length ? 'ready' : 'unavailable';
    this.error = null;
    return this.state();
  }

  crossfader() {
    if (!this.groups.length) return { position: this.crossfaderPosition, gainA: 0, gainB: 0, disabled: true };
    if (this.groups.length === 1) {
      const onlyB = this.groups[0].trackId === 'B';
      return {
        position: this.crossfaderPosition,
        gainA: onlyB ? 0 : 1,
        gainB: onlyB ? 1 : 0,
        disabled: true,
      };
    }
    const law = equalPower(this.crossfaderPosition);
    return { position: this.crossfaderPosition, gainA: law.gainA, gainB: law.gainB, disabled: false };
  }

  state() {
    const lanes = this.groups.flatMap((group) => group.lanes);
    const anySolo = lanes.some((lane) => lane.solo);
    const crossfader = this.crossfader();
    return {
      status: this.status,
      contextState: this.contextState || 'running',
      error: this.error,
      playing: this.status === 'playing',
      loop: false,
      positionSeconds: this.position,
      durationSeconds: 12,
      crossfader,
      groups: this.groups.map((group, index) => ({
        trackId: group.trackId,
        title: group.title,
        gain: (this.groups.length === 1 ? 1 : (index === 0 ? crossfader.gainA : crossfader.gainB))
          * Math.pow(10, (group.levelDb || 0) / 20),
        xfadeGain: this.groups.length === 1 ? 1 : (index === 0 ? crossfader.gainA : crossfader.gainB),
        levelDb: group.levelDb || 0,
        laneCount: group.lanes.length,
        laneKeys: group.lanes.map((lane) => lane.key),
      })),
      lanes: lanes.map((lane) => ({
        key: lane.key,
        trackId: lane.trackId,
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
        rmsDb: lane.rmsDb,
        silent: lane.silent,
        effectiveGain: (anySolo ? lane.solo : !lane.muted) ? Math.pow(10, lane.gainDb / 20) : 0,
      })),
    };
  }

  _find(name) {
    const key = String(name);
    return this.groups.flatMap((group) => group.lanes)
      .find((lane) => lane.key === key || lane.name === key);
  }

  async resume() { this.calls.push(['resume']); return this.state(); }
  play(options = {}) {
    this.calls.push(['play', Boolean(options.loop)]);
    if (this.contextState === 'suspended' || this.contextState === 'interrupted') {
      const error = new Error('the audio context is suspended by the browser');
      error.code = 'S_CONTEXT_SUSPENDED';
      throw error;
    }
    this.status = 'playing';
    return this.state();
  }
  stop() { this.calls.push(['stop']); this.status = 'ready'; this.position = 0; return this.state(); }
  setGain(name, db) {
    this.calls.push(['setGain', name, Number(db)]);
    this._find(name).gainDb = Number(db);
    return this.state();
  }

  setMuted(name, value) {
    this.calls.push(['setMuted', name, value]);
    this._find(name).muted = Boolean(value);
    return this.state();
  }

  setSolo(name, value) {
    this.calls.push(['setSolo', name, value]);
    this._find(name).solo = Boolean(value);
    return this.state();
  }

  setCrossfader(value) {
    this.calls.push(['setCrossfader', Number(value)]);
    this.crossfaderPosition = Number(value);
    return this.state();
  }

  setTrackLevel(trackId, db) {
    this.calls.push(['setTrackLevel', trackId, Number(db)]);
    const group = this.groups.find((entry) => entry.trackId === trackId);
    if (group) group.levelDb = Number(db);
    return this.state();
  }

  unloadGroup(trackId) {
    this.calls.push(['unloadGroup', trackId]);
    this.groups = this.groups.filter((group) => group.trackId !== trackId);
    this.status = this.groups.length ? 'ready' : 'idle';
    return this.state();
  }

  positionSeconds() { return this.position; }
  position() { return this.position; }
  dispose() { this.disposed = true; }
}

function mount({
  variants = [],
  variantsByTrack = null,
  tracks = [{ id: 'track-1', name: 'night-drive.wav' }],
  silentNames = [],
} = {}) {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  desk.silentNames = silentNames;
  const calls = [];
  const dispose = mountStemDeskPanel({
    container,
    onAnnounce: () => {},
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: (options) => {
      calls.push(['createDesk', options]);
      return desk;
    },
    listTracksImpl: async () => {
      calls.push(['listTracks']);
      return { items: tracks, total: tracks.length, limit: 50, offset: 0 };
    },
    listStemsImpl: async (trackId) => {
      calls.push(['listStems', trackId]);
      const selected = variantsByTrack ? (variantsByTrack[trackId] || []) : variants;
      return {
        stems: ['full', ...selected.map((entry) => entry.name)],
        variants: [{ name: 'full' }, ...selected],
      };
    },
  });
  return { container, desk, calls, dispose };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function loadButton(container, groupId) {
  return container.querySelector(`button[aria-label="Load stems ${groupId}"]`);
}

async function loadGroup(container, groupId) {
  loadButton(container, groupId).click();
  await flush();
}

function selectFor(container, groupId) {
  return container.querySelector(`select[aria-label="Track for group ${groupId}"]`);
}

test('the desk lists tracks, loads four stems into group A and labels their provenance', async () => {
  const { container, desk, calls } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  const select = selectFor(container, 'A');
  select.dispatchEvent(new window.Event('focus'));
  await flush();

  const options = [...select.options].map((option) => option.textContent);
  assert.deepEqual(options, ['night-drive.wav']);
  assert.equal(select.value, 'track-1');
  assert.equal(selectFor(container, 'B').value, 'track-1', 'both groups can choose a track');

  await loadGroup(container, 'A');

  const rows = container.querySelectorAll('.stem-desk__row');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelector('.stem-desk__name').textContent, 'Vocals');
  assert.match(rows[0].querySelector('.stem-desk__meta').textContent, /demucs/);
  assert.match(rows[0].querySelector('.stem-desk__meta').textContent, /htdemucs@4\.1\.0/);
  assert.equal(rows[3].querySelector('.stem-desk__name').textContent, 'Other');
  assert.match(container.querySelector('.stem-desk__group-title').textContent, /Group A/);
  assert.deepEqual(desk.calls.find(([name]) => name === 'loadGroups'), ['loadGroups', 'A', ['vocals', 'drums', 'bass', 'other']]);
  assert.equal(desk.groups.length, 1);
  assert.equal(calls.some(([name]) => name === 'createDesk'), true);
});

test('two group selects load two tracks into eight rows under two headings', async () => {
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' },
      { id: 'track-2', name: 'slow-burn.wav', title: 'Slow Burn' },
    ],
    variantsByTrack: {
      'track-1': [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
      'track-2': [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';

  await loadGroup(container, 'A');
  await loadGroup(container, 'B');

  const sections = container.querySelectorAll('.stem-desk__group');
  assert.equal(sections.length, 2);
  const headings = [...container.querySelectorAll('.stem-desk__group-title')].map((el) => el.textContent);
  assert.match(headings[0], /Group A · Night Drive/);
  assert.match(headings[1], /Group B · Slow Burn/);
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 8);
  assert.deepEqual(desk.groups.map((group) => group.trackId), ['A', 'B']);

  const muteA = container.querySelector('button[aria-label="Mute A · Vocals"]');
  const muteB = container.querySelector('button[aria-label="Mute B · Vocals"]');
  assert.ok(muteA, 'each row names its group and lane for assistive tech');
  assert.ok(muteB);
});

test('loading group B is non-destructive and keeps group A rows alive', async () => {
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' },
      { id: 'track-2', name: 'slow-burn.wav', title: 'Slow Burn' },
    ],
    variantsByTrack: {
      'track-1': [variant('vocals'), variant('drums')],
      'track-2': [variant('vocals'), variant('drums')],
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';

  await loadGroup(container, 'A');
  const aRows = [...container.querySelectorAll('.stem-desk__row')];
  await loadGroup(container, 'B');

  assert.equal(desk.groups.length, 2);
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
  assert.equal(aRows.length, 2, 'group A still has both rows before and after loading B');
  assert.ok(container.querySelector('.stem-desk__row[data-key="A:vocals"]'), 'group A row survives loading B');
  assert.ok(container.querySelector('.stem-desk__row[data-key="A:drums"]'), 'group A drums survive loading B');
  assert.deepEqual(
    desk.calls.filter(([name]) => name === 'loadGroups').map(([, groupId]) => groupId),
    ['A', 'B'],
  );
  assert.equal(container.querySelectorAll('.stem-desk__transport button').length, 2, 'one transport only');
});

test('mute and solo are separate controls and report pressed state', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  await loadGroup(container, 'A');

  const row = container.querySelectorAll('.stem-desk__row')[1]; // drums
  const [mute, solo] = row.querySelectorAll('.stem-desk__actions button');

  mute.click();
  await flush();
  assert.deepEqual(desk.calls.at(-1), ['setMuted', 'A:drums', true]);
  assert.equal(container.querySelectorAll('.stem-desk__row')[1].querySelectorAll('button')[0].getAttribute('aria-pressed'), 'true');

  solo.click();
  await flush();
  assert.deepEqual(desk.calls.at(-1), ['setSolo', 'A:drums', true]);
  assert.equal(container.querySelectorAll('.stem-desk__row')[1].querySelectorAll('button')[1].getAttribute('aria-pressed'), 'true');
});

test('a gain input updates that row in place and shows the new dB value', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  await loadGroup(container, 'A');

  const row = container.querySelectorAll('.stem-desk__row')[2]; // bass
  const gain = row.querySelector('input[type="range"]');
  gain.value = '-12';
  gain.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();

  assert.deepEqual(desk.calls.at(-1), ['setGain', 'A:bass', -12]);
  const refreshed = container.querySelectorAll('.stem-desk__row')[2];
  assert.equal(refreshed, row, 'the same row node is updated, not rebuilt');
  assert.match(refreshed.textContent, /-12 dB/);
  assert.equal(desk._find('A:vocals').gainDb, 0);
});

test('a track with no separated stems says so instead of showing an empty desk', async () => {
  const { container } = mount({ variants: [] });
  await flush();
  await loadGroup(container, 'A');
  assert.match(container.textContent, /no separated stems/i);
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 0);
});

test('a fallback center/sides split is labelled honestly and never as vocals', async () => {
  const { container } = mount({
    variants: [
      variant('center', { method: 'ffmpeg', model_name: 'center-side-v1' }),
      variant('sides', { method: 'ffmpeg', model_name: 'center-side-v1' }),
    ],
  });
  await flush();
  await loadGroup(container, 'A');

  const rows = [...container.querySelectorAll('.stem-desk__row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Center \(mid\)/);
  assert.match(rows[0].textContent, /center\/side fallback/);
  assert.match(container.textContent, /not isolated vocals or instruments/i);
  assert.doesNotMatch(container.textContent, /Vocals/);
});

test('play and stop drive the one transport and keep the accepted single-track loop', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
  });
  await flush();
  await loadGroup(container, 'A');

  const allButtons = [...container.querySelectorAll('button')];
  const play = allButtons.find((button) => button.textContent === 'Play');
  const stop = allButtons.find((button) => button.textContent === 'Stop');
  play.click();
  await flush();
  assert.ok(desk.calls.some(([name]) => name === 'play'));
  // One loaded track keeps the accepted four-stem behaviour: it loops.
  assert.deepEqual(
    desk.calls.find(([name]) => name === 'play'),
    ['play', true],
    'the accepted single-track desk still loops',
  );
  assert.equal(play.textContent, 'Restart');
  stop.click();
  await flush();
  assert.ok(desk.calls.some(([name]) => name === 'stop'));
  assert.equal(desk.status, 'ready');
});

test('the crossfader is disabled for one track and writes equal-power gains for two', async () => {
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' },
      { id: 'track-2', name: 'slow-burn.wav', title: 'Slow Burn' },
    ],
    variantsByTrack: {
      'track-1': [variant('vocals'), variant('drums')],
      'track-2': [variant('vocals'), variant('drums')],
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';

  await loadGroup(container, 'A');
  const slider = container.querySelector('.stem-desk__crossfader');
  assert.equal(slider.disabled, true, 'one track has nothing to crossfade');
  assert.match(container.querySelector('.stem-desk__crossfader-gains').textContent, /gainA 1\.00 · gainB 0\.00/);

  await loadGroup(container, 'B');
  assert.equal(slider.disabled, false);
  assert.match(container.querySelector('.stem-desk__crossfader-gains').textContent, /gainA 0\.71 · gainB 0\.71/);

  slider.value = '0';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();
  assert.deepEqual(desk.calls.at(-1), ['setCrossfader', 0]);
  assert.match(container.querySelector('.stem-desk__crossfader-gains').textContent, /gainA 1\.00 · gainB 0\.00/);
});

test('dispose releases the desk and clears the panel', async () => {
  const { container, desk, dispose } = mount({
    variants: [variant('vocals'), variant('drums')],
  });
  await flush();
  await loadGroup(container, 'A');
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
  await loadGroup(container, 'A');

  assert.equal(desk.groups[0].lanes.length, 4);
  assert.deepEqual(desk.groups[0].lanes.map((lane) => lane.name), ['vocals', 'drums', 'bass', 'other']);
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
});

test('the panel owns and passes ownsContext so the desk can close its own context', async () => {
  const { container, calls } = mount({ variants: [variant('vocals'), variant('drums')] });
  await flush();
  await loadGroup(container, 'A');
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
  await loadGroup(container, 'A');
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'Play').click();
  await flush();
  assert.doesNotMatch(container.textContent, /Playing \d+ stems together/);
  assert.match(container.textContent, /suspended by the browser|blocking audio/i);
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
    decodeAudioData: async () => ({
      duration: 8,
      length: 8000,
      numberOfChannels: 2,
      getChannelData: () => Float32Array.from({ length: 64 }, () => 0.1),
    }),
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
  await loadGroup(container, 'A');

  const rows = container.querySelectorAll('.stem-desk__row');
  assert.equal(rows.length, 4);
  const [mute] = rows[0].querySelectorAll('.stem-desk__actions button');
  mute.click();
  await flush();
  assert.equal(container.querySelectorAll('.stem-desk__row')[0].querySelectorAll('button')[0].getAttribute('aria-pressed'), 'true');
  dispose();
});

test('an effectively silent stem is labelled and its solo says why nothing is heard', async () => {
  const { container } = mount({
    variants: [variant('vocals'), variant('drums'), variant('bass'), variant('other')],
    silentNames: ['vocals'],
  });
  await flush();
  await loadGroup(container, 'A');

  const rows = container.querySelectorAll('.stem-desk__row');
  assert.match(rows[0].textContent, /effectively silent in this separation/);
  assert.doesNotMatch(rows[1].textContent, /effectively silent/);

  const solo = rows[0].querySelectorAll('.stem-desk__actions button')[1];
  solo.click();
  await flush();
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /Solo A · Vocals/);
  assert.match(status, /effectively silent/);
});

test('each group has its own level control that is not the crossfader', async () => {
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' },
      { id: 'track-2', name: 'slow-burn.wav', title: 'Slow Burn' },
    ],
    variantsByTrack: {
      'track-1': [variant('vocals'), variant('drums')],
      'track-2': [variant('vocals'), variant('drums')],
    },
  });
  await flush();
  await loadGroup(container, 'A', 'track-1');
  await loadGroup(container, 'B', 'track-2');

  const levelA = container.querySelector('.stem-desk__group[data-group="A"] .stem-desk__level');
  assert.ok(levelA, 'group A has a level control');
  levelA.value = '-6';
  levelA.dispatchEvent(new window.Event('input'));
  await flush();

  const call = desk.calls.find(([name]) => name === 'setTrackLevel');
  assert.deepEqual(call, ['setTrackLevel', 'A', -6]);
  const crossfaderCalls = desk.calls.filter(([name]) => name === 'setCrossfader').length;
  assert.equal(crossfaderCalls, 0, 'a level move is not a crossfade move');
});

test('two loaded tracks play once and say so, without claiming beat matching', async () => {
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' },
      { id: 'track-2', name: 'slow-burn.wav', title: 'Slow Burn' },
    ],
    variantsByTrack: {
      'track-1': [variant('vocals'), variant('drums')],
      'track-2': [variant('vocals'), variant('drums')],
    },
  });
  await flush();
  await loadGroup(container, 'A', 'track-1');
  await loadGroup(container, 'B', 'track-2');

  const play = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Play');
  play.click();
  await flush();
  assert.deepEqual(desk.calls.find(([name]) => name === 'play'), ['play', false], 'two tracks play once');
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /one clock/);
  assert.match(status, /not tempo or beat matching/);
  assert.doesNotMatch(status, /beat.?matched/i);
});
