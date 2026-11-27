#!/usr/bin/env node
// tests/browser/record_sleeves.js — OPERATION OPEN THE RECORD SLEEVES.
//
// The complete musician journey on a scratch Studio with two validated stem
// sets (Midnight Circuit / Paper Lanterns), in real Chromium with real mouse
// and keyboard: open a recording's stems in the Library, rename Vocals, find
// it by that name in the Library and in the Crate, see its recording and role,
// bring it into another Arrangement on a lane and bar the musician chooses,
// cut/copy/paste/split it, play and export, Undo, navigate, then give the
// stem its role back and watch search and labels follow.
//
// Usage: node tests/browser/record_sleeves.js http://127.0.0.1:PORT OUT_DIR DATA_DIR
// DATA_DIR is the scratch Studio's --data-dir, read (never written) to prove
// the stem files are byte-identical after every rename.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base, outDir, dataDir] = process.argv.slice(2);
if (!base || !outDir || !dataDir || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:8765$/.test(base)) {
  console.error('usage: node tests/browser/record_sleeves.js http://127.0.0.1:PORT OUT_DIR DATA_DIR (never the owner Studio on 8765)');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = 'Lantern Lead';

/** Every stem file on disk with its sha256: the media must never change. */
function stemFiles() {
  const root = join(dataDir, 'stems');
  const out = {};
  for (const set of readdirSync(root)) {
    for (const f of readdirSync(join(root, set))) out[`${set}/${f}`] = createHash('sha256').update(readFileSync(join(root, set, f))).digest('hex');
  }
  return out;
}

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
    window.__ctx = { made: 0 };
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__ctx.made += 1; } };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => { if (/\/api\/arrangements/.test(r.url()) && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
  const S = (fn, arg) => page.evaluate(fn, arg);
  const api = async (path) => (await page.request.get(`${base}${path}`)).json();
  const state = () => S(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const depth = () => S(() => window.__arrangement.session.edit.historyDepth);
  const lane = (st, i) => st.clips.filter((c) => c.trackIndex === i).sort((a, b) => a.timelineStartBeat - b.timelineStartBeat);
  const go = async (route) => {
    await page.locator(`.nav__link[data-route="${route}"]`).click();
    await page.waitForFunction((r) => document.querySelector(`.nav__link[data-route="${r}"]`)?.getAttribute('aria-current') === 'page', route);
    await sleep(250);
  };

  const tracks = (await api('/api/tracks?limit=50')).items;
  const lanterns = tracks.find((t) => t.name === 'Paper Lanterns');
  const midnight = tracks.find((t) => t.name === 'Midnight Circuit');
  // Start from the role name (a scratch Studio may keep a label from an aborted run).
  {
    const pre = (await api(`/api/tracks/${lanterns.id}/stems`)).variants.find((v) => v.name === 'vocals');
    if (pre.custom_name) await page.request.patch(`${base}/api/stem-sets/${pre.stem_set_id}/names`, { data: { names: { vocals: null } } });
  }
  const stemsBefore = await api(`/api/tracks/${lanterns.id}/stems`);
  const vocalsBefore = stemsBefore.variants.find((v) => v.name === 'vocals');
  const SET = vocalsBefore.stem_set_id;
  const filesBefore = stemFiles();
  const audioHash = async (u) => createHash('sha256').update(await (await page.request.get(`${base}${u}`)).body()).digest('hex');
  const vocalsBytesBefore = await audioHash(vocalsBefore.audio_url);
  check('setup: two validated stem sets in a scratch Studio', Boolean(lanterns && midnight && SET) && Object.keys(filesBefore).length === 8, { files: Object.keys(filesBefore).length });

  // ---- 0. Another Arrangement: New, with Midnight Circuit on A ------------
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.click('.daw__project button:has-text("New")');
  await page.fill('input[aria-label="Arrangement name"]', 'Record Sleeves');
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--A select[aria-label^="Track"] option').length > 1);
  const value = await page.$eval('.daw__import-row--A select[aria-label^="Track"]', (s) => [...s.options].find((o) => o.text.includes('Midnight Circuit'))?.value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Track"]', value);
  await page.selectOption('.daw__import-row--A select[aria-label^="Section length"]', '60');
  await page.fill('.daw__import-row--A input[type=number]', '30');
  await page.click('.daw__bring--A');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 4, null, { timeout: 120000 });
  await S(() => { window.__arrangement.__tag = 'sleeves'; });
  const base0 = await state();
  const d0 = await depth();
  check('0. a new Arrangement holds Midnight Circuit on lanes 1–4 only', base0.clips.length === 4 && base0.clips.every((c) => c.trackIndex < 4));

  // ---- 1–3. Library: open Paper Lanterns, expand its stems, rename Vocals --
  await go('library');
  const card = `.track-card[data-track-id="${lanterns.id}"]`;
  await page.waitForSelector(card);
  await page.click(`${card} button[data-action="stems"]`);
  await page.waitForFunction((c) => document.querySelectorAll(`${c} .stem-sleeve__row`).length === 4, card);
  const rowSel = `${card} [data-stem-key="${SET}:vocals"]`;
  const rowText = await page.textContent(rowSel);
  check('2. the recording\'s four stems open beneath it, each with role, method, set and availability',
    /vocals/.test(rowText) && /Role: Vocals/.test(rowText) && /Imported by you/.test(rowText) && /stem audio available/.test(rowText)
      && /“Paper Lanterns”/.test(rowText), { rowText });
  await page.click(`${rowSel} button:has-text("Rename")`);
  await page.keyboard.type(LABEL);
  await page.keyboard.press('Enter');
  await page.waitForFunction((s) => document.querySelector(`${s} .stem-sleeve__label`)?.textContent === 'Lantern Lead', rowSel);
  const focusedAfter = await S((s) => document.activeElement === document.querySelector(`${s} button[data-stem-action="rename"]`), rowSel);
  check('3. Vocals renamed in place; focus stays on that stem; the list stays open', focusedAfter
    && (await page.getAttribute(`${card} button[data-action="stems"]`, 'aria-expanded')) === 'true'
    && (await page.$$(`${card} .stem-sleeve__row`)).length === 4);
  check('3. the other recording\'s card did not open', (await page.$$(`.track-card[data-track-id="${midnight.id}"] .stem-sleeve__row`)).length === 0);
  const stemsAfter = await api(`/api/tracks/${lanterns.id}/stems`);
  const vocalsAfter = stemsAfter.variants.find((v) => v.name === 'vocals');
  check('3. NEGATIVE: the rename changed the label only — same role, set, audio URL and audio bytes',
    vocalsAfter.display_name === LABEL && vocalsAfter.name === 'vocals' && vocalsAfter.stem_set_id === SET
      && vocalsAfter.audio_url === vocalsBefore.audio_url && (await audioHash(vocalsAfter.audio_url)) === vocalsBytesBefore,
    { vocalsAfter });
  check('3. NEGATIVE: no stem file was renamed, added or changed on disk', JSON.stringify(stemFiles()) === JSON.stringify(filesBefore));

  // ---- 4. Library search for the new name ---------------------------------
  await page.fill('input[aria-label="Search tracks and stem names"]', 'lantern lead');
  await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 1
    && document.querySelector('.track-card__stems--match .stem-sleeve__label')?.textContent === 'Lantern Lead', null, { timeout: 10000 });
  const libMatch = await page.textContent('.track-card__stems--match');
  check('4. Library search finds the stem by its name, beneath its one recording',
    (await page.$$('.track-card')).length === 1 && /Paper Lanterns/.test(await page.textContent('.track-card .track-card__title'))
      && /Role: Vocals/.test(libMatch) && /found by stem; the recording name does not match/.test(libMatch) && /Matched by its name/.test(libMatch), { libMatch });
  const page1 = await api('/api/tracks?q=lantern%20lead');
  check('4. the result count is one recording', page1.total === 1 && page1.items.length === 1 && page1.items[0].match.stems.length === 1);
  await page.fill('input[aria-label="Search tracks and stem names"]', 'vocals');
  await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 2 && document.querySelectorAll('.track-card__stems--match .stem-sleeve__row').length === 2, null, { timeout: 10000 });
  const both = await page.$$eval('.track-card', (cards) => cards.map((c) => ({
    title: c.querySelector('.track-card__title').textContent,
    stem: c.querySelector('.track-card__stems--match .stem-sleeve__label')?.textContent,
    facts: c.querySelector('.track-card__stems--match .stem-sleeve__facts')?.textContent,
  })));
  check('4. a role search lists each recording\'s vocals under its own recording, distinguishable by set',
    both.length === 2 && new Set(both.map((b) => b.facts)).size === 2 && both.some((b) => b.title === 'Paper Lanterns' && b.stem === LABEL)
      && both.some((b) => b.title === 'Midnight Circuit' && b.stem === 'vocals'), both);

  // ---- 5–6. The Crate finds it too, with its recording and role ----------
  await go('studio');
  await page.click('[role="tab"][data-tab="crate"]');
  await page.waitForSelector('.record-crate__search');
  await page.fill('.record-crate__search', 'lantern lead');
  await page.waitForFunction(() => document.querySelectorAll('.record-crate__row').length === 1
    && document.querySelector('.record-crate__stem-match .stem-sleeve__label')?.textContent === 'Lantern Lead', null, { timeout: 10000 });
  const crateMatch = await page.textContent('.record-crate__stem-match');
  check('5. the Crate finds the renamed stem as one recording row', (await page.$$('.record-crate__row')).length === 1);
  check('6. the original recording and the original role stay visible', /“Paper Lanterns”/.test(crateMatch) && /Role: Vocals/.test(crateMatch)
    && /Paper Lanterns/.test(await page.textContent('.record-crate__row .record-crate__title')), { crateMatch });
  await page.fill('.record-crate__search', '');
  await page.waitForFunction(() => document.querySelectorAll('.record-crate__row').length === 2 && !document.querySelector('.record-crate__stem-match'), null, { timeout: 10000 });
  await page.click(`.record-crate__row[data-track-id="${midnight.id}"] .record-crate__item`);
  await page.waitForFunction((id) => document.querySelectorAll(`.record-crate__row[data-track-id="${id}"] .record-crate__stems .stem-sleeve__row`).length === 4, midnight.id, { timeout: 10000 });
  check('5. with no search, an expanded Crate row reads its stems from the stem route', true);
  await page.click(`.record-crate__row[data-track-id="${midnight.id}"] .record-crate__item`);
  await page.fill('.record-crate__search', 'lantern lead');
  await page.waitForSelector('.record-crate__stem-match button:has-text("Use in Arrangement")');

  // ---- 7. Bring it into the Arrangement, where the musician says ---------
  await page.click('.record-crate__stem-match button:has-text("Use in Arrangement")');
  await page.waitForSelector('[data-testid="place-stem"]:not([hidden])');
  const placeText = await page.textContent('[data-testid="place-stem"]');
  check('7. the Arrangement offers the stem with its name, role and recording; no lane or bar is chosen for you',
    /Lantern Lead/.test(placeText) && /Vocals stem/.test(placeText) && /“Paper Lanterns”/.test(placeText)
      && (await page.inputValue('select[aria-label="Lane for the stem"]')) === '' && (await page.inputValue('input[aria-label="Bar the stem starts at"]')) === '', { placeText });
  check('7. choosing it decoded and played nothing', (await S(() => window.__ctx.made)) === 0 && (await state()).clips.length === 4);
  await page.selectOption('select[aria-label="Lane for the stem"]', '0');
  await page.fill('input[aria-label="Bar the stem starts at"]', '3');
  await page.selectOption('select[aria-label="Length of the stem to place"]', '30');
  await page.fill('input[aria-label="Start inside the stem (seconds)"]', '30');
  await page.click('.daw__place-go');
  await page.waitForFunction(() => window.__arrangement.session.messages.at(-1)?.code === 'PLACE_OCCUPIED', null, { timeout: 60000 });
  check('7. an occupied lane is refused; nothing moved or was replaced', JSON.stringify((await state()).clips) === JSON.stringify(base0.clips));
  await page.selectOption('select[aria-label="Lane for the stem"]', '4');
  await page.click('.daw__place-go');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 5, null, { timeout: 60000 });
  let st = await state();
  const placed = lane(st, 4)[0];
  const asset = st.assets[placed.assetId];
  const bpb = st.transport.timeSignature[0];
  check('7. one clip on lane 5 at bar 3; lanes 1–4 untouched', placed.timelineStartBeat === 2 * bpb
    && JSON.stringify(st.clips.filter((c) => c.trackIndex < 4)) === JSON.stringify(base0.clips), { start: placed.timelineStartBeat });
  check('7. the asset keeps (stem_set_id, role) and the original recording; the reference names the role, not the label',
    asset.source.stemSetId === SET && asset.source.role === 'vocals' && asset.source.trackId === lanterns.id && asset.source.title === 'Paper Lanterns'
      && asset.bufferReference === `${vocalsBefore.audio_url}&start=30&duration=30` && !JSON.stringify(st).includes(LABEL), { asset });
  check('7. the lane shows the owner\'s name live', /Lantern Lead/.test(await page.textContent(`.daw__clip[data-clip-id="${placed.id}"] .daw__clip-label`)));
  check('7. placing started no playback', (await S(() => window.__ctx.made)) === 0 && (await S(() => window.__arrangement.session.phase())) !== 'playing');

  // Save now, with the custom name: the saved document must not depend on it.
  await page.click('.daw__project button:has-text("Save")');
  await page.waitForFunction(() => /Saved/i.test(document.querySelector('[data-field="save-state"]')?.textContent || ''), null, { timeout: 20000 });
  const savedId = await S(() => window.__arrangement.session.projectId ?? window.__arrangement.session.savedId ?? null);
  const list = await api('/api/arrangements');
  const saved = list.items.find((i) => i.name === 'Record Sleeves');
  const savedDoc = saved ? await api(`/api/arrangements/${saved.id}`) : null;
  check('7. the saved arrangement holds the stem reference and no display name',
    Boolean(savedDoc) && JSON.stringify(savedDoc).includes('name=vocals') && !JSON.stringify(savedDoc).includes(LABEL), { savedId, saved });

  // ---- 8. Cut, Copy, Paste and Split the placed clip ----------------------
  const clipEl = (id) => page.locator(`.daw__clip[data-clip-id="${id}"]`);
  // A lane re-render (Save, a live label) can replace the node mid-scroll.
  const boxOf = async (id) => {
    for (let i = 0; ; i += 1) {
      try {
        await clipEl(id).scrollIntoViewIfNeeded({ timeout: 2000 });
        return await clipEl(id).boundingBox();
      } catch (err) { if (i >= 5) throw err; await sleep(200); }
    }
  };
  const box = await boxOf(placed.id);
  await page.mouse.click(box.x + 20, box.y + 30);
  await page.waitForFunction((id) => window.__arrangement.ui.selectedClipId === id, placed.id);
  await page.keyboard.press('Control+c');
  await S((b) => window.__arrangement.session.seek(b), 16 * bpb);
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 6, null, { timeout: 30000 });
  st = await state();
  const pasted = lane(st, 4).find((c) => c.timelineStartBeat === 16 * bpb);
  check('8. Copy + Paste puts a second piece of the same stem at bar 17 on its lane', Boolean(pasted) && pasted.assetId === placed.assetId);
  await page.mouse.click(box.x + 20, box.y + 30);
  await page.waitForFunction((id) => window.__arrangement.ui.selectedClipId === id, placed.id);
  await S((b) => window.__arrangement.session.seek(b), 6 * bpb);
  await page.keyboard.press('s');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 7);
  st = await state();
  const pieces = lane(st, 4);
  check('8. S splits the placed clip at bar 7; both halves keep the stem identity', pieces.length === 3
    && pieces[1].timelineStartBeat === 6 * bpb && pieces.every((c) => st.assets[c.assetId].source.stemSetId === SET));
  const box2 = await boxOf(pieces[1].id);
  await page.mouse.click(box2.x + 20, box2.y + 30);
  await page.waitForFunction((id) => window.__arrangement.ui.selectedClipId === id, pieces[1].id);
  await page.keyboard.press('Control+x');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 6);
  st = await state();
  const finalLane = lane(st, 4);
  check('8. Cut removes the second half from the lane; its source stays in the project', finalLane.length === 2
    && Boolean(st.assets[placed.assetId]));

  // ---- 9. Play, then export with lane 5 soloed --------------------------
  await S(() => window.__arrangement.session.seek(0));
  await page.click('button.daw__play');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 30000 });
  const p1 = await S(() => window.__arrangement.session.playheadBeat());
  await sleep(1200);
  const p2 = await S(() => window.__arrangement.session.playheadBeat());
  check('9. the arrangement with the reused stem plays (playhead advances)', p2 > p1 + 0.5, { p1, p2 });
  await page.click('button.daw__stop');
  check('9. one AudioContext, made by Play', (await S(() => window.__ctx.made)) === 1);
  const laneName = st.tracks[4].name;
  await page.click(`button[aria-label="Solo ${laneName}"]`);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.click('button:has-text("Export WAV")'),
  ]);
  const wavPath = join(outDir, await download.suggestedFilename());
  await download.saveAs(wavPath);
  const wav = readWav(readFileSync(wavPath));
  const spb = 60 / st.transport.masterBpm;
  const f = (beat) => beat * spb * wav.sampleRate;
  const first = finalLane[0];
  const second = finalLane[1];
  const beforeDb = rmsDb(wav, f(0.25), f(first.timelineStartBeat - 0.25));
  const firstDb = rmsDb(wav, f(first.timelineStartBeat + 0.25), f(first.timelineStartBeat + first.durationBeats - 0.25));
  const gapDb = rmsDb(wav, f(first.timelineStartBeat + first.durationBeats + 0.25), f(second.timelineStartBeat - 0.25));
  const secondDb = rmsDb(wav, f(second.timelineStartBeat + 0.25), f(second.timelineStartBeat + Math.min(second.durationBeats, 16) - 0.25));
  check('9. export (lane 5 solo): silent before bar 3, the stem sounds where placed, silent where it was cut, and the pasted copy sounds',
    beforeDb < -80 && firstDb > -60 && gapDb < -80 && secondDb > -60, { beforeDb, firstDb, gapDb, secondDb });
  await page.click(`button[aria-label="Solo ${laneName}"]`);

  // ---- 10. Undo back to before the stem; the source is untouched --------
  const steps = (await depth()).past - d0.past;
  for (let i = 0; i < steps; i += 1) await page.keyboard.press('Control+z');
  st = await state();
  check(`10. ${steps} Undo steps return exactly the arrangement before the stem was placed`, JSON.stringify(st.clips) === JSON.stringify(base0.clips));
  check('10. the original stem file and its audio are untouched', JSON.stringify(stemFiles()) === JSON.stringify(filesBefore)
    && (await audioHash(vocalsBefore.audio_url)) === vocalsBytesBefore);
  for (let i = 0; i < steps; i += 1) await page.keyboard.press('Control+Shift+z');
  const redone = await state();
  check('10. Redo brings the edits back', lane(redone, 4).length === 2);

  // ---- 11. Change sections; the Studio session survives -----------------
  const before = { clips: JSON.stringify(redone.clips), depth: JSON.stringify(await depth()) };
  const writesBefore = writes.length;
  for (const route of ['library', 'activity', 'engine']) {
    await go(route);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+v');
  }
  await go('studio');
  await sleep(300);
  check('11. Library → Activity → Engine → Studio: the same Arrangement, clips and history; nothing saved',
    (await S(() => window.__arrangement.__tag)) === 'sleeves' && JSON.stringify((await state()).clips) === before.clips
      && JSON.stringify(await depth()) === before.depth && writes.length === writesBefore && await page.isVisible('[data-testid="arrangement"]'));

  // ---- 12. Clear the name: search and labels follow ---------------------
  await go('library');
  await page.fill('input[aria-label="Search tracks and stem names"]', '');
  await page.waitForFunction((c) => document.querySelector(c), card);
  if ((await page.getAttribute(`${card} button[data-action="stems"]`, 'aria-expanded')) !== 'true') await page.click(`${card} button[data-action="stems"]`);
  await page.waitForSelector(`${rowSel} button:has-text("Original name")`);
  await page.click(`${rowSel} button:has-text("Original name")`);
  await page.waitForFunction((s) => document.querySelector(`${s} .stem-sleeve__label`)?.textContent === 'vocals', rowSel);
  check('12. Original name gives the stem its role back; focus stays on it',
    (await S((s) => document.activeElement === document.querySelector(`${s} button[data-stem-action="rename"]`), rowSel)));
  await page.fill('input[aria-label="Search tracks and stem names"]', 'lantern lead');
  await page.waitForFunction(() => document.querySelectorAll('.track-card').length === 0, null, { timeout: 10000 });
  check('12. the old name no longer finds anything', (await api('/api/tracks?q=lantern%20lead')).total === 0);
  await go('studio');
  const labelNow = await page.textContent(`.daw__clip[data-clip-id="${placed.id}"] .daw__clip-label`);
  check('12. the Arrangement clip now reads its role, without editing the project', !/Lantern Lead/.test(labelNow)
    && JSON.stringify((await state()).clips) === before.clips, { labelNow });
  await page.focus('select[aria-label="Saved arrangements"]');
  await page.waitForFunction(() => [...document.querySelector('select[aria-label="Saved arrangements"]').options].some((o) => o.text.startsWith('Record Sleeves')));
  const reopen = await page.$eval('select[aria-label="Saved arrangements"]', (s) => [...s.options].find((o) => o.text.startsWith('Record Sleeves'))?.value);
  // Export saved the arrangement while the stem still had its custom name.
  const lastSaved = (await api(`/api/arrangements/${reopen}`)).project;
  await S(() => window.__arrangement.session.newProject());
  await page.selectOption('select[aria-label="Saved arrangements"]', reopen);
  await page.click('.daw__project button:has-text("Open")');
  await page.waitForFunction((n) => window.__arrangement.session.state.clips.length === n, lastSaved.clips.length, { timeout: 60000 });
  const reopened = await state();
  check('12. the arrangement saved under the old name reopens with its stem, unbroken by the rename',
    JSON.stringify(reopened.clips) === JSON.stringify(lastSaved.clips) && lane(reopened, 4).length === 2
      && reopened.assets[lane(reopened, 4)[0].assetId].bufferReference === asset.bufferReference
      && !JSON.stringify(lastSaved).includes(LABEL), { clips: reopened.clips.length });

  // ---- 390 px: the stem list fits a phone --------------------------------
  await go('library');
  await page.fill('input[aria-label="Search tracks and stem names"]', '');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector(`${card} button[data-action="stems"]`);
  if ((await page.getAttribute(`${card} button[data-action="stems"]`, 'aria-expanded')) !== 'true') await page.click(`${card} button[data-action="stems"]`);
  await page.waitForSelector(`${card} .stem-sleeve__row`);
  const phone = await S((c) => ({
    scroll: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll(`${c} .stem-sleeve button`)].filter((b) => b.getBoundingClientRect().height < 44).length,
  }), card);
  check('390 px: no horizontal scroll and every stem button is at least 44 px', phone.scroll <= 390 && phone.small === 0, phone);
  await page.screenshot({ path: join(outDir, 'record-sleeves-390-library.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  check('no page errors', pageErrors.length === 0, pageErrors);
} finally {
  await browser.close();
}
writeFileSync(join(outDir, 'record-sleeves.json'), JSON.stringify({ checks }, null, 2));
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
