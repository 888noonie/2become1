// tests/frontend/clockwork-audition.test.js — the owner audition page's controls
// (OPERATION THE GOLDEN EAR II, Grok N3). jsdom + the REAL RealtimeEngine, real
// EditEngine/compileRenderPlan and the synthesised fixtures over the simulated
// Web Audio host. No audio device is involved: the context factory is the fake.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import {
  FakeAudioContext, installFakeWorkletGlobal, fakeStretchFactory, flush, manualTimers,
} from './arrangement/helpers/fake-audio.js';
import { mountAudition, DEFAULT_LEVEL_DB, STOP_WATCHDOG_MS } from '../../tools/clockwork-audition/audition.js';
import { auditionProject } from '../../tools/clockwork-audition/fixtures.js';
import { RealtimeEngine } from '../../src/twobecomeone/studio_static/js/realtime-engine.js';
import { EditEngine } from '../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';

installFakeWorkletGlobal();

function mount() {
  const dom = setupDom('<!doctype html><html><body><main id="a"></main></body></html>');
  const contexts = [];
  const pageTimers = manualTimers();
  const api = mountAudition(document.getElementById('a'), {
    document, RealtimeEngine, EditEngine, compileRenderPlan, auditionProject,
    createContext: () => { const c = new FakeAudioContext(); c.state = 'suspended'; contexts.push(c); return c; },
    StretchFactory: fakeStretchFactory(),
    modules: { limiterModuleUrl: 'limiter.js' },
    engineOptions: { timers: manualTimers() },
    setInterval: (f) => pageTimers.setTimeout(f, 100),
    clearInterval: (i) => pageTimers.clearTimeout(i),
    setTimeout: (f, ms) => pageTimers.setTimeout(f, ms),
    clearTimeout: (i) => pageTimers.clearTimeout(i),
  });
  return { api, contexts, pageTimers, dom };
}

async function advance(api, sec) {
  const ctx = api.state.ctx;
  const end = ctx.currentTime + sec;
  while (ctx.currentTime < end - 1e-9) {
    ctx.currentTime += 0.025;
    await api.state.engine.tick();
    await flush();
  }
  api.render();
}

const key = (k, code = k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true }));
const phase = (api) => api.elements.phaseText.textContent;

test('N3: loading the page creates no audio context and starts nothing (no autoplay, no pilot tone)', async () => {
  const { api, contexts, dom } = mount();
  await flush();
  assert.equal(contexts.length, 0, 'no AudioContext on load');
  assert.equal(phase(api), 'audio off');
  assert.match(document.body.textContent, /Nothing will sound until you press Play/);
  key('Escape');
  await flush();
  assert.equal(contexts.length, 0, 'Esc with nothing playing opens nothing');
  const { playBtn, stopBtn } = api.elements;
  assert.equal(playBtn.textContent, 'Play');
  assert.match(stopBtn.textContent, /Stop/);
  assert.equal(stopBtn.hidden, false);
  assert.equal(stopBtn.disabled, false, 'Stop is always available');
  api.unmount(); teardownDom(dom);
});

test('N3: Play prepares the real engine once, plays the real arrangement; Stop button reaches stopped', async () => {
  const { api, contexts, dom } = mount();
  api.elements.playBtn.click();
  await api.state.preparing; await flush(); await api.state.engine.settle();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumeCalls, 1, 'the context is resumed from the Play gesture');
  assert.ok(api.state.engine instanceof RealtimeEngine, 'the actual C1 engine');
  assert.equal(api.state.engine.plan.clips.length, 4, 'the real ProjectState arrangement');
  await advance(api, 0.3);
  assert.equal(phase(api), 'playing');
  api.elements.stopBtn.click();
  await advance(api, 0.1);
  assert.equal(phase(api), 'stopped');
  assert.equal(api.state.engine.state().isPlaying, false);
  // Replay reuses the same context (no second device open).
  api.elements.playBtn.click();
  await flush(); await api.state.engine.settle();
  await advance(api, 0.3);
  assert.equal(phase(api), 'playing');
  assert.equal(contexts.length, 1);
  await api.closeAudio();
  api.unmount(); teardownDom(dom);
});

test('N3: Esc is the same Stop action, from anywhere, including while preparing', async () => {
  const { api, contexts, dom } = mount();
  api.elements.playBtn.click();
  key('Escape'); // during preparation
  await api.state.preparing; await flush();
  assert.equal(contexts.length, 1);
  assert.notEqual(api.state.engine.state().phase, 'starting', 'Esc during prepare cancels the pending Play');
  api.elements.playBtn.click();
  await flush(); await api.state.engine.settle();
  await advance(api, 0.3);
  assert.equal(phase(api), 'playing');
  key('Escape');
  await advance(api, 0.1);
  assert.equal(phase(api), 'stopped');
  api.unmount(); teardownDom(dom);
});

test('N3: Space toggles Play/Stop exactly once per press (focused buttons are not also clicked)', async () => {
  const { api, dom } = mount();
  api.elements.seekA.focus();
  key(' ', 'Space');
  await api.state.preparing; await flush(); await api.state.engine.settle();
  await advance(api, 0.3);
  assert.equal(phase(api), 'playing');
  const up = new window.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(up);
  assert.equal(up.defaultPrevented, true, 'Space keyup cannot activate the focused button');
  key(' ', 'Space');
  await advance(api, 0.1);
  assert.equal(phase(api), 'stopped');
  api.unmount(); teardownDom(dom);
});

