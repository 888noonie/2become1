#!/usr/bin/env node
// tests/browser/record_crate_ux.js — real-browser journey for The Crate
// (record-crate), first slice, at 1280x800 and 390x844.
//
// Boots the real Studio against the fixture server. The Library listing, the
// /api/crate projection, stem listings, stem audio, artwork and separation
// requests are served by request interception, so the real desk decodes real
// WAVs. Proves: the Producer/Crate tabs keep the strips' width; search and
// Choose create no AudioContext and do not interrupt playback; Load goes
// through the desk's own Load; a Producer audition survives a tab switch; the
// overlay and the phone sheet are keyboard-safe; 44 px targets; no request
// leaves the loopback Studio.
//
// Usage: node tests/browser/record_crate_ux.js [--out DIR]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

import { resolveChromium } from './chromium.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'tests', 'browser', 'artifacts', 'record-crate');
mkdirSync(outDir, { recursive: true });
const A11Y_SOURCE = readFileSync(new URL('./a11y.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export \{.*$/m, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export /gm, '')
  + '\nwindow.auditDocument = auditDocument;\n';

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close((error) => (error ? reject(error) : resolvePort(free)));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  process.env.PYTHON || '.venv/bin/python',
  ['-m', 'tests.browser.fixture_server', '--data-dir', join(outDir, 'data'), '--port', String(port)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: join(ROOT, 'src') } },
);
const log = [];
server.stdout.on('data', (chunk) => log.push(chunk.toString()));
server.stderr.on('data', (chunk) => log.push(chunk.toString()));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function wav(freq, seconds = 2) {
  const rate = 44100;
  const frames = rate * seconds;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + frames * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 3000), 44 + i * 2);
  return buffer;
}

const TRACKS = [
  { id: 'track-1', name: 'Midnight Circuit', duration: 180, bpm: 96.8, key: { tonic: 'F', mode: 'major' }, source: { kind: 'upload' } },
  { id: 'track-2', name: 'Paper Lanterns', duration: 171, bpm: 84.3, key: { tonic: 'F', mode: 'major' }, source: { kind: 'upload' } },
  { id: 'track-3', name: 'Rough Demo', duration: 95, bpm: null, key: null, source: { kind: 'youtube' } },
  { id: 'track-4', name: 'Wide Pad', duration: 64, bpm: null, key: null, source: { kind: 'local' } },
  { id: 'track-5', name: 'Half Done', duration: 120, bpm: 120, key: null, source: { kind: 'upload' } },
  { id: 'track-6', name: 'Broken Take', duration: 30, bpm: null, key: null, source: { kind: 'upload' } },
];
const QUAD = ['vocals', 'drums', 'bass', 'other'];
const STEMS = {
  'track-1': { status: 'quad', quad: true, method: 'demucs', roles: QUAD },
  'track-2': { status: 'quad', quad: true, method: 'demucs', roles: QUAD },
  'track-3': { status: 'none', quad: false, method: null, roles: [] },
  'track-4': { status: 'center_sides', quad: false, method: 'ffmpeg', roles: ['center', 'sides'] },
  'track-5': { status: 'none', quad: false, method: null, roles: [] },
  'track-6': { status: 'none', quad: false, method: null, roles: [] },
};
const SEPARATION = {
  'track-5': { job_id: 'job-5', status: 'running', progress: 40, error: null },
  'track-6': { job_id: 'job-6', status: 'failed', progress: null, error: 'Demucs ran out of memory' },
};
const ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#1c2b2c"/><circle cx="20" cy="20" r="14" fill="#2c4040"/></svg>';

