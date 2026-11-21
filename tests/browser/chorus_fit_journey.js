#!/usr/bin/env node
// Chorus Fit on the real Studio, in Chromium, against a temporary data directory.
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

const work = mkdtempSync(join(tmpdir(), 'chorus-fit-'));
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

  await page.getByRole('button', { name: 'You play' }).click();
  const explained = await tell('Which part of B fits this chorus?');
  const afterExplain = await clips();
  check('You play explains without writing', afterExplain.length === 8 && /You play is on/.test(explained), explained.slice(0, 180));
  check('the fit did not ask the language model', !apiCalls.some((line) => line.startsWith('POST /api/producer/converse')));
  check('the fit called the ranker', apiCalls.some((line) => line.startsWith('POST /api/chorus-fit') && line.endsWith(' 200')));

  await page.getByRole('button', { name: 'Jam together' }).click();
  const offered = await tell('Try the strongest match');
  check('Jam offers the ranked passage before Hear it', /Press Hear it/.test(offered) && (await clips()).length === 8, offered.slice(0, 180));
  await page.getByRole('button', { name: 'Hear it' }).click();
  let heard = await clips();
  const idea = heard.find((clip) => clip.id.startsWith('idea-'));
  check('Hear it places the passage on the timeline', Boolean(idea), JSON.stringify(idea));
  if (idea) {
    check('the placed clip keeps zero pitch and a finite source offset', idea.pitch === 0 && Number.isFinite(idea.offset), JSON.stringify(idea));
  }
  if (analysisB.sections.length >= 2) {
    const beforeRef = (await assets())[idea?.asset]?.ref;
    const next = await tell('Try the next best match instead');
    const nextIdea = (await clips()).find((clip) => clip.id.startsWith('idea-'));
    const afterRef = (await assets())[nextIdea?.asset]?.ref;
    check('the next candidate keeps the chorus and changes the source', nextIdea && /song A/.test(next) && beforeRef !== afterRef, next.slice(0, 180));
  }
  await page.getByRole('button', { name: 'Hear mine' }).click();
  check('Hear mine restores the lanes', (await clips()).every((clip) => !clip.id.startsWith('idea-')));
  await page.getByRole('button', { name: 'Hear it' }).click();
  await page.getByRole('button', { name: 'Keep it' }).click();
  const kept = (await clips()).filter((clip) => clip.id.startsWith('idea-'));
  check('Keep leaves the passage in the arrangement', kept.length === 1);

  await page.getByLabel('Arrangement name').fill('Chorus fit audition');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-live], .daw__messages')].some((el) => el.textContent.includes('Saved')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Saved arrangements').waitFor();
  await page.getByLabel('Saved arrangements').focus();
  await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Saved arrangements"] option')].some((option) => option.textContent.includes('Chorus fit audition')));
  const savedValue = await page.evaluate(() => [...document.querySelectorAll('select[aria-label="Saved arrangements"] option')].find((option) => option.textContent.includes('Chorus fit audition'))?.value);
  await page.getByLabel('Saved arrangements').selectOption(savedValue);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await waitFor(async () => (await clips()).some((clip) => clip.id.startsWith('idea-')), 'reopened idea', 30000);
  check('save and reopen keeps the passage', (await clips()).some((clip) => clip.id.startsWith('idea-')));

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Export WAV' }).click();
  const download = await downloadPromise;
  const wavPath = join(outDir, download.suggestedFilename());
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  await download.saveAs(wavPath);
  const wav = await import('node:fs').then((fs) => fs.readFileSync(wavPath));
  const measured = measureWav(wav);
  check('export writes a WAV', wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE', `${wav.length} bytes`);
  check('export duration follows the 12-bar songs', measured.seconds > 20 && measured.seconds < 40, `${measured.seconds.toFixed(2)} s, ${measured.bits}-bit, ${measured.channels} ch, ${measured.rate} Hz`);
  check('export is not silent', measured.rms > 0.01, `rms ${measured.rms.toFixed(4)}`);

  await page.getByRole('button', { name: 'Take the decks' }).click();
  let lastLine = '';
  let took;
  try {
    took = await waitFor(async () => {
      lastLine = await page.locator('.daw__talk-log li').last().textContent() ?? '';
      return /on the lanes|playing|Take back/.test(lastLine) ? lastLine : null;
    }, 'take the decks', 45000);
  } catch (error) {
    const log = await page.locator('.daw__talk-log li').allTextContents();
    throw new Error(`${error.message}\nlast=${lastLine.slice(0, 400)}\nlog=${log.slice(-4).join(' | ').slice(0, 800)}`);
  }
  check('Take the decks writes from the ranker without a separate Hear it', /on the lanes|playing/.test(took), took.slice(0, 180));
  check('the Producer says this was not an audition', /did not audition the audio/.test(took), took.slice(0, 220));
  const shape = await page.evaluate(() => {
    const ideas = window.__arrangement.session.state.clips.filter((item) => item.id.startsWith('idea-'));
    return { tracks: ideas.map((item) => item.trackIndex), count: ideas.length };
  });
  check('Take the decks places B vocals and a later B drums handoff', shape.tracks.includes(4) && shape.tracks.includes(5), JSON.stringify(shape));
  const vocalStart = () => page.evaluate(() => {
    const ideas = window.__arrangement.session.state.clips.filter((item) => item.trackIndex === 4 && String(item.id).startsWith('idea-'));
    ideas.sort((a, b) => Number(b.id.slice(5)) - Number(a.id.slice(5)));
    return ideas[0]?.timelineStartBeat ?? null;
  });
  const firstStart = await vocalStart();
  await tell('Try something completely different');
  const secondStart = await vocalStart();
  await tell('Try something completely different');
  const thirdStart = await vocalStart();
  const starts = [firstStart, secondStart, thirdStart];
  check('three arrangements do not share one entrance', new Set(starts.filter((value) => value != null)).size >= 3, JSON.stringify(starts));
  await page.getByLabel('Arrangement name').fill('Autonomous take');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-live], .daw__messages')].some((el) => el.textContent.includes('Saved')));
  const autonomousDownload = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Export WAV' }).click();
  const autonomousFile = await autonomousDownload;
  const autonomousPath = join(outDir, `autonomous-${autonomousFile.suggestedFilename()}`);
  await autonomousFile.saveAs(autonomousPath);
  const autonomousWav = await import('node:fs').then((fs) => fs.readFileSync(autonomousPath));
  const autonomous = measureWav(autonomousWav);
  check('the autonomous take exports as WAV', autonomousWav.subarray(0, 4).toString() === 'RIFF' && autonomousWav.subarray(8, 12).toString() === 'WAVE', `${autonomousWav.length} bytes`);
  check('the autonomous export is not silent', autonomous.rms > 0.01, `rms ${autonomous.rms.toFixed(4)}, ${autonomous.seconds.toFixed(2)} s`);
  const sources = await page.evaluate(() => window.__arrangement.session.state.clips.filter((item) => String(item.id).startsWith('idea-')).map((item) => ({
    id: item.id, track: item.trackIndex, start: item.timelineStartBeat, offset: item.sourceOffsetSec,
  })));
  check('the exported project still has the autonomous passages', sources.length >= 2 && sources.some((item) => item.track === 4), JSON.stringify(sources));
  const moved = await page.evaluate(() => {
    const clip = window.__arrangement.session.state.clips.find((item) => item.id.startsWith('idea-'));
    if (!clip) return null;
    window.__arrangement.session.apply({ name: 'moveClip', args: { clipId: clip.id, newTrackIndex: clip.trackIndex, newStartBeat: clip.timelineStartBeat + 4 } });
    return clip.id;
  });
  const refused = await tell('Take back');
  const afterHand = (await clips()).find((clip) => clip.id === moved);
  check('a hand move makes Take back leave that edit alone', Boolean(moved) && /will not take that away/.test(refused) && afterHand && afterHand.start > 0, refused.slice(0, 160));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Take the decks' }).waitFor();
  const layout = await page.evaluate(() => {
    const root = document.querySelector('.daw');
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Take the decks');
    const box = button?.getBoundingClientRect();
    return {
      overflow: root ? root.scrollWidth - root.clientWidth : null,
      buttonWidth: box?.width ?? 0,
      buttonHeight: box?.height ?? 0,
    };
  });
  check('Take the decks is visible at 390x844', layout.buttonWidth >= 44 && layout.buttonHeight >= 24, JSON.stringify(layout));
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
  if (!server.killed && log.includes('Traceback')) check('server stayed up', false, log.slice(-500));
} catch (error) {
  check('journey completed', false, error.stack || error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
  console.log('cleaned temporary songs and data directory');
}

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
