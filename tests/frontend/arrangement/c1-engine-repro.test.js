// tests/frontend/arrangement/c1-engine-repro.test.js — engine-level reproductions
// of Grok's BLOCKING C1 findings N1 (seek doubles audio) and N2 (Stop never
// completes), OPERATION THE GOLDEN EAR II.
//
// These instantiate the ACTUAL RealtimeEngine against the simulated Web Audio
// host and use only the API the C1 engine (ec74085) and the repaired engine
// share, so the same file is the negative control: run with
//   CLOCKWORK_ENGINE_MODULE=<legacy copy>  node --test <this file>
// and both tests must FAIL on the legacy engine (tests/browser/clockwork-rescue/
// legacy-control.mjs does exactly that).

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import {
  FakeAudioContext, installFakeWorkletGlobal, fakeStretchFactory, flush, manualTimers,
  flatPlan, planClip, silentSource, SR,
} from './helpers/fake-audio.js';

const ENGINE_URL = process.env.CLOCKWORK_ENGINE_MODULE
  ? pathToFileURL(process.env.CLOCKWORK_ENGINE_MODULE).href
  : new URL('../../../src/twobecomeone/studio_static/js/realtime-engine.js', import.meta.url).href;
const { RealtimeEngine } = await import(ENGINE_URL);

installFakeWorkletGlobal();

async function makeEngine({ startAt = 0, onParked } = {}) {
  const ctx = new FakeAudioContext({ currentTime: startAt });
  const plan = flatPlan({
    clips: [planClip({ clipId: 'pad', trackIndex: 0, start: 0, length: 20 * SR })],
  });
  const engine = new RealtimeEngine(ctx, plan, { src: silentSource(20 * SR) }, {
    StretchFactory: fakeStretchFactory(),
    limiterModuleUrl: 'limiter.js',
    onParked,
    timers: manualTimers(), // the test drives every wake through tick()
  });
  await engine.prepare();
  return { ctx, engine, plan };
}

async function advance(ctx, engine, toSec, stepSec = 0.025) {
  while (ctx.currentTime + 1e-12 < toSec) {
    ctx.currentTime = Math.min(toSec, ctx.currentTime + stepSec);
    await engine.tick();
    await flush();
  }
}

/** Gate nodes feeding track 0 that are still connected, with their clip gains. */
function trackVoices(ctx, engine, track = 0) {
  const input = engine.backbone.trackInputs[track];
  return [...ctx.nodes].filter((n) => n.kind === 'gain' && n.outputs.has(input)).map((gate) => ({
    gate,
    clipGain: [...gate.inputs][0],
  }));
}

function audibleSum(voices, t) {
  return voices.reduce((sum, v) => sum + v.gate.gain.valueAt(t) * (v.clipGain ? v.clipGain.gain.valueAt(t) : 1), 0);
}

test('N1 (Grok repro): a seek at 6.0 s to frame 240000 leaves no old audio after the 6.104 s handover', async () => {
  // Epoch origin 5.0 s: Play at 4.896 s with the 104 ms start lead.
  const { ctx, engine } = await makeEngine({ startAt: 4.896 });
  engine.play();
  await flush();
  await advance(ctx, engine, 6.0);
  const before = trackVoices(ctx, engine);
  assert.equal(before.length, 1, 'one voice is sounding before the seek');
  assert.ok(Math.abs(audibleSum(before, 6.0) - 1) < 1e-9, 'the pad is at unity before the seek');

  engine.seek(240000);
  await flush();
  await engine.tick();
  await flush();

  const oldGate = before[0].gate.gain;
  // The incoming epoch begins at 6.104 s; the handover crossfade is 5 ms.
  for (const t of [6.115, 6.2, 7.0, 9.0, 9.999, 10.0]) {
    assert.ok(oldGate.valueAt(t) === 0 || before[0].gate.outputs.size === 0,
      `the outgoing voice must be silent at ${t} s (gate ${oldGate.valueAt(t)})`);
  }
  await advance(ctx, engine, 6.3);
  const after = trackVoices(ctx, engine);
  for (const t of [6.115, 6.2, 6.3]) {
    const sum = audibleSum(after, t);
    assert.ok(Math.abs(sum - 1) < 1e-6, `exactly one voice-worth of gain at ${t} s, got ${sum}`);
  }
  assert.ok(!after.some((v) => v.gate === before[0].gate), 'the outgoing voice is disconnected by 6.3 s');
  engine.dispose();
});

test('N2 (Grok repro): Stop completes; advancing to 100 s does not leave the engine stopping', async () => {
  const parked = [];
  const { ctx, engine } = await makeEngine({ startAt: 0, onParked: (f) => parked.push(f) });
  const parkedBefore = parked.length;
  engine.play();
  await flush();
  await advance(ctx, engine, 1.0);
  engine.stop();
  await flush();
  await advance(ctx, engine, 100, 0.5);
  const s = engine.state();
  assert.equal(s.phase, 'stopped', `phase after Stop + 99 s: ${s.phase}`);
  assert.equal(s.isPlaying, false);
  assert.deepEqual(parked.slice(parkedBefore), [0], 'the parked cue (frame 0) is written exactly once');
  engine.dispose();
});
