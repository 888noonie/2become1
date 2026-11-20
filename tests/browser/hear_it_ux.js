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

    // Watch the real Web Audio automation the desk uses: how far ahead of the
    // context clock each gain ramp ends, and whether any gain is ramped at all.
    await page.addInitScript(() => {
      window.__ramps = [];
      const create = BaseAudioContext.prototype.createGain;
      BaseAudioContext.prototype.createGain = function patched(...args) {
        window.__ctx = this;
        const node = create.apply(this, args);
        (window.__gains ||= []).push(node);
        return node;
      };
      window.__starts = 0;
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function patched(...args) {
        window.__starts += 1;
        return start.apply(this, args);
      };
      const ramp = AudioParam.prototype.linearRampToValueAtTime;
      AudioParam.prototype.linearRampToValueAtTime = function patched(value, when) {
        window.__ramps.push({ value, seconds: when - (window.__ctx?.currentTime ?? 0) });
        return ramp.call(this, value, when);
      };
    });
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
    const keep = page.locator('.stem-desk__proposal button').nth(3); // Approve / Keep it / Keep mine / Undo
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    const proposalStatus = page.locator('.stem-desk__proposal-status');
    const crossfader = page.locator('input[aria-label="Crossfader A to B"]');
    const setGain = (label, value) => page.locator(`input[aria-label="${label} gain"]`)
      .evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    const state = async () => ({
      crossfader: await crossfader.inputValue(),
      gains: await page.locator('.stem-desk__row input[aria-label$=" gain"]').evaluateAll((n) => n.map((e) => e.value)),
      mutes: await page.locator('.stem-desk__row button[aria-label^="Mute "]').evaluateAll((n) => n.map((e) => e.getAttribute('aria-pressed'))),
    });
    const starts = () => page.evaluate(() => window.__starts);
    const silentGains = () => page.evaluate(() => window.__gains.filter((node) => node.gain.value === 0).length);
    const near = (value) => page.evaluate((v) => window.__gains.some((node) => Math.abs(node.gain.value - v) < 1e-3), value);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const SUGGESTED = ['true', 'false', 'false', 'true', 'false', 'true', 'true', 'false'];

    // The musician's own mix first, so a return is distinguishable from defaults.
    await crossfader.evaluate((el) => { el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await setGain('A · Drums', '-6');
    const mine = await state();

    record('Hear it is not offered until there is a suggestion', await hear.isDisabled(), '');
    await ask.click();
    record('asking changes nothing on the desk', same(await state(), mine), '');

    // Idea → Hear
    await hear.click();
    const heard = await state();
    record('Hear it puts the suggestion on the desk',
      same(heard.mutes, SUGGESTED) && heard.crossfader === '50', heard);
    record('the buttons read Hear mine and Keep it',
      (await hear.innerText()) === 'Hear mine' && (await keep.innerText()) === 'Keep it', '');
    record('nothing plays by itself when an idea is applied', (await starts()) === 0, '');
    await page.screenshot({ path: path.join(outDir, 'desk-1280-hearing.png'), fullPage: true });

    // Adjust, compare
    await setGain('A · Bass', '-9');
    await hear.click(); // Hear mine
    const flipped = await state();
    record('Hear mine brings back the musician mix and keeps the fader they just moved',
      flipped.crossfader === '35' && flipped.mutes.every((m) => m === 'false')
        && flipped.gains[1] === '-6' && flipped.gains[2] === '-9', flipped);
    record('the keep button now reads Keep mine', (await keep.innerText()) === 'Keep mine', '');
    record('on a stopped desk flips are plain assignments, not ramps',
      (await page.evaluate(() => window.__ramps.length)) === 0, '');
    await hear.click(); // Hear it

    // Rapid A/B while playing
    const play = page.getByRole('button', { name: 'Play', exact: true });
    await play.click();
    let status = await page.locator('.stem-desk__status').innerText();
    for (let i = 0; i < 2 && !/Started 8 lanes/.test(status); i += 1) {
      await play.click();
      await sleep(600);
      status = await page.locator('.stem-desk__status').innerText();
    }
    record('Play (pressed by the musician) starts eight lanes on one clock', /Started 8 lanes on one clock/.test(status), status);
    const startsWhilePlaying = await starts();
    await page.evaluate(() => { window.__ramps.length = 0; });
    const FLIPS = 6;
    await page.evaluate((n) => {
      const button = [...document.querySelectorAll('.stem-desk__proposal button')].find((b) => /^Hear (it|mine)$/.test(b.textContent));
      for (let i = 0; i < n; i += 1) button.click(); // all inside one glide window
    }, FLIPS);
    await sleep(300);
    const ramps = await page.evaluate(() => window.__ramps.slice());
    record('rapid flipping while playing: every ramp is 40 ms of the audio clock, at most one per gain per flip',
      ramps.length > 0 && ramps.length <= FLIPS * 10 && ramps.every((r) => Math.abs(r.seconds - 0.04) < 1e-6),
      { flips: FLIPS, ramps: ramps.length, perFlip: ramps.length / FLIPS });
    record('after rapid flipping the gains land on the suggestion (four muted lanes)',
      (await silentGains()) === 4 && (await hear.innerText()) === 'Hear mine', { silent: await silentGains() });
    record('flipping restarts no source', (await starts()) === startsWhilePlaying, '');

    // A manual move during an unfinished glide wins
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.stem-desk__proposal button')].find((b) => /^Hear (it|mine)$/.test(b.textContent));
      button.click(); // glide toward my mix …
      const other = document.querySelector('input[aria-label="A · Other gain"]');
      other.value = '-12'; // … and grab a fader before it finishes
      other.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    record('a fader moved mid-glide lands where the musician put it',
      await near(10 ** (-12 / 20)), { expectedLinear: 10 ** (-12 / 20) });

    // Stop during a transition
    await page.evaluate(() => {
      [...document.querySelectorAll('.stem-desk__proposal button')].find((b) => /^Hear (it|mine)$/.test(b.textContent)).click();
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Stop').click();
    });
    await waitForStatus(page, /Stem desk stopped/);
    record('Stop during a transition stops at once', (await hear.innerText()) === 'Hear mine', '');
    // A stopped graph does not render, so its gains are not read here; the
    // musician's next Play must sound exactly what the desk shows.
    await play.click();
    await sleep(400);
    record('the next Play after that Stop sounds what is shown (four muted lanes)',
      (await silentGains()) === 4, { silent: await silentGains() });
    await stop.click();
    await waitForStatus(page, /Stem desk stopped/);
    const startsAfterStop = await starts();

    // Keep it → Undo
    await keep.click();
    const kept = await state();
    record('Keep it keeps the suggestion with both of the musician fader moves',
      same(kept.mutes, SUGGESTED) && kept.gains[2] === '-9' && kept.gains[3] === '-12'
        && /Kept the suggestion/.test(await proposalStatus.innerText()), kept);
    record('the same button now offers Undo', (await keep.innerText()) === 'Undo' && await hear.isDisabled(), '');
    await setGain('B · Vocals', '-4');
    await keep.click(); // Undo
    const undone = await state();
    record('Undo returns the mix from before the idea and leaves every musician move',
      undone.crossfader === '35' && undone.mutes.every((m) => m === 'false')
        && undone.gains[1] === '-6' && undone.gains[2] === '-9' && undone.gains[3] === '-12' && undone.gains[4] === '-4',
      undone);
    record('keeping and undoing never start playback', (await starts()) === startsAfterStop, '');

    // Hear mine → Keep mine never applies the unheard suggestion
    const before = await state();
    await ask.click();
    await hear.click();
    await hear.click(); // Hear mine
    await keep.click(); // Keep mine
    record('Keep mine keeps exactly the mix being heard',
      same(await state(), before) && /Kept your mix/.test(await proposalStatus.innerText()), await state());
    record('after Keep mine there is nothing to undo', (await keep.innerText()) === 'Approve' && await keep.isDisabled(), '');

    // Reject
    await ask.click();
    await hear.click();
    await reject.click();
    record('Reject returns the mix exactly',
      same(await state(), before) && /Back to your mix/.test(await proposalStatus.innerText()), '');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record('no horizontal overflow at 1280x900', overflow <= 1, `${overflow}px`);

    // Phone width: same journey, Black Tie layout intact.
    await page.setViewportSize({ width: 390, height: 844 });
    await ask.click();
    await hear.click();
    await page.locator('.stem-desk__producer').scrollIntoViewIfNeeded();
    await page.locator('.stem-desk__producer').screenshot({ path: path.join(outDir, 'producer-390-hearing.png') });
    await keep.click();
    await page.locator('.stem-desk__producer').screenshot({ path: path.join(outDir, 'producer-390-undo.png') });
    const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record('no horizontal overflow at 390x844', narrowOverflow <= 1, `${narrowOverflow}px`);
    const tooSmall = await page.locator('.stem-desk__proposal button').evaluateAll((nodes) =>
      nodes.filter((n) => n.getBoundingClientRect().height < 44).map((n) => n.textContent));
    record('every Producer button keeps a 44 px touch target on a phone', tooSmall.length === 0, tooSmall.join(', '));
    await keep.click(); // Undo
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
