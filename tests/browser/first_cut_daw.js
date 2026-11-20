#!/usr/bin/env node
// OPERATION FIRST CUT — direct musical control, driven through the real Studio
// controls in real Chromium against a seeded loopback Studio.
//
//   node tests/browser/first_cut_daw.js <studio-url> <out-dir>
//
// Chromium runs with --disable-audio-output and --mute-audio: the Web Audio
// clock and graph run for real, nothing reaches this machine's speakers.
// Every musical action is a pointer, key or form action on the page; page
// state is only READ (window.__arrangement) to verify what the controls did.
//
// The journey: put a B Vocals clip at bar 9, slip it to a later moment of the
// stem without moving it, set -3 dB and a one-beat fade-in, play from a chosen
// cue, undo and redo, save and reopen, export, and let the AI Producer make
// the same kind of edit through the same edit API.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base = 'http://127.0.0.1:8792', outDir = 'first-cut-out'] = process.argv.slice(2);
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
const checks = [];
const measurements = {};
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SR = 48000;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function readWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(...buf.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let o = 12; let fmt = null; let data = null;
  while (o + 8 <= buf.length) {
    const id = tag(o); const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data') data = { offset: o + 8, size };
    o += 8 + size + (size % 2);
  }
  const frames = data.size / (fmt.channels * (fmt.bits / 8));
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
/** Least-squares gain of `x` against `y` over a window, and the correlation, at a lag. */
function fit(x, y, xStart, yStart, n, lag) {
  let xy = 0; let yy = 0; let xx = 0;
  for (let i = 0; i < n; i += 1) {
    const a = x[xStart + lag + i] ?? 0; const b = y[yStart + i] ?? 0;
    xy += a * b; yy += b * b; xx += a * a;
  }
  return { gain: yy ? xy / yy : 0, corr: xx && yy ? xy / Math.sqrt(xx * yy) : 0 };
}
function bestLag(x, y, xStart, yStart, n, span) {
  let best = { lag: 0, corr: -1, gain: 0 };
  for (let lag = -span; lag <= span; lag += 1) {
    const f = fit(x, y, xStart, yStart, n, lag);
    if (f.corr > best.corr) best = { lag, ...f };
  }
  return best;
}

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  let page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  const S = (fn, arg) => page.evaluate(fn, arg);
  const state = () => S(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const depth = () => S(() => window.__arrangement.session.edit.historyDepth.past);
  const vocal = async () => (await state()).clips.find((c) => c.trackIndex === 4);
  const clipEl = async () => {
    const id = (await vocal()).id;
    const el = page.locator(`.daw__clip[data-clip-id="${id}"]`);
    await el.scrollIntoViewIfNeeded();
    return el;
  };
  const ppb = () => S(() => Number.parseFloat(getComputedStyle(document.querySelector('.daw__content')).getPropertyValue('--beat-px')));
  const drag = async (from, to, { shift = false, steps = 8 } = {}) => {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i += 1) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

  // ---- Bring B in (60 s from 30 s) and set Snap to Bar ------------------------
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--B select[aria-label^="Track"] option').length > 1);
  const value = await page.$eval('.daw__import-row--B select[aria-label^="Track"]', (sel) => [...sel.options].find((o) => o.text.includes('Paper Lanterns'))?.value);
  await page.selectOption('.daw__import-row--B select[aria-label^="Track"]', value);
  await page.selectOption('.daw__import-row--B select[aria-label^="Section length"]', '60');
  await page.fill('.daw__import-row--B input[type=number]', '30');
  await page.click('.daw__bring--B');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length === 4, null, { timeout: 120000 });
  await page.selectOption('select[aria-label="Snap"]', 'bar');
  // The project tempo for B alone is its own measured tempo; make it A's 96.8 so bar maths matches the demo.
  await page.fill('input[aria-label="Project tempo (BPM)"]', '96.8');
  await page.dispatchEvent('input[aria-label="Project tempo (BPM)"]', 'change');
  // Fit the view: zoom out to the floor, then in one step (10 px per beat).
  await page.locator('.daw__timeline').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('-');
  await page.keyboard.press('+');
  check('setup: B Vocals clip is on lane 5 at natural speed, view at 10 px/beat', (await ppb()) === 10 && (await vocal()).stretchMode === 'manual', { ppb: await ppb() });
  let st = await state();
  const bpm = st.transport.masterBpm;
  const spb = 60 / bpm;
  check('setup: project tempo is 96.8 BPM', bpm === 96.8, { bpm });

  // ---- A. Three different positions ------------------------------------------
  // A.1 Trim the end by dragging the end handle: leaves room to slip.
  let box = await (await clipEl()).boundingBox();
  const c0 = await vocal();
  await drag({ x: box.x + box.width - 4, y: box.y + box.height / 2 }, { x: box.x + 24 * (await ppb()), y: box.y + box.height / 2 });
  let c1 = await vocal();
  check('trim: dragging the end handle shortens the clip to a bar and keeps its start and in-point',
    c1.durationBeats === 24 && c1.timelineStartBeat === c0.timelineStartBeat && c1.sourceOffsetSec === 0, c1);

  // B. Move: drag the body to bar 9 (beat 32).
  box = await (await clipEl()).boundingBox();
  const startX = box.x + 60;
  await drag({ x: startX, y: box.y + box.height / 2 }, { x: startX + 32 * (await ppb()), y: box.y + box.height / 2 });
  let c2 = await vocal();
  check('1. moving the vocal clip by pointer puts it at bar 9 (beat 32), source untouched',
    c2.timelineStartBeat === 32 && c2.sourceOffsetSec === 0 && c2.durationBeats === 24, c2);
  await page.screenshot({ path: join(outDir, 'fc-1-moved.png') });

  // Candidate slip distance in bars, chosen from the decoded source so the chosen moment is audible.
  const pickSlip = await S(({ spbSec }) => {
    const s = window.__arrangement.session;
    const c = s.state.clips.find((x) => x.trackIndex === 4);
    const a = s.state.assets[c.assetId];
    const ch = s.buffers[a.bufferReference].channels[0];
    const rms = (from, secs) => {
      let e = 0; const a0 = Math.round(from * 48000); const n = Math.round(secs * 48000);
      for (let i = a0; i < a0 + n && i < ch.length; i += 1) e += ch[i] * ch[i];
      return 10 * Math.log10(e / n + 1e-20);
    };
    const base0 = rms(0.8, 2);
    let best = null;
    for (let k = 1; k <= 8; k += 1) {
      const off = k * 4 * spbSec;
      const here = rms(off + 0.8, 2);
      const score = Math.abs(here - base0);
      if (here > -35 && (!best || score > best.score)) best = { bars: k, off, here, base0, score };
    }
    return best;
  }, { spbSec: spb });
  measurements.slipChoice = pickSlip;
  check('setup: the decoded stem has a loud moment to slip to that differs from where it starts', pickSlip && pickSlip.score >= 6, pickSlip);
  const bars = pickSlip.bars;

  // C. Slip by dragging the bottom bar left (audio moves with the pointer: later material).
  box = await (await clipEl()).boundingBox();
  const slipBox = await page.locator(`.daw__clip[data-clip-id="${c2.id}"] .daw__slip-grip`).boundingBox();
  const d0 = await depth();
  const waveBefore = await S((id) => {
    const c = document.querySelector(`.daw__clip[data-clip-id="${id}"] canvas`);
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0; for (let i = 3; i < g.length; i += 97) h = (h * 31 + g[i]) | 0;
    return h;
  }, c2.id);
  await drag({ x: slipBox.x + slipBox.width / 2, y: slipBox.y + slipBox.height / 2 }, { x: slipBox.x + slipBox.width / 2 - bars * 4 * (await ppb()), y: slipBox.y + slipBox.height / 2 });
  let c3 = await vocal();
  const expectOff = Math.round(bars * 4 * spb * 1e9) / 1e9;
  check('2. dragging the slip bar selects a later moment of the stem and nothing else moves',
    near(c3.sourceOffsetSec, expectOff, 1e-6) && c3.timelineStartBeat === 32 && c3.durationBeats === 24
    && c3.trackIndex === 4 && c3.stretchMode === c2.stretchMode && c3.fadeInBeats === c2.fadeInBeats && c3.clipGainDb === c2.clipGainDb,
    { c3, expectOff });
  check('2. the slip is one undo step', (await depth()) === d0 + 1, { d0, now: await depth() });
  const waveAfter = await S((id) => {
    const c = document.querySelector(`.daw__clip[data-clip-id="${id}"] canvas`);
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0; for (let i = 3; i < g.length; i += 97) h = (h * 31 + g[i]) | 0;
    return h;
  }, c2.id);
  check('2. the waveform changed to show the new source moment', waveBefore !== waveAfter, { waveBefore, waveAfter });
  // The waveform equals the audio that will play: columns follow the decoded peaks at the new in-point.
  const waveFit = await S(async (id) => {
    const { peaksFor } = await import('/assets/js/arrangement/daw-session.js');
    const s = window.__arrangement.session;
    const c = s.state.clips.find((x) => x.id === id);
    const a = s.state.assets[c.assetId];
    const peaks = peaksFor(a.bufferReference);
    const canvas = document.querySelector(`.daw__clip[data-clip-id="${id}"] canvas`);
    const w = canvas.width; const h = canvas.height;
    const g = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const spbSec = 60 / s.bpm;
    const srcStart = c.sourceOffsetSec * 48000;
    const srcSpan = c.durationBeats * spbSec * 1 * 48000;
    const measured = []; const expected = [];
    for (let px = 0; px < w; px += 1) {
      let lit = 0;
      for (let y = 0; y < h; y += 1) if (g[(y * w + px) * 4 + 3] > 0) lit += 1;
      const a0 = Math.floor((srcStart + (px / w) * srcSpan) / peaks.bucketFrames);
      const b0 = Math.max(a0 + 1, Math.floor((srcStart + ((px + 1) / w) * srcSpan) / peaks.bucketFrames));
      let lo = 0; let hi = 0;
      for (let i = a0; i < b0 && i < peaks.min.length; i += 1) { lo = Math.min(lo, peaks.min[i]); hi = Math.max(hi, peaks.max[i]); }
      const beat = ((px + 0.5) / w) * c.durationBeats;
      let env = 1;
      if (c.fadeInBeats > 0) env = Math.min(env, beat / c.fadeInBeats);
      if (c.fadeOutBeats > 0) env = Math.min(env, (c.durationBeats - beat) / c.fadeOutBeats);
      const lin = 10 ** (c.clipGainDb / 20) * Math.max(0, Math.min(1, env));
      expected.push((Math.min(1, hi * lin) - Math.max(-1, lo * lin)) * h / 2);
      measured.push(lit);
    }
    const mean = (v) => v.reduce((p, q) => p + q, 0) / v.length;
    const mm = mean(measured); const me = mean(expected);
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let i = 0; i < measured.length; i += 1) { const x = measured[i] - mm; const y = expected[i] - me; sxy += x * y; sxx += x * x; syy += y * y; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }, c2.id);
  measurements.waveformCorrelation = waveFit;
  check('2. the drawn waveform matches the decoded audio at the new in-point (correlation > 0.9)', waveFit > 0.9, { waveFit });
  await page.screenshot({ path: join(outDir, 'fc-2-slipped.png') });

  // C.2 Shift-drag the body: another slip, no move. Undo it afterwards to keep the planned state.
  box = await (await clipEl()).boundingBox();
  const dShift = await depth();
  await drag({ x: box.x + 90, y: box.y + box.height / 2 }, { x: box.x + 90 + 4 * (await ppb()), y: box.y + box.height / 2 }, { shift: true });
  let c3b = await vocal();
  check('2. Shift-drag on the clip body also slips (one bar earlier) and keeps the position',
    near(c3b.sourceOffsetSec, expectOff - 4 * spb, 1e-6) && c3b.timelineStartBeat === 32, { c3b });
  await page.click('.daw__history button:nth-child(1)');
  check('2. Undo restores the previous in-point', near((await vocal()).sourceOffsetSec, expectOff, 1e-9) && (await depth()) === dShift);

  // D. Distinguish trim from slip: dragging the START edge moves the boundary and advances the in-point.
  box = await (await clipEl()).boundingBox();
  const beforeTrim = await vocal();
  await drag({ x: box.x + 3, y: box.y + box.height / 2 }, { x: box.x + 3 + 4 * (await ppb()), y: box.y + box.height / 2 });
  let afterTrim = await vocal();
  check('trim vs slip: the start edge moves the boundary (+4 beats) and advances the in-point by the same musical time',
    afterTrim.timelineStartBeat === beforeTrim.timelineStartBeat + 4 && afterTrim.durationBeats === beforeTrim.durationBeats - 4
    && near(afterTrim.sourceOffsetSec, beforeTrim.sourceOffsetSec + 4 * spb, 1e-6), { beforeTrim, afterTrim });
  await page.click('.daw__history button:nth-child(1)');

  // E. Gain: drag the gain grip down 15 px = -3 dB.
  const dGain = await depth();
  const gainBox = await page.locator(`.daw__clip[data-clip-id="${c2.id}"] .daw__gain-grip`).boundingBox();
  await drag({ x: gainBox.x + gainBox.width / 2, y: gainBox.y + gainBox.height / 2 }, { x: gainBox.x + gainBox.width / 2, y: gainBox.y + gainBox.height / 2 + 15 }, { steps: 5 });
  let c4 = await vocal();
  check('3. dragging the clip gain grip down 15 px sets -3 dB, track level untouched, one undo step',
    c4.clipGainDb === -3 && (await state()).tracks[4].volumeDb === 0 && (await depth()) === dGain + 1, { gain: c4.clipGainDb });
  // A tiny wobble is not an edit.
  const gb2 = await page.locator(`.daw__clip[data-clip-id="${c2.id}"] .daw__gain-grip`).boundingBox();
  await drag({ x: gb2.x + gb2.width / 2, y: gb2.y + 3 }, { x: gb2.x + gb2.width / 2, y: gb2.y + 4 }, { steps: 2 });
  check('3. a one-pixel wobble on the gain grip is not an edit', (await depth()) === dGain + 1 && (await vocal()).clipGainDb === -3);

  // F. Fade in: drag the fade-in grip to one beat, then enter the exact value.
  const dFade = await depth();
  const clipBox = await (await clipEl()).boundingBox();
  const gripBox = await page.locator(`.daw__clip[data-clip-id="${c2.id}"] .daw__fade-grip--in`).boundingBox();
  await drag({ x: gripBox.x + 6, y: gripBox.y + 6 }, { x: clipBox.x + 1 * (await ppb()), y: gripBox.y + 6 });
  let c5 = await vocal();
  check('4. dragging the fade-in grip to one beat sets a ~1 beat fade-in as one undo step',
    near(c5.fadeInBeats, 1, 0.1) && (await depth()) === dFade + 1 && c5.clipGainDb === -3, { fadeInBeats: c5.fadeInBeats });
  await page.fill('.daw__inspector input[aria-label="Fade in"]', '1');
  await page.dispatchEvent('.daw__inspector input[aria-label="Fade in"]', 'change');
  c5 = await vocal();
  check('4. the inspector sets the exact one-beat fade-in and shows it in beats and seconds',
    c5.fadeInBeats === 1 && /1 beat · 0\.62 s/.test(await page.locator('.daw__inspector').innerText()), { f: c5.fadeInBeats });
  const insText = await page.locator('.daw__inspector').innerText();
  check('inspector shows source in-point seconds, frame and musical stem position',
    /Plays from\s*\d+\.\d{3} s · frame \d+/.test(insText) && /bar \d+ · beat \d+ at 84\.3 BPM/.test(insText) && /Room to slip/.test(insText), insText.slice(0, 400));
  await page.screenshot({ path: join(outDir, 'fc-3-edited.png') });
  await page.locator('.daw__timeline-wrap').scrollIntoViewIfNeeded();
  await page.locator('.daw__timeline-wrap').screenshot({ path: join(outDir, 'fc-3-timeline.png') });
  await page.locator('.daw__inspector').screenshot({ path: join(outDir, 'fc-3-inspector.png') });
  const edited = await vocal();
  const hint = await page.locator('[data-field="hint"]').innerText();
  check('a contextual hint line is present', hint.length > 20, { hint });

  // ---- Play from a chosen cue; hear the edited clip in the right place ---------
  // Cue at bar 7 (beat 24): 8 beats of nothing, then the clip at bar 9.
  const rb = await page.locator('.daw__ruler').boundingBox();
  const scrollLeft = await S(() => document.querySelector('.daw__scroller').scrollLeft);
  await page.mouse.click(rb.x + 24 * (await ppb()) - scrollLeft + 1, rb.y + 15);
  const cue = await S(() => window.__arrangement.session.playheadBeat());
  check('A. clicking the ruler moves the play cue to bar 7 and moves no clip',
    near(cue, 24, 0.01) && JSON.stringify(await vocal()) === JSON.stringify(edited), { cue });
  await S(() => {
    const s = window.__arrangement.session;
    window.__logApply = [];
    const orig = s.apply.bind(s);
    s.apply = (command, key) => { window.__logApply.push(JSON.parse(JSON.stringify(command))); return orig(command, key); };
  });
  await page.click('button[aria-label="Solo B Vocals"]');
  await page.click('button[aria-label="Play"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 15000 });
  await S(() => {
    const s = window.__arrangement.session;
    const an = s.ctx.createAnalyser(); an.fftSize = 2048; s.monitor.connect(an);
    window.__trace = async (untilBeat, windowFrom, windowTo, timeoutMs = 20000) => {
      const buf = new Float32Array(2048);
      const out = []; let e = 0; let n = 0; const end = performance.now() + timeoutMs;
      while (performance.now() < end && s.playheadBeat() < untilBeat) {
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        const beat = s.playheadBeat();
        out.push([beat, 10 * Math.log10(sum / buf.length + 1e-20)]);
        if (beat >= windowFrom && beat <= windowTo) { e += sum / buf.length; n += 1; }
        await new Promise((r) => setTimeout(r, 25));
      }
      return { trace: out, windowDb: n ? 10 * Math.log10(e / n + 1e-20) : -200, samples: n };
    };
  });
  const playA = await S(() => window.__trace(38, 32 + 1.3, 32 + 4.5));
  const before = playA.trace.filter(([b]) => b > 25 && b < 31.5).map(([, d]) => d);
  const onset = playA.trace.find(([b, d]) => b >= 31 && d > -60);
  measurements.playFromCue = { onsetBeat: onset?.[0], silenceMaxDb: Math.max(...before), windowDb: playA.windowDb, samples: playA.samples };
  measurements.playTraceSketch = playA.trace.filter((_, i) => i % 12 === 0).map(([b, d]) => [Math.round(b * 100) / 100, Math.round(d)]);
  measurements.playDiag = await S(() => { const s = window.__arrangement.session; const d = s.engine.diagnostics(); return { phase: s.phase(), events: d.events.slice(-8), misses: d.deadlineMisses, msgs: s.messages.slice(-4) }; });
  check('5. playing from the bar-7 cue is silent until bar 9, then the edited clip sounds',
    before.length > 20 && Math.max(...before) < -90 && onset && onset[0] >= 31.8 && onset[0] <= 33.2,
    measurements.playFromCue);
  await page.click('button[aria-label="Stop"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'stopped', null, { timeout: 5000 });

  // Gain heard: same window at 0 dB.
  const gainNow = (await vocal()).clipGainDb;
  await page.fill('.daw__inspector input[aria-label="Gain"]', '0');
  await page.dispatchEvent('.daw__inspector input[aria-label="Gain"]', 'change');
  const playB = await (async () => {
    await page.mouse.click(rb.x + 24 * (await ppb()) - scrollLeft + 1, rb.y + 15);
    await page.click('button[aria-label="Play"]');
    await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 15000 });
    const r = await S(() => window.__trace(38, 32 + 1.3, 32 + 4.5));
    await page.click('button[aria-label="Stop"]');
    await page.waitForFunction(() => window.__arrangement.session.phase() === 'stopped', null, { timeout: 5000 });
    return r;
  })();
  const gainDiff = playB.windowDb - playA.windowDb;
  measurements.gainHeard = { at0dB: playB.windowDb, atMinus3: playA.windowDb, diff: gainDiff, gainNow };
  check('3. the clip gain is heard: -3 dB plays 3 dB quieter than 0 dB (within 1 dB)', near(gainDiff, 3, 1), measurements.gainHeard);
  await page.click('.daw__history button:nth-child(1)'); // undo the 0 dB edit
  check('3. Undo brings the -3 dB gain back', (await vocal()).clipGainDb === -3);

  // Slip heard: put the in-point back to the start of the stem and compare the same window.
  await page.fill('.daw__inspector input[aria-label="Source in-point (seconds)"]', '0');
  await page.keyboard.press('Enter');
  check('2. entering the exact in-point 0 puts the clip back at the stem start without moving it',
    (await vocal()).sourceOffsetSec === 0 && (await vocal()).timelineStartBeat === 32);
  await page.mouse.click(rb.x + 24 * (await ppb()) - scrollLeft + 1, rb.y + 15);
  await page.click('button[aria-label="Play"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 15000 });
  const playC = await S(() => window.__trace(38, 32 + 1.3, 32 + 4.5));
  await page.click('button[aria-label="Stop"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'stopped', null, { timeout: 5000 });
  const slipDiff = playA.windowDb - playC.windowDb;
  const expectedSlipDiff = pickSlip.here - pickSlip.base0;
  measurements.slipHeard = { slipped: playA.windowDb, atStart: playC.windowDb, heardDiff: slipDiff, sourceDiff: expectedSlipDiff };
  check('2. the slip is heard: the level change between in-points matches the decoded source (within 3 dB)',
    near(slipDiff, expectedSlipDiff, 3), measurements.slipHeard);
  await page.click('.daw__history button:nth-child(1)'); // undo the in-point 0 edit
  check('2. Undo returns to the slipped in-point', near((await vocal()).sourceOffsetSec, expectOff, 1e-9));
  await page.click('button[aria-label="Solo B Vocals"]'); // unsolo

  // ---- Undo / redo the whole sequence ------------------------------------------
  // (Solo on/off are project edits too, so a few undo steps are the solo toggles.)
  const chain = [];
  for (let n = 0; n < 14 && (await vocal()).timelineStartBeat !== 0; n += 1) {
    await page.click('.daw__history button:nth-child(1)');
    chain.push(await vocal());
  }
  const sawFadeOff = chain.some((c) => c.fadeInBeats !== 1 && c.clipGainDb === -3 && c.sourceOffsetSec === edited.sourceOffsetSec);
  const sawGainOff = chain.some((c) => c.clipGainDb === 0 && c.sourceOffsetSec === edited.sourceOffsetSec && c.timelineStartBeat === 32);
  const sawSlipOff = chain.some((c) => c.sourceOffsetSec === 0 && c.timelineStartBeat === 32 && c.clipGainDb === 0);
  const last = chain[chain.length - 1];
  check('7. Undo walks back through fade, gain, slip and move, one musical action at a time',
    sawFadeOff && sawGainOff && sawSlipOff && last.timelineStartBeat === 0 && last.durationBeats === 24 && last.sourceOffsetSec === 0,
    chain.map((c) => [c.timelineStartBeat, c.sourceOffsetSec, c.clipGainDb, c.fadeInBeats]));
  for (let i = 0; i < chain.length; i += 1) await page.click('.daw__history button:nth-child(2)');
  const redone = await vocal();
  check('7. Redo restores the finished clip exactly', JSON.stringify(redone) === JSON.stringify(edited), { redone, edited });

  // ---- Save, reopen ------------------------------------------------------------
  await page.fill('input[aria-label="Arrangement name"]', 'First Cut demo');
  await page.click('button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('[data-field="save-state"]').textContent === 'all edits saved');
  const savedDoc = await S(() => { const s = JSON.parse(window.__arrangement.session.edit.serialize()); s.transport.isPlaying = false; return s; });
  const savedId = await S(() => window.__arrangement.session.projectId);
  await page.close();
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  await page.focus('select[aria-label="Saved arrangements"]');
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Saved arrangements"] option').length > 1);
  await page.selectOption('select[aria-label="Saved arrangements"]', savedId);
  await page.click('button:has-text("Open")');
  await page.waitForFunction(() => window.__arrangement.session.state.clips.length > 0, null, { timeout: 120000 });
  const reopened = await page.evaluate(() => JSON.parse(window.__arrangement.session.edit.serialize()));
  const diffs = [];
  const walk = (a, b, path) => {
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) { if (a !== b) diffs.push({ path, a, b }); return; }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
  };
  walk(savedDoc, reopened, '');
  check('8. reopening reproduces the saved arrangement exactly (in-point, gain, fade, position)', diffs.length === 0, diffs.slice(0, 5));
  const rc = reopened.clips.find((c) => c.trackIndex === 4);
  check('8. the reopened clip holds the chosen moment', near(rc.sourceOffsetSec, expectOff, 1e-9) && rc.timelineStartBeat === 32 && rc.clipGainDb === -3 && rc.fadeInBeats === 1, rc);

  // ---- Export: same source selection, gain and fade -----------------------------
  const exportWav = async (name) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 300000 }),
      page.click('button:has-text("Export WAV")'),
    ]);
    const p = join(outDir, `${name}.wav`);
    await download.saveAs(p);
    return readWav(readFileSync(p));
  };
  // Isolate the edited vocal so the analysis below hears only it (solo is project state; the export honours it).
  await page.click('button[aria-label="Solo B Vocals"]');
  const wav = await exportWav('first-cut-export');
  const srcOf = await S(async () => {
    const s = window.__arrangement.session;
    const c = s.state.clips.find((x) => x.trackIndex === 4);
    const a = s.state.assets[c.assetId];
    const ch = s.buffers[a.bufferReference].channels;
    return { L: Array.from(ch[0]), len: ch[0].length, off: c.sourceOffsetSec, start: c.timelineStartBeat, bpm: s.bpm };
  });
  const srcL = Float32Array.from(srcOf.L);
  const clipStartFrame = Math.round(32 * spb * SR);
  const offFrame = Math.round(srcOf.off * SR);
  // Analyse the loudest second of the slipped source after the fade-in, so a rest between phrases cannot pass for a match.
  let loudRel = 1; let loudE = -1;
  for (let rel = 1; rel < 13; rel += 0.25) {
    let e = 0; const a0 = offFrame + Math.round(rel * SR);
    for (let i = a0; i < a0 + SR; i += 1) e += srcL[i] * srcL[i];
    if (e > loudE) { loudE = e; loudRel = rel; }
  }
  measurements.analysisWindow = { loudRelSec: loudRel, rmsDb: 10 * Math.log10(loudE / SR + 1e-20) };
  const win = SR;
  const winStart = clipStartFrame + Math.round(loudRel * SR);
  const slippedFit = bestLag(wav.L, srcL, winStart, offFrame + Math.round(loudRel * SR), win, 400);
  const startFit = bestLag(wav.L, srcL, winStart, Math.round(loudRel * SR), win, 400);
  measurements.exportSource = { slippedFit, startFit, frames: wav.frames };
  check('9. the export plays the slipped source moment at bar 9 (correlation with the decoded stem > 0.9)',
    wav.sampleRate === 48000 && wav.channels === 2 && wav.bits === 24 && slippedFit.corr > 0.9 && Math.abs(slippedFit.lag) <= 400,
    measurements.exportSource);
  check('9. negative control: the same export does NOT match the stem from its start', startFit.corr < 0.6, { startFit });
  const nothingBefore = (() => { let m = 0; for (let i = 0; i < clipStartFrame - 4800; i += 1) m = Math.max(m, Math.abs(wav.L[i]), Math.abs(wav.R[i])); return m; })();
  check('9. nothing sounds before the clip at bar 9 (position unchanged by the slip)', nothingBefore < 1e-4, { nothingBefore });
  const g0 = fit(wav.L, srcL, winStart + slippedFit.lag, offFrame + Math.round(loudRel * SR), win, 0).gain;
  // Same arrangement with 0 dB: the exported body gain must differ by 3 dB.
  await page.locator(`.daw__clip[data-clip-id="${rc.id}"]`).scrollIntoViewIfNeeded();
  await page.click(`.daw__clip[data-clip-id="${rc.id}"]`, { position: { x: 60, y: 30 } });
  await page.fill('.daw__inspector input[aria-label="Gain"]', '0');
  await page.dispatchEvent('.daw__inspector input[aria-label="Gain"]', 'change');
  await page.fill('.daw__inspector input[aria-label="Fade in"]', '0');
  await page.dispatchEvent('.daw__inspector input[aria-label="Fade in"]', 'change');
  const wav0 = await exportWav('first-cut-export-0db-nofade');
  const g00 = fit(wav0.L, srcL, winStart + slippedFit.lag, offFrame + Math.round(loudRel * SR), win, 0).gain;
  measurements.exportGain = { minus3: g0, zero: g00, dB: 20 * Math.log10(g0 / g00) };
  check('9. the export applies the -3 dB clip gain (3.0 dB below the 0 dB export, within 0.3 dB)', near(20 * Math.log10(g0 / g00), -3, 0.3), measurements.exportGain);
  // The fade-in shape: the same quarter-beat slices of the faded export against the unfaded one (the bounce's own
  // DSP attack cancels in the ratio). A linear one-beat ramp rises 0.125, 0.375, 0.625, 0.875 across the four quarters.
  const quarter = Math.round((spb * SR) / 4);
  const ratioAt = (q) => {
    const a = fit(wav.L, srcL, clipStartFrame + slippedFit.lag + q * quarter, offFrame + q * quarter, quarter, 0).gain;
    const b = fit(wav0.L, srcL, clipStartFrame + slippedFit.lag + q * quarter, offFrame + q * quarter, quarter, 0).gain;
    return a / (b * 10 ** (-3 / 20));
  };
  const ramp = [0, 1, 2, 3].map(ratioAt);
  measurements.exportEnvelope = { ramp: ramp.map((r) => Math.round(r * 1000) / 1000), expected: [0.125, 0.375, 0.625, 0.875] };
  check('9. the export fades in over one beat: the faded-to-unfaded level ratio rises 0.125, 0.375, 0.625, 0.875 (within 0.12)',
    ramp.every((r, q) => near(r, [0.125, 0.375, 0.625, 0.875][q], 0.12)) && ramp.every((r, q) => q === 0 || r > ramp[q - 1]), measurements.exportEnvelope);
  await page.click('.daw__history button:nth-child(1)');
  await page.click('.daw__history button:nth-child(1)');
  check('9. Undo returns the clip to -3 dB and its one-beat fade after the comparison export',
    (await vocal()).clipGainDb === -3 && (await vocal()).fadeInBeats === 1);

  // ---- AI Producer: the same creative edit through the same edit API -----------
  // Use B Drums (lane 6) so the idea has something to do.
  const drums = (await state()).clips.find((c) => c.trackIndex === 5);
  await page.click(`.daw__clip[data-clip-id="${drums.id}"]`, { position: { x: 60, y: 28 } });
  await S(() => {
    const s = window.__arrangement.session;
    window.__logApply = [];
    if (!s.__wrapped) { const orig = s.apply.bind(s); s.apply = (c, k) => { window.__logApply.push(JSON.parse(JSON.stringify(c))); return orig(c, k); }; s.__wrapped = true; }
  });
  const preIdea = JSON.stringify((await state()).clips.find((c) => c.id === drums.id));
  await page.click('.daw__producer button:has-text("Ask for a clip idea")');
  check('10. asking for a clip idea changes nothing and lists typed changes',
    JSON.stringify((await state()).clips.find((c) => c.id === drums.id)) === preIdea
    && (await page.locator('.daw__producer-list li').count()) >= 4, { rows: await page.locator('.daw__producer-list li').allInnerTexts() });
  const rows = await page.locator('.daw__producer-list li').allInnerTexts();
  measurements.producerRows = rows;
  const dIdea = await depth();
  await page.click('.daw__producer button:has-text("Hear it")');
  const idea = (await state()).clips.find((c) => c.id === drums.id);
  const logged = await S(() => window.__logApply);
  const batch = logged.find((c) => c.name === 'batch');
  measurements.producerCommands = batch?.args.commands.map((c) => c.name);
  check('10. Hear it applies position, source in-point, gain and fade-in as ONE ordinary batch edit',
    idea.timelineStartBeat === 32 && idea.sourceOffsetSec > 0 && idea.clipGainDb === -3 && idea.fadeInBeats === 1
    && (await depth()) === dIdea + 1 && batch && batch.args.commands.every((c) => ['trimClip', 'slipClip', 'moveClip', 'setClipGain', 'setClipFades'].includes(c.name)),
    { idea, commands: measurements.producerCommands });
  // The same typed commands, one at a time through the musician's own path, give the identical clip.
  await page.click('.daw__history button:nth-child(1)');
  const undone = JSON.stringify((await state()).clips.find((c) => c.id === drums.id));
  await S((commands) => { const s = window.__arrangement.session; for (const c of commands) s.apply(c); }, batch.args.commands);
  const byHand = (await state()).clips.find((c) => c.id === drums.id);
  check('10. the musician applying the same typed edits one by one reaches the identical clip', undone === preIdea && JSON.stringify(byHand) === JSON.stringify(idea), { byHand, idea });
  for (let i = 0; i < batch.args.commands.length; i += 1) await page.click('.daw__history button:nth-child(1)');
  check('10. the hand route is also fully reversible', JSON.stringify((await state()).clips.find((c) => c.id === drums.id)) === preIdea);
  // Human edits stay authoritative while an idea is on offer. (Undo from the history is the
  // musician's move too, so start a fresh idea.)
  await page.click('.daw__producer button:has-text("Reject")');
  await page.click('.daw__producer button:has-text("Ask for a clip idea")');
  await page.click('.daw__producer button:has-text("Hear it")');
  await S((id) => { window.__arrangement.session.apply({ name: 'setClipGain', args: { clipId: id, gainDb: -9 } }); }, drums.id);
  await page.click('.daw__producer button:has-text("Hear mine")');
  const mineNow = (await state()).clips.find((c) => c.id === drums.id);
  check('10. Hear mine returns the position, in-point and length; the musician\'s -9 dB stays',
    mineNow.timelineStartBeat === drums.timelineStartBeat && mineNow.sourceOffsetSec === drums.sourceOffsetSec
    && mineNow.durationBeats === drums.durationBeats && mineNow.clipGainDb === -9, mineNow);
  await page.click('.daw__producer button:has-text("Hear it")');
  const keptHuman = (await state()).clips.find((c) => c.id === drums.id);
  check('10. hearing the idea again does not overwrite the musician\'s gain',
    keptHuman.clipGainDb === -9 && keptHuman.timelineStartBeat === 32 && keptHuman.sourceOffsetSec > 0, { gain: keptHuman.clipGainDb, start: keptHuman.timelineStartBeat });
  await page.click('.daw__producer button:has-text("Keep it")');
  await page.click('.daw__producer button:has-text("Undo")');
  const afterUndo = (await state()).clips.find((c) => c.id === drums.id);
  check('10. Keep then Undo returns position, in-point, length and fade to before; the musician\'s -9 dB stays',
    afterUndo.timelineStartBeat === drums.timelineStartBeat && afterUndo.sourceOffsetSec === drums.sourceOffsetSec
    && afterUndo.durationBeats === drums.durationBeats && afterUndo.fadeInBeats === drums.fadeInBeats && afterUndo.clipGainDb === -9, afterUndo);
  check('10. the Producer started no playback', (await S(() => window.__arrangement.session.phase())) !== 'playing');
  await page.screenshot({ path: join(outDir, 'fc-4-producer.png') });

  // ---- Layout, accessibility, phone --------------------------------------------
  const a11y1440 = await audit(page, 1440);
  measurements.a11y1440 = a11y1440;
  check('a11y 1440: no serious or moderate findings', a11y1440.serious === 0 && a11y1440.moderate === 0, a11y1440);
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const overflow = await S(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone 390 px: no page-level horizontal overflow', overflow <= 0, { overflow });
  const small = await S(() => [...document.querySelectorAll('.daw button, .daw input:not([type=checkbox]):not([type=range]), .daw select')]
    .filter((b) => b.offsetParent && !b.closest('.daw__scroller')).map((b) => { const r = b.getBoundingClientRect(); return { t: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 18), h: Math.round(r.height) }; })
    .filter((r) => r.h < 28));
  check('phone 390 px: controls keep usable heights', small.length === 0, small);
  const a11y390 = await audit(page, 390);
  measurements.a11y390 = a11y390;
  check('a11y 390: no serious or moderate findings', a11y390.serious === 0 && a11y390.moderate === 0, a11y390);
  await page.screenshot({ path: join(outDir, 'fc-390.png') });
  check('no page errors', pageErrors.length === 0, pageErrors);
} catch (err) {
  check('journey completed', false, { error: String(err && err.stack || err) });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'checks.json'), JSON.stringify({ checks, measurements, pageErrors }, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
