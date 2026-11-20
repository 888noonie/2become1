// tests/frontend/arrangement/history-and-proposals.test.js — undo/redo
// reversibility, persistence, and the AI Producer proposal boundary.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApprovalRequiredError,
  EditEngine,
  InvalidEditError,
} from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';

function engineWithStem() {
  const engine = new EditEngine();
  const { clipId } = engine.loadStemToTrack(0, {
    name: 'vocals.wav', durationSec: 60, bufferReference: 'r:vocals',
  }, 60);
  return { engine, clipId };
}

test('undo restores the exact previous state and redo reapplies it', () => {
  const { engine, clipId } = engineWithStem();
  const before = JSON.stringify(engine.state);
  engine.moveClip(clipId, 2, 8);
  const after = JSON.stringify(engine.state);
  assert.notEqual(before, after);

  assert.equal(engine.undo(), true);
  assert.equal(JSON.stringify(engine.state), before);
  assert.equal(engine.canRedo, true);

  assert.equal(engine.redo(), true);
  assert.equal(JSON.stringify(engine.state), after);
});

test('undo and redo at the ends of history are safe no-ops', () => {
  const engine = new EditEngine();
  assert.equal(engine.undo(), false);
  assert.equal(engine.redo(), false);
  engine.setMasterBpm(140);
  assert.equal(engine.redo(), false);
  assert.equal(engine.undo(), true);
  assert.equal(engine.undo(), false);
});

test('a new edit clears the redo stack', () => {
  const { engine, clipId } = engineWithStem();
  engine.moveClip(clipId, 1, 4);
  engine.undo();
  assert.equal(engine.canRedo, true);
  engine.setMasterBpm(90);
  assert.equal(engine.canRedo, false);
});

test('undo restores a whole edit sequence, including a split as one step', () => {
  const { engine, clipId } = engineWithStem();
  const before = JSON.stringify(engine.state);
  const split = engine.splitClipAtBeat(clipId, 30);
  assert.equal(engine.state.clips.length, 2);
  engine.undo();
  assert.equal(JSON.stringify(engine.state), before);
  assert.equal(engine.state.clips.length, 1);
  engine.redo();
  assert.equal(engine.state.clips.length, 2);
  assert.ok(engine.state.clips.some((c) => c.id === split.rightId));
});

test('live transport markers never enter history and survive undo', () => {
  const { engine, clipId } = engineWithStem();
  const depth = engine.historyDepth.past;
  engine.setPlayhead(12);
  engine.setPlaying(true);
  assert.equal(engine.historyDepth.past, depth, 'playhead/playing are not edits');

  engine.moveClip(clipId, 4, 2); // one real edit on top
  engine.undo();
  assert.equal(engine.state.transport.playheadBeat, 12);
  assert.equal(engine.state.transport.isPlaying, true);
  assert.equal(engine.state.clips[0].timelineStartBeat, 0, 'the move itself is undone');
});

test('masterBpm and loopRange are arrangement choices and are undoable', () => {
  const engine = new EditEngine();
  engine.setMasterBpm(128);
  engine.setLoopRange(8, 24);
  engine.undo();
  assert.deepEqual(engine.state.transport.loopRange, null);
  engine.undo();
  assert.equal(engine.state.transport.masterBpm, 120);
});

test('undoing a load removes the stem cleanly', () => {
  const engine = new EditEngine();
  engine.loadStemToTrack(0, { name: 'a.wav', durationSec: 30, bufferReference: 'r:a' }, 120);
  assert.equal(engine.state.clips.length, 1);
  engine.undo();
  assert.equal(engine.state.clips.length, 0);
  assert.deepEqual(engine.state.assets, {});
});

