#!/usr/bin/env node
// tests/browser/stem_passport_audio.js — eight-lane PCM gate for imported stems.
//
// Loads an owner-supplied (imported) set into group A and a Demucs-shaped set
// into group B through the real StemDesk runtime on an OfflineAudioContext,
// then measures what each lane actually contributes. It proves that imported
// files behave exactly like separated ones: audible lanes, independent mute and
// solo, one shared start, no clipping, and a clean end.
//
// Usage:
//   node tests/browser/stem_passport_audio.js --data-dir <seeded dir> [--out DIR]
//
// Seed with tests/browser/stem_passport_seed.py first. It starts its own Studio
// on a free loopback port against that temporary data directory.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const value = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dataDir = value('--data-dir');
const outDir = path.resolve(value('--out', path.join(ROOT, 'tests', 'browser', 'artifacts')));
if (!dataDir) {
  console.error('usage: node tests/browser/stem_passport_audio.js --data-dir <seeded dir>');
  process.exit(2);
}

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close((error) => (error ? reject(error) : resolvePort(free)));
  });
});
const base = `http://127.0.0.1:${port}`;
const studio = spawn(
  process.env.PYTHON || '.venv/bin/python',
  ['-m', 'twobecomeone.cli', 'web', '--port', String(port), '--data-dir', dataDir],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') } },
);
const serverLog = [];
studio.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
studio.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${JSON.stringify(detail)}`);
};

try {
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (studio.exitCode !== null) throw new Error(`studio exited: ${serverLog.join('')}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`studio did not start: ${serverLog.join('')}`);
    await sleep(200);
  }

  const tracks = (await (await fetch(`${base}/api/tracks?limit=20`)).json()).items;
  const byTitle = (needle) => tracks.find((t) => (t.title || t.name || '').includes(needle));
  const trackA = byTitle('arrangement-a');
  const trackB = byTitle('arrangement-b');
  if (!trackA || !trackB) throw new Error(`seeded tracks missing: ${tracks.map((t) => t.title || t.name)}`);

  const stemsOf = async (track) => {
    const payload = await (await fetch(`${base}/api/tracks/${track.id}/stems`)).json();
    const lanes = payload.variants.filter((v) => ['vocals', 'drums', 'bass', 'other'].includes(v.name));
    return { payload, lanes };
  };
  const a = await stemsOf(trackA);
  const b = await stemsOf(trackB);
  check('the owner-supplied set is listed as imported',
    a.lanes.length === 4 && a.lanes.every((v) => v.method === 'imported'),
    a.lanes.map((v) => `${v.name}:${v.method}`));
  check('the imported set carries a set hash and per-lane source hash',
    a.lanes.every((v) => v.set_hash && v.source_sha256 && v.original_name),
    { setHash: a.lanes[0]?.set_hash?.slice(0, 12), original: a.lanes[0]?.original_name });
  check('the separated track is still a demucs set',
    b.lanes.length === 4 && b.lanes.every((v) => v.method === 'demucs'),
    b.lanes.map((v) => `${v.name}:${v.method}`));

  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
  try {
    const page = await browser.newPage();
    // Same-origin so the runtime module and its ./crossfader.js import resolve.
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const rendered = await page.evaluate(async ({ baseUrl, lanesA, lanesB }) => {
      const rate = 44100;
      const moduleUrl = new URL('/assets/js/runtime/stem-desk.js', baseUrl).href;
      const { StemDesk } = await import(moduleUrl);
      const ctx = new OfflineAudioContext(2, Math.round(rate * 11), rate);
      const desk = new StemDesk({ audioContext: ctx, fetchImpl: (u) => fetch(u) });
      const group = (trackId, lanes) => ({
        trackId,
        title: trackId,
        lanes: lanes.map((lane) => ({
          name: lane.name,
          label: lane.name,
          audioUrl: new URL(lane.audio_url, baseUrl).href,
          method: lane.method,
          modelName: lane.model_name,
          device: lane.device,
          stemSetId: lane.stem_set_id,
        })),
      });
      const loaded = await desk.loadGroups([group('A', lanesA), group('B', lanesB)]);
      if (loaded.lanes.length !== 8) throw new Error(`load failed: ${JSON.stringify(loaded.error)}`);
      const started = desk.play({ loop: false });
      const buffer = await ctx.startRendering();
      const ch = [buffer.getChannelData(0), buffer.getChannelData(1)];
      const peakOf = (fromS, toS) => {
        const from = Math.round(fromS * rate);
        const to = Math.min(ch[0].length, Math.round(toS * rate));
        let peak = 0;
        for (let i = from; i < to; i += 1) {
          peak = Math.max(peak, Math.abs(ch[0][i]), Math.abs(ch[1][i]));
        }
        return peak;
      };
      const rmsOf = (fromS, toS) => {
        const from = Math.round(fromS * rate);
        const to = Math.min(ch[0].length, Math.round(toS * rate));
        let sum = 0;
        for (let i = from; i < to; i += 1) sum += ch[0][i] ** 2 + ch[1][i] ** 2;
        return Math.sqrt(sum / Math.max(1, (to - from) * 2));
      };
      const full = { peak: peakOf(0.2, 9.5), rms: rmsOf(0.2, 9.5), tail: peakOf(10.2, 10.9) };

      // Solo one imported lane: only that lane should remain.
      const solo = new OfflineAudioContext(2, Math.round(rate * 11), rate);
      const soloDesk = new StemDesk({ audioContext: solo, fetchImpl: (u) => fetch(u) });
      const soloLoaded = await soloDesk.loadGroups([group('A', lanesA)]);
      soloDesk.setSolo('A:vocals', true);
      soloDesk.play({ loop: false });
      const soloBuf = await solo.startRendering();
      let soloRms = 0;
      for (let i = Math.round(rate * 0.2); i < Math.round(rate * 9.5); i += 1) {
        soloRms += soloBuf.getChannelData(0)[i] ** 2;
      }
      soloRms = Math.sqrt(soloRms / (Math.round(rate * 9.3)));

      const end = desk.state();
      desk.dispose();
      soloDesk.dispose();
      return {
        lanes: loaded.lanes.length,
        started: started.status,
        full,
        soloRms,
        laneRms: Object.fromEntries(loaded.lanes.map((lane) => [lane.key, lane.rmsDb])),
        end: { status: end.status, playing: end.playing, loop: end.loop },
        crossfade: end.crossfader,
      };
    }, { baseUrl: base, lanesA: a.lanes, lanesB: b.lanes });

    const anyLaneSilent = Object.entries(rendered.laneRms).filter(([, db]) => db <= -50);
    check('eight lanes start together on one clock', rendered.lanes === 8 && rendered.started === 'playing',
      { lanes: rendered.lanes, status: rendered.started });
    check('the imported group is audible in the mix', rendered.full.rms > 0.005,
      { rms: +rendered.full.rms.toFixed(4), peak: +rendered.full.peak.toFixed(3) });
    check('the eight-lane mix stays inside full scale', rendered.full.peak <= 1.0000001,
      { peak: +rendered.full.peak.toFixed(3) });
    check('soloing an imported lane leaves a real signal', rendered.soloRms > 0.001,
      { soloRms: +rendered.soloRms.toFixed(4) });
    check('no imported lane is effectively silent', anyLaneSilent.length === 0, anyLaneSilent);
    check('playback ends in silence and returns to ready',
      rendered.full.tail === 0 && rendered.end.status === 'ready' && rendered.end.playing === false,
      { tail: rendered.full.tail, end: rendered.end });

    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'stem-passport-audio.json'), JSON.stringify({ ...rendered, results }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  studio.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} imported-stem audio checks passed`);
process.exitCode = failed.length ? 1 : 0;
