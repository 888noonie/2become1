// tools/clockwork-audition/audition.js — the owner-controlled C1 audition page.
//
// OPERATION THE GOLDEN EAR II (Grok N3). A minimal, isolated local page that
// drives the ACTUAL C1 transport: a real ProjectState (EditEngine), the real
// render-plan compiler and the real RealtimeEngine with the vendored
// Signalsmith worklet and the shared limiter. It is not a separate demo player.
//
// Safety contract (each point is tested):
//   * No autoplay. No AudioContext exists until the owner presses Play; loading
//     the page opens no audio device and makes no sound.
//   * No pilot tone, no automatic sequence: sound only follows a key or click.
//   * Stop is always visible; Esc is the same Stop action, from anywhere on the
//     page, at any time (including while preparing).
//   * Space toggles Play / Stop (Stop returns to the cue).
//   * Conservative monitor level: -24 dB by default, -6 dB maximum, changed with
//     short ramps (never a step on a running graph).
//   * Transport state and every error/warning are shown on the page.
//   * If a Stop has not completed 600 ms after it was requested, the audio
//     context is suspended (a second, independent stop path) and that is shown.

export const DEFAULT_LEVEL_DB = -24;
export const MIN_LEVEL_DB = -48;
export const MAX_LEVEL_DB = -6;
export const STOP_WATCHDOG_MS = 600;

const dbToGain = (db) => 10 ** (db / 20);

/**
 * Mount the audition UI into `root`.
 * @param {object} deps {document, RealtimeEngine, EditEngine, compileRenderPlan,
 *   auditionProject, createContext: () => AudioContext, StretchFactory, modules,
 *   setInterval?, clearInterval?, setTimeout?, engineOptions?}
 */
