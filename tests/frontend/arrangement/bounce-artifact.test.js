// tests/frontend/arrangement/bounce-artifact.test.js — duration truthfulness
// regression (GATE 6 corrective action, Grok C2).
//
// The audited WAV held 448 000 frames (9.3333 s) while the documentation
// claimed 432 000 (9.000 s). The WAV was right: the arrangement end is a
// MUSICAL fact set by the 140 BPM percussion's beat-synced extent (8 source-s
// at 140 BPM = 18.6667 beats = 9.3333 s at the 120 master), and the prose had
// conflated it with the lead's nine-second trim (beat 18.0015 = 432 036
// frames). This test computes the end THREE independent ways and compares it
// with the WAV container's frame count:
//
//   1. plain arithmetic over raw EditEngine state (no plan compiler),
//   2. the compiled RenderPlan's arrangementEndFrame,
//   3. the data-chunk frame count of the produced WAV.
//
// It also pins the documented latency/tail handling: the artifact is the exact
// arrangement extent (the 0.3 s DSP tail excluded) and renderOffline trims the
// limiter's lookahead so WAV frame 0 == arrangement frame 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { EditEngine } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '../../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { limiterLookaheadFrames } from '../../../src/twobecomeone/studio_static/js/arrangement/offline-render.js';
import { encodeWav24 } from '../../../src/twobecomeone/studio_static/js/arrangement/wav.js';
import { SR, buildStems } from '../../browser/daw/synth.js';
import { applyHarnessArrangement } from '../../browser/daw/arrangement-script.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TAIL_FRAMES = Math.round(0.3 * SR);

/** Independent RIFF chunk walker (works on any WAV, canonical or not). */
function wavFrames(buffer) {
  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length);
  let at = 12;
  let fmt = null;
  let dataSize = 0;
  while (at + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      fmt = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    }
    if (id === 'data') { dataSize = size; break; }
    at += 8 + size + (size % 2);
  }
  assert.ok(fmt, 'WAV must carry a fmt chunk');
  return { frames: dataSize / (fmt.channels * fmt.bits / 8), ...fmt };
}

function fixtureSeconds(name) {
  const { frames, sampleRate } = wavFrames(readFileSync(path.join(ROOT, 'tests', 'fixtures', name)));
  return frames / sampleRate;
}

function buildHarnessState() {
  // The exact harness arrangement: synthesised stems + the repo's loop
  // fixtures, one shared edit script (tests/browser/daw/arrangement-script.js).
  const stems = buildStems();
  const engine = new EditEngine({
    project: {
      ...new EditEngine().state,
      transport: { ...new EditEngine().state.transport, masterBpm: 120 },
    },
  });
  const { ids } = applyHarnessArrangement(engine, {
    drumsSec: stems.drums[0].length / SR,
    bassSec: stems.bass[0].length / SR,
    chordsSec: fixtureSeconds('c_major_100.wav'),
    leadSec: stems.lead[0].length / SR,
    padSec: stems.pad[0].length / SR,
    arpSec: stems.arp[0].length / SR,
    percSec: fixtureSeconds('a_minor_140.wav'),
    sideSec: fixtureSeconds('side_tone.wav'),
  });
  return { engine, ids };
}

function independentEndFrame(state) {
  // Plain arithmetic over raw state — no plan compiler involved.
  const spbSec = 60 / state.transport.masterBpm;
  let end = 0;
  for (const clip of state.clips) {
    end = Math.max(end, Math.round((clip.timelineStartBeat + clip.durationBeats) * spbSec * SR));
  }
  return end;
}

test('the arrangement end is 448 000 frames (9.3333 s) and three derivations agree', () => {
  const { engine } = buildHarnessState();
  const plan = compileRenderPlan(engine.state, { tailFrames: TAIL_FRAMES });

  // Derivation 1: raw state arithmetic.
  const end = independentEndFrame(engine.state);
  assert.equal(end, 448000, '18.6667 beats at 120 BPM = 9.3333 s at 48 kHz');

  // Derivation 2: the compiled plan.
  assert.equal(plan.output.arrangementEndFrame, end);

  // Derivation 3: the exported WAV container (harness export shape: the
  // arrangement extent only, tail excluded).
  const channels = [new Float32Array(plan.output.totalFrames), new Float32Array(plan.output.totalFrames)];
  const artifact = encodeWav24([channels[0].slice(0, end), channels[1].slice(0, end)], SR);
  const parsed = wavFrames(Buffer.from(artifact));
  assert.equal(parsed.frames, end, 'WAV frame count must equal the computed arrangement end');
  assert.equal(parsed.frames / parsed.sampleRate, 448000 / 48000);
});

