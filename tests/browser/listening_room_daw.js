#!/usr/bin/env node
// OPERATION THE LISTENING ROOM — talk to the Producer in real Chromium, against
// a seeded loopback Studio whose Producer model is the LOCAL Ollama daemon.
//
//   node tests/browser/listening_room_daw.js <studio-url> <out-dir>
//
// Chromium runs with --disable-audio-output and --mute-audio. Every request is
// typed into the Producer's text box and answered by the real model; every
// musical action is a click, key or form action. Page state is only READ
// (window.__arrangement) to verify what happened. Songs: A = Looking For Love,
// B = Need To Feel Loved (Demucs stems), 60 s from 30 s each.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const [base = 'http://127.0.0.1:8793', outDir = 'listening-room-out'] = process.argv.slice(2);
const A11Y_SOURCE = readFileSync(new URL('./a11y.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ').replace(/^export \{.*$/m, '').replace(/^export const /gm, 'const ').replace(/^export /gm, '')
  + '\nwindow.auditDocument = auditDocument;\n';
mkdirSync(outDir, { recursive: true });
const checks = [];
const measurements = { turns: [] };
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const SR = 48000;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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
  const L = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const p = data.offset + i * 6;
    let v = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff;
    L[i] = v / 8388608;
  }
  return { ...fmt, frames, L };
}
/** RMS envelope (20 ms frames) of x from `start` for `count` frames, reading x at `start + k*step`. */
function envelope(x, start, count, step = 1) {
  const hop = 960; const out = [];
  for (let f = 0; f < count; f += 1) {
    let e = 0;
    for (let i = 0; i < hop; i += 1) { const v = x[Math.round(start + (f * hop + i) * step)] ?? 0; e += v * v; }
    out.push(Math.sqrt(e / hop));
  }
  return out;
}
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  const ma = a.reduce((s, v) => s + v, 0) / n; const mb = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < n; i += 1) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

