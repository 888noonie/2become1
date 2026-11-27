// tests/frontend/record-sleeves.test.js — OPERATION OPEN THE RECORD SLEEVES.
// A recording's separated stems open in the Library and the Crate, a stem is
// renamed or given its role back with PATCH /api/stem-sets/{id}/names, search
// matches sit beneath their recording, and one stem is placed in an
// Arrangement where the musician says, through the edit engine, with its
// (stem_set_id, role) and original recording kept and its label looked up live.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import {
  cleanStemName, createStemList, normalizeStem, offerStem, publishStemCard, renameStem,
  resetStemSleeveForTests, stemMatch, stemOffer, stemsFromVariants, clearStemOffer,
} from '../../src/twobecomeone/studio_static/js/stem-sleeve.js';
import { normalizeCrateItem, createCrateSource } from '../../src/twobecomeone/studio_static/js/record-crate.js';
import { mountRecordCrate } from '../../src/twobecomeone/studio_static/js/components/record-crate-panel.js';
import { mountArrangementPanel } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';
import { EditEngine } from '../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';

let dom;
const panels = [];
test.beforeEach(() => { dom = setupDom(); resetStemSleeveForTests(); });
test.afterEach(() => { while (panels.length) panels.pop().dispose(); teardownDom(dom); });

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const byText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const url = (set, role) => `/api/stems/${set}/audio?name=${role}`;

const SET = 'set-lanterns';
const variants = (names = {}) => ({
  track_id: 't-lan',
  stems: ['bass', 'drums', 'full', 'other', 'vocals'],
  variants: [
    { name: 'full', display_name: 'full', custom_name: false, stem_set_id: null, audio_url: '/api/tracks/t-lan/audio' },
    ...['vocals', 'drums', 'bass', 'other'].map((role) => ({
      name: role, display_name: names[role] ?? role, custom_name: Boolean(names[role]),
      stem_set_id: SET, method: 'demucs', model_name: 'htdemucs', device: 'cpu', audio_url: url(SET, role),
    })),
  ],
});
const card = (names = {}) => ({
  stem_set_id: SET, track_id: 't-lan', track_name: 'Paper Lanterns', bpm: 95, bpm_source: 'measured',
  method: 'demucs', model_name: 'htdemucs', status: 'complete',
  stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({
    name: role, display_name: names[role] ?? role, custom_name: Boolean(names[role]), audio_url: url(SET, role),
  })),
});

/** A fake backend: PATCH names only touches the label, like the real route. */
function backend() {
  const names = {};
  const calls = [];
  return {
    names, calls,
    patchJson: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      assert.equal(path, `/api/stem-sets/${SET}/names`);
      for (const [role, value] of Object.entries(body.names)) {
        if (value === null) delete names[role]; else names[role] = value;
      }
      return card(names);
    },
    listStems: async () => variants(names),
    getJson: async (p) => (p === `/api/stem-sets/${SET}` ? card(names) : null),
  };
}

// ------------------------------------------------------------ the data shape

test('a stem is (stem_set_id, role); a label never becomes a path, and a foreign URL is not playable', () => {
  const ok = normalizeStem({ name: 'vocals', stem_set_id: SET, display_name: 'Lead Vox', custom_name: true, audio_url: url(SET, 'vocals') },
    { trackId: 't-lan', trackName: 'Paper Lanterns', available: true });
  assert.equal(ok.key, `${SET}:vocals`);
  assert.equal(ok.displayName, 'Lead Vox');
  assert.equal(ok.audioUrl, url(SET, 'vocals'), 'the URL names the role, not the label');
  assert.equal(ok.available, true);
  const foreign = normalizeStem({ name: 'vocals', stem_set_id: SET, audio_url: 'https://elsewhere.example/v.wav' }, { available: true });
  assert.equal(foreign.available, false, 'a URL that is not the stem route is not offered as playable');
  assert.equal(foreign.audioUrl, null);
  assert.equal(normalizeStem({ name: 'Lead Vox', stem_set_id: SET, audio_url: url(SET, 'Lead Vox') }), null, 'a label is not a role');
  assert.equal(normalizeStem({ name: 'vocals', stem_set_id: '../etc', audio_url: url('../etc', 'vocals') }), null);
  const missing = normalizeStem({ role: 'drums', stem_set_id: SET, audio_url: url(SET, 'drums'), available: false });
  assert.equal(missing.available, false, 'missing media is never playable');
  assert.equal(offerStem(missing), false, 'and cannot be offered to an Arrangement');
});

