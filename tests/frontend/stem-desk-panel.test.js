import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import { StemDesk } from '../../src/twobecomeone/studio_static/js/runtime/stem-desk.js';
import { mountStemDeskPanel } from '../../src/twobecomeone/studio_static/js/components/stem-desk-panel.js';

let dom;
let disposeAfter;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => {
  try {
    disposeAfter?.();
  } finally {
    disposeAfter = null;
    teardownDom(dom);
  }
});

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
    this.lastLoad = null;
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

  async loadGroups(groups, options) {
    this.lastOptions = options || null;
    this.lastUrls = groups.flatMap((group) => group.lanes.map((lane) => lane.audioUrl));
    if (this.failNextGroups) {
      // The desk keeps its previous group and reports a refused reload. Only
      // two of four lanes fail here, the case where a failure count alone
      // cannot tell a refusal from a committed partial load.
      const message = this.failNextGroups;
      this.failNextGroups = null;
      const failures = groups.flatMap((group) => group.lanes.slice(0, 2).map((lane) => ({
        name: lane.name,
        code: 'S_STEM_UNAVAILABLE',
        message,
      })));
      this.error = { code: 'S_STEM_PARTIAL', message: 'some stems are unavailable', failures };
      this.lastLoad = {
        byTrack: Object.fromEntries(groups.map((group) => [group.trackId || 'A', {
          committed: false,
          failureCount: failures.length,
        }])),
      };
      return this.state();
    }
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
    this.lastLoad = {
      byTrack: Object.fromEntries(groups.map((group) => [group.trackId || 'A', {
        committed: true,
        failureCount: 0,
      }])),
    };
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
      lastLoad: this.lastLoad,
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
  store = null,
  crateSource = undefined,
  railHost = null,
} = {}) {
  const container = document.createElement('div');
  const desk = new FakeDesk();
  desk.silentNames = silentNames;
  const calls = [];
  const dispose = mountStemDeskPanel({
    container,
    store,
    onAnnounce: () => {},
    audioContextFactory: () => ({ name: 'fake-context' }),
    createDesk: (options) => {
      calls.push(['createDesk', options]);
      return desk;
    },
    openPicker,
    crateSource,
    railHost,
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

function unloadButton(container, groupId) {
  const button = container.querySelector(`button[aria-label="Unload stems from group ${groupId}"]`);
  assert.ok(button, `bank ${groupId} exposes an Unload stems button`);
  return button;
}

test('bank unload during playback stops both banks and preserves the other mix and library selection', async () => {
  const { container, desk, calls, dispose } = mount({ variants: DEMUCS_QUAD });
  document.body.append(container);
  disposeAfter = dispose;
  const unloadA = unloadButton(container, 'A');
  const unloadB = unloadButton(container, 'B');
  assert.equal(unloadA.disabled, true);
  assert.equal(unloadB.disabled, true);
  await loadGroup(container, 'A');
  assert.equal(unloadA.disabled, false);
  assert.equal(unloadB.disabled, true);
  await loadGroup(container, 'B');
  desk.setGain('A:vocals', -7);
  desk.setMuted('A:drums', true);
  desk.setSolo('A:bass', true);
  desk.setTrackLevel('A', -3);
  desk.setGroupEntryOffset('A', 20);
  const keptLanes = desk.state().lanes.filter((lane) => lane.trackId === 'A');
  const beforeCalls = calls.length;
  const track = selectFor(container, 'B').value;
  const play = container.querySelector('.stem-desk__transport button');
  play.click();
  await flush();
  assert.equal(play.textContent, 'Restart');
  unloadB.focus();
  unloadB.click();
  assert.equal(play.textContent, 'Play');
  assert.equal(play.disabled, false);
  assert.equal(container.querySelector('.stem-desk__transport').dataset.playing, 'false');
  assert.equal(container.querySelector('.stem-desk__transport button:nth-child(2)').disabled, true);
  assert.equal(container.querySelector('[aria-label="Crossfader A to B"]').disabled, true);
  assert.deepEqual(desk.state().lanes, keptLanes);
  assert.equal(desk.state().groups[0].levelDb, -3);
  assert.equal(desk.state().groups[0].entryOffsetMs, 20);
  assert.equal(container.querySelectorAll('.stem-desk__group[data-group="B"]').length, 0);
  assert.equal(selectFor(container, 'B').value, track);
  assert.equal(calls.length, beforeCalls, 'unload makes no library request');
  assert.equal(unloadB.disabled, true);
  assert.equal(document.activeElement, loadButton(container, 'B'));
  assert.match(container.querySelector('.stem-desk__status').textContent, /Unloaded.*B.*Playback stopped/);
  play.click();
  await flush();
  assert.deepEqual(desk.calls.filter(([name]) => name === 'play'), [['play', false], ['play', true]]);
  await loadGroup(container, 'B');
  assert.equal(unloadB.disabled, false);
  unloadB.click();
  unloadA.click();
  assert.equal(desk.state().status, 'idle');
  assert.equal(play.disabled, true);
});

test('bank unload cancels a pending stem list before it can start decoding', async () => {
  const held = Promise.withResolvers();
  let signal;
  let calls = 0;
  const { container, desk, dispose } = mount({
    listStemsImpl: async (_id, loadSignal) => {
      signal = loadSignal;
      calls += 1;
      return calls === 1 ? held.promise : { variants: DEMUCS_QUAD };
    },
  });
  disposeAfter = dispose;
  const unloadB = unloadButton(container, 'B');
  loadButton(container, 'B').click();
  await flush();
  assert.equal(unloadB.disabled, false, 'empty bank can cancel its pending load');
  assert.equal(unloadButton(container, 'A').disabled, true);
  unloadB.click();
  assert.equal(signal.aborted, true);
  assert.equal(unloadB.disabled, true);
  const status = container.querySelector('.stem-desk__status');
  assert.match(status.textContent, /Cancelled.*B/);
  loadButton(container, 'B').click();
  assert.equal(calls, 1, 'a retiring load still owns the one load slot');
  held.resolve({ variants: DEMUCS_QUAD });
  await flush();
  assert.equal(desk.calls.some(([name]) => name === 'loadGroups'), false);
  assert.match(status.textContent, /Cancelled.*B/);
  await loadGroup(container, 'B');
  assert.equal(desk.state().groups[0].trackId, 'B');
  assert.match(status.textContent, /Loaded 4 stems into group B/);
});

test('bank unload during the initial library request prevents the first stem request', async () => {
  const tracks = Promise.withResolvers();
  const container = document.createElement('div');
  const desk = new FakeDesk();
  let stemRequests = 0;
  disposeAfter = mountStemDeskPanel({
    container,
    audioContextFactory: () => ({}),
    createDesk: () => desk,
    listTracksImpl: () => tracks.promise,
    listStemsImpl: async () => {
      stemRequests += 1;
      return { variants: DEMUCS_QUAD };
    },
  });
  loadButton(container, 'A').click();
  unloadButton(container, 'A').click();
  tracks.resolve({ items: [{ id: 'track-1', name: 'night-drive.wav' }] });
  await flush();
  assert.equal(stemRequests, 0);
  assert.match(container.querySelector('.stem-desk__status').textContent, /Cancelled.*A/);
  await loadGroup(container, 'A');
  assert.equal(stemRequests, 1);
  assert.equal(desk.state().groups[0].trackId, 'A');
});

test('bank unload during a real desk decode drops the old result and permits a fresh load', async () => {
  const held = Promise.withResolvers();
  let holdDecode = false;
  let enteredDecode = false;
  const buffer = {
    duration: 8, length: 8000, numberOfChannels: 1,
    getChannelData: () => Float32Array.of(0.1),
  };
  const ctx = {
    state: 'running', currentTime: 5, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    decodeAudioData: async () => {
      if (!holdDecode) return buffer;
      enteredDecode = true;
      return held.promise;
    },
  };
  const container = document.createElement('div');
  let desk;
  const dispose = mountStemDeskPanel({
    container,
    audioContextFactory: () => ctx,
    createDesk: (options) => {
      desk = new StemDesk({
        ...options,
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
      });
      return desk;
    },
    listTracksImpl: async () => ({ items: [{ id: 'track-1', name: 'night-drive.wav' }] }),
    listStemsImpl: async () => ({ variants: DEMUCS_QUAD }),
  });
  disposeAfter = dispose;
  await loadGroup(container, 'A');
  await loadGroup(container, 'B');
  const a = desk._groups.find((group) => group.trackId === 'A');
  const bytes = desk._decodedBytes;
  const unloadB = unloadButton(container, 'B');
  holdDecode = true;
  loadButton(container, 'B').click();
  await flush();
  assert.equal(enteredDecode, true);
  assert.equal(unloadB.disabled, false);
  unloadB.click();
  assert.equal(desk._decodedBytes, bytes / 2);
  assert.equal(unloadB.disabled, true);
  loadButton(container, 'B').click();
  assert.equal(loadButton(container, 'B').disabled, true);
  holdDecode = false;
  held.resolve(buffer);
  await flush();
  assert.deepEqual(desk._groups, [a]);
  assert.equal(desk._decodedBytes, bytes / 2);
  assert.match(container.querySelector('.stem-desk__status').textContent, /Unloaded.*B/);
  await loadGroup(container, 'B');
  assert.equal(desk._decodedBytes, bytes);
  assert.equal(desk._groups.find((group) => group.trackId === 'A'), a);
});

test('bank unload leaves the other bank’s pending load in place', async () => {
  const held = Promise.withResolvers();
  let holdLoad = false;
  let pendingSignal;
  const { container, desk, dispose } = mount({
    listStemsImpl: async (_id, signal) => {
      if (!holdLoad) return { variants: DEMUCS_QUAD };
      pendingSignal = signal;
      return held.promise;
    },
  });
  disposeAfter = dispose;
  await loadGroup(container, 'A');
  holdLoad = true;
  loadButton(container, 'B').click();
  assert.ok(pendingSignal);
  unloadButton(container, 'A').click();
  assert.equal(pendingSignal.aborted, false);
  assert.equal(unloadButton(container, 'A').disabled, true);
  assert.equal(unloadButton(container, 'B').disabled, false);
  held.resolve({ variants: DEMUCS_QUAD });
  await flush();
  assert.deepEqual(desk.state().groups.map((group) => group.trackId), ['B']);
});

test('bank unload retires a Play still waiting for audio resume', async () => {
  const { container, desk, dispose } = mount({ variants: DEMUCS_QUAD });
  disposeAfter = dispose;
  await loadGroup(container, 'A');
  await loadGroup(container, 'B');
  const held = Promise.withResolvers();
  desk.resume = () => held.promise;
  const play = container.querySelector('.stem-desk__transport button');
  play.click();
  unloadButton(container, 'B').click();
  held.resolve(desk.state());
  await flush();
  assert.equal(desk.calls.some(([name]) => name === 'play'), false);
  assert.equal(play.textContent, 'Play');
  assert.match(container.querySelector('.stem-desk__status').textContent, /Unloaded.*B/);
  play.click();
  await flush();
  assert.deepEqual(desk.calls.find(([name]) => name === 'play'), ['play', true]);
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
  assert.match(container.querySelector('.stem-desk__crossfader-gains').textContent, /A 1\.00 \/ B 0\.00/);

  await loadGroup(container, 'B');
  assert.equal(slider.disabled, false);
  assert.match(container.querySelector('.stem-desk__crossfader-gains').textContent, /A 0\.71 \/ B 0\.71/);

  slider.value = '0';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();
  assert.deepEqual(desk.calls.at(-1), ['setCrossfader', 0]);
  assert.match(container.querySelector('.stem-desk__crossfader-gains').textContent, /A 1\.00 \/ B 0\.00/);
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
  const [askButton, previewButton, , approveButton, rejectButton] = buttons;
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
  // The approved idea can be taken back with the same button.
  assert.equal(approveButton.textContent, 'Undo');
  assert.equal(approveButton.disabled, false);

  askButton.click();
  container.querySelector('button[aria-label="Group A earlier"]').click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /Proposal not approved/);
  assert.equal(container.querySelector('.stem-desk__proposal button:nth-child(4)').disabled, true);

  desk.setSolo('B:vocals', true);
  const soloCalls = desk.calls.length;
  askButton.click();
  assert.match(container.querySelector('.stem-desk__proposal-status').textContent, /clear solo/);
  assert.equal(desk.calls.length, soloCalls);
  assert.equal(container.querySelector('.stem-desk__proposal button:nth-child(4)').disabled, true);
});

async function twoTrackDesk() {
  const ctx = mount({
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
  selectFor(ctx.container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(ctx.container, 'A').value = 'track-1';
  selectFor(ctx.container, 'B').value = 'track-2';
  await loadGroup(ctx.container, 'A');
  await loadGroup(ctx.container, 'B');
  const [ask, preview, hear, approve, reject] = [...ctx.container.querySelectorAll('.stem-desk__proposal button')];
  const lane = (key) => ctx.desk.state().lanes.find((entry) => entry.key === key);
  const say = () => ctx.container.querySelector('.stem-desk__proposal-status').textContent;
  const laneGain = (key) => ctx.container.querySelectorAll('.stem-desk__row')[
    ctx.desk.state().lanes.findIndex((entry) => entry.key === key)
  ].querySelector('input[type="range"]');
  return { ...ctx, ask, preview, hear, approve, reject, lane, say, laneGain };
}

const noPlay = (t) => assert.equal(t.desk.calls.some(([name]) => name === 'play'), false, 'nothing plays by itself');
const handMix = (t) => {
  // A mix the musician built by hand, so a return is not just the defaults.
  t.desk.setCrossfader(30);
  t.desk.setGain('B:drums', -4);
  t.desk.setTrackLevel('B', -3);
};
const setInput = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const suggestionHeard = (t) => {
  assert.equal(t.lane('A:vocals').muted, true);
  assert.equal(t.lane('B:drums').muted, true);
  assert.equal(t.desk.crossfaderPosition, 50);
};
const mineHeard = (t) => {
  assert.equal(t.lane('A:vocals').muted, false);
  assert.equal(t.lane('B:drums').muted, false);
  assert.equal(t.lane('B:drums').gainDb, -4);
  assert.equal(t.desk.crossfaderPosition, 30);
  assert.equal(t.desk.groups.find((group) => group.trackId === 'B').levelDb, -3);
};

test('1. Ask, Hear it, Hear mine, Hear it: one button flips, the keep button names what it keeps', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  assert.equal(t.hear.disabled, true, 'nothing to hear before a suggestion');
  t.ask.click();
  mineHeard(t);
  t.hear.click();
  suggestionHeard(t);
  assert.equal(t.hear.textContent, 'Hear mine');
  assert.equal(t.approve.textContent, 'Keep it');
  assert.equal(t.preview.disabled, true, 'Preview stays display-only and is not offered mid-audition');
  t.hear.click();
  mineHeard(t);
  assert.equal(t.hear.textContent, 'Hear it');
  assert.equal(t.approve.textContent, 'Keep mine');
  t.hear.click();
  suggestionHeard(t);
  assert.equal(t.approve.textContent, 'Keep it');
  noPlay(t);
});

test('2. Hear it, Keep it, Undo: the idea is kept and then taken back in one press', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  t.ask.click();
  t.hear.click();
  t.approve.click(); // Keep it
  suggestionHeard(t);
  assert.match(t.say(), /Kept the suggestion/);
  assert.equal(t.approve.textContent, 'Undo');
  assert.equal(t.approve.disabled, false);
  assert.equal(t.hear.disabled, true);
  assert.equal(t.reject.disabled, true);
  t.approve.click(); // Undo
  mineHeard(t);
  assert.match(t.say(), /Undone/);
  assert.equal(t.approve.textContent, 'Approve');
  assert.equal(t.approve.disabled, true);
  noPlay(t);
});

test('3. Hear mine, Keep mine keeps the musician mix and never applies the unheard suggestion (negative control)', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  t.ask.click();
  t.hear.click();
  t.hear.click(); // Hear mine
  const callsBefore = t.desk.calls.length;
  t.approve.click(); // labelled Keep mine (test 1 checks the label)
  // The previous build applied the suggestion here although the musician was
  // hearing their own mix; this assertion fails on that build.
  mineHeard(t);
  assert.equal(t.desk.calls.length, callsBefore, 'keeping what is heard changes nothing');
  assert.match(t.say(), /Kept your mix/);
  assert.equal(t.approve.textContent, 'Approve');
  assert.equal(t.approve.disabled, true, 'nothing was kept from the AI, so there is nothing to undo');
  assert.equal(t.hear.disabled, true);
  noPlay(t);
});

test('4. Hear it, move a fader, flip twice, Keep it: the move survives everything, and Undo leaves it', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  t.ask.click();
  t.hear.click();
  setInput(t.laneGain('A:drums'), '-7');
  t.hear.click();
  assert.equal(t.lane('A:drums').gainDb, -7, 'their move stays while hearing their mix');
  assert.equal(t.lane('A:vocals').muted, false);
  t.hear.click();
  assert.equal(t.lane('A:drums').gainDb, -7, 'and while hearing the suggestion');
  assert.equal(t.lane('A:vocals').muted, true);
  t.approve.click(); // Keep it
  assert.equal(t.lane('A:drums').gainDb, -7);
  suggestionHeard(t);
  t.approve.click(); // Undo
  assert.equal(t.lane('A:drums').gainDb, -7, 'Undo takes back the AI, not the musician');
  mineHeard(t);
  noPlay(t);
});

test('5. Keep it, then a manual adjustment, then Undo: Undo stays and the adjustment is kept', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  t.ask.click();
  t.hear.click();
  t.approve.click(); // Keep it
  setInput(t.laneGain('B:vocals'), '-5');
  t.container.querySelector('button[aria-label="Group A later"]').click();
  assert.equal(t.approve.textContent, 'Undo', 'carrying on does not throw the Undo away');
  t.approve.click();
  assert.equal(t.lane('B:vocals').gainDb, -5);
  assert.ok(t.desk.groups.find((group) => group.trackId === 'A').entryOffsetMs > 0);
  mineHeard(t);
  noPlay(t);
});

