// tests/frontend/arrangement/cutting-room.test.js — OPERATION THE CUTTING ROOM:
// region delete, clipboard copy/cut/paste and split through the one EditEngine.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIPBOARD_KIND,
  EditEngine,
  clipboardFromClips,
  clipboardFromRegion,
} from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { sourceAdvanceRate } from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';

const STEM = (ref, durationSec = 60) => ({ name: `${ref}.wav`, durationSec, bufferReference: `/api/stems/s/audio?name=${ref}` });

/** Two lanes: vocals on 0 (60 s at 60 BPM, beat_sync) and drums on 1 (manual 1.0). */
function twoLanes() {
  const engine = new EditEngine();
  const v = engine.loadStemToTrack(0, STEM('vocals'), 60);
  const d = engine.loadStemToTrack(1, STEM('drums'), null);
  return { engine, vocals: v.clipId, drums: d.clipId };
}

const clip = (engine, id) => engine.state.clips.find((c) => c.id === id);
const lane = (engine, i) => engine.state.clips.filter((c) => c.trackIndex === i)
  .sort((a, b) => a.timelineStartBeat - b.timelineStartBeat);

/** Source second heard at timeline beat `t` from whichever clip on lane covers it. */
function heardSource(engine, laneIndex, t) {
  const s = engine.state;
  const c = s.clips.find((x) => x.trackIndex === laneIndex
    && t >= x.timelineStartBeat - 1e-9 && t < x.timelineStartBeat + x.durationBeats - 1e-9);
  if (!c) return null;
  const rate = sourceAdvanceRate(c, s.assets[c.assetId], s.transport.masterBpm);
  return { ref: s.assets[c.assetId].bufferReference, sec: c.sourceOffsetSec + (t - c.timelineStartBeat) * (60 / s.transport.masterBpm) * rate };
}

test('deleteRegion removes only the range and keeps both outer pieces on their source', () => {
  const { engine, vocals } = twoLanes();
  const before = engine.snapshot();
  const heard10 = heardSource(engine, 0, 10);
  const heard30 = heardSource(engine, 0, 30);
  const { result } = engine.run({ name: 'deleteRegion', args: { startBeat: 16, endBeat: 24, trackIndices: [0] } });
  assert.equal(result.removed, 1);
  const pieces = lane(engine, 0);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].id, vocals);
  assert.equal(pieces[0].timelineStartBeat, 0);
  assert.equal(pieces[0].durationBeats, 16);
  assert.equal(pieces[1].timelineStartBeat, 24);
  assert.equal(pieces[1].durationBeats, 36);
  // The kept audio is the same audio at the same place: nothing closed the gap.
  assert.deepEqual(heardSource(engine, 0, 10), heard10);
  assert.ok(Math.abs(heardSource(engine, 0, 30).sec - heard30.sec) < 1e-9);
  assert.equal(heardSource(engine, 0, 20), null);
  // The drum lane and every asset are untouched.
  assert.deepEqual(lane(engine, 1), before.clips.filter((c) => c.trackIndex === 1));
  assert.deepEqual(engine.state.assets, before.assets);
  assert.equal(engine.undo(), true);
  assert.deepEqual(engine.state, before);
  assert.equal(engine.redo(), true);
  assert.equal(lane(engine, 0).length, 2);
});

test('deleteRegion across lanes removes a whole clip inside it and trims an edge clip', () => {
  const engine = new EditEngine();
  const a = engine.loadStemToTrack(0, STEM('vocals'), 60).clipId; // beats 0..60
  engine.moveClip(a, 0, 8); // beats 8..68
  const b = engine.loadStemToTrack(2, STEM('bass', 4), 60).clipId; // beats 0..4
  engine.moveClip(b, 2, 10); // beats 10..14, wholly inside
  engine.run({ name: 'deleteRegion', args: { startBeat: 4, endBeat: 16, trackIndices: [0, 2] } });
  assert.equal(lane(engine, 2).length, 0, 'the clip wholly inside is gone');
  const v = lane(engine, 0);
  assert.equal(v.length, 1, 'a clip that starts inside keeps only its outside piece');
  assert.equal(v[0].timelineStartBeat, 16);
  assert.ok(Math.abs(v[0].sourceOffsetSec - 8) < 1e-9, 'its in-point advanced by the removed 8 beats (4 s at 120 BPM, rate 2)');
  assert.ok(engine.state.assets[Object.keys(engine.state.assets).find((k) => engine.state.assets[k].bufferReference.endsWith('bass'))],
    'the deleted clip\'s source stays in the project');
});

