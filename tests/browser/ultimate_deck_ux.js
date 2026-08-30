// Ultimate Deck focused browser proof at desktop and mobile viewports.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), '2b1-ultimate-deck-'));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function wait(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }

async function waitFor(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* retry */ }
    await wait(100);
  }
  throw new Error(`timeout: ${label}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), wait(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function assignTracks(page, base) {
  await page.goto(`${base}/#/studio`);
  await waitFor(() => page.locator('.deck__empty button').count().then((count) => count === 2), 'empty decks');
  for (const role of ['anchor', 'lead']) {
    await page.locator(`.deck-slot--${role} .deck__empty button`).click();
    await waitFor(() => page.locator('.picker__panel .track-card').count().then((count) => count >= 2), 'picker');
    const index = role === 'anchor' ? 0 : 1;
    await page.locator('.picker__panel .track-card').nth(index).locator('button', { hasText: 'Select' }).click();
    await waitFor(() => page.locator(`.deck-slot--${role} .deck__title`).count().then(Boolean), `${role} assigned`);
    await page.locator('dialog[open] button', { hasText: 'Close' }).click();
  }
  await waitFor(
    () => page.locator('.save-status').textContent().then((text) => text.includes('Saved locally')),
    'project autosave',
  );
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    '.venv/bin/python',
    ['-m', 'tests.browser.fixture_server', '--data-dir', dataDir, '--port', String(port)],
    { cwd: ROOT, stdio: 'ignore' },
  );
  let browser;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, 'fixture server');
    browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
    const seedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const seedPage = await seedContext.newPage();
    await assignTracks(seedPage, base);
    await seedContext.close();

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`${base}/#/studio`);
      await waitFor(() => page.locator('.deck-mode__button').count().then((count) => count === 2), 'mode switch');
      await page.locator('.deck-mode__button', { hasText: 'FUN' }).click();
      await waitFor(() => page.locator('.performance-pad').count().then((count) => count === 7), 'seven pads');

      const proof = await page.evaluate(() => ({
        pads: document.querySelectorAll('.performance-pad').length,
        hiddenDecks: document.querySelector('.studio__decks').hidden,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        mode: document.querySelector('.performance-deck').dataset.mode,
        unlabeledButtons: [...document.querySelectorAll('.performance-deck button')]
          .filter((button) => !button.textContent.trim() && !button.getAttribute('aria-label')).length,
      }));
      if (proof.pads !== 7 || !proof.hiddenDecks || proof.mode !== 'fun') throw new Error(JSON.stringify(proof));
      const populated = await page.locator('.performance-pad__launch').count();
      if (populated !== 2) throw new Error(`expected 2 playable pads, found ${populated}`);
      if (proof.scrollWidth !== proof.clientWidth) throw new Error(`horizontal overflow: ${JSON.stringify(proof)}`);
      if (proof.unlabeledButtons) throw new Error(`unlabelled controls: ${proof.unlabeledButtons}`);
      if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);

      const name = `ultimate-deck-fun-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: join('/tmp', name), fullPage: false });
      console.log(`PASS ${viewport.width}x${viewport.height} — 7 pads, no overflow, screenshot /tmp/${name}`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
