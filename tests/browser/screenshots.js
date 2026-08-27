// tests/browser/screenshots.js — Phase 7B visual QA capture.
//
// Captures the populated Studio, Library, Activity, and Engine views at the
// four target viewports (1440x1100, 1280x800, 820x1180, 390x844) against the
// fixture server, plus a loading state. Screenshots are written to
// tests/browser/artifacts/ for inspection. This is a capture tool, not a gate.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
async function availablePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}
const PORT = await availablePort();
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(ROOT, 'tests', 'browser', 'artifacts');

const VIEWPORTS = [
  { name: '1440x1100', width: 1440, height: 1100 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '820x1180', width: 820, height: 1180 },
  { name: '390x844', width: 390, height: 844 },
];

const VIEWS = ['studio', 'library', 'activity', 'engine'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeout = 15000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

function startServer(dataDir) {
  return spawn(
    '.venv/bin/python',
    ['-m', 'tests.browser.fixture_server', '--data-dir', dataDir, '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function waitForServer(child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early');
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await sleep(200);
  }
  throw new Error('server not ready');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null) {
    const killed = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill('SIGKILL');
    await Promise.race([killed, sleep(2000)]);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), '2become1-shots-'));
  const child = startServer(dataDir);
  let browser;
  try {
    await waitForServer(child);
    browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });

    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      for (const view of VIEWS) {
        await page.goto(`${BASE}/#/${view}`);
        await waitFor(async () => {
          const main = await page.locator('#main').textContent().catch(() => '');
          return main && main.trim().length > 0;
        }, 15000, `${view} renders`);
        // Let async data settle.
        await sleep(600);
        const path = join(OUT, `${view}-${vp.name}.png`);
        await page.screenshot({ path, fullPage: false });
        console.log(`captured ${view}-${vp.name}.png`);
      }
      await context.close();
    }

    // Loading state: capture immediately after navigation before data settles.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/#/library`);
    await page.screenshot({ path: join(OUT, 'library-loading-1280x800.png') });
    console.log('captured library-loading-1280x800.png');
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
