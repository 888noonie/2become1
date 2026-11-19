#!/usr/bin/env node
// tests/browser/for_your_ears_ux.js — real-browser owner journey.
//
// Drives the Studio as the owner would:
//   1. Library shows two meaningful names.
//   2. Rename one track from the Library; confirm it persists across a reload
//      and in the API.
//   3. Stem Desk: load group A and group B as 60 s sections.
//   4. Eight lanes, honest provenance, independent mute/solo/gain.
//   5. Entry nudge moves a whole group and is announced on Play.
//   6. AI Producer: preview, reject with no mutation, approve with the exact
//      permitted changes.
//   7. Negative controls: a solo-held proposal is refused; a section past the
//      end is refused without disturbing the loaded desk.
//
// Usage:
//   node tests/browser/for_your_ears_ux.js --data-dir /var/tmp/fye/demo [--out DIR]

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
  console.error('usage: node tests/browser/for_your_ears_ux.js --data-dir <seeded dir>');
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
  const byName = (needle) => tracks.find((t) => (t.name || '').includes(needle));
  const trackA = byName('Midnight Circuit');
  const trackB = byName('Paper Lanterns');
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

    // ---- 1-2. Library names and a persistent rename ---------------------
    await page.goto(`${base}/#/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.track-card', { timeout: 20_000 });
    const libraryText = await page.locator('.library-list, main').first().innerText();
    record('the Library shows both meaningful names',
      /Midnight Circuit/.test(libraryText) && /Paper Lanterns/.test(libraryText),
      libraryText.split('\n').filter((line) => /Circuit|Lantern/.test(line)).join(' | '));

    const card = page.locator(`.track-card[data-track-id="${trackB.id}"]`);
    await card.locator('button[data-action="rename"]').click();
    const dialog = page.locator('#dialog-layer dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('input[aria-label="New name"]').fill('Paper Lanterns (Late Set)');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(
      (id) => document.querySelector(`.track-card[data-track-id="${id}"] .track-card__title`)?.textContent
        === 'Paper Lanterns (Late Set)',
      trackB.id,
      { timeout: 15_000 },
    );
    record('the Library rename updates the card', true, 'Paper Lanterns (Late Set)');

    const afterRename = (await (await fetch(`${base}/api/tracks/${trackB.id}`)).json());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.track-card', { timeout: 20_000 });
    const reloadedTitle = await page.locator(
      `.track-card[data-track-id="${trackB.id}"] .track-card__title`,
    ).innerText();
    record('the rename persists in the API and after a reload',
      afterRename.name === 'Paper Lanterns (Late Set)' && reloadedTitle === 'Paper Lanterns (Late Set)',
      { api: afterRename.name, reloaded: reloadedTitle });

    // ---- 3-4. load both groups as sections ------------------------------
    await page.goto(`${base}/#/studio`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stem-desk', { timeout: 20_000 });
    const selectA = page.locator('.stem-desk select[aria-label="Track for group A"]');
    const selectB = page.locator('.stem-desk select[aria-label="Track for group B"]');
    await selectA.click(); // focus/pointerdown is what asks the desk for the library list
    await page.waitForFunction(
      () => document.querySelectorAll('.stem-desk select[aria-label="Track for group A"] option').length > 1,
      null,
      { timeout: 20_000 },
    );
    const defaultSection = await page.locator('select[aria-label="Section for group A"]').inputValue();
    record('the default load mode is a section, not the full-length opt-in',
      defaultSection !== 'full' && ['30', '60', '90'].includes(defaultSection),
      { defaultSection });

    await selectA.selectOption(trackA.id);
    await page.locator('select[aria-label="Section for group A"]').selectOption('60');
    await page.locator('input[aria-label="Section start in seconds for group A"]').fill('60');
    await page.getByRole('button', { name: 'Load stems A' }).click();
    await waitForStatus(page, /Loaded 4 stems into group A/);
    record('group A loads a 60 s section', true, await page.locator('.stem-desk__status').innerText());

    await selectB.selectOption(trackB.id);
    await page.locator('select[aria-label="Section for group B"]').selectOption('60');
    await page.locator('input[aria-label="Section start in seconds for group B"]').fill('60');
    await page.getByRole('button', { name: 'Load stems B' }).click();
    await waitForStatus(page, /Loaded 4 stems into group B/);

    const rows = page.locator('.stem-desk .stem-desk__row');
    record('eight lanes are loaded from two imported sets', (await rows.count()) === 8,
      `${await rows.count()} rows`);
    const deskText = await page.locator('.stem-desk').innerText();
    record('provenance names the imported sets, never a model',
      (deskText.match(/imported · set [0-9a-f]{8}/g) || []).length === 8
        && !/imported[^\n]*demucs/i.test(deskText),
      { importedLabels: (deskText.match(/imported · set [0-9a-f]{8}/g) || []).length });

    // ---- 5. independent controls and entry nudge ------------------------
    const groupA = page.locator('.stem-desk__group[data-group="A"]');
    const groupB = page.locator('.stem-desk__group[data-group="B"]');
    await groupA.locator('.stem-desk__row').nth(2).getByRole('button', { name: 'Mute A · Bass' }).click();
    const mutePressed = await groupA.locator('.stem-desk__row').nth(2)
      .getByRole('button', { name: 'Mute A · Bass' }).getAttribute('aria-pressed');
    await groupA.locator('.stem-desk__row').nth(2).getByRole('button', { name: 'Mute A · Bass' }).click();
    await groupB.locator('.stem-desk__row').nth(0).getByRole('button', { name: 'Solo B · Vocals' }).click();
    const soloPressed = await groupB.locator('.stem-desk__row').nth(0)
      .getByRole('button', { name: 'Solo B · Vocals' }).getAttribute('aria-pressed');
    await groupB.locator('.stem-desk__row').nth(0).getByRole('button', { name: 'Solo B · Vocals' }).click();
    record('mute and solo act on one lane at a time',
      mutePressed === 'true' && soloPressed === 'true',
      { mutePressed, soloPressed });

    await page.locator('input[aria-label="A · Drums gain"]')
      .evaluate((el) => { el.value = '-6'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const gainValue = await page.locator('input[aria-label="A · Drums gain"]').inputValue();
    record('an individual lane gain is independent', gainValue === '-6', { gainValue });

    await page.getByRole('button', { name: 'Group A earlier' }).click();
    await page.getByRole('button', { name: 'Group A earlier' }).click();
    await page.getByRole('button', { name: 'Group B later' }).click();
    await page.getByRole('button', { name: 'Group B later' }).click();
    const offsetA = await groupA.locator('.stem-desk__offset').innerText();
    const offsetB = await groupB.locator('.stem-desk__offset').innerText();
    record('the entry nudge moves a whole group in signed steps',
      /20 ms/.test(offsetA) && /\+20 ms/.test(offsetB),
      { A: offsetA, B: offsetB });

    const play = page.getByRole('button', { name: 'Play', exact: true });
    await play.click();
    let playStatus = await page.locator('.stem-desk__status').innerText();
    for (let i = 0; i < 2 && !/Started 8 lanes/.test(playStatus); i += 1) {
      await play.click();
      await sleep(600);
      playStatus = await page.locator('.stem-desk__status').innerText();
    }
    record('play starts eight lanes on one clock and announces the nudge',
      /Started 8 lanes on one clock/.test(playStatus)
        && /Entry Group A .*20 ms, Group B .*20 ms/.test(playStatus),
      playStatus);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForStatus(page, /Stem desk stopped/);

    // ---- 6. proposal: reject, then approve ------------------------------
    const ask = page.getByRole('button', { name: 'Ask for a proposal' });
    const preview = page.getByRole('button', { name: 'Preview', exact: true });
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    const proposalStatus = page.locator('.stem-desk__proposal-status');

    await page.locator('input[aria-label="Crossfader A to B"]')
      .evaluate((el) => { el.value = '80'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await ask.click();
    await preview.click();
    const previewText = await proposalStatus.innerText();
    record('a proposal is preview-only until approved',
      /Preview only/.test(previewText) && /Nothing is applied until Approve/.test(previewText),
      previewText);

    const snapshot = async () => ({
      crossfader: await page.locator('input[aria-label="Crossfader A to B"]').inputValue(),
      offsets: [await groupA.locator('.stem-desk__offset').innerText(), await groupB.locator('.stem-desk__offset').innerText()],
      gains: await page.locator('.stem-desk__row input[aria-label$=" gain"]').evaluateAll((nodes) => nodes.map((n) => n.value)),
      mutes: await page.locator('.stem-desk__row button[aria-label^="Mute "]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-pressed'))),
      levels: await page.locator('input[aria-label^="Group "][aria-label$=" level"]').evaluateAll((nodes) => nodes.map((n) => n.value)),
    });
    const beforeReject = await snapshot();
    await reject.click();
    const afterReject = await snapshot();
    record('rejecting a proposal mutates nothing',
      JSON.stringify(beforeReject) === JSON.stringify(afterReject),
      { unchanged: true, crossfader: afterReject.crossfader, offsets: afterReject.offsets });
    record('the rejected proposal says it is not approved',
      /Proposal not approved/.test(await proposalStatus.innerText()),
      await proposalStatus.innerText());

    await ask.click();
    await preview.click();
    await approve.click();
    await page.waitForFunction(
      () => /Proposal approved/.test(document.querySelector('.stem-desk__proposal-status')?.textContent || ''),
      null,
      { timeout: 15_000 },
    );
    const crossfader = await page.locator('input[aria-label="Crossfader A to B"]').inputValue();
    const offsetsAfter = [
      await groupA.locator('.stem-desk__offset').innerText(),
      await groupB.locator('.stem-desk__offset').innerText(),
    ];
    const levelsAfter = await page.locator('input[aria-label^="Group "][aria-label$=" level"]')
      .evaluateAll((nodes) => nodes.map((n) => n.value));
    const gainsAfter = await page.locator('.stem-desk__row input[aria-label$=" gain"]')
      .evaluateAll((nodes) => nodes.map((n) => n.value));
    const mutesAfter = await page.locator('.stem-desk__row button[aria-label^="Mute "]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-pressed')));
    // Eight rows are ordered A vocals, drums, bass, other, then B ...
    const expectedMutes = ['true', 'false', 'false', 'true', 'false', 'true', 'true', 'false'];
    record('approval applies exactly the permitted changes',
      crossfader === '50'
        && offsetsAfter.every((text) => text === '0 ms')
        && levelsAfter.every((v) => v === '0')
        && gainsAfter.every((v) => v === '0')
        && JSON.stringify(mutesAfter) === JSON.stringify(expectedMutes),
      { crossfader, offsetsAfter, levelsAfter, gainsAfter, mutesAfter });

    const approvedPlay = page.getByRole('button', { name: 'Play', exact: true });
    await approvedPlay.click();
    await sleep(800);
    let approvedStatus = await page.locator('.stem-desk__status').innerText();
    for (let i = 0; i < 2 && !/Started 8 lanes/.test(approvedStatus); i += 1) {
      await approvedPlay.click();
      await sleep(600);
      approvedStatus = await page.locator('.stem-desk__status').innerText();
    }
    record('the approved arrangement plays on the same eight lanes',
      /Started 8 lanes on one clock/.test(approvedStatus),
      approvedStatus);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForStatus(page, /Stem desk stopped/);
    mkdirSync(outDir, { recursive: true });
    await page.locator('.stem-desk').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, 'stem-desk.png'), fullPage: true });

    // ---- 7. negative controls ------------------------------------------
    await groupB.locator('.stem-desk__row').nth(0).getByRole('button', { name: 'Solo B · Vocals' }).click();
    await ask.click();
    const soloRefusal = await proposalStatus.innerText();
    record('a proposal is refused while a lane is soloed',
      /clear solo/i.test(soloRefusal),
      soloRefusal);
    await groupB.locator('.stem-desk__row').nth(0).getByRole('button', { name: 'Solo B · Vocals' }).click();

    await page.locator('input[aria-label="Section start in seconds for group A"]').fill('999');
    await page.getByRole('button', { name: 'Load stems A' }).click();
    const pastEnd = await waitForStatus(page, /could not be reloaded|was refused/i, 60_000);
    record('a section past the end is refused and the loaded desk is not disturbed',
      /could not be reloaded/i.test(pastEnd) && /past the end/i.test(pastEnd)
        && (await rows.count()) === 8,
      { status: pastEnd, rows: await rows.count() });
    // Put the desk back on the musical section for the PM.
    await page.locator('input[aria-label="Section start in seconds for group A"]').fill('60');
    await page.getByRole('button', { name: 'Load stems A' }).click();
    await waitForStatus(page, /Loaded 4 stems into group A/);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record('no horizontal overflow at 1280x900', overflow <= 1, `${overflow}px`);
    record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

    mkdirSync(outDir, { recursive: true });
    await page.goto(`${base}/#/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.track-card', { timeout: 20_000 });
    await page.screenshot({ path: path.join(outDir, 'library.png'), fullPage: true });
    writeFileSync(
      path.join(outDir, 'for-your-ears-ux.json'),
      JSON.stringify({ base, results }, null, 2),
    );
  } finally {
    await browser.close();
  }
} finally {
  studio.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} owner-journey checks passed`);
process.exitCode = failed.length ? 1 : 0;