test('5b. Approve from Preview can be undone the same way', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  t.ask.click();
  t.preview.click();
  t.approve.click();
  suggestionHeard(t);
  assert.match(t.say(), /Proposal approved/);
  assert.equal(t.approve.textContent, 'Undo');
  t.approve.click();
  mineHeard(t);
  noPlay(t);
});

for (const view of ['suggestion', 'mix']) {
  test(`6. Reject while hearing the ${view} returns to the musician mix and keeps their move`, async () => {
    const t = await twoTrackDesk();
    handMix(t);
    t.ask.click();
    t.hear.click();
    if (view === 'mix') t.hear.click();
    setInput(t.laneGain('B:vocals'), '-3');
    t.reject.click();
    assert.equal(t.lane('B:vocals').gainDb, -3);
    mineHeard(t);
    assert.match(t.say(), /Back to your mix\. Nothing was kept/);
    assert.equal(t.approve.disabled, true);
    assert.equal(t.hear.disabled, true);
    noPlay(t);
  });
}

test('10. Asking again or choosing another track mid-audition returns to the mix; a kept Undo ends there too', async () => {
  const t = await twoTrackDesk();
  handMix(t);
  t.ask.click();
  t.hear.click();
  t.ask.click();
  mineHeard(t);
  assert.equal(t.hear.textContent, 'Hear it');
  assert.equal(t.hear.disabled, false, 'the new suggestion is ready to hear');
  t.hear.click();
  selectFor(t.container, 'A').dispatchEvent(new window.Event('change'));
  mineHeard(t);
  assert.equal(t.hear.disabled, true);

  t.ask.click();
  t.hear.click();
  t.approve.click(); // Keep it
  assert.equal(t.approve.textContent, 'Undo');
  selectFor(t.container, 'A').dispatchEvent(new window.Event('change'));
  assert.equal(t.approve.textContent, 'Approve', 'a new track ends the Undo rather than guessing');
  suggestionHeard(t);
  noPlay(t);
});