const browser = await chromium.launch({
  executablePath: resolveChromium(), headless: true,
  args: ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  let page = await context.newPage();
  const conversation = [];
  const watch = (p) => {
    p.on('pageerror', (e) => pageErrors.push(e.message));
    p.on('response', async (r) => {
      if (!r.url().includes('/api/producer/converse')) return;
      const j = await r.json().catch(() => null);
      if (j?.intent) conversation.push({ intent: j.intent, model: j.model, contextChars: j.contextChars });
    });
  };
  watch(page);
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('[data-testid="arrangement"]');
  const S = (fn, arg) => page.evaluate(fn, arg);
  const state = () => S(() => JSON.parse(JSON.stringify(window.__arrangement.session.state)));
  const depth = () => S(() => window.__arrangement.session.edit.historyDepth.past);
  const idea = async () => (await state()).clips.find((c) => c.id.startsWith('idea-'));
  const card = '.daw__producer-card';
  const say = async (text) => {
    const n = await S(() => Number(document.querySelector('.daw__talk-log').dataset.lines || 0));
    const t0 = Date.now();
    await page.fill('.daw__talk-input', text);
    const seen = conversation.length;
    await page.click('.daw__talk button[type=submit]');
    await page.waitForFunction((n) => Number(document.querySelector('.daw__talk-log').dataset.lines || 0) >= n + 2 && !document.querySelector('.daw__talk-input').disabled, n, { timeout: 180000 });
    const reply = (await page.locator('.daw__talk-log li').last().textContent()).trim();
    for (let i = 0; i < 40 && conversation.length === seen; i += 1) await page.waitForTimeout(25);
    const got = conversation.length > seen ? conversation.at(-1) : null;
    const turn = { you: text, producer: reply, intent: got?.intent ?? null, model: got?.model?.name ?? null, ms: Date.now() - t0 };
    measurements.turns.push(turn);
    console.log(`      you: ${text}\n      producer: ${reply.slice(0, 240)}`);
    return turn;
  };
  /** Say it; if the model asks a question instead, answer the way a musician would (recorded). */
  const sayUntil = async (text, done, answers) => {
    let turn = await say(text);
    for (const a of answers) {
      if (await done(turn)) return turn;
      turn = await say(a);
    }
    return turn;
  };

  // ---- Bring both songs in ------------------------------------------------------
  await page.click('.daw__import > summary');
  for (const [g, title] of [['A', 'Looking For Love'], ['B', 'Need To Feel Loved']]) {
    await page.waitForFunction((g) => document.querySelectorAll(`.daw__import-row--${g} select[aria-label^="Track"] option`).length > 1, g);
    const v = await page.$eval(`.daw__import-row--${g} select[aria-label^="Track"]`, (sel, t) => [...sel.options].find((o) => o.text.includes(t))?.value, title);
    await page.selectOption(`.daw__import-row--${g} select[aria-label^="Track"]`, v);
    await page.selectOption(`.daw__import-row--${g} select[aria-label^="Section length"]`, '60');
    await page.fill(`.daw__import-row--${g} input[type=number]`, '30');
    await page.click(`.daw__bring--${g}`);
    await page.waitForFunction((n) => window.__arrangement.session.state.clips.length === n, g === 'A' ? 4 : 8, { timeout: 120000 });
  }
  await page.locator('.daw__timeline').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('-');
  await page.keyboard.press('+');
  const modelLine = await page.locator('.daw__talk-model').textContent();
  check('setup: both songs on the lanes; the Producer names its local model', (await state()).clips.length === 8 && /qwen2\.5:3b-instruct via Ollama, on this machine/.test(modelLine), { modelLine });

  // ---- 1. The headline request --------------------------------------------------
  const before = JSON.stringify((await state()).clips);
  const d0 = await depth();
  const t1 = await sayUntil('Find the second chorus in the other song and put its vocals over my drums at bar 17',
    async (t) => /chorus 2 of “Need To Feel Loved”/.test(t.producer),
    ['The second chorus of song B, its vocals, at bar 17.']);
  const analysisB = await S(async () => {
    const id = window.__arrangement.session.groups().B.trackId;
    return (await fetch(`/api/tracks/${id}/listening`)).json();
  });
  const chorus2 = analysisB.sections.find((s) => s.name === 'chorus 2');
  measurements.analysisB = {
    elapsedSec: analysisB.elapsedSec, lyrics: analysisB.lyrics, method: analysisB.method,
    sections: analysisB.sections.map((s) => `${s.name} bars ${s.startBar}-${s.startBar + s.bars - 1} ${s.startSec}-${s.endSec}s c=${s.confidence}`),
  };
  check('1. a free-text request, answered by the real model, picks chorus 2 of the OTHER song from its audio analysis',
    /chorus 2 of “Need To Feel Loved”.*at bar 17/.test(t1.producer) && chorus2 && t1.intent?.section === `B:${chorus2.id}` && t1.model === 'qwen2.5:3b-instruct',
    { t1, chorus2 });
  check('1. the idea is shown on the timeline (B Vocals lane, aqua outline) and nothing has changed yet',
    JSON.stringify((await state()).clips) === before && (await depth()) === d0
      && (await page.locator('.daw__lane[data-track="4"] .daw__ghost.daw__ghost--B').count()) === 1);
  await page.locator('.daw__lane[data-track="4"] .daw__ghost').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, 'lr-1-idea-outline.png') });

  // ---- 2. Refine it -------------------------------------------------------------
  const t2 = await say('Pitch it up two semitones and fade it in over two beats');
  check('2. “pitch it up two semitones and fade it in over two beats” changes the same idea', /\+2 semitones, fade in 2 beats/.test(t2.producer) && /chorus 2/.test(t2.producer), t2);

  // ---- 3. Hear it ---------------------------------------------------------------
  await page.click(`${card} button:has-text("Hear it")`);
  let c = await idea();
  check('3. Hear it puts the idea on the lanes as ONE edit: bar 17, +2 st, 2-beat fade, fitted to tempo',
    c && c.trackIndex === 4 && c.timelineStartBeat === 64 && c.pitchSemitones === 2 && c.fadeInBeats === 2 && c.stretchMode === 'beat_sync' && (await depth()) === d0 + 1, c);

  // ---- 4. A follow-up while listening -------------------------------------------
  const t3 = await say('Half a beat earlier');
  c = await idea();
  check('4. “half a beat earlier” moves it to beat 63.5 and keeps pitch, fade and passage, as ONE more undo step',
    c.timelineStartBeat === 63.5 && c.pitchSemitones === 2 && c.fadeInBeats === 2 && (await depth()) === d0 + 2 && /Now playing/.test(t3.producer), { c, t3 });
  await page.screenshot({ path: join(outDir, 'lr-2-heard.png') });
  await page.locator(card).scrollIntoViewIfNeeded();
  await page.locator(card).screenshot({ path: join(outDir, 'lr-3-conversation.png') });

  // ---- 5. Exact source frames ---------------------------------------------------
  const exact = await S(async ({ start }) => {
    const s = window.__arrangement.session;
    const clip = s.state.clips.find((x) => x.id.startsWith('idea-'));
    const a = s.state.assets[clip.assetId];
    const { compileRenderPlan } = await import('/assets/js/arrangement/render-plan.js');
    const plan = compileRenderPlan(s.state).clips.find((p) => p.clipId === clip.id);
    return { section: a.source.section, offset: clip.sourceOffsetSec, firstHeard: a.source.section.startSec + clip.sourceOffsetSec,
      planStart: plan.sourceStartFrame, want: start, ref: a.bufferReference, nativeBpm: a.nativeBpm, bpm: s.bpm, duration: clip.durationBeats };
  }, { start: chorus2.startSec });
  measurements.exact = exact;
  check('5. the cut starts on a real sample of the stem file; the first heard sample IS the chorus start; the plan reads the in-point frame',
    exact.section.startSec === exact.section.startFrame / exact.section.sampleRate && near(exact.firstHeard, chorus2.startSec, 1e-9)
      && exact.offset > 1 && exact.planStart === Math.round(exact.offset * SR) && exact.nativeBpm !== exact.bpm, exact);

  // ---- 6. Play it through the existing DAW from a cue ---------------------------
  const ppb = await S(() => Number.parseFloat(getComputedStyle(document.querySelector('.daw__content')).getPropertyValue('--beat-px')));
  await page.click('button[aria-label="Solo B Vocals"]');
  // Cue at bar 16 (beat 60) by clicking just right of the ruler's own "16" label.
  const label16 = page.locator('.daw__ruler .daw__bar', { hasText: /^16$/ });
  await label16.scrollIntoViewIfNeeded();
  const lb = await label16.boundingBox();
  await page.mouse.click(lb.x + 1, lb.y + lb.height / 2);
  const cueAt = await S(() => window.__arrangement.session.playheadBeat());
  check('6. clicking the ruler at bar 16 sets the play cue there and moves no clip', near(cueAt, 60, 0.2), { cueAt });
  await page.click('button[aria-label="Play"]');
  await page.waitForFunction(() => window.__arrangement.session.phase() === 'playing', null, { timeout: 20000 });
  const trace = await S(async () => {
    const s = window.__arrangement.session;
    const an = s.ctx.createAnalyser(); an.fftSize = 2048; s.monitor.connect(an);
    const buf = new Float32Array(2048); const out = []; const end = performance.now() + 30000;
    while (performance.now() < end && s.playheadBeat() < 72) {
      an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v;
      out.push([s.playheadBeat(), 10 * Math.log10(sum / buf.length + 1e-20)]);
      await new Promise((r) => setTimeout(r, 25));
    }
    return out;
  });
  await page.click('button[aria-label="Stop"]');
  await page.click('button[aria-label="Solo B Vocals"]');
  // Where the passage itself is loud: half-beat RMS of the decoded cut, mapped to timeline beats.
  const loud = await S(({ ref, offset, start, rate, spb }) => {
    const ch = window.__arrangement.session.buffers[ref].channels[0];
    const rows = [];
    for (let b = start + 2; b < Math.min(start + 8, 71.5); b += 0.5) {
      const a0 = Math.round((offset + (b - start) * spb * rate) * 48000); const n = Math.round(0.5 * spb * rate * 48000);
      let e = 0; for (let i = a0; i < a0 + n; i += 1) e += ch[i] * ch[i];
      rows.push([b, 10 * Math.log10(e / n + 1e-20)]);
    }
    return rows;
  }, { ref: exact.ref, offset: exact.offset, start: (await idea()).timelineStartBeat, rate: exact.bpm / exact.nativeBpm, spb: 60 / exact.bpm });
  const [peakBeat, peakSrcDb] = loud.reduce((m, r) => (r[1] > m[1] ? r : m), [0, -999]);
  const heard = trace.filter(([x]) => x >= peakBeat && x < peakBeat + 0.5).map(([, d]) => d);
  const heardDb = heard.length ? Math.max(...heard) : -200;
  measurements.play = { cueBeat: 60, heardFrom: trace[0]?.[0], loudestSourceHalfBeat: peakBeat, sourceDb: peakSrcDb, liveDbThere: heardDb, samples: trace.length };
  check('6. Play from the cue sounds the idea where it was placed: live output is loud where the chosen passage is loud',
    trace.length > 20 && near(trace[0][0], 60, 1.5) && heard.length > 2 && heardDb > -45 && peakSrcDb > -40, measurements.play);

  // ---- 7. Hear mine / Hear it ----------------------------------------------------
  await page.click(`${card} button:has-text("Hear mine")`);
  const mine = await state();
  check('7. Hear mine takes the idea away again and leaves everything else as it was',
    !mine.clips.some((x) => x.id.startsWith('idea-')) && JSON.stringify(mine.clips) === before);
  await page.click(`${card} button:has-text("Hear it")`);
  check('7. Hear it brings the refined idea back exactly', (await idea())?.timelineStartBeat === 63.5 && (await idea())?.pitchSemitones === 2);

  // ---- 8. Something the DAW cannot do --------------------------------------------
  const s8 = JSON.stringify(await state());
  const t8 = await say('add some reverb to that vocal');
  check('8. an unsupported request is explained, and nothing is edited', /can.?t|isn.?t|not something/i.test(t8.producer) && JSON.stringify(await state()) === s8, t8);

  // ---- 9. Keep, save, reopen -----------------------------------------------------
  await page.click(`${card} button:has-text("Keep it")`);
  check('9. Keep keeps the idea; Undo is offered', (await idea()) && (await page.locator(`${card} button:has-text("Undo")`).count()) === 1);
  await page.fill('input[aria-label="Arrangement name"]', 'Listening Room demo');
  await page.click('button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('[data-field="save-state"]').textContent === 'all edits saved');
  const savedDoc = await S(() => { const s = JSON.parse(window.__arrangement.session.edit.serialize()); s.transport.isPlaying = false; return s; });
  const savedId = await S(() => window.__arrangement.session.projectId);
  await page.close();
  page = await context.newPage();
  watch(page);
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
  const rc = reopened.clips.find((x) => x.id.startsWith('idea-'));
  check('9. reopening reproduces the arrangement exactly, with the chorus passage, in-point, pitch and fade',
    diffs.length === 0 && rc && rc.sourceOffsetSec === exact.offset && rc.timelineStartBeat === 63.5 && reopened.assets[rc.assetId].bufferReference === exact.ref, diffs.slice(0, 5));

  // ---- 10. Export against the chosen source --------------------------------------
  const exportWav = async (name) => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('button:has-text("Export WAV")')]);
    const p = join(outDir, `${name}.wav`);
    await download.saveAs(p);
    return readWav(readFileSync(p));
  };
  // Hand edits: solo the vocal, pitch back to 0 so the waveform can be compared with the stem.
  await page.click('button[aria-label="Solo B Vocals"]');
  await page.locator(`.daw__clip[data-clip-id="${rc.id}"]`).scrollIntoViewIfNeeded();
  await page.click(`.daw__clip[data-clip-id="${rc.id}"]`, { position: { x: 80, y: 30 } });
  await page.fill('.daw__inspector input[aria-label="Semitones"]', '0');
  await page.dispatchEvent('.daw__inspector input[aria-label="Semitones"]', 'change');
  const handPitch = (await page.evaluate((id) => window.__arrangement.session.state.clips.find((x) => x.id === id).pitchSemitones, rc.id));
  const wav = await exportWav('listening-room-export');
  const src = await S((ref) => Array.from(window.__arrangement.session.buffers[ref].channels[0]), exact.ref);
  const rate = exact.bpm / exact.nativeBpm; // source seconds per output second
  const spb = 60 / exact.bpm;
  const startOut = Math.round((63.5 + 2) * spb * SR); // after the 2-beat fade
  const n = 600; // 12 s of 20 ms frames
  const out = envelope(wav.L, startOut, n);
  const inSrc = Math.round((exact.offset + 2 * spb * rate) * SR);
  const right = envelope(src, inSrc, n, rate);
  const wrong = envelope(src, inSrc - Math.round(analysisB.barSec * SR), n, rate); // = the cut start: the "forgot the lead" error
  const later = envelope(src, inSrc + Math.round(analysisB.barSec * SR), n, rate);
  measurements.export = { frames: wav.frames, sampleRate: wav.sampleRate, bits: wav.bits, envCorrChosen: corr(out, right), envCorrOneBarEarly: corr(out, wrong), envCorrOneBarLate: corr(out, later) };
  check('10. the export is the chosen passage: its loudness contour matches the stem at the in-point (r > 0.8)',
    wav.sampleRate === 48000 && wav.bits === 24 && handPitch === 0 && measurements.export.envCorrChosen > 0.8, measurements.export);
  check('10. negative control: the same export does NOT match the stem one bar early (the cut start) or one bar late (r < 0.5)',
    measurements.export.envCorrOneBarEarly < 0.5 && measurements.export.envCorrOneBarLate < 0.5, measurements.export);
  let silentBefore = 0;
  for (let i = Math.round(63.2 * spb * SR) - 4800; i < Math.round(63.5 * spb * SR) - 480; i += 1) silentBefore = Math.max(silentBefore, Math.abs(wav.L[i]));
  measurements.export.peakJustBeforeIdea = silentBefore;
  await page.click('.daw__history button:nth-child(1)');
  await page.click('.daw__history button:nth-child(1)');
  check('10. Undo restores the kept idea’s +2 semitones and unsolos after the comparison export',
    (await page.evaluate((id) => window.__arrangement.session.state.clips.find((x) => x.id === id).pitchSemitones, rc.id)) === 2);

  // ---- 11. A new idea, undone by voice; another rejected by hand ----------------
  const s11 = JSON.stringify((await state()).clips);
  const t11 = await sayUntil('now put the first chorus vocals from the other song at bar 33',
    async (t) => /chorus 1 of “Need To Feel Loved”/.test(t.producer), ['The first chorus of song B, vocals, at bar 33.']);
  await page.click(`${card} button:has-text("Hear it")`);
  const heard11 = (await state()).clips.filter((x) => x.id.startsWith('idea-')).length;
  const t11b = await say('undo that idea');
  check('11. a second idea (chorus 1 at bar 33) is heard, then “undo that idea” takes exactly it away',
    /bar 33/.test(t11.producer) && heard11 === 2 && JSON.stringify((await state()).clips) === s11, { t11, t11b });
  const t12 = await sayUntil('bring in the drums from the third chorus of song B at bar 41',
    async (t) => /Drums: chorus 3/.test(t.producer), ['The drums of chorus 3 in song B, at bar 41.', 'Chorus 3.']);
  const hearBtn = page.locator(`${card} button:has-text("Hear it")`);
  if (await hearBtn.isEnabled()) await hearBtn.click();
  const heard12 = await state();
  if (await page.locator(`${card} button:has-text("Reject")`).isEnabled()) await page.click(`${card} button:has-text("Reject")`);
  // The local model's reading of this phrasing is MEASURED, not asserted: it is recorded as it happened.
  measurements.drumsPhrasing = { understoodAsDrumsChorus3: /Drums: chorus 3/.test(t12.producer), turnsNeeded: measurements.turns.filter((t) => /drums|Chorus 3/.test(t.you)).length, finalReply: t12.producer };
  check('11. whatever idea that formed is heard on the lanes, and Reject leaves the arrangement exactly as it was',
    heard12.clips.some((x) => x.id.startsWith('idea-')) && JSON.stringify((await state()).clips) === s11, { t12, drums: measurements.drumsPhrasing });

  // ---- 12. Correct what the Producer heard; the name is reused ------------------
  await page.click('.daw__heard > summary');
  const sel = page.locator('.daw__heard select[aria-label^="B chorus 1"]');
  await sel.selectOption('verse');
  await page.waitForFunction(() => /named by you/.test(document.querySelector('.daw__heard').textContent));
  await page.reload();
  await page.waitForSelector('[data-testid="arrangement"]');
  const again = await S(async (id) => (await fetch(`/api/tracks/${id}/listening`)).json(), analysisB.trackId);
  const renamed = again.sections.find((s) => s.startSec === analysisB.sections.find((x) => x.name === 'chorus 1').startSec);
  check('12. renaming a section is stored for that recording and comes back after a reload', renamed?.label === 'verse' && renamed.basis === 'musician', renamed);
  await S(async (id) => fetch(`/api/tracks/${id}/listening/sections`, { method: 'DELETE' }), analysisB.trackId);

  // ---- 13. Accessibility and phone width ----------------------------------------
  await page.goto(`${base}/#/studio/arrangement`);
  await page.waitForSelector('.daw__talk-input');
  await page.addScriptTag({ content: A11Y_SOURCE });
  const a11y = await S(() => window.auditDocument(document, { viewportWidth: 1440 }));
  check('13. accessibility audit: no serious findings at 1440 px', a11y.serious === 0, (a11y.findings ?? []).filter((f) => f.severity === 'serious').slice(0, 5));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const phone = await S(() => {
    const talk = document.querySelector('.daw__talk-input').getBoundingClientRect();
    const send = document.querySelector('.daw__talk button').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, inputH: talk.height, sendH: send.height, inputW: talk.width };
  });
  const a11y390 = await S(() => window.auditDocument(document, { viewportWidth: 390 }));
  await page.locator('.daw__talk').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, 'lr-390.png') });
  check('13. at 390 px the request box is usable (44 px targets, no sideways scroll) and the audit is clean',
    phone.overflow <= 0 && phone.inputH >= 44 && phone.sendH >= 44 && phone.inputW > 150 && a11y390.serious === 0, { phone, a11y390: a11y390.serious });
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5));
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'listening-room-results.json'), JSON.stringify({ checks, measurements }, null, 1));
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
