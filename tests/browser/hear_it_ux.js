#!/usr/bin/env node
// tests/browser/hear_it_ux.js — real-browser journey for "Hear it / Hear mine".
//
// Idea → Hear → Adjust → Keep or Return, on a seeded two-track Studio:
//   1. Ask, then Hear it: the suggestion is on the desk; Play was not pressed.
//   2. Adjust a fader mid-audition; Hear mine / Hear it never move it.
//   3. Play, flip while it plays, Stop stays dependable.
//   4. Approve keeps the suggestion plus the tweak.
//   5. A second idea: Hear it, then Reject returns to the mix exactly.
//
// Usage:
//   node tests/browser/hear_it_ux.js --data-dir <seeded dir> [--out DIR]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  console.error('usage: node tests/browser/hear_it_ux.js --data-dir <seeded dir>');
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
  {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') },
  },
);
const serverLog = [];
studio.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
studio.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const shown = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown ? ` — ${shown}` : ''}`);
};

const waitForStatus = async (page, pattern, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.locator('.stem-desk__status').innerText().catch(() => '');
    if (pattern.test(last)) return last;
    await sleep(250);
  }
  throw new Error(`status never matched ${pattern}: ${last}`);
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
  const trackA = tracks.find((t) => (t.name || '').includes('Midnight Circuit'));
  const trackB = tracks.find((t) => (t.name || '').includes('Paper Lanterns'));
  if (!trackA || !trackB) throw new Error(`seeded tracks missing: ${tracks.map((t) => t.name)}`);

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`${base}/#/studio`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stem-desk', { timeout: 20_000 });
    const selectA = page.locator('.stem-desk select[aria-label="Track for group A"]');
    const selectB = page.locator('.stem-desk select[aria-label="Track for group B"]');
    await selectA.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.stem-desk select[aria-label="Track for group A"] option').length > 1,
      null,
      { timeout: 20_000 },
    );
    for (const [group, select, track] of [['A', selectA, trackA], ['B', selectB, trackB]]) {
      await select.selectOption(track.id);
      await page.locator(`.stem-desk__group-controls[data-group="${group}"] summary`).click();
      await page.locator(`select[aria-label="Section for group ${group}"]`).selectOption('60');
      await page.locator(`input[aria-label="Section start in seconds for group ${group}"]`).fill('60');
      await page.getByRole('button', { name: `Load stems ${group}` }).click();
      await waitForStatus(page, new RegExp(`Loaded 4 stems into group ${group}`));
    }

    const ask = page.getByRole('button', { name: 'Ask for a proposal' });
    const hear = page.locator('.stem-desk__proposal button', { hasText: /^Hear (it|mine)$/ });
    const approve = page.getByRole('button', { name: /^(Approve|Undo)$/ });
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    const proposalStatus = page.locator('.stem-desk__proposal-status');
    const crossfader = page.locator('input[aria-label="Crossfader A to B"]');
    const state = async () => ({
      crossfader: await crossfader.inputValue(),
      gains: await page.locator('.stem-desk__row input[aria-label$=" gain"]').evaluateAll((n) => n.map((e) => e.value)),
      mutes: await page.locator('.stem-desk__row button[aria-label^="Mute "]').evaluateAll((n) => n.map((e) => e.getAttribute('aria-pressed'))),
    });

    // The musician's own mix first, so a restore is distinguishable from defaults.
    await crossfader.evaluate((el) => { el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('input[aria-label="A · Drums gain"]')
      .evaluate((el) => { el.value = '-6'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const mine = await state();

    record('Hear it is not offered until there is a suggestion', await hear.isDisabled(), '');
    await ask.click();
    record('asking changes nothing on the desk', JSON.stringify(await state()) === JSON.stringify(mine), '');

    // 1. Hear it
    await hear.click();
    const heard = await state();
    const expectedMutes = ['true', 'false', 'false', 'true', 'false', 'true', 'true', 'false'];
    record('Hear it puts the suggestion on the desk',
      JSON.stringify(heard.mutes) === JSON.stringify(expectedMutes) && heard.crossfader === '50', heard);
    record('the button now says Hear mine and Approve is ready',
      (await hear.innerText()) === 'Hear mine' && await approve.isEnabled(), '');
    record('nothing started playing by itself',
      !/Started 8 lanes/.test(await page.locator('.stem-desk__status').innerText()), '');
    await page.screenshot({ path: path.join(outDir, 'hear-it-1280.png'), fullPage: true }).catch(() => {});

    // 2. A fader move mid-audition is never put back
    await page.locator('input[aria-label="A · Bass gain"]')
      .evaluate((el) => { el.value = '-9'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await hear.click(); // Hear mine
    const flipped = await state();
    record('Hear mine brings back the musician mix except the fader they just moved',
      flipped.crossfader === '35' && flipped.mutes[0] === 'false'
        && flipped.gains[1] === '-6' && flipped.gains[2] === '-9', flipped);
    await hear.click(); // Hear it again

    // 3. Play, flip while playing, Stop
    const play = page.getByRole('button', { name: 'Play', exact: true });
    await play.click();
    let status = await page.locator('.stem-desk__status').innerText();
    for (let i = 0; i < 2 && !/Started 8 lanes/.test(status); i += 1) {
      await play.click();
      await sleep(600);
      status = await page.locator('.stem-desk__status').innerText();
    }
    record('Play starts the eight lanes on one clock', /Started 8 lanes on one clock/.test(status), status);
    await hear.click();
    await sleep(300);
    await hear.click();
    record('flipping while playing does not stop or restart the desk',
      !/Stem desk stopped/.test(await page.locator('.stem-desk__status').innerText()), '');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForStatus(page, /Stem desk stopped/);
    record('Stop still stops while a suggestion is on the desk', true, '');

    // 4. Keep
    await approve.click();
    const kept = await state();
    record('Approve keeps the suggestion and the musician tweak',
      JSON.stringify(kept.mutes) === JSON.stringify(expectedMutes) && kept.gains[2] === '-9'
        && /Proposal approved/.test(await proposalStatus.innerText()), kept);
    record('after keeping, Hear it is spent', await hear.isDisabled(), '');

    // 5. A second idea, then return
    await crossfader.evaluate((el) => { el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const mine2 = await state();
    await ask.click();
    await hear.click();
    await reject.click();
    record('Reject returns the mix exactly',
      JSON.stringify(await state()) === JSON.stringify(mine2)
        && /Back to your mix/.test(await proposalStatus.innerText()), await state());

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record('no horizontal overflow at 1280x900', overflow <= 1, `${overflow}px`);

    // Narrow viewport: the extra button must not break the Black Tie layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await ask.click();
    await hear.click();
    await page.locator('.stem-desk__proposal').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, 'hear-it-390.png'), fullPage: true }).catch(() => {});
    const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record('no horizontal overflow at 390x844', narrowOverflow <= 1, `${narrowOverflow}px`);
    await reject.click();
    record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'hear-it-ux.json'), JSON.stringify({ base, results }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  studio.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} Hear-it journey checks passed`);
process.exitCode = failed.length ? 1 : 0;