const TOUCHES = {
  'a lane gain': {
    touch: (t) => setInput(t.laneGain('A:drums'), '-7'),
    check: (t) => assert.equal(t.lane('A:drums').gainDb, -7),
  },
  'a lane mute': {
    touch: (t) => { t.container.querySelectorAll('.stem-desk__row')[2].querySelector('button[aria-label^="Mute "]').click(); },
    check: (t, wasMuted) => assert.equal(t.lane('A:bass').muted, !wasMuted),
  },
  'the crossfader': {
    touch: (t) => setInput(t.container.querySelector('input[aria-label="Crossfader A to B"]'), '80'),
    check: (t) => assert.equal(t.desk.crossfaderPosition, 80),
  },
  'a group level': {
    touch: (t) => setInput(t.container.querySelector('input[aria-label^="Group A"][aria-label$="level"]'), '-5'),
    check: (t) => assert.equal(t.desk.groups.find((group) => group.trackId === 'A').levelDb, -5),
  },
  'a timing nudge': {
    touch: (t) => { t.container.querySelector('button[aria-label="Group A later"]').click(); },
    check: (t) => assert.ok(t.desk.groups.find((group) => group.trackId === 'A').entryOffsetMs > 0),
  },
};

for (const view of ['idea', 'mine']) {
  for (const [name, spec] of Object.entries(TOUCHES)) {
    test(`keeping while hearing ${view === 'idea' ? 'the suggestion' : 'my mix'} keeps exactly that, plus ${name} the musician moved`, async () => {
      const t = await twoTrackDesk();
      handMix(t);
      t.ask.click();
      t.hear.click();
      if (view === 'mine') t.hear.click();
      const wasMuted = t.lane('A:bass').muted;
      spec.touch(t);
      t.approve.click();
      spec.check(t, wasMuted);
      // Untouched controls are what the musician was hearing.
      if (view === 'idea') {
        assert.equal(t.lane('A:vocals').muted, true);
        assert.equal(t.lane('B:drums').muted, true);
        if (name !== 'the crossfader') assert.equal(t.desk.crossfaderPosition, 50);
      } else {
        assert.equal(t.lane('A:vocals').muted, false);
        assert.equal(t.lane('B:drums').muted, false);
        assert.equal(t.lane('B:drums').gainDb, -4);
        if (name !== 'the crossfader') assert.equal(t.desk.crossfaderPosition, 30);
      }
      noPlay(t);
    });
  }
}

