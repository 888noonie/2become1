#!/usr/bin/env node
// tests/browser/stem_desk_audio.js — signal-level capture of the Stem Desk.
//
// Renders the real StemDesk runtime in Chromium on an OfflineAudioContext with
// four synthetic mono stems (220/440/660/880 Hz), then measures each stem's
// amplitude in the rendered PCM. This separates "the graph was scheduled" from
// "the graph produced the expected signal": these are captured samples.
//
// It is still not a listening test and makes no claim about speakers.
//
// Usage: node tests/browser/stem_desk_audio.js [--out tests/browser/artifacts]

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'src/twobecomeone/studio_static/js/runtime/stem-desk.js');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(ROOT, 'tests/browser/artifacts');

const source = readFileSync(RUNTIME, 'utf8');

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async (runtimeSource) => {
    const moduleUrl = URL.createObjectURL(new Blob([runtimeSource], { type: 'text/javascript' }));
    const { StemDesk } = await import(moduleUrl);

    const RATE = 44100;
    const SECONDS = 2;
    const FREQS = { vocals: 220, drums: 440, bass: 660, other: 880 };
    const AMP = 0.1;

    function monoWav(freq, seconds, rate) {
      const frames = Math.round(seconds * rate);
      const buffer = new ArrayBuffer(44 + frames * 2);
      const view = new DataView(buffer);
      const write = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      write(0, 'RIFF');
      view.setUint32(4, 36 + frames * 2, true);
      write(8, 'WAVE');
      write(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i += 1) {
        const sample = Math.sin((2 * Math.PI * freq * i) / rate) * AMP;
        view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
      }
      return buffer;
    }

    /** Fourier projection over whole 1 s (every probe frequency has integer cycles). */
    function amplitudeAt(channelData, freq, rate) {
      const start = Math.round(rate * 0.5);
      const count = rate;
      let real = 0;
      let imag = 0;
      for (let i = 0; i < count; i += 1) {
        const angle = (2 * Math.PI * freq * i) / rate;
        real += channelData[start + i] * Math.cos(angle);
        imag += channelData[start + i] * Math.sin(angle);
      }
      return (2 / count) * Math.sqrt(real * real + imag * imag);
    }

    async function render({ gains = {}, muted = [], solo = [], stopImmediately = false }) {
      const ctx = new OfflineAudioContext(1, RATE * SECONDS, RATE);
      const desk = new StemDesk({
        audioContext: ctx,
        fetchImpl: async (url) => {
          const name = new URL(url, 'http://local').searchParams.get('name');
          return { ok: true, status: 200, arrayBuffer: async () => monoWav(FREQS[name], SECONDS, RATE) };
        },
      });
      await desk.load(Object.keys(FREQS).map((name) => ({
        name,
        label: name,
        audioUrl: `/api/stems/set-1/audio?name=${name}`,
        method: 'demucs',
        modelName: 'htdemucs@4.1.0',
        device: 'cpu',
      })));
      for (const [name, db] of Object.entries(gains)) desk.setGain(name, db);
      for (const name of muted) desk.setMuted(name, true);
      for (const name of solo) desk.setSolo(name, true);
      desk.play({ loop: false });
      if (stopImmediately) desk.stop();
      const rendered = await ctx.startRendering();
      const channel = rendered.getChannelData(0);
      const measured = {};
      for (const [name, freq] of Object.entries(FREQS)) {
        measured[name] = amplitudeAt(channel, freq, RATE);
      }
      const peak = channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      desk.dispose();
      return { measured, peak };
    }

    const scenarios = {
      baseline: await render({}),
      mute_drums_and_bass_minus_12: await render({ gains: { bass: -12 }, muted: ['drums'] }),
      solo_vocals: await render({ solo: ['vocals'] }),
      stopped: await render({ stopImmediately: true }),
    };
    return { rate: RATE, seconds: SECONDS, amplitude: AMP, scenarios };
  }, source);

  const tolerance = (value, expected, relative = 0.2) => Math.abs(value - expected) <= expected * relative;
  const cases = [];
  const check = (name, ok, detail) => cases.push({ name, ok, detail });

  const { scenarios, amplitude } = result;
  const silent = 0.005;

  for (const [name, value] of Object.entries(scenarios.baseline.measured)) {
    check(`baseline ${name} is audible`, tolerance(value, amplitude), { measured: value });
  }
  check('muting drums removes only drums',
    scenarios.mute_drums_and_bass_minus_12.measured.drums < silent &&
    tolerance(scenarios.mute_drums_and_bass_minus_12.measured.vocals, amplitude) &&
    tolerance(scenarios.mute_drums_and_bass_minus_12.measured.other, amplitude),
    scenarios.mute_drums_and_bass_minus_12.measured);
  check('bass at -12 dB is one quarter amplitude, others unchanged',
    tolerance(scenarios.mute_drums_and_bass_minus_12.measured.bass, amplitude * Math.pow(10, -12 / 20), 0.25),
    { bass: scenarios.mute_drums_and_bass_minus_12.measured.bass });
  check('solo vocals suppresses the other three',
    tolerance(scenarios.solo_vocals.measured.vocals, amplitude) &&
    scenarios.solo_vocals.measured.drums < silent &&
    scenarios.solo_vocals.measured.bass < silent &&
    scenarios.solo_vocals.measured.other < silent,
    scenarios.solo_vocals.measured);
  check('stop before rendering leaves silence',
    Object.values(scenarios.stopped.measured).every((value) => value < silent),
    scenarios.stopped.measured);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'stem-desk-audio.json'), JSON.stringify({ result, cases }, null, 2));

  const failed = cases.filter((entry) => !entry.ok);
  for (const entry of cases) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
  console.log(`${cases.length - failed.length}/${cases.length} signal-level checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
}