test('the 140->120 BPM stretch sets the end (and the lead trim does not)', () => {
  const { engine, ids } = buildHarnessState();
  const plan = compileRenderPlan(engine.state, { tailFrames: TAIL_FRAMES });

  // The percussion: 8 source-s at 140 BPM = 18.6667 source-beats, beat-synced
  // to the 120 master -> 18.6667 master-beats = 9.3333 output-s. The plan's
  // rate is the source-advance rate 120/140 source-s per output-s.
  const perc = plan.clips.find((c) => c.assetId === ids.perc.assetId);
  assert.ok(Math.abs(perc.rate - 120 / 140) < 1e-9);
  assert.ok(Math.abs(perc.sourceSpanFrames / SR - 8) < 1e-3, 'the full 8 s source is consumed');
  assert.ok(Math.abs((perc.timelineEndFrame - perc.timelineStartFrame) / SR - 8 / (120 / 140)) < 1e-3,
    'output extent = source / rate = 9.3333 s');
  assert.equal(perc.timelineEndFrame, plan.output.arrangementEndFrame, 'the percussion sets the end');

  // The lead's sine-peak trim ends at beat 18.0015 = 432 036 frames — the
  // figure the old documentation mis-stated as the arrangement end (and
  // rounded to 432 000). It is an interior edge.
  const lead = plan.clips.find((c) => c.assetId === ids.lead.assetId);
  assert.equal(lead.timelineEndFrame, 432036);
  assert.ok(lead.timelineEndFrame < plan.output.arrangementEndFrame,
    'the lead trim is NOT the arrangement end');
});

test('documented latency/tail handling: tail excluded, lookahead trimmed', () => {
  const { engine } = buildHarnessState();
  const plan = compileRenderPlan(engine.state, { tailFrames: TAIL_FRAMES });

  // The plan's total render length carries the documented 0.3 s DSP tail...
  assert.equal(plan.output.totalFrames, plan.output.arrangementEndFrame + TAIL_FRAMES);
  assert.equal(plan.output.totalFrames, 462400);
  // ...the artifact excludes it (exact arrangement extent)...
  assert.notEqual(plan.output.arrangementEndFrame, plan.output.totalFrames);
  // ...and renderOffline trims the limiter's lookahead so that WAV frame 0 is
  // arrangement frame 0 (it renders totalFrames + lookahead and cuts the head).
  assert.equal(limiterLookaheadFrames(plan), 240, '5 ms lookahead at 48 kHz');
});

test('the saved bounce artifact matches the computed end (when present)', (t) => {
  const artifactPath = path.join(ROOT, 'artifacts', 'living-daylights-bounce.wav');
  if (!existsSync(artifactPath)) {
    t.skip('artifacts/living-daylights-bounce.wav is not present (untracked artifact)');
    return;
  }
  const { frames, sampleRate } = wavFrames(readFileSync(artifactPath));
  const { engine } = buildHarnessState();
  const end = independentEndFrame(engine.state);
  assert.equal(frames, end, 'the saved WAV frame count must equal the computed arrangement end');
  assert.equal(sampleRate, SR);
  assert.ok(Math.abs(frames / sampleRate - 9.3333333) < 1e-4, `duration must read 9.3333 s, got ${frames / sampleRate}`);
});

test('the fixture loops are exactly 8.000 s each (the durations the harness feeds)', () => {
  for (const name of ['c_major_100.wav', 'a_minor_140.wav', 'side_tone.wav']) {
    assert.equal(fixtureSeconds(name), 8, `${name} must be exactly 8.000 s`);
  }
});
