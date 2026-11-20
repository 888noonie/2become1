// tests/frontend/arrangement/negative-control.test.js — proof that the
// verification actually detects a defective implementation.
//
// OPERATION ALL THE TIME IN THE WORLD, §11: "Include tests that fail on an
// intentionally defective implementation." The checker in fixtures/ is an
// independent reference for timeline/source correspondence; the defective
// engine applies the classic stretch-rate bug (split offsets advance at the
// timeline rate instead of the clip's source-advance rate).

import test from 'node:test';
import assert from 'node:assert/strict';

import { EditEngine } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { DefectiveEngine } from './fixtures/defective-engine.js';
import { checkSourceCorrespondence } from './fixtures/correspondence.js';

/** Replay the same operation log on any engine. Returns the log with ids. */
function playScenario(EngineClass) {
  const engine = new EngineClass(); // masterBpm 120
  const { clipId } = engine.loadStemToTrack(0, {
    name: 'vocals.wav', durationSec: 60, bufferReference: 'r:vocals',
  }, 60); // beat_sync, rate = 120/60 = 2
  const log = [{ op: 'load', clipId, durationBeats: 60, mode: 'beat_sync', nativeBpm: 60, durationSec: 60 }];

  const split = engine.splitClipAtBeat(clipId, 24);
  log.push({ op: 'split', clipId, at: 24, rightId: split.rightId });

  engine.trimClip(split.rightId, 'start', 6);
  log.push({ op: 'trimStart', clipId: split.rightId, deltaBeats: 6 });

  engine.trimClip(clipId, 'end', 12);
  log.push({ op: 'trimEnd', clipId, deltaBeats: 12 });

  engine.setClipStretch(split.rightId, 1.5);
  log.push({ op: 'stretch', clipId: split.rightId, ratioOrAuto: 1.5 });

  engine.moveClip(clipId, 3, 12);
  log.push({ op: 'move', clipId, newTrackIndex: 3, newStartBeat: 12 });

  return { engine, log };
}

test('the real engine satisfies the independent source-correspondence reference', () => {
  const { engine, log } = playScenario(EditEngine);
  const check = checkSourceCorrespondence(engine, log);
  assert.deepEqual(check, { ok: true, mismatches: [] });
});

test('the same check fails the intentionally defective engine (negative control)', () => {
  const { engine, log } = playScenario(DefectiveEngine);
  const check = checkSourceCorrespondence(engine, log);
  assert.equal(check.ok, false, 'the checker must detect the stretch-rate defect');
  const offsets = check.mismatches.filter((m) => m.field === 'sourceOffsetSec');
  assert.ok(offsets.length >= 1, 'the defect lives in split source offsets');
  assert.equal(offsets[0].id, 'clip-2', 'the split child is the corrupted region');
  // The defect is specifically the missing rate factor (rate 2 here).
  assert.equal(offsets[0].expected, 30);
  assert.equal(offsets[0].actual, 18);
});
