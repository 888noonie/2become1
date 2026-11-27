#!/usr/bin/env node
// tests/browser/stem_focus.js — OPERATION STUDIO SURGEON, Act I.
//
// The Stem-Focus musician journey in real Chromium on a scratch Studio with
// two validated stem sets (Midnight Circuit / Paper Lanterns): open Focus from
// the Library (button and double-click), the Crate and an Arrangement clip;
// audition through the one shared preview with an In/Out window and loop;
// yield to the Arrangement; rename; place a selection; trim, gain, split and
// Undo a clip; keep the stem files byte-identical; return focus on close; and
// check 390 px for clipping, horizontal scroll and 44 px targets.
//
// Usage: node tests/browser/stem_focus.js http://127.0.0.1:PORT OUT_DIR DATA_DIR
// DATA_DIR is the scratch Studio's --data-dir, read (never written).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base, outDir, dataDir] = process.argv.slice(2);
if (!base || !outDir || !dataDir || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:8765$/.test(base)) {
  console.error('usage: node tests/browser/stem_focus.js http://127.0.0.1:PORT OUT_DIR DATA_DIR (never the owner Studio on 8765)');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stemFiles() {
  const root = join(dataDir, 'stems');
  const out = {};
  for (const set of readdirSync(root)) {
    for (const f of readdirSync(join(root, set))) out[`${set}/${f}`] = createHash('sha256').update(readFileSync(join(root, set, f))).digest('hex');
  }
  return out;
}

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const pageErrors = [];
const writes = [];
const audioRequests = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__ctx = { made: 0 };
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__ctx.made += 1; } };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => {
    if (/\/api\/arrangements/.test(r.url()) && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`);
    if (/\/api\/stems\/[^/]+\/audio/.test(r.url())) audioRequests.push(r.url().replace(base, ''));
  });
  const S = (fn, arg) => page.evaluate(fn, arg);
  const api = async (path) => (await page.request.get(`${base}${path}`)).json();
  const state = () => S(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const depth = () => S(() => window.__arrangement.session.edit.historyDepth.past);
  const preview = () => S(async () => {
    const { audioController: a } = await import('/assets/js/audio.js');
    return { playing: a.playing, url: a.current?.url ?? null, time: a.time };
  });
  const focusState = () => S(async () => {
    const m = await import('/assets/js/stem-focus.js');
    const h = m.activeStemFocus();
    if (!h) return null;
    const s = h.state();
    return { mode: h.mode, playing: s.playing, inSec: s.inSec, outSec: s.outSec, cursor: s.cursor, duration: s.duration, loop: s.loop, status: s.status };
  });
  const dialog = 'dialog.stem-focus[open]';
  const go = async (route) => {
    await page.locator(`.nav__link[data-route="${route}"]`).click();
    await page.waitForFunction((r) => document.querySelector(`.nav__link[data-route="${r}"]`)?.getAttribute('aria-current') === 'page', route);
    await sleep(250);
  };
  const setNumber = async (label, value) => {
    await page.fill(`${dialog} input[aria-label^="${label}"]`, String(value));
    await page.press(`${dialog} input[aria-label^="${label}"]`, 'Tab');
  };
  const inkPixels = () => S((sel) => {
    const c = document.querySelector(`${sel} canvas.stem-focus__canvas`);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
    return { n, w: c.width, h: c.height };
  }, dialog);

  const tracks = (await api('/api/tracks?limit=50')).items;
  const lanterns = tracks.find((t) => t.name === 'Paper Lanterns');
  const midnight = tracks.find((t) => t.name === 'Midnight Circuit');
  {
    const pre = (await api(`/api/tracks/${lanterns.id}/stems`)).variants.find((v) => v.name === 'vocals');
    if (pre.custom_name) await page.request.patch(`${base}/api/stem-sets/${pre.stem_set_id}/names`, { data: { names: { vocals: null } } });
  }
  const vocals = (await api(`/api/tracks/${lanterns.id}/stems`)).variants.find((v) => v.name === 'vocals');
  const SET = vocals.stem_set_id;
  const filesBefore = stemFiles();
  check('setup: two validated stem sets in a scratch Studio', Boolean(lanterns && midnight && SET) && Object.keys(filesBefore).length === 8);

  // ---- 0. A fresh Arrangement with Midnight Circuit on A ------------------
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.click('.daw__project button:has-text("New")');
  await page.fill('input[aria-label="Arrangement name"]', 'Studio Surgeon');
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--A select[aria-label^="Track"] option').length > 1);
  const value = await page.$eval('.daw__import-row--A select[aria-label^="Track"]', (s) => [...s.options].find((o) => o.text.includes('Midnight Circuit'))?.value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Track"]', value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Section length"]', '30');
  await page.click('.daw__bring--A');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 4, null, { timeout: 120000 });
  await S(() => { window.__arrangement.__tag = 'surgeon'; });
  const roleTokens = await page.$$eval('.daw__clip', (els) => els.map((e) => e.dataset.roleToken));
  check('0. Arrangement clips carry their role token and glyph; the A bank stays A',
    JSON.stringify(roleTokens.slice().sort()) === JSON.stringify(['bass', 'drums', 'other', 'vocals'])
      && (await page.$$('.daw__clip .daw__clip-role svg')).length === 4 && (await page.$$('.daw__clip.daw__clip--A')).length === 4, { roleTokens });
  const ctxBefore = await S(() => window.__ctx.made);

  // ---- 1. Library: Focus button opens asset mode; nothing plays -----------
  await go('library');
  const card = `.track-card[data-track-id="${lanterns.id}"]`;
  await page.waitForSelector(card);
  await page.click(`${card} button[data-action="stems"]`);
  await page.waitForFunction((c) => document.querySelectorAll(`${c} .stem-sleeve__row`).length === 4, card);
  const rowSel = `${card} [data-stem-key="${SET}:vocals"]`;
  const tokens = await page.$$eval(`${card} .stem-sleeve__row`, (rows) => rows.map((r) => [r.dataset.roleToken, r.querySelector('.role-chip')?.textContent]));
  check('1. Library rows show role chips with glyph and written role', tokens.every(([t, txt]) => t && txt && txt.toLowerCase() === t), { tokens });
  const focusBtn = `${rowSel} button[data-stem-action="focus"]`;
  audioRequests.length = 0;
  await page.click(focusBtn);
  await page.waitForSelector(dialog);
  await page.waitForFunction((d) => document.querySelector(`${d} [data-testid="focus-wave"]`)?.dataset.source === 'stem-file', dialog, { timeout: 15000 });
  await sleep(200);
  const idText = await page.textContent(dialog);
  check('1. asset mode shows name, original role, recording, stem set, method and availability',
    /Library stem/.test(idText) && /original role name/.test(idText) && /“Paper Lanterns”/.test(idText)
      && idText.includes(`${SET.slice(0, 8)} · role token vocals`) && /Imported by you|Demucs/.test(idText) && /stem audio available/.test(idText), { idText: idText.slice(0, 400) });
  const ink = await inkPixels();
  check('1. the waveform is drawn from the stored stem file\'s peaks (1200 bins)',
    (await page.getAttribute(`${dialog} [data-testid="focus-wave"]`, 'data-bins')) === '1200' && ink.n > ink.w, ink);
  const p0 = await preview();
  check('1. opening plays nothing, fetches no audio and makes no AudioContext',
    !p0.playing && audioRequests.length === 0 && (await S(() => window.__ctx.made)) === ctxBefore, { p0, audioRequests });
  await page.screenshot({ path: join(outDir, 'focus-desktop-asset.png') });

  // ---- 2. Audition: window, loop, stop at Out ----------------------------
  await setNumber('Selection start', 2);
  await setNumber('Selection end', 3);
  await page.click(`${dialog} input[aria-keyshortcuts="L"]`);
  await page.click(`${dialog} button[data-focus-action="play"]`);
  await sleep(2600);
  const p1 = await preview();
  const f1 = await focusState();
  check('2. Play uses the ONE shared preview on the stem route; Loop keeps it between In and Out',
    p1.playing && p1.url === vocals.audio_url && p1.time >= 1.95 && p1.time <= 3.15 && f1.playing && audioRequests.every((u) => u.startsWith(vocals.audio_url)), { p1, f1 });
  await page.click(`${dialog} input[aria-keyshortcuts="L"]`);
  await sleep(1600);
  const p2 = await preview();
  const f2 = await focusState();
  check('2. with Loop off, playback stops at Out and the cursor returns to In', !p2.playing && !f2.playing && Math.abs(f2.cursor - 2) < 0.05 && /Reached Out/.test(f2.status), { p2, f2 });
  check('2. the preview made no AudioContext', (await S(() => window.__ctx.made)) === ctxBefore);

  // ---- 3. Rename from Focus; Escape returns focus -------------------------
  await page.click(`${dialog} [data-testid="focus-tools"] > summary`);
  await page.fill(`${dialog} [data-focus-field="name"]`, 'Focus Lead');
  await page.press(`${dialog} [data-focus-field="name"]`, 'Enter');
  await page.waitForFunction((d) => document.querySelector(`${d} .stem-focus__title`)?.textContent === 'Focus Lead', dialog);
  const renamed = (await api(`/api/tracks/${lanterns.id}/stems`)).variants.find((v) => v.name === 'vocals');
  check('3. Rename in Focus changes the label only; the row behind updates live',
    renamed.display_name === 'Focus Lead' && renamed.audio_url === vocals.audio_url && renamed.stem_set_id === SET
      && (await page.textContent(`${rowSel} .stem-sleeve__label`)) === 'Focus Lead' && JSON.stringify(stemFiles()) === JSON.stringify(filesBefore));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.stem-focus'));
  check('3. Escape closes; focus returns to the Focus button', await S((s) => document.activeElement === document.querySelector(s), focusBtn));
  await page.dblclick(`${rowSel} .stem-sleeve__facts`);
  await page.waitForSelector(dialog);
  check('3. a double-click on the stem row opens the same panel', (await focusState())?.mode === 'asset');

  // ---- 4. Place a selection in the Arrangement ---------------------------
  await page.waitForFunction((d) => document.querySelector(`${d} [data-testid="focus-wave"]`)?.dataset.source === 'stem-file', dialog);
  await setNumber('Selection start', 4);
  await setNumber('Selection end', 9.5);
  if (!(await page.getAttribute(`${dialog} [data-testid="focus-tools"]`, 'open'))) await page.click(`${dialog} [data-testid="focus-tools"] > summary`);
  await page.click(`${dialog} button[data-focus-action="place"]`);
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="place-stem"]').hidden);
  const lengthText = await page.$eval('select[aria-label="Length of the stem to place"]', (s) => s.selectedOptions[0].textContent);
  check('4. the Arrangement offers exactly the Focus selection', /Focus selection \(5\.50 s from 0:04\.0\)/.test(lengthText), { lengthText });
  check('4. the same Arrangement instance, clips and history', (await S(() => window.__arrangement.__tag)) === 'surgeon' && (await state()).clips.length === 4);
  await page.selectOption('select[aria-label="Lane for the stem"]', '4');
  await page.fill('input[aria-label="Bar the stem starts at"]', '3');
  const d4 = await depth();
  audioRequests.length = 0;
  await page.click('button:has-text("Place on lane")');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 5, null, { timeout: 30000 });
  const st4 = await state();
  const placed = st4.clips.find((c) => c.trackIndex === 4);
  const bpm = st4.transport.masterBpm;
  const placedAsset = st4.assets[placed.assetId];
  check('4. ONE clip on lane 5 at bar 3 plays exactly 5.5 s from 0:04 of the stem, at its own speed',
    (await depth()) === d4 + 1 && placed.timelineStartBeat === 8 && placed.sourceOffsetSec === 0
      && Math.abs(placed.durationBeats - 5.5 * bpm / 60) < 1e-6 && placedAsset.bufferReference === `${vocals.audio_url}&start=4&duration=30`,
    { placed, ref: placedAsset.bufferReference });
  check('4. the clip keeps (set, role) and its recording', placedAsset.source.stemSetId === SET && placedAsset.source.role === 'vocals' && placedAsset.source.title === 'Paper Lanterns');

  // ---- 5. Clip mode from the Arrangement ---------------------------------
  const clipSel = `.daw__clip[data-clip-id="${placed.id}"]`;
  await page.locator(clipSel).scrollIntoViewIfNeeded();
  await page.dblclick(clipSel);
  await page.waitForSelector(dialog);
  await page.waitForFunction((d) => document.querySelector(`${d} [data-testid="focus-wave"]`)?.dataset.source === 'decoded-clip', dialog);
  const f5 = await focusState();
  const clipText = await page.textContent(dialog);
  check('5. double-clicking the clip opens clip mode with its live name, lane and bank',
    f5.mode === 'clip' && /Clip in the Arrangement/.test(clipText) && /Focus Lead/.test(clipText) && /lane 5, bank B/.test(clipText), { clipText: clipText.slice(0, 300) });
  check('5. the clip waveform is the PCM the Arrangement already decoded (no new audio request)', audioRequests.length === 1 && (await inkPixels()).n > 0, { audioRequests });
  await page.screenshot({ path: join(outDir, 'focus-desktop-clip.png') });

  // Preview, then Hear it in place: one sound at a time, said out loud.
  await page.click(`${dialog} button[data-focus-action="play"]`);
  await sleep(700);
  const p5 = await preview();
  check('5. clip preview seeks to the section in the full stem', p5.playing && p5.url === vocals.audio_url && p5.time >= 4 && p5.time < 5.5, p5);
  await page.click(`${dialog} [data-testid="focus-tools"] > summary`);
  await page.click(`${dialog} button[data-focus-action="hear-in-place"]`);
  await page.waitForFunction(() => window.__arrangement.session.isPlaying(), null, { timeout: 30000 });
  await sleep(400);
  const p6 = await preview();
  check('5. Hear it in place plays the Arrangement and the preview stops: one sound, one AudioContext',
    !p6.playing && (await S(() => window.__arrangement.session.isPlaying())) && (await S(() => window.__ctx.made)) === ctxBefore + 1, { p6 });
  await page.click(`${dialog} button[data-focus-action="play"]`);
  await sleep(500);
  check('5. starting the Focus preview stops the Arrangement', !(await S(() => window.__arrangement.session.isPlaying())) && (await preview()).playing);
  await page.click(`${dialog} button.stem-focus__stop`);

  // ---- 6. Surgical edits through the one history -------------------------
  const before6 = await state();
  const d6 = await depth();
  await setNumber('Selection start', 1);
  await setNumber('Selection end', 4);
  await page.click(`${dialog} button[data-focus-action="trim"]`);
  const t6 = (await state()).clips.find((c) => c.id === placed.id);
  check('6. Trim to selection: same start, plays 1–4 s of its section, one undo step',
    (await depth()) === d6 + 1 && t6.timelineStartBeat === 8 && Math.abs(t6.sourceOffsetSec - 1) < 1e-9 && Math.abs(t6.durationBeats - 3 * bpm / 60) < 1e-6, { t6 });
  await page.focus(`${dialog} input[aria-label="Clip gain"]`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await sleep(100);
  const g6 = (await state()).clips.find((c) => c.id === placed.id);
  check('6. Clip gain moves from the keyboard (track level untouched)', g6.clipGainDb === -1 && (await state()).tracks[4].volumeDb === before6.tracks[4].volumeDb, { gain: g6.clipGainDb });
  await S(async () => { const m = await import('/assets/js/stem-focus.js'); m.activeStemFocus().moveCursor(2.5); });
  await page.click(`${dialog} button[data-focus-action="split"]`);
  const s6 = await state();
  check('6. Split at the cursor makes two clips on lane 5', s6.clips.filter((c) => c.trackIndex === 4).length === 2);
  const steps = (await depth()) - d6;
  for (let i = 0; i < steps; i += 1) await page.click(`${dialog} button[data-focus-action="undo"]`);
  const u6 = await state();
  check('6. Undo from the panel restores the clip exactly; no asset was added',
    JSON.stringify(u6.clips) === JSON.stringify(before6.clips) && JSON.stringify(Object.keys(u6.assets)) === JSON.stringify(Object.keys(before6.assets)), { steps });
  check('6. NEGATIVE: the stem files on disk are byte-identical', JSON.stringify(stemFiles()) === JSON.stringify(filesBefore));
  // Arrangement shortcuts do not fire from inside the panel.
  await page.focus(`${dialog} button[data-focus-action="play"]`);
  await page.keyboard.press('Delete');
  await page.keyboard.press('s');
  check('6. Delete and S inside the panel do not edit the arrangement', (await state()).clips.length === 5);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.stem-focus'));
  check('6. Escape closes; focus returns to the clip', await S((s) => document.activeElement === document.querySelector(s), clipSel));
  await page.keyboard.press('f');
  await page.waitForSelector(dialog);
  check('6. F on the selected clip opens Focus from the keyboard', (await focusState())?.mode === 'clip');
  await page.keyboard.press('Escape');

  // ---- 7. Crate: same panel, continuity ------------------------------------
  await go('studio');
  await page.click('[role="tab"][data-tab="crate"]');
  await page.waitForSelector('.record-crate__search');
  await page.fill('.record-crate__search', '');
  await page.waitForFunction(() => document.querySelectorAll('.record-crate__row').length === 2, null, { timeout: 10000 });
  const rowCrate = `.record-crate__row[data-track-id="${lanterns.id}"]`;
  if (!(await page.$(`${rowCrate} .record-crate__stems .stem-sleeve__row`))) await page.click(`${rowCrate} .record-crate__item`);
  await page.waitForFunction((r) => document.querySelectorAll(`${r} .record-crate__stems .stem-sleeve__row`).length === 4, rowCrate, { timeout: 10000 });
  const crateBtn = `${rowCrate} [data-stem-key$=":vocals"] button[data-stem-action="focus"]`;
  await page.click(crateBtn);
  await page.waitForSelector(dialog);
  await page.waitForFunction((d) => document.querySelector(`${d} [data-testid="focus-wave"]`)?.dataset.source === 'stem-file', dialog);
  const crateText = await page.textContent(dialog);
  await page.click(`${dialog} button[aria-pressed="false"]:text-is("Play")`);
  await page.waitForFunction(async () => (await import('/assets/js/audio.js')).audioController.playing);
  check('7. Crate and Library resolve the same renamed vocal stem',
    (await page.getAttribute(dialog, 'data-role-token')) === 'vocals'
    && /“Paper Lanterns”/.test(crateText) && /Focus Lead/.test(crateText)
    && crateText.includes(SET.slice(0, 8)) && (await preview()).url === vocals.audio_url);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.stem-focus'));
  check('7. focus returns to the Crate row; the row stays expanded', await S((s) => document.activeElement === document.querySelector(s), crateBtn)
    && (await page.$$(`${rowCrate} .record-crate__stems .stem-sleeve__row`)).length === 4);
  await go('studio');
  check('7. the Arrangement is the same instance after Library → Studio → Crate', (await S(() => window.__arrangement.__tag)) === 'surgeon' && (await state()).clips.length === 5);

  // ---- 8. Restore the name; no saves --------------------------------------
  await page.request.patch(`${base}/api/stem-sets/${SET}/names`, { data: { names: { vocals: null } } });
  check('8. nothing was saved to /api/arrangements during the journey', writes.length === 0, writes);

  // ---- 9. 390 px: clipping, horizontal scroll, targets ---------------------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const m = await mobile.newPage();
  m.on('pageerror', (e) => pageErrors.push(`390: ${e.message}`));
  await m.goto(`${base}/#/library`);
  await m.waitForSelector(card);
  await m.click(`${card} button[data-action="stems"]`);
  await m.waitForFunction((c) => document.querySelectorAll(`${c} .stem-sleeve__row`).length === 4, card);
  const mFocus = await m.$eval(`${rowSel} button[data-stem-action="focus"]`, (b) => b.getBoundingClientRect().height);
  await m.tap(`${rowSel} button[data-stem-action="focus"]`);
  await m.waitForSelector(dialog);
  await m.click(`${dialog} [data-testid="focus-tools"] > summary`);
  await sleep(300);
  const layout = await m.evaluate((d) => {
    const dlg = document.querySelector(d);
    const r = dlg.getBoundingClientRect();
    const small = [...dlg.querySelectorAll('button, summary, input[type="checkbox"], input[type="number"], input[type="text"], input[type="range"]')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el: (el.textContent || el.getAttribute('aria-label') || el.type).trim().slice(0, 30), h: Math.round((el.closest('label') ?? el).getBoundingClientRect().height) }))
      .filter((x) => x.h < 44);
    return {
      docScroll: document.documentElement.scrollWidth, vw: window.innerWidth,
      left: Math.round(r.left), right: Math.round(r.right),
      inner: dlg.scrollWidth <= dlg.clientWidth + 1, small,
    };
  }, dialog);
  check('9. 390 px: the panel fits, with no horizontal scroll', layout.docScroll <= layout.vw && layout.left >= 0 && layout.right <= 390 && layout.inner, layout);
  check('9. 390 px: every control in the panel, and the row Focus button, is at least 44 px', layout.small.length === 0 && mFocus >= 44, { small: layout.small, mFocus });
  await m.screenshot({ path: join(outDir, 'focus-390-asset.png'), fullPage: false });
  await m.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await sleep(200);
  await m.screenshot({ path: join(outDir, 'focus-390-forced-colors.png'), fullPage: false });
  check('9. forced colours: the role is still written and the glyph still drawn',
    await m.evaluate((d) => /Vocals/.test(document.querySelector(`${d} .stem-focus__role`).textContent) && Boolean(document.querySelector(`${d} .stem-focus__glyph svg`)), dialog));
  await mobile.close();

  check('no page errors', pageErrors.length === 0, pageErrors);
} catch (err) {
  check('journey completed without an exception', false, { error: String(err?.stack || err) });
} finally {
  await browser.close();
}

const passed = checks.filter((c) => c.ok).length;
writeFileSync(join(outDir, 'stem-focus-results.json'), JSON.stringify({ base, passed, total: checks.length, checks }, null, 2));
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
