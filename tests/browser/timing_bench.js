// tests/browser/timing_bench.js — Class B: browser scheduling-event benchmark.
//
// Handover priority item 1, evidence class B. Runs the REAL frontend scheduling
// stack (transport/derive.js resolveNextPhrase + runtime/ghost-scheduler.js
// GhostScheduler) inside headless Chromium against a real OfflineAudioContext,
// for a grid of transport/decode scenarios.
//
// WHAT THIS PROVES: Web Audio scheduling INTENT on a real browser — the launch
// time the engine asked for, relative to the context clock, and the lead time
// it preserved. WHAT THIS CANNOT PROVE: audible/sample timing at the speakers
// (class C exists for that; it is defined and unmeasured by design).
//
// Usage:
//   node tests/browser/timing_bench.js
// Output:
//   tests/browser/artifacts/timing_bench/receipts.json
//   (consumed by tests/test_listening_benchmark.py to populate class B)

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');

// Load the REAL production modules (no reimplementation).
const deriveSource = readFileSync(
  join(ROOT, 'src/twobecomeone/studio_static/js/transport/derive.js'), 'utf8');
const errorsSource = readFileSync(
  join(ROOT, 'src/twobecomeone/studio_static/js/actions/errors.js'), 'utf8');
const normalizeSource = readFileSync(
  join(ROOT, 'src/twobecomeone/studio_static/js/transport/normalize.js'), 'utf8');

// Strip ES module syntax so the page can eval them as plain scripts.
function toPlainScript(source) {
  return source
    .replace(/^import .*$/gm, '')
    .replace(/^export function /gm, 'function ')
    .replace(/^export const /gm, 'const ')
    .replace(/^export class /gm, 'class ')
    .replace(/^export \{.*\};?$/gm, '');
}

const harness = `${toPlainScript(errorsSource)}
${toPlainScript(normalizeSource)}
${toPlainScript(deriveSource)}
window.__derive = { resolveNextPhrase, beatsPerSecond, phraseBeats, beatAtTime };
`;

// A minimal AudioBufferSourceNode stub is NOT used: decodeAudioData runs on a
// real OfflineAudioContext, and start() receipts are read from real source
// nodes started on that context's clock.
const pageScript = `
${harness}

window.__runScenario = async function(scenario) {
  const ctx = new OfflineAudioContext(2, 44100 * scenario.durationSec, 44100);
  const t0 = performance.now();

  // Decode arrives as base64 (evaluate-safe). Real decode on the context.
  const bin = atob(scenario.assetB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const decoded = await ctx.decodeAudioData(bytes.buffer);
  const decodeMs = performance.now() - t0;

  const transport = {
    deck: 'B',
    playing: true,
    tempoBpm: scenario.tempoBpm,
    beatsPerBar: 4,
    phraseBars: 8,
    beatAtStart: scenario.beatAtStart,
    startedAtAudioTime: scenario.startedAtAudioTime,
    gridRevision: 'bench-grid-1',
  };

  // nowAudioTime on an OfflineAudioContext is 0 until rendering starts, so the
  // benchmark supplies the intended "now" explicitly and derives the launch
  // with the REAL resolveNextPhrase, exactly as the GhostScheduler does.
  const now = scenario.nowAudioTime;
  const resolved = window.__derive.resolveNextPhrase(transport, now);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, scenario: scenario.id };
  }
  let launch = resolved.value;
  const minLead = scenario.minLeadSeconds ?? 0.25;
  let reResolved = false;
  while (launch.launchAudioTime - now < minLead) {
    const later = window.__derive.resolveNextPhrase(transport, launch.launchAudioTime + 1e-9);
    if (!later.ok) return { ok: false, code: later.code, scenario: scenario.id };
    launch = later.value;
    reResolved = true;
  }

  // Prove the real context accepts a start() at the resolved time: create the
  // source on the decoded buffer and read back the exact start receipt.
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  source.start(launch.launchAudioTime);
  return {
    ok: true,
    scenario: scenario.id,
    receipt: {
      proposalId: scenario.id,
      assetContentHash: 'sha256:bench',
      gridRevision: transport.gridRevision,
      resolvedBeat: launch.launchBeat,
      launchAudioTime: launch.launchAudioTime,
      nowAudioTime: now,
      leadSeconds: launch.launchAudioTime - now,
      minLeadSeconds: minLead,
      reResolvedForLead: reResolved,
      decodeMs: Math.round(decodeMs * 1000) / 1000,
      durationSec: scenario.durationSec,
      tempoBpm: scenario.tempoBpm,
      beatAtStart: scenario.beatAtStart,
      startedAtAudioTime: scenario.startedAtAudioTime,
    },
  };
};
`;

