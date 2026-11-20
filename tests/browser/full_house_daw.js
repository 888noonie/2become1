#!/usr/bin/env node
// OPERATION FULL HOUSE — the PM's eleven-step product acceptance, driven through
// the real Studio controls in real Chromium against a seeded loopback Studio.
//
//   node tests/browser/full_house_daw.js <studio-url> <out-dir>
//
// Chromium runs with --disable-audio-output and --mute-audio: the Web Audio
// clock and graph run for real, but nothing reaches this machine's speakers.
// Every musical action is a pointer, key or form action on the page; page
// state is only READ (window.__arrangement) to verify what the controls did.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base = 'http://127.0.0.1:8791', outDir = 'full-house-out'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const checks = [];
const measurements = {};
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const rmsDb = (L, R, a, b) => {
  let s = 0; let n = 0;
  for (let i = Math.max(0, a); i < Math.min(L.length, b); i += 1) { s += L[i] * L[i] + R[i] * R[i]; n += 2; }
  return n ? 10 * Math.log10(s / n + 1e-20) : -200;
};

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
  // Count AudioContexts the page creates (loading must create none).
  await context.addInitScript(() => {
    window.__ctxCount = 0;
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__ctxCount += 1; } };
  });
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  check('loading the arrangement opens no audio device', await page.evaluate(() => window.__ctxCount) === 0);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const state = () => S(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));

  // ---- 1. Load two songs' stems ------------------------------------------
  await page.click('.daw__import > summary');
  await page.waitForFunction(() => document.querySelectorAll('.daw__import-row--A select[aria-label^="Track"] option').length > 1);
  const pick = async (group, title, from) => {
    const value = await page.$eval(`.daw__import-row--${group} select[aria-label^="Track"]`, (sel, t) => [...sel.options].find((o) => o.text.includes(t))?.value, title);
    await page.selectOption(`.daw__import-row--${group} select[aria-label^="Track"]`, value);
    await page.selectOption(`.daw__import-row--${group} select[aria-label^="Section length"]`, '60');
    await page.fill(`.daw__import-row--${group} input[type=number]`, String(from));
    await page.click(`.daw__bring--${group}`);
    await page.waitForFunction((g) => !document.querySelector(`.daw__bring--${g}`).disabled, group, { timeout: 120000 });
  };
  const t0 = Date.now();
  await pick('A', 'Midnight Circuit', 30);
  await pick('B', 'Paper Lanterns', 30);
  measurements.importMs = Date.now() - t0;
  let st = await state();
  check('1. two songs bring eight stem clips (four per track)', st.clips.length === 8, { clips: st.clips.length });
  check('1. assets reference Studio stem sections, not audio data',
    Object.values(st.assets).every((a) => /^\/api\/stems\/[^/]+\/audio\?name=\w+&start=30&duration=60$/.test(a.bufferReference)),
    Object.values(st.assets).map((a) => a.bufferReference));
  check('1. project tempo taken from A\'s measured analysis', Math.abs(st.transport.masterBpm - 96.8) < 0.05, { bpm: st.transport.masterBpm });

  // ---- 2. Eight tracks, real waveforms -------------------------------------
  const names = await page.$$eval('.daw__head strong', (els) => els.map((e) => e.textContent));
  check('2. eight lanes A Vocals..B Other', JSON.stringify(names) === JSON.stringify(
    ['A Vocals', 'A Drums', 'A Bass', 'A Other', 'B Vocals', 'B Drums', 'B Bass', 'B Other']), names);
  await sleep(300);
  const wave = await S(() => {
    const out = [];
    for (const el of document.querySelectorAll('.daw__clip')) {
      const c = el.querySelector('canvas');
      const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < g.length; i += 4) if (g[i] > 0) lit += 1;
      out.push({ clip: el.dataset.clipId, lit: lit / (c.width * c.height) });
    }
    return out;
  });
  check('2. every clip draws a waveform from decoded peaks', wave.every((w) => w.lit > 0.02), wave);
  // The peaks are the real PCM: recompute one bucket from the decoded buffer.
  const peakOk = await S(() => {
    const s = window.__arrangement.session;
    const asset = Object.values(s.state.assets)[1];
    const buf = s.buffers[asset.bufferReference];
    // eslint-disable-next-line no-undef
    return import('/assets/js/arrangement/daw-session.js').then(({ peaksFor }) => {
      const p = peaksFor(asset.bufferReference);
      const b = 400;
      let hi = 0;
      for (let i = b * 256; i < (b + 1) * 256; i += 1) hi = Math.max(hi, (buf.channels[0][i] + (buf.channels[1] ?? buf.channels[0])[i]) / 2);
      return { cached: p.max[b], recomputed: hi, buckets: p.max.length };
    });
  });
  check('2. waveform peaks equal the decoded audio', Math.abs(peakOk.cached - peakOk.recomputed) < 1e-6, peakOk);
  await page.screenshot({ path: join(outDir, 'daw-1440-loaded.png') });

  // ---- 3. Drag a vocal clip into another section --------------------------
  const clipBox = async (trackIndex, nth = 0) => {
    const id = await S(([t, n]) => window.__arrangement.session.state.clips.filter((c) => c.trackIndex === t)
      .sort((a, b) => a.timelineStartBeat - b.timelineStartBeat)[n]?.id, [trackIndex, nth]);
    await page.locator(`.daw__clip[data-clip-id="${id}"]`).scrollIntoViewIfNeeded();
    const box = await page.locator(`.daw__clip[data-clip-id="${id}"]`).boundingBox();
    return { id, box };
  };
  await page.selectOption('select[aria-label="Snap"]', 'bar');
  await page.click('button[aria-label="Zoom out"]'); // 16 px/beat: the whole section and the gap are visible
  await page.click('button[aria-label="Zoom out"]'); // 10 px/beat
  let { id: bv, box } = await clipBox(4);
  const ppb = await S(() => 10);
  const before = (await state()).clips.find((c) => c.id === bv);
  // Drag B Vocals 28 bars right (beyond every other clip) using the mouse.
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(box.x + 60 + (28 * 4 * ppb * i) / 10, box.y + box.height / 2);
  await page.mouse.up();
  st = await state();
  let moved = st.clips.find((c) => c.id === bv);
  check('3. drag moves the vocal clip by 28 bars on its lane (snapped to bars)',
    moved.timelineStartBeat === 112 && moved.trackIndex === 4, { start: moved.timelineStartBeat, track: moved.trackIndex });
  check('3. moving keeps the source offset', moved.sourceOffsetSec === before.sourceOffsetSec);

  // Undo / redo of that move from the keyboard (step 9 rehearsed early, re-checked later)
  await page.click('.daw__corner');
  await page.keyboard.press('Control+z');
  st = await state();
  check('9. Ctrl+Z returns the clip to where it was', st.clips.find((c) => c.id === bv).timelineStartBeat === before.timelineStartBeat);
  await page.keyboard.press('Control+Shift+z');
  st = await state();
  check('9. Ctrl+Shift+Z re-applies the move', st.clips.find((c) => c.id === bv).timelineStartBeat === 112);

  // ---- 4. Split and trim ---------------------------------------------------
  ({ box } = await clipBox(4));
  await page.click('.daw__ruler', { position: { x: (112 + 32) * ppb + 2, y: 15 } }); // cue at bar 37 (beat 144)
  await page.locator(`.daw__clip[data-clip-id="${bv}"]`).click({ position: { x: 40, y: 30 } });
  await page.click('button:has-text("Split at playhead")');
  st = await state();
  const halves = st.clips.filter((c) => c.trackIndex === 4).sort((a, b) => a.timelineStartBeat - b.timelineStartBeat);
  const spb = 60 / st.transport.masterBpm;
  check('4. split at the cue makes two clips that meet at beat 144',
    halves.length === 2 && halves[1].timelineStartBeat === 144 && halves[0].timelineStartBeat + halves[0].durationBeats === 144,
    halves.map((c) => [c.timelineStartBeat, c.durationBeats]));
  check('4. the right half continues exactly where the left stops in the source',
    Math.abs(halves[1].sourceOffsetSec - (halves[0].sourceOffsetSec + 32 * spb)) < 1e-6,
    { left: halves[0].sourceOffsetSec, right: halves[1].sourceOffsetSec });
  // Trim the right half's start by one bar with its start handle.
  const right = halves[1];
  await page.locator(`.daw__clip[data-clip-id="${right.id}"]`).scrollIntoViewIfNeeded();
  const rightBox = await page.locator(`.daw__clip[data-clip-id="${right.id}"]`).boundingBox();
  await page.locator(`.daw__clip[data-clip-id="${right.id}"]`).click({ position: { x: 40, y: 30 } });
  await page.mouse.move(rightBox.x + 3, rightBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(rightBox.x + 3 + 2 * ppb, rightBox.y + 40);
  await page.mouse.move(rightBox.x + 3 + 4 * ppb, rightBox.y + 40);
  await page.mouse.up();
  st = await state();
  const trimmed = st.clips.find((c) => c.id === right.id);
  check('4. trimming the start moves start and source offset together (one bar)',
    trimmed.timelineStartBeat === 148 && Math.abs(trimmed.sourceOffsetSec - (right.sourceOffsetSec + 4 * spb)) < 1e-6,
    { start: trimmed.timelineStartBeat, offset: trimmed.sourceOffsetSec, expected: right.sourceOffsetSec + 4 * spb });
  // Trim the end handle back by two bars.
  const tb = await page.locator(`.daw__clip[data-clip-id="${right.id}"]`).boundingBox();
  await page.mouse.move(tb.x + tb.width - 3, tb.y + 40);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width - 3 - 4 * ppb, tb.y + 40);
  await page.mouse.move(tb.x + tb.width - 3 - 8 * ppb, tb.y + 40);
  await page.mouse.up();
  st = await state();
  const endTrim = st.clips.find((c) => c.id === right.id);
  // The end edge snaps to the bar grid (Snap: Bar), two bars earlier.
  const snappedEnd = Math.round((trimmed.timelineStartBeat + trimmed.durationBeats - 8) / 4) * 4;
  check('4. trimming the end lands on the bar grid and keeps its source start',
    Math.abs(endTrim.timelineStartBeat + endTrim.durationBeats - snappedEnd) < 1e-6 && endTrim.sourceOffsetSec === trimmed.sourceOffsetSec,
    { before: trimmed.durationBeats, after: endTrim.durationBeats, snappedEnd });

  // ---- 5. Stretch to project tempo (time only) ----------------------------
  await page.locator(`.daw__clip[data-clip-id="${bv}"]`).click({ position: { x: 40, y: 30 } });
  const pre = (await state()).clips.find((c) => c.id === bv);
  await page.click('button:has-text("Fit to project tempo")');
  st = await state();
  const fitted = st.clips.find((c) => c.id === bv);
  const bAsset = st.assets[fitted.assetId];
  // 84.3 BPM material played at 96.8 BPM is consumed faster: the same source
  // spans fewer project beats.
  const expectDur = pre.durationBeats * (bAsset.nativeBpm / st.transport.masterBpm);
  check('5. Fit to project tempo follows B\'s measured tempo (beat_sync)',
    fitted.stretchMode === 'beat_sync' && bAsset.nativeBpmSource === 'analysis', { mode: fitted.stretchMode, bpm: bAsset.nativeBpm });
  check('5. the same source material now spans the project tempo (duration scaled by 84.3/96.8)',
    Math.abs(fitted.durationBeats - expectDur) < 1e-3 && fitted.sourceOffsetSec === pre.sourceOffsetSec,
    { before: pre.durationBeats, after: fitted.durationBeats, expectDur });
  check('5. stretching does not touch pitch', fitted.pitchSemitones === 0);

  // ---- 6. Pitch-shift independently ----------------------------------------
  await page.fill('input[aria-label="Semitones"]', '3');
  await page.dispatchEvent('input[aria-label="Semitones"]', 'change');
  await page.check('input[aria-label="Keep formants"]');
  st = await state();
  const pitched = st.clips.find((c) => c.id === bv);
  check('6. pitch +3 st with formants kept, duration and offsets untouched',
    pitched.pitchSemitones === 3 && pitched.preserveFormants === true
    && pitched.durationBeats === fitted.durationBeats && pitched.sourceOffsetSec === fitted.sourceOffsetSec,
    { semitones: pitched.pitchSemitones, formants: pitched.preserveFormants });

  // ---- 7. Fades, gain, EQ, pan ---------------------------------------------
  await page.fill('input[aria-label="Fade in"]', '2');
  await page.dispatchEvent('input[aria-label="Fade in"]', 'change');
  await page.fill('input[aria-label="Gain"]', '-3');
  await page.dispatchEvent('input[aria-label="Gain"]', 'change');
  // Fade-out by dragging its grip on the clip.
  const fb = await page.locator(`.daw__clip[data-clip-id="${bv}"]`).boundingBox();
  await page.mouse.move(fb.x + fb.width - 16, fb.y + 4);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width - 16 - 2 * ppb, fb.y + 4);
  await page.mouse.move(fb.x + fb.width - 16 - 4 * ppb, fb.y + 4);
  await page.mouse.up();
  st = await state();
  const faded = st.clips.find((c) => c.id === bv);
  check('7. clip fades in over 2 beats, fades out by its grip, gain -3 dB',
    faded.fadeInBeats === 2 && faded.fadeOutBeats > 3 && faded.clipGainDb === -3,
    { in: faded.fadeInBeats, out: faded.fadeOutBeats, gain: faded.clipGainDb });
  await page.click('.daw__head-name[data-track-select="4"]');
  for (const [label, v] of [['EQ low (250 Hz shelf)', '-4'], ['EQ high (4 kHz shelf)', '3'], ['Pan', '-0.4'], ['Level', '-2']]) {
    await page.fill(`.daw__inspector input[aria-label="${label}"]`, v);
    await page.dispatchEvent(`.daw__inspector input[aria-label="${label}"]`, 'change');
  }
  st = await state();
  const t4 = st.tracks[4];
  check('7. track EQ, pan and level set from the inspector',
    t4.eq.lowGainDb === -4 && t4.eq.highGainDb === 3 && t4.pan === -0.4 && t4.volumeDb === -2, t4);
  await page.fill('input[aria-label="Master level (exported)"]', '-1.5');
  await page.dispatchEvent('input[aria-label="Master level (exported)"]', 'change');
  check('7. master level is project state', (await state()).master?.volumeDb === -1.5);
  const depthBeforeDrag = await S(() => window.__arrangement.session.edit.historyDepth.past);
  // A real mouse drag along the A Drums fader: many input events, one change.
  const fader = page.locator('.daw__head:nth-child(2) .daw__head-fader');
  await fader.scrollIntoViewIfNeeded();
  const fbx = await fader.boundingBox();
  const zeroX = fbx.x + fbx.width * (60 / 66);
  await page.mouse.move(zeroX, fbx.y + fbx.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(zeroX - i * 6, fbx.y + fbx.height / 2);
  await page.mouse.up();
  check('7. a fader drag is one undo step', await S(() => window.__arrangement.session.edit.historyDepth.past) === depthBeforeDrag + 1);
  await page.screenshot({ path: join(outDir, 'daw-1440-edited.png') });

  // ---- 8. Play and loop the arrangement -----------------------------------
  await page.click('.daw__ruler', { position: { x: 4, y: 15 } }); // cue to bar 1
  await page.click('button[aria-label="Play"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 15000 });
  check('8. Play creates exactly one AudioContext', await page.evaluate(() => window.__ctxCount) === 1);
  await sleep(500); // past the start lead: the heard position is moving
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    samples.push(await S(() => ({ beat: window.__arrangement.session.playheadBeat(), t: window.__arrangement.session.ctx.currentTime })));
    await sleep(250);
  }
  const rate = (samples.at(-1).beat - samples[0].beat) / (samples.at(-1).t - samples[0].t);
  measurements.playheadBeatsPerSec = rate;
  check('8. the playhead follows the audio clock at the project tempo', Math.abs(rate - 96.8 / 60) < 0.02, { rate, expected: 96.8 / 60 });
  const playingDiag = await S(() => {
    const d = window.__arrangement.session.engine.diagnostics();
    return { voices: d.pool.live, capacity: d.capacity, misses: d.deadlineMisses, peak: d.peakConnectedProcessors };
  });
  check('8. eight lanes play with no deadline miss inside the voice budget',
    playingDiag.misses === 0 && playingDiag.voices >= 7 && playingDiag.peak <= playingDiag.capacity, playingDiag);
  // Editing while playing changes what is heard: mute ramps the track gain.
  await page.click('button[aria-label="Mute A Drums"]');
  await sleep(120);
  const gainA1 = await S(() => window.__arrangement.session.engine.backbone.trackInputs['gain-1'].gain.value);
  check('8. Mute while playing ramps the live track gain to silence', gainA1 === 0, { gainA1 });
  await page.click('button[aria-label="Mute A Drums"]');
  // A clip move while playing re-plans the live engine through the seek handover.
  const epochs0 = await S(() => window.__arrangement.session.engine.state().epoch);
  const aOther = (await state()).clips.find((c) => c.trackIndex === 3);
  await page.locator(`.daw__clip[data-clip-id="${aOther.id}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await sleep(400);
  const live = await S((id) => {
    const e = window.__arrangement.session.engine;
    const c = e.plan.clips.find((x) => x.clipId === id);
    const d = e.diagnostics();
    return { start: c.timelineStartFrame, epoch: e.state().epoch, phase: e.state().phase, epochs: [...new Set(d.voices.map((v) => v.epoch))], misses: d.deadlineMisses };
  }, aOther.id);
  check('8. moving a clip while playing reaches the live engine without stopping',
    live.start === Math.round(4 * (60 / 96.8) * 48000) && live.phase === 'playing' && live.misses === 0, live);
  // Loop: drag on the ruler over bars 3-5.
  await page.evaluate(() => { window.__arrangement.elements.scroller.scrollLeft = 0; });
  await page.locator('.daw__ruler').scrollIntoViewIfNeeded();
  const rb = await page.locator('.daw__ruler').boundingBox();
  await page.mouse.move(rb.x + 8 * ppb + 1, rb.y + 15);
  await page.mouse.down();
  await page.mouse.move(rb.x + 12 * ppb, rb.y + 15);
  await page.mouse.move(rb.x + 16 * ppb + 1, rb.y + 15);
  await page.mouse.up();
  st = await state();
  check('8. dragging the ruler sets the loop bars 3-5', JSON.stringify(st.transport.loopRange) === '[8,16]', st.transport.loopRange);
  await sleep(600);
  const loopBeats = [];
  for (let i = 0; i < 40; i += 1) { loopBeats.push(await S(() => window.__arrangement.session.playheadBeat())); await sleep(200); }
  const eLoop = await S(() => window.__arrangement.session.engine.state().loop);
  check('8. the engine plays the loop and the heard playhead stays inside it (and wraps)',
    JSON.stringify(eLoop) === JSON.stringify([Math.round(8 * (60 / 96.8) * 48000), Math.round(16 * (60 / 96.8) * 48000)])
    && loopBeats.slice(4).every((b) => b >= 7.99 && b < 16.01)
    && loopBeats.some((b, i) => i > 0 && b < loopBeats[i - 1] - 1),
    { eLoop, loopBeats: loopBeats.map((b) => Math.round(b * 100) / 100) });
  await page.click('button[aria-label="Loop"]');
  await page.click('button[aria-label="Stop"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'stopped', null, { timeout: 5000 });
  await sleep(300);
  const stopped = await S(() => { const d = window.__arrangement.session.engine.diagnostics(); return { live: d.pool.live, connected: d.connectedProcessors, sched: d.schedulerRunning }; });
  check('8. Stop releases every voice and processor (no stale voices or leaks)', stopped.live === 0 && stopped.connected === 0, stopped);
  // Pause then Play resumes from the heard position.
  await page.click('button[aria-label="Play"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing');
  await sleep(1200);
  await page.click('button[aria-label="Pause"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'stopped');
  const cueBeat = await S(() => window.__arrangement.session.playheadBeat());
  check('8. Pause parks at the heard position (not the start)', cueBeat > 1, { cueBeat });
  await page.click('button[aria-label="Stop"]');

  // ---- 8b. What is HEARD follows the edits (live output, measured) ----------
  // A read-only analyser on the listening stage after the limiter: the signal
  // that would reach the speakers (output is disabled for this run).
  await S(() => {
    const s = window.__arrangement.session;
    const an = s.ctx.createAnalyser();
    an.fftSize = 2048;
    s.monitor.connect(an);
    window.__tap = an;
    window.__level = async (ms = 500) => {
      const buf = new Float32Array(2048);
      let best = -200;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        best = Math.max(best, 10 * Math.log10(sum / buf.length + 1e-20));
        await new Promise((r) => setTimeout(r, 40));
      }
      return best;
    };
  });
  await page.click('button[aria-label="Solo B Vocals"]');
  await S(() => window.__arrangement.session.seek(116)); // inside the stretched, +3 st B Vocals clip
  await page.click('button[aria-label="Play"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 15000 });
  await sleep(400);
  const soloLevel = await S(() => window.__level(700));
  const dsp = await S(() => {
    const d = window.__arrangement.session.engine.diagnostics();
    return { dspArms: d.timing.suppliedDspLeadMs?.count ?? 0, minLeadMs: d.timing.suppliedDspLeadMs?.min ?? null, misses: d.deadlineMisses, unqualified: d.unqualifiedStretch };
  });
  measurements.liveDsp = { soloLevel, ...dsp };
  check('8b. the stretched, pitch-shifted vocal plays live through Signalsmith (primed, no deadline miss)',
    dsp.dspArms >= 1 && dsp.misses === 0 && dsp.minLeadMs >= 64, dsp);
  check('8b. soloed B Vocals is heard at its new bar', soloLevel > -50, { soloLevel });
  check('8b. a pitch shift outside the measured priming range is reported, not hidden',
    dsp.unqualified.some((u) => u.semitones === 3), dsp.unqualified);
  // Swap the solo to A Vocals, which has nothing at this bar: the output must fall silent.
  await page.click('button[aria-label="Solo B Vocals"]');
  await page.click('button[aria-label="Solo A Vocals"]');
  await sleep(250);
  const silentLevel = await S(() => window.__level(600));
  measurements.liveDsp.swappedSoloLevel = silentLevel;
  check('8b. a solo edit while playing changes what is heard (silence where A Vocals has no clip)', silentLevel < -90, { silentLevel });
  await page.click('button[aria-label="Solo A Vocals"]');
  await page.click('button[aria-label="Stop"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'stopped', null, { timeout: 5000 });

  // ---- 9. Undo / redo buttons on a fresh edit -------------------------------
  const vol = (await state()).tracks[4].volumeDb;
  await page.click('.daw__head-name[data-track-select="4"]');
  await page.fill('.daw__inspector input[aria-label="Level"]', '-5');
  await page.dispatchEvent('.daw__inspector input[aria-label="Level"]', 'change');
  const edited = (await state()).tracks[4].volumeDb;
  await page.click('.daw__history button:nth-child(1)');
  const undone = (await state()).tracks[4].volumeDb;
  await page.click('.daw__history button:nth-child(2)');
  const redone = (await state()).tracks[4].volumeDb;
  check('9. Undo and Redo buttons step the history', edited === -5 && undone === vol && redone === -5, { vol, edited, undone, redone });

  // ---- 10. Save, close, reopen ----------------------------------------------
  await page.fill('input[aria-label="Arrangement name"]', 'Full House demo');
  await page.click('button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('[data-field="save-state"]').textContent === 'all edits saved');
  const savedDoc = await S(() => { const s = JSON.parse(window.__arrangement.session.edit.serialize()); s.transport.isPlaying = false; return s; });
  const savedId = await S(() => window.__arrangement.session.projectId);
  await page.close(); // close the Studio
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
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
      if (a !== b) diffs.push({ path, saved: a, reopened: b });
      return;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
  };
  walk(savedDoc, reopened, '');
  check('10. reopening reproduces the saved arrangement exactly', diffs.length === 0, diffs.slice(0, 5));
  check('10. reopened project holds references, not audio', !JSON.stringify(reopened).includes('channels') && JSON.stringify(reopened).length < 40000,
    { bytes: JSON.stringify(reopened).length });
  await page.screenshot({ path: join(outDir, 'daw-1440-reopened.png') });

  // ---- 11. Export the finished arrangement ---------------------------------
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.click('button:has-text("Export WAV")'),
  ]);
  const wavPath = join(outDir, await download.suggestedFilename());
  await download.saveAs(wavPath);
  const report = await page.evaluate(() => window.__arrangement.session.lastExport);
  const wav = readWav(readFileSync(wavPath));
  const endBeat = Math.max(...reopened.clips.map((c) => c.timelineStartBeat + c.durationBeats));
  const expectFrames = Math.round(endBeat * (60 / reopened.transport.masterBpm) * 48000) + 24000;
  measurements.export = { ...report, file: wavPath };
  check('11. export is 48 kHz, stereo, 24-bit', wav.sampleRate === 48000 && wav.channels === 2 && wav.bits === 24, wav);
  check('11. export length = arrangement end + 0.5 s tail', Math.abs(wav.frames - expectFrames) <= 1, { frames: wav.frames, expectFrames });
  let peak = 0;
  for (let i = 0; i < wav.frames; i += 1) peak = Math.max(peak, Math.abs(wav.L[i]), Math.abs(wav.R[i]));
  const peakDb = 20 * Math.log10(peak);
  check('11. export peak stays under the -0.3 dBFS limiter ceiling', peakDb <= -0.3 + 0.01, { peakDb });
  // Placement: the moved B Vocals clip is the only clip after the A/B sections.
  const fr = (beat) => Math.round(beat * (60 / reopened.transport.masterBpm) * 48000);
  const others = reopened.clips.filter((c) => c.trackIndex !== 4);
  const othersEnd = Math.max(...others.map((c) => c.timelineStartBeat + c.durationBeats));
  const vocalFirst = reopened.clips.filter((c) => c.trackIndex === 4).sort((a, b) => a.timelineStartBeat - b.timelineStartBeat)[0];
  const gap = rmsDb(wav.L, wav.R, fr(othersEnd) + 4800, fr(vocalFirst.timelineStartBeat) - 2400);
  const vocal = rmsDb(wav.L, wav.R, fr(vocalFirst.timelineStartBeat + 4), fr(vocalFirst.timelineStartBeat + 12));
  measurements.placement = { othersEndBeat: othersEnd, vocalStartBeat: vocalFirst.timelineStartBeat, gapDb: gap, vocalDb: vocal };
  check('11. representative placement: silence in the gap, the moved vocal sounds at its new bar', gap < -80 && vocal > -45, measurements.placement);
  const savedAfter = await (await fetch(`${base}/api/arrangements/${savedId}`)).json();
  check('11. the export reflects the saved arrangement', JSON.stringify(savedAfter.project) === JSON.stringify(reopened) && report.arrangementId === savedId);

  // ---- Stage D: the Producer edits the same project data --------------------
  await page.click('button:has-text("Ask for an idea")');
  const beforeIdea = (await page.evaluate(() => JSON.parse(window.__arrangement.session.edit.serialize()))).tracks.map((t) => t.mute);
  check('D. an idea alone changes nothing', JSON.stringify(beforeIdea) === JSON.stringify(reopened.tracks.map((t) => t.mute)));
  await page.click('.daw__producer button:has-text("Hear it")');
  const hearing = (await state()).tracks.map((t) => t.mute);
  check('D. Hear it applies the idea to the same ProjectState', JSON.stringify(hearing) === JSON.stringify([true, false, false, true, false, true, true, false]), hearing);
  await page.click('button[aria-label="Mute B Vocals"]'); // the musician's own move
  await page.click('.daw__producer button:has-text("Hear mine")');
  const mine = (await state()).tracks.map((t) => t.mute);
  check('D. Hear mine returns to the captured mix but keeps the musician\'s move',
    mine[4] === true && JSON.stringify(mine.filter((_, i) => i !== 4)) === JSON.stringify(beforeIdea.filter((_, i) => i !== 4)), mine);
  await page.click('.daw__producer button:has-text("Hear it")');
  await page.click('.daw__producer button:has-text("Keep it")');
  await page.click('.daw__producer button:has-text("Undo")');
  const undoneIdea = (await state()).tracks.map((t) => t.mute);
  check('D. Keep then Undo restores the mix from before the idea, musician move kept',
    undoneIdea[4] === true && JSON.stringify(undoneIdea.filter((_, i) => i !== 4)) === JSON.stringify(beforeIdea.filter((_, i) => i !== 4)), undoneIdea);
  check('D. no playback was started by the Producer', await S(() => window.__arrangement.session.phase()) !== 'playing');

  // ---- Phone width ----------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const overflow = await S(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone 390 px: no page-level horizontal overflow', overflow <= 0, { overflow });
  const small = await S(() => [...document.querySelectorAll('.daw button, .surface-switch button')]
    .filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 14), w: r.width, h: r.height }; })
    .filter((r) => r.h < 28));
  check('phone 390 px: controls keep usable heights', small.length === 0, small);
  await page.screenshot({ path: join(outDir, 'daw-390.png'), fullPage: false });
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
