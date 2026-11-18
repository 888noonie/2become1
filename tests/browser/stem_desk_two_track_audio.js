#!/usr/bin/env node
// tests/browser/stem_desk_two_track_audio.js — signal-level capture of the
// two-track Stem Desk.
//
// Renders the real StemDesk runtime in Chromium on an OfflineAudioContext with
// two groups of synthetic stems, then measures the rendered PCM. It proves the
// A/B crossfader energies, the no-wrap end state, and that eight lanes do not
// clip. This is captured sample evidence, not a listening test.
//
// Usage: node tests/browser/stem_desk_two_track_audio.js [--out DIR]

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'src/twobecomeone/studio_static/js/runtime/stem-desk.js');
const CROSSFADER = path.join(ROOT, 'src/twobecomeone/studio_static/js/runtime/crossfader.js');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(ROOT, 'tests/browser/artifacts');

const source = readFileSync(RUNTIME, 'utf8');
const crossfaderSource = readFileSync(CROSSFADER, 'utf8');

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async ({ runtimeSource, crossfaderSource }) => {
    const crossfaderUrl = URL.createObjectURL(new Blob([crossfaderSource], { type: 'text/javascript' }));
    const patched = runtimeSource.replace('./crossfader.js', crossfaderUrl);
    const moduleUrl = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
    const { StemDesk } = await import(moduleUrl);

    const RATE = 44100;
    const FREQS = {
      A: { vocals: 200, drums: 300, bass: 400, other: 500 },
      B: { vocals: 700, drums: 800, bass: 900, other: 1000 },
    };
    const AMP = 0.05;

    function monoWav(freq, seconds, rate, amplitude = AMP) {
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
        const sample = Math.sin((2 * Math.PI * freq * i) / rate) * amplitude;
        view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
      }
      return buffer;
    }

    /** Fourier projection over a whole 0.5 s window (all probes have integer cycles). */
    function amplitudeAt(channelData, freq, rate, startSeconds = 0.2) {
      const start = Math.round(rate * startSeconds);
      const count = Math.round(rate * 0.5);
      let real = 0;
      let imag = 0;
      for (let i = 0; i < count; i += 1) {
        const angle = (2 * Math.PI * freq * i) / rate;
        real += channelData[start + i] * Math.cos(angle);
        imag += channelData[start + i] * Math.sin(angle);
      }
      return (2 / count) * Math.sqrt(real * real + imag * imag);
    }

    function peakOf(channelData, from = 0, to = channelData.length) {
      let peak = 0;
      for (let i = from; i < to; i += 1) {
        const absolute = Math.abs(channelData[i]);
        if (absolute > peak) peak = absolute;
      }
      return peak;
    }

    const lanesFor = (groupId) => Object.entries(FREQS[groupId]).map(([name, freq]) => ({
      lane: {
        name,
        label: name,
        audioUrl: `/stems/${groupId}/${name}.wav`,
        method: 'synthetic',
        modelName: 'probe-tone',
        device: 'offline',
      },
      freq,
    }));

    async function render({ crossfader = 50, stemSeconds = 1, renderSeconds = 1.6, offset = 0, levels = {}, amplitude = AMP } = {}) {
      const ctx = new OfflineAudioContext(1, Math.round(RATE * renderSeconds), RATE);
      const freqByUrl = new Map();
      for (const groupId of ['A', 'B']) {
        for (const entry of lanesFor(groupId)) freqByUrl.set(entry.lane.audioUrl, entry.freq);
      }
      const monoFor = (freq) => monoWav(freq, stemSeconds, RATE, amplitude);
      const desk = new StemDesk({
        audioContext: ctx,
        fetchImpl: async (url) => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => monoFor(freqByUrl.get(url)),
        }),
      });
      const loaded = await desk.loadGroups(['A', 'B'].map((groupId) => ({
        trackId: groupId,
        title: `Set ${groupId}`,
        lanes: lanesFor(groupId).map((entry) => entry.lane),
      })));
      if (loaded.status !== 'ready' || loaded.lanes.length !== 8) {
        throw new Error(`load failed: ${JSON.stringify(loaded.error ?? loaded.status)}`);
      }
      desk.setCrossfader(crossfader);
      for (const [trackId, db] of Object.entries(levels)) desk.setTrackLevel(trackId, db);
      const started = desk.play({ loop: false, offset });
      const rendered = await ctx.startRendering();
      const channel = rendered.getChannelData(0);
      const measured = { A: {}, B: {} };
      for (const groupId of ['A', 'B']) {
        for (const [name, freq] of Object.entries(FREQS[groupId])) {
          measured[groupId][name] = amplitudeAt(channel, freq, RATE);
        }
      }
      const endState = desk.state();
      desk.dispose();
      return {
        measured,
        peak: peakOf(channel),
        tailPeak: peakOf(channel, Math.round(RATE * 0.75)),
        started: {
          status: started.status,
          loop: started.loop,
          lanes: started.lanes.length,
          groups: started.groups.length,
        },
        end: {
          status: endState.status,
          playing: endState.playing,
          positionSeconds: endState.positionSeconds,
          loop: endState.loop,
        },
      };
    }

    const scenarios = {
      crossfade_left: await render({ crossfader: 0 }),
      crossfade_middle: await render({ crossfader: 50 }),
      crossfade_right: await render({ crossfader: 100 }),
      end_of_programme: await render({ crossfader: 50, stemSeconds: 0.6, renderSeconds: 1 }),
      // A track level must move only its own track's PCM.
      level_b_minus_12: await render({ crossfader: 50, levels: { B: -12 } }),
      // Worst allowed case: loud lanes, both tracks at +6 dB, both groups open.
      hot_boosted: await render({
        crossfader: 50, levels: { A: 6, B: 6 }, amplitude: 0.9, stemSeconds: 1.2, renderSeconds: 1.4,
      }),
    };
    return { rate: RATE, amplitude: AMP, scenarios };
  }, { runtimeSource: source, crossfaderSource });

  const tolerance = (value, expected, relative = 0.2) => Math.abs(value - expected) <= expected * relative;
  const cases = [];
  const check = (name, ok, detail) => cases.push({ name, ok, detail });

  const { scenarios, amplitude } = result;
  const silent = 0.005;
  const groups = (scenario, groupId) => Object.values(scenario.measured[groupId]);

  check('two groups start together with loop off',
    scenarios.crossfade_middle.started.status === 'playing' &&
    scenarios.crossfade_middle.started.loop === false &&
    scenarios.crossfade_middle.started.lanes === 8 &&
    scenarios.crossfade_middle.started.groups === 2,
    scenarios.crossfade_middle.started);

  check('crossfader 0 leaves only group A audible',
    groups(scenarios.crossfade_left, 'A').every((value) => tolerance(value, amplitude)) &&
    groups(scenarios.crossfade_left, 'B').every((value) => value < silent),
    scenarios.crossfade_left.measured);

  check('crossfader 100 leaves only group B audible',
    groups(scenarios.crossfade_right, 'B').every((value) => tolerance(value, amplitude)) &&
    groups(scenarios.crossfade_right, 'A').every((value) => value < silent),
    scenarios.crossfade_right.measured);

  check('crossfader 50 gives both groups equal-power level',
    groups(scenarios.crossfade_middle, 'A').every((value) => tolerance(value, amplitude * Math.SQRT1_2, 0.25)) &&
    groups(scenarios.crossfade_middle, 'B').every((value) => tolerance(value, amplitude * Math.SQRT1_2, 0.25)),
    scenarios.crossfade_middle.measured);

  const levelB = scenarios.level_b_minus_12;
  const baseB = groups(scenarios.crossfade_middle, 'B');
  const cutB = groups(levelB, 'B');
  const baseA = groups(scenarios.crossfade_middle, 'A');
  const cutA = groups(levelB, 'A');
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const bRatio = mean(cutB) / mean(baseB);
  const aRatio = mean(cutA) / mean(baseA);
  check('a track level attenuates only that track',
    Math.abs(bRatio - 0.2512) < 0.05 && Math.abs(aRatio - 1) < 0.02,
    { bRatio: +bRatio.toFixed(4), aRatio: +aRatio.toFixed(4), expectedBRatio: 0.2512 });

  check('the loudest allowed gain combination is limited below full scale',
    scenarios.hot_boosted.peak <= 1 && scenarios.hot_boosted.peak > 0.5,
    { peak: +scenarios.hot_boosted.peak.toFixed(4), levels: '+6 dB lane, +6 dB track, hot source' });

  check('eight lanes at the crossfader midpoint do not clip',
    scenarios.crossfade_middle.peak < 1,
    { peak: scenarios.crossfade_middle.peak });

  check('the programme ends in silence and the desk returns to ready',
    scenarios.end_of_programme.tailPeak < 1e-4 &&
    scenarios.end_of_programme.end.status === 'ready' &&
    scenarios.end_of_programme.end.playing === false,
    {
      tailPeak: scenarios.end_of_programme.tailPeak,
      end: scenarios.end_of_programme.end,
    });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'stem-desk-two-track-audio.json'), JSON.stringify({ result, cases }, null, 2));
  for (const entry of cases) {
    const detail = entry.detail === undefined ? '' : ` — ${JSON.stringify(entry.detail)}`;
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${detail}`);
  }
  const failed = cases.filter((entry) => !entry.ok);
  console.log(`${cases.length - failed.length}/${cases.length} two-track signal-level checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
}