async function routes(page, seen) {
  page.on('request', (request) => seen.push(request.url()));
  await page.route('**/api/tracks?**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: TRACKS.map((t) => ({ ...t, artwork_url: `/api/tracks/${t.id}/artwork` })), total: TRACKS.length, limit: 50, offset: 0 }),
  }));
  await page.route('**/api/crate?**', (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') || '').toLowerCase();
    const items = TRACKS.filter((t) => t.name.toLowerCase().includes(q)).map((t) => ({
      track_id: t.id, name: t.name, artwork_url: `/api/tracks/${t.id}/artwork`, duration: t.duration, bpm: t.bpm,
      key: t.key, source: t.source, stems: STEMS[t.id], separation: SEPARATION[t.id] || null,
      actions: [
        ...(STEMS[t.id].roles.length ? ['choose_A', 'choose_B'] : []),
        ...(!STEMS[t.id].quad && SEPARATION[t.id]?.status !== 'running' ? ['separate'] : []),
      ],
    }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: items.length, limit: 20, offset: 0 }) });
  });
  await page.route('**/api/tracks/*/artwork', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: ART }));
  await page.route('**/api/tracks/*/stems', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const ready = STEMS[id]?.status === 'quad';
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        stems: ['full', ...(ready ? QUAD : [])],
        variants: [{ name: 'full' }, ...(ready ? QUAD.map((name) => ({
          name, stem_set_id: `set-${id}`, method: 'demucs', model_name: 'htdemucs@4.1.0', device: 'cpu',
          audio_url: `/api/stems/set-${id}/audio?name=${name}`,
        })) : [])],
      }),
    });
  });
  await page.route('**/api/stems/**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav(220 + QUAD.indexOf(name) * 110) });
  });
  await page.route('**/api/jobs?**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'job-5', kind: 'separate', status: 'running', request: { track_id: 'track-5' } }], total: 1 }),
  }));
  await page.route('**/api/tracks/*/separations', (route) => route.fulfill({
    status: 202, contentType: 'application/json', body: JSON.stringify({ id: 'job-new', kind: 'separate', status: 'queued' }),
  }));
  await page.route('**/api/jobs/job-*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'job-new', kind: 'separate', status: 'queued' }),
  }));
}

async function countContexts(page) {
  await page.addInitScript(() => {
    window.__contexts = 0;
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...a) { super(...a); window.__contexts += 1; }
    };
  });
}

async function audit(page, viewportWidth, scope) {
  if (!(await page.evaluate(() => typeof window.auditDocument === 'function'))) await page.addScriptTag({ content: A11Y_SOURCE });
  return page.evaluate(({ w, sel }) => {
    const r = window.auditDocument(document, { viewportWidth: w });
    const within = r.findings.filter((f) => f.severity !== 'info' && (!sel || (f.selector || f.element || '').toString().includes('crate') || /crate|desk-rail/i.test(JSON.stringify(f))));
    return { serious: r.serious, moderate: r.moderate, crate: within.slice(0, 10) };
  }, { w: viewportWidth, sel: scope });
}