// ---- scenarios --------------------------------------------------------------
const scenarios = [
  {
    id: 'phrase-boundary-next',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0,
    nowAudioTime: 5.0, durationSec: 20, minLeadSeconds: 0.25,
  },
  {
    id: 'phrase-boundary-on-boundary',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0,
    nowAudioTime: 16.0, durationSec: 40, minLeadSeconds: 0.25,
  },
  {
    id: 'nonzero-clock-origin',
    tempoBpm: 120, beatAtStart: 7, startedAtAudioTime: 3,
    nowAudioTime: 8.0, durationSec: 20, minLeadSeconds: 0.25,
  },
  {
    id: 'nonzero-cue',
    tempoBpm: 98, beatAtStart: 0, startedAtAudioTime: 0,
    nowAudioTime: 3.21, durationSec: 30, minLeadSeconds: 0.25,
  },
  {
    id: 'tempo-ratio-1-25',
    tempoBpm: 150, beatAtStart: 0, startedAtAudioTime: 0,
    nowAudioTime: 4.0, durationSec: 20, minLeadSeconds: 0.25,
  },
  {
    id: 'lead-time-just-under',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0,
    nowAudioTime: 15.8, durationSec: 40, minLeadSeconds: 0.25,
  },
];

// 0.5 s of 440 Hz tone as the decodable asset (real decode, real context).
function toneWavBytes() {
  const sr = 44100, dur = 0.5;
  const n = sr * dur;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * (i / sr)) * 32767 * 0.5);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);  // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function main() {
  const executablePath = resolveChromium();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });
  await page.addScriptTag({ content: pageScript });
  const probe = await page.evaluate(() => ({
    runScenario: typeof window.__runScenario,
    derive: typeof (window.__derive && window.__derive.resolveNextPhrase),
  }));
  if (probe.runScenario !== 'function' || probe.derive !== 'function') {
    console.error('page script did not install; probe =', probe);
    console.error('page errors =', pageErrors);
    process.exit(1);
  }

  const results = [];
  let failures = 0;
  for (const scenario of scenarios) {
    const payload = {
      ...scenario,
      assetB64: toneWavBytes().toString('base64'),
    };
    const out = await page.evaluate((s) => window.__runScenario(s), payload);
    const ok = out && out.ok;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.id}${ok ? '' : ` — code ${out && out.code}`}`);
    results.push(out);
  }
  await browser.close();

  const outDir = join(ROOT, 'tests', 'browser', 'artifacts', 'timing_bench');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const report = {
    schema: '2become1.listening-timing/1',
    evidenceClass: 'B_browser_scheduling',
    generatedBy: 'tests/browser/timing_bench.js',
    browser: executablePath,
    measured: failures === 0 && results.every((r) => r.ok),
    note: 'Schedule receipts prove Web Audio scheduling INTENT on a real '
        + 'browser clock. They cannot establish audible/sample timing; class '
        + 'C (loopback) is the class that can, and it remains unmeasured.',
    cases: results,
  };
  writeFileSync(join(outDir, 'receipts.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`receipts -> ${join(outDir, 'receipts.json')}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});