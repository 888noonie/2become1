// Disposable Golden Ear feasibility probe (2026-11-20). Not product code; not part of any suite.
// Run: copy this folder outside the repo, then `TMPDIR=<dir> node probe-driver.mjs` (needs the
// all-the-time worktree for playwright-core and the vendored Signalsmith module).
import SS from '/src/twobecomeone/studio_static/vendor/signalsmith-stretch/SignalsmithStretch.mjs';

const SR = 48000;
const R = {};
const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] };
const r4 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1e4) / 1e4);

function seg(sec, fn) { const n = Math.round(sec * SR); const a = new Float32Array(n); for (let i = 0; i < n; i += 1) a[i] = fn(i / SR, i); return a; }
const sine = (f, a = 0.5) => (t) => a * Math.sin(2 * Math.PI * f * t);
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 * 2 - 1; };
// percussive: noise bursts every 0.25 s with 40 ms exponential decay, plus 220 Hz bed
const perc = (t) => { const ph = t % 0.25; return 0.6 * rnd() * Math.exp(-ph / 0.04) + 0.15 * Math.sin(2 * Math.PI * 220 * t); };

async function mk(ctx, cfg) { const n = await SS(ctx, opts); if (cfg) await n.configure(cfg); return n; }

function goertzel(x, from, len, f) {
  let s1 = 0, s2 = 0; const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
  for (let i = 0; i < len; i += 1) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1)); const s = (x[from + i] || 0) * h + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (len / 4);
}
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i += 1) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
function env(x, a, b, w) { const o = []; for (let i = a; i + w <= b; i += w) o.push(rms(x, i, i + w)); return o; }
function corr(p, q) { const n = Math.min(p.length, q.length); let mp = 0, mq = 0; for (let i = 0; i < n; i += 1) { mp += p[i]; mq += q[i]; } mp /= n; mq /= n; let sp = 0, sq = 0, spq = 0; for (let i = 0; i < n; i += 1) { const a = p[i] - mp, b = q[i] - mq; sp += a * a; sq += b * b; spq += a * b; } return spq / Math.sqrt(sp * sq); }

async function renderOne(seconds, build, at, later) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const st = await build(ctx);
  if (at != null) ctx.suspend(at).then(async () => { await later(st); ctx.resume(); });
  const b = await ctx.startRendering();
  return b.getChannelData(0).slice();
}

// E1 latency per configuration, and node construction cost
async function e1() {
  const out = [];
  for (const cfg of [null, { preset: 'cheaper' }, { blockMs: 80 }, { blockMs: 60 }, { blockMs: 40 }]) {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const t = performance.now(); const n = await mk(ctx, cfg); const ms = performance.now() - t;
    out.push({ cfg: cfg ? JSON.stringify(cfg) : 'default', latencyMs: r4((await n.latency()) * 1000), constructMs: r4(ms) });
  }
  const live = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
  const times = []; for (let i = 0; i < 8; i += 1) { const t = performance.now(); await SS(live, opts); times.push(r4(performance.now() - t)); }
  R.e1 = { configs: out, liveConstructMs8: times, baseLatencyMs: r4(live.baseLatency * 1000), outputLatencyMs: r4((live.outputLatency || 0) * 1000), renderCapacity: typeof live.renderCapacity, getOutputTimestamp: typeof live.getOutputTimestamp };
  await live.close();
}

// E2 cold start (inactive until T) vs warm (active 0.3 s before T) vs sliced (no source before start).
async function e2() {
  const res = [];
  for (const [name, fn] of [['tone', sine(440)], ['perc', perc]]) {
    seed = 7; const src = seg(4, fn); const sliced = src.slice(2 * SR);
    for (const offFrames of [0, 37]) {
      const T = 1.0 + offFrames / SR;
      const run = (mode) => renderOne(1.6, async (ctx) => {
        const n = await mk(ctx); await n.addBuffers(mode === 'sliced' ? [sliced, sliced] : [src, src]); n.connect(ctx.destination); return n;
      }, 0.5, async (n) => {
        if (mode === 'warm') await n.schedule({ output: T - 0.3, input: 2.0 - 0.3, rate: 1, active: true });
        else await n.schedule({ output: T, input: mode === 'sliced' ? 0 : 2.0, rate: 1, active: true });
      });
      const warm = await run('warm');
      for (const mode of ['cold', 'sliced']) {
        const cold = await run(mode);
        const a = Math.round(T * SR); const w = 48; const errs = [];
        for (let k = 0; k < 60; k += 1) { const i = a + k * w; let e = 0; for (let j = i; j < i + w; j += 1) e += (cold[j] - warm[j]) ** 2; errs.push(20 * Math.log10(Math.sqrt(e / w) / Math.max(1e-9, rms(warm, i, i + w)) + 1e-12)); }
        const settle = errs.findIndex((e, k) => errs.slice(k).every((v) => v < -30));
        let on = -1; for (let i = a - 9600; i < a + 9600; i += 1) if (Math.abs(cold[i]) > 1e-3) { on = i - a; break; }
        let wOn = -1; for (let i = a - 9600; i < a + 9600; i += 1) if (Math.abs(warm[i]) > 1e-3) { wOn = i - a; break; }
        res.push({ material: name, mode, startOffsetFrames: offFrames, errDbVsWarm_ms0to5: errs.slice(0, 5).map(r4), settleMsBelowMinus30dB: settle < 0 ? '>60' : settle, onsetFrameRelT: on, warmOnsetRelT: wOn, rmsFirst5ms: r4(rms(cold, a, a + 240)), warmRmsFirst5ms: r4(rms(warm, a, a + 240)) });
      }
    }
  }
  R.e2 = res;
}

