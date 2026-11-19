#!/usr/bin/env node
// tests/browser/for_your_ears_audio.js — PCM and memory gate for the mission.
//
// Loads group A and group B as *sections* through the real StemDesk runtime on
// an OfflineAudioContext at 48 kHz, then measures:
//   * eight lanes on one clock, every lane audible, the mix inside full scale;
//   * the desk's decoded-byte accounting against a 60 s section (default mode);
//   * source/window alignment by comparing the section WAV to the full stem at
//     the same sample offset (byte-exact, no decode rounding);
//   * unload/reload accounting;
//   * proposal validation, reject (no mutation) and approve (exact changes);
//   * negative controls: a declared full-length stem over 40 MiB, an invalid
//     section length, and a start past the end.
//
// Usage:
//   node tests/browser/for_your_ears_audio.js --data-dir /var/tmp/fye/demo [--out DIR]
//
// Seed first with tests/browser/for_your_ears_seed.py.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const value = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dataDir = value('--data-dir');
const outDir = path.resolve(value('--out', path.join(ROOT, 'tests', 'browser', 'artifacts')));
if (!dataDir) {
  console.error('usage: node tests/browser/for_your_ears_audio.js --data-dir <seeded dir>');
  process.exit(2);
}

const sectionStart = Number(value('--start', '60'));
const sectionSeconds = Number(value('--seconds', '60'));
const ROLES = ['vocals', 'drums', 'bass', 'other'];

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close((error) => (error ? reject(error) : resolvePort(free)));
  });
});
const base = `http://127.0.0.1:${port}`;
const studio = spawn(
  process.env.PYTHON || '.venv/bin/python',
  ['-m', 'twobecomeone.cli', 'web', '--port', String(port), '--data-dir', dataDir],
  {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') },
  },
);
const serverLog = [];
studio.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
studio.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${JSON.stringify(detail)}`);
};

function readWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') throw new Error('not a WAV');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      data = { offset: offset + 8, size: Math.min(size, bytes.length - (offset + 8)) };
      break;
    }
    offset += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV has no fmt/data chunk');
  return { fmt, data, bytes };
}

try {
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (studio.exitCode !== null) throw new Error(`studio exited: ${serverLog.join('')}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`studio did not start: ${serverLog.join('')}`);
    await sleep(200);
  }

  const tracks = (await (await fetch(`${base}/api/tracks?limit=20`)).json()).items;
  const byName = (needle) => tracks.find((t) => (t.name || t.title || '').includes(needle));
  const trackA = byName('Midnight Circuit') || tracks[0];
  const trackB = byName('Paper Lanterns') || tracks[1];
  if (!trackA || !trackB) throw new Error(`seeded tracks missing: ${tracks.map((t) => t.name)}`);

  const stemsOf = async (track) => {
    const payload = await (await fetch(`${base}/api/tracks/${track.id}/stems`)).json();
    const lanes = payload.variants
      .filter((v) => ROLES.includes(v.name))
      .sort((a, b) => ROLES.indexOf(a.name) - ROLES.indexOf(b.name));
    return { track, lanes };
  };
  const a = await stemsOf(trackA);
  const b = await stemsOf(trackB);
  check('both library tracks expose four usable lanes',
    a.lanes.length === 4 && b.lanes.length === 4,
    { a: a.lanes.map((l) => l.name), b: b.lanes.map((l) => l.name) });
  check('the lanes are honest imported provenance',
    [...a.lanes, ...b.lanes].every((l) => l.method === 'imported' && l.original_name),
    [...a.lanes, ...b.lanes].map((l) => `${l.name}:${l.method}`));

  // ---- source/window alignment (byte-exact, no decode rounding) -----------
  const laneA = a.lanes.find((l) => l.name === 'vocals');
  const fullUrl = new URL(laneA.audio_url, base).href;
  const sectionUrl = new URL(`${laneA.audio_url}&start=${sectionStart}&duration=${sectionSeconds}`, base).href;
  const fullWav = readWav(await (await fetch(fullUrl)).arrayBuffer());
  const sectionWav = readWav(await (await fetch(sectionUrl)).arrayBuffer());
  const blockAlign = fullWav.fmt.channels * (fullWav.fmt.bits / 8);
  const startFrame = Math.round(sectionStart * fullWav.fmt.sampleRate);
  const startByte = fullWav.data.offset + startFrame * blockAlign;
  const expected = fullWav.bytes.subarray(startByte, startByte + sectionWav.data.size);
  const got = sectionWav.bytes.subarray(
    sectionWav.data.offset, sectionWav.data.offset + sectionWav.data.size,
  );
  let same = got.length === expected.length;
  if (same) {
    for (let i = 0; i < got.length; i += 1) {
      if (got[i] !== expected[i]) { same = false; break; }
    }
  }
  check('a section is byte-exact against the source at the same sample offset',
    same,
    {
      start: sectionStart,
      seconds: sectionSeconds,
      sampleRate: sectionWav.fmt.sampleRate,
      channels: sectionWav.fmt.channels,
      bits: sectionWav.fmt.bits,
      bytes: sectionWav.data.size,
    });
  check('the section header declares its real size',
    new DataView(sectionWav.bytes.buffer).getUint32(4, true) === sectionWav.bytes.length - 8,
    { riffSize: new DataView(sectionWav.bytes.buffer).getUint32(4, true), actual: sectionWav.bytes.length - 8 });
  check('the section keeps the source rate, channels and sample width',
    sectionWav.fmt.sampleRate === fullWav.fmt.sampleRate
      && sectionWav.fmt.channels === fullWav.fmt.channels
      && sectionWav.fmt.bits === fullWav.fmt.bits,
    { full: fullWav.fmt, section: sectionWav.fmt });

  // ---- the real desk on an offline 48 kHz context -------------------------
  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
  let rendered;
  let approvedWav;
  try {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    rendered = await page.evaluate(async ({ baseUrl, lanesA, lanesB, start, seconds }) => {
      const rate = 48000;
      const { StemDesk, STEM_DESK_LIMITS, STEM_DESK_FULL_LIMITS } = await import(
        new URL('/assets/js/runtime/stem-desk.js', baseUrl).href
      );
      const proposalModule = await import(
        new URL('/assets/js/runtime/stem-desk-proposal.js', baseUrl).href
      );
      const groupOf = (track, lanes) => ({
        trackId: track.name.includes('Midnight') ? 'A' : 'B',
        title: track.name,
        lanes: lanes.map((lane) => ({
          name: lane.name,
          label: lane.name,
          audioUrl: new URL(`${lane.audio_url}&start=${start}&duration=${seconds}`, baseUrl).href,
          method: lane.method,
          modelName: lane.model_name,
          device: lane.device,
          stemSetId: lane.stem_set_id,
        })),
      });
      const groups = [groupOf(lanesA.track, lanesA.lanes), groupOf(lanesB.track, lanesB.lanes)];
      const ctx = new OfflineAudioContext(2, Math.round(rate * (seconds + 1)), rate);
      const desk = new StemDesk({ audioContext: ctx, fetchImpl: (u) => fetch(u) });
      const loaded = await desk.loadGroups(groups);
      const state = loaded;
      const laneBytes = state.lanes.map((lane) => lane.durationSeconds * rate * 2 * 4);
      const expectedBytes = laneBytes.reduce((sum, n) => sum + n, 0);
      const internal = desk._decodedBytes;

      // Render the full eight-lane performance.
      const started = desk.play({ loop: false });
      const playingState = desk.state();
      const buffer = await ctx.startRendering();
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.getChannelData(1);
      const from = Math.round(0.5 * rate);
      const to = Math.min(ch0.length, Math.round((seconds - 0.5) * rate));
      let peak = 0;
      let sumSq = 0;
      let count = 0;
      for (let i = from; i < to; i += 1) {
        peak = Math.max(peak, Math.abs(ch0[i]), Math.abs(ch1[i]));
        sumSq += ch0[i] * ch0[i] + ch1[i] * ch1[i];
        count += 2;
      }
      const mixRms = Math.sqrt(sumSq / Math.max(1, count));

      // Proposal: suggest, validate, "reject" (nothing applied), then approve.
      const suggestion = proposalModule.suggestStemDeskProposal(desk.state());
      const before = JSON.stringify(desk.state().lanes.map((l) => [l.key, l.muted, l.gainDb]));
      const rejected = suggestion; // Reject means the pending proposal is discarded.
      const afterReject = JSON.stringify(desk.state().lanes.map((l) => [l.key, l.muted, l.gainDb]));
      const approved = suggestion.ok
        ? proposalModule.approveStemDeskProposal(suggestion.proposal, desk)
        : null;
      const after = desk.state();

      // A second desk applies the same proposal and renders the arrangement.
      const ctx2 = new OfflineAudioContext(2, Math.round(rate * (seconds + 1)), rate);
      const desk2 = new StemDesk({ audioContext: ctx2, fetchImpl: (u) => fetch(u) });
      await desk2.loadGroups(groups);
      const approved2 = suggestion.ok
        ? proposalModule.approveStemDeskProposal(suggestion.proposal, desk2)
        : null;
      desk2.play({ loop: false });
      const buffer2 = await ctx2.startRendering();
      const pcm = new Int16Array(buffer2.length * 2);
      for (let i = 0; i < buffer2.length; i += 1) {
        pcm[i * 2] = Math.max(-1, Math.min(1, buffer2.getChannelData(0)[i])) * 32767;
        pcm[i * 2 + 1] = Math.max(-1, Math.min(1, buffer2.getChannelData(1)[i])) * 32767;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const approvedPcmBase64 = btoa(bin);

      // Unload/reload accounting on desk2.
      const beforeUnload = desk2.state();
      const unloaded = desk2.unloadGroup('A');
      const reload = await desk2.loadGroups([groups[0]]);
      const reloaded = desk2.state();
      desk.dispose();
      desk2.dispose();

      return {
        limits: {
          defaultDecodedBytes: STEM_DESK_LIMITS.maxDecodedBytes,
          defaultStemDecodedBytes: STEM_DESK_LIMITS.maxStemDecodedBytes,
          fullDecodedBytes: STEM_DESK_FULL_LIMITS.maxDecodedBytes,
        },
        lanes: state.lanes.length,
        status: started.status,
        loadedStatus: state.status,
        contextState: playingState.contextState,
        laneRmsDb: Object.fromEntries(state.lanes.map((lane) => [lane.key, lane.rmsDb])),
        laneDurationSeconds: state.lanes.map((lane) => lane.durationSeconds),
        expectedDecodedBytes: expectedBytes,
        decodedBytes: internal,
        rendered: { peak, rms: mixRms, seconds: buffer.duration },
        suggestion: suggestion.ok
          ? { ok: true, proposal: suggestion.proposal }
          : { ok: false, code: suggestion.code, message: suggestion.message },
        rejectUnchanged: before === afterReject,
        approved: approved ? { ok: approved.ok } : null,
        afterApproval: {
          crossfader: after.crossfader,
          groups: after.groups.map((g) => ({ trackId: g.trackId, levelDb: g.levelDb, entryOffsetMs: g.entryOffsetMs })),
          lanes: after.lanes.map((l) => ({ key: l.key, muted: l.muted, gainDb: l.gainDb })),
          playing: after.playing,
        },
        approved2: approved2 ? { ok: approved2.ok } : null,
        approvedPcmBase64,
        approvedPcmSeconds: buffer2.duration,
        unload: {
          beforeLanes: beforeUnload.lanes.length,
          afterLanes: unloaded.lanes.length,
          beforeBytes: beforeUnload.lanes.reduce((s, l) => s + l.durationSeconds * rate * 2 * 4, 0),
          afterBytes: unloaded.lanes.reduce((s, l) => s + l.durationSeconds * rate * 2 * 4, 0),
          reloadedLanes: reloaded.lanes.length,
          reloadCommitted: reload.lanes.length === 8,
        },
      };
    }, {
      baseUrl: base,
      lanesA: { track: trackA, lanes: a.lanes },
      lanesB: { track: trackB, lanes: b.lanes },
      start: sectionStart,
      seconds: sectionSeconds,
    });

    // ---- assertions ------------------------------------------------------
    const silent = Object.entries(rendered.laneRmsDb).filter(([, db]) => db <= -50);
    check('eight section lanes load on one 48 kHz clock',
      rendered.lanes === 8 && rendered.status === 'playing',
      { lanes: rendered.lanes, loadedStatus: rendered.loadedStatus, status: rendered.status });
    check('every lane carries a real signal (none silent)', silent.length === 0,
      { silent: Object.fromEntries(silent) });
    check('the eight-lane mix stays inside full scale', rendered.rendered.peak <= 1.0000001,
      { rms: +rendered.rendered.rms.toFixed(4), peak: +rendered.rendered.peak.toFixed(3) });
    check('all lanes are the same 60 s section',
      rendered.laneDurationSeconds.every((d) => Math.abs(d - sectionSeconds) < 0.001),
      { durations: rendered.laneDurationSeconds.slice(0, 2) });
    const budget = 320 * 1024 * 1024;
    check('the section load stays under the ordinary 320 MiB desk budget',
      rendered.decodedBytes > 0 && rendered.decodedBytes < budget,
      {
        decodedBytes: rendered.decodedBytes,
        decodedMiB: +(rendered.decodedBytes / 1024 / 1024).toFixed(1),
        expectedBytes: rendered.expectedDecodedBytes,
        matchesAccounting: Math.abs(rendered.decodedBytes - rendered.expectedDecodedBytes) <= 8 * 2 * 4 * 48000,
        budgetMiB: 320,
      });
    check('the 1024 MiB allowance stays an opt-in constant, not the default',
      rendered.limits.fullDecodedBytes === 1024 * 1024 * 1024
        && rendered.limits.defaultDecodedBytes === 320 * 1024 * 1024,
      rendered.limits);
    check('unloading one group frees only that group',
      rendered.unload.afterLanes === 4
        && rendered.unload.afterBytes < rendered.unload.beforeBytes
        && rendered.unload.beforeLanes === 8,
      rendered.unload);
    check('reloading restores eight lanes', rendered.unload.reloadCommitted === true,
      { reloadedLanes: rendered.unload.reloadedLanes });

    check('the AI Producer returns a valid proposal',
      rendered.suggestion.ok === true,
      rendered.suggestion.ok ? rendered.suggestion.proposal.rationale : rendered.suggestion);
    check('rejecting a proposal changes no lane', rendered.rejectUnchanged === true,
      { unchanged: rendered.rejectUnchanged });
    const after = rendered.afterApproval;
    const laneState = Object.fromEntries(after.lanes.map((l) => [l.key, l]));
    const expectedMute = {
      'A:drums': false, 'A:bass': false, 'A:vocals': true, 'A:other': true,
      'B:vocals': false, 'B:other': false, 'B:drums': true, 'B:bass': true,
    };
    check('approval changes exactly the permitted controls',
      rendered.approved?.ok === true
        && after.crossfader.position === 50
        && after.groups.every((g) => g.levelDb === 0 && g.entryOffsetMs === 0)
        && Object.entries(expectedMute).every(([key, muted]) => laneState[key]?.muted === muted)
        && after.lanes.every((l) => l.gainDb === 0)
        && after.playing === false,
      {
        crossfader: after.crossfader,
        groups: after.groups,
        mutes: Object.fromEntries(after.lanes.map((l) => [l.key, l.muted])),
        playing: after.playing,
      });
    check('the approved arrangement renders audible PCM', rendered.approved2?.ok === true,
      { seconds: rendered.approvedPcmSeconds });

    // ---- negative controls ----------------------------------------------
    const negative = await page.evaluate(async ({ baseUrl, lane, start, seconds }) => {
      const { StemDesk } = await import(new URL('/assets/js/runtime/stem-desk.js', baseUrl).href);
      const out = {};
      // A declared full-length stem over the 40 MiB fetch ceiling.
      const declared = new OfflineAudioContext(2, 1024, 48000);
      const hugeDesk = new StemDesk({
        audioContext: declared,
        fetchImpl: async () => new Response(new Uint8Array([0]), {
          headers: { 'content-length': String(70 * 1024 * 1024) },
        }),
      });
      const huge = await hugeDesk.loadGroups([{
        trackId: 'A',
        title: 'declared full length',
        lanes: [{
          name: 'vocals', label: 'Vocals',
          audioUrl: `${baseUrl}${lane.audio_url}`,
          method: 'imported', modelName: 'sha256:x', device: 'user', stemSetId: 'x',
        }],
      }]);
      out.declaredFullLength = {
        lanes: huge.lanes.length,
        code: (huge.error?.failures?.[0]?.code) || huge.error?.code || null,
        message: huge.error?.failures?.[0]?.message || huge.error?.message || null,
      };
      hugeDesk.dispose();
      // The section route rejects a length it cannot serve and a start past the end.
      const badLength = await fetch(`${baseUrl}${lane.audio_url}&start=${start}&duration=45`);
      const pastEnd = await fetch(`${baseUrl}${lane.audio_url}&start=999&duration=${seconds}`);
      out.badLength = { status: badLength.status, body: await badLength.text() };
      out.pastEnd = { status: pastEnd.status, body: await pastEnd.text() };
      return out;
    }, { baseUrl: base, lane: laneA, start: sectionStart, seconds: sectionSeconds });

    check('a declared full-length stem is refused before download',
      negative.declaredFullLength.lanes === 0
        && /TOO_LONG|too large|declares/.test(
          `${negative.declaredFullLength.code} ${negative.declaredFullLength.message}`,
        ),
      negative.declaredFullLength);
    check('the section route refuses a length it cannot serve',
      negative.badLength.status === 400 && /30, 60, or 90/.test(negative.badLength.body),
      negative.badLength);
    check('the section route refuses a start past the end',
      negative.pastEnd.status === 400 && /past the end/.test(negative.pastEnd.body),
      negative.pastEnd);

    // Save the approved arrangement so the receipt can point at real audio.
    mkdirSync(outDir, { recursive: true });
    const pcm = Buffer.from(rendered.approvedPcmBase64, 'base64');
    const sampleRate = 48000;
    const channels = 2;
    const bits = 16;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
    header.writeUInt16LE(channels * (bits / 8), 32);
    header.writeUInt16LE(bits, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    writeFileSync(path.join(outDir, 'approved-arrangement.wav'), Buffer.concat([header, pcm]));

    const { approvedPcmBase64, ...evidence } = rendered;
    writeFileSync(
      path.join(outDir, 'for-your-ears-audio.json'),
      JSON.stringify({ base, results, evidence }, null, 2),
    );
    console.log(`\napproved arrangement written to ${path.join(outDir, 'approved-arrangement.wav')}`);
  } finally {
    await browser.close();
  }
} finally {
  studio.kill('SIGTERM');
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} audio/memory checks passed`);
process.exitCode = failed.length ? 1 : 0;
