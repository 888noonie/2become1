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
        peakDb: this.silentNames.includes(lane.name) ? -68 : -6,
      })),
      entryOffsetMs: 0,
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
      if (index >= 0) {
        next.entryOffsetMs = this.groups[index].entryOffsetMs || 0;
        this.groups[index] = next;
      } else this.groups.push(next);
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
        entryOffsetMs: group.entryOffsetMs || 0,
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
        stemSetId: lane.stemSetId,
        durationSeconds: 12,
        gainDb: lane.gainDb,
        muted: lane.muted,
        solo: lane.solo,
        audible: anySolo ? lane.solo : !lane.muted,
        rmsDb: lane.rmsDb,
        peakDb: lane.peakDb,
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

  setGroupEntryOffset(trackId, ms) {
    this.calls.push(['setGroupEntryOffset', trackId, Number(ms)]);
    const group = this.groups.find((entry) => entry.trackId === trackId);
    const value = Number(ms);
    if (group) {
      group.entryOffsetMs = Number.isFinite(value)
        ? Math.max(-4000, Math.min(4000, value))
        : 0;
    }
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
  openPicker = async () => 'close',
  submitSeparationImpl = async () => {
    throw new Error('separation was not stubbed');
  },
  listJobsImpl = async () => ({ items: [] }),
  watchJobImpl = () => () => {},
  listStemsImpl = null,
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
    openPicker,
    submitSeparationImpl,
    listJobsImpl,
    watchJobImpl,
    listTracksImpl: async () => {
      calls.push(['listTracks']);
      return { items: tracks, total: tracks.length, limit: 50, offset: 0 };
    },
    listStemsImpl: listStemsImpl || (async (trackId) => {
      calls.push(['listStems', trackId]);
      const selected = variantsByTrack ? (variantsByTrack[trackId] || []) : variants;
      return {
        stems: ['full', ...selected.map((entry) => entry.name)],
        variants: [{ name: 'full' }, ...selected],
      };
    }),
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

function chooseButton(container, groupId) {
  return container.querySelector(`button[aria-label="Choose from Library for group ${groupId}"]`);
}

function addButton(container, groupId) {
  return container.querySelector(`button[aria-label="Add / Process Track for group ${groupId}"]`);
}

const DEMUCS_QUAD = ['vocals', 'drums', 'bass', 'other'].map((name) => variant(name));
const IMPORTED_HASH = 'a1b2c3d4e5f60718';
const IMPORTED_QUAD = ['vocals', 'drums', 'bass', 'other'].map((name) => variant(name, {
  method: 'imported',
  model_name: IMPORTED_HASH,
  device: null,
}));

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
  assert.match(
    rows[0].querySelector('.stem-desk__meta').textContent,
    /set set-1/,
    'provenance names the stem set that produced the lane',
  );
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
  assert.match(rows[0].textContent, /effectively silent in this set/);
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

test('a refused replacement shows the runtime reason, not a bare success', async () => {
  const { container, desk } = mount({
    variants: [variant('vocals'), variant('drums')],
  });
  await flush();
  await loadGroup(container, 'A');

  // Simulate the desk refusing a replacement because the lanes are too large.
  desk.loadGroups = async () => {
    desk.error = {
      code: 'S_STEM_TOO_LONG',
      message: 'per-lane budget exceeded',
      failures: [{
        name: 'vocals',
        code: 'S_STEM_TOO_LONG',
        message: 'stem vocals decodes to 45312000 bytes; the desk holds at most 41943040 per stem',
      }],
    };
    return desk.state();
  };
  await loadGroup(container, 'A');

  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /S_STEM_TOO_LONG/);
  assert.match(status, /at most 41943040 per stem/);
});

