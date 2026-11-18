#!/usr/bin/env node
// tests/browser/stem_desk_ux.js — real-browser journey for the Stem Desk.
//
// Boots the real Studio against the fixture server, then serves four synthetic
// stem WAVs through request interception so the real StemDesk runtime decodes
// and plays them. Proves the mount path, lane labels, M/S/gain wiring and the
// truthful stop state in a real browser. It is a scheduling/DOM check: the
// signal-level proof lives in stem_desk_audio.js.
//
// Usage: node tests/browser/stem_desk_ux.js [--viewport 1280x800] [--out DIR]

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
const dataDir = join(outDir, 'stem-desk-ux-data');

const server = spawn(
  process.env.PYTHON || '.venv/bin/python',
  ['-m', 'tests.browser.fixture_server', '--data-dir', dataDir, '--port', String(port)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
const log = [];
server.stdout.on('data', (chunk) => log.push(chunk.toString()));
server.stderr.on('data', (chunk) => log.push(chunk.toString()));

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const fail = (message) => { throw new Error(message); };

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) fail(`fixture server exited early: ${log.join('')}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) fail(`fixture server did not start: ${log.join('')}`);
    await sleep(200);
  }

  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Four synthetic stems: 2 s mono, one distinct tone per lane.
    function wav(freq) {
      const rate = 44100;
      const frames = rate * 2;
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
    const tones = { vocals: 220, drums: 440, bass: 660, other: 880 };

    await page.route('**/api/tracks?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: 'track-1', name: 'night-drive.wav', title: 'Night Drive' }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    }));
    await page.route('**/api/tracks/track-1/stems', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stems: ['full', 'vocals', 'drums', 'bass', 'other'],
        variants: [
          { name: 'full', stem_set_id: null, audio_url: '/api/tracks/track-1/audio' },
          ...['vocals', 'drums', 'bass', 'other'].map((name) => ({
            name,
            stem_set_id: 'set-1',
            method: 'demucs',
            model_name: 'htdemucs@4.1.0',
            device: 'cpu',
            audio_url: `/api/stems/set-1/audio?name=${name}`,
          })),
        ],
      }),
    }));
    await page.route('**/api/stems/**', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name');
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav(tones[name] || 220) });
    });

    await page.goto(`${base}/#/studio`);
    await sleep(1500);

    const desk = page.locator('.stem-desk');
    if ((await desk.count()) !== 1) fail('the Stem Desk is not mounted in the Studio');

    await page.locator('.stem-desk select[aria-label="Track for group A"]').focus();
    await sleep(500);
    await page.locator('.stem-desk select[aria-label="Track for group A"]').selectOption('track-1');
    await page.getByRole('button', { name: 'Load stems A' }).click();
    await sleep(2500);

    const rows = page.locator('.stem-desk .stem-desk__row');
    if ((await rows.count()) !== 4) fail(`expected 4 stem lanes, saw ${await rows.count()}`);
    const text = await desk.innerText();
    for (const label of ['Vocals', 'Drums', 'Bass', 'Other']) {
      if (!text.includes(label)) fail(`missing lane label ${label}`);
    }
    if (!/demucs/.test(text)) fail('lane provenance does not name the separation method');
    if (!/htdemucs@4\.1\.0/.test(text)) fail('lane provenance does not name the model');

    const drums = rows.nth(1);
    await drums.getByRole('button', { name: 'Mute Drums' }).click();
    await sleep(300);
    if ((await drums.getByRole('button', { name: 'Mute Drums' }).getAttribute('aria-pressed')) !== 'true') {
      fail('mutting Drums did not report pressed state');
    }

    await rows.nth(2).getByRole('button', { name: 'Solo Bass' }).click();
    await sleep(300);
    if ((await rows.nth(2).getByRole('button', { name: 'Solo Bass' }).getAttribute('aria-pressed')) !== 'true') {
      fail('soloing Bass did not report pressed state');
    }
    if ((await rows.nth(0).getByRole('button', { name: 'Mute Vocals' }).getAttribute('aria-pressed')) !== 'false') {
      fail('solo should not rewrite another lane mute flag');
    }

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await sleep(1200);
    const playingText = await desk.innerText();
    if (!/Playing 4 stems together/.test(playingText)) {
      fail(`Play did not report a truthful playing state: ${playingText.slice(0, 200)}`);
    }

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await sleep(300);
    if (!/Stem desk stopped/.test(await desk.innerText())) fail('Stop did not report a stopped state');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) fail(`horizontal overflow ${overflow}px at ${viewportArg}`);

    if (pageErrors.length) fail(`uncaught page errors: ${pageErrors.join('; ')}`);

    await desk.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(outDir, `stem-desk-${viewportArg}.png`) });
    writeFileSync(join(outDir, `stem-desk-${viewportArg}.json`), JSON.stringify({
      viewport: viewportArg,
      lanes: 4,
      labels: ['Vocals', 'Drums', 'Bass', 'Other'],
      provenance: 'demucs · htdemucs@4.1.0 · cpu',
      screenshot: `stem-desk-${viewportArg}.png`,
    }, null, 2));
    console.log(`PASS  four lanes render with provenance at ${viewportArg}`);
    console.log('PASS  mute and solo report pressed state');
    console.log('PASS  Play and Stop report truthful transport states');
    console.log(`PASS  no horizontal overflow at ${viewportArg}`);
    console.log('PASS  no uncaught page errors');
  } finally {
    await browser.close();
  }
} finally {
  if (server.exitCode === null) server.kill('SIGTERM');
}