test('the stem route lists stems without the full mix; search matches stay under their own recording, once each', () => {
  const stems = stemsFromVariants(variants({ vocals: 'Lead Vox' }), { trackId: 't-lan', trackName: 'Paper Lanterns' });
  assert.deepEqual(stems.map((s) => s.role), ['vocals', 'drums', 'bass', 'other']);
  assert.equal(stems[0].displayName, 'Lead Vox');
  assert.equal(stems[1].displayName, 'drums', 'no custom name shows the role');
  const raw = (set, role, label) => ({
    stem_set_id: set, role, display_name: label, custom_name: true, available: true, method: 'demucs',
    audio_url: url(set, role), matched: ['label'], track_id: 't-lan', track_name: 'Paper Lanterns',
  });
  const match = stemMatch({
    track: false,
    stems: [raw('set-a', 'vocals', 'Lead'), raw('set-b', 'vocals', 'Lead'), raw('set-a', 'vocals', 'Lead'),
      { ...raw('set-c', 'bass', 'Lead'), track_id: 't-other' }],
  }, { trackId: 't-lan', trackName: 'Paper Lanterns' });
  assert.equal(match.trackMatched, false);
  assert.deepEqual(match.stems.map((s) => s.key), ['set-a:vocals', 'set-b:vocals'], 'two stems named Lead stay two, by set; a duplicate and another recording\'s stem are dropped');
  assert.equal(stemMatch(undefined, {}), null, 'no match key means no stem rows');
});

test('names follow the backend rules: blank and over-long are refused, whitespace collapses', () => {
  assert.equal(cleanStemName('   ').ok, false);
  assert.equal(cleanStemName('x'.repeat(201)).ok, false);
  assert.deepEqual(cleanStemName('  Lead   Vox \n'), { ok: true, value: 'Lead Vox' });
});

test('NEGATIVE: renaming sends only the label; the role, set, audio URL and file identity stay exactly the same', async () => {
  const api = backend();
  const before = stemsFromVariants(await api.listStems(), { trackId: 't-lan', trackName: 'Paper Lanterns' })[0];
  await renameStem(api.patchJson, before, 'Lead Vox');
  assert.deepEqual(api.calls[0].body, { names: { vocals: 'Lead Vox' } }, 'the body names the role and the label, nothing else');
  const after = stemsFromVariants(await api.listStems(), { trackId: 't-lan', trackName: 'Paper Lanterns' })[0];
  assert.equal(after.displayName, 'Lead Vox');
  for (const k of ['key', 'stemSetId', 'role', 'audioUrl', 'trackId', 'method']) assert.equal(after[k], before[k], k);
  assert.ok(!after.audioUrl.includes('Lead'), 'the label never enters the audio URL');
});

// ------------------------------------------------------------ the list widget

test('a stem list renames in place, keeps focus on that stem, and Original name restores the role', async () => {
  const api = backend();
  const list = createStemList({ label: 'stems', api, onUse: () => {} });
  document.getElementById('main').append(list.el);
  list.setStems(stemsFromVariants(await api.listStems(), { trackId: 't-lan', trackName: 'Paper Lanterns' }));
  const row = () => list.el.querySelector(`[data-stem-key="${SET}:vocals"]`);
  click(byText(row(), 'Rename'));
  const input = row().querySelector('input');
  assert.equal(document.activeElement, input, 'the name field takes focus');
  input.value = 'Lead Vox';
  row().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(row().querySelector('.stem-sleeve__label').textContent, 'Lead Vox');
  assert.match(row().textContent, /Role: Vocals/, 'the original role is still shown');
  assert.match(row().textContent, /Paper Lanterns/, 'and the recording it came from');
  assert.equal(document.activeElement, byText(row(), 'Rename'), 'focus stays on this stem');
  assert.equal(list.el.querySelectorAll('.stem-sleeve__row').length, 4, 'no row collapsed or vanished');
  click(byText(row(), 'Original name'));
  await flush();
  assert.equal(row().querySelector('.stem-sleeve__label').textContent, 'vocals');
  assert.deepEqual(api.calls.at(-1).body, { names: { vocals: null } });
  assert.equal(document.activeElement, byText(row(), 'Rename'));
  list.dispose();
});

