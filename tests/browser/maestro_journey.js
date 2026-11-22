#!/usr/bin/env node
// OPERATION THE MAESTRO: the autonomous Producer in the real Studio, in Chromium.
//
// Two short synthetic songs are uploaded, stem-imported (no Demucs), and
// analysed by the listening pipeline. The Producer phrases go through the
// page. POST /api/chorus-fit is the server ranker. The language model is not
// required and must not be called for these phrases.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PYTHON = join(ROOT, '.venv/bin/python');
const WEB = join(ROOT, '.venv/bin/twobecomeone');

function port() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const found = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolvePort(found));
    });
  });
}

function measureWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (offset) => buf.subarray(offset, offset + 4).toString('latin1');
  let cursor = 12;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataSize = 0;
  while (cursor + 8 <= buf.length) {
    const id = tag(cursor);
    const size = dv.getUint32(cursor + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(cursor + 10, true);
      rate = dv.getUint32(cursor + 12, true);
      bits = dv.getUint16(cursor + 22, true);
    }
    if (id === 'data') {
      dataOffset = cursor + 8;
      dataSize = size;
      break;
    }
    cursor += 8 + size + (size % 2);
  }
  const frameBytes = channels * (bits / 8);
  const frames = frameBytes > 0 ? Math.floor(dataSize / frameBytes) : 0;
  let energy = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(frames / 4000));
  for (let frame = 0; frame < frames; frame += step) {
    const point = dataOffset + frame * frameBytes;
    let sample = 0;
    if (bits === 16) sample = dv.getInt16(point, true) / 32768;
    else if (bits === 24) {
      let value = buf[point] | (buf[point + 1] << 8) | (buf[point + 2] << 16);
      if (value & 0x800000) value |= ~0xffffff;
      sample = value / 8388608;
    }
    energy += sample * sample;
    count += 1;
  }
  return { channels, rate, bits, seconds: rate ? frames / rate : 0, rms: count ? Math.sqrt(energy / count) : 0 };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runPython(code, args = []) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(PYTHON, ['-c', code, ...args], {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: join(ROOT, 'src') },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => (status === 0 ? resolveRun(out) : reject(new Error(err || out || `python ${status}`))));
  });
}

const WAV_WRITER = `
import sys, wave
from pathlib import Path
import numpy as np
path, kind = sys.argv[1], sys.argv[2]
sr, bpm, bars = 22050, 100.0, 12
bar = 60.0 / bpm * 4
beat = 60.0 / bpm
n = int(round(bars * bar * sr))
t = np.arange(n) / sr
audio = np.zeros(n)
click = np.hanning(max(8, int(0.02 * sr)))
for i in range(bars * 4):
    start = int(i * beat * sr)
    audio[start:start + len(click)] += 0.55 * click
bar_index = np.minimum((t / bar).astype(int), bars - 1)
if kind == "a":
    freqs = [(261.63, 1.0), (329.63, 0.8), (392.00, 0.7)]
    phase = [np.cumsum(2 * np.pi * freq / sr) for freq, _ in freqs]
    tone = sum(amp * np.sin(p) for p, (_, amp) in zip(phase, freqs))
else:
    tone = np.zeros(n)
    first = bar_index < 6
    second = ~first
    for freq, amp in ((261.63, 1.0), (329.63, 0.8), (392.00, 0.7)):
        tone[first] += amp * np.sin(2 * np.pi * freq * t[first])
    for freq, amp in ((261.63, 1.0), (277.18, 0.9), (293.66, 0.8)):
        tone[second] += amp * np.sin(2 * np.pi * freq * t[second])
audio += 0.22 * tone / 3
peak = np.max(np.abs(audio)) or 1
frames = (np.clip(audio / peak, -1, 1) * 32767).astype(np.int16)
with wave.open(path, "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(sr)
    handle.writeframes(frames.tobytes())
print(path)
`;