test('two quick Load clicks start only one load, even before the library resolves', async () => {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  let releaseTracks;
  const tracksGate = new Promise((resolve) => { releaseTracks = resolve; });
  const dispose = mountStemDeskPanel({
    container,
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: () => desk,
    listTracksImpl: async () => {
      await tracksGate;
      return { items: [{ id: 'track-1', name: 'night-drive.wav' }] };
    },
    listStemsImpl: async () => ({ variants: [variant('vocals'), variant('drums')] }),
  });
  await flush();

  const loadA = container.querySelector('button[aria-label="Load stems A"]');
  loadA.click();
  loadA.click();
  releaseTracks();
  await flush();
  await flush();

  const loads = desk.calls.filter(([name]) => name === 'loadGroups');
  assert.equal(loads.length, 1, 'the second click is ignored while one load is reserved');
  assert.equal(container.querySelector('button[aria-label="Load stems A"]').disabled, false,
    'the button is usable again after the load settles');
  dispose();
});

test('an empty library or no chosen track never leaves the Load buttons disabled', async () => {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  const dispose = mountStemDeskPanel({
    container,
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: () => desk,
    listTracksImpl: async () => ({ items: [] }),
    listStemsImpl: async () => ({ variants: [] }),
  });
  await flush();

  const loadA = container.querySelector('button[aria-label="Load stems A"]');
  loadA.click();               // empty library, no track selected
  await flush();
  assert.equal(loadA.disabled, false, 'button recovers after an empty library');

  // A failing library request must also release the slot.
  const failContainer = document.createElement('div');
  const failDesk = new FakeDesk();
  const disposeFail = mountStemDeskPanel({
    container: failContainer,
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: () => failDesk,
    listTracksImpl: async () => { throw new Error('library request failed'); },
    listStemsImpl: async () => ({ variants: [] }),
  });
  await flush();
  const failLoad = failContainer.querySelector('button[aria-label="Load stems A"]');
  failLoad.click();
  await flush();
  assert.equal(failLoad.disabled, false, 'button recovers after a failed library request');
  dispose();
  disposeFail();
});

test('a throwing announcement listener cannot break the load path or the buttons', async () => {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  const dispose = mountStemDeskPanel({
    container,
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: () => desk,
    listTracksImpl: async () => ({ items: [{ id: 'track-1', name: 'night-drive.wav' }] }),
    listStemsImpl: async () => ({ variants: [variant('vocals'), variant('drums')] }),
    onAnnounce: () => { throw new Error('announcement viewer failed'); },
  });
  await flush();
  const loadA = container.querySelector('button[aria-label="Load stems A"]');
  loadA.click();
  await flush();
  await flush();
  assert.equal(desk.calls.filter(([name]) => name === 'loadGroups').length, 1);
  assert.equal(loadA.disabled, false, 'the button is usable after a throwing listener');
  dispose();
});

test('each group can choose from the library without loading or touching the other group', async () => {
  let seen = null;
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav' },
      { id: 'track-2', name: 'slow-burn.wav' },
    ],
    variantsByTrack: {
      'track-1': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-a' })),
      'track-2': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-b' })),
    },
    openPicker: async (_store, slot, options) => {
      seen = { slot, initialTab: options.initialTab };
      options.onPick({ id: 'track-2', name: 'slow-burn.wav' });
      return 'pick';
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  assert.equal(chooseButton(container, 'A').textContent, 'Choose from Library');
  assert.equal(addButton(container, 'B').textContent, 'Add / Process Track');
  assert.equal(loadButton(container, 'A').textContent, 'Load A');
  chooseButton(container, 'B').click();
  await flush();
  assert.equal(seen.slot, null);
  assert.equal(seen.initialTab, 'library');
  assert.equal(selectFor(container, 'B').value, 'track-2');
  assert.equal(selectFor(container, 'A').value, 'track-1');
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
  assert.match(container.querySelector('.stem-desk__status').textContent, /Four Demucs stems are ready/);
});

