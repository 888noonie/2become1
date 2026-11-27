// tests/frontend/cutting-room-panel.test.js — OPERATION THE CUTTING ROOM.
// Cut / Copy / Paste / Delete / Split from the keyboard, the inspector and the
// right-click menu, over jsdom: every action is one EditEngine step through
// DawSession, the source asset is never removed, and Undo/Redo walk it back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import { mountArrangementPanel } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

const SR = 48000;
const decodeAudio = async () => {
  const length = 10 * SR;
  const ch = [new Float32Array(length).fill(0.25), new Float32Array(length).fill(0.25)];
  return { sampleRate: SR, numberOfChannels: 2, length, getChannelData: (c) => ch[c] };
};

async function mounted() {
  const fetched = [];
  const s = new DawSession({
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; },
    decodeAudio,
    createContext: () => { throw new Error('no audio in this test'); },
    RealtimeEngine: class {},
    renderOffline: async () => { throw new Error('not used'); },
    StretchFactory: () => null,
    modules: {},
  });
  const container = document.getElementById('main');
  const api = mountArrangementPanel({
    container, session: s,
    listTracks: async () => ({ items: [] }),
    listStems: async () => ({ variants: [] }),
  });
  await s.importGroup('A', {
    trackId: 't1', title: 'Midnight Circuit', bpm: 120, section: { startSec: 0, seconds: 10 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/a/audio?name=${role}&start=0&duration=10` })),
  });
  api.render();
  return { api, s, container, fetched };
}

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const key = (k, extra = {}, target = document) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
const ctrl = (k) => key(k, { ctrlKey: true });
const lane = (s, i) => s.state.clips.filter((c) => c.trackIndex === i).sort((a, b) => a.timelineStartBeat - b.timelineStartBeat);
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

test('Ctrl+X cuts the selected clip, Ctrl+V pastes it at the playhead on the selected lane, and Undo walks both back', async () => {
  const { api, s, container } = await mounted();
  const vocals = lane(s, 0)[0];
  const original = structuredClone(vocals);
  const assets = structuredClone(s.state.assets);
  api.select(vocals.id);
  ctrl('x');
  assert.equal(lane(s, 0).length, 0, 'the clip left the lane');
  assert.deepEqual(s.state.assets, assets, 'its source stays in the project');
  assert.match(container.querySelector('[data-field="clipboard"]').textContent, /1 clip from A Vocals/);
  s.seek(8);
  api.ui.selectedTrack = 2;
  ctrl('v');
  await new Promise((r) => setTimeout(r, 0));
  const pasted = lane(s, 2).find((c) => c.timelineStartBeat === 8);
  assert.ok(pasted, 'pasted at the playhead on the selected lane');
  for (const k of ['durationBeats', 'sourceOffsetSec', 'stretchMode', 'customStretchRatio', 'assetId', 'fadeInBeats', 'fadeOutBeats']) {
    assert.deepEqual(pasted[k], original[k], k);
  }
  assert.equal(api.ui.selectedClipId, pasted.id, 'the pasted clip is selected');
  assert.ok(s.undo());
  assert.equal(lane(s, 2).length, 1, 'only the bass clip is left on lane 3');
  assert.ok(s.undo());
  assert.deepEqual(lane(s, 0)[0], original, 'the cut clip is back exactly as it was');
  assert.ok(s.redo());
  assert.ok(s.redo());
  assert.ok(lane(s, 2).some((c) => c.timelineStartBeat === 8));
});

test('Ctrl+C copies without editing; paste of a copy adds a second clip over the same source', async () => {
  const { api, s } = await mounted();
  const drums = lane(s, 1)[0];
  api.select(drums.id);
  const revision = s.edit.revision;
  ctrl('c');
  assert.equal(s.edit.revision, revision, 'copy is not an edit');
  assert.ok(api.clipboard());
  s.seek(drums.durationBeats);
  ctrl('v');
  await new Promise((r) => setTimeout(r, 0));
  const pieces = lane(s, 1);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[1].timelineStartBeat, drums.durationBeats);
  assert.equal(pieces[1].assetId, drums.assetId);
  assert.equal(Object.keys(s.state.assets).length, 4, 'no asset copies');
});

test('a ruler range is cut from every lane, and pasted back keeps each lane', async () => {
  const { api, s, container } = await mounted();
  s.setLoop(4, 8);
  api.ui.selectedClipId = null;
  api.render();
  assert.match(container.querySelector('[data-field="region"]').textContent, /Range bar 2/);
  click(button(container.querySelector('[data-testid="edit-tools"]'), 'Cut range'));
  for (let i = 0; i < 4; i += 1) {
    const pieces = lane(s, i);
    assert.equal(pieces.length, 2, `lane ${i} split around the range`);
    assert.equal(pieces[0].durationBeats, 4);
    assert.equal(pieces[1].timelineStartBeat, 8);
  }
  assert.equal(api.clipboard().pieces.length, 4);
  assert.deepEqual(api.clipboard().lanes, [0, 1, 2, 3]);
  // Paste it back where it came from: the arrangement plays the same audio again.
  s.seek(4);
  click(button(container.querySelector('[data-testid="edit-tools"]'), 'Paste at playhead'));
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 4; i += 1) {
    const [a, mid, b] = lane(s, i);
    assert.equal(mid.timelineStartBeat, 4);
    assert.ok(Math.abs(mid.sourceOffsetSec - (a.sourceOffsetSec + 2)) < 1e-9, 'beat 4 at 120 BPM is 2 s into the source');
    assert.ok(Math.abs(b.sourceOffsetSec - (mid.sourceOffsetSec + 2)) < 1e-9);
  }
});

test('Delete with a range and no selected clip removes the range on the chosen lane only', async () => {
  const { api, s, container } = await mounted();
  s.setLoop(2, 6);
  api.ui.selectedTrack = 3;
  api.ui.regionScope = 'lane';
  api.ui.selectedClipId = null;
  api.render();
  key('Delete', {}, container.querySelector('.daw'));
  assert.equal(lane(s, 3).length, 2);
  for (const i of [0, 1, 2]) assert.equal(lane(s, i).length, 1, `lane ${i} untouched`);
  assert.ok(s.undo());
  assert.equal(lane(s, 3).length, 1);
});

test('S without a selected clip splits the selected lane at the playhead; outside any clip it is refused', async () => {
  const { api, s, container } = await mounted();
  api.ui.selectedTrack = 1;
  api.ui.selectedClipId = null;
  s.seek(6);
  api.render();
  key('s', {}, container.querySelector('.daw'));
  assert.deepEqual(lane(s, 1).map((c) => c.timelineStartBeat), [0, 6]);
  s.seek(100);
  const before = s.edit.serialize();
  key('s', {}, container.querySelector('.daw'));
  assert.equal(s.edit.serialize(), before);
  assert.ok([...container.querySelectorAll('.daw__msg')].some((m) => m.dataset.code === 'SPLIT_OUTSIDE_CLIP'));
});

test('the right-click menu on a clip splits there, copies and deletes; Escape closes it', async () => {
  const { api, s, container } = await mounted();
  const bass = lane(s, 2)[0];
  const el = container.querySelector(`[data-clip-id="${bass.id}"]`);
  el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
  const menu = api.elements.menu;
  assert.equal(menu.hidden, false);
  assert.equal(api.ui.selectedClipId, bass.id);
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.dataset.action.replace(/ \(.*\)/, '')),
    ['Cut', 'Copy', 'Paste here', 'Split here', 'Split at playhead', 'Duplicate', 'Delete']);
  assert.ok(menu.querySelector('[data-action="Paste here"]').disabled, 'nothing to paste yet');
  key('Escape');
  assert.equal(menu.hidden, true);
  assert.equal(s.engine, null, 'Escape on the menu is not a transport command here');
  // Split at a pointer position: jsdom has no layout, so drive the beat through the menu builder.
  s.seek(3);
  container.querySelector(`[data-clip-id="${bass.id}"]`).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  click(menu.querySelector('[data-action="Split at playhead"]'));
  assert.deepEqual(lane(s, 2).map((c) => c.timelineStartBeat), [0, 3]);
  assert.equal(menu.hidden, true);
});

test('the right-click menu on an empty lane offers Paste here at that lane', async () => {
  const { api, s, container } = await mounted();
  api.select(lane(s, 0)[0].id);
  ctrl('c');
  const laneEl = container.querySelector('.daw__lane[data-track="6"]');
  laneEl.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
  const menu = api.elements.menu;
  assert.equal(api.ui.selectedClipId, null);
  const paste = menu.querySelector('[data-action="Paste here"]');
  assert.equal(paste.disabled, false);
  assert.ok(menu.querySelector('[data-action="Cut range"]').disabled, 'no range, no range edits');
  click(paste);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lane(s, 6).length, 1);
});

test('copy, Open another arrangement, paste: the copied audio is decoded again before the paste lands', async () => {
  const { api, s, fetched } = await mounted();
  api.select(lane(s, 1)[0].id);
  ctrl('c');
  for (const k of Object.keys(s.buffers)) delete s.buffers[k]; // what Open does to the old project's audio
  await s.newProject();
  fetched.length = 0;
  await api.pasteAt(0, 5);
  assert.deepEqual(fetched, ['/api/stems/a/audio?name=drums&start=0&duration=10']);
  assert.equal(lane(s, 5).length, 1);
  assert.ok(s.buffers['/api/stems/a/audio?name=drums&start=0&duration=10']);
});

test('a paste whose audio finishes decoding after the project changed does not land', async () => {
  const { api, s } = await mounted();
  api.select(lane(s, 1)[0].id);
  ctrl('c');
  for (const k of Object.keys(s.buffers)) delete s.buffers[k];
  let release;
  s.deps.decodeAudio = () => new Promise((r) => { release = r; });
  const pending = api.pasteAt(0, 5);
  await new Promise((r) => setTimeout(r, 0));
  await s.newProject();
  release(await decodeAudio());
  await pending;
  assert.equal(s.state.clips.length, 0);
  assert.ok(s.messages.some((m) => m.code === 'PASTE_STALE'));
});

test('shortcuts do nothing while the arrangement is hidden, and Ctrl+C leaves selected page text alone', async () => {
  const { api, s, container } = await mounted();
  api.select(lane(s, 0)[0].id);
  container.hidden = true;
  ctrl('x');
  assert.equal(lane(s, 0).length, 1, 'hidden: no cut');
  container.hidden = false;
  const p = document.createElement('p');
  p.textContent = 'some page text';
  document.body.append(p);
  window.getSelection().selectAllChildren(p);
  ctrl('c');
  assert.equal(api.clipboard(), null, 'the browser copies the selected text instead');
});

test('pressing a clip selects it even while another clip holds keyboard focus (the menu returns focus to its clip)', async () => {
  const { api, s, container } = await mounted();
  const [vocals] = lane(s, 0);
  const [bass] = lane(s, 2);
  container.querySelector(`[data-clip-id="${vocals.id}"]`).focus();
  assert.equal(api.ui.selectedClipId, vocals.id);
  container.querySelector(`[data-clip-id="${bass.id}"]`).dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
  assert.equal(api.ui.selectedClipId, bass.id);
  assert.equal(document.activeElement?.dataset.clipId, bass.id);
});
