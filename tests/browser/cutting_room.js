#!/usr/bin/env node
// tests/browser/cutting_room.js — OPERATION THE CUTTING ROOM, Act I.
//
// A real Studio (seeded Midnight Circuit / Paper Lanterns stems), real
// Chromium, real mouse and keyboard. The musician copies, pastes, cuts, deletes
// a ruler range and splits real Arrangement clips; plays the edited
// arrangement (and edits while it plays); walks Undo/Redo; exports and the WAV
// is measured where the edits are; and navigates Studio → Library → Activity →
// Engine → Studio with the same arrangement, history and clipboard.
//
// Usage: node tests/browser/cutting_room.js http://127.0.0.1:PORT OUT_DIR
// The Studio must be a scratch --data-dir (docs/full-house-daw.md recipe).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base, outDir] = process.argv.slice(2);
if (!base || !outDir || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  console.error('usage: node tests/browser/cutting_room.js http://127.0.0.1:PORT OUT_DIR');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(...buf.subarray(o, o + 4));
  let o = 12; let fmt = null; let data = null;
  while (o + 8 <= buf.length) {
    const id = tag(o); const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data') data = { offset: o + 8, size };
    o += 8 + size + (size % 2);
  }
  const frames = data.size / (fmt.channels * 3);
  const L = new Float32Array(frames); const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < 2; c += 1) {
      const p = data.offset + (i * 2 + c) * 3;
      let v = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;
      (c ? R : L)[i] = v / 8388608;
    }
  }
  return { ...fmt, frames, L, R };
}
const rmsDb = (w, a, b) => {
  let s = 0; let n = 0;
  for (let i = Math.max(0, Math.round(a)); i < Math.min(w.L.length, Math.round(b)); i += 1) { s += w.L[i] ** 2 + w.R[i] ** 2; n += 2; }
  return n ? 10 * Math.log10(s / n + 1e-20) : -200;
};

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const pageErrors = [];
const writes = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => {
    window.__ctx = { made: 0, closed: 0 };
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig {
      constructor(...a) { super(...a); window.__ctx.made += 1; const close = this.close.bind(this); this.close = () => { window.__ctx.closed += 1; return close(); }; }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => { if (/\/api\/arrangements/.test(r.url()) && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
  const S = (fn, arg) => page.evaluate(fn, arg);
  const state = () => S(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const depth = () => S(() => window.__arrangement.session.edit.historyDepth);
  const laneClips = (st, i) => st.clips.filter((c) => c.trackIndex === i).sort((a, b) => a.timelineStartBeat - b.timelineStartBeat);

  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');

  // ---- setup: bring in two songs' stems -----------------------------------
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--A select[aria-label^="Track"] option').length > 1);
  const pick = async (group, title) => {
    const sel = `.daw__import-row--${group} select[aria-label^="Track"]`;
    const value = await page.$eval(sel, (s, t) => [...s.options].find((o) => o.text.includes(t))?.value, title);
    await page.selectOption(sel, value);
    await page.selectOption(`.daw__import-row--${group} select[aria-label^="Section length"]`, '60');
    await page.fill(`.daw__import-row--${group} input[type=number]`, '30');
    await page.click(`.daw__bring--${group}`);
    await page.waitForFunction((g) => !document.querySelector(`.daw__bring--${g}`).disabled, group, { timeout: 120000 });
  };
  await pick('A', 'Midnight Circuit');
  await pick('B', 'Paper Lanterns');
  let st = await state();
  check('setup: eight real stem clips on the lanes', st.clips.length === 8, { clips: st.clips.length });
  const imported = JSON.stringify(st.clips);
  const assetsAtImport = JSON.stringify(st.assets);
  const d0 = await depth();
  const bpm = st.transport.masterBpm;
  const spb = 60 / bpm;

  await page.selectOption('select[aria-label="Snap"]', 'bar');
  await page.click('button[aria-label="Zoom out"]');
  await page.click('button[aria-label="Zoom out"]'); // 10 px per beat
  const ppb = await S(() => [6, 10, 16, 24, 36, 54, 80, 120][window.__arrangement.ui.zoomIndex]);
  const rulerClick = async (beat) => {
    await page.locator('.daw__ruler').scrollIntoViewIfNeeded();
    await page.click('.daw__ruler', { position: { x: beat * ppb + 1, y: 12 } });
  };
  const clipEl = (id) => page.locator(`.daw__clip[data-clip-id="${id}"]`);
  const clickClip = async (id, beatInside = null) => {
    await clipEl(id).scrollIntoViewIfNeeded();
    const c = (await state()).clips.find((x) => x.id === id);
    const x = beatInside === null ? 40 : (beatInside - c.timelineStartBeat) * ppb;
    await clipEl(id).click({ position: { x, y: 30 } });
  };

  // ---- 1. Copy, then paste at the playhead ---------------------------------
  const aVocals = laneClips(st, 0)[0];
  const aDrums = laneClips(st, 1)[0]; // drums sound from the first bar of the section
  await clickClip(aDrums.id);
  const rev = await S(() => window.__arrangement.session.edit.revision);
  await page.keyboard.press('Control+c');
  check('1. Ctrl+C copies the selected clip and makes no edit',
    (await S(() => window.__arrangement.session.edit.revision)) === rev
      && (await S(() => window.__arrangement.clipboard()?.pieces.length)) === 1);
  await rulerClick(112); // bar 29, past every clip
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 9);
  st = await state();
  const pasted = laneClips(st, 1).find((c) => c.timelineStartBeat === 112);
  const same = ['durationBeats', 'sourceOffsetSec', 'stretchMode', 'customStretchRatio', 'pitchSemitones', 'clipGainDb', 'fadeInBeats', 'fadeOutBeats', 'assetId']
    .filter((k) => JSON.stringify(pasted?.[k]) !== JSON.stringify(aDrums[k]));
  check('1. Ctrl+V pastes at the playhead on the clip\'s lane with every source field unchanged', pasted && !same.length, { pasted, differs: same });
  check('1. paste reuses the same source asset (no copy, nothing re-decoded)', JSON.stringify(st.assets) === assetsAtImport);

  // ---- 2. Cut, Undo, Redo ---------------------------------------------------
  await clickClip(pasted.id);
  await page.keyboard.press('Control+x');
  st = await state();
  check('2. Ctrl+X removes the clip and keeps its source', !st.clips.some((c) => c.id === pasted.id) && JSON.stringify(st.assets) === assetsAtImport);
  await page.keyboard.press('Control+z');
  st = await state();
  check('2. Ctrl+Z brings the cut clip back exactly', JSON.stringify(st.clips.find((c) => c.id === pasted.id)) === JSON.stringify(pasted));
  await page.keyboard.press('Control+Shift+z');
  check('2. Ctrl+Shift+Z cuts it again', !(await state()).clips.some((c) => c.id === pasted.id));
  await page.click('.daw__history button:has-text("Undo")');
  check('2. the Undo button restores it', (await state()).clips.some((c) => c.id === pasted.id));

  // ---- 3. Delete a ruler range from all lanes --------------------------------
  await S(() => { window.__arrangement.elements.scroller.scrollLeft = 0; });
  await page.locator('.daw__ruler').scrollIntoViewIfNeeded();
  const rb = await page.locator('.daw__ruler').boundingBox();
  await page.mouse.move(rb.x + 16 * ppb + 2, rb.y + 12);
  await page.mouse.down();
  await page.mouse.move(rb.x + 20 * ppb, rb.y + 12);
  await page.mouse.move(rb.x + 24 * ppb + 2, rb.y + 12);
  await page.mouse.up();
  st = await state();
  check('3. dragging the ruler selects bars 5 to 7 (beats 16–24)', JSON.stringify(st.transport.loopRange) === '[16,24]', st.transport.loopRange);
  await page.click('.daw__head-name >> nth=0'); // the lane head: no clip selected
  check('3. the Edit tools show the range', /Range bar 5/.test(await page.textContent('[data-testid="edit-tools"] [data-field="region"]')));
  await page.keyboard.press('Delete');
  st = await state();
  const gaps = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const pieces = laneClips(st, i);
    const covering = pieces.filter((c) => c.timelineStartBeat < 24 - 1e-9 && c.timelineStartBeat + c.durationBeats > 16 + 1e-9);
    return { lane: i, pieces: pieces.length, covering: covering.length };
  });
  check('3. Delete removes beats 16–24 on all eight lanes and nothing else', gaps.every((g) => g.covering === 0 && g.pieces >= 2), gaps);
  const v0 = laneClips(st, 0);
  check('3. the piece after the gap plays the source from where it was (in-point advanced 24 beats)',
    Math.abs(v0[1].sourceOffsetSec - (aVocals.sourceOffsetSec + 24 * spb)) < 1e-6, { offset: v0[1].sourceOffsetSec });
  check('3. no source audio was removed', JSON.stringify(st.assets) === assetsAtImport);

  // ---- 4. Right-click split at a position; S splits at the playhead ----------
  const bDrums = laneClips(st, 5).find((c) => c.timelineStartBeat >= 24);
  await clipEl(bDrums.id).scrollIntoViewIfNeeded();
  const box = await clipEl(bDrums.id).boundingBox();
  await page.mouse.click(box.x + (40 - bDrums.timelineStartBeat) * ppb + 1, box.y + 30, { button: 'right' });
  await page.waitForSelector('.daw__menu:not([hidden])');
  const menuItems = await page.$$eval('.daw__menu [role="menuitem"]', (els) => els.map((e) => e.textContent));
  check('4. right-click on a clip opens the edit menu', menuItems.some((t) => t.startsWith('Split here')) && menuItems.some((t) => t.startsWith('Cut')), menuItems);
  await page.click('.daw__menu [role="menuitem"]:has-text("Split here")');
  st = await state();
  check('4. Split here cuts B Drums at the clicked bar (beat 40)', laneClips(st, 5).some((c) => c.timelineStartBeat === 40), laneClips(st, 5).map((c) => c.timelineStartBeat));
  const aBass = laneClips(st, 2).find((c) => c.timelineStartBeat >= 24);
  await rulerClick(48);
  await clickClip(aBass.id, 60);
  await page.keyboard.press('s');
  st = await state();
  check('4. S splits the selected clip at the playhead (beat 48)', laneClips(st, 2).some((c) => c.timelineStartBeat === 48),
    { starts: laneClips(st, 2).map((c) => c.timelineStartBeat), cue: await S(() => window.__arrangement.session.playheadBeat()),
      selected: await S(() => window.__arrangement.ui.selectedClipId), aBass: aBass.id, msgs: await S(() => window.__arrangement.session.messages.slice(-2)) });

  // ---- 5. Play the edited arrangement; edit while it plays ----------------
  await page.click('button[aria-label="Loop"]'); // the range was the edit selection; play straight through
  check('5. Loop off before playing', (await state()).transport.loopRange === null);
  await rulerClick(8);
  await page.click('button.daw__play');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 30000 });
  const p1 = await S(() => window.__arrangement.session.playheadBeat());
  await sleep(1200);
  const p2 = await S(() => window.__arrangement.session.playheadBeat());
  check('5. the edited arrangement plays (playhead advances)', p2 > p1 + 0.5, { p1, p2 });
  await page.keyboard.press('Control+z'); // undo the S split while playing
  await sleep(400);
  const playingAfterUndo = await S(() => ({ phase: window.__arrangement.session.phase(), at: window.__arrangement.session.playheadBeat() }));
  check('5. Undo while playing keeps playing (edit applied live, no restart)', playingAfterUndo.phase === 'playing' && playingAfterUndo.at > p2, playingAfterUndo);
  await page.keyboard.press('Control+Shift+z');
  await sleep(300);
  check('5. Redo while playing re-applies the split', laneClips(await state(), 2).some((c) => c.timelineStartBeat === 48)
    && (await S(() => window.__arrangement.session.phase())) === 'playing');
  await page.click('button.daw__stop');
  check('5. one AudioContext for the session', (await S(() => window.__ctx.made)) === 1, await S(() => window.__ctx));

  // ---- 6. Navigation keeps the arrangement, history and clipboard --------
  await S(() => { window.__arrangement.__tag = 'original'; });
  const before = { clips: JSON.stringify((await state()).clips), depth: await depth(), board: await S(() => JSON.stringify(window.__arrangement.clipboard())) };
  const go = async (route) => {
    await page.locator(`.nav__link[data-route="${route}"]`).click();
    await page.waitForFunction((r) => document.querySelector(`.nav__link[data-route="${r}"]`)?.getAttribute('aria-current') === 'page', route);
    await sleep(250);
  };
  const writesBeforeNav = writes.length;
  for (const route of ['library', 'activity', 'engine']) {
    await go(route);
    await page.keyboard.press('Control+v');
    await page.keyboard.press('Delete');
    await page.keyboard.press('s');
  }
  const hiddenEdits = (await state()).clips.length;
  await go('studio');
  await sleep(300);
  const after = { clips: JSON.stringify((await state()).clips), depth: await depth(), board: await S(() => JSON.stringify(window.__arrangement.clipboard())) };
  check('6. shortcuts pressed on Library, Activity and Engine edit nothing', JSON.stringify(JSON.parse(before.clips).length) === JSON.stringify(hiddenEdits) && after.clips === before.clips);
  check('6. back in Studio: same Arrangement instance, clips, history and clipboard',
    (await S(() => window.__arrangement.__tag)) === 'original' && after.clips === before.clips
      && JSON.stringify(after.depth) === JSON.stringify(before.depth) && after.board === before.board,
    { depth: [before.depth, after.depth] });
  check('6. the Arrangement surface is still the one shown', await page.isVisible('[data-testid="arrangement"]'));
  check('6. navigation saved nothing', writes.length === writesBeforeNav, writes.slice(writesBeforeNav));
  await rulerClick(136);
  await clickClip(laneClips(await state(), 0)[0].id);
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.some((c) => c.timelineStartBeat === 136));
  check('6. the clipboard still pastes after navigation', true);
  await page.keyboard.press('Control+z');
  check('6. ...and Undo removes that paste', !(await state()).clips.some((c) => c.timelineStartBeat === 136));

  // ---- 7. Export: the edits are in the rendered audio ------------------------
  const final = await state();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.click('button:has-text("Export WAV")'),
  ]);
  const wavPath = join(outDir, await download.suggestedFilename());
  await download.saveAs(wavPath);
  const wav = readWav(readFileSync(wavPath));
  const f = (beat) => beat * spb * wav.sampleRate;
  const gapDb = rmsDb(wav, f(16.25), f(23.75));
  const beforeDb = rmsDb(wav, f(8), f(15.75));
  const afterDb = rmsDb(wav, f(24.25), f(32));
  const pastedDb = rmsDb(wav, f(112.25), f(120));
  const silentDb = rmsDb(wav, f(final.clips.filter((c) => c.timelineStartBeat < 100).reduce((m, c) => Math.max(m, c.timelineStartBeat + c.durationBeats), 0) + 0.5), f(111.75));
  check('7. the deleted range is silent in the export', gapDb < -80, { gapDb });
  check('7. the music either side of the range is there', beforeDb > -40 && afterDb > -40, { beforeDb, afterDb });
  check('7. the pasted drums sound at bar 29 after silence', pastedDb > -50 && silentDb < -80, { pastedDb, silentDb });

  // ---- 8. Undo walks every edit back to the imported clips; Redo replays ----
  const steps = (await depth()).past - d0.past;
  for (let i = 0; i < steps; i += 1) await page.keyboard.press('Control+z');
  const undone = await state();
  check(`8. ${steps} Undo steps return exactly the imported clips`, JSON.stringify(undone.clips) === imported
    && JSON.stringify(undone.assets) === assetsAtImport);
  for (let i = 0; i < steps; i += 1) await page.keyboard.press('Control+Shift+z');
  check('8. Redo replays them to the exported arrangement', JSON.stringify((await state()).clips) === JSON.stringify(final.clips));

  await page.screenshot({ path: join(outDir, 'cutting-room-1440.png') });
  // The menu at phone width stays on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  const first = laneClips(await state(), 0)[0];
  await clipEl(first.id).scrollIntoViewIfNeeded();
  const pb = await clipEl(first.id).boundingBox();
  await page.mouse.click(pb.x + Math.min(30, pb.width / 2), pb.y + 20, { button: 'right' });
  await page.waitForSelector('.daw__menu:not([hidden])');
  const menuBox = await page.locator('.daw__menu').boundingBox();
  check('9. at 390 px the edit menu fits the screen with 44 px items',
    menuBox.x >= 0 && menuBox.x + menuBox.width <= 390 && menuBox.y + menuBox.height <= 844
      && (await page.$$eval('.daw__menu-item', (els) => els.every((e) => e.getBoundingClientRect().height >= 44))), menuBox);
  await page.screenshot({ path: join(outDir, 'cutting-room-390-menu.png') });
  await page.keyboard.press('Escape');
  check('9. Escape closes the menu', await page.isHidden('.daw__menu'));
  check('no page errors', pageErrors.length === 0, pageErrors);
} finally {
  await browser.close();
}
writeFileSync(join(outDir, 'cutting-room.json'), JSON.stringify({ checks }, null, 2));
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