test('adding a track opens Choose Track and does not treat the import as separated', async () => {
  let seen = null;
  const { container, desk } = mount({
    tracks: [{ id: 'track-1', name: 'night-drive.wav' }],
    variantsByTrack: { 'track-1': DEMUCS_QUAD, fresh: [] },
    listJobsImpl: async () => ({ items: [] }),
    openPicker: async (_store, slot, options) => {
      seen = { slot, initialTab: options.initialTab };
      await options.onImported({ id: 'fresh', name: 'fresh.wav' });
      return 'close';
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  assert.equal(seen.slot, null);
  assert.equal(seen.initialTab, 'upload');
  assert.equal(selectFor(container, 'A').value, 'fresh');
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /full mix is in the library/i);
  assert.match(status, /not finished/i);
  assert.doesNotMatch(status, /Four Demucs stems are ready/);
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
});

test('a fast separation is reported only after the stem list is read', async () => {
  const { container, desk } = mount({
    tracks: [{ id: 'track-1', name: 'night-drive.wav' }],
    variantsByTrack: { 'track-1': DEMUCS_QUAD, fresh: DEMUCS_QUAD },
    listJobsImpl: async () => ({ items: [] }),
    openPicker: async (_store, _slot, options) => {
      await options.onImported({ id: 'fresh', name: 'fresh.wav' });
      return 'close';
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /full mix is in the library/i);
  assert.match(status, /Four Demucs stems are ready/);
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
});

test('a failed or cancelled automatic separation is named after import', async () => {
  for (const status of ['failed', 'cancelled']) {
    const { container, dispose } = mount({
      tracks: [{ id: 'track-1', name: 'night-drive.wav' }],
      variantsByTrack: { 'track-1': DEMUCS_QUAD, fresh: [] },
      listJobsImpl: async () => ({
        items: [{
          id: `job-${status}`,
          kind: 'separate',
          status,
          error: 'Stem decode failed',
          request: { track_id: 'fresh', method: 'auto' },
        }],
      }),
      openPicker: async (_store, _slot, options) => {
        await options.onImported({ id: 'fresh', name: 'fresh.wav' });
        return 'close';
      },
    });
    await flush();
    selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
    await flush();
    addButton(container, 'A').click();
    await flush();
    const text = container.querySelector('.stem-desk__status').textContent;
    assert.match(text, new RegExp(status, 'i'));
    assert.match(text, /Stem decode failed/);
    assert.match(text, /retry/i);
    assert.doesNotMatch(text, /not finished yet/);
    dispose();
  }
});

test('a track without Demucs stems requests processing and does not claim a center/sides result', async () => {
  const submitted = [];
  let onUpdate = null;
  let stems = [];
  const { container, desk } = mount({
    tracks: [{ id: 'track-1', name: 'bare.wav' }],
    openPicker: async () => { throw new Error('picker should stay closed'); },
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async (trackId, method) => {
      submitted.push([trackId, method]);
      return {
        id: 'job-1', status: 'queued', message: 'Queued',
        request: { track_id: trackId, method },
      };
    },
    watchJobImpl: (_id, callback) => {
      onUpdate = callback;
      return () => {};
    },
    listStemsImpl: async () => ({ variants: [{ name: 'full' }, ...stems] }),
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  assert.deepEqual(submitted, [['track-1', 'demucs']]);
  assert.match(container.querySelector('.stem-desk__status').textContent, /queued/i);
  onUpdate({
    id: 'job-1', status: 'running', message: 'Separating',
    request: { track_id: 'track-1', method: 'demucs' },
    progress_detail: { percent: 40 },
  });
  await flush();
  assert.match(container.querySelector('.stem-desk__status').textContent, /running/);
  assert.match(container.querySelector('.stem-desk__status').textContent, /40/);
  stems = [
    variant('center', { method: 'ffmpeg', model_name: 'center-side-v1' }),
    variant('sides', { method: 'ffmpeg', model_name: 'center-side-v1' }),
  ];
  onUpdate({
    id: 'job-1', status: 'complete', message: 'Separation complete',
    request: { track_id: 'track-1', method: 'demucs' },
  });
  await flush();
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /center\/sides/i);
  assert.match(status, /not four Demucs stems/i);
  assert.doesNotMatch(status, /Four Demucs stems are ready/);
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
});

test('a finished Demucs job stays unloaded until Load is pressed', async () => {
  let onUpdate = null;
  let ready = false;
  const { container, desk } = mount({
    tracks: [{ id: 'track-1', name: 'bare.wav' }],
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async (trackId) => ({
      id: 'job-2', status: 'queued', message: 'Queued',
      request: { track_id: trackId, method: 'demucs' },
    }),
    watchJobImpl: (_id, callback) => {
      onUpdate = callback;
      return () => {};
    },
    listStemsImpl: async () => ({
      variants: [{ name: 'full' }, ...(ready ? DEMUCS_QUAD : [])],
    }),
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  ready = true;
  onUpdate({
    id: 'job-2', status: 'complete', message: 'Separation complete',
    request: { track_id: 'track-1', method: 'demucs' },
  });
  await flush();
  assert.match(container.querySelector('.stem-desk__status').textContent, /Four Demucs stems are ready/);
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
  await loadGroup(container, 'A');
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
});

test('missing Demucs and a cancelled job name the failure and the retry', async () => {
  const { container } = mount({
    tracks: [{ id: 'track-1', name: 'bare.wav' }],
    variants: [],
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async () => {
      throw new Error('Demucs is not installed');
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  assert.match(container.querySelector('.stem-desk__status').textContent, /Demucs is not installed/);
  assert.match(container.querySelector('.stem-desk__status').textContent, /retry/i);

  let onUpdate = null;
  const second = mount({
    tracks: [{ id: 'track-1', name: 'bare.wav' }],
    variants: [],
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async (trackId) => ({
      id: 'job-3', status: 'queued', message: 'Queued',
      request: { track_id: trackId, method: 'demucs' },
    }),
    watchJobImpl: (_id, callback) => {
      onUpdate = callback;
      return () => {};
    },
  });
  await flush();
  selectFor(second.container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(second.container, 'A').click();
  await flush();
  onUpdate({
    id: 'job-3', status: 'cancelled', message: 'Cancelled',
    request: { track_id: 'track-1', method: 'demucs' },
  });
  await flush();
  const status = second.container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /cancelled/i);
  assert.match(status, /retry/i);
  second.dispose();
});

test('a stale separation result cannot describe the track now selected', async () => {
  let onUpdate = null;
  const stems = {
    'track-1': [],
    'track-2': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-b' })),
  };
  const { container } = mount({
    tracks: [
      { id: 'track-1', name: 'bare.wav' },
      { id: 'track-2', name: 'ready.wav' },
    ],
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async (trackId) => ({
      id: 'job-4', status: 'queued', message: 'Queued',
      request: { track_id: trackId, method: 'demucs' },
    }),
    watchJobImpl: (_id, callback) => {
      onUpdate = callback;
      return () => {};
    },
    listStemsImpl: async (trackId) => ({ variants: [{ name: 'full' }, ...(stems[trackId] || [])] }),
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  const select = selectFor(container, 'A');
  select.value = 'track-2';
  select.dispatchEvent(new window.Event('change'));
  await flush();
  stems['track-1'] = [
    variant('center', { method: 'ffmpeg', model_name: 'center-side-v1' }),
    variant('sides', { method: 'ffmpeg', model_name: 'center-side-v1' }),
  ];
  onUpdate({
    id: 'job-4', status: 'complete', message: 'Separation complete',
    request: { track_id: 'track-1', method: 'demucs' },
  });
  await flush();
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /Four Demucs stems are ready/);
  assert.doesNotMatch(status, /center\/sides/i);
});

test('a failed load of group B leaves group A playing lanes in place', async () => {
  const { container } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav' },
      { id: 'track-2', name: 'broken.wav' },
    ],
    listStemsImpl: async (trackId) => {
      if (trackId === 'track-2') throw new Error('stems unavailable');
      return { variants: [{ name: 'full' }, ...DEMUCS_QUAD] };
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';
  await loadGroup(container, 'A');
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
  await loadGroup(container, 'B');
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
  assert.match(container.querySelector('.stem-desk__group-title').textContent, /Group A/);
  assert.match(container.querySelector('.stem-desk__status').textContent, /group B/i);
});

test('two ready library tracks keep their own stem sets when both groups load', async () => {
  const { container } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav' },
      { id: 'track-2', name: 'slow-burn.wav' },
    ],
    variantsByTrack: {
      'track-1': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-aaa' })),
      'track-2': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-bbb' })),
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';
  await loadGroup(container, 'A');
  await loadGroup(container, 'B');
  const titles = [...container.querySelectorAll('.stem-desk__group-title')].map((node) => node.textContent);
  assert.match(titles[0], /Group A/);
  assert.match(titles[1], /Group B/);
  const metas = [...container.querySelectorAll('.stem-desk__meta')].map((node) => node.textContent);
  assert.ok(metas.some((text) => text.includes('set set-aaa')));
  assert.ok(metas.some((text) => text.includes('set set-bbb')));
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 8);
});

test('a processing failure on group B leaves a ready group A loaded', async () => {
  const { container } = mount({
    tracks: [
      { id: 'track-1', name: 'ready.wav' },
      { id: 'track-2', name: 'bare.wav' },
    ],
    variantsByTrack: {
      'track-1': DEMUCS_QUAD,
      'track-2': [],
    },
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async () => {
      throw new Error('Demucs is not installed');
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';
  await loadGroup(container, 'A');
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
  addButton(container, 'B').click();
  await flush();
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
  assert.match(container.querySelector('.stem-desk__group-title').textContent, /Group A/);
  assert.match(container.querySelector('.stem-desk__status').textContent, /group B/i);
  assert.match(container.querySelector('.stem-desk__status').textContent, /Demucs is not installed/);
});

test('an in-flight separation is shown and not submitted twice', async () => {
  const submitted = [];
  let watched = null;
  const { container } = mount({
    tracks: [{ id: 'track-1', name: 'bare.wav' }],
    variants: [],
    submitSeparationImpl: async (trackId, method) => {
      submitted.push([trackId, method]);
      return { id: 'should-not-run', status: 'queued', request: { track_id: trackId } };
    },
    listJobsImpl: async () => ({
      items: [{
        id: 'job-live',
        kind: 'separate',
        status: 'running',
        message: 'Working',
        request: { track_id: 'track-1', method: 'auto' },
      }],
    }),
    watchJobImpl: (id) => {
      watched = id;
      return () => {};
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  addButton(container, 'A').click();
  await flush();
  assert.deepEqual(submitted, []);
  assert.equal(watched, 'job-live');
  assert.match(container.querySelector('.stem-desk__status').textContent, /running/i);
});

test('an empty library still opens Choose Track', async () => {
  let opened = 0;
  const { container } = mount({
    tracks: [],
    openPicker: async (_store, slot, options) => {
      opened += 1;
      assert.equal(slot, null);
      assert.equal(options.initialTab, 'library');
      return 'close';
    },
  });
  await flush();
  chooseButton(container, 'A').click();
  await flush();
  assert.equal(opened, 1);
  assert.match(container.querySelector('.stem-desk__status').textContent, /No tracks are available|empty/i);
});

test('earlier, later and reset show a signed group offset and do not start playback', async () => {
  const { container, desk } = mount({ variants: DEMUCS_QUAD });
  await flush();
  await loadGroup(container, 'A');

  const earlier = container.querySelector('button[aria-label="Group A earlier"]');
  const later = container.querySelector('button[aria-label="Group A later"]');
  const reset = container.querySelector('button[aria-label="Group A reset entry"]');
  assert.ok(earlier && later && reset, 'each loaded group has earlier, later and reset');
  assert.match(container.querySelector('.stem-desk__timing').textContent, /Takes effect on the next Play/);

  earlier.click();
  assert.equal(desk.calls.some(([name]) => name === 'play'), false);
  assert.equal(container.querySelector('.stem-desk__offset').textContent, '−10 ms');
  assert.match(container.querySelector('.stem-desk__status').textContent, /Group A entry −10 ms/);
  assert.match(container.querySelector('.stem-desk__status').textContent, /next Play/);

  later.click();
  later.click();
  assert.equal(container.querySelector('.stem-desk__offset').textContent, '+10 ms');

  reset.click();
  assert.equal(container.querySelector('.stem-desk__offset').textContent, '0 ms');
  assert.equal(desk.calls.filter(([name]) => name === 'setGroupEntryOffset').length, 4);
});

test('ask, preview, reject, and approve do not apply a proposal before approval', async () => {
  const { container, desk } = mount({
    tracks: [
      { id: 'track-1', name: 'night-drive.wav' },
      { id: 'track-2', name: 'slow-burn.wav' },
    ],
    variantsByTrack: {
      'track-1': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-aaa' })),
      'track-2': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-bbb' })),
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(container, 'A').value = 'track-1';
  selectFor(container, 'B').value = 'track-2';
  await loadGroup(container, 'A');
  const buttons = [...container.querySelectorAll('.stem-desk__proposal button')];
  const [askButton, previewButton, approveButton, rejectButton] = buttons;
  assert.equal(askButton.textContent, 'Ask for a proposal');
  askButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Proposal incomplete/);
  assert.equal(desk.calls.some(([name]) => name === 'setMuted'), false);

  await loadGroup(container, 'B');
  const before = desk.calls.length;
  askButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Proposal not approved/);
  assert.equal(previewButton.disabled, false);
  assert.equal(approveButton.disabled, true);
  previewButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Preview only/);
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Nothing is applied until Approve/);
  assert.equal(desk.calls.length, before);
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'A:vocals').muted, false);

  rejectButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Proposal not approved/);
  assert.equal(desk.calls.length, before);
  assert.equal(approveButton.disabled, true);

  askButton.click();
  previewButton.click();
  approveButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Proposal approved/);
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'A:vocals').muted, true);
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'A:drums').muted, false);
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'B:vocals').muted, false);
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'B:drums').muted, true);
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'A:vocals').method, 'demucs');
  assert.equal(desk.state().lanes.find((lane) => lane.key === 'B:vocals').stemSetId, 'set-bbb');
  assert.equal(desk.calls.some(([name]) => name === 'play'), false);
  const applied = desk.calls.length;
  approveButton.click();
  assert.equal(desk.calls.length, applied);

  askButton.click();
  container.querySelector('button[aria-label="Group A earlier"]').click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Proposal not approved/);
  assert.equal(container.querySelector('.stem-desk__proposal button:nth-child(3)').disabled, true);

  desk.setSolo('B:vocals', true);
  const soloCalls = desk.calls.length;
  askButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /clear solo/);
  assert.equal(desk.calls.length, soloCalls);
  assert.equal(container.querySelector('.stem-desk__proposal button:nth-child(3)').disabled, true);
});