test('a blank name is refused before any request; a server refusal changes nothing', async () => {
  const api = backend();
  const list = createStemList({ label: 'stems', api: { patchJson: async () => { throw new Error('stem media is unavailable or corrupt: vocals'); } }, onUse: () => {} });
  document.getElementById('main').append(list.el);
  list.setStems(stemsFromVariants(await api.listStems(), { trackId: 't-lan', trackName: 'Paper Lanterns' }));
  const row = () => list.el.querySelector(`[data-stem-key="${SET}:vocals"]`);
  click(byText(row(), 'Rename'));
  row().querySelector('input').value = '   ';
  row().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.match(list.el.querySelector('[role="status"]').textContent, /Enter a name/);
  row().querySelector('input').value = 'Lead';
  row().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.match(list.el.querySelector('[role="status"]').textContent, /Could not rename: stem media is unavailable.*Nothing changed/);
  assert.equal(row().querySelector('.stem-sleeve__label').textContent, 'vocals');
  list.dispose();
});

// ------------------------------------------------------------ Library

async function library({ items, api = backend() }) {
  const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
  const store = registerReducers(new StateStore());
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items, total: items.length, limit: 50, offset: 0 }) });
  const { mountLibrary } = await import('../../src/twobecomeone/studio_static/js/views/library.js');
  const container = document.getElementById('main');
  const hashes = [];
  const stemReads = [];
  const stemApi = { ...api, listStems: async (id) => { stemReads.push(id); return api.listStems(id); } };
  const dispose = mountLibrary({ store, container, stemApi, navigate: (h) => hashes.push(h) });
  await flush();
  return { store, container, dispose, hashes, stemReads, api };
}

test('Library: Stems opens a recording\'s stems from the stem route; a rename keeps the list open and focused through a re-render', async () => {
  const t = await library({ items: [{ id: 't-lan', name: 'Paper Lanterns', duration: 200, source: { kind: 'upload' } },
    { id: 't-mid', name: 'Midnight Circuit', duration: 180, source: { kind: 'upload' } }] });
  const card = () => t.container.querySelector('[data-track-id="t-lan"]');
  const toggle = byText(card(), 'Stems');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  click(toggle);
  await flush();
  assert.deepEqual(t.stemReads, ['t-lan']);
  const rows = card().querySelectorAll('.stem-sleeve__row');
  assert.equal(rows.length, 4, 'four stems, no full mix');
  assert.match(card().textContent, /Demucs · set set-lant · stem audio available/);
  const vocals = () => card().querySelector(`[data-stem-key="${SET}:vocals"]`);
  click(byText(vocals(), 'Rename'));
  vocals().querySelector('input').value = 'Lead Vox';
  vocals().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  // Something else re-renders the Library (playback, a project change).
  t.store.dispatch({ type: 'playback/set', trackId: 't-mid', playing: true });
  await flush();
  assert.equal(vocals().querySelector('.stem-sleeve__label').textContent, 'Lead Vox');
  assert.equal(byText(card(), 'Hide stems').getAttribute('aria-expanded'), 'true', 'still open');
  assert.equal(document.activeElement, byText(vocals(), 'Rename'), 'focus survived the re-render');
  assert.equal(t.store.getState().playback.trackId, 't-mid', 'playback was not touched by the rename');
  assert.equal(t.container.querySelector('[data-track-id="t-mid"] .stem-sleeve'), null, 'the other recording stayed closed');
  t.dispose();
});

