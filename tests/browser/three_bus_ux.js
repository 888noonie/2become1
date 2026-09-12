// Phase 15C browser acceptance: A + B + one prepared stack on the LiveMixer.
//
// Class B: three buses have distinguishable sources in the same graph, A/B
// clocks advance together, and the stack snapshot is scheduled/live while
// decks play. Class C capture is unmeasured in this harness — a receipt is
// never treated as speaker output.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const viewportArg = argValue('--viewport', '1280x800');
const [width, height] = viewportArg.split('x').map(Number);
const outDir = argValue('--out', join(ROOT, 'tests', 'browser', 'artifacts'));

async function availablePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

const PORT = await availablePort();
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
let failures = 0;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startServer(dataDir) {
  const child = spawn(
    process.env.PYTHON || '.venv/bin/python',
    ['-m', 'tests.browser.fixture_server', '--data-dir', dataDir, '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  );
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => log.push(chunk.toString()));
  return { child, log };
}

async function waitForServer(child, log) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${log.join('')}`);
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, 'fixture server');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function seedCrate() {
  const tracks = await (await fetch(`${BASE}/api/tracks?limit=10`)).json();
  const track = tracks.items[0];
  const started = await fetch(`${BASE}/api/tracks/${track.id}/separations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'ffmpeg' }),
  });
  const job = await started.json();
  await waitFor(async () => {
    const current = await (await fetch(`${BASE}/api/jobs/${job.id}`)).json();
    if (current.status === 'failed' || current.status === 'interrupted') {
      throw new Error(current.error || current.message || 'separation failed');
    }
    return current.status === 'complete';
  }, 'ffmpeg separation');
  const stems = await (await fetch(`${BASE}/api/tracks/${track.id}/stems`)).json();
  for (const variant of stems.variants || []) {
    if (!variant.stem_set_id || variant.name === 'full') continue;
    const created = await fetch(`${BASE}/api/stem-crate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track_id: track.id,
        stem_set_id: variant.stem_set_id,
        stem_name: variant.name,
        role: variant.name === 'center' || variant.name === 'sides' ? 'other' : 'voice',
      }),
    });
    if (!created.ok) throw new Error(`crate create ${created.status}`);
  }
}

async function mixerSnapshot(page) {
  return page.evaluate(async () => {
    const { liveMixer } = await import('/assets/js/app-context.js');
    return liveMixer.snapshot();
  });
}

mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), '2become1-15c-'));
const { child, log } = startServer(dataDir);
let browser;
try {
  await waitForServer(child, log);
  await seedCrate();
  browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => (
    (await page.locator('.deck-slot--anchor .deck__empty button').count()) >= 1
    || (await page.locator('.deck-slot--anchor .deck__title').count()) === 1
  ), 'studio ready');
  if ((await page.locator('.deck-slot--anchor .deck__title').count()) === 0) {
    await page.locator('.deck-slot--anchor .deck__empty button').click();
    await waitFor(async () => (await page.locator('.picker__panel .track-card').count()) >= 2, 'picker tracks');
    await page.locator('.picker__panel .track-card').nth(0).locator('button', { hasText: 'Select' }).click();
    await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, 'anchor assigned');
    await page.locator('dialog[open] button', { hasText: 'Close' }).click();
    await waitFor(async () => (await page.locator('dialog[open]').count()) === 0, 'picker closed');
    await page.locator('.deck-slot--lead .deck__empty button').click();
    await waitFor(async () => (await page.locator('.picker__panel .track-card').count()) >= 2, 'picker tracks 2');
    await page.locator('.picker__panel .track-card').nth(1).locator('button', { hasText: 'Select' }).click();
    await waitFor(async () => (await page.locator('.deck-slot--lead .deck__title').count()) === 1, 'lead assigned');
    await page.locator('dialog[open] button', { hasText: 'Close' }).click();
    await waitFor(async () => (await page.locator('dialog[open]').count()) === 0, 'picker closed 2');
  }
  await waitFor(async () => (await page.locator('.deck-slot--anchor button[aria-label="Play Foundation"]').count()) === 1, 'foundation play');
  await page.locator('.deck-slot--anchor button[aria-label="Play Foundation"]').click();
  await page.locator('.deck-slot--lead button[aria-label="Play Lead"]').click();
  await waitFor(async () => {
    const snap = await mixerSnapshot(page);
    return snap.decks.A.playing && snap.decks.B.playing;
  }, 'A+B playing');
  const clocks0 = await mixerSnapshot(page);
  await sleep(400);
  const clocks1 = await mixerSnapshot(page);
  record(
    'A+B clocks advance together before stack commit',
    clocks0.decks.A.playing && clocks0.decks.B.playing
      && clocks1.decks.A.time > clocks0.decks.A.time
      && clocks1.decks.B.time > clocks0.decks.B.time,
    `A ${clocks0.decks.A.time.toFixed(2)}→${clocks1.decks.A.time.toFixed(2)} B ${clocks0.decks.B.time.toFixed(2)}→${clocks1.decks.B.time.toFixed(2)}`,
  );

  await page.locator('.deck-mode__button', { hasText: 'FUN' }).click();
  await waitFor(async () => (await page.locator('.stem-crate').count()) === 1, 'crate panel');
  await page.locator('.stem-crate-card .stem-crate__place').first().click();
  await waitFor(async () => (await page.locator('.stem-crate-slot.is-filled').count()) >= 1, 'placed slot');
  await page.locator('.stem-crate__preview').click();
  try {
    await waitFor(async () => page.locator('.stem-crate__commit').isEnabled(), 'stack auditioning');
  } catch (err) {
    const status = await page.locator('.stem-crate__stack-state').textContent().catch(() => '');
    const toast = await page.locator('#toast').textContent().catch(() => '');
    const fever = await page.locator('.stem-crate__fever').textContent().catch(() => '');
    throw new Error(`${err.message}; status=${status}; toast=${toast}; fever=${fever}; pageerrors=${errors.join(' | ')}`);
  }
  await page.locator('.stem-crate__commit').click();
  await waitFor(async () => {
    const snap = await mixerSnapshot(page);
    return snap.mixer.stack?.assetId && String(snap.mixer.stack.assetId).startsWith('ss-');
  }, 'stack asset on mixer');

  await page.locator('.deck-mode__button', { hasText: 'DJ' }).click();
  await waitFor(async () => (await page.locator('.live-crossfader').count()) === 1, 'crossfader');
  if ((await page.locator('.deck-slot--anchor button[aria-label="Play Foundation"]').count()) === 1) {
    await page.locator('.deck-slot--anchor button[aria-label="Play Foundation"]').click();
  }
  if ((await page.locator('.deck-slot--lead button[aria-label="Play Lead"]').count()) === 1) {
    await page.locator('.deck-slot--lead button[aria-label="Play Lead"]').click();
  }
  let three;
  try {
    three = await waitFor(async () => {
      const snap = await mixerSnapshot(page);
      if (snap.decks.A.playing && snap.decks.B.playing && (snap.mixer.stack.playing || snap.mixer.stack.state === 'scheduled' || snap.mixer.stack.state === 'live')) {
        return snap;
      }
      return false;
    }, 'three buses active');
  } catch (err) {
    const snap = await mixerSnapshot(page);
    throw new Error(`${err.message}; A=${snap.decks.A.playing} B=${snap.decks.B.playing} stack=${JSON.stringify(snap.mixer.stack)}`);
  }
  record(
    'A, B and prepared stack share the live mixer',
    Boolean(three.decks.A.playing && three.decks.B.playing && three.mixer.stack.assetId),
    `stack=${three.mixer.stack.state} asset=${three.mixer.stack.assetId}`,
  );
  record(
    'stack bus is not the library singleton path',
    String(three.mixer.stack.assetId || '').startsWith('ss-'),
    three.mixer.stack.assetId || 'missing',
  );

  await page.locator('.live-crossfader__stack-mute').click();
  const muted = await mixerSnapshot(page);
  record('muting stack leaves A+B playing', muted.decks.A.playing && muted.decks.B.playing && muted.mixer.stack.muted === true);
  record('Fever/mixer truth does not claim audible stack while muted', muted.mixer.stack.audible === false);
  record('Class C capture unmeasured', true, 'no OS sink monitor in this harness; receipts are Class B only');
  record('no uncaught browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
} catch (err) {
  record('three-bus journey', false, String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopChild(child);
  rmSync(dataDir, { recursive: true, force: true });
}

writeFileSync(join(outDir, `three-bus-${viewportArg}.json`), JSON.stringify({ viewport: viewportArg, results, failures }, null, 2));
if (failures) process.exit(1);
