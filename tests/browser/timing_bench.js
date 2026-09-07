// tests/browser/timing_bench.js — Class B: browser scheduling-event benchmark.
//
// Handover item 1, evidence class B (audit B rewrite). This script imports the
// REAL production modules into the page — transport/derive.js,
// transport/normalize.js, actions/errors.js AND runtime/ghost-scheduler.js —
// and runs the production GhostScheduler against real Web Audio nodes.
//
// Clock provenance (audit B/D): OfflineAudioContext.currentTime is 0 until
// rendering starts, so scenarios needing deterministic timing run on an
// INJECTED CONTROLLED CLOCK (explicitly labeled; the context's nodes/decode
// are real, the clock value is manually advanced). One additional observation
// runs on a REAL AudioContext device clock. Neither is claimed to be the
// other; neither establishes audible timing (class C exists for that).
//
// PASS requires assertions to hold, not just absence of exceptions: each
// scenario has independent, hand-computed expectations (beat, launch time,
// start count, receipt parity) written on the Node side, deliberately NOT
// derived from the same resolveNextPhrase helper production uses. A built-in
// self-test feeds a deliberately wrong expectation and fails if the
// comparator does not catch it.
//
// Usage:
//   node tests/browser/timing_bench.js
// Output:
//   tests/browser/artifacts/timing_bench/receipts.json
//   (consumed by tests/test_listening_benchmark.py only after provenance
//   validation; stale/malformed/failed captures must not be relabeled current)

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');