test('Library: matching stems sit beneath their recording; the result count is still one recording', async () => {
  const match = {
    track: false,
    stems: ['set-a', 'set-b'].map((set) => ({
      stem_set_id: set, role: 'vocals', display_name: 'Lead Vox', custom_name: true, available: true,
      method: set === 'set-a' ? 'demucs' : 'imported', audio_url: url(set, 'vocals'), matched: ['label'],
      track_id: 't-lan', track_name: 'Paper Lanterns',
    })),
  };
  const t = await library({ items: [{ id: 't-lan', name: 'Paper Lanterns', duration: 200, source: { kind: 'upload' }, match }] });
  assert.equal(t.container.querySelectorAll('.track-card').length, 1, 'one recording result');
  assert.equal(t.store.getState().library.total, 1);
  const rows = t.container.querySelectorAll('.track-card__stems--match .stem-sleeve__row');
  assert.equal(rows.length, 2, 'both same-named stems are listed');
  assert.match(rows[0].textContent, /set set-a/);
  assert.match(rows[1].textContent, /set set-b/);
  assert.match(rows[1].textContent, /Imported by you/);
  assert.match(t.container.textContent, /found by stem; the recording name does not match/);
  assert.match(rows[0].textContent, /Matched by its name/);
  click(byText(rows[0], 'Use in Arrangement'));
  assert.deepEqual(t.hashes, ['#/studio/arrangement']);
  assert.equal(stemOffer().stemSetId, 'set-a');
  assert.equal(stemOffer().role, 'vocals');
  assert.equal(stemOffer().trackId, 't-lan');
  t.dispose();
});

test('Library: when a search ends under a focused match row, focus moves to the same stem in the card\'s own list', async () => {
  const match = { track: false, stems: [{ stem_set_id: SET, role: 'vocals', display_name: 'vocals', custom_name: false, available: true, method: 'demucs', audio_url: url(SET, 'vocals'), matched: ['role'], track_id: 't-lan', track_name: 'Paper Lanterns' }] };
  const plain = { id: 't-lan', name: 'Paper Lanterns', duration: 200, source: { kind: 'upload' } };
  const t = await library({ items: [{ ...plain, match }] });
  const card = () => t.container.querySelector('[data-track-id="t-lan"]');
  click(byText(card(), 'Stems'));
  await flush();
  const matchRename = card().querySelector(`.track-card__stems--match [data-stem-key="${SET}:vocals"] button[data-stem-action="rename"]`);
  matchRename.focus();
  // The search is cleared: the same recording comes back without match rows.
  t.store.dispatch({ type: 'library/set', items: [plain], total: 1, limit: 50, offset: 0 });
  await flush();
  assert.equal(card().querySelector('.track-card__stems--match'), null);
  const own = card().querySelector(`.track-card__stems:not(.track-card__stems--match) [data-stem-key="${SET}:vocals"] button[data-stem-action="rename"]`);
  assert.equal(document.activeElement, own, 'focus is on the same stem, not lost to the page');
  t.dispose();
});

test('Library: with a search active, a rename searches again at once; the stem that stopped matching leaves, the rest keep their place', async () => {
  const api = backend();
  const matchFor = (label) => ({ track: false, stems: [{ stem_set_id: SET, role: 'vocals', display_name: label, custom_name: true, available: true, method: 'demucs', audio_url: url(SET, 'vocals'), matched: ['label'], track_id: 't-lan', track_name: 'Paper Lanterns' }] });
  let items = [{ id: 't-lan', name: 'Paper Lanterns', duration: 200, source: { kind: 'upload' }, match: matchFor('Lead Vox') },
    { id: 't-mid', name: 'Midnight Circuit', duration: 180, source: { kind: 'upload' } }];
  const t = await library({ items, api });
  let searches = 0;
  globalThis.fetch = async () => { searches += 1; return { ok: true, json: async () => ({ items, total: items.length, limit: 50, offset: 0 }) }; };
  const input = t.container.querySelector('input[type="search"]');
  input.value = 'lead vox';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400)); await flush();
  assert.equal(searches, 1, 'the typed search ran once');
  const card = () => t.container.querySelector('[data-track-id="t-lan"]');
  click(byText(card(), 'Stems'));
  await flush();
  const vocals = () => card().querySelector(`.track-card__stems:not(.track-card__stems--match) [data-stem-key="${SET}:vocals"]`);
  click(byText(vocals(), 'Rename'));
  vocals().querySelector('input').value = 'Guide';
  // The backend now answers the same query without that stem.
  items = [{ id: 't-lan', name: 'Paper Lanterns', duration: 200, source: { kind: 'upload' } }];
  vocals().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(); await flush();
  assert.equal(searches, 2, 'one more search ran immediately after the rename');
  assert.equal(card().querySelector('.track-card__stems--match'), null, 'the old-name match is gone');
  assert.equal(vocals().querySelector('.stem-sleeve__label').textContent, 'Guide', 'the open list shows the new name');
  assert.equal(byText(card(), 'Hide stems').getAttribute('aria-expanded'), 'true', 'still open');
  assert.equal(document.activeElement, byText(vocals(), 'Rename'), 'focus stayed on the renamed stem');
  assert.equal(t.store.getState().library.loading, false, 'no loading flash');
  t.dispose();
});

