// tests/browser/demo_smoke.js — transient demonstration readiness check.
//
// Usage: node tests/browser/demo_smoke.js http://127.0.0.1:8766
//
// Drives the real Studio, against a temporary data directory, through the real
// Stem Performance Desk UI. It makes no claim about audible output: headless
// Chromium has no listening environment.
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const base = process.argv[2];
if (!base) throw new Error('usage: node tests/browser/demo_smoke.js <base-url>');

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stem-desk', { timeout: 15000 });
  record('Studio shell renders the Stem Performance Desk', true);

  const select = await page.$('.stem-desk__select');
  await select.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.stem-desk__select option').length > 0,
    null,
    { timeout: 10000 },
  );
  const options = await page.$$eval('.stem-desk__select option', (nodes) =>
    nodes.map((n) => ({ value: n.value, text: n.textContent })),
  );
  record('the temporary library offers a separated track', options.length > 0, `${options.length} track option(s)`);

  await page.selectOption('.stem-desk__select', options[0].value);
  await page.click('.stem-desk button:has-text("Load stems")');
  await page.waitForSelector('.stem-desk__row', { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.stem-desk__row').length === 4,
    null,
    { timeout: 20000 },
  );

  const lanes = await page.$$eval('.stem-desk__row', (rows) =>
    rows.map((row) => ({
      name: row.querySelector('.stem-desk__name')?.textContent,
      provenance: row.querySelector('.stem-desk__meta')?.textContent,
    })),
  );
  record('four stem lanes load together', lanes.length === 4, lanes.map((l) => l.name).join(', '));
  const expected = ['vocals', 'drums', 'bass', 'other'];
  record(
    'lane names are the four Demucs stems',
    expected.every((name) => lanes.some((lane) => lane.name?.toLowerCase() === name)),
  );
  record(
    'provenance names the real model',
    lanes.every((lane) => /htdemucs/i.test(lane.provenance || '')),
    lanes[0]?.provenance,
  );

  await page.click('button[aria-label="Mute Drums"]');
  record(
    'mute toggles pressed state',
    (await page.getAttribute('button[aria-label="Mute Drums"]', 'aria-pressed')) === 'true',
  );
  await page.click('button[aria-label="Solo Vocals"]');
  record(
    'solo toggles pressed state',
    (await page.getAttribute('button[aria-label="Solo Vocals"]', 'aria-pressed')) === 'true',
  );

  const gain = await page.$('input[aria-label="Bass gain"]');
  await gain.evaluate((node) => {
    node.value = '-12';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const bassGain = await page.$$eval('.stem-desk__row', (rows) => {
    const row = rows.find((r) => r.querySelector('.stem-desk__name')?.textContent?.toLowerCase() === 'bass');
    return row ? [...row.querySelectorAll('.stem-desk__meta')].map((n) => n.textContent).join(' | ') : '';
  });
  record('bass gain reports -12 dB', bassGain.includes('-12 dB'), bassGain);

  await page.click('.stem-desk button:has-text("Play")');
  await page.waitForTimeout(1200);
  const position = await page.textContent('.stem-desk__meta');
  record('transport advances while playing', position !== '0.0 s', position.trim());
  const status = await page.textContent('.stem-desk__status');
  record('transport reports a truthful state', /Playing|blocking audio/.test(status), status.trim());

  await page.click('.stem-desk button:has-text("Stop")');
  await page.waitForTimeout(300);
  const stopped = await page.textContent('.stem-desk__meta');
  record('stop resets the position', stopped.trim() === '0.0 s', stopped.trim());
  record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

  await page.screenshot({ path: '/tmp/opencode/evidence/demo-smoke-1280x900.png', fullPage: false });
} finally {
  await browser.close();
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
