#!/usr/bin/env node
// tests/browser/stem_desk_entry_offset.js — rendered onset proof for the
// manual group entry nudge.
//
// Group B's click sits 8820 samples (200 ms at 44.1 kHz) later than group A's.
// A negative entry offset pulls B back to A's onset. A positive offset pushes
// B further late. Playback rate stays 1. Mute, crossfade, stop and a failed
// stem are measured on the same rendered PCM, not on UI state.

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
    const CLICK = 8820;
    const BURST = 180;
    const AMP = 0.2;
    const NAMES = ['vocals', 'drums', 'bass', 'other'];

    function wav(clickAt) {
      const frames = RATE;
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
      view.setUint32(24, RATE, true);
      view.setUint32(28, RATE * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, frames * 2, true);
      if (clickAt >= 0) {
        for (let i = 0; i < BURST; i += 1) {
          view.setInt16(44 + (clickAt + i) * 2, Math.round(AMP * 32767), true);
        }
      }
      return buffer;
    }

    function onsetOf(channel, threshold = 0.02) {
      for (let i = 0; i < channel.length; i += 1) {
        if (Math.abs(channel[i]) > threshold) return i;
      }
      return -1;
    }

    function peakOf(channel) {
      let peak = 0;
      for (let i = 0; i < channel.length; i += 1) {
        const absolute = Math.abs(channel[i]);
        if (absolute > peak) peak = absolute;
      }
      return peak;
    }

    function clicksFor(groupClick) {
      const clicks = {};
      for (const name of NAMES) {
        clicks[`/A/${name}.wav`] = name === 'drums' ? 0 : -1;
        clicks[`/B/${name}.wav`] = name === 'drums' ? groupClick.B : -1;
        if (groupClick.all) {
          clicks[`/A/${name}.wav`] = groupClick.A;
          clicks[`/B/${name}.wav`] = groupClick.B;
        }
      }
      return clicks;
    }

    async function render(spec) {
      const renderSeconds = spec.renderSeconds || 0.7;
      const ctx = new OfflineAudioContext(1, Math.round(RATE * renderSeconds), RATE);
      const startedSources = [];
      const stoppedSources = [];
      const original = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = () => {
        const source = original();
        const stop = source.stop.bind(source);
        source.stop = (...args) => {
          stoppedSources.push(source);
          return stop(...args);
        };
        const start = source.start.bind(source);
        source.start = (...args) => {
          startedSources.push(source);
          return start(...args);
        };
        return source;
      };
      const clicks = spec.clicks;
      const desk = new StemDesk({
        audioContext: ctx,
        fetchImpl: async (url) => {
          if (spec.failUrl && url === spec.failUrl) {
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
          }
          return { ok: true, status: 200, arrayBuffer: async () => wav(clicks[url] ?? -1) };
        },
      });
      const loaded = await desk.loadGroups(['A', 'B'].map((trackId) => ({
        trackId,
        title: trackId,
        lanes: NAMES.map((name) => ({
          name,
          label: name,
          audioUrl: `/${trackId}/${name}.wav`,
          method: 'synthetic',
          modelName: 'onset-click',
          device: 'offline',
        })),
      })));
      for (const [trackId, ms] of Object.entries(spec.offsets || {})) {
        desk.setGroupEntryOffset(trackId, ms);
      }
      if (spec.crossfader != null) desk.setCrossfader(spec.crossfader);
      if (spec.mute) desk.setMuted(spec.mute, true);
      if (spec.solo) desk.setSolo(spec.solo, true);
      const before = startedSources.length;
      if (spec.restart) {
        desk.play({ loop: false });
        desk.stop();
        for (const [trackId, ms] of Object.entries(spec.restart)) {
          desk.setGroupEntryOffset(trackId, ms);
        }
      }
      const started = desk.play({ loop: false });
      const rates = desk._lanes
        .filter((lane) => lane.source)
        .map((lane) => lane.source.playbackRate.value);
      if (spec.cancel) desk.stop();
      const rendered = await ctx.startRendering();
      const channel = rendered.getChannelData(0);
      desk.dispose();
      const afterDisposeSources = desk._sources.length;
      const pcm = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, channel[i]));
        pcm[i] = Math.round(clamped * 32767);
      }
      return {
        onset: onsetOf(channel),
        peak: peakOf(channel),
        rates,
        status: loaded.status,
        error: loaded.error?.code || null,
        lanes: loaded.lanes.length,
        startedStatus: started.status,
        startedNow: startedSources.length - before,
        stopped: stoppedSources.length,
        startedTotal: startedSources.length,
        sourcesAfterDispose: afterDisposeSources,
        beatMatched: started.sync.beatMatched,
        // Keep the click neighbourhood so the report can show the rendered hit.
        window: Array.from(pcm.slice(Math.max(0, onsetOf(channel) - 2), Math.max(0, onsetOf(channel) - 2) + 8)),
        pcm: spec.keepPcm ? Array.from(pcm) : null,
      };
    }

    const drums = { A: 0, B: CLICK };
    const aligned = { A: 0, B: 0, all: true };
    const scenarios = {
      a_only: await render({ clicks: clicksFor(drums), crossfader: 0 }),
      b_late: await render({ clicks: clicksFor(drums), crossfader: 100, keepPcm: true }),
      b_corrected: await render({
        clicks: clicksFor(drums), crossfader: 100, offsets: { B: -200 }, keepPcm: true,
      }),
      b_pushed_later: await render({
        clicks: clicksFor(drums), crossfader: 100, offsets: { B: 200 },
      }),
      crossfade_a_while_offset: await render({
        clicks: clicksFor({ A: 0, B: 0 }), crossfader: 0, offsets: { B: 200 },
      }),
      crossfade_b_while_offset: await render({
        clicks: clicksFor({ A: 0, B: 0 }), crossfader: 100, offsets: { B: 200 },
      }),
      muted_click: await render({
        clicks: clicksFor(drums), crossfader: 100, offsets: { B: -200 }, mute: 'B:drums',
      }),
      solo_a_vocals: await render({
        clicks: clicksFor(aligned), crossfader: 50, solo: 'A:vocals',
      }),
      cancelled: await render({ clicks: clicksFor(drums), crossfader: 50, cancel: true }),
      restarted: await render({
        clicks: clicksFor(drums), crossfader: 100, restart: { B: -200 },
      }),
      failed_stem: await render({
        clicks: clicksFor(drums), crossfader: 0, failUrl: '/A/other.wav',
      }),
    };

    const internal = {};
    for (const name of NAMES) {
      const only = {};
      for (const stem of NAMES) {
        only[`/A/${stem}.wav`] = -1;
        only[`/B/${stem}.wav`] = stem === name ? CLICK : -1;
      }
      internal[name] = await render({
        clicks: only, crossfader: 100, offsets: { B: -200 },
      });
    }

    return { rate: RATE, click: CLICK, scenarios, internal };
  }, { runtimeSource: source, crossfaderSource });

  mkdirSync(OUT, { recursive: true });
  function writeWav(name, samples) {
    const frames = samples.length;
    const buffer = Buffer.alloc(44 + frames * 2);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + frames * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(result.rate, 24);
    buffer.writeUInt32LE(result.rate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(samples[i], 44 + i * 2);
    writeFileSync(path.join(OUT, name), buffer);
  }
  writeWav('b-late.wav', result.scenarios.b_late.pcm);
  writeWav('b-corrected.wav', result.scenarios.b_corrected.pcm);

  const near = (value, expected, slack) => Math.abs(value - expected) <= slack;
  const cases = [];
  const check = (name, ok, detail) => cases.push({ name, ok, detail });
  const aOnset = result.scenarios.a_only.onset;
  const late = result.scenarios.b_late.onset;
  const corrected = result.scenarios.b_corrected.onset;
  const pushed = result.scenarios.b_pushed_later.onset;

  check('group A click lands on the shared play lead',
    near(aOnset, Math.round(0.05 * result.rate), 2),
    { onset: aOnset });
  check('unmodified group B is late by the known click displacement',
    near(late - aOnset, result.click, 2),
    { late, aOnset, delta: late - aOnset });
  check('a -200 ms entry pulls group B onto group A',
    near(corrected, aOnset, 2) && corrected < late,
    { corrected, aOnset, late });
  check('a +200 ms entry pushes group B later, the other direction',
    pushed > late && near(pushed - late, result.click, 2),
    { pushed, late, delta: pushed - late });
  check('the four stems of the nudged group share one onset',
    Object.values(result.internal).every((entry) => near(entry.onset, corrected, 2)),
    Object.fromEntries(Object.entries(result.internal).map(([name, entry]) => [name, entry.onset])));
  check('playback rate stays 1 on every started source',
    [result.scenarios.b_late, result.scenarios.b_corrected, result.scenarios.b_pushed_later]
      .every((entry) => entry.rates.length === 8 && entry.rates.every((rate) => rate === 1)),
    { corrected: result.scenarios.b_corrected.rates });
  check('rendered peaks stay inside full scale',
    Object.values(result.scenarios).every((entry) => entry.peak <= 1)
      && Object.values(result.internal).every((entry) => entry.peak <= 1),
    Object.fromEntries(Object.entries(result.scenarios).map(([name, entry]) => [name, entry.peak])));
  check('crossfade toward A hides the delayed group B click',
    near(result.scenarios.crossfade_a_while_offset.onset, aOnset, 2)
      && result.scenarios.crossfade_b_while_offset.onset > aOnset + result.click - 2,
    {
      a: result.scenarios.crossfade_a_while_offset.onset,
      b: result.scenarios.crossfade_b_while_offset.onset,
    });
  check('muting the clicking stem leaves silence',
    result.scenarios.muted_click.onset === -1 && result.scenarios.muted_click.peak < 0.01,
    result.scenarios.muted_click);
  check('solo keeps only the chosen stem and the desk does not claim beat matching',
    near(result.scenarios.solo_a_vocals.onset, aOnset, 2)
      && result.scenarios.solo_a_vocals.beatMatched === false
      && result.scenarios.solo_a_vocals.peak < 0.35,
    result.scenarios.solo_a_vocals);
  check('stop before render cancels the scheduled clicks',
    result.scenarios.cancelled.onset === -1 && result.scenarios.cancelled.peak < 0.01,
    result.scenarios.cancelled);
  check('stop then play uses the new offset',
    near(result.scenarios.restarted.onset, corrected, 2),
    { restarted: result.scenarios.restarted.onset, corrected });
  check('a failed stem stays partial and dispose stops every source',
    result.scenarios.failed_stem.error === 'S_STEM_PARTIAL'
      && result.scenarios.failed_stem.lanes === 7
      && result.scenarios.failed_stem.sourcesAfterDispose === 0
      && result.scenarios.failed_stem.stopped >= result.scenarios.failed_stem.startedTotal
      && near(result.scenarios.failed_stem.onset, aOnset, 2),
    result.scenarios.failed_stem);

  const report = {
    rate: result.rate,
    clickSamples: result.click,
    measured: {
      aOnset,
      bLate: late,
      bCorrected: corrected,
      bPushedLater: pushed,
      correctionSamples: late - corrected,
      internalOnsets: Object.fromEntries(
        Object.entries(result.internal).map(([name, entry]) => [name, entry.onset]),
      ),
    },
    cases,
  };
  writeFileSync(path.join(OUT, 'entry-offset-report.json'), JSON.stringify(report, null, 2));
  const failed = cases.filter((entry) => !entry.ok);
  for (const entry of cases) {
    console.log(`${entry.ok ? 'ok' : 'FAIL'}  ${entry.name}`);
    if (!entry.ok) console.log(JSON.stringify(entry.detail, null, 2));
  }
  if (failed.length) {
    console.error(`${failed.length} entry-offset checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`entry offset corrected ${late - corrected} samples (${((late - corrected) / result.rate * 1000).toFixed(2)} ms)`);
  }
} finally {
  await browser.close();
}
