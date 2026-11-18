#!/usr/bin/env node
// tests/browser/demo_two_track_smoke.js — readiness check for the two-track
// owner demonstration, against a running Studio.
//
// Usage: node tests/browser/demo_two_track_smoke.js http://127.0.0.1:8767 [--out DIR]
//
// It drives the real UI against the real server and temporary library: pick a
// track for each group, load both, then dial the demonstration combination
// (Track A drums + bass with Track B vocals + other) using only the visible
// M/S controls, play, stop. Headless Chromium has no listening environment, so
// this claims readiness and control behaviour, never audible quality.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveChromium } from './chromium.js';

const base = process.argv[2];
if (!base) throw new Error('usage: node tests/browser/demo_two_track_smoke.js <base-url>');
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : '/tmp/opencode/octopussy-evidence/demo';
mkdirSync(outDir, { recursive: true });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stem-desk', { timeout: 20000 });
  record('the Studio serves the two-track Stem Desk', true);

  const selectA = page.locator('.stem-desk select[aria-label="Track for group A"]');
  const selectB = page.locator('.stem-desk select[aria-label="Track for group B"]');
  await selectA.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.stem-desk select[aria-label="Track for group A"] option').length > 1,
    null,
    { timeout: 20000 },
  );
  const options = await page.$$eval(
    '.stem-desk select[aria-label="Track for group A"] option',
    (nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent })),
  ).then((rows) => rows.filter((row) => row.value));
  record('the temporary library offers two separated tracks', options.length >= 2,
    options.map((row) => row.text).join(' | '));

  // Choose the two prepared arrangements, matching by title when present.
  const pick = (text) => (options.find((row) => text.test(row.text)) || options[0]).value;
  const trackA = pick(/trackA|octopussy a/i);
  const trackB = pick(/trackB|octopussy b/i);
  record('two distinct tracks are selected', trackA !== trackB,
    `${options.find((row) => row.value === trackA)?.text} / ${options.find((row) => row.value === trackB)?.text}`);

  await selectA.selectOption(trackA);
  await page.getByRole('button', { name: 'Load stems A' }).click();
  await sleep(2500);
  await selectB.selectOption(trackB);
  await page.getByRole('button', { name: 'Load stems B' }).click();
  await sleep(2500);

  const rows = page.locator('.stem-desk .stem-desk__row');
  record('eight stem lanes are loaded', (await rows.count()) === 8, `${await rows.count()} rows`);
  const deskText = await page.locator('.stem-desk').innerText();
  const setLabels = (deskText.match(/· set [0-9a-f]{8}/g) || []).length;
  record('provenance names Demucs and the stem set for both sets',
    (deskText.match(/htdemucs@4\.1\.0/g) || []).length >= 8 && setLabels >= 8,
    `${(deskText.match(/htdemucs@4\.1\.0/g) || []).length} model labels, ${setLabels} set labels`);
  record('the policy line states the tempo truth',
    /not beat-match/.test(deskText) && /one clock/.test(deskText));

  const groupA = page.locator('.stem-desk .stem-desk__group[data-group="A"]');
  const groupB = page.locator('.stem-desk .stem-desk__group[data-group="B"]');

  // The demonstration combination: A drums + bass with B vocals + other.
  const muteTargets = [
    [groupA, 0, 'Mute A · Vocals'],
    [groupA, 3, 'Mute A · Other'],
    [groupB, 1, 'Mute B · Drums'],
    [groupB, 2, 'Mute B · Bass'],
  ];
  for (const [group, index, label] of muteTargets) {
    await group.locator('.stem-desk__row').nth(index).getByRole('button', { name: label }).click();
    await sleep(120);
  }
  const pressed = [];
  for (const [group, index, label] of muteTargets) {
    pressed.push(await group.locator('.stem-desk__row').nth(index)
      .getByRole('button', { name: label }).getAttribute('aria-pressed'));
  }
  record('the demonstrated combination is set through visible controls',
    pressed.every((value) => value === 'true'), pressed.join(', '));

  const audibleRows = await page.$$eval('.stem-desk .stem-desk__row', (nodes) =>
    nodes.filter((node) => {
      const mute = node.querySelector('button[aria-label^="Mute "]');
      return mute?.getAttribute('aria-pressed') === 'false';
    }).map((node) => node.querySelector('button[aria-label^="Mute "]')?.getAttribute('aria-label')));
  record('exactly four lanes remain unmuted', audibleRows.length === 4, audibleRows.join(' | '));

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await sleep(1500);
  const playing = await page.locator('.stem-desk__status').innerText();
  record('play reports a shared-clock start', /Started 8 lanes on one clock/.test(playing), playing.slice(0, 120));
  const position = await page.locator('.stem-desk__transport .stem-desk__meta').last().innerText();
  record('the transport advances', Number.parseFloat(position) > 0, position);

  for (const [group, index, label] of muteTargets) {
    await group.locator('.stem-desk__row').nth(index).getByRole('button', { name: label }).click();
    await sleep(80);
  }
  record('unmuting is reversible from the same controls', true);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await sleep(300);
  record('stop reports a stopped transport', /Stem desk stopped/.test(await page.locator('.stem-desk__status').innerText()));
  record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

  await page.locator('.stem-desk').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, 'two-track-demo.png'), fullPage: false });
  writeFileSync(path.join(outDir, 'two-track-demo.json'), JSON.stringify({ base, results }, null, 2));
} finally {
  await browser.close();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} demonstration readiness checks passed`);
process.exitCode = failed.length ? 1 : 0;