test('every flip, keep and undo glides through the desk, and stays plain on a stand-in without it', async () => {
  const t = await twoTrackDesk();
  let glides = 0;
  t.desk.glide = (change) => { glides += 1; return change(); };
  t.ask.click();
  t.hear.click(); // hear it
  t.hear.click(); // hear mine
  t.hear.click(); // hear it
  t.reject.click(); // return
  assert.equal(glides, 4);
  t.ask.click();
  t.hear.click();
  t.approve.click(); // keep it: already on the desk, no glide needed
  assert.equal(glides, 5);
  t.approve.click(); // undo
  assert.equal(glides, 6);
  t.ask.click();
  t.preview.click();
  t.approve.click(); // approve from Preview
  assert.equal(glides, 7);
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
    const [askButton, previewButton, , approveButton, rejectButton] = [
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

test('a group section uses one window for every stem, and full length is explicit', async () => {
  const { container, desk } = mount({ variants: DEMUCS_QUAD });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  await loadGroup(container, 'A');

  assert.equal(desk.lastUrls.length, 4);
  const windows = desk.lastUrls.map((url) => new URL(url, 'http://127.0.0.1'));
  const starts = windows.map((url) => url.searchParams.get('start'));
  const lengths = windows.map((url) => url.searchParams.get('duration'));
  assert.deepEqual(starts, ['0', '0', '0', '0']);
  assert.deepEqual(lengths, ['90', '90', '90', '90']);
  assert.equal(desk.lastOptions.limits.maxStemDecodedBytes, 40 * 1024 * 1024);
  assert.match(container.querySelector('.stem-desk__status').textContent, /Section 0–90 s/);
  assert.equal(desk.calls.filter(([name]) => name === 'loadGroups').length, 1);

  container.querySelector('select[aria-label="Section for group A"]').value = 'full';
  await loadGroup(container, 'A');
  assert.ok(desk.lastUrls.every((url) => !url.includes('duration=')));
  assert.equal(desk.lastOptions.limits.maxStemDecodedBytes, 128 * 1024 * 1024);
  assert.equal(desk.lastOptions.limits.maxTrackDecodedBytes, 512 * 1024 * 1024);
  assert.equal(desk.lastOptions.limits.maxDecodedBytes, 1024 * 1024 * 1024);
  assert.match(container.querySelector('.stem-desk__status').textContent, /Full length/);
});

test('a refused reload says the existing lanes are unchanged', async () => {
  const { container, desk } = mount({ variants: DEMUCS_QUAD });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  await loadGroup(container, 'A');
  assert.match(container.querySelector('.stem-desk__status').textContent, /Loaded 4 stems/);

  desk.failNextGroups = 'the section starts past the end of the recording';
  await loadGroup(container, 'A');
  const status = container.querySelector('.stem-desk__status').textContent;
  assert.match(status, /could not be reloaded; its existing 4 lanes are unchanged/);
  assert.match(status, /starts past the end/);
  assert.equal(container.querySelectorAll('.stem-desk__row').length, 4);
});

test('renaming a library track updates the desk heading without loading again', async () => {
  const items = [{ id: 'track-1', name: 'night-drive.wav' }];
  let listener = () => {};
  const store = {
    getState: () => ({ library: { items } }),
    subscribeSlice: (_slice, fn) => {
      listener = fn;
      return () => {};
    },
  };
  const { container, desk } = mount({ variants: DEMUCS_QUAD, store });
  await flush();
  selectFor(container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  await loadGroup(container, 'A');
  const loads = desk.calls.filter(([name]) => name === 'loadGroups').length;

  items[0] = { id: 'track-1', name: 'Café — 夜 <script>' };
  listener();

  const heading = container.querySelector('.stem-desk__group-title').textContent;
  assert.match(heading, /Café — 夜 <script>/);
  assert.equal(container.querySelectorAll('script').length, 0);
  assert.equal(selectFor(container, 'A').selectedOptions[0].textContent, 'Café — 夜 <script>');
  assert.equal(desk.calls.filter(([name]) => name === 'loadGroups').length, loads);
});

// ---- The Crate (record-crate) --------------------------------------------

const CRATE_ITEMS = [
  { track_id: 'track-1', name: 'night-drive.wav', duration: 180, bpm: 96.8, key: { tonic: 'F', mode: 'major' }, source: { kind: 'upload' }, stems: { status: 'quad', quad: true, method: 'demucs', roles: ['vocals', 'drums', 'bass', 'other'] }, actions: ['choose_A', 'choose_B'], separation: null },
  { track_id: 'track-2', name: 'slow-burn.wav', duration: 171, bpm: 84.3, key: null, source: { kind: 'upload' }, stems: { status: 'quad', quad: true, method: 'demucs', roles: ['vocals', 'drums', 'bass', 'other'] }, actions: ['choose_A', 'choose_B'], separation: null },
  { track_id: 'track-3', actions: ['separate'], name: 'raw-demo.wav', duration: 90, bpm: null, key: null, source: { kind: 'youtube' }, stems: { status: 'none', quad: false, method: null, roles: [] }, separation: null },
  { track_id: 'track-4', actions: ['choose_A', 'separate'], duplicates: {
    exact_content: ['duplicate'], same_source: ['source'], possible_versions: [{ track_id: 'live', name: 'Live Pad' }],
  }, name: 'wide-pad.wav', duration: 60, bpm: null, key: null, source: { kind: 'local' }, stems: { status: 'center_sides', quad: false, method: 'ffmpeg', roles: ['center', 'sides'] }, separation: null },
  { track_id: 'track-5', name: 'half-done.wav', duration: 60, bpm: null, key: null, source: { kind: 'upload' }, stems: { status: 'none', quad: false, method: null, roles: [] }, separation: { job_id: 'job-5', status: 'running', progress: 40, error: null } },
  { track_id: 'track-6', actions: ['separate'], name: 'broken.wav', duration: 60, bpm: null, key: null, source: { kind: 'upload' }, stems: { status: 'none', quad: false, method: null, roles: [] }, separation: { job_id: 'job-6', status: 'failed', progress: null, error: 'Demucs ran out of memory' } },
];

async function crateDesk(options = {}) {
  const { createCrateSource } = await import('../../src/twobecomeone/studio_static/js/record-crate.js');
  const searches = [];
  const stemReads = [];
  const crateSource = createCrateSource({
    fetchJson: async (url) => {
      // Opening a row reads that recording's stems (OPEN THE RECORD
      // SLEEVES); that is not a search.
      if (url.startsWith('/api/tracks/')) { stemReads.push(url); return { variants: [] }; }
      searches.push(url);
      return { items: CRATE_ITEMS, total: CRATE_ITEMS.length, limit: 20, offset: 0 };
    },
  });
  const ctx = mount({
    tracks: CRATE_ITEMS.map((entry) => ({ id: entry.track_id, name: entry.name })),
    variantsByTrack: {
      'track-1': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-aaa' })),
      'track-2': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-bbb' })),
    },
    crateSource,
    ...options,
  });
  document.body.appendChild(ctx.container);
  disposeAfter = ctx.dispose;
  const tab = (name) => ctx.container.querySelector(`[role="tab"][data-tab="${name}"]`);
  const row = (id) => ctx.container.querySelector(`.record-crate__row[data-track-id="${id}"]`);
  const open = (id) => {
    const toggle = row(id).querySelector('.record-crate__item');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    return row(id);
  };
  const crateButton = (id, cls) => open(id).querySelector(cls);
  return { ...ctx, searches, stemReads, tab, row, open, crateButton };
}

const badges = (row) => [...row.querySelectorAll('.record-crate__badge')].map((el) => el.textContent);

test('Crate: the Producer tab is the default, and the Crate fetches nothing until it is opened', async () => {
  const t = await crateDesk();
  await flush();
  assert.equal(t.tab('producer').getAttribute('aria-selected'), 'true');
  assert.equal(t.container.querySelector('.stem-desk__producer').hidden, false);
  assert.equal(t.container.querySelector('.desk-rail__crate').hidden, true);
  assert.equal(t.searches.length, 0, 'mounting the desk does not search');
  t.tab('crate').click();
  await flush();
  assert.equal(t.container.querySelector('.stem-desk__producer').hidden, true, 'the Producer stays in the DOM, hidden');
  assert.equal(t.searches.length, 1);
  t.tab('producer').click();
  t.tab('crate').click();
  await flush();
  assert.equal(t.searches.length, 1, 'switching tabs does not search again');
  // Arrow keys move between the two tabs and focus follows.
  t.tab('crate').focus();
  t.tab('crate').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(t.tab('producer').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, t.tab('producer'));
  assert.equal(t.tab('producer').tabIndex, 0);
  assert.equal(t.tab('crate').tabIndex, -1);
});

test('Crate: every stem state has its own badge; center/sides is never called stems', async () => {
  let updateJob;
  const t = await crateDesk({
    watchJobImpl(id, onUpdate) {
      if (id === 'job-5') updateJob = onUpdate;
      return () => {};
    },
  });
  t.tab('crate').click();
  await flush();
  assert.deepEqual(badges(t.row('track-1')), ['Stems ready · Demucs 4']);
  assert.deepEqual(badges(t.row('track-3')), ['No stems yet']);
  assert.deepEqual(badges(t.row('track-4')), ['Center/sides only']);
  assert.deepEqual(badges(t.row('track-5')), ['Separating']);
  assert.deepEqual(badges(t.row('track-6')), ['Separation failed']);
  assert.match(t.open('track-6').textContent, /Demucs ran out of memory/);
  assert.match(t.open('track-1').textContent, /Artist\s*Not in Library data/);
  assert.match(t.open('track-4').textContent, /not vocal or instrument stems/);
  assert.match(t.open('track-4').textContent, /Exact-content matches1Same source1Possible versionsLive Pad/);
  assert.equal(t.crateButton('track-4', '.record-crate__choose--a').disabled, false);
  assert.equal(t.crateButton('track-4', '.record-crate__choose--b').disabled, true);
  assert.equal(t.crateButton('track-4', '.record-crate__load--b').disabled, true);
  updateJob({ id: 'job-5', status: 'running', progress_detail: { percent: 40 } });
  assert.deepEqual(badges(t.row('track-5')), ['Separating 40%']);
});

test('Crate: Choose sets the bank selector without an AudioContext, a load or a stop', async () => {
  const t = await crateDesk();
  t.tab('crate').click();
  await flush();
  t.crateButton('track-2', '.record-crate__choose--b').click();
  await flush();
  assert.equal(selectFor(t.container, 'B').value, 'track-2');
  assert.equal(t.calls.some(([name]) => name === 'createDesk'), false, 'no desk or AudioContext was created');
  assert.equal(t.desk.calls.length, 0, 'nothing was loaded, played or stopped');
  assert.ok(badges(t.row('track-2')).includes('Selected for B'));
  // Focus moves to the next step, Load B for that track.
  assert.equal(document.activeElement, t.row('track-2').querySelector('.record-crate__load--b'));
});

test('Crate: Choose during playback does not stop the desk', async () => {
  const t = await crateDesk();
  selectFor(t.container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(t.container, 'A').value = 'track-1';
  await loadGroup(t.container, 'A');
  t.container.querySelector('.stem-desk__transport .button--primary').click();
  await flush();
  assert.equal(t.desk.status, 'playing');
  const before = t.desk.calls.length;
  t.tab('crate').click();
  await flush();
  const search = t.container.querySelector('.record-crate__search');
  search.value = 'slow';
  search.dispatchEvent(new window.Event('input'));
  t.crateButton('track-2', '.record-crate__choose--b').click();
  await flush();
  assert.equal(t.desk.status, 'playing', 'search and Choose leave playback running');
  assert.deepEqual(t.desk.calls.slice(before), [], 'no stop, load or gain call');
  assert.ok(badges(t.row('track-1')).includes('On A'));
});

test('Crate: Load presses the bank’s own Load and the row then reads On B', async () => {
  const t = await crateDesk();
  t.tab('crate').click();
  await flush();
  const load = t.crateButton('track-2', '.record-crate__load--b');
  assert.equal(load.disabled, true, 'Load waits for Choose');
  assert.match(t.row('track-2').textContent, /Choose it for B first/);
  t.crateButton('track-2', '.record-crate__choose--b').click();
  await flush();
  const ready = t.row('track-2').querySelector('.record-crate__load--b');
  assert.equal(ready.disabled, false);
  ready.focus();
  ready.click();
  await flush();
  await flush();
  assert.deepEqual(t.desk.calls.filter(([name]) => name === 'loadGroups'), [['loadGroups', 'B', ['vocals', 'drums', 'bass', 'other']]]);
  assert.match(t.container.querySelector('.stem-desk__status').textContent, /Loaded 4 stems into group B/);
  assert.ok(badges(t.row('track-2')).includes('On B'));
  assert.equal(document.activeElement, t.row('track-2').querySelector('.record-crate__load--b'), 'focus returns to the Load that was pressed');
});

test('Crate: a track with no stems offers Separate, not Load, and a running job is not submitted twice', async () => {
  const submitted = [];
  const t = await crateDesk({
    submitSeparationImpl: async (trackId, method) => {
      submitted.push([trackId, method]);
      return { id: 'job-new', status: 'queued' };
    },
    listJobsImpl: async () => ({ items: [{ id: 'job-5', kind: 'separate', status: 'running', request: { track_id: 'track-5' } }] }),
  });
  t.tab('crate').click();
  await flush();
  assert.equal(t.crateButton('track-3', '.record-crate__choose--a').disabled, true);
  assert.equal(selectFor(t.container, 'A').value, '');
  assert.equal(t.row('track-3').querySelector('.record-crate__load--a').disabled, true);
  assert.match(t.row('track-3').textContent, /No stems yet\. Separate stems first/);
  t.crateButton('track-3', '.record-crate__separate').click();
  await flush();
  assert.deepEqual(submitted, [['track-3', 'demucs']]);
  assert.deepEqual(badges(t.row('track-3')).slice(-1), ['Separation queued']);
  assert.equal(t.row('track-3').querySelector('.record-crate__separate').disabled, true);
  assert.equal(t.crateButton('track-5', '.record-crate__separate').disabled, true, 'already separating');
  assert.equal(t.calls.some(([name]) => name === 'createDesk'), false);
});

test('Crate: a Producer audition and its Undo stay put when the Crate tab is shown', async () => {
  const t = await twoTrackDesk();
  document.body.appendChild(t.container);
  disposeAfter = t.dispose;
  handMix(t);
  t.ask.click();
  t.hear.click();
  suggestionHeard(t);
  const crateTab = t.container.querySelector('[role="tab"][data-tab="crate"]');
  const producerTab = t.container.querySelector('[role="tab"][data-tab="producer"]');
  const strip = t.container.querySelector('.desk-rail__idea');
  crateTab.click();
  await flush();
  suggestionHeard(t);
  assert.equal(strip.hidden, false);
  assert.match(strip.textContent, /Hearing the Producer’s suggestion/);
  assert.equal(producerTab.dataset.pending, 'true');
  assert.match(producerTab.textContent, /idea pending/);
  strip.querySelector('button').click();
  assert.equal(producerTab.getAttribute('aria-selected'), 'true');
  assert.equal(t.hear.textContent, 'Hear mine', 'the audition is exactly where it was');
  t.approve.click();
  assert.equal(t.approve.textContent, 'Undo');
  crateTab.click();
  assert.match(strip.textContent, /Undo is in the Producer tab/);
  producerTab.click();
  t.approve.click();
  mineHeard(t);
  assert.equal(strip.hidden, true);
  noPlay(t);
});

test('Crate: Expand is a non-modal overlay that Escape closes, returning focus', async () => {
  const t = await crateDesk();
  t.tab('crate').click();
  await flush();
  const expand = t.container.querySelector('.record-crate__expand');
  const rail = t.container.querySelector('.desk-rail');
  expand.click();
  assert.equal(rail.classList.contains('desk-rail--expanded'), true);
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, t.container.querySelector('.record-crate__search'));
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(rail.classList.contains('desk-rail--expanded'), false);
  assert.equal(document.activeElement, expand);
  expand.click();
  t.tab('producer').click();
  assert.equal(rail.classList.contains('desk-rail--expanded'), false, 'showing the Producer closes the overlay');
});

test('Crate: the narrow-screen sheet holds the same Crate and returns focus to its button', async () => {
  const t = await crateDesk();
  const opener = t.container.querySelector('.stem-desk__crate-open');
  assert.equal(t.container.querySelector('dialog'), null, 'no dialog exists until the sheet opens');
  opener.focus();
  opener.click();
  await flush();
  const sheet = t.container.querySelector('dialog.record-crate-sheet');
  assert.equal(sheet.hasAttribute('open'), true);
  assert.ok(sheet.querySelector('.record-crate'), 'the Crate moved into the sheet');
  assert.equal(document.activeElement, sheet.querySelector('.record-crate__search'));
  assert.equal(t.searches.length, 1);
  sheet.querySelector('.record-crate-sheet__head button').click();
  assert.equal(sheet.hasAttribute('open'), false);
  assert.equal(sheet.isConnected, false, 'the closed sheet leaves the page');
  assert.ok(t.container.querySelector('.desk-rail__crate .record-crate'), 'the Crate is back in its tab');
  assert.equal(document.activeElement, opener);
});

// ---------------------------------------------------------------------------
// OPERATION NEVER LOSE THE MIX: the shell sidebar hosts the desk's one rail.

async function shellSidebar({ store = null, narrow = false } = {}) {
  const { mountWorkspaceSidebar } = await import('../../src/twobecomeone/studio_static/js/components/workspace-sidebar.js');
  window.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
  const aside = document.createElement('aside');
  const openButton = document.createElement('button');
  openButton.id = 'sidebar-open';
  openButton.hidden = true;
  document.body.append(openButton, aside);
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)) };
  const sidebar = mountWorkspaceSidebar({ aside, openButton, store, storage });
  return { sidebar, aside, openButton, memory };
}

test('Shell: the desk hands its one rail to the sidebar, and Hide/reopen keep the Crate as it was', async () => {
  const shell = await shellSidebar();
  const t = await crateDesk({ railHost: shell.sidebar });
  await flush();
  assert.equal(t.container.querySelector('.desk-rail'), null, 'nothing left in the desk column');
  assert.ok(t.container.querySelector('.console-body--solo'));
  assert.equal(document.querySelectorAll('.desk-rail').length, 1, 'one rail, one Producer, one Crate');
  const rail = shell.aside.querySelector('.desk-rail');
  assert.ok(rail);
  assert.equal(shell.aside.hidden, false);
  assert.equal(shell.openButton.hidden, false);
  const tab = (name) => shell.aside.querySelector(`[role="tab"][data-tab="${name}"]`);
  tab('crate').click();
  await flush();
  assert.equal(t.searches.length, 1);
  const search = shell.aside.querySelector('input[type="search"]');
  search.value = 'lant';
  const row = shell.aside.querySelector('.record-crate__row .record-crate__item');
  row.click();
  const hide = shell.aside.querySelector('.workspace-sidebar__hide');
  hide.click();
  assert.equal(shell.aside.dataset.collapsed, 'true');
  assert.equal(shell.aside.querySelector('.workspace-sidebar__body').hidden, true);
  const reopen = shell.aside.querySelector('.workspace-sidebar__reopen');
  assert.equal(reopen.hidden, false);
  assert.equal(document.activeElement, reopen, 'focus moves to the reopen tab');
  assert.equal(shell.memory.get('twobecomeone.sidebar.collapsed'), 'true');
  reopen.click();
  assert.equal(shell.aside.querySelector('.desk-rail'), rail, 'the same rail node');
  assert.equal(search.value, 'lant');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(tab('crate').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, tab('crate'));
  assert.equal(t.searches.length, 1, 'hiding and reopening does not search again');
  t.dispose();
  disposeAfter = null;
  assert.equal(document.querySelectorAll('.desk-rail').length, 0);
  assert.equal(shell.aside.hidden, true);
});

test('Shell: an idea heard in Studio is kept from Library; the sidebar says where the Producer acts', async () => {
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());
  const shell = await shellSidebar({ store });
  const ctx = mount({
    tracks: [{ id: 'track-1', name: 'night-drive.wav' }, { id: 'track-2', name: 'slow-burn.wav' }],
    variantsByTrack: {
      'track-1': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-aaa' })),
      'track-2': DEMUCS_QUAD.map((entry) => ({ ...entry, stem_set_id: 'set-bbb' })),
    },
    railHost: shell.sidebar,
    store,
  });
  document.body.appendChild(ctx.container);
  disposeAfter = ctx.dispose;
  await flush();
  selectFor(ctx.container, 'A').dispatchEvent(new window.Event('focus'));
  await flush();
  selectFor(ctx.container, 'A').value = 'track-1';
  selectFor(ctx.container, 'B').value = 'track-2';
  await loadGroup(ctx.container, 'A');
  await loadGroup(ctx.container, 'B');
  ctx.desk.setCrossfader(30);
  const [ask, , hear, keep] = [...shell.aside.querySelectorAll('.stem-desk__proposal button')];
  ask.click();
  hear.click();
  assert.equal(ctx.desk.crossfaderPosition, 50, 'the suggestion is heard');
  store.dispatch({ type: 'route/set', route: 'library' });
  const context = shell.aside.querySelector('.workspace-sidebar__context');
  assert.equal(context.hidden, false);
  assert.match(context.textContent, /act on the Performance desk/);
  shell.aside.querySelector('.workspace-sidebar__hide').click();
  await flush();
  const reopen = shell.aside.querySelector('.workspace-sidebar__reopen');
  assert.equal(reopen.dataset.pending, 'true', 'the collapsed tab shows a pending idea');
  assert.match(reopen.textContent, /idea pending/);
  reopen.click();
  assert.equal(keep.textContent, 'Keep it');
  keep.click();
  assert.equal(keep.textContent, 'Undo');
  store.dispatch({ type: 'route/set', route: 'studio' });
  assert.equal(context.hidden, true);
  keep.click();
  assert.equal(ctx.desk.crossfaderPosition, 30, 'Undo returns the mix from before the idea');
  assert.equal(ctx.desk.calls.some(([name]) => name === 'play'), false, 'nothing plays by itself');
  // On the Arrangement surface the page has its own Producer; the desk's steps aside.
  window.dispatchEvent(new window.CustomEvent('twobecomeone:studio-surface', { detail: { surface: 'arrangement' } }));
  const producer = shell.aside.querySelector('.stem-desk__producer');
  assert.equal(producer.dataset.away, 'true');
  assert.match(producer.querySelector('.stem-desk__producer-away').textContent, /Arrangement has its own Producer/);
  window.dispatchEvent(new window.CustomEvent('twobecomeone:studio-surface', { detail: { surface: 'performance' } }));
  assert.equal(producer.dataset.away, 'false');
  assert.equal(producer.querySelector('.stem-desk__producer-away').hidden, true);
});