async function waitFor(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

const work = mkdtempSync(join(tmpdir(), 'maestro-'));
const dataDir = join(work, 'data');
const outDir = join(work, 'out');
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let server;
let browser;
try {
  const songA = join(work, 'song-a.wav');
  const songB = join(work, 'song-b.wav');
  await runPython(WAV_WRITER, [songA, 'a']);
  await runPython(WAV_WRITER, [songB, 'b']);
  const chosen = await port();
  const base = `http://127.0.0.1:${chosen}`;
  server = spawn(WEB, ['web', '--host', '127.0.0.1', '--port', String(chosen), '--data-dir', dataDir], {
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: join(ROOT, 'src') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  await waitFor(async () => {
    const res = await fetch(`${base}/api/health`);
    return res.ok ? res : null;
  }, 'studio health', 30000);

  async function upload(file, name) {
    const body = new FormData();
    const bytes = await import('node:fs').then((fs) => fs.readFileSync(file));
    body.append('file', new Blob([bytes], { type: 'audio/wav' }), name);
    const res = await fetch(`${base}/api/tracks`, { method: 'POST', body });
    if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function stage(file, name) {
    const body = new FormData();
    const bytes = await import('node:fs').then((fs) => fs.readFileSync(file));
    body.append('file', new Blob([bytes], { type: 'audio/wav' }), name);
    const res = await fetch(`${base}/api/stems/stage`, { method: 'POST', body });
    if (!res.ok) throw new Error(`stage ${name}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function attach(trackId, source) {
    const files = [];
    for (const role of ['vocals', 'drums', 'bass', 'other']) {
      const staged = await stage(source, `${role}.wav`);
      files.push({ role, staging_key: staged.staging_key, original_name: `${role}.wav` });
    }
    const res = await fetch(`${base}/api/tracks/${trackId}/stem-import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }),
    });
    if (!res.ok) throw new Error(`stem import: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function listen(trackId) {
    const res = await fetch(`${base}/api/tracks/${trackId}/listening`, { method: 'POST' });
    if (!res.ok) throw new Error(`listening: ${res.status} ${await res.text()}`);
    return res.json();
  }

  const trackA = await upload(songA, 'song-a.wav');
  const trackB = await upload(songB, 'song-b.wav');
  await attach(trackA.id, songA);
  await attach(trackB.id, songB);
  let analysisA = await listen(trackA.id);
  const analysisB = await listen(trackB.id);
  writeFileSync(join(work, 'analysis-a.json'), JSON.stringify(analysisA, null, 2));
  writeFileSync(join(work, 'analysis-b.json'), JSON.stringify(analysisB, null, 2));
  if (!analysisA.sections.some((section) => section.label === 'chorus')) {
    const sections = analysisA.sections.map((section, index) => ({
      startSec: section.startSec, endSec: section.endSec, label: index === 0 ? 'chorus' : section.label,
    }));
    const renamed = await fetch(`${base}/api/tracks/${trackA.id}/listening/sections`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sections }),
    });
    if (!renamed.ok) throw new Error(`rename: ${renamed.status} ${await renamed.text()}`);
    analysisA = await renamed.json();
  }
  const chromaKept = analysisA.sections.some((section) => section.label === 'chorus' && Array.isArray(section.meanChroma));
  check('listening produced section chroma for the chorus', chromaKept, `${analysisA.sections.length} sections in A, ${analysisB.sections.length} in B`);
  check('song B has more than one section to compare', analysisB.sections.length >= 2, analysisB.sections.map((section) => section.label).join(', '));

  browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--disable-audio-output', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const pageErrors = [];
  const apiCalls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) apiCalls.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
  });
  await page.goto(`${base}/#/studio/arrangement`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Bring in stems', { exact: true }).waitFor();
  await page.getByText('Bring in stems', { exact: true }).click();
  async function bring(group, trackId) {
    const before = await page.evaluate(() => window.__arrangement.session.state.clips.length);
    await page.getByLabel(`Track for ${group}`).selectOption(trackId);
    await page.getByLabel(`Section length for ${group}`).selectOption('full');
    await page.locator(`.daw__bring--${group}`).click();
    await waitFor(async () => {
      const count = await page.evaluate(() => window.__arrangement.session.state.clips.length);
      const label = await page.locator(`.daw__bring--${group}`).textContent();
      return count >= before + 4 && label === `Bring in ${group}`;
    }, `bring in ${group}`, 40000);
  }
  await bring('A', trackA.id);
  await bring('B', trackB.id);
  const imported = await page.evaluate(() => window.__arrangement.session.state.clips.length);
  check('both songs are on the eight lanes', imported === 8, `clips ${imported}`);

  async function tell(text) {
    const input = page.getByLabel('Tell the Producer');
    await input.fill(text);
    await input.press('Enter');
    await waitFor(async () => {
      const lines = await page.locator('.daw__talk-log li').allTextContents();
      return lines.at(-1) && lines.at(-1) !== text ? lines.at(-1) : null;
    }, `reply to ${text}`, 20000);
    return page.locator('.daw__talk-log li').last().textContent();
  }
  const clips = () => page.evaluate(() => window.__arrangement.session.state.clips.map((clip) => ({
    id: clip.id,
    trackIndex: clip.trackIndex,
    start: clip.timelineStartBeat,
    offset: clip.sourceOffsetSec,
    pitch: clip.pitchSemitones,
    stretch: clip.stretchMode,
    fade: clip.fadeInBeats,
    asset: clip.assetId,
  })));
  const assets = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__arrangement.session.state.assets).map(([id, asset]) => [id, {
    ref: asset.bufferReference, frame: asset.source?.section?.startFrame ?? null, passage: asset.source?.passage?.startSec ?? null,
  }])));


  // ------------------------------------------------------------ the Maestro
  //
  // The songs are synthetic: every stem of a song is the same tone-and-click
  // mix, so this proves timing, identity, levels and handoffs, not taste.
  const EVIDENCE = process.env.MAESTRO_EVIDENCE || null;
  const evidence = { states: [], takes: [] };
  const nowState = () => page.evaluate(() => {
    const el = document.querySelector('.daw__producer-now');
    return el ? { state: el.dataset.state, text: el.textContent } : null;
  });
  const laneMap = () => page.evaluate(() => {
    const { state } = window.__arrangement.session;
    return state.clips.map((clip) => {
      const asset = state.assets[clip.assetId];
      return {
        id: clip.id, lane: clip.trackIndex, start: Math.round(clip.timelineStartBeat * 1000) / 1000,
        beats: Math.round(clip.durationBeats * 1000) / 1000, fadeIn: clip.fadeInBeats, gainDb: clip.gainDb,
        passage: asset?.source?.passage?.name ?? null, song: asset?.source?.group ?? null, role: asset?.source?.role ?? null,
      };
    });
  });
  const overlaps = (map) => {
    const out = [];
    for (let lane = 0; lane < 8; lane += 1) {
      const rows = map.filter((clip) => clip.lane === lane);
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const lo = Math.max(rows[i].start, rows[j].start);
          const hi = Math.min(rows[i].start + rows[i].beats, rows[j].start + rows[j].beats);
          if (hi - lo > 1e-6) out.push(`${rows[i].id}&${rows[j].id}@lane${lane}:${(hi - lo).toFixed(2)}b`);
        }
      }
    }
    return out;
  };
  // Beats where both songs' vocal lanes are audible (clip present and lane curve above -20 dB).
  const vocalCollisions = () => page.evaluate(async () => {
    const { gainLinearAtBeat } = await import('/assets/js/arrangement/automation.js');
    const { state } = window.__arrangement.session;
    const heard = (lane, beat) => state.clips.some((clip) => clip.trackIndex === lane && beat >= clip.timelineStartBeat && beat < clip.timelineStartBeat + clip.durationBeats)
      && gainLinearAtBeat(state.tracks[lane], beat) > 0.1;
    const end = Math.max(...state.clips.map((clip) => clip.timelineStartBeat + clip.durationBeats));
    let both = 0;
    for (let beat = 0; beat < end; beat += 0.25) if (heard(0, beat) && heard(4, beat)) both += 0.25;
    return { bothVocalBeats: both, endBeat: end, beatSec: 60 / state.transport.masterBpm };
  }).catch((error) => ({ error: error.message }));
  async function settle(label, timeout = 45000) {
    return waitFor(async () => {
      const now = await nowState();
      return now && now.state !== 'creating' && !(await page.locator('.daw__talk-input').isDisabled()) ? now : null;
    }, label, timeout);
  }
  const sampler = setInterval(async () => {
    try { const now = await nowState(); if (now && evidence.states.at(-1) !== now.state) evidence.states.push(now.state); } catch { /* page busy */ }
  }, 40);

  await page.getByRole('button', { name: 'Jam together' }).click();
  check('the Producer says it is waiting for direction', (await nowState())?.state === 'jam', (await nowState())?.text);
  await page.getByRole('button', { name: 'Take the decks' }).click();
  const take1 = await settle('first take');
  const reply1 = await page.locator('.daw__talk-log li').last().textContent();
  const map1 = await laneMap();
  evidence.takes.push({ name: 'take 1', reply: reply1, clips: map1.filter((clip) => clip.id.startsWith('idea-')) });
  check('a complete autonomous take lands and says so', /finished|playing/.test(take1.state) && /did not audition the audio/.test(reply1), `${take1.state}: ${take1.text}`);
  check('the take uses both songs', map1.some((clip) => clip.id.startsWith('idea-') && clip.song === 'B') && map1.some((clip) => clip.lane < 4), JSON.stringify(evidence.takes[0].clips));
  check('the direction buttons appear while the Producer holds the decks', await page.locator('.daw__direct').isVisible());
  if (EVIDENCE) await page.locator('.daw__producer-card').screenshot({ path: `${EVIDENCE}/1-take-playing.png` }).catch(() => {});
  check('Previous vocal waits until there is a previous vocal', await page.getByRole('button', { name: 'Previous vocal' }).isDisabled());

  await page.getByRole('button', { name: 'Keep it' }).click();
  const keptVocal = (await laneMap()).find((clip) => clip.lane === 4 && clip.id.startsWith('idea-'));
  await page.getByRole('button', { name: 'Try another' }).click();
  await settle('second take');
  const reply2 = await page.locator('.daw__talk-log li').last().textContent();
  const map2 = await laneMap();
  evidence.takes.push({ name: 'try another', reply: reply2, clips: map2.filter((clip) => clip.id.startsWith('idea-')) });
  const keptNow = map2.find((clip) => clip.id === keptVocal.id);
  check('Try another writes a different structure', reply2 !== reply1 && /Instruments lead|drums drop|drums take/.test(reply2), reply2.slice(0, 120));
  check('the kept vocal stays exactly where it was', keptNow && keptNow.start === keptVocal.start && keptNow.beats === keptVocal.beats, JSON.stringify({ keptVocal, keptNow }));
  check('nothing new plays on top of the kept vocal', overlaps(map2).length === 0, overlaps(map2).join(', ') || 'no same-lane overlap');
  if (EVIDENCE) await page.locator('.daw__producer-card').screenshot({ path: `${EVIDENCE}/2-try-another-kept.png` }).catch(() => {});
  check('the reply and the card say the kept vocal is in this take', /Your kept B Vocals/.test(reply2) && /Kept from earlier: B Vocals/.test(await page.locator('.daw__now-kept').textContent()), reply2.match(/Your kept[^.]*\./)?.[0] ?? '');
  const keptHeard = await page.evaluate(async (clip) => {
    const { gainLinearAtBeat } = await import('/assets/js/arrangement/automation.js');
    return gainLinearAtBeat(window.__arrangement.session.state.tracks[4], clip.start + clip.beats / 2);
  }, keptVocal).catch((error) => error.message);
  check('the kept vocal is still audible on its lane', typeof keptHeard === 'number' && keptHeard > 0.1, `lane gain at its middle ${keptHeard}`);

  const newVocal = () => laneMap().then((map) => map.filter((clip) => clip.lane === 4 && clip.id.startsWith('idea-') && clip.id !== keptVocal.id).at(-1));
  const before = await newVocal();
  await page.getByRole('button', { name: 'More energy' }).click();
  await settle('more energy');
  const reply3 = await page.locator('.daw__talk-log li').last().textContent();
  const after = await newVocal();
  check('More energy brings the new vocal in sooner and says what it did', after && before && after.start < before.start && /comes in sooner|Your kept clip holds that lane, so my vocal comes in at/.test(reply3), `${before?.start} -> ${after?.start}: ${reply3.match(/(The vocal comes in sooner|Your kept clip holds)[^.]*\./)?.[0] ?? reply3.slice(0, 120)}`);
  const fadeBefore = (await newVocal()).fadeIn;
  const tookWords = await tell('let it breathe');
  check('loose words direct the take without the model', /I took “breathe” as a gentler entrance, from the words alone; no model was used/.test(tookWords) && (await newVocal()).fadeIn > fadeBefore && !apiCalls.some((line) => line.startsWith('POST /api/producer/creative')), `${fadeBefore} -> ${(await newVocal()).fadeIn} beats: ${tookWords.slice(-110)}`);

  // Interrupt: ask for another structure and take over while it is creating.
  const steps = await page.evaluate(() => document.querySelector('.daw__producer-now').textContent);
  check('the Producer still has a revision left before the interrupt', !/revised this 4 times/.test(steps) && await page.getByRole('button', { name: 'Try another' }).isEnabled(), steps);
  const beforeInterrupt = JSON.stringify(await laneMap());
  await page.getByRole('button', { name: 'Try another' }).click();
  const creating = await waitFor(async () => ((await nowState())?.state === 'creating' ? 'creating' : null), 'creating', 5000).catch(() => 'not seen');
  await page.getByRole('button', { name: 'Take over' }).click();
  await settle('interrupt');
  await sleep(1500);
  const afterInterrupt = await laneMap();
  const log2 = await page.locator('.daw__talk-log li').allTextContents();
  const interruptReply = log2.at(-1);
  check('Take over while it is creating stops the Producer before it writes', creating === 'creating' && (await nowState()).state === 'yours'
    && /I have stopped|decks are yours/.test(interruptReply) && JSON.stringify(afterInterrupt) === beforeInterrupt,
  `${creating} → ${(await nowState()).state}; lanes unchanged: ${JSON.stringify(afterInterrupt) === beforeInterrupt}; ${log2.slice(-3).join(' | ').slice(0, 300)}`);
  evidence.interrupt = { sawCreating: creating, landed: JSON.stringify(afterInterrupt) !== beforeInterrupt, replies: log2.slice(-3) };
  check('the Producer is not playing after Take over', !(await page.evaluate(() => window.__arrangement.session.isPlaying())));
  if (EVIDENCE) await page.locator('.daw__producer-card').screenshot({ path: `${EVIDENCE}/3-taken-over.png` }).catch(() => {});

  // A musician's own adjustment, then Take back.
  await page.evaluate(() => window.__arrangement.session.apply({ name: 'setTrackVolume', args: { trackIndex: 2, volumeDb: -5 } }));
  await sleep(700);
  check('a hand edit hides Restore previous arrangement', await page.getByRole('button', { name: 'Restore previous arrangement' }).isHidden());
  const takeBack = await tell('Take back');
  const afterBack = await page.evaluate(() => window.__arrangement.session.state.tracks[2].volumeDb);
  check('Take back returns control and keeps the musician edit', /decks are yours/.test(takeBack) && afterBack === -5, `${takeBack} (A Bass ${afterBack} dB)`);
  const kept4 = await laneMap();

  // Save, reload, reopen.
  await page.getByLabel('Arrangement name').fill('Maestro take');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-live], .daw__messages')].some((el) => el.textContent.includes('Saved')), null, { timeout: 30000 })
    .catch(async (error) => {
      const said = await page.evaluate(() => [...document.querySelectorAll('[aria-live], .daw__messages, [role="alert"]')].map((el) => el.textContent.trim()).filter(Boolean).join(' | '));
      throw new Error(`save: ${error.message}\n${said.slice(0, 900)}`);
    });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Saved arrangements').waitFor();
  await page.getByLabel('Saved arrangements').focus();
  await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Saved arrangements"] option')].some((option) => option.textContent.includes('Maestro take')));
  const saved = await page.evaluate(() => [...document.querySelectorAll('select[aria-label="Saved arrangements"] option')].find((option) => option.textContent.includes('Maestro take'))?.value);
  await page.getByLabel('Saved arrangements').selectOption(saved);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await waitFor(async () => (await laneMap()).some((clip) => clip.id.startsWith('idea-')), 'reopened take', 30000);
  const reopened = await laneMap();
  const same = JSON.stringify(reopened.map(({ id, lane, start, beats, fadeIn, gainDb, passage }) => ({ id, lane, start, beats, fadeIn, gainDb, passage })))
    === JSON.stringify(kept4.map(({ id, lane, start, beats, fadeIn, gainDb, passage }) => ({ id, lane, start, beats, fadeIn, gainDb, passage })));
  check('the reopened arrangement has the same clips, timing, gains and passages', same, `${reopened.length} clips`);
  check('the reopened arrangement keeps the hand edit', (await page.evaluate(() => window.__arrangement.session.state.tracks[2].volumeDb)) === -5);
  check('the reopened arrangement has no same-lane overlap', overlaps(reopened).length === 0, overlaps(reopened).join(', '));
  evidence.vocals = await vocalCollisions();
  evidence.chosen = reopened.filter((clip) => clip.id.startsWith('idea-'));

  // Export the arrangement on the lanes.
  const exported = page.waitForEvent('download', { timeout: 90000 });
  await page.getByRole('button', { name: 'Export WAV' }).click();
  const file = await exported;
  const { mkdirSync, readFileSync, writeFileSync: write } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const exportPath = join(outDir, file.suggestedFilename());
  await file.saveAs(exportPath);
  const wav = readFileSync(exportPath);
  const pcm = decodeWav(wav);
  const exportStats = levelStats(pcm.mono, pcm.rate);
  evidence.export = { ...exportStats, rate: pcm.rate, bits: pcm.bits, channels: pcm.channels };
  check('the export is a WAV of the arrangement length', pcm.rate > 0 && Math.abs(pcm.seconds - evidence.vocals.endBeat * evidence.vocals.beatSec) < 2.5, `${pcm.seconds.toFixed(2)} s vs ${(evidence.vocals.endBeat * evidence.vocals.beatSec).toFixed(2)} s on the lanes, ${pcm.bits}-bit ${pcm.rate} Hz`);
  check('the export peak is below full scale', exportStats.peakDb < -0.1, `peak ${exportStats.peakDb.toFixed(2)} dBFS, ${exportStats.clipped} samples at or above 0.999`);
  check('the export has no unintended silence', exportStats.silentRuns.length === 0, `${exportStats.silentRuns.length} runs of 250 ms below -60 dBFS: ${JSON.stringify(exportStats.silentRuns.slice(0, 4))}`);

  // Live capture of the same arrangement from the session's monitor bus.
  const live = await page.evaluate(async (seconds) => {
    const session = window.__arrangement.session;
    session.stop();
    session.edit.setPlayhead(0);
    const ok = await session.play();
    if (!ok) return { error: 'play did not start' };
    session.stop();
    const ctx = session.ctx;
    await ctx.audioWorklet.addModule('/assets/js/arrangement/capture-worklet.js');
    const tap = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    session.monitor.connect(tap);
    tap.connect(sink);
    sink.connect(ctx.destination);
    const chunks = [];
    let recording = false;
    tap.port.onmessage = (event) => { if (recording) chunks.push(event.data.l); };
    session.edit.setPlayhead(0);
    recording = true;
    const started = ctx.currentTime;
    await session.play();
    await new Promise((resolve) => setTimeout(resolve, (seconds + 1.5) * 1000));
    session.stop();
    recording = false;
    tap.port.onmessage = null;
    session.monitor.disconnect(tap);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const mono = new Float32Array(total);
    let at = 0;
    for (const chunk of chunks) { mono.set(chunk, at); at += chunk.length; }
    // 1 ms mean-square frames: small to transfer, fine enough to align.
    const hop = Math.round(ctx.sampleRate / 1000);
    const env = [];
    let peak = 0;
    for (let i = 0; i + hop <= mono.length; i += hop) {
      let e = 0;
      for (let j = i; j < i + hop; j += 1) { e += mono[j] * mono[j]; peak = Math.max(peak, Math.abs(mono[j])); }
      env.push(e / hop);
    }
    return { rate: ctx.sampleRate, env, peak, seconds: mono.length / ctx.sampleRate, monitorDb: session.monitorDb, wall: ctx.currentTime - started };
  }, pcm.seconds);
  if (live.error) check('live capture', false, live.error);
  else {
    const exportEnv = energyMs(pcm.mono, pcm.rate);
    const gain2 = 10 ** (-(live.monitorDb ?? 0) / 10);
    const match = alignEnvelopes(exportEnv, live.env.map((value) => value * gain2));
    evidence.live = { seconds: live.seconds, peakDb: 20 * Math.log10(live.peak || 1e-12), monitorDb: live.monitorDb, ...match };
    check('the live take and the export have the same level shape', match.correlation > 0.95, `50 ms envelope correlation ${match.correlation.toFixed(4)} at lag ${match.lagMs} ms over ${match.windows} windows; level difference median ${match.medianDb.toFixed(2)} dB, 5–95% ${match.p05Db.toFixed(2)}…${match.p95Db.toFixed(2)} dB`);
    check('the live take and the export have the same loudness', Math.abs(match.medianDb) < 1.0, `${match.medianDb.toFixed(2)} dB`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const narrow = await page.evaluate(() => {
    const root = document.querySelector('.daw');
    const card = document.querySelector('.daw__producer-card');
    return { overflow: root ? root.scrollWidth - root.clientWidth : null, card: card?.getBoundingClientRect().width ?? 0 };
  });
  check('the Producer card fits a phone', narrow.overflow !== null && narrow.overflow <= 1, JSON.stringify(narrow));
  if (EVIDENCE) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.daw__producer-card').screenshot({ path: `${EVIDENCE}/producer-card-1280.png` }).catch(() => {});
  }
  clearInterval(sampler);
  check('the card showed creating, then finished or playing, then yours', evidence.states.includes('creating') && evidence.states.some((s) => s === 'finished' || s === 'playing') && evidence.states.includes('yours'), evidence.states.join(' → '));
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
  if (EVIDENCE) write(`${EVIDENCE}/maestro-evidence.json`, JSON.stringify({ ...evidence, apiCalls: apiCalls.filter((line) => /producer|chorus-fit/.test(line)) }, null, 2));
  if (!server.killed && log.includes('Traceback')) check('server stayed up', false, log.slice(-500));
} catch (error) {
  check('journey completed', false, error.stack || error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
  console.log('cleaned temporary songs and data directory');
}

function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let cursor = 12;
  let channels = 0; let rate = 0; let bits = 0; let format = 1; let data = 0; let size = 0;
  while (cursor + 8 <= buf.length) {
    const id = buf.subarray(cursor, cursor + 4).toString('latin1');
    const len = dv.getUint32(cursor + 4, true);
    if (id === 'fmt ') { format = dv.getUint16(cursor + 8, true); channels = dv.getUint16(cursor + 10, true); rate = dv.getUint32(cursor + 12, true); bits = dv.getUint16(cursor + 22, true); }
    if (id === 'data') { data = cursor + 8; size = len; break; }
    cursor += 8 + len + (len % 2);
  }
  const width = bits / 8;
  const frames = Math.floor(size / (width * channels));
  const mono = new Float32Array(frames);
  const read = (at) => {
    if (format === 3 && bits === 32) return dv.getFloat32(at, true);
    if (bits === 16) return dv.getInt16(at, true) / 32768;
    if (bits === 24) { let v = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16); if (v & 0x800000) v |= ~0xffffff; return v / 8388608; }
    if (bits === 32) return dv.getInt32(at, true) / 2147483648;
    return 0;
  };
  for (let f = 0; f < frames; f += 1) {
    let peak = 0;
    for (let c = 0; c < channels; c += 1) { const v = read(data + (f * channels + c) * width); if (Math.abs(v) > Math.abs(peak)) peak = v; }
    mono[f] = peak; // the louder channel, so a one-sided peak is not averaged away
  }
  return { mono, rate, bits, channels, seconds: rate ? frames / rate : 0 };
}

