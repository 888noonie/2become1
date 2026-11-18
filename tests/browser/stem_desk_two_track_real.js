#!/usr/bin/env node
// tests/browser/stem_desk_two_track_real.js — render two real separated tracks
// through the real two-group StemDesk runtime.
//
// Usage:
//   node tests/browser/stem_desk_two_track_real.js \
//     --stemsA <dir> --stemsB <dir> [--ids <ids.json>] [--out <dir>]
//
// STEMS_A, STEMS_B and IDS_PATH are accepted as environment fallbacks (useful
// with `node --env-file=... --test` where the test runner owns argv).
//
// Each directory must contain vocals.wav, drums.wav, bass.wav and other.wav.
// This is a demonstration/release gate, not part of the default unit suite.

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'src', 'twobecomeone', 'studio_static', 'js', 'runtime', 'stem-desk.js');
const CROSSFADER = path.join(ROOT, 'src', 'twobecomeone', 'studio_static', 'js', 'runtime', 'crossfader.js');
const NAMES = ['vocals', 'drums', 'bass', 'other'];

const value = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const stemsA = value('--stemsA', process.env.STEMS_A || null);
const stemsB = value('--stemsB', process.env.STEMS_B || null);
const idsPath = value('--ids', process.env.IDS_PATH || null);
const outDir = path.resolve(value('--out', path.join(ROOT, 'tests', 'browser', 'artifacts')));
if (!stemsA || !stemsB) {
  console.error('usage: node tests/browser/stem_desk_two_track_real.js --stemsA <dir> --stemsB <dir> [--ids <ids.json>] [--out <dir>]');
  process.exit(2);
}

/** Find a stem WAV either directly in `dir` or in one level of stem-set subdirs. */
function findStemFile(dir, name) {
  const direct = path.join(dir, `${name}.wav`);
  if (existsSync(direct)) return direct;
  const pending = [dir];
  while (pending.length) {
    const current = pending.shift();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (entry.name === `${name}.wav`) return path.join(current, entry.name);
    }
  }
  return null;
}

const files = { A: {}, B: {} };
for (const [groupId, dir] of [['A', stemsA], ['B', stemsB]]) {
  for (const name of NAMES) {
    const file = findStemFile(dir, name);
    if (!file) {
      console.error(`missing stem file: ${name}.wav under ${dir}`);

      process.exit(2);
    }
    files[groupId][name] = readFileSync(file);
  }
}

const ids = idsPath && existsSync(idsPath) ? JSON.parse(readFileSync(idsPath, 'utf8')) : null;

