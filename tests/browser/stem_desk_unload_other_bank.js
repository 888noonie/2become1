#!/usr/bin/env node
// tests/browser/stem_desk_unload_other_bank.js — real-runtime PCM regression:
// unloading bank B must leave bank A's settings and decoded audio intact.
//
// Why this exists
// ---------------
// Codex commit 7bdc78d ("Expose per-bank stem unload in the Performance Desk")
// documents the invariant: "The other bank keeps its stems, mute, solo, gain,
// level and entry offset."  The existing automated checks are:
//
//   * tests/frontend/stem-desk-panel.test.js — the Unload B button preserves
//     A's level, entry offset and lane flags, but on FakeDesk (UI wiring);
//   * tests/frontend/runtime/stem-desk.test.js — the real StemDesk keeps the
//     surviving group's keys and decoded bytes, but sets no mixer settings;
//   * tests/browser/stem_desk_two_track_ux.js — the real page keeps an A mute
//     and one A gain slider in the DOM, but not level, entry, solo, buffers or
//     rendered audio.
//
// This harness closes that gap on the REAL StemDesk with decoded musical PCM:
//
//   1. load A and B, set A's track level, entry nudge, lane gain, mute and
//      solo (and deliberately different B settings);
//   2. unload B during playback through desk.unloadGroup(), the runtime call
//      the panel makes;
//   3. assert A's settings, group object, decoded-byte accounting and four
//      attached buffers survive, B is gone, and B's bytes are freed;
//   4. play A again after the unload and compare its rendered PCM, sample for
//      sample, with a reference A-only desk carrying the same settings.
//
// Two scenarios: A vocals soloed (solo is audible), and no solo with A drums
// muted and A bass cut (mute and lane gain are audible).
//
// A disposable negative control (resetting A's settings inside unloadGroup)
// must fail the retention checks; it is described in the Act III-C receipt and
// is not committed.
//
// Usage:
//   node tests/browser/stem_desk_unload_other_bank.js
//   node tests/browser/stem_desk_unload_other_bank.js \
//     --stemsA <four-stem dir> --stemsB <four-stem dir> [--out <dir>]
//
// With no stems supplied, the harness builds the short two-bank fixture with
// tests/browser/first_mix_stop_fixture.py (the established FOR YOUR EARS
// synthesis, eight chorus-forward bars, inside the ordinary 40 MiB ceiling).
//
// Output: tests/browser/artifacts/stem-desk-unload-other-bank.json
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
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'first-mix-unload-'));
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
    const { StemDesk } = await import(moduleUrl);

    const RATE = 44100;
    const RENDER_SECONDS = 3.4;
    // 172 render quanta of 128 frames: an exact, browser-agreed unload time.
    const UNLOAD_FRAME = 22016;
    const UNLOAD_AT = UNLOAD_FRAME / RATE;
    // The survivor replays at atUnload + startLead + entry nudge; the
    // reference starts at startLead + entry nudge.  Both are compared from
    // 0.2 s after their nominal time, i.e. 0.03 s into the audible material.
    const COMPARE_FROM_SECONDS = 0.2;
    const COMPARE_TO_SECONDS = RENDER_SECONDS - 0.1;
    const SURVIVOR_COMPARE_FROM = UNLOAD_AT + COMPARE_FROM_SECONDS;
    const COMPARE_DURATION = COMPARE_TO_SECONDS - SURVIVOR_COMPARE_FROM;
    const AUDIBLE_RMS_DB = -45;
    const IDENTICAL = 1e-5;

    const A_LEVEL_DB = -6;
    const A_ENTRY_MS = 120;
    const A_BASS_DB = -12;
    const B_LEVEL_DB = -3;
    const B_BASS_DB = -9;

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
      for (const channel of channels) {
        for (let i = from; i < to; i += 1) {
          const value = channel[i];
          const absolute = Math.abs(value);
          if (absolute > peak) peak = absolute;
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
      };
    }

    /** Max |a[fromA + i] - b[fromB + i]| over `frames` two-channel frames. */
    function compareShifted(a, b, fromA, fromB, frames) {
      const startA = Math.max(0, Math.round(fromA));
      const startB = Math.max(0, Math.round(fromB));
      const count = Math.min(frames, a[0].length - startA, b[0].length - startB);
      let max = 0;
      let compared = 0;
      for (let c = 0; c < Math.min(a.length, b.length); c += 1) {
        for (let i = 0; i < count; i += 1) {
          const difference = Math.abs(a[c][startA + i] - b[c][startB + i]);
          if (difference > max) max = difference;
          compared += 1;
        }
      }
      return { maxAbsDiff: max, compared };
    }

    function groupSpecs(baseUrl, ids) {
      return ids.map((groupId) => ({
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

    function settingsOf(state, trackId) {
      const group = state.groups.find((entry) => entry.trackId === trackId) || null;
      return group ? {
        levelDb: group.levelDb,
        entryOffsetMs: group.entryOffsetMs,
        gain: group.gain,
        lanes: state.lanes
          .filter((lane) => lane.trackId === trackId)
          .map((lane) => ({
            key: lane.key,
            gainDb: lane.gainDb,
            muted: lane.muted,
            solo: lane.solo,
            durationSeconds: lane.durationSeconds,
          })),
      } : null;
    }

    function compactState(state) {
      return {
        status: state.status,
        playing: state.playing,
        positionSeconds: state.positionSeconds,
        crossfader: state.crossfader,
        groups: state.groups.map((group) => ({
          trackId: group.trackId,
          levelDb: group.levelDb,
          entryOffsetMs: group.entryOffsetMs,
          gain: group.gain,
          laneCount: group.laneCount,
          laneKeys: group.laneKeys,
        })),
        lanes: state.lanes.map((lane) => ({
          key: lane.key,
          trackId: lane.trackId,
          gainDb: lane.gainDb,
          muted: lane.muted,
          solo: lane.solo,
          durationSeconds: lane.durationSeconds,
        })),
      };
    }

    function applyASettings(desk, settings) {
      desk.setTrackLevel('A', settings.levelDb);
      desk.setGroupEntryOffset('A', settings.entryOffsetMs);
      for (const [key, value] of Object.entries(settings.gains)) desk.setGain(key, value);
      for (const key of settings.muted) desk.setMuted(key, true);
      for (const key of settings.solo) desk.setSolo(key, true);
    }

    function applyBSettings(desk) {
      desk.setTrackLevel('B', B_LEVEL_DB);
      desk.setGain('B:bass', B_BASS_DB);
      desk.setMuted('B:drums', true);
    }

    async function loadDesk(ctx, ids) {
      const desk = new StemDesk({ audioContext: ctx, fetchImpl: (url) => fetch(url) });
      const loaded = await desk.loadGroups(groupSpecs(baseUrl, ids));
      if (loaded.status !== 'ready' || loaded.lanes.length !== ids.length * names.length) {
        throw new Error(`load failed: ${JSON.stringify(loaded.error ?? loaded.status)}`);
      }
      return desk;
    }

    /** A-only desk carrying the same settings: the expected PCM after unload. */
    async function renderReference(settings) {
      const ctx = new OfflineAudioContext(2, Math.round(RATE * RENDER_SECONDS), RATE);
      const desk = await loadDesk(ctx, ['A']);
      applyASettings(desk, settings);
      const aBytes = desk._decodedBytes;
      const started = desk.play({ loop: false });
      const rendered = await ctx.startRendering();
      const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
      const state = desk.state();
      desk.dispose();
      return {
        aBytes,
        started: compactState(started),
        state: compactState(state),
        settings: settingsOf(state, 'A'),
        pre: windowMetrics(channels, COMPARE_FROM_SECONDS, COMPARE_FROM_SECONDS + COMPARE_DURATION),
        channels,
      };
    }

    /**
     * A+B desk with A settings applied, played, then B unloaded at UNLOAD_FRAME
     * through the production runtime call the panel makes.  A is played again
     * before the render resumes, so the post-unload audio is real PCM.
     */
    async function renderSurvivor(settings) {
      const ctx = new OfflineAudioContext(2, Math.round(RATE * RENDER_SECONDS), RATE);
      const desk = await loadDesk(ctx, ['A', 'B']);
      applyASettings(desk, settings);
      applyBSettings(desk);

      const beforeUnload = desk.state();
      const bytesBefore = desk._decodedBytes;
      const bBytes = beforeUnload.lanes
        .filter((lane) => lane.trackId === 'B')
        .reduce((total, lane) => total + lane.durationSeconds * RATE * 2 * 4, 0);
      const aGroupBefore = desk._groups.find((group) => group.trackId === 'A');
      const aBuffersBefore = aGroupBefore.lanes.map((lane) => lane.buffer);
      const aLaneKeysBefore = aGroupBefore.lanes.map((lane) => lane.key);

      desk.play({ loop: false });

      let atUnload = null;
      let afterUnload = null;
      let replayState = null;
      let unloadError = null;
      let aGroupAfter = null;
      let aBuffersAfter = null;
      let bytesAfterUnload = null;
      let buffersAfterUnload = null;

      const suspension = ctx.suspend(UNLOAD_AT).then(async () => {
        atUnload = ctx.currentTime;
        try {
          afterUnload = desk.unloadGroup('B');
          aGroupAfter = desk._groups.find((group) => group.trackId === 'A');
          aBuffersAfter = aGroupAfter ? aGroupAfter.lanes.map((lane) => lane.buffer) : [];
          bytesAfterUnload = desk._decodedBytes;
          buffersAfterUnload = desk._lanes
            .filter((lane) => lane.buffer && lane.buffer.length > 0).length;
          replayState = desk.play({ loop: false });
        } catch (err) {
          unloadError = String((err && err.message) || err);
        } finally {
          await ctx.resume();
        }
      });

      const rendered = await ctx.startRendering();
      await suspension;

      const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
      const endState = desk.state();
      const bytesEnd = desk._decodedBytes;
      desk.dispose();

      return {
        atUnload,
        unloadError,
        beforeUnload: compactState(beforeUnload),
        afterUnload: afterUnload ? compactState(afterUnload) : null,
        replayState: replayState ? compactState(replayState) : null,
        endState: compactState(endState),
        aSettingsBefore: settingsOf(beforeUnload, 'A'),
        aSettingsAfter: afterUnload ? settingsOf(afterUnload, 'A') : null,
        bSettingsBefore: settingsOf(beforeUnload, 'B'),
        bytesBefore,
        bBytes,
        bytesAfterUnload,
        bytesEnd,
        buffersAfterUnload,
        aGroupSameObject: aGroupAfter !== null && aGroupAfter === aGroupBefore,
        aBuffersSameObjects: aBuffersAfter !== null
          && aBuffersAfter.length === aBuffersBefore.length
          && aBuffersBefore.every((buffer, index) => buffer === aBuffersAfter[index]),
        aBuffersAttached: aBuffersAfter !== null
          && aBuffersAfter.length === names.length
          && aBuffersAfter.every((buffer) => buffer && buffer.length > 0),
        aLaneKeysBefore,
        pre: windowMetrics(channels, SURVIVOR_COMPARE_FROM, COMPARE_TO_SECONDS),
        channels,
      };
    }

    const SCENARIOS = {
      soloVocals: {
        label: 'A vocals soloed',
        settings: {
          levelDb: A_LEVEL_DB,
          entryOffsetMs: A_ENTRY_MS,
          gains: { 'A:bass': A_BASS_DB },
          muted: ['A:drums'],
          solo: ['A:vocals'],
        },
      },
      muteAndGain: {
        label: 'A drums muted, bass cut, no solo',
        settings: {
          levelDb: A_LEVEL_DB,
          entryOffsetMs: A_ENTRY_MS,
          gains: { 'A:bass': A_BASS_DB },
          muted: ['A:drums'],
          solo: [],
        },
      },
    };

    for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
      const settings = scenario.settings;
      const reference = await renderReference(settings);
      const survivor = await renderSurvivor(settings);
      const label = scenario.label;

      const compareFromA = UNLOAD_FRAME + Math.round(COMPARE_FROM_SECONDS * RATE);
      const compareFromB = Math.round(COMPARE_FROM_SECONDS * RATE);
      const compareFrames = Math.round(COMPARE_TO_SECONDS * RATE) - compareFromA;
      const pcmIdentity = compareShifted(
        survivor.channels, reference.channels, compareFromA, compareFromB, compareFrames,
      );

      const laneSettings = (entry) => Object.fromEntries(
        (entry?.lanes || []).map((lane) => [lane.key, {
          gainDb: lane.gainDb, muted: lane.muted, solo: lane.solo,
        }]),
      );
      const beforeLanes = laneSettings(survivor.aSettingsBefore);
      const afterLanes = laneSettings(survivor.aSettingsAfter);
      const lanesRetained = survivor.aLaneKeysBefore.length === names.length
        && survivor.aLaneKeysBefore.every((key) => afterLanes[key])
        && JSON.stringify(afterLanes) === JSON.stringify(beforeLanes);

      const groupGainExpected = Math.pow(10, A_LEVEL_DB / 20);

      add(`${label}: both banks and A's settings are in place before unload`,
        Math.round(survivor.atUnload * RATE) === UNLOAD_FRAME
          && survivor.beforeUnload.groups.length === 2
          && survivor.beforeUnload.lanes.length === names.length * 2
          && survivor.aSettingsBefore?.levelDb === A_LEVEL_DB
          && survivor.aSettingsBefore?.entryOffsetMs === A_ENTRY_MS
          && survivor.bSettingsBefore?.levelDb === B_LEVEL_DB
          && survivor.bSettingsBefore?.lanes.length === names.length,
        {
          atUnloadSeconds: survivor.atUnload,
          groups: survivor.beforeUnload.groups.map((group) => group.trackId),
          laneCount: survivor.beforeUnload.lanes.length,
          aSettings: survivor.aSettingsBefore,
          bSettings: survivor.bSettingsBefore,
        });

      add(`${label}: unload B keeps A's track level, entry nudge and effective gain`,
        survivor.unloadError === null
          && survivor.afterUnload !== null
          && survivor.afterUnload.groups.length === 1
          && survivor.afterUnload.groups[0].trackId === 'A'
          && survivor.aSettingsAfter?.levelDb === A_LEVEL_DB
          && survivor.aSettingsAfter?.entryOffsetMs === A_ENTRY_MS
          && survivor.afterUnload.crossfader.disabled === true
          && survivor.afterUnload.crossfader.gainA === 1
          && Math.abs(survivor.aSettingsAfter.gain - groupGainExpected) < 1e-9,
        {
          levelDb: survivor.aSettingsAfter?.levelDb,
          entryOffsetMs: survivor.aSettingsAfter?.entryOffsetMs,
          groupGain: survivor.aSettingsAfter?.gain,
          expectedGroupGain: groupGainExpected,
          crossfader: survivor.afterUnload?.crossfader,
        });

      add(`${label}: unload B keeps A's lane mute, solo and gain`,
        lanesRetained,
        { before: beforeLanes, after: afterLanes });

      add(`${label}: unload B frees exactly B's bytes and keeps A's four buffers`,
        survivor.bytesAfterUnload === survivor.bytesBefore - survivor.bBytes
          && survivor.bytesAfterUnload === reference.aBytes
          && survivor.buffersAfterUnload === names.length
          && survivor.aGroupSameObject === true
          && survivor.aBuffersSameObjects === true
          && survivor.aBuffersAttached === true,
        {
          bytesBefore: survivor.bytesBefore,
          bBytes: survivor.bBytes,
          bytesAfterUnload: survivor.bytesAfterUnload,
          referenceABytes: reference.aBytes,
          buffersAfterUnload: survivor.buffersAfterUnload,
          aGroupSameObject: survivor.aGroupSameObject,
          aBuffersSameObjects: survivor.aBuffersSameObjects,
          aBuffersAttached: survivor.aBuffersAttached,
        });

      add(`${label}: B is not restored by the unload or the replay`,
        survivor.endState.groups.length === 1
          && survivor.endState.groups[0].trackId === 'A'
          && survivor.endState.lanes.length === names.length
          && survivor.endState.lanes.every((lane) => lane.trackId === 'A')
          && survivor.bytesEnd === survivor.bytesAfterUnload,
        {
          groups: survivor.endState.groups.map((group) => group.trackId),
          lanes: survivor.endState.lanes.map((lane) => lane.key),
          bytesAfterUnload: survivor.bytesAfterUnload,
          bytesEnd: survivor.bytesEnd,
        });

      add(`${label}: A replays after unload and the PCM matches the A-only reference`,
        survivor.replayState?.playing === true
          && survivor.replayState?.status === 'playing'
          && survivor.pre.rmsDb > AUDIBLE_RMS_DB
          && pcmIdentity.compared > 0
          && pcmIdentity.maxAbsDiff <= IDENTICAL
          && Math.abs(survivor.pre.rmsDb - reference.pre.rmsDb) < 0.05,
        {
          replayed: survivor.pre,
          reference: reference.pre,
          pcmIdentity,
          threshold: IDENTICAL,
          status: survivor.replayState?.status,
        });

      scenarios[scenarioName] = {
        label,
        settings,
        reference: {
          aBytes: reference.aBytes,
          started: reference.started,
          state: reference.state,
          settings: reference.settings,
          pre: reference.pre,
        },
        survivor: {
          atUnload: survivor.atUnload,
          unloadError: survivor.unloadError,
          beforeUnload: survivor.beforeUnload,
          afterUnload: survivor.afterUnload,
          replayState: survivor.replayState,
          endState: survivor.endState,
          aSettingsBefore: survivor.aSettingsBefore,
          aSettingsAfter: survivor.aSettingsAfter,
          bSettingsBefore: survivor.bSettingsBefore,
          bytesBefore: survivor.bytesBefore,
          bBytes: survivor.bBytes,
          bytesAfterUnload: survivor.bytesAfterUnload,
          bytesEnd: survivor.bytesEnd,
          buffersAfterUnload: survivor.buffersAfterUnload,
          aGroupSameObject: survivor.aGroupSameObject,
          aBuffersSameObjects: survivor.aBuffersSameObjects,
          aBuffersAttached: survivor.aBuffersAttached,
          pre: survivor.pre,
        },
        pcmIdentity,
      };
    }

    return {
      rate: RATE,
      renderSeconds: RENDER_SECONDS,
      unloadFrame: UNLOAD_FRAME,
      unloadSeconds: UNLOAD_AT,
      thresholds: { audibleRmsDb: AUDIBLE_RMS_DB, identical: IDENTICAL },
      scenarios,
      checks,
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
  writeFileSync(path.join(outDir, 'stem-desk-unload-other-bank.json'), JSON.stringify(receipt, null, 2));

  for (const entry of result.checks) {
    const detail = entry.detail === undefined ? '' : ` — ${JSON.stringify(entry.detail)}`;
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${detail}`);
  }
  const failed = result.checks.filter((entry) => !entry.ok);
  console.log(`\n${result.checks.length - failed.length}/${result.checks.length} unload-other-bank checks passed`);
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