function readModule(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

// Strip ES module syntax so the page can eval modules as plain scripts.
// Dependency wiring is explicit: the harness provides derive's exports under
// window.__derive, and ghost-scheduler's single import (resolveNextPhrase) is
// satisfied from that same scope — production policy is NOT re-implemented.
function toPlainScript(source) {
  return source
    .replace(/^import .*$/gm, '')
    .replace(/^export function /gm, 'function ')
    .replace(/^export const /gm, 'const ')
    .replace(/^export class /gm, 'class ')
    .replace(/^export \{.*\};?$/gm, '');
}

const harness = [
  'src/twobecomeone/studio_static/js/actions/errors.js',
  'src/twobecomeone/studio_static/js/transport/normalize.js',
  'src/twobecomeone/studio_static/js/transport/derive.js',
].map((p) => toPlainScript(readModule(p))).join('\n')
  + '\nwindow.__derive = { resolveNextPhrase };\n';

const schedulerSource = toPlainScript(
  readModule('src/twobecomeone/studio_static/js/runtime/ghost-scheduler.js'));

const pageScript = `
${harness}
${schedulerSource}

// Controlled-clock context: real OfflineAudioContext nodes/decode, injected
// manually-advanced clock (labeled per scenario in the report).
window.__makeControlledContext = function(realCtx) {
  const clock = { now: 0 };
  const ctx = {
    clockMode: 'injected-controlled',
    get currentTime() { return clock.now; },
    set currentTime(v) { clock.now = v; },
    destination: realCtx.destination,
    decodeAudioData: (bytes) => realCtx.decodeAudioData(bytes),
    createBufferSource: () => realCtx.createBufferSource(),
    createGain: () => realCtx.createGain(),
  };
  return { ctx, clock };
};

window.__runScenario = async function(scenario) {
  const realCtx = new OfflineAudioContext(2, 44100 * scenario.durationSec, 44100);
  const { ctx, clock } = window.__makeControlledContext(realCtx);
  clock.now = scenario.clockStart;
  const decodeMs = { value: null };

  // Production GhostScheduler with real nodes. source.start is captured and
  // forwarded to the OfflineAudioContext; rendering is never started and
  // nothing reaches a device.
  const starts = [];
  const realCreateBufferSource = realCtx.createBufferSource.bind(realCtx);
  ctx.createBufferSource = () => {
    const source = realCreateBufferSource();
    const realStart = source.start.bind(source);
    source.start = (when, ...rest) => { starts.push(when); return realStart(when, ...rest); };
    return source;
  };

  if (scenario.decodeAdvancesClockTo != null) {
    // Causal decode-crossing: the injected clock advances while decode is
    // pending, exactly the race the production min-lead policy guards.
    const realDecode = ctx.decodeAudioData.bind(ctx);
    ctx.decodeAudioData = async (bytes) => {
      const out = await realDecode(bytes);
      clock.now = scenario.decodeAdvancesClockTo;
      return out;
    };
  }

  const states = [];
  const scheduledReceipts = [];
  const scheduler = new GhostScheduler({
    audioContext: ctx,
    loadAsset: async (asset, signal) => {
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const bin = atob(scenario.assetB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    },
    transportProvider: () => ({
      deck: 'B', playing: true,
      tempoBpm: scenario.tempoBpm,
      beatsPerBar: 4,
      phraseBars: scenario.phraseBars,
      beatAtStart: scenario.beatAtStart,
      startedAtAudioTime: scenario.startedAtAudioTime,
      gridRevision: 'bench-grid-1',
    }),
    onScheduled: (proposalId, receipt) => scheduledReceipts.push(receipt),
    onStateChange: (proposalId, state) => states.push(state),
  });

  const t0 = performance.now();
  const result = await scheduler.schedule(
    { id: scenario.id, actor: { type: 'human', id: 'bench' },
      lifecycle: 'scheduled', payload: { gainDb: 0 } },
    { id: 'asset-bench', contentHash: 'sha256:bench', audioUrl: '/bench', transformSpec: {} });
  decodeMs.value = Math.round((performance.now() - t0) * 1000) / 1000;

  return {
    scenario: scenario.id,
    schedulerResult: result,
    receipts: scheduledReceipts,
    capturedStarts: starts,
    states,
    decodeMs: decodeMs.value,
    clockAtReturn: clock.now,
  };
};

// Real-clock observation (audit B3): production scheduler on a REAL
// AudioContext whose currentTime advances with the device. No rendering or
// output assertion is possible in headless; this records scheduling behavior
// on a live clock only.
window.__runRealClockObservation = async function(scenario) {
  const ctx = new AudioContext({ sampleRate: 44100 });
  try {
    const clockBeforeWait = ctx.currentTime;
    await ctx.resume();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const clockAfterWait = ctx.currentTime;
    const ctxStateAtSchedule = ctx.state;
    const starts = [];
    const states = [];
    const scheduledReceipts = [];
    const scheduler = new GhostScheduler({
      audioContext: ctx,
      loadAsset: async () => {
        const bin = atob(scenario.assetB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      },
      transportProvider: () => ({
        deck: 'B', playing: true, tempoBpm: scenario.tempoBpm,
        beatsPerBar: 4, phraseBars: scenario.phraseBars,
        beatAtStart: 0, startedAtAudioTime: 0, gridRevision: 'bench-grid-1',
      }),
      onScheduled: (id, receipt) => scheduledReceipts.push(receipt),
      onStateChange: (id, state) => states.push(state),
    });
    const result = await scheduler.schedule(
      { id: scenario.id, actor: { type: 'human', id: 'bench' },
        lifecycle: 'scheduled', payload: { gainDb: 0 } },
      { id: 'asset-bench', contentHash: 'sha256:bench', audioUrl: '/bench', transformSpec: {} });
    // Cancel immediately: we never let the scheduled source actually fire.
    scheduler.cancel(scenario.id);
    return {
      scenario: scenario.id,
      schedulerResult: result,
      receipts: scheduledReceipts,
      capturedStarts: null, // start forwarding not needed for this observation
      states,
      ctxCurrentTimeAtReturn: ctx.currentTime,
      clockBeforeWait,
      clockAfterWait,
      ctxStateAtSchedule,
      ctxSampleRate: ctx.sampleRate,
      ctxState: ctx.state,
    };
  } finally {
    await ctx.close();
  }
};
`;

// ---- scenarios --------------------------------------------------------------
// expectations are hand-computed arithmetic on the Node side (independent of
// the in-page production code). 'exercises' names what the scenario ACTUALLY
// covers — audit B5: no scenario claims cue/trim or asset transforms it does
// not perform.
const B = 0.25; // production default min lead
const scenarios = [
  {
    id: 'next-phrase-boundary-32beat',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0, phraseBars: 8,
    clockStart: 5.0, durationSec: 20,
    exercises: 'resolveNextPhrase next-boundary advance on the injected clock',
    expect: { launchAudioTime: 16.0, resolvedBeat: 32, startCount: 1, minLead: B },
  },
  {
    id: 'on-boundary-advances-to-following-32beat',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0, phraseBars: 8,
    clockStart: 16.0, durationSec: 40,
    exercises: 'epsilon rule: exactly-on-boundary counts as past',
    expect: { launchAudioTime: 32.0, resolvedBeat: 64, startCount: 1, minLead: B },
  },
  {
    id: 'nonzero-clock-origin-32beat',
    tempoBpm: 120, beatAtStart: 7, startedAtAudioTime: 3, phraseBars: 8,
    clockStart: 8.0, durationSec: 20,
    exercises: 'transport origin math: beat 7 + (8-3)*2 = 17 -> next boundary 32',
    expect: { launchAudioTime: 15.5, resolvedBeat: 32, startCount: 1, minLead: B },
  },
  {
    id: 'destination-tempo-150-32beat',
    tempoBpm: 150, beatAtStart: 0, startedAtAudioTime: 0, phraseBars: 8,
    clockStart: 4.0, durationSec: 20,
    exercises: 'transport tempo only; asset tempo transforms are NOT exercised here',
    expect: { launchAudioTime: 12.8, resolvedBeat: 32, startCount: 1, minLead: B },
  },
  {
    id: 'min-lead-advances-to-following-32beat',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0, phraseBars: 8,
    clockStart: 15.8, durationSec: 40,
    exercises: 'finite min-lead policy: 0.2 s lead is unsafe -> following phrase',
    expect: { launchAudioTime: 32.0, resolvedBeat: 64, startCount: 1, minLead: B },
  },
  {
    id: 'decode-instant-4beat-phrases',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0, phraseBars: 1,
    clockStart: 5.5, durationSec: 20,
    exercises: 'baseline for the decode-crossing pair: at now=5.5 beat=11, '
             + 'next 4-beat boundary is 12 (launch 6.0) and the 0.5 s lead is safe',
    expect: { launchAudioTime: 6.0, resolvedBeat: 12, startCount: 1, minLead: B },
  },
  {
    id: 'decode-crossing-4beat-phrases',
    tempoBpm: 120, beatAtStart: 0, startedAtAudioTime: 0, phraseBars: 1,
    clockStart: 5.5, decodeAdvancesClockTo: 5.9, durationSec: 20,
    exercises: 'decode-crossing causality: clock advanced while decode pending -> '
             + 'same boundary becomes unsafe and the launch must move to the '
             + 'following phrase (6.0 -> 8.0)',
    expect: { launchAudioTime: 8.0, resolvedBeat: 16, startCount: 1, minLead: B },
  },
];
const REAL_CLOCK_SCENARIO = {
  id: 'real-clock-observation-4beat-phrases',
  tempoBpm: 120, phraseBars: 1,
  exercises: 'production scheduler on a REAL AudioContext device clock '
           + '(observation; invariants only, not deterministic timing)',
};

// 0.5 s of 440 Hz tone as the decodable asset (real decode, real context).
function toneWavBytes() {
  const sr = 44100, dur = 0.5;
  const n = sr * dur;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * (i / sr)) * 32767 * 0.5);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);  // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const EPS = 1e-6;
