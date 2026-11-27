#!/usr/bin/env node
// tests/browser/stem_desk_stop_regression.js — a focused two-bank Stop
// regression on genuine decoded musical PCM.
//
// Why this exists
// ---------------
// stem_desk_real_audio.js already has a check named "stop releases to digital
// silence", but it calls desk.stop() BEFORE startRendering().  On an
// OfflineAudioContext that stops every source at the start of the render, so
// the check only proves that an already-stopped desk renders silence.  It
// never proves that real playback began and was then stopped.
//
// This harness issues Stop DURING an offline render, through the production
// StemDesk.stop() path, at a deterministic suspend() wake:
//
//   1. two banks (A and B, four musical stems each) play on one
//      OfflineAudioContext;
//   2. the rendered PCM is measurably non-silent before the Stop, and the same
//      frames are sample-identical to a control run without Stop;
//   3. Stop at a fixed frame leaves digital silence after it, while the
//      control run stays audible over the very same interval;
//   4. each bank alone (the other bank's lanes muted, both banks still
//      loaded) is audible before the Stop, so the two-bank mix is not one
//      bank carrying the test;
//   5. the stopped desk still holds both groups and all eight decoded
//      buffers, and a second Play is audible and sample-identical to the
//      programme start.
//
// OfflineAudioContext.suspend() is the established deterministic clock seam in
// this repository (tests/browser/clockwork/harness.js and
// tests/browser/clockwork-rescue/harness.js use the same idea).  No transport
// state is mocked: the nodes, decodeAudioData, Play and Stop are the real
// StemDesk runtime's.  Only the render clock is suspended so the test can call
// Stop at a known time.
//
// Usage:
//   node tests/browser/stem_desk_stop_regression.js
//   node tests/browser/stem_desk_stop_regression.js \
//     --stemsA <vocals/drums/bass/other dir> --stemsB <dir> [--out <dir>]
//
// With no --stemsA/--stemsB, the harness builds the short two-bank fixture
// with tests/browser/first_mix_stop_fixture.py (the established FOR YOUR EARS
// synthesis, trimmed to eight bars so it fits the ordinary 40 MiB ceiling).
//
// Output: tests/browser/artifacts/stem-desk-stop-regression.json
// Exit code is nonzero on any failed check.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'src', 'twobecomeone', 'studio_static', 'js', 'runtime', 'stem-desk.js');
const CROSSFADER = path.join(ROOT, 'src', 'twobecomeone', 'studio_static', 'js', 'runtime', 'crossfader.js');
const FIXTURE = path.join(ROOT, 'tests', 'browser', 'first_mix_stop_fixture.py');
const NAMES = ['vocals', 'drums', 'bass', 'other'];

const value = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(value('--out', path.join(ROOT, 'tests', 'browser', 'artifacts')));
const keepFixture = process.argv.includes('--keep-fixture');

let fixtureRoot = null;
let stemsA = value('--stemsA');
let stemsB = value('--stemsB');
if (!stemsA || !stemsB) {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'first-mix-stop-'));
  const python = process.env.PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
  const generated = spawnSync(python, [FIXTURE, '--out', fixtureRoot], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') },
  });
  if (generated.status !== 0) {
    console.error('fixture generation failed');
    console.error(generated.stdout || '');
    console.error(generated.stderr || '');
    rmSync(fixtureRoot, { recursive: true, force: true });
    process.exit(2);
  }
  stemsA = stemsA || path.join(fixtureRoot, 'midnight-circuit');
  stemsB = stemsB || path.join(fixtureRoot, 'paper-lanterns');
}

const files = { A: {}, B: {} };
for (const [groupId, dir] of [['A', stemsA], ['B', stemsB]]) {
  for (const name of NAMES) {
    const file = path.join(dir, `${name}.wav`);
    if (!existsSync(file)) {
      console.error(`missing stem file: ${file}`);
      process.exit(2);
    }
    files[groupId][name] = readFileSync(file);
  }
}