test('an empty region is refused and changes nothing', () => {
  const { engine } = twoLanes();
  const before = engine.state;
  assert.throws(() => engine.run({ name: 'deleteRegion', args: { startBeat: 70, endBeat: 80, trackIndices: [0] } }),
    (err) => err.code === 'REGION_EMPTY');
  assert.throws(() => engine.run({ name: 'deleteRegion', args: { startBeat: 8, endBeat: 8, trackIndices: [0] } }),
    (err) => err.code === 'OUT_OF_RANGE');
  assert.equal(engine.state, before);
  assert.equal(engine.canUndo, true); // only the two loads
  assert.equal(engine.historyDepth.past, 2);
});

test('clipboardFromRegion is pure and cuts at the region edges like a split', () => {
  const { engine } = twoLanes();
  const json = JSON.stringify(engine.state);
  const board = clipboardFromRegion(engine.state, { startBeat: 16, endBeat: 24, trackIndices: [0, 1] });
  assert.equal(JSON.stringify(engine.state), json, 'copying a region never edits the project');
  assert.equal(board.kind, CLIPBOARD_KIND);
  assert.equal(board.originBeat, 16);
  assert.equal(board.lengthBeats, 8);
  assert.deepEqual(board.lanes, [0, 1]);
  const vocals = board.pieces.find((p) => p.clip.trackIndex === 0);
  assert.equal(vocals.offsetBeats, 0);
  assert.equal(vocals.clip.durationBeats, 8);
  assert.ok(Math.abs(vocals.clip.sourceOffsetSec - 16) < 1e-9, 'beat 16 is 8 s at 120 BPM, read at rate 2 from a 60 BPM stem');
  const drums = board.pieces.find((p) => p.clip.trackIndex === 1);
  assert.ok(Math.abs(drums.clip.sourceOffsetSec - 8) < 1e-9, 'manual ratio 1: 8 s of timeline is 8 s of source');
});

test('paste places a region copy so every beat plays the same source as the original', () => {
  const { engine } = twoLanes();
  const board = clipboardFromRegion(engine.state, { startBeat: 16, endBeat: 24, trackIndices: [0, 1] });
  const { result } = engine.run({ name: 'pasteClipboard', args: { clipboard: board, startBeat: 64, trackIndex: 5 } });
  assert.equal(result.clipIds.length, 2);
  const pasted = result.clipIds.map((id) => clip(engine, id));
  assert.deepEqual(pasted.map((c) => c.trackIndex).sort(), [0, 1], 'a multi-lane copy keeps its lanes');
  for (const t of [16, 17.5, 20, 23.9]) {
    for (const i of [0, 1]) {
      const original = heardSource(engine, i, t);
      // Lane 0's original ends at 60, so read the copy at 64 + (t - 16).
      const copy = (() => {
        const c = pasted.find((x) => x.trackIndex === i);
        const s = engine.state;
        const rate = sourceAdvanceRate(c, s.assets[c.assetId], s.transport.masterBpm);
        return { ref: s.assets[c.assetId].bufferReference, sec: c.sourceOffsetSec + (64 + t - 16 - c.timelineStartBeat) * 0.5 * rate };
      })();
      assert.equal(copy.ref, original.ref);
      assert.ok(Math.abs(copy.sec - original.sec) < 1e-9, `lane ${i} beat ${t}`);
    }
  }
  // Same asset records, no copies piled up.
  assert.equal(Object.keys(engine.state.assets).length, 2);
  assert.equal(engine.undo(), true);
  assert.equal(engine.state.clips.length, 2);
});