test('history is bounded', () => {
  const engine = new EditEngine();
  for (let i = 0; i < 205; i += 1) {
    engine.loadStemToTrack(0, { name: `s${i}.wav`, durationSec: 1, bufferReference: `r:${i}` }, 120);
  }
  assert.equal(engine.historyDepth.past, 200);
  assert.equal(engine.state.clips.length, 205, 'history bounds never lose live state');
});

test('serialization round trip preserves state and starts a fresh history', () => {
  const { engine, clipId } = engineWithStem();
  engine.moveClip(clipId, 5, 3);
  engine.setLoopRange(2, 10);
  const text = engine.serialize();
  const restored = EditEngine.deserialize(text);
  assert.equal(JSON.stringify(restored.state), JSON.stringify(engine.state));
  assert.equal(restored.canUndo, false);
  assert.equal(restored.canRedo, false);
  // The restored engine is fully operational.
  restored.moveClip(clipId, 6, 1);
  assert.equal(restored.state.clips[0].trackIndex, 6);
});

test('propose is a dry run: it never mutates the state', () => {
  const { engine, clipId } = engineWithStem();
  const before = engine.state;
  const json = JSON.stringify(before);
  const proposal = engine.propose({ name: 'moveClip', args: { clipId, newTrackIndex: 2, newStartBeat: 4 } });
  assert.equal(proposal.status, 'pending');
  assert.strictEqual(engine.state, before);
  assert.equal(JSON.stringify(engine.state), json);
});

test('a rejected proposal reports its errors and cannot be applied', () => {
  const { engine, clipId } = engineWithStem();
  const bad = engine.propose({ name: 'moveClip', args: { clipId, newTrackIndex: 99, newStartBeat: 0 } });
  assert.equal(bad.status, 'rejected');
  assert.ok(bad.errors.length >= 1);
  assert.throws(
    () => engine.applyProposal(bad, { approved: true }),
    (err) => err instanceof InvalidEditError && err.code === 'PROPOSAL_NOT_APPLICABLE',
  );
  const unknown = engine.propose({ name: 'deleteEverything', args: {} });
  assert.equal(unknown.status, 'rejected');
  assert.equal(unknown.errors[0].code, 'UNKNOWN_COMMAND');
});

test('a pending proposal needs explicit owner approval before it applies', () => {
  const { engine, clipId } = engineWithStem();
  const proposal = engine.propose({ name: 'moveClip', args: { clipId, newTrackIndex: 3, newStartBeat: 16 } });
  assert.throws(() => engine.applyProposal(proposal), ApprovalRequiredError);
  assert.throws(() => engine.applyProposal(proposal, { approved: false }), ApprovalRequiredError);
  assert.equal(engine.state.clips[0].trackIndex, 0, 'nothing moved without approval');

  const result = engine.applyProposal(proposal, { approved: true });
  assert.equal(result.clipId, clipId);
  assert.equal(engine.state.clips[0].trackIndex, 3);
  assert.equal(engine.state.clips[0].timelineStartBeat, 16);
});

test('a proposal is re-validated at apply time against the current state', () => {
  const { engine, clipId } = engineWithStem();
  const proposal = engine.propose({ name: 'splitClipAtBeat', args: { clipId, splitBeat: 50 } });
  assert.equal(proposal.status, 'pending');
  engine.trimClip(clipId, 'end', -20); // the clip is now 0..40 beats
  assert.throws(
    () => engine.applyProposal(proposal, { approved: true }),
    (err) => err.code === 'SPLIT_OUTSIDE_CLIP',
  );
  assert.equal(engine.state.clips.length, 1, 'the refused proposal changed nothing');
});

test('proposals and hand edits share one validated command path', () => {
  const { engine, clipId } = engineWithStem();
  const proposal = engine.propose({ name: 'setClipGain', args: { clipId, gainDb: 99 } });
  assert.equal(proposal.status, 'rejected');
  // The same invalid value through the hand path throws with the same code.
  assert.throws(() => engine.setClipGain(clipId, 99), (err) => err.code === 'OUT_OF_RANGE');
});
