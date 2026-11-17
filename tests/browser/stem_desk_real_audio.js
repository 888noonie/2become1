#!/usr/bin/env node
// tests/browser/stem_desk_real_audio.js — render real separated stems through
// the real StemDesk runtime, not synthetic probe tones.
//
// The original Stem Desk audio test used four generated sine waves. It proved
// the gain graph but could not see that a real Demucs separation may leave a
// stem effectively silent. This harness decodes the actual files and checks
// that every lane is audible on its own, that mute/solo isolate exactly, that
// gain changes only its own lane, and that Stop releases to silence.
//
// Usage:
//   node tests/browser/stem_desk_real_audio.js --stems <dir> [--out <dir>]
//
// The directory must contain vocals.wav, drums.wav, bass.wav and other.wav.
// It is a demonstration/release gate, not part of the default unit suite.

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'src', 'twobecomeone', 'studio_static', 'js', 'runtime', 'stem-desk.js');
const NAMES = ['vocals', 'drums', 'bass', 'other'];

const value = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const stemDir = value('--stems');
const outDir = path.resolve(value('--out', path.join(ROOT, 'tests', 'browser', 'artifacts')));
if (!stemDir) {
  console.error('usage: node tests/browser/stem_desk_real_audio.js --stems <dir> [--out <dir>]');
  process.exit(2);
}

const files = {};
for (const name of NAMES) {
  const file = path.join(stemDir, `${name}.wav`);
  if (!existsSync(file)) {
    console.error(`missing stem file: ${file}`);
    process.exit(2);
  }
  files[name] = readFileSync(file);
}

const server = http.createServer((req, res) => {
  const name = (req.url || '').split('?')[0].replace('/stem/', '').replace('.wav', '');
  const body = files[name];
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

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async ({ runtimeSource, baseUrl, names }) => {
    const moduleUrl = URL.createObjectURL(new Blob([runtimeSource], { type: 'text/javascript' }));
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

    async function render({ gains = {}, muted = [], solo = [], stopImmediately = false }) {
      const ctx = new OfflineAudioContext(2, Math.round(RATE * 12), RATE);
      const desk = new StemDesk({ audioContext: ctx, fetchImpl: (url) => fetch(url) });
      const loaded = await desk.load(names.map((name) => ({
        name,
        label: name,
        audioUrl: `${baseUrl}/stem/${name}.wav`,
        method: 'demucs',
        modelName: 'htdemucs@4.1.0',
        device: 'cuda',
      })));
      if (loaded.status !== 'ready' || loaded.lanes.length !== names.length) {
        throw new Error(`load failed: ${JSON.stringify(loaded.error ?? loaded.status)}`);
      }
      for (const [name, db] of Object.entries(gains)) desk.setGain(name, db);
      for (const name of muted) desk.setMuted(name, true);
      for (const name of solo) desk.setSolo(name, true);
      desk.play({ loop: false });
      if (stopImmediately) desk.stop();
      const rendered = await ctx.startRendering();
      const channels = [];
      for (let c = 0; c < rendered.numberOfChannels; c += 1) channels.push(rendered.getChannelData(c));
      const state = desk.state();
      desk.dispose();
      return { ...metrics(channels), channels, status: state.status, lanes: state.lanes };
    }

    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    const solo = {};
    for (const name of names) solo[name] = await render({ solo: [name] });
    const baseline = await render({});
    const muteDrums = await render({ muted: ['drums'] });
    const soloRest = await render({ solo: names.filter((name) => name !== 'drums') });
    const muteThree = await render({ muted: names.filter((name) => name !== 'vocals') });
    const bassCut = await render({ gains: { bass: -12 } });
    const bassCutSoloVocals = await render({ gains: { bass: -12 }, solo: ['vocals'] });
    const stopped = await render({ stopImmediately: true });

    for (const name of names) {
      add(`solo ${name} is audible`, solo[name].rmsDb > STEM_DESK_LIMITS.silentRmsDb,
        { rmsDb: solo[name].rmsDb, peakDb: solo[name].peakDb });
      add(`solo ${name} keeps the transport playing`, solo[name].status === 'playing', solo[name].status);
    }
    add('the four-stem mix does not clip', baseline.peak < 1, { peak: baseline.peak });
    add('the four-stem mix is not silent', baseline.rmsDb > -40, { rmsDb: baseline.rmsDb });

    const muteDrumsVsSoloRest = compare(muteDrums.channels, soloRest.channels);
    add('muting drums equals soloing the other three',
      muteDrumsVsSoloRest.correlation > 0.999 && Math.abs(muteDrumsVsSoloRest.rmsRatio - 1) < 0.01,
      muteDrumsVsSoloRest);

    const soloVocalsVsMuteThree = compare(solo.vocals.channels, muteThree.channels);
    add('solo vocals equals muting the other three',
      soloVocalsVsMuteThree.correlation > 0.999 && Math.abs(soloVocalsVsMuteThree.rmsRatio - 1) < 0.01,
      soloVocalsVsMuteThree);

    const vocalsUnaffected = compare(solo.vocals.channels, bassCutSoloVocals.channels);
    add('a bass gain change leaves vocals untouched',
      vocalsUnaffected.correlation > 0.999 && Math.abs(vocalsUnaffected.rmsRatio - 1) < 0.01,
      vocalsUnaffected);

    add('bass at -12 dB reduces the mix by the bass contribution',
      bassCut.rms < baseline.rms && bassCut.rms > baseline.rms * 0.6,
      { baselineRms: baseline.rms, bassCutRms: bassCut.rms });

    add('stop releases to digital silence', stopped.peak === 0, { peak: stopped.peak });

    return {
      rate: RATE,
      lanes: names,
      scenarios: {
        solo: Object.fromEntries(names.map((name) => [name, {
          rmsDb: solo[name].rmsDb, peakDb: solo[name].peakDb, status: solo[name].status,
        }])),
        baseline: { rmsDb: baseline.rmsDb, peakDb: baseline.peakDb },
        muteDrums: { rmsDb: muteDrums.rmsDb },
        bassCut: { rmsDb: bassCut.rmsDb },
        stopped: { peak: stopped.peak },
      },
      checks,
    };
  }, { runtimeSource: source, baseUrl: base, names: NAMES });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'stem-desk-real-audio.json'), JSON.stringify(result, null, 2));
  for (const entry of result.checks) {
    const detail = entry.detail === undefined ? '' : ` — ${JSON.stringify(entry.detail)}`;
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${detail}`);
  }
  const failed = result.checks.filter((entry) => !entry.ok);
  console.log(`\n${result.checks.length - failed.length}/${result.checks.length} real-stem checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