function envelope(mono, rate) {
  const hop = Math.round(rate / 100);
  const out = [];
  for (let i = 0; i + hop <= mono.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + hop; j += 1) e += mono[j] * mono[j];
    out.push(Math.sqrt(e / hop));
  }
  return out;
}

function levelStats(mono, rate) {
  let peak = 0; let clipped = 0; let energy = 0;
  for (const v of mono) { const a = Math.abs(v); if (a > peak) peak = a; if (a >= 0.999) clipped += 1; energy += v * v; }
  const env = envelope(mono, rate);
  const silentRuns = [];
  let run = 0;
  const floor = 10 ** (-60 / 20);
  // The last half second is the release tail and is not counted.
  for (let i = 0; i < env.length - 50; i += 1) {
    if (env[i] < floor) run += 1;
    else { if (run >= 25) silentRuns.push({ fromSec: (i - run) / 100, seconds: run / 100 }); run = 0; }
  }
  return { peakDb: 20 * Math.log10(peak || 1e-12), rmsDb: 20 * Math.log10(Math.sqrt(energy / Math.max(1, mono.length)) || 1e-12), clipped, silentRuns, seconds: mono.length / rate };
}

function energyMs(mono, rate) {
  const hop = Math.round(rate / 1000);
  const out = [];
  for (let i = 0; i + hop <= mono.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + hop; j += 1) e += mono[j] * mono[j];
    out.push(e / hop);
  }
  return out;
}

