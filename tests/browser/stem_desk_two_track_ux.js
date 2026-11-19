#!/usr/bin/env node
// tests/browser/stem_desk_two_track_ux.js — real-browser journey for the
// two-track, eight-lane Stem Desk.
//
// Boots the real Studio against the fixture server, then serves two sets of
// four synthetic stem WAVs through request interception so the real runtime
// decodes eight lanes in a real browser. Proves: two track pickers, eight rows
// under two group headings, per-group level controls, one transport, the
// crossfader, unique accessible names, that a gain drag keeps focus, and that
// two tracks play once and say so without claiming beat matching.
//
// It is a DOM/transport check. The signal proof lives in
// stem_desk_two_track_audio.js and stem_desk_two_track_real.js.
//
// Usage: node tests/browser/stem_desk_two_track_ux.js [--viewport 1280x800] [--out DIR]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

import { resolveChromium } from './chromium.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const viewportArg = value('--viewport', '1280x800');
const [width, height] = viewportArg.split('x').map(Number);
const outDir = value('--out', join(ROOT, 'tests', 'browser', 'artifacts'));
mkdirSync(outDir, { recursive: true });

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => (error ? reject(error) : resolvePort(address.port)));
  });
});
const base = `http://127.0.0.1:${port}`;
const dataDir = join(outDir, 'stem-desk-two-track-data');