test('Shell: the sheet takes the same rail and gives it back, with focus returned', async () => {
  const shell = await shellSidebar();
  const t = await crateDesk({ railHost: shell.sidebar });
  await flush();
  const rail = shell.aside.querySelector('.desk-rail');
  shell.openButton.hidden = false;
  shell.openButton.focus();
  shell.openButton.click();
  const sheet = document.querySelector('dialog.workspace-sheet');
  assert.ok(sheet);
  assert.equal(sheet.querySelector('.desk-rail'), rail, 'the same rail moved into the sheet');
  assert.equal(shell.aside.querySelector('.desk-rail'), null);
  [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Done').click();
  assert.equal(document.querySelector('dialog.workspace-sheet'), null, 'the sheet exists only while open');
  assert.equal(shell.aside.querySelector('.desk-rail'), rail);
  assert.equal(document.activeElement, shell.openButton);
  // The desk heading's Crate button opens the same sheet on the Crate tab.
  t.container.querySelector('.stem-desk__crate-open').click();
  await flush();
  const again = document.querySelector('dialog.workspace-sheet');
  assert.equal(again.querySelector('.desk-rail').dataset.tab, 'crate');
  assert.equal(document.activeElement, again.querySelector('input[type="search"]'));
  assert.equal(t.searches.length, 1);
  shell.sidebar.closeSheet();
  assert.equal(document.activeElement, t.container.querySelector('.stem-desk__crate-open'));
});

test('Shell: narrow screens keep the rail under the desk while the desk is on screen', async () => {
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());
  const shell = await shellSidebar({ store, narrow: true });
  const t = await crateDesk({ railHost: shell.sidebar, store });
  await flush();
  const rail = document.querySelector('.desk-rail');
  assert.equal(rail.parentElement, t.container.querySelector('.desk-rail-slot'));
  store.dispatch({ type: 'route/set', route: 'engine' });
  assert.equal(rail.parentElement, shell.aside.querySelector('.workspace-sidebar__body'));
  store.dispatch({ type: 'route/set', route: 'studio' });
  assert.equal(rail.parentElement, t.container.querySelector('.desk-rail-slot'));
  window.dispatchEvent(new window.CustomEvent('twobecomeone:studio-surface', { detail: { surface: 'arrangement' } }));
  assert.equal(rail.parentElement, shell.aside.querySelector('.workspace-sidebar__body'));
  window.dispatchEvent(new window.CustomEvent('twobecomeone:studio-surface', { detail: { surface: 'performance' } }));
  assert.equal(rail.parentElement, t.container.querySelector('.desk-rail-slot'));
});