/** 1 ms energy frames in, 50 ms RMS windows compared, lag searched at 1 ms over 0–600 ms. */
function alignEnvelopes(a, b, windowMs = 50) {
  const windows = (frames, lag, count) => {
    const out = new Float64Array(count);
    for (let w = 0; w < count; w += 1) {
      let e = 0;
      for (let k = 0; k < windowMs; k += 1) e += frames[lag + w * windowMs + k] ?? 0;
      out[w] = Math.sqrt(e / windowMs);
    }
    return out;
  };
  const corr = (x, y) => {
    let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
    const n = x.length;
    for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i]; }
    const den = Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
    return den > 0 ? (sxy - (sx * sy) / n) / den : 0;
  };
  let best = { lag: 0, correlation: -1 };
  for (let lag = 0; lag <= 600; lag += 1) {
    const count = Math.floor(Math.min(a.length, b.length - lag) / windowMs);
    if (count < 20) break;
    const r = corr(windows(a, 0, count), windows(b, lag, count));
    if (r > best.correlation) best = { lag, correlation: r, count };
  }
  const x = windows(a, 0, best.count);
  const y = windows(b, best.lag, best.count);
  const diffs = [];
  for (let i = 0; i < x.length; i += 1) if (x[i] > 1e-3 && y[i] > 1e-3) diffs.push(20 * Math.log10(y[i] / x[i]));
  diffs.sort((p, q) => p - q);
  const pct = (q) => (diffs.length ? diffs[Math.min(diffs.length - 1, Math.floor(q * diffs.length))] : NaN);
  return { correlation: best.correlation, lagMs: best.lag, medianDb: pct(0.5), p05Db: pct(0.05), p95Db: pct(0.95), windows: best.count, windowMs };
}

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