test('a complete imported quad is ready and never requests a separation', async () => {
  const submitted = [];
  const { container, desk } = mount({
    variantsByTrack: { 'track-1': IMPORTED_QUAD },
    listJobsImpl: async () => ({ items: [] }),
    submitSeparationImpl: async (trackId, method) => {
      submitted.push([trackId, method]);
      return {
        id: 'job-imported', status: 'queued', message: 'Queued',
        request: { track_id: trackId, method },
      };
    },
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();

  const select = selectFor(container, 'A');
  select.dispatchEvent(new window.Event('change'));
  await flush();
  const ready = container.querySelector('.stem-desk__status').textContent;
  assert.match(ready, /Four imported stems are ready/);
  assert.doesNotMatch(ready, /demucs/i);

  addButton(container, 'A').click();
  await flush();
  assert.deepEqual(submitted, [], 'a complete imported quad must not request Demucs');
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
});

test('imported provenance names the set hash and never claims Demucs', async () => {
  const { container } = mount({ variants: IMPORTED_QUAD });
  await flush();
  await loadGroup(container, 'A');

  const rows = [...container.querySelectorAll('.stem-desk__row')];
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const meta = row.querySelector('.stem-desk__meta').textContent;
    assert.equal(meta, 'imported · set a1b2c3d4', 'provenance is imported plus the truncated set hash');
    assert.doesNotMatch(meta, /demucs/i);
    assert.doesNotMatch(meta, new RegExp(IMPORTED_HASH), 'the full hash is not shown');
  }
  assert.doesNotMatch(container.querySelector('.stem-desk__lanes').textContent, /demucs/i);
});

test('three imported lanes without the fourth are not ready and say the set is incomplete', async () => {
  const { container, desk } = mount({
    variantsByTrack: { 'track-1': IMPORTED_QUAD.slice(0, 3) },
    listJobsImpl: async () => ({ items: [] }),
  });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();

  selectFor(container, 'A').dispatchEvent(new window.Event('change'));
  await flush();
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /3 of 4 imported stems/);
  assert.match(status, /incomplete/i);
  assert.doesNotMatch(status, /are ready/i);
  assert.doesNotMatch(status, /demucs/i);
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
});