function assertScenario(scenario, observed) {
  const failures = [];
  const exp = scenario.expect;
  if (observed.schedulerResult?.ok !== true) {
    failures.push(`scheduler.result.ok=${observed.schedulerResult?.ok} code=${observed.schedulerResult?.code}`);
  }
  const receipt = observed.receipts?.[0];
  const returnedReceipt = observed.schedulerResult?.receipt;
  if (!receipt) failures.push('no production onScheduled receipt captured');
  if (!returnedReceipt || JSON.stringify(returnedReceipt) !== JSON.stringify(receipt)) {
    failures.push('scheduler return receipt and onScheduled receipt differ');
  }
  if (observed.capturedStarts?.length !== exp.startCount) {
    failures.push(`captured source.start count=${observed.capturedStarts?.length} expected ${exp.startCount}`);
  }
  if (receipt) {
    if (Math.abs(receipt.launchAudioTime - exp.launchAudioTime) > EPS) {
      failures.push(`receipt.launchAudioTime=${receipt.launchAudioTime} expected ${exp.launchAudioTime}`);
    }
    if (receipt.resolvedBeat !== exp.resolvedBeat) {
      failures.push(`receipt.resolvedBeat=${receipt.resolvedBeat} expected ${exp.resolvedBeat}`);
    }
    if (receipt.launchAudioTime - receipt.requestedAt < exp.minLead - EPS) {
      failures.push(`lead ${receipt.launchAudioTime - receipt.requestedAt} < minLead ${exp.minLead}`);
    }
    if (observed.capturedStarts?.[0] !== undefined
        && Math.abs(observed.capturedStarts[0] - exp.launchAudioTime) > EPS) {
      failures.push(`start(when)=${observed.capturedStarts[0]} expected ${exp.launchAudioTime}`);
    }
  }
  if (!observed.states?.includes('started')) failures.push(`states=${JSON.stringify(observed.states)}`);
  return failures;
}