test('N3: conservative level by default, ramped (never stepped) changes, capped at -6 dB', async () => {
  const { api, dom } = mount();
  assert.equal(Number(api.elements.level.value), DEFAULT_LEVEL_DB);
  assert.equal(Number(api.elements.level.max), -6);
  api.elements.playBtn.click();
  await api.state.preparing; await flush();
  const g = api.state.monitor.gain;
  assert.ok(Math.abs(g.value - 10 ** (DEFAULT_LEVEL_DB / 20)) < 1e-9, `monitor at ${DEFAULT_LEVEL_DB} dB`);
  api.elements.level.value = '-12';
  api.elements.level.dispatchEvent(new window.Event('input'));
  const t = api.state.ctx.currentTime;
  assert.ok(g.valueAt(t + 0.025) < 10 ** (-12 / 20), 'ramping, not stepped');
  assert.ok(Math.abs(g.valueAt(t + 0.05) - 10 ** (-12 / 20)) < 1e-9);
  assert.equal(g.valueWritesWhileConnected, 0);
  api.unmount(); teardownDom(dom);
});

test('N3: seek and loop controls drive the engine; state and errors are displayed', async () => {
  const { api, dom } = mount();
  api.elements.playBtn.click();
  await api.state.preparing; await flush(); await api.state.engine.settle();
  await advance(api, 0.3);
  api.elements.seekB.click();
  await advance(api, 0.3);
  assert.ok(api.state.engine.playhead() >= 6 * 48000, 'jumped to 6 s');
  api.elements.loopBtn.click();
  await advance(api, 0.2);
  assert.deepEqual(api.state.engine.state().loop, [2 * 48000, 4 * 48000]);
  assert.equal(api.elements.loopBtn.getAttribute('aria-pressed'), 'true');
  // A non-finite fault is shown, and the transport is in a safe failed state.
  api.state.engine.backbone.limiter.emitStats({ nonFiniteCount: 1, firstNonFiniteIndex: 9 });
  await advance(api, 0.05);
  assert.equal(phase(api), 'failed');
  assert.match(api.elements.errList.textContent, /NON_FINITE/);
  api.unmount(); teardownDom(dom);
});

test('N3: the Stop watchdog suspends the context if the transport does not reach stopped', async () => {
  const { api, pageTimers, dom } = mount();
  api.elements.playBtn.click();
  await api.state.preparing; await flush(); await api.state.engine.settle();
  await advance(api, 0.3);
  api.elements.stopBtn.click();
  // Do NOT advance the audio clock: the stop cannot complete. Fire the watchdog.
  const wd = [...pageTimers.pending.values()].find((t) => t.ms === STOP_WATCHDOG_MS);
  assert.ok(wd, 'a watchdog is armed on Stop');
  await wd.fn();
  assert.equal(api.state.ctx.suspendCalls, 1, 'second stop path: the context is suspended');
  assert.match(api.elements.errList.textContent, /STOP_WATCHDOG/);
  assert.equal(api.state.engine.state().phase, 'stopped', 'and the engine parks honestly on suspension');
  api.unmount(); teardownDom(dom);
});

test('N3: a Play after Stop disarms that Stop\'s watchdog (it never suspends the new playback)', async () => {
  const { api, pageTimers, dom } = mount();
  api.elements.playBtn.click();
  await api.state.preparing; await flush(); await api.state.engine.settle();
  await advance(api, 0.3);
  key('Escape');
  await advance(api, 0.1);
  const wd = [...pageTimers.pending.values()].find((t) => t.ms === STOP_WATCHDOG_MS);
  key(' ', 'Space'); // play again before the watchdog fires
  await flush(); await api.state.engine.settle();
  await advance(api, 0.2);
  api.elements.seekB.click();
  assert.ok(![...pageTimers.pending.values()].some((t) => t.ms === STOP_WATCHDOG_MS), 'watchdog cleared by Play');
  if (wd) await wd.fn(); // even a stale callback must not act
  assert.equal(api.state.ctx.suspendCalls ?? 0, 0, 'the new playback was not suspended');
  assert.doesNotMatch(api.elements.errList.textContent, /STOP_WATCHDOG/);
  api.unmount(); teardownDom(dom);
});

test('BROKEN RECORD: Loop pressed before the first Play reaches the engine, and Play from 6 s loops 2–4 s', async () => {
  const { api, dom } = mount();
  api.elements.loopBtn.click(); // audio off: no engine yet
  api.elements.playBtn.click();
  await api.state.preparing; await flush(); await api.state.engine.settle();
  assert.deepEqual(api.state.engine.state().loop, [2 * 48000, 4 * 48000], 'the engine has the loop the page shows');
  await advance(api, 3);
  api.elements.seekB.click(); // Jump to 6 s while looping
  await advance(api, 9);
  assert.equal(phase(api), 'playing', 'still playing past the 8 s arrangement end');
  const f = api.state.engine.playhead();
  assert.ok(f >= 2 * 48000 && f < 4 * 48000, `heard position inside the loop (${f})`);
  key('Escape');
  await advance(api, 0.3);
  assert.equal(phase(api), 'stopped');
  api.unmount(); teardownDom(dom);
});