test('a proposal arranges imported and Demucs groups without swapping their methods', async () => {
  const assignments = [
    ['imported', 'demucs'],
    ['demucs', 'imported'],
  ];
  for (const [methodA, methodB] of assignments) {
    const quad = (method, stemSetId) => (method === 'imported' ? IMPORTED_QUAD : DEMUCS_QUAD)
      .map((entry) => ({ ...entry, method, stem_set_id: stemSetId }));
    const { container, desk } = mount({
      tracks: [
        { id: 'track-1', name: 'left.wav' },
        { id: 'track-2', name: 'right.wav' },
      ],
      variantsByTrack: {
        'track-1': quad(methodA, 'set-a'),
        'track-2': quad(methodB, 'set-b'),
      },
    });
    await flush();
    selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
    await flush();
    selectFor(container, 'A').value = 'track-1';
    selectFor(container, 'B').value = 'track-2';
    await loadGroup(container, 'A');
    await loadGroup(container, 'B');
    const [askButton, previewButton, approveButton, rejectButton] = [
      ...container.querySelectorAll('.stem-desk__proposal button'),
    ];
    const before = desk.calls.length;
    askButton.click();
    previewButton.click();
    rejectButton.click();
    assert.equal(desk.calls.length, before, `${methodA}/${methodB} reject must not apply`);
    assert.equal(desk.state().lanes.find((lane) => lane.key === 'A:drums').muted, false);
    askButton.click();
    previewButton.click();
    approveButton.click();
    const lanes = desk.state().lanes;
    assert.equal(lanes.find((lane) => lane.key === 'A:drums').muted, false);
    assert.equal(lanes.find((lane) => lane.key === 'A:vocals').muted, true);
    assert.equal(lanes.find((lane) => lane.key === 'B:vocals').muted, false);
    assert.equal(lanes.find((lane) => lane.key === 'B:drums').muted, true);
    assert.ok(lanes.filter((lane) => lane.trackId === 'A').every((lane) => lane.method === methodA && lane.stemSetId === 'set-a'));
    assert.ok(lanes.filter((lane) => lane.trackId === 'B').every((lane) => lane.method === methodB && lane.stemSetId === 'set-b'));
    const metas = [...container.querySelectorAll('.stem-desk__row .stem-desk__meta')].map((node) => node.textContent);
    if (methodA === 'imported') assert.ok(metas.some((text) => text.startsWith('imported · set ')));
    if (methodB === 'imported') assert.ok(metas.some((text) => text.startsWith('imported · set ')));
    assert.equal(desk.calls.some(([name]) => name === 'play'), false);
  }
});