// E3 seek / loop-wrap stale content: tone A region -> tone B region at T.
async function e3() {
  const A = 440, B = 1320; const src = new Float32Array(4 * SR);
  src.set(seg(2, sine(A)), 0); src.set(seg(2, (t) => 0.5 * Math.sin(2 * Math.PI * B * (t + 2))), 2 * SR);
  const T = 1.0; const out = [];
  for (const rate of [1, 0.857]) {
    for (const mode of ['single-voice jump', 'two-voice 5ms crossfade']) {
      const y = await renderOne(1.6, async (ctx) => {
        const n1 = await mk(ctx); await n1.addBuffers([src, src]);
        n1.schedule({ output: 0.1, input: 0.1, rate, active: true });
        if (mode === 'single-voice jump') { n1.connect(ctx.destination); return { n1 }; }
        const g1 = ctx.createGain(); const g2 = ctx.createGain(); n1.connect(g1).connect(ctx.destination);
        const n2 = await mk(ctx); await n2.addBuffers([src, src]); n2.connect(g2).connect(ctx.destination);
        n2.schedule({ output: T - 0.3, _ot: T - 0.3, input: 2.5 - 0.3 * rate, rate, active: true });
        g1.gain.setValueAtTime(1, 0); g1.gain.setValueAtTime(1, T - 0.0025); g1.gain.linearRampToValueAtTime(0, T + 0.0025);
        g2.gain.setValueAtTime(0, 0); g2.gain.setValueAtTime(0, T - 0.0025); g2.gain.linearRampToValueAtTime(1, T + 0.0025);
        return { n1, two: true };
      }, 0.5, async (st) => {
        if (st.two) await st.n1.schedule({ output: T + 0.01, active: false });
        else await st.n1.schedule({ output: T, input: 2.5, rate, active: true });
      });
      const a = Math.round(T * SR); const L = 480; const refA = goertzel(y, a - 4 * L, L, A);
      const series = []; for (let k = 0; k < 20; k += 1) series.push([k * 10, r4(20 * Math.log10(goertzel(y, a + k * L, L, A) / refA + 1e-9)), r4(20 * Math.log10(goertzel(y, a + k * L, L, B) / refA + 1e-9))]);
      const staleMs = (series.findIndex((s, k) => series.slice(k).every((v) => v[1] < -40)) ) * 10;
      const bMs = series.findIndex((s) => s[2] > -1) * 10;
      let maxStep = 0; for (let i = a - 240; i < a + 4800; i += 1) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
      out.push({ rate, mode, staleAbelowMinus40dB_atMs: staleMs, bWithin1dB_atMs: bMs, maxSampleStepNearT: r4(maxStep), naturalMaxStepB: r4(0.5 * 2 * Math.PI * B / SR), firstWindows_ms_A_B_dB: series.slice(0, 8) });
    }
  }
  R.e3 = out;
}