const box = (locator) => locator.boundingBox();
const smallTargets = (page, root) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} [role="tab"]`)]
  .filter((el) => el.offsetParent !== null)
  .map((el) => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), ...el.getBoundingClientRect().toJSON() }))
  .filter((r) => r.height < 44 || r.width < 44)
  .map((r) => `${r.name} ${Math.round(r.width)}x${Math.round(r.height)}`), root);

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`fixture server exited early: ${log.join('')}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`fixture server did not start: ${log.join('')}`);
    await sleep(200);
  }
  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true, args: ['--disable-audio-output', '--mute-audio'] });
  const measurements = {};
  try {
    // ------------------------------------------------------------ 1280x800
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      const errors = [];
      const seen = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await countContexts(page);
      await routes(page, seen);
      await page.goto(`${base}/#/studio`);
      await page.waitForSelector('.desk-rail__tabs');
      await sleep(500);
      const rail = page.locator('.desk-rail');
      const producerTab = page.getByRole('tab', { name: /Producer/ });
      const crateTab = page.getByRole('tab', { name: 'Crate' });
      record('desktop: Producer and Crate are tabs in the right column', (await producerTab.count()) === 1 && (await crateTab.count()) === 1);
      record('desktop: nothing is fetched for the Crate on load', !seen.some((u) => u.includes('/api/crate')));

      // Load A through the desk, then play.
      const selectA = page.locator('select[aria-label="Track for group A"]');
      await selectA.focus();
      await sleep(300);
      await selectA.selectOption('track-1');
      await page.getByRole('button', { name: 'Load stems A' }).click();
      await page.waitForSelector('.stem-desk__group[data-group="A"]');
      await page.locator('.stem-desk__transport').getByRole('button', { name: 'Play' }).click();
      await sleep(400);
      const contextsPlaying = await page.evaluate(() => window.__contexts);
      record('desktop: the desk plays on one AudioContext', contextsPlaying === 1, `contexts=${contextsPlaying}`);
      const railWidthProducer = (await box(rail)).width;
      const rowA = page.locator('.stem-desk__row').first();
      const stripProducer = (await box(rowA)).width;

      // Open the Crate by keyboard.
      await producerTab.focus();
      await page.keyboard.press('ArrowRight');
      await sleep(400);
      record('desktop: ArrowRight selects the Crate tab and focus follows',
        (await crateTab.getAttribute('aria-selected')) === 'true' && await crateTab.evaluate((el) => el === document.activeElement));
      const railWidthCrate = (await box(rail)).width;
      const stripCrate = (await box(rowA)).width;
      record('desktop: the column keeps its width and strips keep theirs with the Crate open',
        Math.abs(railWidthCrate - railWidthProducer) < 1 && Math.abs(stripCrate - stripProducer) < 1,
        `column ${railWidthProducer.toFixed(0)}→${railWidthCrate.toFixed(0)} px, strip ${stripProducer.toFixed(1)}→${stripCrate.toFixed(1)} px`);
      measurements.desktop = { column: railWidthCrate, strip: stripCrate };
      await page.screenshot({ path: join(outDir, 'crate-1280-docked.png') });

      // Search by keyboard and choose for B.
      await page.locator('.record-crate__search').first().focus();
      await page.keyboard.type('lanterns');
      await sleep(700);
      const rows = page.locator('.desk-rail__crate .record-crate__row');
      record('desktop: search filters the Library', (await rows.count()) === 1 && /Paper Lanterns/.test(await rows.first().innerText()));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await sleep(200);
      const chooseB = page.getByRole('button', { name: 'Choose for B, Paper Lanterns' });
      await chooseB.focus();
      await page.keyboard.press('Enter');
      await sleep(600);
      const afterChoose = await page.evaluate(() => ({
        contexts: window.__contexts,
        playing: document.querySelector('.stem-desk__transport').dataset.playing,
        selectB: document.querySelector('select[aria-label="Track for group B"]').value,
        groups: [...document.querySelectorAll('.stem-desk__group')].map((g) => g.dataset.group),
      }));
      record('desktop: Choose sets Bank B, keeps playing, creates no AudioContext and loads nothing',
        afterChoose.selectB === 'track-2' && afterChoose.playing === 'true' && afterChoose.contexts === 1 && afterChoose.groups.join() === 'A',
        JSON.stringify(afterChoose));
      const loadB = page.getByRole('button', { name: 'Load B, Paper Lanterns' });
      record('desktop: focus moves from Choose to Load B', await loadB.evaluate((el) => el === document.activeElement));

      // Load B through the Crate, by keyboard.
      await page.getByRole('button', { name: 'Load B, Paper Lanterns' }).focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.stem-desk__group[data-group="B"]');
      await sleep(600);
      const afterLoad = await page.evaluate(() => ({
        status: document.querySelector('.stem-desk__status').textContent,
        playing: document.querySelector('.stem-desk__transport').dataset.playing,
        contexts: window.__contexts,
        focus: document.activeElement?.getAttribute('aria-label'),
        badges: [...document.querySelectorAll('.desk-rail__crate .record-crate__row .record-crate__badge')].map((b) => b.textContent),
      }));
      record('desktop: Load B uses the desk handler: loads, stops playback, one context',
        /Loaded 4 stems into group B/.test(afterLoad.status) && afterLoad.playing === 'false' && afterLoad.contexts === 1,
        afterLoad.status.slice(0, 60));
      record('desktop: the row then reads On B', afterLoad.badges.includes('On B'), afterLoad.badges.join(', '));
      record('desktop: focus returns to the Crate Load that was pressed', afterLoad.focus === 'Load B, Paper Lanterns', String(afterLoad.focus));


      // Play both banks again for the audition.
      await page.locator('.stem-desk__transport').getByRole('button', { name: 'Play' }).click();
      await sleep(300);
      // Producer audition survives the tab switch: ask and hear first.
      await producerTab.click();
      await page.getByRole('button', { name: 'Ask for a proposal' }).click();
      await page.getByRole('button', { name: 'Hear it' }).click();
      await sleep(200);
      const mixBefore = await page.evaluate(() => [...document.querySelectorAll('.stem-desk__row [aria-pressed]')].map((b) => b.getAttribute('aria-pressed')).join(''));
      await crateTab.click();
      await sleep(200);
      const strip = page.locator('.desk-rail__idea');
      record('desktop: the Crate tab shows the pending audition', await strip.isVisible() && /Hearing the Producer/.test(await strip.innerText()));
      const mixAfter = await page.evaluate(() => [...document.querySelectorAll('.stem-desk__row [aria-pressed]')].map((b) => b.getAttribute('aria-pressed')).join(''));
      const stillPlaying = await page.evaluate(() => document.querySelector('.stem-desk__transport').dataset.playing);
      record('desktop: switching tabs changes no mute or solo and playback continues', mixBefore === mixAfter && stillPlaying === 'true', `playing=${stillPlaying}`);
      await page.screenshot({ path: join(outDir, 'crate-1280-audition.png') });
      await strip.getByRole('button', { name: 'Show Producer' }).click();
      record('desktop: the audition is still being heard in the Producer tab',
        (await page.locator('.stem-desk__proposal').getByRole('button', { name: 'Hear mine' }).count()) === 1);
      await page.getByRole('button', { name: /^Keep/ }).click();
      await crateTab.click();

      // All states in one list.
      await page.locator('.record-crate__search').first().fill('');
      await sleep(700);
      const states = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.desk-rail__crate .record-crate__row')]
        .map((row) => [row.querySelector('.record-crate__title').textContent, [...row.querySelectorAll('.record-crate__badge')].map((b) => b.textContent).join(' + ')])));
      record('desktop: empty, ready, separating, failed, center/sides and loaded are distinct',
        states['Rough Demo'] === 'No stems yet' && states['Wide Pad'] === 'Center/sides only'
        && states['Half Done'] === 'Separating' && states['Broken Take'] === 'Separation failed'
        && /On A/.test(states['Midnight Circuit']) && /On B/.test(states['Paper Lanterns']) && /Stems ready · Demucs 4/.test(states['Paper Lanterns']),
        JSON.stringify(states));

      // Separate stems for the empty track.
      await page.locator('.desk-rail__crate .record-crate__row', { hasText: 'Rough Demo' }).locator('.record-crate__item').click();
      const separate = page.getByRole('button', { name: 'Separate stems, Rough Demo' });
      await separate.click();
      await sleep(400);
      const posted = seen.filter((u) => /\/api\/tracks\/track-3\/separations$/.test(u)).length;
      record('desktop: Separate stems posts one Demucs request and the row shows it',
        posted === 1 && /Separation queued|Separating/.test(await page.locator('.desk-rail__crate .record-crate__row', { hasText: 'Rough Demo' }).innerText()),
        `posts=${posted}`);

      // Expanded overlay.
      const expand = page.getByRole('button', { name: 'Expand' });
      await expand.click();
      await sleep(200);
      const overlay = await box(page.locator('.desk-rail__crate'));
      const stripExpanded = (await box(rowA)).width;
      record('desktop: Expand opens a 430 px overlay without shrinking the strips',
        Math.round(overlay.width) === 430 && Math.abs(stripExpanded - stripProducer) < 1,
        `overlay ${overlay.width}px, strip ${stripExpanded.toFixed(1)}px`);
      record('desktop: the overlay is not modal (Play stays operable)',
        await page.locator('.stem-desk__transport').getByRole('button', { name: /Play|Restart/ }).isEnabled());
      await page.screenshot({ path: join(outDir, 'crate-1280-expanded.png') });
      await page.keyboard.press('Escape');
      await sleep(100);
      record('desktop: Escape collapses the overlay and returns focus to Expand',
        !(await rail.evaluate((el) => el.classList.contains('desk-rail--expanded')))
        && await page.getByRole('button', { name: 'Expand' }).evaluate((el) => el === document.activeElement));
      const transition = await page.evaluate(() => getComputedStyle(document.querySelector('.desk-rail__crate')).transitionDuration);
      record('desktop: reduced motion: the Crate does not animate', parseFloat(transition) <= 0.001, transition);

      const tiny = await smallTargets(page, '.desk-rail');
      record('desktop: every visible Crate control is at least 44 x 44', tiny.length === 0, tiny.join('; '));
      const a11y = await audit(page, 1280, true);
      record('desktop: accessibility audit finds nothing serious', a11y.serious === 0, JSON.stringify(a11y.crate));
      measurements.desktopAudit = a11y;
      const external = seen.filter((u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
      record('desktop: no request leaves the loopback Studio', external.length === 0, external.slice(0, 3).join(' '));
      record('desktop: no page errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }

    // ------------------------------------------------------------ 390x844
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const errors = [];
      const seen = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await countContexts(page);
      await routes(page, seen);
      await page.goto(`${base}/#/studio`);
      await page.waitForSelector('.desk-rail__tabs');
      await sleep(500);
      const opener = page.locator('.stem-desk__crate-open');
      const openBox = await box(opener);
      record('mobile: the desk heading has a Crate button of at least 44 x 44',
        await opener.isVisible() && openBox.height >= 44 && openBox.width >= 44, `${openBox.width.toFixed(0)}x${openBox.height.toFixed(0)} at y=${openBox.y.toFixed(0)}`);
      await opener.tap();
      await sleep(700);
      const sheet = page.locator('dialog.workspace-sheet');
      const sheetBox = await box(sheet);
      record('mobile: the Crate opens as a full-height, full-width sheet',
        await sheet.evaluate((el) => el.open) && Math.round(sheetBox.width) === 390 && Math.round(sheetBox.height) === 844,
        `${sheetBox.width}x${sheetBox.height}`);
      record('mobile: focus starts in the search field', await page.locator('dialog .record-crate__search').evaluate((el) => el === document.activeElement));
      await page.locator('dialog .record-crate__row', { hasText: 'Paper Lanterns' }).locator('.record-crate__item').tap();
      await page.getByRole('button', { name: 'Choose for A, Paper Lanterns' }).tap();
      await sleep(500);
      record('mobile: Choose for A creates no AudioContext', await page.evaluate(() => window.__contexts) === 0);
      await page.screenshot({ path: join(outDir, 'crate-390-sheet.png') });
      const tiny = await smallTargets(page, 'dialog.workspace-sheet');
      record('mobile: every visible sheet control is at least 44 x 44', tiny.length === 0, tiny.join('; '));
      const loadA = page.getByRole('button', { name: 'Load A, Paper Lanterns' });
      const pair = [await box(page.getByRole('button', { name: 'Selected for A, Paper Lanterns' })), await box(loadA)];
      record('mobile: Choose and Load sit side by side with a gap', pair[1].x - (pair[0].x + pair[0].width) >= 8,
        `gap ${(pair[1].x - (pair[0].x + pair[0].width)).toFixed(0)} px`);
      await loadA.tap();
      await page.waitForSelector('.stem-desk__group[data-group="A"]', { state: 'attached' });
      await sleep(600);
      const mirrored = await page.locator('dialog .record-crate__status').innerText();
      record('mobile: the sheet reports the desk’s own load message', /Loaded 4 stems into group A/.test(mirrored), mirrored.slice(0, 70));
      // Modal: Tab stays inside the sheet.
      // Modal: the desk behind is inert, so Tab cannot leave the sheet.
      const modal = await page.evaluate(() => document.querySelector('dialog.workspace-sheet').matches(':modal'));
      const escaped = [];
      for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press('Tab');
        // Inside the sheet, or on the browser's own UI (body), never the desk.
        escaped.push(await page.evaluate(() => document.activeElement === document.body
          || Boolean(document.activeElement?.closest('dialog.workspace-sheet'))));
      }
      record('mobile: the sheet is modal and Tab stays inside it', modal && escaped.every(Boolean), `modal=${modal}`);
      const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= 390);
      record('mobile: no horizontal page scroll', noScroll);
      await page.getByRole('button', { name: 'Done', exact: true }).tap();
      await sleep(300);
      record('mobile: Done closes and removes the sheet; focus returns to the Crate button',
        (await sheet.count()) === 0 && await opener.evaluate((el) => el === document.activeElement));
      await page.locator('.desk-rail').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(outDir, 'crate-390-after.png'), fullPage: false });
      const a11y = await audit(page, 390, true);
      record('mobile: accessibility audit finds nothing serious', a11y.serious === 0, JSON.stringify(a11y.crate));
      measurements.mobileAudit = a11y;
      const external = seen.filter((u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
      record('mobile: no request leaves the loopback Studio', external.length === 0, external.slice(0, 3).join(' '));
      record('mobile: no page errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(outDir, 'record-crate-results.json'), JSON.stringify({ results, measurements }, null, 2));
} catch (error) {
  record('journey completed', false, error.stack || String(error));
} finally {
  server.kill();
}
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