export function mountAudition(root, deps) {
  const doc = deps.document ?? root.ownerDocument;
  const setI = deps.setInterval ?? ((f, ms) => globalThis.setInterval(f, ms));
  const clearI = deps.clearInterval ?? ((id) => globalThis.clearInterval(id));
  const setT = deps.setTimeout ?? ((f, ms) => globalThis.setTimeout(f, ms));
  const clearT = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const SR = 48000;

  const el = (tag, attrs = {}, text = '') => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    return n;
  };

  root.replaceChildren();
  const title = el('h1', {}, 'Clockwork audition (C1 transport)');
  const note = el('p', { class: 'note' }, 'Audio is off. Nothing will sound until you press Play. Esc stops at any time.');
  const controls = el('div', { class: 'controls', role: 'group', 'aria-label': 'Transport' });
  const playBtn = el('button', { type: 'button', class: 'play', 'aria-label': 'Play' }, 'Play');
  const stopBtn = el('button', { type: 'button', class: 'stop', 'aria-label': 'Stop' }, 'Stop (Esc)');
  const seekA = el('button', { type: 'button', 'aria-label': 'Jump to 2 s' }, 'Jump to 2 s');
  const seekB = el('button', { type: 'button', 'aria-label': 'Jump to 6 s' }, 'Jump to 6 s');
  const loopBtn = el('button', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Loop 2 s to 4 s' }, 'Loop 2 s–4 s: off');
  const releaseBtn = el('button', { type: 'button', 'aria-label': 'Release audio device' }, 'Release audio device');
  controls.append(playBtn, stopBtn, seekA, seekB, loopBtn, releaseBtn);

  const levelLabel = el('label', { for: 'level' }, 'Monitor level ');
  const level = el('input', {
    id: 'level', type: 'range', min: String(MIN_LEVEL_DB), max: String(MAX_LEVEL_DB), step: '1',
    value: String(DEFAULT_LEVEL_DB), 'aria-label': 'Monitor level (dB)',
  });
  const levelValue = el('output', { for: 'level', 'aria-live': 'off' }, `${DEFAULT_LEVEL_DB} dB`);
  levelLabel.append(level, levelValue);

  const status = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const phaseText = el('strong', { 'data-field': 'phase' }, 'audio off');
  const posText = el('span', { 'data-field': 'position' }, '0.00 s');
  const loopText = el('span', { 'data-field': 'loop' }, 'loop off');
  status.append('State: ', phaseText, ' · Position: ', posText, ' · ', loopText);
  const errors = el('div', { class: 'errors', role: 'alert', 'aria-live': 'assertive' });
  const errList = el('ul');
  errors.append(el('h2', {}, 'Errors and warnings'), errList);
  const details = el('details');
  const diag = el('pre', { 'data-field': 'diagnostics' }, 'Not prepared.');
  details.append(el('summary', {}, 'Engine diagnostics (timing provenance, voices)'), diag);
  const material = el('p', { class: 'note' },
    'Material: 8 s of synthesised pad, drums, bass (unstretched) and an arpeggio stretched x1.2 through Signalsmith. '
    + 'All generated in this page; no library media is read or changed. This is a shared start on one clock, not beat matching.');
  root.append(title, note, controls, levelLabel, status, errors, details, material);

  const state = {
    ctx: null, engine: null, monitor: null, preparing: null, cancelPrepare: false,
    loopOn: false, uiTimer: null, contextsCreated: 0, stopRequestedAt: null, watchdog: null, lastPhase: 'audio off',
  };

  const report = (kind, code, message) => {
    const li = el('li', { 'data-code': code }, `${kind}: ${code}${message ? ` — ${message}` : ''}`);
    errList.append(li);
    while (errList.children.length > 12) errList.firstChild.remove();
  };

  const render = () => {
    const e = state.engine;
    const phase = e ? e.state().phase : (state.preparing ? 'preparing' : 'audio off');
    state.lastPhase = phase;
    phaseText.textContent = phase;
    const frame = e ? e.playhead() : 0;
    posText.textContent = `${(frame / SR).toFixed(2)} s`;
    loopText.textContent = state.loopOn ? 'loop 2 s–4 s' : 'loop off';
    playBtn.disabled = !!state.preparing;
    const active = ['starting', 'playing', 'seeking'].includes(phase);
    seekA.disabled = !e; seekB.disabled = !e;
    root.setAttribute('data-phase', phase);
    if (e) {
      const d = e.diagnostics();
      const t = d.timing;
      diag.textContent = [
        `phase ${d.state.phase}  epoch ${d.state.epoch}  fault ${d.state.fault ? d.state.fault.code : 'none'}`,
        `voices ${d.pool.live}/${d.capacity} (peak connected ${d.peakConnectedProcessors}, graph limit ${d.graphLimit})`,
        `priming lead ${t.primingLeadMs.value} ms (${t.primingLeadMs.provenance})`,
        `start lead ${t.startLeadMs.value.toFixed(1)} ms (${t.startLeadMs.provenance})`,
        `supplied Signalsmith lead ${t.suppliedDspLeadMs ? `${t.suppliedDspLeadMs.min.toFixed(1)}-${t.suppliedDspLeadMs.max.toFixed(1)} ms` : 'n/a'}`,
        `device output latency ${t.deviceOutputLatencyMs.value == null ? 'n/a' : t.deviceOutputLatencyMs.value.toFixed(1)} ms (${t.deviceOutputLatencyMs.provenance})`,
        `deadline misses ${d.deadlineMisses}  start delays ${d.startDelaysMs.length}  unqualified stretch ${d.unqualifiedStretch.length}`,
      ].join('\n');
    }
    if (!active && state.uiTimer && !state.preparing) {
      clearI(state.uiTimer);
      state.uiTimer = null;
    }
  };

  const startUi = () => {
    if (!state.uiTimer) state.uiTimer = setI(render, 100);
  };

  const applyLevel = (db) => {
    levelValue.textContent = `${db} dB`;
    if (!state.monitor) return;
    const g = state.monitor.gain;
    const now = state.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(dbToGain(db), now + 0.05); // 50 ms ramp, never a step
  };

  async function prepare() {
    const ctx = deps.createContext();
    state.contextsCreated += 1;
    state.ctx = ctx;
    if (ctx.state !== 'running') await ctx.resume();
    const monitor = ctx.createGain();
    monitor.gain.value = dbToGain(Number(level.value)); // not yet connected: not a running-graph write
    monitor.connect(ctx.destination);
    state.monitor = monitor;
    const { engine: edit, buffers } = deps.auditionProject(deps.EditEngine);
    const plan = deps.compileRenderPlan(edit.state);
    const engine = new deps.RealtimeEngine(ctx, plan, buffers, {
      ...deps.modules,
      StretchFactory: deps.StretchFactory,
      destination: monitor,
      onStateChange: () => render(),
      onParked: (frame) => { try { edit.setPlayhead((frame / SR) * (plan.masterBpm / 60)); } catch { /* bookkeeping only */ } },
      onFail: (e) => { report('error', e.code, e.message); render(); },
      onWarn: (e) => { report('warning', e.code, e.message); render(); },
      onCapacityError: (e) => { report('refused', e.code, e.message); render(); },
      ...(deps.engineOptions ?? {}),
    });
    await engine.prepare();
    state.engine = engine;
    return engine;
  }

  async function play() {
    if (state.preparing) return;
    state.cancelPrepare = false;
    // A new Play supersedes any earlier Stop: its watchdog must not fire on
    // this playback (found by the real-Chromium page check).
    if (state.watchdog) { clearT(state.watchdog); state.watchdog = null; }
    try {
      if (!state.engine) {
        state.preparing = prepare();
        render();
        await state.preparing;
        state.preparing = null;
        if (state.cancelPrepare) { render(); return; } // Esc/Stop during preparation wins
      }
      if (state.ctx.state !== 'running') await state.ctx.resume();
      state.engine.play();
      startUi();
    } catch (err) {
      state.preparing = null;
      report('error', 'PLAY_FAILED', String(err && err.message ? err.message : err));
    }
    render();
  }

  function stop() {
    state.cancelPrepare = true;
    const e = state.engine;
    if (!e) { render(); return; }
    const phase = e.state().phase;
    if (['starting', 'playing', 'seeking'].includes(phase)) {
      e.stop();
      state.stopRequestedAt = Date.now();
      const epochAtStop = e.state().epoch;
      if (state.watchdog) clearT(state.watchdog);
      // Independent second stop path: if the transport has not reached
      // `stopped`, suspend the whole context so nothing can keep sounding.
      state.watchdog = setT(() => {
        state.watchdog = null;
        const p = e.state().phase;
        const sameStop = e.state().epoch === epochAtStop && state.engine === e;
        if (sameStop && p !== 'stopped' && p !== 'failed' && state.ctx && state.ctx.state === 'running') {
          state.ctx.suspend();
          report('warning', 'STOP_WATCHDOG', `transport was "${p}" ${STOP_WATCHDOG_MS} ms after Stop; audio output suspended`);
        }
        render();
      }, STOP_WATCHDOG_MS);
    }
    startUi();
    render();
  }

  const toggle = () => {
    const phase = state.engine ? state.engine.state().phase : 'audio off';
    if (['starting', 'playing', 'seeking'].includes(phase)) stop();
    else void play();
  };

  playBtn.addEventListener('click', () => { void play(); });
  stopBtn.addEventListener('click', () => stop());
  seekA.addEventListener('click', () => { state.engine?.seek(2 * SR); render(); });
  seekB.addEventListener('click', () => { state.engine?.seek(6 * SR); render(); });
  loopBtn.addEventListener('click', () => {
    const on = !state.loopOn;
    if (state.engine) {
      state.engine.setLoop(on ? [2 * SR, 4 * SR] : null);
      // Reflect the ENGINE's loop, so a refused change (either way) is never shown as done.
      if (!!state.engine.state().loop !== on) return render(); // refused; the reason is in the error list
    }
    state.loopOn = on;
    loopBtn.setAttribute('aria-pressed', String(on));
    loopBtn.textContent = `Loop 2 s–4 s: ${on ? 'on' : 'off'}`;
    render();
  });
  level.addEventListener('input', () => applyLevel(Number(level.value)));
  releaseBtn.addEventListener('click', () => { void api.closeAudio(); });

  const onKey = (ev) => {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      stop();
    } else if (ev.key === ' ' || ev.code === 'Space') {
      if (ev.target && ev.target.tagName === 'INPUT' && ev.target.type !== 'range') return;
      ev.preventDefault(); // never also "click" a focused button
      if (ev.repeat) return; // holding Space must not toggle repeatedly
      toggle();
    }
  };
  // Browsers activate a focused button on Space KEYUP, so suppress that too:
  // Space must mean exactly one Play/Stop toggle.
  const onKeyUp = (ev) => {
    if ((ev.key === ' ' || ev.code === 'Space') && !(ev.target && ev.target.tagName === 'INPUT' && ev.target.type !== 'range')) ev.preventDefault();
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('keyup', onKeyUp, true);

  const api = {
    state,
    play,
    stop,
    toggle,
    render,
    elements: { playBtn, stopBtn, seekA, seekB, loopBtn, releaseBtn, level, phaseText, posText, errList, diag },
    async closeAudio() {
      state.engine?.dispose();
      state.engine = null;
      if (state.ctx && state.ctx.state !== 'closed') await state.ctx.close();
      state.ctx = null;
      state.monitor = null;
      render();
    },
    unmount() {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('keyup', onKeyUp, true);
      if (state.uiTimer) clearI(state.uiTimer);
      if (state.watchdog) clearT(state.watchdog);
    },
  };
  render();
  return api;
}
