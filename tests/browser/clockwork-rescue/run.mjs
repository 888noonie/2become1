#!/usr/bin/env node
// tests/browser/clockwork-rescue/run.mjs — bounded real-Chromium checks for the
// repaired live engine (OPERATION THE GOLDEN EAR II).
//
// Serves the repo on an ephemeral loopback port and runs harness.js in headless
// Chromium. Modes (comma-separated --mode, default "offline"):
//
//   offline  the ACTUAL RealtimeEngine on an OfflineAudioContext with real
//            worklets (Signalsmith + limiter), driven by suspend() wakes;
//            measures seek / stop / loop / arm-lead / non-finite in the PCM,
//            plus the same seek/stop scripts on the legacy C1 engine as the
//            negative control.
//   routing  the live/offline routing divergence for a rate-1 clip
//            (bypass vs Signalsmith) — evidence for the shared-contract finding.
//   live     a real-time AudioContext under --disable-audio-output --mute-audio
//            (a fake, silent output stream; NO device is opened — verified with
//            pactl before and during the run, which aborts if a Chromium stream
//            appears). Measures real build times and supplied priming leads.
//
// Output: ~/.local/state/clockwork-rescue/<mode>-results.json (small JSON only).

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveChromium } from '../chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT = path.join(os.homedir(), '.local', 'state', 'clockwork-rescue');
mkdirSync(OUT, { recursive: true });
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const MODES = arg('--mode', 'offline').split(',');

const LEGACY_SHA = 'ec7408594d47c8870a946aa9d7fb25d1fd013c60';
const LEGACY = path.join(ROOT, 'src/twobecomeone/studio_static/js/realtime-engine.legacy-c1.tmp.js');
const LEGACY_OFFLINE = path.join(ROOT, 'src/twobecomeone/studio_static/js/arrangement/offline-render.legacy-c1.tmp.js');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
};
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

