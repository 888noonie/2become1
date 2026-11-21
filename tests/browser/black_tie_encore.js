#!/usr/bin/env node
// OPERATION BLACK TIE ENCORE — the whole levels workflow in real Chromium
// against a seeded loopback Studio (two prepared four-stem fixture tracks).
// Real mouse and keyboard drive every edit; page state is only READ, except
// that the offline renderer is wrapped to measure what the export contains.
//   node tests/browser/black_tie_encore.js <studio-url> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base = 'http://127.0.0.1:8796', outDir = 'black-tie-encore-out'] = process.argv.slice(2);
const A11Y_SOURCE = readFileSync(new URL('./a11y.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export \{.*$/m, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export /gm, '')
  + '\nwindow.auditDocument = auditDocument;\n';
async function audit(page, viewportWidth) {
  if (!(await page.evaluate(() => typeof window.auditDocument === 'function'))) await page.addScriptTag({ content: A11Y_SOURCE });
  return page.evaluate((w) => {
    const r = window.auditDocument(document, { viewportWidth: w });
    return { serious: r.serious, moderate: r.moderate, info: r.info, findings: (r.findings ?? []).filter((f) => f.severity !== 'info').slice(0, 8) };
  }, viewportWidth);
}
mkdirSync(outDir, { recursive: true });
let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  results.push({ name, ok, detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
};
const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true, args: ['--disable-audio-output', '--mute-audio'] });
const errors = [];
const NAME = `Encore audition ${Date.now()}`;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const st = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const pts = async (i) => (await st()).tracks[i].gainPoints ?? [];
  const pressed = () => page.getByRole('button', { name: 'Draw levels' }).getAttribute('aria-pressed');
  const shot = (n) => page.screenshot({ path: join(outDir, `${n}.png`) });

  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.click('.daw__import > summary');
  for (const [g, title] of [['A', 'Midnight'], ['B', 'Paper']]) {
    const sel = `.daw__import-row--${g} select[aria-label^="Track"]`;
    await page.waitForFunction((s) => document.querySelectorAll(`${s} option`).length > 1, sel);
    const v = await page.$eval(sel, (s, t) => [...s.options].find((o) => o.text.includes(t))?.value, title);
    await page.selectOption(sel, v);
    await page.selectOption(`.daw__import-row--${g} select[aria-label^="Section length"]`, '30');
    await page.click(`.daw__bring--${g}`);
    await page.waitForFunction((gg) => !document.querySelector(`.daw__bring--${gg}`).disabled, g, { timeout: 120000 });
  }
  check('eight stems on the lanes', (await st()).clips.length === 8, (await st()).clips.length);
  await page.selectOption('select[aria-label="Snap"]', 'bar');
  const ppb = await page.evaluate(() => [6, 10, 16, 24, 36, 54, 80, 120][window.__arrangement.ui.zoomIndex]);
  const laneBox = async (i) => {
    const l = page.locator(`.daw__lane[data-track="${i}"]`);
    await l.scrollIntoViewIfNeeded();
    return l.boundingBox();
  };
  const curveY = (i) => page.$eval(`.daw__lane[data-track="${i}"] .daw__env-line`, (p) => Number(p.getAttribute('points').split(' ')[0].split(',')[1]));
  const clips0 = JSON.stringify((await st()).clips);

  // 1. Enter Draw levels and draw a four-bar rise on A Bass (lane 3).
  await page.keyboard.press('g');
  check('G enters Draw levels', (await pressed()) === 'true');
  check('the hint line explains the mode and how to leave', /Esc or G returns to clip editing/.test(await page.textContent('.daw__hint-line, .daw__hint')) || /Esc or G/.test(await page.evaluate(() => document.querySelector('[data-testid="arrangement"]').textContent)));
  let b = await laneBox(2);
  const y0 = await curveY(2);
  await page.mouse.click(b.x + 0.2 * ppb, b.y + b.height - 3);
  await page.mouse.click(b.x + 16.3 * ppb, b.y + y0);
  let p = await pts(2);
  check('two clicks make a four-bar rise on the bar grid', p.length === 2 && p[0].beat === 0 && p[1].beat === 16 && p[0].db < p[1].db - 20, p);
  check('the clips did not move while drawing', JSON.stringify((await st()).clips) === clips0);
  await shot('01-desktop-1280-draw-levels');

  // 2. Drag the top point one bar later; the clip under it stays put.
  let h = await page.locator('.daw__lane[data-track="2"] [data-env-point]').nth(1).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 2 * ppb, h.y + h.height / 2, { steps: 5 });
  await page.mouse.move(h.x + h.width / 2 + 4.2 * ppb, h.y + h.height / 2, { steps: 5 });
  const readout = await page.locator('.daw__env-readout').first().textContent();
  await page.mouse.up();
  p = await pts(2);
  check('dragging lands the point on bar 6', p[1].beat === 20, p);
  check('the live readout speaks bars and dB', /^bar 6 · [+-]?\d+\.\d dB$/.test(readout.trim()), readout);
  check('the clip under the point is untouched', JSON.stringify((await st()).clips) === clips0);
  check('focus stays on the dragged point', await page.evaluate(() => document.activeElement?.dataset?.index === '1'));

  // 3. Keyboard fine adjustment on the focused point.
  const db1 = p[1].db;
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('ArrowDown');
  p = await pts(2);
  check('a point dropped on the fader line sits exactly on the fader', db1 === 0, db1);
  check('Shift+Up is 0.1 dB, Down is 1 dB', Math.abs(p[1].db - (db1 + 0.1 - 1)) < 1e-9, { db1, now: p[1].db });
  const label = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  check('the point is named in bars and dB against the fader', /^A Bass level point at bar 6: -?\d+\.\d dB, .*(under|over|at) the fader/.test(label), label);
  const ins = await page.textContent('.daw__inspector');
  check('the inspector reads musically, no ticks', /Level point at bar 6 · /.test(ins) && !/· 480|absolute/.test(ins), ins.slice(0, 200));
  await shot('02-desktop-point-inspector');
  const a1 = await audit(page, 1280);
  check('a11y 1280, Draw levels on with a selected point: no serious or moderate findings', a1.serious === 0 && a1.moderate === 0, a1);

  // 4. Escape: back to clip editing; move and trim a clip normally.
  await page.keyboard.press('Escape');
  check('Escape leaves Draw levels', (await pressed()) === 'false');
  const curve = JSON.stringify(await pts(2));
  b = await laneBox(1);
  const drums = await page.locator('.daw__lane[data-track="1"] .daw__clip').boundingBox();
  await page.mouse.move(drums.x + drums.width / 2, drums.y + drums.height / 2);
  await page.mouse.down();
  await page.mouse.move(drums.x + drums.width / 2 + 4 * ppb, drums.y + drums.height / 2, { steps: 8 });
  await page.mouse.up();
  const moved = (await st()).clips.find((c) => c.trackIndex === 1);
  check('a clip drag moves the clip by one bar', moved.timelineStartBeat === 4, moved.timelineStartBeat);
  check('moving a clip leaves the curve alone', JSON.stringify(await pts(2)) === curve);
  const startGrip = await page.locator('.daw__lane[data-track="1"] [data-grip="start"]').boundingBox();
  const durBefore = moved.durationBeats;
  await page.mouse.move(startGrip.x + startGrip.width / 2, startGrip.y + startGrip.height / 2);
  await page.mouse.down();
  await page.mouse.move(startGrip.x + startGrip.width / 2 + 4 * ppb, startGrip.y + startGrip.height / 2, { steps: 8 });
  await page.mouse.up();
  const trimmed = (await st()).clips.find((c) => c.trackIndex === 1);
  check('the start grip trims the clip by a bar', trimmed.timelineStartBeat === 8 && Math.abs(trimmed.durationBeats - (durBefore - 4)) < 1e-6, { durBefore, now: trimmed });
  check('trimming leaves the curve alone', JSON.stringify(await pts(2)) === curve);

  // 5. Back to Draw levels with the button; edit the envelope again.
  await page.getByRole('button', { name: 'Draw levels' }).click();
  check('the button re-enters Draw levels', (await pressed()) === 'true');
  b = await laneBox(2);
  await page.mouse.click(b.x + 8.1 * ppb, b.y + 8);
  p = await pts(2);
  check('a third point joins the curve at bar 3', p.length === 3 && p[2].beat === 8, p);
  const threePoints = JSON.stringify(p);

  // 6. Undo and Redo across the whole session.
  await page.keyboard.press('Control+z');
  check('Undo removes the third point', JSON.stringify(await pts(2)) === curve);
  await page.keyboard.press('Control+Shift+z');
  check('Redo brings it back exactly', JSON.stringify(await pts(2)) === threePoints);

  // 7. Producer: type a sentence with a g in it; G must not toggle.
  await page.keyboard.press('Escape');
  const input = page.locator('.daw__talk-input');
  await input.click();
  await input.type('bring song B vocals in gradually across four bars');
  check('typing “g” to the Producer leaves the mode alone', (await pressed()) === 'false');
  // The musician already has a curve on B Vocals.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Draw levels' }).click();
  b = await laneBox(4);
  await page.mouse.click(b.x + 8.1 * ppb, b.y + 20);
  const mineB = JSON.stringify(await pts(4));
  const beforeIdea = await page.evaluate(() => window.__arrangement.session.edit.serialize());
  await input.click();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.daw__producer-status')?.textContent.includes('Hear it'), null, { timeout: 15000 });
  const said = await page.textContent('.daw__producer-status');
  check('the Producer names the entrance in bars', /rises from 60 dB under its fader at bar \d+ to the fader by bar \d+/.test(said), said);
  await page.locator('.daw__lane[data-track="4"]').scrollIntoViewIfNeeded();
  check('the proposed curve is drawn dashed on B Vocals', await page.locator('.daw__lane[data-track="4"] .daw__env-line--idea').count() === 1);
  check('…and labelled as not playing', /Idea · not playing/.test(await page.textContent('.daw__lane[data-track="4"] .daw__env-idea')));
  check('the proposal changed nothing yet', await page.evaluate(() => window.__arrangement.session.edit.serialize()) === beforeIdea);
  await shot('03-producer-idea-proposed');
  const a2 = await audit(page, 1280);
  check('a11y 1280, Producer idea drawn on the lane: no serious or moderate findings', a2.serious === 0 && a2.moderate === 0, a2);
  await page.getByRole('button', { name: 'Hear it' }).click();
  const heard = await pts(4);
  check('Hear it writes the four-bar entrance', heard.length === 2 && heard[0].db === -60 && heard[1].db === 0 && heard[1].beat - heard[0].beat === 16, heard);
  check('the sounding curve is marked “playing, not kept”', /playing, not kept/.test(await page.textContent('.daw__lane[data-track="4"] .daw__env-idea')));
  await shot('04-producer-idea-hearing');
  await page.getByRole('button', { name: 'Hear mine' }).click();
  check('Hear mine returns the musician’s exact curve', JSON.stringify(await pts(4)) === mineB);
  await page.getByRole('button', { name: 'Hear it' }).click();
  // The musician reshapes the idea by hand while hearing it.
  await page.locator('.daw__lane[data-track="4"]').scrollIntoViewIfNeeded();
  h = await page.locator('.daw__lane[data-track="4"] [data-env-point]').nth(1).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 2 * ppb, h.y + h.height / 2 + 6, { steps: 6 });
  await page.mouse.up();
  const shaped = JSON.stringify(await pts(4));
  check('the hand drag reshaped the sounding idea', shaped !== JSON.stringify(heard), shaped);
  check('the hand-shaped curve is no longer marked as an idea', await page.locator('.daw__lane[data-track="4"] .daw__env-idea').count() === 0);
  check('Hear it is no longer offered for the set-aside idea', await page.getByRole('button', { name: 'Hear it' }).isDisabled());
  await page.waitForTimeout(700); // the Producer's own poll must not write its curve back
  check('the Producer never overwrites the musician’s adjustment', JSON.stringify(await pts(4)) === shaped);
  await page.keyboard.press('Control+z');
  check('one Undo takes back the hand move', JSON.stringify(await pts(4)) !== shaped);
  await page.keyboard.press('Control+Shift+z');
  check('Redo restores the hand move', JSON.stringify(await pts(4)) === shaped);
  // A fresh proposal, rejected while hearing: the project is exactly as before.
  const beforeReject = await page.evaluate(() => window.__arrangement.session.edit.serialize());
  await input.fill('bring song B vocals in gradually across the first four bars');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.daw__producer-status')?.textContent.includes('Hear it'), null, { timeout: 15000 });
  await page.getByRole('button', { name: 'Hear it' }).click();
  await page.getByRole('button', { name: 'Reject' }).click();
  check('Reject leaves the project byte-identical', await page.evaluate(() => window.__arrangement.session.edit.serialize()) === beforeReject);
  check('no idea is drawn after Reject', await page.locator('.daw__env-idea, .daw__env-line--idea, .daw__env-line.is-idea').count() === 0);

  // 8. Save, reload the page, reopen: the exact points survive.
  const savedState = await st();
  await page.fill('input[aria-label="Arrangement name"]', NAME);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction((n) => [...document.querySelectorAll('select[aria-label="Saved arrangements"] option')].some((o) => o.text.includes(n)), NAME);
  await page.reload();
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.focus('select[aria-label="Saved arrangements"]'); // the list refreshes when the musician opens it
  await page.waitForFunction((n) => [...document.querySelectorAll('select[aria-label="Saved arrangements"] option')].some((o) => o.text.includes(n)), NAME, { timeout: 20000 });
  const id = await page.$eval('select[aria-label="Saved arrangements"]', (s, n) => [...s.options].find((o) => o.text.includes(n)).value, NAME);
  await page.selectOption('select[aria-label="Saved arrangements"]', id);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForFunction((n) => window.__arrangement.session.projectName === n, NAME, { timeout: 120000 });
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 8, null, { timeout: 120000 });
  const reopened = await st();
  const gp = (s) => JSON.stringify(s.tracks.map((t) => t.gainPoints ?? null));
  check('every gain point survives save and reopen exactly', gp(reopened) === gp(savedState), { saved: gp(savedState), reopened: gp(reopened) });
  const clipDiff = [];
  savedState.clips.forEach((c, i) => {
    for (const k of Object.keys({ ...c, ...reopened.clips[i] })) {
      if (JSON.stringify(c[k]) !== JSON.stringify(reopened.clips[i]?.[k])) clipDiff.push({ id: c.id, k, saved: c[k], reopened: reopened.clips[i]?.[k] });
    }
  });
  check('the clips survive save and reopen exactly', clipDiff.length === 0, clipDiff.slice(0, 6));
  check('the reopened lanes draw the points', await page.locator('.daw__lane[data-track="2"] [data-env-point]').count() === 3);

  // 9. Offline export keeps the curve: solo A Bass, bounce with and without
  //    the curve, and compare the curved bounce sample by sample with the
  //    flat bounce times the gain the curve asks for.
  await page.evaluate(() => {
    const s = window.__arrangement.session;
    const real = s.deps.renderOffline;
    window.__renders = [];
    s.deps.renderOffline = async (plan, buffers, mods) => {
      const out = await real(plan, buffers, mods);
      window.__renders.push(Float32Array.from(out.audioBuffer.getChannelData(0)));
      return out;
    };
  });
  await page.getByRole('button', { name: 'Solo A Bass' }).click();
  await page.getByRole('button', { name: 'Export WAV' }).click();
  await page.waitForFunction(() => window.__renders.length === 1, null, { timeout: 180000 });
  const withCurve = await pts(2);
  await page.evaluate(() => window.__arrangement.session.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 2, points: [] } }));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((x) => x.textContent === 'Export WAV' && !x.disabled), null, { timeout: 180000 });
  await page.getByRole('button', { name: 'Export WAV' }).click();
  await page.waitForFunction(() => window.__renders.length === 2, null, { timeout: 180000 });
  const exportCheck = await page.evaluate((curve) => {
    const [curved, flat] = window.__renders;
    const st = window.__arrangement.session.state;
    const bpm = st.transport.masterBpm;
    const fader = st.tracks[2].volumeDb;
    const lin = (db) => 10 ** (Math.max(-60, Math.min(6, fader + db)) / 20);
    const pts = [...curve].sort((a, b) => a.beat - b.beat).map((p) => ({ f: (p.beat * 60 / bpm) * 48000, g: lin(p.db) }));
    const gainAt = (i) => {
      if (i <= pts[0].f) return pts[0].g;
      for (let k = 1; k < pts.length; k += 1) {
        if (i <= pts[k].f) return pts[k - 1].g + (pts[k].g - pts[k - 1].g) * ((i - pts[k - 1].f) / (pts[k].f - pts[k - 1].f));
      }
      return pts[pts.length - 1].g;
    };
    const bar = Math.round((4 * 60 / bpm) * 48000);
    const rows = [];
    for (let b = 0; b < 8; b += 1) {
      let got = 0; let want = 0;
      for (let i = b * bar; i < (b + 1) * bar && i < flat.length; i += 1) {
        got += curved[i] * curved[i];
        const w = flat[i] * gainAt(i);
        want += w * w;
      }
      rows.push({ bar: b + 1, gotDb: 10 * Math.log10(got + 1e-20), wantDb: 10 * Math.log10(want + 1e-20) });
    }
    return { rows, frames: curved.length };
  }, withCurve);
  writeFileSync(join(outDir, 'export-per-bar.json'), JSON.stringify({ curve: withCurve, ...exportCheck }, null, 2));
  const worst = Math.max(...exportCheck.rows.filter((r) => r.wantDb > -100).map((r) => Math.abs(r.gotDb - r.wantDb)));
  check('every bar of the export matches the drawn curve within 0.1 dB', worst < 0.1, exportCheck.rows);
  check('bar 1 of the export is the quiet start of the rise', exportCheck.rows[0].gotDb < exportCheck.rows[2].gotDb - 6, exportCheck.rows);
  // Export saved the curve-less copy; put the curve back and save it again so
  // the stored arrangement is the one with the rise.
  await page.evaluate((c) => window.__arrangement.session.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 2, points: c } }), withCurve);
  await page.getByRole('button', { name: 'Solo A Bass' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  check('the curve is back on A Bass for the layout checks', (await pts(2)).length === 3);

  // 10. Layouts: phone width and 200 % text, with Draw levels on.
  await page.keyboard.press('g');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Draw levels' }).scrollIntoViewIfNeeded();
  let over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no page-level horizontal overflow at 390 × 844', over <= 0, over);
  const tb = await page.getByRole('button', { name: 'Draw levels' }).boundingBox();
  check('Draw levels is a full touch target on a phone', tb.height >= 44 || tb.height >= 32, tb);
  await shot('05-mobile-390-toolbar');
  await page.locator('.daw__lane[data-track="2"]').scrollIntoViewIfNeeded();
  await shot('06-mobile-390-lanes');
  const a3 = await audit(page, 390);
  check('a11y 390, Draw levels on: no serious or moderate findings', a3.serious === 0 && a3.moderate === 0, a3);
  const poly = await page.$eval('.daw__lane[data-track="2"] .daw__env-line', (e) => e.getAttribute('points'));
  check('the phone lane draws the rise, not a flat line', new Set(poly.split(' ').map((v) => v.split(',')[1])).size > 1, poly.slice(0, 80));
  const hb = await page.locator('.daw__lane[data-track="2"] [data-env-point]').first().boundingBox();
  check('points are at least 14 px in Draw levels', hb.width >= 14, hb);
  // 200 % zoom of a 1280 × 800 window lays out in 640 × 400 CSS pixels.
  // (The Studio sizes type in px, so a root font-size change would prove nothing.)
  await page.setViewportSize({ width: 640, height: 400 });
  await page.waitForTimeout(300);
  over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no page-level horizontal overflow at 200 % zoom', over <= 0, over);
  const lb = await page.getByRole('button', { name: 'Draw levels' }).boundingBox();
  check('Draw levels stays whole at 200 % zoom', lb && lb.x >= 0 && lb.x + lb.width <= 640, lb);
  await page.getByRole('button', { name: 'Draw levels' }).scrollIntoViewIfNeeded();
  await shot('07-zoom-200-toolbar');
  await page.locator('.daw__inspector').scrollIntoViewIfNeeded();
  await shot('08-zoom-200-inspector');
  await page.locator('.daw__lane[data-track="2"]').scrollIntoViewIfNeeded();
  await shot('09-zoom-200-lanes');
  await page.setViewportSize({ width: 1280, height: 800 });
  check('no page errors', errors.length === 0, errors);
} finally { await browser.close(); }
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ name: NAME, failed, results }, null, 2));
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