const server = spawn(
  process.env.PYTHON || '.venv/bin/python',
  ['-m', 'tests.browser.fixture_server', '--data-dir', dataDir, '--port', String(port)],
  {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: join(ROOT, 'src') },
  },
);
const log = [];
server.stdout.on('data', (chunk) => log.push(chunk.toString()));
server.stderr.on('data', (chunk) => log.push(chunk.toString()));

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`fixture server exited early: ${log.join('')}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`fixture server did not start: ${log.join('')}`);
    await sleep(200);
  }

  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    function wav(freq, seconds = 2) {
      const rate = 44100;
      const frames = rate * seconds;
      const buffer = Buffer.alloc(44 + frames * 2);
      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + frames * 2, 4);
      buffer.write('WAVEfmt ', 8);
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(1, 22);
      buffer.writeUInt32LE(rate, 24);
      buffer.writeUInt32LE(rate * 2, 28);
      buffer.writeUInt16LE(2, 32);
      buffer.writeUInt16LE(16, 34);
      buffer.write('data', 36);
      buffer.writeUInt32LE(frames * 2, 40);
      for (let i = 0; i < frames; i += 1) {
        const sample = Math.sin((2 * Math.PI * freq * i) / rate) * 0.1;
        buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
      }
      return buffer;
    }
    // Two distinct four-lane sets: group A 220/330/440/550, group B 660/770/880/990.
    const tonesA = { vocals: 220, drums: 330, bass: 440, other: 550 };
    const tonesB = { vocals: 660, drums: 770, bass: 880, other: 990 };

    await page.route('**/api/tracks?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' },
          { id: 'track-2', name: 'slow-burn.wav', title: 'Slow Burn' },
        ],
        total: 2,
        limit: 50,
        offset: 0,
      }),
    }));
    const stemsPayload = (setId) => ({
      stems: ['full', 'vocals', 'drums', 'bass', 'other'],
      variants: [
        { name: 'full', stem_set_id: null, audio_url: '/api/tracks/full/audio' },
        ...['vocals', 'drums', 'bass', 'other'].map((name) => ({
          name,
          stem_set_id: setId,
          method: 'demucs',
          model_name: 'htdemucs@4.1.0',
          device: 'cpu',
          audio_url: `/api/stems/${setId}/audio?name=${name}`,
        })),
      ],
    });
    await page.route('**/api/tracks/track-1/stems', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(stemsPayload('set-a')),
    }));
    await page.route('**/api/tracks/track-2/stems', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(stemsPayload('set-b')),
    }));
    await page.route('**/api/stems/**', (route) => {
      const url = new URL(route.request().url());
      const name = url.searchParams.get('name');
      const setId = url.pathname.split('/')[3];
      const tones = setId === 'set-b' ? tonesB : tonesA;
      return route.fulfill({
        status: 200, contentType: 'audio/wav', body: wav(tones[name] || 220),
      });
    });

    await page.goto(`${base}/#/studio`);
    await sleep(1500);

    const desk = page.locator('.stem-desk');
    record('the two-track Stem Desk is mounted', (await desk.count()) === 1);
    for (const options of await desk.locator('.source-options summary').all()) await options.click();
    record('group A offers library, add/process, and load',
      (await page.getByRole('button', { name: 'Choose from Library for group A' }).count()) === 1
      && (await page.getByRole('button', { name: 'Add / Process Track for group A' }).count()) === 1
      && (await page.getByRole('button', { name: 'Load stems A' }).count()) === 1);
    record('group B offers library, add/process, and load',
      (await page.getByRole('button', { name: 'Choose from Library for group B' }).count()) === 1
      && (await page.getByRole('button', { name: 'Add / Process Track for group B' }).count()) === 1
      && (await page.getByRole('button', { name: 'Load stems B' }).count()) === 1);
    await page.getByRole('button', { name: 'Choose from Library for group A' }).click();
    await sleep(400);
    const dialogText = await page.locator('dialog').innerText().catch(() => '');
    record('Choose from Library opens the existing Choose Track dialog',
      /Library/.test(dialogText) && /Upload/.test(dialogText) && /YouTube/.test(dialogText));
    await page.getByRole('button', { name: 'Close' }).click();
    await sleep(200);

    await page.locator('.stem-desk select[aria-label="Track for group A"]').focus();
    await sleep(300);
    await page.locator('.stem-desk select[aria-label="Track for group A"]').selectOption('track-1');
    await page.getByRole('button', { name: 'Load stems A' }).click();
    await sleep(2000);
    await page.locator('.stem-desk select[aria-label="Track for group B"]').selectOption('track-2');
    await page.getByRole('button', { name: 'Load stems B' }).click();
    await sleep(2500);

    const rows = page.locator('.stem-desk .stem-desk__row');
    record('eight stem lanes load across two tracks', (await rows.count()) === 8, `${await rows.count()} rows`);
    record('two group headings are rendered',
      (await page.locator('.stem-desk .stem-desk__group').count()) === 2);

    const text = await desk.innerText();
    record('both track titles appear', /Night Drive/.test(text) && /Slow Burn/.test(text));
    record('lane provenance names the real model', /htdemucs@4\.1\.0/.test(text));
    record('lane provenance includes the stem set', /set set-/.test(text));
    record('the solo policy is stated', /Solo applies across both tracks/.test(text));

    // Unique accessible names: group-qualified, so two "Vocals" are distinct.
    const muteLabels = await page.$$eval('.stem-desk .stem-desk__row .button', (nodes) =>
      nodes.filter((node) => node.getAttribute('aria-label')?.startsWith('Mute '))
        .map((node) => node.getAttribute('aria-label')));
    record('mute labels are unique across the eight lanes',
      new Set(muteLabels).size === 8, muteLabels.slice(0, 3).join(' | '));

    const groupA = page.locator('.stem-desk .stem-desk__group[data-group="A"]');
    const groupB = page.locator('.stem-desk .stem-desk__group[data-group="B"]');
    record('each group has its own level control',
      (await groupA.locator('.stem-desk__level').count()) === 1 &&
      (await groupB.locator('.stem-desk__level').count()) === 1);

    // Mute A drums, solo B vocals: both state flags must be independent.
    await groupA.locator('.stem-desk__row').nth(1)
      .getByRole('button', { name: 'Mute A · Drums' }).click();
    await sleep(200);
    record('mute reports pressed state in group A',
      (await groupA.locator('.stem-desk__row').nth(1)
        .getByRole('button', { name: 'Mute A · Drums' }).getAttribute('aria-pressed')) === 'true');

    await groupB.locator('.stem-desk__row').nth(0)
      .getByRole('button', { name: 'Solo B · Vocals' }).click();
    await sleep(200);
    record('solo reports pressed state in group B',
      (await groupB.locator('.stem-desk__row').nth(0)
        .getByRole('button', { name: 'Solo B · Vocals' }).getAttribute('aria-pressed')) === 'true');
    record('solo does not rewrite a mute flag in the other group',
      (await groupA.locator('.stem-desk__row').nth(1)
        .getByRole('button', { name: 'Mute A · Drums' }).getAttribute('aria-pressed')) === 'true');

    // Crossfader is live with two tracks.
    const crossfader = page.locator('.stem-desk__crossfader');
    record('the crossfader is enabled for two tracks', !(await crossfader.isDisabled()));
    await crossfader.fill('0');
    await crossfader.dispatchEvent('input');
    await sleep(200);
    record('crossfader 0 reports A open and B closed',
      /A 1\.00 \/ B 0\.00/.test(await desk.innerText()));
    await crossfader.fill('100');
    await crossfader.dispatchEvent('input');
    await sleep(200);
    record('crossfader 100 reports B open and A closed',
      /A 0\.00 \/ B 1\.00/.test(await desk.innerText()));

    // A gain drag must not replace the slider element (keyed row update).
    const slider = groupA.locator('.stem-desk__row').nth(2).locator('input[type="range"]');
    await slider.focus();
    await slider.fill('-12');
    await slider.dispatchEvent('input');
    await sleep(200);
    const stillFocused = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label') || '');
    record('a gain drag keeps focus on the same slider',
      stillFocused === 'A · Bass gain', stillFocused);

    const play = page.getByRole('button', { name: 'Play', exact: true });
    await play.click();
    await sleep(1200);
    const playingText = await desk.innerText();
    record('two tracks play once and say so', /Started 8 lanes on one clock/.test(playingText));
    record('the status does not claim beat matching',
      /not tempo or beat matching/.test(playingText) && !/beat.?matched/i.test(playingText));

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await sleep(300);
    record('stop reports a stopped state', /Stem desk stopped/.test(await desk.innerText()));

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record(`no horizontal overflow at ${viewportArg}`, overflow <= 1, `${overflow}px`);

    record('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));

    await desk.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(outDir, `stem-desk-two-track-${viewportArg}.png`) });
    writeFileSync(join(outDir, `stem-desk-two-track-${viewportArg}.json`), JSON.stringify({
      viewport: viewportArg, results,
    }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} two-track UI checks passed at ${viewportArg}`);
process.exitCode = failed.length ? 1 : 0;