// ------------------------------------------------------------ Crate

test('Crate: matching stems appear under the one row; an expanded row with no query reads the stem route', async () => {
  const api = backend();
  const fetched = [];
  const raw = (match) => ({
    track_id: 't-lan', name: 'Paper Lanterns', duration: 200, stems: { status: 'quad', quad: true, roles: ['vocals', 'drums', 'bass', 'other'], method: 'demucs' },
    actions: [], ...(match ? { match } : {}),
  });
  let page = { items: [raw(null)], total: 1, limit: 20, offset: 0 };
  const source = createCrateSource({
    fetchJson: async (u) => {
      fetched.push(u);
      if (u.startsWith('/api/tracks/')) return api.listStems();
      return page;
    },
    patchJson: api.patchJson,
  });
  const bridge = { session: () => ({ banks: {}, loading: null }), subscribe: () => () => {} };
  const crate = mountRecordCrate({ container: document.getElementById('main'), source, bridge, searchDelayMs: 0 });
  crate.activate();
  await flush(); await flush();
  assert.equal(crate.root.querySelector('.record-crate__stem-match'), null, 'no query, no match rows');
  click(crate.root.querySelector('.record-crate__item'));
  await flush(); await flush();
  assert.ok(fetched.includes('/api/tracks/t-lan/stems'), 'the expanded row used the stem route');
  assert.equal(crate.root.querySelectorAll('.record-crate__stems .stem-sleeve__row').length, 4);
  // Rename from the Crate; the label changes and the row stays open.
  const vocals = () => crate.root.querySelector(`.record-crate__stems [data-stem-key="${SET}:vocals"]`);
  click(byText(vocals(), 'Rename'));
  vocals().querySelector('input').value = 'Lead Vox';
  vocals().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(vocals().querySelector('.stem-sleeve__label').textContent, 'Lead Vox');
  assert.equal(crate.root.querySelector('.record-crate__item').getAttribute('aria-expanded'), 'true');
  // Now search for the label: the backend answers with match.stems.
  page = {
    items: [raw({ track: false, stems: [{ stem_set_id: SET, role: 'vocals', display_name: 'Lead Vox', custom_name: true, available: true, method: 'demucs', audio_url: url(SET, 'vocals'), matched: ['label'], track_id: 't-lan', track_name: 'Paper Lanterns' }] })],
    total: 1, limit: 20, offset: 0,
  };
  crate.searchInput.value = 'lead vox';
  crate.searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 5)); await flush();
  assert.equal(crate.root.querySelectorAll('.record-crate__row').length, 1, 'one recording row');
  const m = crate.root.querySelector('.record-crate__stem-match');
  assert.ok(m);
  assert.match(m.textContent, /Lead Vox/);
  assert.match(m.textContent, /Role: Vocals/);
  assert.match(m.textContent, /“Paper Lanterns”/);
  assert.match(m.textContent, /found by stem, not by the recording name/);
  // Rename again while that search is showing: the Crate searches again at once.
  const before = fetched.filter((u) => u.startsWith('/api/crate')).length;
  page = { items: [raw(null)], total: 1, limit: 20, offset: 0 };
  const matched = () => crate.root.querySelector('.record-crate__stems [data-stem-key="' + SET + ':vocals"]');
  click(byText(matched() || vocals(), 'Rename'));
  (matched() || vocals()).querySelector('input').value = 'Guide';
  (matched() || vocals()).querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 5)); await flush(); await flush();
  assert.equal(fetched.filter((u) => u.startsWith('/api/crate')).length, before + 1, 'a rename ran one more search');
  assert.equal(crate.root.querySelector('.record-crate__stem-match'), null, 'the old-name match is gone');
  crate.dispose();
  clearStemOffer();
});

