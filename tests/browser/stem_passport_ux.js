#!/usr/bin/env node
// tests/browser/stem_passport_ux.js — real-browser journey for importing stems.
//
// Drives the Studio UI against a seeded temporary library:
//   1. selects a library track with no stems in group A,
//   2. opens "Import My Stems", names the four roles and supplies four WAVs,
//   3. confirms the imported provenance and that no separation job was created,
//   4. loads imported A beside Demucs B, and exercises the desk controls.
//
// Seed first: tests/browser/stem_passport_seed.py --data-dir <dir>
// Usage: node tests/browser/stem_passport_ux.js --data-dir <dir> [--out DIR]

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
  console.error('usage: node tests/browser/stem_passport_ux.js --data-dir <seeded dir>');
  process.exit(2);
}
const fixtureDir = value('--fixture', `${dataDir}-fixture`);

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
const log = [];
studio.stdout.on('data', (chunk) => log.push(chunk.toString()));
studio.stderr.on('data', (chunk) => log.push(chunk.toString()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (studio.exitCode !== null) throw new Error(`studio exited: ${log.join('')}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`studio did not start: ${log.join('')}`);
    await sleep(200);
  }

  const tracks = (await (await fetch(`${base}/api/tracks?limit=20`)).json()).items;
  const byTitle = (needle) => tracks.find((t) => (t.title || t.name || '').includes(needle));
  const trackA = byTitle('arrangement-a');
  const trackB = byTitle('arrangement-b');
  const trackC = byTitle('arrangement-c');
  if (!trackA || !trackB || !trackC) throw new Error('seeded tracks are missing');

  const jobsBefore = (await (await fetch(`${base}/api/jobs`)).json()).items || [];

  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/#/studio`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stem-desk', { timeout: 20000 });

    const selectA = page.locator('.stem-desk select[aria-label="Track for group A"]');
    await selectA.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.stem-desk select[aria-label="Track for group A"] option').length > 1,
      null,
      { timeout: 20000 },
    );
    await selectA.selectOption(trackC.id);
    await sleep(400);

    await page.locator('.source-options summary').first().click();
    const importButton = page.getByRole('button', { name: 'Import My Stems for group A' });
    record('the desk offers an Import My Stems action', (await importButton.count()) === 1);
    await importButton.click();
    const dialog = page.locator('#dialog-layer dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    record('the import dialog names the four roles',
      (await dialog.getByText('Vocals', { exact: true }).count()) >= 1
      && (await dialog.getByText('Drums', { exact: true }).count()) >= 1
      && (await dialog.getByText('Bass', { exact: true }).count()) >= 1
      && (await dialog.getByText('Other', { exact: true }).count()) >= 1);
    const note = await dialog.innerText();
    record('the dialog states the alignment responsibility',
      /aligned|same start|one timeline/i.test(note) && /not proof of alignment/i.test(note));

    for (const role of ['vocals', 'drums', 'bass', 'other']) {
      await dialog.locator(`input[aria-label="${role[0].toUpperCase()}${role.slice(1)} file"]`)
        .setInputFiles(path.join(fixtureDir, 'c', `${role}.wav`));
    }
    await dialog.getByRole('button', { name: 'Import four stems' }).click();
    let importedOk = false;
    let importDetail = '';
    for (let i = 0; i < 120; i += 1) {
      const deskText = await page.locator('.stem-desk__status').innerText();
      const dialogText = (await dialog.count())
        ? await dialog.innerText().catch(() => '')
        : '';
      // The readiness message may immediately replace the import message.
      if (/Imported four|imported stems are ready/i.test(deskText)) {
        importedOk = true; importDetail = deskText; break;
      }
      if (/Could not import/.test(dialogText)) { importDetail = dialogText.split('\n').at(-1); break; }
      await sleep(250);
    }
    record('the import reports success in the desk', importedOk, importDetail);

    const stems = (await (await fetch(`${base}/api/tracks/${trackC.id}/stems`)).json()).variants
      .filter((v) => ['vocals', 'drums', 'bass', 'other'].includes(v.name));
    record('the imported set is attached with honest provenance',
      stems.length === 4 && stems.every((v) => v.method === 'imported' && v.original_name),
      stems.map((v) => `${v.name}:${v.method}`).join(' '));

    const jobsAfter = (await (await fetch(`${base}/api/jobs`)).json()).items || [];
    record('importing created no separation job', jobsAfter.length === jobsBefore.length,
      `${jobsBefore.length} -> ${jobsAfter.length}`);

    // Load imported C in A and Demucs B in B, then exercise the controls.
    await page.getByRole('button', { name: 'Load stems A' }).click();
    await sleep(2500);
    const selectB = page.locator('.stem-desk select[aria-label="Track for group B"]');
    await selectB.selectOption(trackB.id);
    await sleep(400);
    await page.getByRole('button', { name: 'Load stems B' }).click();
    await sleep(2500);

    const rows = page.locator('.stem-desk .stem-desk__row');
    record('eight lanes load from an imported set and a Demucs set', (await rows.count()) === 8,
      `${await rows.count()} rows`);
    const deskText = await page.locator('.stem-desk').innerText();
    record('imported provenance is shown without a model claim',
      /imported · set [0-9a-f]{8}/.test(deskText) && !/htdemucs.*imported/i.test(deskText));
    record('the Demucs group still names its model', /htdemucs@4\.1\.0/.test(deskText));

    const groupA = page.locator('.stem-desk .stem-desk__group[data-group="A"]');
    const groupB = page.locator('.stem-desk .stem-desk__group[data-group="B"]');
    await groupA.locator('.stem-desk__row').nth(2).getByRole('button', { name: 'Mute A · Bass' }).click();
    await sleep(200);
    record('an imported lane mutes independently',
      (await groupA.locator('.stem-desk__row').nth(2)
        .getByRole('button', { name: 'Mute A · Bass' }).getAttribute('aria-pressed')) === 'true');
    await groupB.locator('.stem-desk__row').nth(0).getByRole('button', { name: 'Solo B · Vocals' }).click();
    await sleep(200);
    record('a Demucs lane solos across both tracks',
      (await groupB.locator('.stem-desk__row').nth(0)
        .getByRole('button', { name: 'Solo B · Vocals' }).getAttribute('aria-pressed')) === 'true');

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await sleep(1200);
    record('the mixed imported/Demucs performance starts',
      /Started 8 lanes on one clock/.test(await page.locator('.stem-desk__status').innerText()));
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await sleep(300);
    record('stop reports a stopped transport',
      /Stem desk stopped/.test(await page.locator('.stem-desk__status').innerText()));

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record('no horizontal overflow at 1280x800', overflow <= 1, `${overflow}px`);
    record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

    mkdirSync(outDir, { recursive: true });
    await page.locator('.stem-desk').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, 'stem-passport.png') });
    writeFileSync(path.join(outDir, 'stem-passport-ux.json'), JSON.stringify({ base, results }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  studio.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} import-journey checks passed`);
process.exitCode = failed.length ? 1 : 0;