// Count ALL PipeWire/Pulse sink inputs (playback streams). The live mode aborts
// if the count rises above its pre-launch baseline: any new stream at all.
function chromiumSinkInputs() {
  try {
    const out = execFileSync('pactl', ['list', 'sink-inputs', 'short'], { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').filter((l) => l.trim()).length;
  } catch {
    return null; // pactl unavailable: reported, not assumed
  }
}
let sinkBaseline = 0;

async function runMode(browser, port, mode) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let guard = null;
  let sinkSamples = [];
  if (mode.startsWith('live')) {
    // Abort the page at once if Chromium ever registers a PipeWire stream.
    guard = setInterval(async () => {
      const n = chromiumSinkInputs();
      sinkSamples.push(n);
      if (n === null || n > sinkBaseline) { errors.push(`ABORT: playback stream count ${n} > baseline ${sinkBaseline}`); await page.close().catch(() => {}); }
    }, 100);
  }
  const [m, set] = mode.split(':');
  await page.goto(`http://127.0.0.1:${port}/tests/browser/clockwork-rescue/harness.html?mode=${m}${set ? `&set=${set}` : ''}`);
  let report = null;
  try {
    await page.waitForFunction('window.__done === true', null, { timeout: 300000 });
    report = await page.evaluate('window.__report');
  } catch (err) {
    errors.push(`harness did not finish: ${err.message}`);
  }
  if (guard) clearInterval(guard);
  await page.close().catch(() => {});
  report = report ?? { checks: [], measurements: {} };
  report.errors = [...(report.errors ?? []), ...errors];
  if (mode.startsWith('live')) report.measurements.playbackStreamsSeen = { baseline: sinkBaseline, samples: sinkSamples.length, max: Math.max(...sinkSamples.map((x) => x ?? Infinity)) };
  writeFileSync(path.join(OUT, `${mode.replace(':', '-')}-results.json`), `${JSON.stringify(report, null, 2)}\n`);
  let failed = 0;
  for (const c of report.checks) {
    console.log(`${c.passed ? 'PASS' : 'FAIL'} [${mode}] ${c.name} ${JSON.stringify(c.detail ?? {}).slice(0, 220)}`);
    if (!c.passed) failed += 1;
  }
  for (const e of report.errors) console.log(`ERROR [${mode}] ${e}`);
  console.log(`[${mode}] measurements: ${JSON.stringify(report.measurements).slice(0, 1500)}`);
  return failed + report.errors.length;
}

// The owner audition page, in real Chromium with real worklets, under the same
// no-device guarantees as the live mode (fake output, muted, stream guard).
async function runPage(browser, port) {
  const page = await browser.newPage();
  const errors = [];
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__ctxCount = 0;
    const Native = window.AudioContext;
    window.AudioContext = class extends Native { constructor(...a) { super(...a); window.__ctxCount += 1; } };
  });
  const samples = [];
  const guard = setInterval(async () => {
    const n = chromiumSinkInputs();
    samples.push(n);
    if (n === null || n > sinkBaseline) { errors.push(`ABORT: playback stream count ${n} > baseline ${sinkBaseline}`); await page.close().catch(() => {}); }
  }, 100);
  const phase = () => page.evaluate(() => document.getElementById('audition').getAttribute('data-phase'));
  const waitPhase = (p) => page.waitForFunction((want) => document.getElementById('audition').getAttribute('data-phase') === want, p, { timeout: 8000 });
  try {
    await page.goto(`http://127.0.0.1:${port}/tools/clockwork-audition/index.html`);
    await page.waitForFunction(() => !!window.__audition, null, { timeout: 8000 });
    await page.waitForTimeout(300);
    check('page: loading creates no AudioContext (no autoplay)', (await page.evaluate(() => window.__ctxCount)) === 0, { phase: await phase() });
    check('page: Stop button visible and enabled', await page.isVisible('button.stop') && await page.isEnabled('button.stop'), {});
    await page.keyboard.press('Escape');
    check('page: Esc before Play opens nothing', (await page.evaluate(() => window.__ctxCount)) === 0, {});
    await page.click('button.play');
    await waitPhase('playing');
    check('page: Play -> playing through the real engine', true, { contexts: await page.evaluate(() => window.__ctxCount) });
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await waitPhase('stopped');
    check('page: Esc -> stopped', true, {});
    await page.keyboard.press('Space');
    await waitPhase('playing');
    await page.click('button[aria-label="Jump to 6 s"]');
    await page.waitForTimeout(300);
    await page.click('button[aria-label="Loop 2 s to 4 s"]');
    await page.waitForTimeout(500);
    const mid = await page.evaluate(() => { const d = window.__audition.state.engine.diagnostics(); return { phase: d.state.phase, loop: d.state.loop, misses: d.deadlineMisses, lead: d.timing.suppliedDspLeadMs, starts: d.startDelaysMs }; });
    check('page: Space -> playing; seek and loop keep playing with no deadline miss', mid.phase === 'playing' && mid.misses === 0 && mid.loop, mid);
    // THE BROKEN RECORD: Loop was switched on at ~6.5 s (outside 2-4 s). Sample
    // the heard position for 7 s of real clock: it must stay in [2 s, 4 s),
    // wrap repeatedly and outlive the 8 s arrangement end.
    const trace = [];
    for (let i = 0; i < 70; i += 1) {
      trace.push(await page.evaluate(() => { const e = window.__audition.state.engine; return { f: e.playhead(), phase: e.state().phase, live: e.pool.stats().live, conn: e.diagnostics().connectedProcessors }; }));
      await page.waitForTimeout(100);
    }
    const inLoop = trace.filter((x) => x.phase === 'playing');
    const wraps = trace.filter((x, i) => i && x.f < trace[i - 1].f).length;
    const loopDiag = await page.evaluate(() => { const d = window.__audition.state.engine.diagnostics(); return { misses: d.deadlineMisses, loopEntries: d.loopEntries, peakConnected: d.peakConnected, poolPeak: d.pool.peakConcurrent }; });
    check('page: loop 2-4 s repeats (>=3 wraps in 7 s), stays in range, outlives the arrangement end',
      trace.at(-1).phase === 'playing' && wraps >= 3 && inLoop.every((x) => x.f >= 96000 && x.f < 192000) && loopDiag.misses === 0,
      { wraps, samples: trace.length, maxLive: Math.max(...trace.map((x) => x.live)), maxConnected: Math.max(...trace.map((x) => x.conn)), ...loopDiag });
    await page.click('button[aria-label="Jump to 6 s"]');
    await page.waitForTimeout(1500);
    const afterSeek = await page.evaluate(() => { const e = window.__audition.state.engine; return { f: e.playhead(), phase: e.state().phase }; });
    check('page: Jump to 6 s while looping re-enters the loop', afterSeek.phase === 'playing' && afterSeek.f >= 96000 && afterSeek.f < 192000, afterSeek);
    await page.keyboard.press('Space');
    await waitPhase('stopped');
    const end = await page.evaluate(() => { const d = window.__audition.state.engine.diagnostics(); return { connected: d.connectedProcessors, live: d.pool.live, errors: [...document.querySelectorAll('.errors li')].map((li) => li.textContent) }; });
    check('page: Space -> stopped; processors and slots at baseline', end.connected === 0 && end.live === 0, end);
    check('page: exactly one AudioContext was created (on the Play gesture)', (await page.evaluate(() => window.__ctxCount)) === 1, {});
    await page.click('button[aria-label="Release audio device"]');
    await page.waitForTimeout(200);
    check('page: Release closes the audio context', await page.evaluate(() => window.__audition.state.ctx === null), {});
  } catch (err) {
    errors.push(`page flow: ${err.message}`);
  }
  clearInterval(guard);
  await page.close().catch(() => {});
  const report = { checks, errors, measurements: { playbackStreamsSeen: { baseline: sinkBaseline, samples: samples.length, max: Math.max(...samples.map((x) => x ?? Infinity)) } } };
  writeFileSync(path.join(OUT, 'page-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'} [page] ${c.name} ${JSON.stringify(c.detail).slice(0, 220)}`);
  for (const e of errors) console.log(`ERROR [page] ${e}`);
  console.log(`[page] playback streams: ${JSON.stringify(report.measurements.playbackStreamsSeen)}`);
  return checks.filter((c) => !c.passed).length + errors.length;
}

writeFileSync(LEGACY, execFileSync('git', ['-C', ROOT, 'show', `${LEGACY_SHA}:src/twobecomeone/studio_static/js/realtime-engine.js`]));
writeFileSync(LEGACY_OFFLINE, execFileSync('git', ['-C', ROOT, 'show', `${LEGACY_SHA}:src/twobecomeone/studio_static/js/arrangement/offline-render.js`]));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let failures = 0;
try {
  for (const mode of MODES) {
    const live = mode.startsWith('live') || mode === 'page';
    if (live) {
      const before = chromiumSinkInputs();
      if (before === null) { console.log('SKIP [live] pactl unavailable: cannot verify that no output device is opened'); continue; }
      sinkBaseline = before;
    }
    const browser = await chromium.launch({
      executablePath: resolveChromium(),
      headless: true,
      args: live
        ? ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required']
        : ['--mute-audio'],
    });
    try {
      failures += mode === 'page' ? await runPage(browser, port) : await runMode(browser, port, mode);
    } finally {
      await browser.close();
    }
  }
} finally {
  rmSync(LEGACY, { force: true });
  rmSync(LEGACY_OFFLINE, { force: true });
  server.close();
}
console.log(`results: ${OUT}`);
process.exitCode = failures ? 1 : 0;