test('the Crate normalizer keeps match.stems and drops malformed or foreign entries', () => {
  const item = normalizeCrateItem({
    track_id: 't-lan', name: 'Paper Lanterns', stems: {},
    match: { track: true, stems: [
      { stem_set_id: SET, role: 'drums', display_name: 'drums', custom_name: false, available: true, audio_url: url(SET, 'drums'), matched: ['track'], track_id: 't-lan', track_name: 'Paper Lanterns' },
      { stem_set_id: SET, role: 'drums', audio_url: '/etc/passwd', available: true, track_id: 't-lan' },
      { stem_set_id: SET, role: 'kazoo', audio_url: url(SET, 'kazoo'), available: true },
    ] },
  });
  assert.equal(item.match.trackMatched, true);
  assert.equal(item.match.stems.length, 1, 'one valid stem; the duplicate key and the unknown role are dropped');
  assert.equal(item.match.stems[0].available, true);
  assert.equal(normalizeCrateItem({ track_id: 't', name: 'x', stems: {} }).match, null);
});

// ------------------------------------------------------------ Arrangement

const SR = 48000;
async function arrangement() {
  const fetched = [];
  const api = backend();
  const s = new DawSession({
    fetchImpl: async (u) => { fetched.push(u); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; },
    decodeAudio: async () => {
      const length = 8 * SR;
      const ch = [new Float32Array(length).fill(0.2), new Float32Array(length).fill(0.2)];
      return { sampleRate: SR, numberOfChannels: 2, length, getChannelData: (c) => ch[c] };
    },
    createContext: () => { throw new Error('no AudioContext: placing must not play'); },
    RealtimeEngine: class {},
    renderOffline: async () => { throw new Error('not used'); },
    StretchFactory: () => null,
    modules: {},
  });
  const panel = mountArrangementPanel({
    container: document.getElementById('main'), session: s,
    listTracks: async () => ({ items: [] }), listStems: async () => ({ variants: [] }),
    fetchJson: api.getJson,
  });
  panels.push(panel);
  return { s, panel, fetched, api };
}

const offerVocals = (names = {}) => {
  const stem = stemsFromVariants(variants(names), { trackId: 't-lan', trackName: 'Paper Lanterns' })[0];
  assert.ok(offerStem(stem));
  return stem;
};

test('Arrangement: a Library stem waits for the musician to choose a lane and a bar; nothing decodes or plays before Place', async () => {
  const { s, panel, fetched } = await arrangement();
  const place = panel.elements.place;
  assert.equal(place.box.hidden, true, 'no offer, no box');
  offerVocals();
  assert.equal(place.box.hidden, false);
  assert.equal(place.box.open, true);
  assert.match(place.box.textContent, /vocals · Vocals stem/);
  assert.match(place.box.textContent, /From the recording “Paper Lanterns” · Demucs · set set-lant/);
  assert.equal(place.lane.value, '', 'no lane is chosen for the musician');
  assert.equal(place.bar.value, '', 'nor a bar');
  assert.deepEqual(fetched, []);
  await panel.placeOffered();
  assert.equal(s.state.clips.length, 0);
  assert.match(s.messages.at(-1).code, /PLACE_LANE_REQUIRED/);
  place.lane.value = '5';
  await panel.placeOffered();
  assert.match(s.messages.at(-1).code, /PLACE_POSITION_REQUIRED/);
  assert.deepEqual(fetched, [], 'nothing fetched before both are chosen');
  assert.notEqual(s.phase(), 'playing');
  assert.equal(s.engine ?? null, null, 'no audio engine exists');
});