async function main() {
  const executablePath = resolveChromium();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  let assertionFailures = 0;
  let hardFailures = 0;
  let selfTestDetected = false;
  const cases = [];
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
    });
    await page.addScriptTag({ content: pageScript });
    const probe = await page.evaluate(() => ({
      runScenario: typeof window.__runScenario,
      scheduler: typeof GhostScheduler,
      derive: typeof (window.__derive && window.__derive.resolveNextPhrase),
    }));
    if (probe.runScenario !== 'function' || probe.scheduler !== 'function'
        || probe.derive !== 'function') {
      console.error('page script did not install; probe =', probe);
      console.error('page errors =', pageErrors);
      throw new Error('page script did not install');
    }

    const assetB64 = toneWavBytes().toString('base64');
    const clockMode = 'injected-controlled (real OfflineAudioContext nodes/decode; '
      + 'clock manually advanced)';

    for (const scenario of scenarios) {
      const observed = await page.evaluate(
        (s) => window.__runScenario(s), { ...scenario, assetB64 });
      const failures = assertScenario(scenario, observed);
      if (failures.length) assertionFailures += 1;
      cases.push({
        scenario: scenario.id,
        exercises: scenario.exercises,
        clockMode,
        sampleRate: 44100,
        assertionFailures: failures,
        ok: failures.length === 0,
        receipt: observed.receipts?.[0] ?? null,
        capturedStarts: observed.capturedStarts,
        states: observed.states,
        decodeMs: observed.decodeMs,
        clockAtReturn: observed.clockAtReturn,
      });
      console.log(`${failures.length ? 'FAIL' : 'PASS'}  ${scenario.id}`
        + (failures.length ? ` — ${failures.join('; ')}` : ''));
    }

    // Self-test (audit B2): a deliberately WRONG expectation must be caught.
    const wrongScenario = { ...scenarios[0], expect: { ...scenarios[0].expect, launchAudioTime: 16.5 } };
    const observedWrong = await page.evaluate(
      (s) => window.__runScenario(s), { ...wrongScenario, assetB64 });
    selfTestDetected = assertScenario(wrongScenario, observedWrong).length > 0;
    console.log(`${selfTestDetected ? 'PASS' : 'FAIL'}  self-test: wrong expectation detected`);

    // Real-clock observation (audit B3): invariants only.
    const obs = await page.evaluate(
      (s) => window.__runRealClockObservation(s), { ...REAL_CLOCK_SCENARIO, assetB64 });
    const receipt = obs.receipts?.[0];
    const obsFailures = [];
    if (obs.schedulerResult?.ok !== true) obsFailures.push('scheduler not ok');
    if (obs.ctxStateAtSchedule !== 'running') {
      obsFailures.push(`AudioContext state at schedule=${obs.ctxStateAtSchedule}`);
    }
    if (!(obs.clockAfterWait > obs.clockBeforeWait)) {
      obsFailures.push(
        `AudioContext clock did not advance (${obs.clockBeforeWait} -> ${obs.clockAfterWait})`);
    }
    if (!receipt) obsFailures.push('no receipt');
    else {
      if (!(receipt.launchAudioTime > receipt.requestedAt)) obsFailures.push('launch not after request');
      if (receipt.launchAudioTime - receipt.requestedAt < B - 1e-6) obsFailures.push('lead < minLead');
      // Independent invariant: resolvedBeat is the next 4-beat boundary after now.
      const beatNow = (receipt.requestedAt) * (REAL_CLOCK_SCENARIO.tempoBpm / 60);
      const nextBoundary = (Math.floor(beatNow / 4) + 1) * 4;
      if (receipt.resolvedBeat !== nextBoundary) {
        obsFailures.push(`resolvedBeat ${receipt.resolvedBeat} != next 4-beat boundary ${nextBoundary}`);
      }
    }
    cases.push({
      scenario: REAL_CLOCK_SCENARIO.id,
      exercises: REAL_CLOCK_SCENARIO.exercises,
      clockMode: 'real-device-audiocontext-clock (observation; headless, output unused)',
      sampleRate: obs.ctxSampleRate,
      assertionFailures: obsFailures,
      ok: obsFailures.length === 0,
      receipt: receipt ?? null,
      states: obs.states,
      ctxState: obs.ctxState,
      ctxCurrentTimeAtReturn: obs.ctxCurrentTimeAtReturn,
      clockBeforeWait: obs.clockBeforeWait,
      clockAfterWait: obs.clockAfterWait,
      ctxStateAtSchedule: obs.ctxStateAtSchedule,
    });
    console.log(`${obsFailures.length ? 'FAIL' : 'PASS'}  ${REAL_CLOCK_SCENARIO.id}`);
    if (obsFailures.length) assertionFailures += 1;

    if (pageErrors.length) {
      console.error('page errors during run:', pageErrors);
      hardFailures += 1;
    }
    if (!selfTestDetected) {
      console.error('self-test FAILED to detect a deliberately wrong expectation');
      hardFailures += 1;
    }
  } finally {
    await browser.close();
  }

  const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim().length > 0;
  // Unrelated workspace files (for example .vscode/) do not invalidate a
  // capture. Any tracked or untracked change in the benchmark or production
  // modules it executes does, so commit + this scoped-clean gate identifies
  // the executable sources without requiring a globally clean worktree.
  const sourceStatus = execSync(
    'git status --porcelain --untracked-files=all -- '
      + 'tests/browser/timing_bench.js '
      + 'src/twobecomeone/studio_static/js/actions/errors.js '
      + 'src/twobecomeone/studio_static/js/transport/normalize.js '
      + 'src/twobecomeone/studio_static/js/transport/derive.js '
      + 'src/twobecomeone/studio_static/js/runtime/ghost-scheduler.js',
    { cwd: ROOT },
  ).toString().trim();
  const report = {
    schema: '2become1.listening-timing/1',
    evidenceClass: 'B_browser_scheduling',
    generatedBy: 'tests/browser/timing_bench.js',
    capturedAt: new Date().toISOString(),
    commit,
    repoDirtyAtCapture: dirty,
    benchmarkSourcesDirtyAtCapture: sourceStatus.length > 0,
    sourceIdentityPolicy: 'commit match + clean benchmark source scope',
    browser: { name: 'chromium', version: browser.version?.() ?? 'unknown', executablePath },
    os: { platform: process.platform, release: osRelease(), node: process.version },
    contextKind: 'OfflineAudioContext (nodes real; never rendered to device) + one real AudioContext observation',
    clockPolicy: 'per-scenario clockMode field; synthetic clocks are labeled injected',
    schedulerCoverage: 'production runtime/ghost-scheduler.js GhostScheduler; '
      + 'CommittedLayerEngine is NOT exercised (separate follow-up)',
    selfTestWrongExpectationDetected: selfTestDetected,
    measured: assertionFailures === 0 && hardFailures === 0 && selfTestDetected,
    assertionFailureCount: assertionFailures,
    note: 'Receipts prove Web Audio scheduling INTENT by the production '
        + 'scheduler. They cannot establish audible/sample timing; class C '
        + '(loopback) is the class that can, and it remains unmeasured.',
    cases,
  };

  const outDir = join(ROOT, 'tests', 'browser', 'artifacts', 'timing_bench');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'receipts.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`receipts -> ${join(outDir, 'receipts.json')}`);
  if (assertionFailures > 0 || hardFailures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});