const server = http.createServer((req, res) => {
  const [groupId, file] = (req.url || '').split('?')[0].replace(/^\//, '').split('/');
  const name = (file || '').replace('.wav', '');
  const body = files[groupId]?.[name];
  if (!body) {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end('missing stem');
    return;
  }
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': body.length,
    'access-control-allow-origin': '*',
  });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const source = readFileSync(RUNTIME, 'utf8');
const crossfaderSource = readFileSync(CROSSFADER, 'utf8');

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async ({ runtimeSource, crossfaderSource, baseUrl, names }) => {
    const crossfaderUrl = URL.createObjectURL(new Blob([crossfaderSource], { type: 'text/javascript' }));
    const patched = runtimeSource.replace('./crossfader.js', crossfaderUrl);
    const moduleUrl = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
    const { StemDesk, STEM_DESK_LIMITS } = await import(moduleUrl);

    const RATE = 44100;
    const RENDER_SECONDS = 3.9;
    // 345 render quanta of 128 frames: a stop time every browser agrees on.
    const STOP_FRAME = 44160;
    const STOP_AT = STOP_FRAME / RATE;
    // 5 dB above the desk's own "effectively silent lane" label (-50 dB).  The
    // fixture stems sit near -24 dBFS each, so two equal-power banks are about
    // -18 dBFS together: -45 dB is a conservative audibility floor, not a
    // threshold chosen to fit a quiet render.
    const AUDIBLE_RMS_DB = -45;
    const AUDIBLE_PEAK = 0.01;
    // The desk has no latency stage between a buffer source and destination.
    // After Stop the expected output is exactly zero; 1e-7 is one float32
    // step near 1.0 and proves digital silence rather than "inaudible".
    const SILENCE_PEAK = 1e-7;
    // Offline rendering of the same graph is deterministic.  Two independent
    // renders may differ only by float32 rounding of identical operations.
    const IDENTICAL = 1e-6;

    const checks = [];
    const scenarios = {};
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
    const db = (value) => 20 * Math.log10(value + 1e-12);

    function windowMetrics(channels, fromSec, toSec) {
      const from = Math.max(0, Math.round(fromSec * RATE));
      const to = Math.min(channels[0].length, Math.round(toSec * RATE));
      let peak = 0;
      let sumSq = 0;
      let count = 0;
      let nonSilent = 0;
      for (const channel of channels) {
        for (let i = from; i < to; i += 1) {
          const value = channel[i];
          const absolute = Math.abs(value);
          if (absolute > peak) peak = absolute;
          if (absolute > SILENCE_PEAK) nonSilent += 1;
          sumSq += value * value;
          count += 1;
        }
      }
      const rms = Math.sqrt(sumSq / Math.max(1, count));
      return {
        fromSeconds: fromSec,
        toSeconds: toSec,
        frames: Math.max(0, to - from),
        peak,
        peakDb: db(peak),
        rms,
        rmsDb: db(rms),
        nonSilent,
      };
    }

    /** Max |a[i] - b[i - shift]| over the requested output window. */
    function maxAbsDiff(a, b, fromSec, toSec, shiftFrames = 0) {
      const from = Math.max(0, shiftFrames, Math.round(fromSec * RATE));
      const to = Math.min(a[0].length, b[0].length + shiftFrames, Math.round(toSec * RATE));
      let max = 0;
      let compared = 0;
      for (let c = 0; c < Math.min(a.length, b.length); c += 1) {
        for (let i = from; i < to; i += 1) {
          const difference = Math.abs(a[c][i] - b[c][i - shiftFrames]);
          if (difference > max) max = difference;
          compared += 1;
        }
      }
      return { maxAbsDiff: max, compared };
    }

    function compactState(state) {
      return {
        status: state.status,
        playing: state.playing,
        loop: state.loop,
        positionSeconds: state.positionSeconds,
        groups: state.groups.map((group) => ({
          trackId: group.trackId,
          laneCount: group.laneCount,
          laneKeys: group.laneKeys,
        })),
        laneCount: state.lanes.length,
        laneDurationSeconds: state.lanes.map((lane) => lane.durationSeconds),
        crossfader: state.crossfader,
      };
    }

    function groupSpecs(baseUrl, names) {
      return ['A', 'B'].map((groupId) => ({
        trackId: groupId,
        title: `Bank ${groupId}`,
        lanes: names.map((name) => ({
          name,
          label: name,
          audioUrl: `${baseUrl}/${groupId}/${name}.wav`,
          method: 'demucs',
          modelName: 'htdemucs@4.1.0',
          device: 'cuda',
        })),
      }));
    }

    /**
     * One complete render.  `stop` issues the production Stop during the
     * suspend() wake at STOP_AT; `suspend` schedules the same wake but never
     * calls Stop (the control that proves the measurement seam itself does not
     * silence the render); `replay` calls the production Play again from the
     * stopped desk before rendering resumes.  `muted` is a list of lane keys to
     * mute (both banks stay loaded, so the crossfader stays active).
     */
    async function renderScenario({ stop = false, suspend = false, replay = false, muted = [] } = {}) {
      const ctx = new OfflineAudioContext(2, Math.round(RATE * RENDER_SECONDS), RATE);
      const desk = new StemDesk({ audioContext: ctx, fetchImpl: (url) => fetch(url) });
      const groups = groupSpecs(baseUrl, names);
      const loaded = await desk.loadGroups(groups);
      if (loaded.status !== 'ready' || loaded.lanes.length !== names.length * 2) {
        throw new Error(`load failed: ${JSON.stringify(loaded.error ?? loaded.status)}`);
      }
      for (const key of muted) desk.setMuted(key, true);
      desk.setCrossfader(50);

      const started = desk.play({ loop: false });
      // The public state reports lane durations but not the decoded buffers.
      // The desk's own byte accounting and lane buffers are the direct
      // evidence that Stop retained (or failed to retain) decoded audio; the
      // existing for_your_ears_audio.js harness reads the same accounting.
      const decodedBefore = desk._decodedBytes;
      const buffersBefore = desk._lanes.filter((lane) => lane.buffer && lane.buffer.length > 0).length;

      let atStop = null;
      let stopError = null;
      let stateBeforeStop = null;
      let stateAfterStop = null;
      let stateAfterReplay = null;

      let suspension = null;
      if (stop || suspend) {
        suspension = ctx.suspend(STOP_AT).then(async () => {
          atStop = ctx.currentTime;
          try {
            stateBeforeStop = desk.state();
            if (stop) {
              stateAfterStop = desk.stop();
              if (replay) {
                desk.play({ loop: false });
                stateAfterReplay = desk.state();
              }
            }
          } catch (err) {
            stopError = String((err && err.message) || err);
          } finally {
            // A throwing scenario must never deadlock the render.
            await ctx.resume();
          }
        });
      }

      const rendered = await ctx.startRendering();
      if (suspension) await suspension;

      const channels = [];
      for (let c = 0; c < rendered.numberOfChannels; c += 1) channels.push(rendered.getChannelData(c));
      const stateEnd = desk.state();
      const decodedAfter = desk._decodedBytes;
      const buffersAfter = desk._lanes.filter((lane) => lane.buffer && lane.buffer.length > 0).length;
      desk.dispose();

      return {
        atStop,
        stopError,
        loadedLanes: loaded.lanes.map((lane) => ({
          key: lane.key,
          rmsDb: lane.rmsDb,
          durationSeconds: lane.durationSeconds,
        })),
        started: compactState(started),
        stateBeforeStop: stateBeforeStop ? compactState(stateBeforeStop) : null,
        stateAfterStop: stateAfterStop ? compactState(stateAfterStop) : null,
        stateAfterReplay: stateAfterReplay ? compactState(stateAfterReplay) : null,
        stateEnd: compactState(stateEnd),
        decodedBefore,
        decodedAfter,
        buffersBefore,
        buffersAfter,
        channels,
      };
    }

    const B_KEYS = names.map((name) => `B:${name}`);
    const A_KEYS = names.map((name) => `A:${name}`);

    const bothStop = await renderScenario({ stop: true });
    const bothControl = await renderScenario({ suspend: true });
    const bankAOnly = await renderScenario({ stop: true, muted: B_KEYS });
    const bankBOnly = await renderScenario({ stop: true, muted: A_KEYS });
    const bothReplay = await renderScenario({ stop: true, replay: true });

    // Frame-align the measured stop time so every window is an integer frame
    // index, independent of the float representation of currentTime.
    const stopSeconds = Math.round(bothStop.atStop * RATE) / RATE;
    const preFrom = 0.2;
    // Include the last frame before the Stop, so audibility is proven right up
    // to the moment the Stop is issued.
    const preTo = stopSeconds - 1 / RATE;
    const stopFrame = Math.round(stopSeconds * RATE);
    // The Web Audio unit of work is a 128-frame render quantum.  Silence is
    // asserted from the end of the quantum in which Stop lands; the first
    // quantum is reported separately in the detail.  This is a justified
    // 2.9 ms allowance, not a 100 ms hiding gap.
    const postFrom = (stopFrame + 128) / RATE;
    const postTo = RENDER_SECONDS - 0.1;
    const replayFrom = stopSeconds + 0.1;
    const shiftFrames = stopFrame;

    bothStop.pre = windowMetrics(bothStop.channels, preFrom, preTo);
    bothStop.post = windowMetrics(bothStop.channels, postFrom, postTo);
    bothStop.immediateAfterStop = windowMetrics(bothStop.channels, stopSeconds, postFrom);
    bothControl.pre = windowMetrics(bothControl.channels, preFrom, preTo);
    bothControl.post = windowMetrics(bothControl.channels, postFrom, postTo);
    bankAOnly.pre = windowMetrics(bankAOnly.channels, preFrom, preTo);
    bankAOnly.post = windowMetrics(bankAOnly.channels, postFrom, postTo);
    bankBOnly.pre = windowMetrics(bankBOnly.channels, preFrom, preTo);
    bankBOnly.post = windowMetrics(bankBOnly.channels, postFrom, postTo);
    bothReplay.pre = windowMetrics(bothReplay.channels, preFrom, preTo);
    bothReplay.replayed = windowMetrics(bothReplay.channels, replayFrom, postTo);

    const preIdentical = maxAbsDiff(bothStop.channels, bothControl.channels, 0, stopSeconds);
    const replayIdentical = maxAbsDiff(bothReplay.channels, bothControl.channels,
      stopSeconds + 0.06, postTo, shiftFrames);

    // A short dump at the boundary, so a failure shows the last audible
    // samples and the first samples after the Stop.
    const boundary = { lastPreStop: [], firstAfterStop: [] };
    for (let c = 0; c < bothStop.channels.length; c += 1) {
      boundary.lastPreStop.push(Array.from(
        bothStop.channels[c].slice(stopFrame - 8, stopFrame),
      ).map((v) => Number(v.toFixed(9))));
      boundary.firstAfterStop.push(Array.from(
        bothStop.channels[c].slice(stopFrame, stopFrame + 8),
      ).map((v) => Number(v.toFixed(9))));
    }

    // ---- assertions -------------------------------------------------------

    add('two banks are loaded and playing when Stop is issued',
      bothStop.stopError === null
        && Math.round(bothStop.atStop * RATE) === STOP_FRAME
        && bothStop.stateBeforeStop?.playing === true
        && bothStop.stateBeforeStop?.status === 'playing'
        && bothStop.stateBeforeStop.groups.length === 2
        && bothStop.stateBeforeStop.laneCount === names.length * 2
        && Math.abs(bothStop.stateBeforeStop.positionSeconds - (STOP_AT - STEM_DESK_LIMITS.startLeadSeconds)) < 1e-3,
      {
        atStopSeconds: bothStop.atStop,
        expectedStopSeconds: STOP_AT,
        stopError: bothStop.stopError,
        status: bothStop.stateBeforeStop?.status,
        playing: bothStop.stateBeforeStop?.playing,
        positionSeconds: bothStop.stateBeforeStop?.positionSeconds,
        expectedPositionSeconds: STOP_AT - STEM_DESK_LIMITS.startLeadSeconds,
        groups: bothStop.stateBeforeStop?.groups.map((g) => g.trackId),
        laneCount: bothStop.stateBeforeStop?.laneCount,
      });

    add('all eight decoded lanes carry musical signal',
      bothStop.loadedLanes.length === names.length * 2
        && bothStop.loadedLanes.every((lane) => lane.rmsDb > STEM_DESK_LIMITS.silentRmsDb),
      {
        labels: bothStop.loadedLanes.map((lane) => lane.key),
        rmsDb: Object.fromEntries(bothStop.loadedLanes.map((lane) => [lane.key, lane.rmsDb])),
        thresholdRmsDb: STEM_DESK_LIMITS.silentRmsDb,
      });

    add('both banks produce non-silent PCM before Stop',
      bothStop.pre.rmsDb > AUDIBLE_RMS_DB
        && bothStop.pre.peak > AUDIBLE_PEAK
        && bothStop.pre.nonSilent > 0,
      { ...bothStop.pre, thresholdRmsDb: AUDIBLE_RMS_DB, thresholdPeak: AUDIBLE_PEAK });

    add('bank A alone is non-silent before Stop (bank B muted, both banks loaded)',
      bankAOnly.pre.rmsDb > AUDIBLE_RMS_DB && bankAOnly.pre.peak > AUDIBLE_PEAK,
      { ...bankAOnly.pre, thresholdRmsDb: AUDIBLE_RMS_DB });

    add('bank B alone is non-silent before Stop (bank A muted, both banks loaded)',
      bankBOnly.pre.rmsDb > AUDIBLE_RMS_DB && bankBOnly.pre.peak > AUDIBLE_PEAK,
      { ...bankBOnly.pre, thresholdRmsDb: AUDIBLE_RMS_DB });

    add('Stop after real playback produces digital silence',
      bothStop.stopError === null
        && bothStop.post.peak <= SILENCE_PEAK
        && bothStop.post.nonSilent === 0
        && bothStop.stateAfterStop?.playing === false
        && bothStop.stateAfterStop?.status === 'ready',
      {
        ...bothStop.post,
        thresholdPeak: SILENCE_PEAK,
        firstRenderQuantumAfterStop: bothStop.immediateAfterStop,
        status: bothStop.stateAfterStop?.status,
        playing: bothStop.stateAfterStop?.playing,
        boundary,
      });

    add('a control run without Stop stays audible over the same interval',
      bothControl.stopError === null
        && Math.round(bothControl.atStop * RATE) === STOP_FRAME
        && bothControl.stateAfterStop === null
        && bothControl.post.rmsDb > AUDIBLE_RMS_DB
        && bothControl.post.peak > AUDIBLE_PEAK
        && bothControl.stateEnd.status === 'playing'
        && bothControl.stateEnd.positionSeconds > STOP_AT,
      {
        ...bothControl.post,
        thresholdRmsDb: AUDIBLE_RMS_DB,
        suspendWakeSeconds: bothControl.atStop,
        stopped: bothControl.stateAfterStop !== null,
        endStatus: bothControl.stateEnd.status,
        endPositionSeconds: bothControl.stateEnd.positionSeconds,
      });

    add('Stop changes only the post-Stop interval: pre-Stop PCM is identical to the control',
      preIdentical.compared > 0
        && preIdentical.maxAbsDiff <= IDENTICAL
        && Math.abs(bothStop.pre.rmsDb - bothControl.pre.rmsDb) < 1e-6,
      { ...preIdentical, threshold: IDENTICAL, stopRmsDb: bothStop.pre.rmsDb, controlRmsDb: bothControl.pre.rmsDb });

    const afterStop = bothStop.stateAfterStop;
    add('Stop retains both loaded banks and every decoded buffer',
      afterStop !== null
        && afterStop.groups.length === 2
        && afterStop.groups.map((g) => g.trackId).sort().join(',') === 'A,B'
        && afterStop.groups.every((g) => g.laneCount === names.length)
        && afterStop.laneCount === names.length * 2
        && afterStop.laneDurationSeconds.every((seconds) => seconds > 0)
        && bothStop.decodedBefore > 0
        && bothStop.decodedAfter === bothStop.decodedBefore
        && bothStop.buffersBefore === names.length * 2
        && bothStop.buffersAfter === names.length * 2,
      {
        groups: afterStop?.groups,
        laneCount: afterStop?.laneCount,
        decodedBefore: bothStop.decodedBefore,
        decodedAfter: bothStop.decodedAfter,
        buffersBefore: bothStop.buffersBefore,
        buffersAfter: bothStop.buffersAfter,
      });

    add('a stopped desk plays both banks again and the replay matches the programme start',
      bothReplay.stopError === null
        && bothReplay.stateAfterReplay?.status === 'playing'
        && bothReplay.stateAfterReplay?.playing === true
        && bothReplay.stateAfterReplay.groups.length === 2
        && bothReplay.stateAfterReplay.laneCount === names.length * 2
        && bothReplay.replayed.rmsDb > AUDIBLE_RMS_DB
        && bothReplay.replayed.peak > AUDIBLE_PEAK
        && replayIdentical.compared > 0
        && replayIdentical.maxAbsDiff <= IDENTICAL,
      {
        replayed: bothReplay.replayed,
        thresholdRmsDb: AUDIBLE_RMS_DB,
        replayVsControl: replayIdentical,
        threshold: IDENTICAL,
        status: bothReplay.stateAfterReplay?.status,
        groups: bothReplay.stateAfterReplay?.groups.map((g) => g.trackId),
        laneCount: bothReplay.stateAfterReplay?.laneCount,
      });

    const strip = (scenario) => ({
      atStopSeconds: scenario.atStop,
      stopError: scenario.stopError,
      loadedLanes: scenario.loadedLanes,
      pre: scenario.pre,
      post: scenario.post,
      immediateAfterStop: scenario.immediateAfterStop ?? null,
      replayed: scenario.replayed ?? null,
      stateBeforeStop: scenario.stateBeforeStop,
      stateAfterStop: scenario.stateAfterStop,
      stateAfterReplay: scenario.stateAfterReplay,
      stateEnd: scenario.stateEnd,
      decodedBefore: scenario.decodedBefore,
      decodedAfter: scenario.decodedAfter,
      buffersBefore: scenario.buffersBefore,
      buffersAfter: scenario.buffersAfter,
    });

    for (const [name, scenario] of Object.entries({
      bothStop, bothControl, bankAOnly, bankBOnly, bothReplay,
    })) scenarios[name] = strip(scenario);

    return {
      rate: RATE,
      renderSeconds: RENDER_SECONDS,
      stopFrame: STOP_FRAME,
      stopSeconds: STOP_AT,
      thresholds: {
        audibleRmsDb: AUDIBLE_RMS_DB,
        audiblePeak: AUDIBLE_PEAK,
        silencePeak: SILENCE_PEAK,
        identical: IDENTICAL,
      },
      windows: { pre: [preFrom, preTo], post: [postFrom, postTo], replay: [replayFrom, postTo] },
      boundaries: boundary,
      preStopIdentical: preIdentical,
      replayIdentical,
      checks,
      scenarios,
    };
  }, { runtimeSource: source, crossfaderSource, baseUrl: base, names: NAMES });

  mkdirSync(outDir, { recursive: true });
  const receipt = {
    generatedFixture: fixtureRoot,
    stemsA,
    stemsB,
    keepFixture,
    result,
  };
  writeFileSync(path.join(outDir, 'stem-desk-stop-regression.json'), JSON.stringify(receipt, null, 2));

  for (const entry of result.checks) {
    const detail = entry.detail === undefined ? '' : ` — ${JSON.stringify(entry.detail)}`;
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${detail}`);
  }
  const failed = result.checks.filter((entry) => !entry.ok);
  console.log(`\n${result.checks.length - failed.length}/${result.checks.length} two-bank Stop checks passed`);
  if (failed.length) {
    console.log('\nDiagnostics (all scenarios):');
    console.log(JSON.stringify(result.scenarios, null, 2));
  }
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.close();
  if (fixtureRoot && !keepFixture) rmSync(fixtureRoot, { recursive: true, force: true });
}