const server = http.createServer((req, res) => {
  const [groupId, file] = (req.url || '').split('?')[0].replace(/^\//, '').split('/');
  const name = (file || '').replace('.wav', '');
  const body = files[groupId]?.[name];
  if (!body) {
    res.writeHead(404);
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
    const checks = [];

    function metrics(channels) {
      let peak = 0;
      let sum = 0;
      let count = 0;
      for (const channel of channels) {
        for (let i = 0; i < channel.length; i += 1) {
          const value = channel[i];
          const absolute = value < 0 ? -value : value;
          if (absolute > peak) peak = absolute;
          sum += value * value;
          count += 1;
        }
      }
      const rms = Math.sqrt(sum / count);
      return {
        peak,
        rms,
        peakDb: 20 * Math.log10(peak + 1e-12),
        rmsDb: 20 * Math.log10(rms + 1e-12),
      };
    }

    function compare(a, b) {
      let dot = 0;
      let aa = 0;
      let bb = 0;
      const length = Math.min(a[0].length, b[0].length);
      for (let c = 0; c < Math.min(a.length, b.length); c += 1) {
        for (let i = 0; i < length; i += 1) {
          dot += a[c][i] * b[c][i];
          aa += a[c][i] * a[c][i];
          bb += b[c][i] * b[c][i];
        }
      }
      return {
        correlation: dot / (Math.sqrt(aa * bb) + 1e-24),
        rmsRatio: Math.sqrt(bb / (aa + 1e-24)),
      };
    }

    function tailPeak(channels, fromSeconds) {
      let peak = 0;
      const from = Math.round(RATE * fromSeconds);
      for (const channel of channels) {
        for (let i = from; i < channel.length; i += 1) {
          const absolute = Math.abs(channel[i]);
          if (absolute > peak) peak = absolute;
        }
      }
      return peak;
    }

    async function render({
      crossfader = 50,
      muted = [],
      solo = [],
      onlyA = false,
      seconds = 4,
      offset = 0,
    } = {}) {
      const ctx = new OfflineAudioContext(2, Math.round(RATE * seconds), RATE);
      const desk = new StemDesk({ audioContext: ctx, fetchImpl: (url) => fetch(url) });
      const groupIds = onlyA ? ['A'] : ['A', 'B'];
      const loaded = await desk.loadGroups(groupIds.map((groupId) => ({
        trackId: groupId,
        title: `Set ${groupId}`,
        lanes: names.map((name) => ({
          name,
          label: name,
          audioUrl: `${baseUrl}/${groupId}/${name}.wav`,
          method: 'demucs',
          modelName: 'htdemucs@4.1.0',
          device: 'cuda',
        })),
      })));
      if (loaded.status !== 'ready' || loaded.lanes.length !== groupIds.length * names.length) {
        throw new Error(`load failed: ${JSON.stringify(loaded.error ?? loaded.status)}`);
      }
      for (const key of muted) desk.setMuted(key, true);
      for (const key of solo) desk.setSolo(key, true);
      desk.setCrossfader(crossfader);
      const started = desk.play({ loop: false, offset });
      const rendered = await ctx.startRendering();
      const channels = [];
      for (let c = 0; c < rendered.numberOfChannels; c += 1) channels.push(rendered.getChannelData(c));
      const state = desk.state();
      desk.dispose();
      return {
        ...metrics(channels),
        channels,
        tail: tailPeak(channels, Math.max(0, seconds - 0.4)),
        status: state.status,
        playing: state.playing,
        loop: state.loop,
        lanes: state.lanes.length,
        groups: state.groups.map((group) => group.trackId),
        startedStatus: started.status,
      };
    }

    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    const B_KEYS = names.map((name) => `B:${name}`);
    const A_KEYS = names.map((name) => `A:${name}`);

    // Probe one real file so the end-of-programme render is long enough even
    // when the demonstration stems are not exactly twelve seconds.
    const probe = new OfflineAudioContext(1, 1, RATE);
    const probeBytes = await (await fetch(`${baseUrl}/A/vocals.wav`)).arrayBuffer();
    const programmeSeconds = (await probe.decodeAudioData(probeBytes)).duration;

    const aOnly = await render({ onlyA: true, solo: ['A:vocals'], crossfader: 0 });
    const twoGroupSolo = await render({ solo: ['A:vocals'], crossfader: 0 });
    const aGroup = await render({ muted: B_KEYS });
    const bGroup = await render({ muted: A_KEYS });
    const left = await render({ crossfader: 0 });
    const middle = await render({ crossfader: 50 });
    const right = await render({ crossfader: 100 });
    const ended = await render({ crossfader: 50, seconds: programmeSeconds + 0.7 });

    add('solo A vocals is audible across two real tracks',
      twoGroupSolo.rmsDb > STEM_DESK_LIMITS.silentRmsDb,
      { rmsDb: twoGroupSolo.rmsDb, peakDb: twoGroupSolo.peakDb });
    add('solo A vocals keeps the transport playing',
      twoGroupSolo.playing === true && twoGroupSolo.status === 'playing',
      { status: twoGroupSolo.status });

    const soloScopedToA = compare(twoGroupSolo.channels, aOnly.channels);
    add('soloing a lane in A suppresses every lane in B',
      soloScopedToA.correlation > 0.999 && Math.abs(soloScopedToA.rmsRatio - 1) < 0.01,
      soloScopedToA);

    // The group references were rendered at crossfader 50 (0.707), while the
    // hard-left/right renders use gain 1, so the expected ratio is sqrt(2).
    const leftVsA = compare(aGroup.channels, left.channels);
    add('crossfader 0 plays group A at full equal-power gain',
      leftVsA.correlation > 0.999 && Math.abs(leftVsA.rmsRatio - Math.SQRT2) < 0.03,
      leftVsA);

    const rightVsB = compare(bGroup.channels, right.channels);
    add('crossfader 100 plays group B at full equal-power gain',
      rightVsB.correlation > 0.999 && Math.abs(rightVsB.rmsRatio - Math.SQRT2) < 0.03,
      rightVsB);

    add('two real tracks at the crossfader midpoint do not clip',
      middle.peak < 1,
      { peak: middle.peak, peakDb: middle.peakDb, rmsDb: middle.rmsDb });
    add('two real tracks at the crossfader midpoint are not silent',
      middle.rmsDb > -40,
      { rmsDb: middle.rmsDb });

    add('the programme ends in silence and returns to ready',
      ended.tail < 1e-4 && ended.status === 'ready' && ended.playing === false && ended.loop === false,
      { tailPeak: ended.tail, status: ended.status, playing: ended.playing, loop: ended.loop });

    return {
      rate: RATE,
      lanes: names,
      scenarios: {
        aOnly: { rmsDb: aOnly.rmsDb },
        twoGroupSolo: { rmsDb: twoGroupSolo.rmsDb, status: twoGroupSolo.status },
        left: { rmsDb: left.rmsDb },
        middle: { rmsDb: middle.rmsDb, peak: middle.peak, peakDb: middle.peakDb },
        right: { rmsDb: right.rmsDb },
        ended: { tailPeak: ended.tail, status: ended.status },
      },
      checks,
    };
  }, { runtimeSource: source, crossfaderSource, baseUrl: base, names: NAMES });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'stem-desk-two-track-real.json'), JSON.stringify({
    stemsA,
    stemsB,
    ids,
    result,
  }, null, 2));
  for (const entry of result.checks) {
    const detail = entry.detail === undefined ? '' : ` — ${JSON.stringify(entry.detail)}`;
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${detail}`);
  }
  const failed = result.checks.filter((entry) => !entry.ok);
  console.log(`\n${result.checks.length - failed.length}/${result.checks.length} two-track real-stem checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
