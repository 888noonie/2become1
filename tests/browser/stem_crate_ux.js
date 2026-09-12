// Phase 14B.3 browser acceptance: FUN crate panel at both viewports.

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
async function waitFor(fn, label, timeout = 30000) {
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

mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), '2become1-crate-'));
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
  await waitFor(async () => (await page.locator('.deck-mode__button', { hasText: 'FUN' }).count()) === 1, 'FUN toggle');
  record('crate panel is hidden in DJ mode', await page.locator('.studio__stem-crate').isHidden());
  await page.locator('.deck-mode__button', { hasText: 'FUN' }).click();
  await waitFor(async () => (await page.locator('.stem-crate').count()) === 1, 'crate panel');
  record('crate panel is visible in FUN', await page.locator('.studio__stem-crate').isVisible());
  const body = await page.locator('.stem-crate').textContent();
  record('ffmpeg crate cards stay center/sides', /ffmpeg center\/sides/.test(body) && !/vocals/i.test(body), body.slice(0, 120));
  const place = page.locator('.stem-crate__place').first();
  record('stack placement stays disabled with 14C copy', await place.isDisabled() && /Stem stack arrives in Phase 14C/.test(await place.textContent()));
  const search = page.locator('.stem-crate__search');
  await search.fill('center');
  await waitFor(async () => (await page.locator('.stem-crate-card').count()) === 1, 'search filter');
  record('search filters crate cards', (await page.locator('.stem-crate-card').count()) === 1);
  await page.locator('.stem-crate__filters button', { hasText: 'voice' }).click();
  await waitFor(async () => (await page.locator('.stem-crate-card').count()) === 0, 'role filter empty');
  record('role filter hides ffmpeg sides from voice', (await page.locator('.stem-crate-card').count()) === 0);
  await page.locator('.stem-crate__filters button', { hasText: 'All' }).click();
  await search.fill('');
  await waitFor(async () => (await page.locator('.stem-crate-card').count()) >= 1, 'crate restored');
  await page.locator('.stem-crate__bars button', { hasText: '2' }).first().click();
  await waitFor(async () => {
    const listing = await (await fetch(`${BASE}/api/stem-crate`)).json();
    return listing.items.some((item) => item.loop_bars === 2);
  }, 'loop bars patched');
  record('loop selector patches crate item', true);
  record('grid correction control is present', (await page.locator('.stem-crate-card button', { hasText: 'Correct grid' }).count()) >= 1);
  await waitFor(async () => {
    const button = page.locator('.stem-crate-card .stem-crate__place').first();
    return (await button.count()) === 1 && await button.isVisible();
  }, 'visible place control');
  const placeTarget = page.locator('.stem-crate-card .stem-crate__place').first();
  await placeTarget.evaluate((button) => button.scrollIntoView({ block: 'center' }));
  const size = await placeTarget.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  record('disabled place control keeps a 44px target', size.width >= 44 && size.height >= 44, `${size.width.toFixed(1)}x${size.height.toFixed(1)}`);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  record('no horizontal overflow', overflow.scroll <= overflow.client + 1, `scroll=${overflow.scroll} client=${overflow.client}`);
  record('no uncaught browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
} catch (err) {
  record('stem crate journey', false, String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopChild(child);
  rmSync(dataDir, { recursive: true, force: true });
}

writeFileSync(join(outDir, `stem-crate-${viewportArg}.json`), JSON.stringify({ viewport: viewportArg, results, failures }, null, 2));
if (failures) process.exit(1);
