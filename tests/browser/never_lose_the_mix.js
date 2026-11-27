#!/usr/bin/env node
// tests/browser/never_lose_the_mix.js — OPERATION NEVER LOSE THE MIX.
//
// A real browser on a real Studio with two complete Demucs tracks:
//   A. Load A and B, change gain, mute, solo, crossfader and a track level,
//      press Play, bring a clip into the Arrangement and edit it (one undo
//      step), then go Studio → Library → Activity → Engine → Studio. The same
//      desk (banks, settings, transport still running) and the same
//      Arrangement (clips, the edit, the selection, Undo/Redo) are there, with
//      one AudioContext and none closed.
//   B. The Producer/Crate sidebar is on every section: an audition started in
//      Studio is kept from Library and undone back in Studio; the Crate keeps
//      its search and open row through Hide/reopen and navigation; at
//      390×844 a top-bar button opens a modal sheet that keeps Tab inside and
//      returns focus, on all four sections, without touching audio.
//
// Usage:
//   node tests/browser/never_lose_the_mix.js --data-dir <library with lead-fixture.wav and paper-lanterns.wav quads> [--out DIR]
//   node tests/browser/never_lose_the_mix.js --base http://127.0.0.1:PORT   (an already running Studio, e.g. a negative control)
//
// The data dir is copied; the copy is what the Studio serves.

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dataDir = arg('--data-dir');
const givenBase = arg('--base');
const outDir = path.resolve(arg('--out', path.join(ROOT, 'tests', 'browser', 'artifacts', 'never-lose-the-mix')));
if (!dataDir && !givenBase) {
  console.error('usage: node tests/browser/never_lose_the_mix.js --data-dir <dir> | --base <url>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

let studio = null;
let scratch = null;
let base = givenBase ? new URL(givenBase).origin : null;
const serverLog = [];
if (!base) {
  const port = await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close((error) => (error ? reject(error) : resolvePort(free)));
    });
  });
  base = `http://127.0.0.1:${port}`;
  scratch = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'never-lose-the-mix-'));
  cpSync(dataDir, path.join(scratch, 'library'), { recursive: true });
  studio = spawn(process.env.PYTHON || '.venv/bin/python',
    ['-m', 'twobecomeone.cli', 'web', '--host', '127.0.0.1', '--port', String(port), '--data-dir', path.join(scratch, 'library')],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, 'src'),
        TWOBECOMEONE_PRODUCER_URL: 'http://127.0.0.1:9',
        HF_HUB_OFFLINE: '1',
        OLLAMA_API_KEY: '',
      },
    });
  studio.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  studio.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('loopback Studio only');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 120; i += 1) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
  await sleep(250);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

/** Count every AudioContext made or closed, and animation-frame requests. */
const instrument = () => {
  const Original = window.AudioContext;
  window.__audio = { made: 0, closed: 0 };
  window.AudioContext = class extends Original {
    constructor(...options) {
      super(...options);
      window.__audio.made += 1;
      const close = this.close.bind(this);
      this.close = () => { window.__audio.closed += 1; return close(); };
    }
  };
  window.__raf = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => { window.__raf += 1; return raf(fn); };
};

const external = [];
const pageErrors = [];
async function newPage(viewport, extra = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...extra });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return page;
}

const go = async (page, route) => {
  await page.locator(`.nav__link[data-route="${route}"]`).click();
  await page.waitForFunction((r) => document.querySelector(`.nav__link[data-route="${r}"]`)?.getAttribute('aria-current') === 'page', route);
  await sleep(250);
};