// E4 render-quantum phase: same clip scheduled k frames later, compared after shifting back.
async function e4() {
  seed = 7; const src = seg(4, perc); const out = [];
  for (const rate of [1, 0.857]) {
    const renders = {};
    for (const k of [0, 37, 64, 101, 128, 1440]) {
      renders[k] = await renderOne(3, async (ctx) => { const n = await mk(ctx); await n.addBuffers([src, src]); n.connect(ctx.destination); n.schedule({ output: 0.5 + k / SR, _ot: 0.5 + k / SR, input: 0, rate, active: true }); });
    }
    const a = Math.round(0.7 * SR), b = Math.round(2.6 * SR); const base = renders[0];
    for (const k of [37, 64, 101, 128, 1440]) {
      const s = renders[k].subarray(k);
      let d = 0; for (let i = a; i < b; i += 1) d += (s[i] - base[i]) ** 2;
      out.push({ rate, shiftFrames: k, env1msCorr: r4(corr(env(base, a, b, 48), env(s, a, b, 48))), env10msCorr: r4(corr(env(base, a, b, 480), env(s, a, b, 480))), normRmsDiff: r4(Math.sqrt(d / (b - a)) / rms(base, a, b)) });
    }
    const again = await renderOne(3, async (ctx) => { const n = await mk(ctx); await n.addBuffers([src, src]); n.connect(ctx.destination); n.schedule({ output: 0.5, _ot: 0.5, input: 0, rate, active: true }); });
    let d = 0; for (let i = a; i < b; i += 1) d = Math.max(d, Math.abs(again[i] - base[i]));
    out.push({ rate, shiftFrames: 0, rerenderMaxAbsDiff: d });
  }
  R.e4 = out;
}

// E5 CPU of active versus scheduled-inactive versus no nodes (10 s offline, wall time)
async function e5() {
  const src = seg(11, sine(330)); const out = [];
  for (const mode of ['none', '8 inactive', '8 active']) {
    const ctx = new OfflineAudioContext(2, 10 * SR, SR);
    if (mode !== 'none') for (let i = 0; i < 8; i += 1) { const n = await mk(ctx); await n.addBuffers([src, src]); n.connect(ctx.destination); if (mode === '8 active') n.schedule({ output: 0, _ot: 0, input: 0, rate: 0.9, active: true }); }
    const t = performance.now(); await ctx.startRendering(); out.push({ mode, wallMsFor10s: r4(performance.now() - t) });
  }
  R.e5 = out;
}


// E6 fast start: voice armed (active, rate 0, frozen at the playhead) vs cold vs warm, with a 21 ms horizon.
async function e6() {
  const out = [];
  for (const [name, fn] of [['tone', sine(440)], ['perc', perc]]) {
    seed = 7; const src = seg(4, fn); const T = 1.0; const s = T - 1024 / SR;
    const run = (mode) => renderOne(1.6, async (ctx) => {
      const n = await mk(ctx); await n.addBuffers([src, src]); n.connect(ctx.destination);
      if (mode === 'armed') n.schedule({ output: 0, input: 2.0, rate: 0, active: true });
      if (mode === 'warm') n.schedule({ output: T - 0.3, input: 1.7, rate: 1, active: true });
      return n;
    }, s, async (n) => { if (mode !== 'warm') await n.schedule({ output: T, input: 2.0, rate: 1, active: true }); });
    const warm = await run('warm');
    for (const mode of ['armed', 'cold']) {
      const y = await run(mode); const a = Math.round(T * SR);
      const ew = env(warm, a, a + 4800, 240), ey = env(y, a, a + 4800, 240);
      out.push({ material: name, mode, horizonMs: r4((T - s) * 1000), env5msDbVsWarm_0to50ms: ey.slice(0, 10).map((v, i) => r4(20 * Math.log10(v / ew[i]))), env5msCorr0to100ms: r4(corr(ew, ey)), rmsBeforeT_10ms: r4(rms(y, a - 480, a)) });
    }
  }
  R.e6 = out;
}

// E7 start horizon sweep: schedule sent H before T; voice active immediately at the position that reaches the playhead at T.
async function e7() {
  const out = [];
  for (const [name, fn] of [['tone', sine(440)], ['perc', perc]]) {
    seed = 7; const src = seg(4, fn); const T = 1.0;
    const warm = await renderOne(1.6, async (ctx) => { const n = await mk(ctx); await n.addBuffers([src, src]); n.connect(ctx.destination); n.schedule({ output: 0, input: 1.0, rate: 1, active: true }); return n; });
    for (const q of [8, 16, 24, 32, 40, 48]) {
      const s = T - q * 128 / SR;
      const y = await renderOne(1.6, async (ctx) => { const n = await mk(ctx); await n.addBuffers([src, src]); n.connect(ctx.destination); return n; }, s,
        async (n) => { await n.schedule({ output: s, input: 2.0 - (T - s), rate: 1, active: true }); });
      const a = Math.round(T * SR); const ew = env(warm, a, a + 2400, 240), ey = env(y, a, a + 2400, 240);
      out.push({ material: name, horizonMs: r4((T - s) * 1000), env5msDbVsSteady_0to25ms: ey.slice(0, 5).map((v, i) => r4(20 * Math.log10(v / ew[i]))) });
    }
  }
  R.e7 = out;
}

try { await e1(); await e2(); await e3(); await e4(); await e5(); await e6(); await e7(); } catch (e) { R.error = String(e.stack || e); }
window.__results = R; window.__done = true;