test('cut a clip then paste it: same source fields, new id, one undo step each', () => {
  const { engine, drums } = twoLanes();
  engine.setClipGain(drums, -3);
  engine.setClipPitch(drums, 2, true);
  engine.slipClip(drums, 0); // no-op keeps history unchanged
  engine.trimClip(drums, 'end', -20);
  const original = structuredClone(clip(engine, drums));
  const board = clipboardFromClips(engine.state, [drums]);
  engine.deleteClip(drums); // Cut = copy + delete
  assert.equal(clip(engine, drums), undefined);
  const depth = engine.historyDepth.past;
  const { result } = engine.run({ name: 'pasteClipboard', args: { clipboard: board, startBeat: 32, trackIndex: 3 } });
  assert.equal(engine.historyDepth.past, depth + 1);
  const pasted = clip(engine, result.clipIds[0]);
  assert.equal(pasted.trackIndex, 3, 'a one-lane copy lands on the chosen lane');
  assert.equal(pasted.timelineStartBeat, 32);
  for (const k of ['durationBeats', 'sourceOffsetSec', 'stretchMode', 'customStretchRatio', 'pitchSemitones',
    'preserveFormants', 'clipGainDb', 'fadeInBeats', 'fadeOutBeats', 'assetId']) {
    assert.deepEqual(pasted[k], original[k], k);
  }
  engine.undo();
  engine.undo();
  assert.deepEqual(clip(engine, drums), original, 'undoing the cut brings back the very same clip');
});

test('paste into a new project carries the source record; a same-source paste reuses it', () => {
  const { engine, vocals } = twoLanes();
  const board = clipboardFromClips(engine.state, [vocals]);
  const fresh = new EditEngine();
  fresh.run({ name: 'pasteClipboard', args: { clipboard: board, startBeat: 0, trackIndex: 4 } });
  fresh.run({ name: 'pasteClipboard', args: { clipboard: board, startBeat: 60, trackIndex: 4 } });
  assert.equal(Object.keys(fresh.state.assets).length, 1);
  const asset = Object.values(fresh.state.assets)[0];
  assert.equal(asset.bufferReference, engine.state.assets[board.pieces[0].asset.id].bufferReference);
  // The pasted project survives save and reopen (arrangement compatibility).
  const reopened = EditEngine.deserialize(fresh.serialize());
  assert.deepEqual(reopened.state.clips, fresh.state.clips);
});

test('a paste that would run past its source after a tempo change is refused whole', () => {
  const { engine, drums } = twoLanes();
  const board = clipboardFromClips(engine.state, [drums]);
  engine.deleteClip(drums);
  engine.setMasterBpm(60); // manual-rate drums now consume twice the source per beat
  const before = engine.state;
  assert.throws(() => engine.run({ name: 'pasteClipboard', args: { clipboard: board, startBeat: 0, trackIndex: 1 } }),
    (err) => err.code === 'BEYOND_ASSET_END');
  assert.equal(engine.state, before);
});

test('a malformed clipboard is refused before anything changes', () => {
  const { engine } = twoLanes();
  const before = engine.state;
  for (const clipboard of [null, {}, { kind: CLIPBOARD_KIND, lanes: [0], pieces: [] },
    { kind: CLIPBOARD_KIND, lanes: [0], pieces: [{ offsetBeats: 0, clip: {}, asset: { id: 'x' } }] }]) {
    assert.throws(() => engine.run({ name: 'pasteClipboard', args: { clipboard, startBeat: 0, trackIndex: 0 } }),
      (err) => err.code === 'CLIPBOARD_INVALID');
  }
  assert.equal(engine.state, before);
});

test('a sliver shorter than a split can leave is removed with the region', () => {
  const { engine } = twoLanes();
  engine.run({ name: 'deleteRegion', args: { startBeat: 1 / 128, endBeat: 8, trackIndices: [0] } });
  const v = lane(engine, 0);
  assert.equal(v.length, 1);
  assert.equal(v[0].timelineStartBeat, 8);
});