try {
  // ======================================================== A. 1280×800
  const page = await newPage({ width: 1280, height: 800 });
  await page.goto(`${base}/#/studio`);
  const desk = page.locator('.stem-desk');
  await desk.waitFor();
  const selectA = desk.locator('select[aria-label="Track for group A"]');
  await selectA.focus();
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Track for group A"] option').length > 2);
  const ids = await selectA.evaluate((sel) => Object.fromEntries([...sel.options].map((o) => [o.textContent, o.value])));
  const idA = ids['lead-fixture.wav'];
  const idB = ids['paper-lanterns.wav'];
  if (!idA || !idB) throw new Error(`fixture tracks missing: ${JSON.stringify(Object.keys(ids))}`);
  await selectA.selectOption(idA);
  await desk.getByRole('button', { name: 'Load stems A', exact: true }).click();
  await desk.locator('.stem-desk__group[data-group="A"]').waitFor({ timeout: 60000 });
  await desk.locator('select[aria-label="Track for group B"]').selectOption(idB);
  await desk.getByRole('button', { name: 'Load stems B', exact: true }).click();
  await desk.locator('.stem-desk__group[data-group="B"]').waitFor({ timeout: 60000 });

  const setRange = (label, value) => desk.locator(`input[aria-label="${label}"]`).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await setRange('A · Vocals gain', -9);
  await setRange('B · Bass gain', -4);
  await setRange('Group A level', -3);
  await setRange('Crossfader A to B', 72);
  await desk.getByRole('button', { name: 'Mute A · Drums' }).click();
  await desk.getByRole('button', { name: 'Solo B · Vocals' }).click();

  const deskSnapshot = () => page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const ranges = Object.fromEntries([...document.querySelectorAll('.stem-desk input[type=range]')].map((el) => [el.getAttribute('aria-label'), el.value]));
    const pressed = Object.fromEntries([...document.querySelectorAll('.stem-desk button[aria-pressed]')].map((el) => [el.getAttribute('aria-label') || el.textContent, el.getAttribute('aria-pressed')]));
    return {
      groups: [...document.querySelectorAll('.stem-desk__group')].map((g) => g.dataset.group),
      lanes: document.querySelectorAll('.stem-desk__row').length,
      selected: { A: q('select[aria-label="Track for group A"]').value, B: q('select[aria-label="Track for group B"]').value },
      ranges,
      pressed,
      transport: q('.stem-desk__transport')?.innerText.replace(/\s+/g, ' '),
      root: q('.stem-desk')?.dataset.instance || null,
    };
  });
  // Tag the DOM node: if navigation rebuilt the desk, the tag is gone.
  await page.evaluate(() => { document.querySelector('.stem-desk').dataset.instance = 'original'; });

  await desk.getByRole('button', { name: 'Play', exact: true }).click();
  await sleep(700);
  const seconds = (text) => Number.parseFloat(/([\d.]+)\s*s/.exec(text || '')?.[1] ?? 'NaN');
  const before = await deskSnapshot();
  const audioBefore = await page.evaluate(() => ({ ...window.__audio }));
  check('setup: both banks loaded with eight lanes and the transport running',
    before.groups.join() === 'A,B' && before.lanes === 8 && seconds(before.transport) > 0, before);

  // ---- Arrangement: bring A in and edit the clip once.
  await page.getByRole('button', { name: 'Arrangement', exact: true }).click();
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--A select[aria-label^="Track"] option').length > 1);
  const arrValue = await page.$eval('.daw__import-row--A select[aria-label^="Track"]', (sel) => [...sel.options].find((o) => o.text.includes('lead-fixture'))?.value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Track"]', arrValue);
  await page.click('.daw__bring--A');
  await page.waitForFunction(() => (window.__arrangement?.session.state.clips.length || 0) >= 1, null, { timeout: 120000 });
  // Playing the desk keeps going while the Arrangement is shown.
  const arr = () => page.evaluate(() => {
    const a = window.__arrangement;
    if (!a) return { clips: [], past: 0, future: 0, selected: null, undoEnabled: false, redoEnabled: false, apiTag: 'gone' };
    return {
      clips: JSON.parse(JSON.stringify(a.session.state.clips)),
      past: a.session.edit.historyDepth.past,
      future: a.session.edit.historyDepth.future,
      selected: a.ui.selectedClipId,
      undoEnabled: !a.elements.undoBtn.disabled,
      redoEnabled: !a.elements.redoBtn.disabled,
      apiTag: a.__tag || null,
    };
  });
  const firstClip = (await arr()).clips[0];
  await page.locator(`.daw__clip[data-clip-id="${firstClip.id}"]`).scrollIntoViewIfNeeded();
  await page.click(`.daw__clip[data-clip-id="${firstClip.id}"]`, { position: { x: 30, y: 20 } });
  const pastBeforeEdit = (await arr()).past;
  // One real edit through the edit API path the clip gain grip uses: move the clip one bar.
  const clipLocator = () => page.locator(`.daw__clip[data-clip-id="${firstClip.id}"]`);
  await clipLocator().press('ArrowRight');
  await page.waitForFunction((p) => window.__arrangement.session.edit.historyDepth.past > p, pastBeforeEdit);
  // A second edit, then Undo it, so Redo has something to keep too.
  await clipLocator().press('ArrowRight');
  await page.waitForFunction((p) => window.__arrangement.session.edit.historyDepth.past > p + 1, pastBeforeEdit);
  await page.locator('.daw__history button').first().click();
  await page.evaluate(() => { window.__arrangement.__tag = 'original'; });
  const arrBefore = await arr();
  check('setup: an edited Arrangement clip, selected, with one Undo and one Redo available',
    arrBefore.clips.length >= 1 && arrBefore.clips[0].timelineStartBeat !== firstClip.timelineStartBeat
      && arrBefore.selected === firstClip.id && arrBefore.undoEnabled && arrBefore.redoEnabled,
    { first: firstClip.timelineStartBeat, now: arrBefore.clips[0]?.timelineStartBeat, selected: arrBefore.selected, past: arrBefore.past, future: arrBefore.future });
  await page.getByRole('button', { name: 'Performance', exact: true }).click();
  const deskStill = await deskSnapshot();
  check('switching surfaces kept the desk playing', seconds(deskStill.transport) > seconds(before.transport), { before: before.transport, now: deskStill.transport });

  // ---- The navigation gate.
  const away = {};
  for (const route of ['library', 'activity', 'engine']) {
    await go(page, route);
    away[route] = await page.evaluate(() => ({
      sidebar: Boolean(document.querySelector('.workspace-sidebar:not([hidden]) .desk-rail__tabs')),
      deskInDom: document.querySelector('.stem-desk')?.dataset.instance || null,
      transport: document.querySelector('.stem-desk__transport')?.innerText.replace(/\s+/g, ' '),
      studioHidden: Boolean(document.querySelector('.view-pane[data-pane="studio"]')?.hidden),
    }));
  }
  await go(page, 'studio');
  await sleep(300);
  const after = await deskSnapshot();
  const arrAfter = await arr();
  const audioAfter = await page.evaluate(() => ({ ...window.__audio }));

  check('A1. leaving Studio keeps the same desk alive (hidden, not rebuilt) on Library, Activity and Engine',
    Object.values(away).every((v) => v.deskInDom === 'original' && v.studioHidden), away);
  check('A2. both banks and all eight lanes are still loaded with the same tracks',
    after.groups.join() === 'A,B' && after.lanes === 8 && after.selected.A === idA && after.selected.B === idB, after);
  check('A3. lane gains, track level and crossfader are exactly as left',
    JSON.stringify(after.ranges) === JSON.stringify(before.ranges), { before: before.ranges, after: after.ranges });
  check('A4. mute and solo states are exactly as left',
    JSON.stringify(after.pressed) === JSON.stringify(before.pressed)
      && after.pressed['Mute A · Drums'] === 'true' && after.pressed['Solo B · Vocals'] === 'true', after.pressed);
  check('A5. the transport kept running through navigation (position advanced, Stop enabled)',
    seconds(after.transport) > seconds(deskStill.transport)
      && await desk.getByRole('button', { name: 'Stop', exact: true }).isEnabled(),
    { left: deskStill.transport, returned: after.transport });
  check('A6. one AudioContext, none made or closed by navigation',
    audioAfter.made === audioBefore.made && audioAfter.closed === 0 && audioAfter.made === 1, { audioBefore, audioAfter });
  check('A7. the Arrangement is the same instance with its clips, the edit and the selection',
    arrAfter.apiTag === 'original' && JSON.stringify(arrAfter.clips) === JSON.stringify(arrBefore.clips) && arrAfter.selected === arrBefore.selected,
    { before: arrBefore.selected, after: arrAfter.selected, tag: arrAfter.apiTag });
  check('A8. Undo and Redo history survived (same depths, both enabled)',
    arrAfter.past === arrBefore.past && arrAfter.future === arrBefore.future && arrAfter.undoEnabled && arrAfter.redoEnabled,
    { before: [arrBefore.past, arrBefore.future], after: [arrAfter.past, arrAfter.future] });
  await page.getByRole('button', { name: 'Arrangement', exact: true }).click();
  await page.locator('.daw__history button').nth(1).click(); // Redo
  const redone = await arr();
  await page.locator('.daw__history button').first().click(); // Undo
  const undone = await arr();
  check('A9. Redo then Undo still walk the retained history',
    redone.clips[0].timelineStartBeat !== arrBefore.clips[0].timelineStartBeat
      && undone.clips[0].timelineStartBeat === arrBefore.clips[0].timelineStartBeat,
    { before: arrBefore.clips[0].timelineStartBeat, redone: redone.clips[0].timelineStartBeat, undone: undone.clips[0].timelineStartBeat });
  check('A10. navigation saved nothing: no arrangement write request', !serverLog.join('').match(/(PUT|POST) \/api\/arrangements/), '');
  await page.getByRole('button', { name: 'Performance', exact: true }).click();

  // Background loops: stop the desk, go to Engine, count animation frames.
  await desk.getByRole('button', { name: 'Stop', exact: true }).click();
  await go(page, 'engine');
  const raf0 = await page.evaluate(() => window.__raf);
  await sleep(1000);
  const raf1 = await page.evaluate(() => window.__raf);
  check('A11. nothing animates in the background while the Studio is hidden and stopped', raf1 - raf0 === 0, { frames: raf1 - raf0 });
  await page.screenshot({ path: path.join(outDir, 'engine-1280-sidebar.png') });
  await go(page, 'studio');

  // ======================================================== B. sidebar
  const sidebar = page.locator('.workspace-sidebar');
  const strip = () => page.evaluate(() => Math.round(document.querySelector('.stem-desk__row').getBoundingClientRect().width * 10) / 10);
  const openStrip = await strip();
  check('B1. the sidebar sits beside the desk at the old column width; strips keep usable width (>= 113 px)',
    Math.round((await sidebar.boundingBox()).width) === 230 && openStrip >= 113, { strip: openStrip });
  await page.screenshot({ path: path.join(outDir, 'studio-1280-sidebar.png') });

  // Producer: Ask, Hear it in Studio, keep it from Library, Undo back in Studio.
  // A soloed lane blocks a proposal (the desk contract), so clear the solo first.
  await desk.getByRole('button', { name: 'Solo B · Vocals' }).click();
  const preIdea = await deskSnapshot();
  await sidebar.getByRole('tab', { name: /Producer/ }).click();
  await sidebar.getByRole('button', { name: 'Ask for a proposal' }).click();
  await sidebar.getByRole('button', { name: 'Hear it' }).click();
  const heard = await deskSnapshot();
  await go(page, 'library');
  const libraryProducer = await sidebar.getByRole('button', { name: 'Keep it' }).isVisible();
  const pendingTab = await sidebar.getByRole('tab', { name: /Producer/ }).innerText();
  await sidebar.getByRole('button', { name: 'Keep it' }).click();
  await page.screenshot({ path: path.join(outDir, 'library-1280-producer-kept.png') });
  await go(page, 'activity');
  const undoOnActivity = (await sidebar.getByRole('button', { name: 'Undo', exact: true }).count()) === 1;
  await go(page, 'studio');
  const kept = await deskSnapshot();
  await sidebar.getByRole('button', { name: 'Undo', exact: true }).click();
  const restored = await deskSnapshot();
  check('B2. an audition started in Studio is still heard on Library and can be kept from there',
    libraryProducer && JSON.stringify(kept.ranges) === JSON.stringify(heard.ranges), { libraryProducer, pendingTab });
  check('B3. Undo is offered on Activity and, back in Studio, returns the mix from before the idea',
    undoOnActivity && JSON.stringify(heard.ranges) !== JSON.stringify(preIdea.ranges)
      && JSON.stringify(restored.ranges) === JSON.stringify(preIdea.ranges)
      && JSON.stringify(restored.pressed) === JSON.stringify(preIdea.pressed), { restored: restored.ranges, expected: preIdea.ranges });

  // One Producer per page: on the Arrangement surface the desk's controls step aside.
  await page.getByRole('button', { name: 'Arrangement', exact: true }).click();
  const askVisibleOnArrangement = await sidebar.getByRole('button', { name: 'Ask for a proposal' }).isVisible().catch(() => false);
  const awayNote = await sidebar.locator('.stem-desk__producer-away').innerText().catch(() => '');
  check('B4. on the Arrangement surface the desk Producer steps aside for the page\'s own Producer',
    !askVisibleOnArrangement && /Arrangement has its own Producer/.test(awayNote), awayNote);
  await page.getByRole('button', { name: 'Performance', exact: true }).click();

  // Crate: search text, open row and tab survive Hide/reopen and navigation.
  await sidebar.getByRole('tab', { name: 'Crate', exact: true }).click();
  const search = sidebar.getByRole('searchbox');
  await sidebar.locator('.record-crate__row').first().waitFor();
  await search.fill('paper');
  await page.waitForFunction(() => document.querySelectorAll('.workspace-sidebar .record-crate__row').length === 1);
  await sidebar.locator('.record-crate__row .record-crate__item').first().click();
  const crateState = () => page.evaluate(() => ({
    q: document.querySelector('.workspace-sidebar input[type=search]')?.value,
    rows: document.querySelectorAll('.workspace-sidebar .record-crate__row').length,
    open: document.querySelectorAll('.workspace-sidebar .record-crate__details:not([hidden])').length,
    tab: document.querySelector('.workspace-sidebar .desk-rail')?.dataset.tab,
  }));
  const crate0 = await crateState();
  await sidebar.getByRole('button', { name: 'Hide Producer and Crate' }).click();
  const collapsedStrip = await strip();
  const collapsedWidth = Math.round((await sidebar.boundingBox()).width);
  await page.screenshot({ path: path.join(outDir, 'studio-1280-collapsed.png') });
  await go(page, 'library');
  await go(page, 'studio');
  const reopen = page.locator('.workspace-sidebar__reopen');
  const stillCollapsed = await reopen.isVisible();
  await reopen.click();
  const crate1 = await crateState();
  check('B5. Hide gives the width back (44 px tab, wider strips) and stays hidden across sections',
    collapsedWidth === 44 && collapsedStrip > openStrip && stillCollapsed, { collapsedWidth, collapsedStrip, openStrip });
  check('B6. reopening keeps the Crate tab, search text and open row',
    JSON.stringify(crate0) === JSON.stringify(crate1) && crate1.q === 'paper' && crate1.open === 1 && crate1.tab === 'crate', { crate0, crate1 });
  const audioEnd = await page.evaluate(() => ({ ...window.__audio }));
  check('B7. still one AudioContext after the whole desktop journey', audioEnd.made === 1 && audioEnd.closed === 0, audioEnd);
  await page.context().close();

  // ======================================================== B. 390×844
  const phone = await newPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  await phone.goto(`${base}/#/library`);
  await phone.waitForSelector('#sidebar-open:not([hidden])');
  const perRoute = {};
  for (const route of ['library', 'activity', 'engine', 'studio']) {
    if (route !== 'library') await go(phone, route);
    const button = phone.locator('#sidebar-open');
    const visible = await button.isVisible();
    await button.click();
    const dialog = phone.locator('dialog.workspace-sheet');
    await dialog.waitFor();
    const inside = [];
    for (let i = 0; i < 12; i += 1) {
      await phone.keyboard.press('Tab');
      inside.push(await phone.evaluate(() => {
        const el = document.activeElement;
        // Past the last control Chromium hands focus to its own UI (body); the
        // page behind the modal must never receive it.
        return Boolean(el?.closest('dialog.workspace-sheet')) || el === document.body || el === null;
      }));
    }
    const box = await dialog.boundingBox();
    if (route === 'library') await phone.screenshot({ path: path.join(outDir, 'library-390-sheet.png') });
    await phone.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const focusBack = await phone.evaluate(() => document.activeElement?.id);
    // Back in the sidebar, or (Studio, narrow) under the desk as the accepted mobile desk had it.
    const railHome = await phone.evaluate((r) => Boolean(document.querySelector(r === 'studio' ? '.stem-desk .desk-rail-slot > .desk-rail' : '.workspace-sidebar .desk-rail')), route);
    perRoute[route] = { visible, trapped: inside.every(Boolean), full: Math.round(box.width) === 390 && Math.round(box.height) === 844, focusBack, railHome };
  }
  const phoneAudio = await phone.evaluate(() => ({ ...window.__audio }));
  const scrollW = await phone.evaluate(() => document.documentElement.scrollWidth);
  check('B8. at 390×844 every section has the entry point; the full-height sheet keeps Tab inside and returns focus',
    Object.values(perRoute).every((r) => r.visible && r.trapped && r.full && r.focusBack === 'sidebar-open' && r.railHome), perRoute);
  check('B9. opening and closing the sheet made no AudioContext and no horizontal scroll', phoneAudio.made === 0 && scrollW === 390, { phoneAudio, scrollW });
  await phone.context().close();

  check('no page errors', pageErrors.length === 0, pageErrors);
  check('no request left the loopback Studio', external.length === 0, external);
} catch (error) {
  check('journey completed', false, error.stack || String(error));
} finally {
  await browser.close();
  if (studio) {
    studio.kill('SIGINT');
    await new Promise((resolve) => studio.once('exit', resolve));
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