test('Arrangement: Place adds ONE clip at the chosen lane and bar, keeps (set, role) and the recording, and Undo takes it away with the source untouched', async () => {
  const { s, panel, fetched } = await arrangement();
  offerVocals();
  const place = panel.elements.place;
  place.lane.value = '5';
  place.bar.value = '9';
  place.length.value = '30';
  place.start.value = '12';
  const revision = s.edit.revision;
  await panel.placeOffered();
  assert.deepEqual(fetched, [`${url(SET, 'vocals')}&start=12&duration=30`], 'the backend stem route, cut to the section');
  assert.equal(s.edit.revision, revision + 1, 'one undoable step');
  const [clip] = s.state.clips;
  assert.equal(clip.trackIndex, 5);
  assert.equal(clip.timelineStartBeat, 32, 'bar 9 in 4/4');
  assert.equal(clip.sourceOffsetSec, 0);
  assert.equal(clip.stretchMode, 'manual', 'at its own speed until Fit to project tempo');
  const asset = s.state.assets[clip.assetId];
  assert.equal(asset.bufferReference, `${url(SET, 'vocals')}&start=12&duration=30`);
  assert.equal(asset.name, 'Paper Lanterns — Vocals', 'a stable name from recording and role');
  assert.equal(asset.nativeBpm, 95);
  assert.deepEqual({ ...asset.source }, {
    trackId: 't-lan', title: 'Paper Lanterns', role: 'vocals', method: 'demucs', modelName: 'htdemucs',
    stemSetId: SET, section: { startSec: 12, seconds: 30 }, origin: 'library-stem',
  });
  assert.equal(stemOffer(), null, 'the offer is used');
  assert.equal(place.box.hidden, true);
  assert.equal(panel.ui.selectedClipId, clip.id);
  assert.notEqual(s.phase(), 'playing', 'placing did not start playback');
  assert.equal(s.engine ?? null, null, 'no audio engine was made');
  assert.ok(s.undo());
  assert.equal(s.state.clips.length, 0);
  assert.ok(s.buffers[asset.bufferReference], 'the decoded source is still held for Redo');
  assert.ok(s.redo());
  assert.equal(s.state.clips[0].id, clip.id);
});

test('Arrangement: Place never overwrites; an occupied span is refused and nothing moves', async () => {
  const { s, panel } = await arrangement();
  offerVocals();
  const place = panel.elements.place;
  place.lane.value = '2'; place.bar.value = '1'; place.length.value = '30';
  await panel.placeOffered();
  const first = structuredClone(s.state.clips);
  offerVocals();
  place.lane.value = '2'; place.bar.value = '3';
  await panel.placeOffered();
  assert.equal(s.messages.at(-1).code, 'PLACE_OCCUPIED');
  assert.match(s.messages.at(-1).message, /already has a clip in that span \(bar 1\). Nothing was moved or replaced/);
  assert.deepEqual(s.state.clips, first, 'the clip already there is exactly as it was');
  assert.ok(stemOffer(), 'the offer waits for a free place');
  place.lane.value = '3';
  await panel.placeOffered();
  assert.equal(s.state.clips.length, 2);
  assert.equal(new Set(Object.keys(s.state.assets)).size, 1, 'the same stem section reuses its asset');
});

test('Arrangement: the placed clip can be cut, copied, pasted and split like any clip', async () => {
  const { s, panel } = await arrangement();
  offerVocals();
  const place = panel.elements.place;
  place.lane.value = '0'; place.bar.value = '1'; place.length.value = '30';
  await panel.placeOffered();
  const [clip] = s.state.clips;
  panel.select(clip.id);
  panel.copySelection();
  await panel.pasteAt(32, 1);
  panel.select(clip.id);
  s.seek(4);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 0).length, 2, 'split at the playhead');
  assert.equal(s.state.clips.filter((c) => c.trackIndex === 1).length, 1, 'pasted on lane 2');
  for (const c of s.state.clips) assert.equal(s.state.assets[c.assetId].source.stemSetId, SET, 'every piece keeps its stem identity');
});

test('Arrangement: a rename shows live on the clip, but the saved project keeps no label and the same reference', async () => {
  const { s, panel } = await arrangement();
  offerVocals();
  const place = panel.elements.place;
  place.lane.value = '0'; place.bar.value = '1'; place.length.value = '30';
  await panel.placeOffered();
  await flush();
  const before = s.edit.serialize ? s.edit.serialize() : JSON.stringify(s.state);
  publishStemCard(card({ vocals: 'Lead Vox' }));
  const label = document.querySelector('.daw__clip .daw__clip-label').textContent;
  assert.match(label, /Lead Vox/, 'the lane shows the owner\'s name');
  panel.select(s.state.clips[0].id);
  assert.match(panel.elements.inspector.querySelector('[data-field="stem-identity"]').textContent, /Stem: Lead Vox · Vocals of “Paper Lanterns”/);
  const after = s.edit.serialize ? s.edit.serialize() : JSON.stringify(s.state);
  assert.equal(after, before, 'the rename did not edit the project');
  assert.ok(!after.includes('Lead Vox'), 'no label in the project JSON');
  const reopened = new EditEngine({ project: JSON.parse(JSON.stringify(s.state)) });
  assert.equal(Object.values(reopened.state.assets)[0].bufferReference, `${url(SET, 'vocals')}&start=0&duration=30`);
});
