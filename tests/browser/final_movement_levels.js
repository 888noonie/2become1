#!/usr/bin/env node
// THE FINAL MOVEMENT — Draw levels in real Chromium against a seeded loopback
// Studio. Real mouse and keyboard; page state is only READ.
//   node tests/browser/final_movement_levels.js <studio-url> <out-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base = 'http://127.0.0.1:8795', outDir = 'final-movement-out'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`); };
const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true, args: ['--disable-audio-output', '--mute-audio'] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--A select[aria-label^="Track"] option').length > 1);
  const value = await page.$eval('.daw__import-row--A select[aria-label^="Track"]', (s) => [...s.options].find((o) => o.text.includes('Midnight'))?.value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Track"]', value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Section length"]', '30');
  await page.click('.daw__bring--A');
  await page.waitForFunction(() => !document.querySelector('.daw__bring--A').disabled, null, { timeout: 120000 });
  const st = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const clips0 = JSON.stringify((await st()).clips);
  check('four stems on lanes', (await st()).clips.length === 4);
  const lane = page.locator('.daw__lane[data-track="1"]');
  await lane.scrollIntoViewIfNeeded();
  const box = await lane.boundingBox();
  const at = (fx, fy) => [box.x + fx, box.y + fy];

  // Off: a drag across a clip moves the clip, never a point.
  const toggle = page.getByRole('button', { name: 'Draw levels' });
  check('Draw levels starts off', (await toggle.getAttribute('aria-pressed')) === 'false');
  await page.keyboard.press('g');
  check('G turns it on', (await toggle.getAttribute('aria-pressed')) === 'true');
  const pts = async () => (await st()).tracks[1].gainPoints ?? [];
  await page.mouse.click(...at(120, 40));
  await page.mouse.click(...at(300, 20));
  check('two clicks over the clip add two points', (await pts()).length === 2, await pts());
  check('clip untouched by adding', JSON.stringify((await st()).clips) === clips0);
  const readout = await page.locator('.daw__env-readout').first().textContent();
  check('readout names bar and dB', /dB/.test(readout), readout);
  await page.screenshot({ path: join(outDir, 'desktop-draw-levels.png') });
  const before = (await pts()).map((p) => ({ ...p }));
  const h = await page.locator('.daw__lane[data-track="1"] [data-env-point]').first().boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 90, h.y + 10, { steps: 6 });
  await page.mouse.up();
  const after = await pts();
  check('dragging a point moves the point', after.some((p, i) => p.beat !== before[i].beat || p.db !== before[i].db), { before, after });
  check('clip untouched by dragging', JSON.stringify((await st()).clips) === clips0);
  await page.keyboard.press('ArrowUp');
  check('focus stayed on the point for keyboard edits', (await pts()).some((p, i) => p.db !== after[i].db));
  await page.keyboard.press('Delete');
  check('Delete removes the point', (await pts()).length === 1);
  await page.keyboard.press('Control+z');
  check('Undo restores it', (await pts()).length === 2);
  await page.keyboard.press('g');
  check('G turns it off', (await toggle.getAttribute('aria-pressed')) === 'false');
  // Reload-safe: serialize through the edit API.
  const saved = await page.evaluate(() => window.__arrangement.session.edit.serialize());
  check('points are in the serialized project', saved.includes('gainPoints') || saved.includes('"points"'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.locator('.daw__lane[data-track="1"]').scrollIntoViewIfNeeded();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no page-level horizontal overflow at 390 px', over <= 0, over);
  const tb = await toggle.boundingBox();
  check('Draw levels target is usable on a phone', tb && tb.height >= 32, tb);
  await page.screenshot({ path: join(outDir, 'mobile.png') });
  check('no page errors', errors.length === 0, errors);
} finally { await browser.close(); }
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
