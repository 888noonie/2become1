// js/stem-focus.js — OPERATION STUDIO SURGEON, Act I: the Stem-Focus panel.
//
// ONE panel for one stem, opened from a Library or Crate stem row (asset mode)
// or from an Arrangement clip (clip mode). It looks and behaves the same from
// every surface:
//
// - Opening plays nothing, loads no bank and creates no audio engine. The
//   waveform is real: the stored stem file's peaks from the Studio
//   (GET /api/stems/{set}/waveform) or, for a clip, the peaks the Arrangement
//   already computed from the PCM it decoded. Nothing is decoded for the panel.
// - Audition goes through the Studio's ONE preview element (audio.js), so the
//   existing exclusive-play handshake keeps one sound at a time: a Focus
//   preview stops the desk and the Arrangement, and either of those (or a
//   Library preview) stops the Focus preview, which says what interrupted it.
//   The media element streams the stem; no buffer is duplicated.
// - The selected In/Out window bounds what is heard. Loop jumps back to In.
//   Window edges are honoured on animation frames (about 17 ms), not samples:
//   this is an audition, not the render path.
// - Asset mode renames the stem (names only, never media) and hands the chosen
//   window to the Arrangement's own placement. Clip mode drives the existing
//   edit commands of the selected clip through the Arrangement's DawSession,
//   so every change is one undoable step and the stem file never changes.

import { createElement as h, replaceChildren } from './dom.js';
import { roleChip, roleGlyph, roleToken } from './stem-roles.js';
import {
  STEM_NAME_LIMIT, cachedStemCard, cleanStemName, methodLabel, onStemCard, renameStem, roleLabel, withCard,
} from './stem-sleeve.js';

export const EXCLUSIVE_PLAY_EVENT = 'twobecomeone:exclusive-play';
/** The longest window the Focus panel places: the Arrangement cuts 30/60/90 s sections. */
export const FOCUS_PLACE_LIMIT_SEC = 90;
export const SECTION_SECONDS = Object.freeze([30, 60, 90]);
const MIN_WINDOW_SEC = 0.05;
const OWNER_WORDS = { desk: 'the Performance Desk', arrangement: 'the Arrangement' };

/** The only waveform route a stem may have, mirroring its audio route. */
export function stemWaveformPath(stemSetId, role) {
  return `/api/stems/${stemSetId}/waveform?name=${role}`;
}

/** m:ss.t */
export function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** The section the Arrangement cuts for a window: the shortest of 30/60/90 s that holds it. */
export function sectionForWindow(startSec, endSec) {
  const len = endSec - startSec;
  if (!(len > 0) || len > FOCUS_PLACE_LIMIT_SEC + 1e-9) return null;
  return { startSec, seconds: SECTION_SECONDS.find((s) => s >= len - 1e-9), lengthSec: len };
}

/** Peaks from either source as {count, min(i), max(i)} over [0, durationSec]. */
function peakReader(peaks) {
  if (!peaks) return null;
  if (Array.isArray(peaks.peaks)) {
    const p = peaks.peaks;
    return { count: p.length, min: (i) => p[i][0], max: (i) => p[i][1], source: 'stem-file' };
  }
  if (peaks.min && peaks.max) {
    return { count: peaks.min.length, min: (i) => peaks.min[i], max: (i) => peaks.max[i], source: 'decoded-clip' };
  }
  return null;
}

/** A content hash model name (imported stems) reads as its first 12 hex digits. */
const shortModel = (name) => (/^sha256:[0-9a-f]{20,}$/.test(name) ? `${name.slice(0, 19)}…` : name);

let active = null;
// The Studio's ONE preview controller (audio.js), registered by app.js at boot
// so that importing this module never builds an audio element.
let sharedAudio = null;

/** app.js: hand the shared preview controller to every Focus panel. */
export function useFocusAudio(controller) { sharedAudio = controller; }

/** The open Focus panel's handle, or null. */
export function activeStemFocus() { return active; }

/** Close the open Focus panel (focus returns to whatever opened it). */
export function closeStemFocus() { active?.close(); }

/**
 * Open the Stem-Focus panel.
 *
 * Asset mode: {mode: 'asset', stem, api: {patchJson, fetchJson}, trigger,
 *   onPlace?(stem, {startSec, endSec})}
 * Clip mode:  {mode: 'clip', clip: adapter, trigger} — see arrangement-panel
 *   `focusAdapter` for the adapter contract.
 * Shared: {audio?: AudioController (tests), win?: window}
 */
export function openStemFocus(opts) {
  active?.close();
  const win = opts.win ?? window;
  const doc = win.document;
  const audio = opts.audio ?? sharedAudio ?? {
    // No preview controller registered: the panel still opens and says so.
    current: null, time: 0, on: () => () => {}, play() {}, resume() {}, pause() {}, stop() {}, seek() {}, missing: true,
  };
  const mode = opts.mode === 'clip' ? 'clip' : 'asset';
  const adapter = mode === 'clip' ? opts.clip : null;
  const trigger = 'trigger' in opts ? opts.trigger : (doc.activeElement instanceof win.HTMLElement ? doc.activeElement : null);
  const listeners = [];
  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); listeners.push(() => target.removeEventListener(type, fn, o)); };

  // ------------------------------------------------------------ identity
  let stem = mode === 'asset' ? withCard(opts.stem, cachedStemCard(opts.stem.stemSetId)) : adapter.identity();
  const playUrl = () => {
    if (audio.missing || !stem) return null;
    return mode === 'asset' ? (stem.available ? stem.audioUrl : null) : adapter.previewUrl();
  };

  const st = {
    duration: 0, cursor: 0, inSec: 0, outSec: 0, loop: false,
    owning: false, ownOffset: 0, playing: false, selfPause: false, status: '', peaks: null, peaksState: 'loading',
    drag: null, raf: 0, closed: false,
  };

  // ------------------------------------------------------------ DOM
  const titleId = `stem-focus-title-${Date.now().toString(36)}`;
  const glyphHolder = h('span', { class: 'stem-focus__glyph' });
  const title = h('h2', { class: 'stem-focus__title', id: titleId });
  const roleLine = h('p', { class: 'stem-focus__role' });
  const facts = h('dl', { class: 'stem-focus__facts', 'data-field': 'facts' });
  const modeTag = h('span', { class: 'stem-focus__mode', text: mode === 'clip' ? 'Clip in the Arrangement' : 'Library stem' });
  const closeBtn = h('button', { type: 'button', class: 'button button--ghost stem-focus__close', text: 'Close', 'aria-label': 'Close Stem Focus' });

  const canvas = h('canvas', { class: 'stem-focus__canvas', 'aria-hidden': 'true' });
  const waveNote = h('p', { class: 'stem-focus__wave-note', 'data-field': 'wave-note' });
  const wave = h('div', { class: 'stem-focus__wave', 'data-testid': 'focus-wave' }, [canvas]);
  const seek = h('input', { type: 'range', class: 'stem-focus__seek', min: '0', max: '0', step: '0.01', value: '0', 'aria-label': 'Position in the stem' });
  const clock = h('span', { class: 'stem-focus__clock', 'aria-live': 'off', 'data-field': 'clock' });

  const playBtn = h('button', { type: 'button', class: 'button button--primary stem-focus__play', text: 'Play', 'aria-keyshortcuts': 'Space', 'data-focus-action': 'play' });
  const stopBtn = h('button', { type: 'button', class: 'button stem-focus__stop', text: 'Stop', 'data-focus-action': 'stop' });
  const loopBox = h('input', { type: 'checkbox', 'aria-keyshortcuts': 'L' });
  const loopLabel = h('label', { class: 'stem-focus__check' }, [loopBox, 'Loop the selection']);

  const inInput = h('input', { type: 'number', class: 'input stem-focus__num', min: '0', step: '0.01', 'aria-label': 'Selection start (In), seconds' });
  const outInput = h('input', { type: 'number', class: 'input stem-focus__num', min: '0', step: '0.01', 'aria-label': 'Selection end (Out), seconds' });
  const setIn = h('button', { type: 'button', class: 'button button--small', text: 'In here', 'aria-label': 'Set the selection start at the cursor', 'aria-keyshortcuts': 'I' });
  const setOut = h('button', { type: 'button', class: 'button button--small', text: 'Out here', 'aria-label': 'Set the selection end at the cursor', 'aria-keyshortcuts': 'O' });
  const selAll = h('button', { type: 'button', class: 'button button--small button--ghost', text: mode === 'clip' ? 'Clip span' : 'Whole stem' });
  const selLen = h('span', { class: 'stem-focus__sel-len', 'data-field': 'selection' });

  const status = h('p', { class: 'stem-focus__status', role: 'status', 'aria-live': 'polite', 'data-field': 'status' });
  const tools = h('details', { class: 'stem-focus__tools', 'data-testid': 'focus-tools' }, [h('summary', { text: 'Details and tools' })]);
  const toolsBody = h('div', { class: 'stem-focus__tools-body' });
  tools.append(toolsBody);

  const dialog = h('dialog', {
    class: 'stem-focus', 'aria-labelledby': titleId, 'data-mode': mode, 'data-testid': 'stem-focus',
  }, [
    h('div', { class: 'stem-focus__body' }, [
      h('header', { class: 'stem-focus__head' }, [
        glyphHolder,
        h('div', { class: 'stem-focus__id' }, [modeTag, title, roleLine]),
        closeBtn,
      ]),
      facts,
      wave, waveNote,
      h('div', { class: 'stem-focus__transport' }, [playBtn, stopBtn, h('label', { class: 'stem-focus__seek-wrap' }, [h('span', { class: 'sr-only', text: 'Position' }), seek]), clock]),
      h('fieldset', { class: 'stem-focus__window' }, [
        h('legend', { text: 'Selection (heard between In and Out)' }),
        h('label', { class: 'stem-focus__field' }, ['In', inInput, h('span', { class: 'stem-focus__unit', text: 's' })]),
        h('label', { class: 'stem-focus__field' }, ['Out', outInput, h('span', { class: 'stem-focus__unit', text: 's' })]),
        setIn, setOut, selAll, loopLabel, selLen,
      ]),
      status,
      tools,
    ]),
  ]);

  function say(message) {
    st.status = message;
    status.textContent = message;
    opts.announce?.(message);
  }

  // ------------------------------------------------------------ identity view
  function renderIdentity() {
    const t = roleToken(stem?.role);
    dialog.dataset.roleToken = t.token;
    replaceChildren(glyphHolder, [roleGlyph(stem?.role, { size: 28 })]);
    title.textContent = stem ? stem.displayName : 'This clip is gone';
    replaceChildren(roleLine, stem ? [
      roleChip(stem.role, { text: roleLabel(stem.role) }),
      ` ${stem.customName ? 'stem, renamed by you' : 'stem, original role name'} · ${t.signature}`,
    ] : ['It was removed from the arrangement. Close, or Undo to bring it back.']);
    if (!stem) { replaceChildren(facts, []); return; }
    const rows = [
      ['From', stem.trackName ? `“${stem.trackName}”` : (stem.trackId || 'recording not recorded')],
      ['Stem set', stem.stemSetId ? `${stem.stemSetId.slice(0, 8)} · role token ${stem.role}` : 'not a Library stem'],
      ['Method', `${methodLabel(stem.method)}${stem.modelName ? ` · ${shortModel(stem.modelName)}` : ''}`],
      ['Audio', stem.available ? 'stem audio available' : 'stem audio missing'],
    ];
    if (mode === 'clip') {
      const c = adapter.describe();
      if (c) rows.push(['In the arrangement', c]);
    }
    replaceChildren(facts, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  }

  // ------------------------------------------------------------ waveform
  function drawWave() {
    const rect = wave.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const dpr = win.devicePixelRatio || 1;
    const width = Math.max(1, Math.round((rect.width || 600) * dpr));
    const height = Math.max(1, Math.round((rect.height || 120) * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext?.('2d');
    wave.style.setProperty('--focus-in', `${pct(st.inSec)}%`);
    wave.style.setProperty('--focus-out', `${pct(st.outSec)}%`);
    wave.style.setProperty('--focus-cursor', `${pct(st.cursor)}%`);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const reader = peakReader(st.peaks);
    if (!reader || !reader.count) return;
    const color = win.getComputedStyle?.(canvas).color || 'currentColor';
    const mid = height / 2;
    const span = st.peaks.spanSec ?? st.duration;
    for (let x = 0; x < width; x += 1) {
      const t0 = (x / width) * span;
      const t1 = ((x + 1) / width) * span;
      const b0 = Math.floor((t0 / span) * reader.count);
      const b1 = Math.max(b0 + 1, Math.ceil((t1 / span) * reader.count));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b < Math.min(b1, reader.count); b += 1) {
        lo = Math.min(lo, reader.min(b));
        hi = Math.max(hi, reader.max(b));
      }
      const inside = t1 > st.inSec && t0 < st.outSec;
      ctx.globalAlpha = inside ? 1 : 0.35;
      ctx.fillStyle = color;
      ctx.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
    }
    ctx.globalAlpha = 1;
  }
  const pct = (sec) => (st.duration > 0 ? Math.max(0, Math.min(100, (sec / st.duration) * 100)) : 0);

  async function loadPeaks() {
    st.peaksState = 'loading';
    waveNote.textContent = 'Reading the waveform…';
    try {
      let payload;
      if (mode === 'asset') {
        if (!stem.stemSetId) throw new Error('not a Library stem');
        payload = await opts.api.fetchJson(stemWaveformPath(stem.stemSetId, stem.role));
        if (!payload || payload.version !== 1 || !Array.isArray(payload.peaks)) throw new Error('unexpected waveform payload');
        if (Number.isFinite(payload.duration_sec) && payload.duration_sec > 0 && !st.duration) setDuration(payload.duration_sec);
      } else {
        payload = adapter.peaks();
        if (!payload) throw new Error('the Arrangement has not decoded this clip yet');
      }
      if (st.closed) return;
      st.peaks = payload;
      st.peaksState = 'ready';
      wave.dataset.source = peakReader(payload)?.source ?? 'none';
      wave.dataset.bins = String(peakReader(payload)?.count ?? 0);
      waveNote.textContent = mode === 'asset'
        ? 'Waveform: peaks of the stored stem file.'
        : 'Waveform: peaks of the audio the Arrangement decoded for this clip. The bright span is what the clip plays.';
    } catch (err) {
      if (st.closed) return;
      st.peaksState = 'unavailable';
      wave.dataset.source = 'none';
      waveNote.textContent = `No waveform: ${err?.message || 'unavailable'}. Audition still works from the controls.`;
    }
    drawWave();
  }

  // ------------------------------------------------------------ time state
  function setDuration(sec) {
    st.duration = Math.max(0, sec);
    seek.max = String(st.duration);
    inInput.max = String(st.duration);
    outInput.max = String(st.duration);
    if (!(st.outSec > st.inSec)) {
      const span = mode === 'clip' ? adapter.sourceSpan() : null;
      st.inSec = span ? span.startSec : 0;
      st.outSec = span ? span.endSec : st.duration;
    }
    st.outSec = Math.min(st.outSec, st.duration);
    renderTime();
  }

  function setWindow(inSec, outSec, { from = null } = {}) {
    let a = Math.max(0, Math.min(st.duration, Number(inSec)));
    let b = Math.max(0, Math.min(st.duration, Number(outSec)));
    if (!Number.isFinite(a) || !Number.isFinite(b)) { renderTime(); return; }
    // A field edit keeps the endpoint the user typed. A drag may go either way.
    if (b < a && !from) [a, b] = [b, a];
    if (b - a < MIN_WINDOW_SEC) {
      if (from === 'out') {
        b = Math.min(st.duration, Math.max(b, MIN_WINDOW_SEC));
        a = Math.max(0, b - MIN_WINDOW_SEC);
      } else {
        a = Math.max(0, Math.min(a, st.duration - MIN_WINDOW_SEC));
        b = a + Math.min(st.duration, MIN_WINDOW_SEC);
      }
    }
    st.inSec = a;
    st.outSec = b;
    const position = st.playing && ours() ? localTime() : st.cursor;
    if (position < a || position >= b) {
      st.cursor = a;
      if (ours()) seekLocal(a);
    }
    renderTime();
    renderTools();
  }

  function renderTime() {
    seek.value = String(st.cursor);
    seek.setAttribute('aria-valuetext', `${fmtTime(st.cursor)} of ${fmtTime(st.duration)}`);
    clock.textContent = `${fmtTime(st.cursor)} / ${fmtTime(st.duration)}`;
    if (doc.activeElement !== inInput) inInput.value = st.inSec.toFixed(2);
    if (doc.activeElement !== outInput) outInput.value = st.outSec.toFixed(2);
    selLen.textContent = `Selection ${fmtTime(st.inSec)}–${fmtTime(st.outSec)} · ${(st.outSec - st.inSec).toFixed(2)} s`;
    playBtn.textContent = st.playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', st.playing ? 'true' : 'false');
    playBtn.disabled = !playUrl() || !stem;
    stopBtn.disabled = !st.owning && !(mode === 'clip' && adapter.arrangementPlaying?.());
    if (mode === 'clip') {
      const split = toolsBody.querySelector('[data-focus-action="split"]');
      if (split) split.disabled = adapter.beatAtSource(st.cursor) === null;
    }
    drawWave();
  }

  // ------------------------------------------------------------ audition
  const ours = () => {
    const cur = audio.current;
    return Boolean(cur && cur.url === st.ownUrl);
  };

  const localTime = () => Math.max(0, audio.time - st.ownOffset);
  const seekLocal = (sec) => audio.seek(st.ownOffset + sec);

  function tick() {
    st.raf = 0;
    if (!st.playing || st.closed) return;
    if (!ours()) { lose('another preview'); return; }
    const t = localTime();
    st.cursor = t;
    if (st.duration && t >= st.outSec - 0.005) reachOut();
    renderTime();
    if (st.playing) st.raf = win.requestAnimationFrame(tick);
  }

  function parkAtIn() {
    st.playing = false;
    st.cursor = st.inSec;
    if (ours()) {
      audio.pause();
      seekLocal(st.inSec);
    }
  }

  function reachOut() {
    if (st.loop) {
      // Native end may win the race against the animation frame. A seek
      // alone would leave the ended player paused (or replay from zero).
      const needsResume = !audio.playing;
      st.cursor = st.inSec;
      seekLocal(st.inSec);
      if (needsResume) audio.resume();
    } else {
      parkAtIn();
      say('Reached Out. Play starts again from In.');
    }
  }

  function startTicking() {
    if (!st.raf && win.requestAnimationFrame) st.raf = win.requestAnimationFrame(tick);
  }

  function play() {
    let url = playUrl();
    if (!url || !stem) return;
    let offset = 0;
    if (mode === 'clip') {
      adapter.stopArrangement?.();
      const source = new URL(url, win.location.href);
      if (source.searchParams.has('start') && source.searchParams.has('duration')) {
        // Section WAV responses have no Range support. Audition the same
        // source through its seekable full URL, keeping the UI section-local.
        offset = Number(source.searchParams.get('start'));
        source.searchParams.delete('start');
        source.searchParams.delete('duration');
        url = source.pathname + source.search;
      }
    }
    const from = st.cursor >= st.inSec && st.cursor < st.outSec - 0.01 ? st.cursor : st.inSec;
    st.cursor = from;
    if (ours() && st.ownUrl === url) {
      st.ownOffset = offset;
      seekLocal(from);
      audio.resume();
    } else {
      audio.play({ kind: 'stem', url, trackId: stem.trackId ?? null, stemName: stem.role, title: `${stem.displayName} · ${roleLabel(stem.role)}` });
      st.ownUrl = url;
      st.ownOffset = offset;
      seekLocal(from);
    }
    st.owning = true;
    st.playing = true;
    say(mode === 'clip'
      ? `Playing this clip's source audio from ${fmtTime(from)} in the shared preview, at its own speed and level (no clip gain, fades, speed or pitch). The desk and the Arrangement stop while it plays.`
      : `Playing ${stem.displayName} from ${fmtTime(from)} in the shared preview. The desk and the Arrangement stop while it plays.`);
    renderTime();
    startTicking();
  }

  function pause() {
    if (!st.playing) return;
    st.selfPause = true;
    audio.pause();
    st.selfPause = false;
    st.playing = false;
    st.cursor = localTime();
    say(`Paused at ${fmtTime(st.cursor)}.`);
    renderTime();
  }

  function stop({ quiet = false } = {}) {
    if (mode === 'clip' && adapter.arrangementPlaying?.()) adapter.stopArrangement();
    parkAtIn();
    st.owning = false;
    if (!quiet) say('Stopped. The cursor is back at In.');
    renderTime();
  }

  function lose(byWhom) {
    if (!st.playing && !st.owning) return;
    st.playing = false;
    st.owning = ours();
    say(`Paused: ${byWhom} started playing. One sound plays at a time; press Play to take the preview back.`);
    renderTime();
  }

  listeners.push(audio.on((type, payload) => {
    if (st.closed) return;
    if (type === 'play' && payload?.url !== st.ownUrl && (st.playing || st.owning || st.lostToStop)) {
      // A new preview first stops the old one (audio.js), so the 'stop' may come first.
      st.lostToStop = false;
      st.playing = true;
      st.owning = false;
      lose(payload?.kind === 'stem' ? 'another stem preview' : 'the Library preview');
    } else if (type === 'pause' && st.playing && !st.selfPause) {
      lose('another Studio sound');
    } else if (type === 'ended' && st.playing && ours() && !audio.playing) {
      reachOut();
      renderTime();
      if (st.playing) startTicking();
    } else if (type === 'duration' && ours() && !st.duration && Number.isFinite(payload) && payload > 0) {
      setDuration(payload);
    } else if (type === 'error' && st.owning) {
      st.playing = false;
      say('The stem audio could not be played. Nothing was changed.');
      renderTime();
    } else if (type === 'stop' && st.ownUrl) {
      st.ownUrl = null;
      st.lostToStop = st.playing;
      st.playing = false;
      st.owning = false;
      if (st.lostToStop) say('Stopped by another Studio sound. Press Play to take the preview back.');
      renderTime();
    }
  }));
  on(win, EXCLUSIVE_PLAY_EVENT, (ev) => {
    const owner = ev.detail?.owner;
    if (owner && owner !== 'preview' && OWNER_WORDS[owner] && (st.playing || st.status.startsWith('Paused: another'))) {
      st.playing = false;
      say(`Paused: ${OWNER_WORDS[owner]} started playing. One sound plays at a time; press Play to take the preview back.`);
      renderTime();
    }
  });

  // ------------------------------------------------------------ pointer + keys
  function secAt(clientX) {
    const r = wave.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.max(0, Math.min(st.duration, ((clientX - r.left) / r.width) * st.duration));
  }
  on(wave, 'pointerdown', (ev) => {
    if (!st.duration) return;
    ev.preventDefault();
    const at = secAt(ev.clientX);
    st.drag = { from: at, moved: false };
    try { wave.setPointerCapture?.(ev.pointerId); } catch { /* still follows */ }
  });
  on(wave, 'pointermove', (ev) => {
    if (!st.drag) return;
    const at = secAt(ev.clientX);
    if (Math.abs(at - st.drag.from) > Math.max(0.05, st.duration / 400)) st.drag.moved = true;
    if (st.drag.moved) setWindow(Math.min(st.drag.from, at), Math.max(st.drag.from, at));
  });
  const endDrag = (ev) => {
    if (!st.drag) return;
    const d = st.drag;
    st.drag = null;
    if (d.moved) { say(`Selected ${fmtTime(st.inSec)}–${fmtTime(st.outSec)}.`); return; }
    moveCursor(secAt(ev.clientX));
  };
  on(wave, 'pointerup', endDrag);
  on(wave, 'pointercancel', () => { st.drag = null; });

  function moveCursor(sec) {
    st.cursor = Math.max(0, Math.min(st.duration, sec));
    if (st.playing && ours()) {
      if (st.cursor < st.inSec || st.cursor >= st.outSec) st.cursor = st.inSec;
      seekLocal(st.cursor);
    }
    renderTime();
  }

  on(seek, 'input', () => moveCursor(Number(seek.value)));
  on(playBtn, 'click', () => (st.playing ? pause() : play()));
  on(stopBtn, 'click', () => stop());
  on(loopBox, 'change', () => { st.loop = loopBox.checked; say(st.loop ? 'Loop on: Out jumps back to In.' : 'Loop off: playback stops at Out.'); });
  on(inInput, 'change', () => setWindow(Number(inInput.value), st.outSec, { from: 'in' }));
  on(outInput, 'change', () => setWindow(st.inSec, Number(outInput.value), { from: 'out' }));
  on(setIn, 'click', () => { setWindow(st.cursor, Math.max(st.outSec, st.cursor + MIN_WINDOW_SEC), { from: 'in' }); say(`In set at ${fmtTime(st.inSec)}.`); });
  on(setOut, 'click', () => { setWindow(Math.min(st.inSec, st.cursor - MIN_WINDOW_SEC), st.cursor, { from: 'out' }); say(`Out set at ${fmtTime(st.outSec)}.`); });
  on(selAll, 'click', () => {
    const span = mode === 'clip' ? adapter.sourceSpan() : null;
    setWindow(span ? span.startSec : 0, span ? span.endSec : st.duration);
    say(mode === 'clip' ? 'Selected the span this clip plays.' : 'Selected the whole stem.');
  });

  const typing = (t) => t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)) || t.isContentEditable);
  on(dialog, 'keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
    const k = ev.key;
    if (k === ' ' && !(ev.target.tagName === 'BUTTON' || ev.target.tagName === 'SUMMARY')) { ev.preventDefault(); if (st.playing) pause(); else play(); }
    else if (k === 'i' || k === 'I') { ev.preventDefault(); setIn.click(); }
    else if (k === 'o' || k === 'O') { ev.preventDefault(); setOut.click(); }
    else if (k === 'l' || k === 'L') { ev.preventDefault(); loopBox.click(); }
  });

  // ------------------------------------------------------------ tools
  function asset_tools() {
    const nameInput = h('input', {
      type: 'text', class: 'input', maxlength: String(STEM_NAME_LIMIT * 2), value: stem.customName ? stem.displayName : '',
      placeholder: roleLabel(stem.role), 'aria-label': `Name for the ${roleLabel(stem.role)} stem`, 'data-focus-field': 'name',
    });
    const save = h('button', { type: 'submit', class: 'button button--small button--primary', text: 'Save name' });
    const original = stem.customName ? h('button', { type: 'button', class: 'button button--small button--ghost', text: 'Original name' }) : null;
    const form = h('form', { class: 'stem-focus__rename' }, [h('label', { class: 'stem-focus__field' }, ['Name', nameInput]), save, original]);
    const commit = async (value) => {
      let name = null;
      if (value !== null) {
        const cleaned = cleanStemName(value);
        if (!cleaned.ok) { say(cleaned.reason); nameInput.focus(); return; }
        name = cleaned.value;
      }
      save.disabled = true;
      try {
        await renameStem(opts.api.patchJson, stem, name);
        say(name === null ? `${roleLabel(stem.role)} stem uses its original name again. The audio file is unchanged.` : `Renamed to “${name}”. The audio file is unchanged.`);
        renderTools();
        toolsBody.querySelector('[data-focus-field="name"]')?.focus();
      } catch (err) {
        say(`Could not rename: ${err?.message || 'request failed'}. Nothing changed.`);
        save.disabled = false;
      }
    };
    form.addEventListener('submit', (ev) => { ev.preventDefault(); void commit(nameInput.value); });
    original?.addEventListener('click', () => void commit(null));

    const section = sectionForWindow(st.inSec, st.outSec);
    const place = h('button', {
      type: 'button', class: 'button button--primary', text: 'Place selection in Arrangement', 'data-focus-action': 'place',
      disabled: section && stem.available && opts.onPlace ? undefined : 'true',
    });
    const placeWhy = h('p', { class: 'stem-focus__hint', 'data-field': 'place-why', text: !stem.available
      ? 'This stem has no audio file to place.'
      : !section
        ? `A selection longer than ${FOCUS_PLACE_LIMIT_SEC} s cannot be placed from here; the Arrangement cuts sections of 30, 60 or 90 s. Use Place a Library stem with Full length in the Arrangement.`
        : `Places ${(section.lengthSec).toFixed(2)} s from ${fmtTime(section.startSec)} as one clip, at its own speed, on the lane and bar you choose next. Nothing plays and no clip moves.` });
    place.addEventListener('click', () => {
      if (!section) return;
      stop({ quiet: true });
      const handed = opts.onPlace(stem, { startSec: st.inSec, endSec: st.outSec });
      if (handed !== false) close();
    });
    return [
      h('section', { class: 'stem-focus__tool' }, [h('h3', { text: 'Rename' }), form,
        h('p', { class: 'stem-focus__hint', text: 'Only the name changes. The role, the stem set and the audio file stay as they are.' })]),
      h('section', { class: 'stem-focus__tool' }, [h('h3', { text: 'Arrangement' }), place, placeWhy]),
      h('section', { class: 'stem-focus__tool' }, [h('h3', { text: 'Not available here' }),
        h('p', { class: 'stem-focus__hint', text: 'Trim, slip, split, gain, fades and stretch belong to a clip. Place the selection, then open Focus on the clip in the Arrangement. The stored stem is never edited.' })]),
    ];
  }

  function clip_tools() {
    const c = adapter.clip();
    if (!c) return [h('p', { class: 'stem-focus__hint', text: 'The clip is no longer in the arrangement. Undo brings it back.' })];
    const lim = adapter.limits();
    const actions = adapter.actions;
    const btn = (text, fn, extra = {}) => h('button', { type: 'button', class: 'button button--small', text, onclick: fn, ...extra });
    const report = (outcome, done) => { if (outcome?.ok) say(done); else if (outcome) say(`Not changed: ${outcome.error?.message || 'the edit was refused'}.`); };
    const range = (label, { min, max, step, value, fmt, key, build }) => {
      const out = h('output', { class: 'stem-focus__out', text: fmt(value) });
      const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, 'aria-valuetext': fmt(value) });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        input.setAttribute('aria-valuetext', fmt(v));
        st.rangeActive = true;
        adapter.apply(build(v), key);
      });
      input.addEventListener('change', () => { st.rangeActive = false; adapter.endGesture(); renderTools(); });
      return h('label', { class: 'stem-focus__range' }, [h('span', { text: label }), input, out]);
    };
    const span = adapter.sourceSpan();
    const fadeMax = adapter.fadeMax();
    return [
      h('section', { class: 'stem-focus__tool' }, [h('h3', { text: 'Edit this clip' }),
        h('div', { class: 'stem-focus__row' }, [
          btn('Trim clip to selection', () => report(adapter.trimToSource(st.inSec, st.outSec), `Trimmed: the clip now plays ${fmtTime(st.inSec)}–${fmtTime(st.outSec)} of its source. Undo restores it.`), { 'data-focus-action': 'trim' }),
          btn('Split at cursor', () => report(adapter.splitAtBeat(adapter.beatAtSource(st.cursor)), 'Split at the cursor into two clips. Undo joins them.'), {
            'data-focus-action': 'split', disabled: adapter.beatAtSource(st.cursor) === null ? 'true' : undefined,
          }),
        ]),
        h('p', { class: 'stem-focus__hint', text: `Trim keeps the clip where it starts on its lane and changes which part of the stem it plays. Split needs the cursor inside the span the clip plays (${fmtTime(span.startSec)}–${fmtTime(span.endSec)}).` }),
        range('Clip gain', { min: lim.gainMin, max: lim.gainMax, step: 0.5, value: c.clipGainDb, fmt: (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`, key: `focus-gain:${c.id}`, build: (v) => ({ name: 'setClipGain', args: { clipId: c.id, gainDb: v } }) }),
        range('Fade in', { min: 0, max: fadeMax, step: 1 / 64, value: Math.min(c.fadeInBeats, fadeMax), fmt: (v) => `${Number(v).toFixed(2)} beats`, key: `focus-fin:${c.id}`, build: (v) => ({ name: 'setClipFades', args: { clipId: c.id, fadeInBeats: v, fadeOutBeats: adapter.clip()?.fadeOutBeats ?? c.fadeOutBeats } }) }),
        range('Fade out', { min: 0, max: fadeMax, step: 1 / 64, value: Math.min(c.fadeOutBeats, fadeMax), fmt: (v) => `${Number(v).toFixed(2)} beats`, key: `focus-fout:${c.id}`, build: (v) => ({ name: 'setClipFades', args: { clipId: c.id, fadeInBeats: adapter.clip()?.fadeInBeats ?? c.fadeInBeats, fadeOutBeats: v } }) }),
      ]),
      h('section', { class: 'stem-focus__tool' }, [h('h3', { text: 'Time' }),
        h('div', { class: 'stem-focus__row' }, [
          btn(c.stretchMode === 'beat_sync' ? 'Following project tempo' : 'Fit to project tempo', () => report(actions.fitTempo(), 'The clip follows the project tempo (pitch kept). Undo returns its speed.'), {
            disabled: adapter.tempoKnown() && c.stretchMode !== 'beat_sync' ? undefined : 'true',
          }),
          btn('Hear it in place', () => { stop({ quiet: true }); adapter.hearInPlace(); say('The Arrangement plays from this clip\'s start, with every lane. Stop here stops it.'); renderTime(); }, { 'data-focus-action': 'hear-in-place' }),
        ]),
        h('p', { class: 'stem-focus__hint', text: adapter.tempoKnown()
          ? 'Speed and pitch use the Arrangement\'s own stretch, set in the clip inspector; the Focus preview plays the source at its own speed.'
          : 'The source tempo is unknown, so Fit to project tempo is off. Enter the source BPM in the clip inspector first.' }),
      ]),
      h('section', { class: 'stem-focus__tool' }, [h('h3', { text: 'Clipboard and history' }),
        h('div', { class: 'stem-focus__row' }, [
          btn('Cut', () => { actions.cut(); close(); }), btn('Copy', () => { actions.copy(); say('Copied the clip. Paste in the Arrangement.'); }),
          btn('Duplicate', () => report(actions.duplicate(), 'Duplicated after the clip.')),
          btn('Delete', () => { actions.delete(); close(); }, { class: 'button button--small button--danger' }),
        ]),
        h('div', { class: 'stem-focus__row' }, [
          btn('Undo', () => { if (actions.undo()) say('Undone.'); }, { 'aria-keyshortcuts': 'Control+Z', disabled: actions.canUndo() ? undefined : 'true', 'data-focus-action': 'undo' }),
          btn('Redo', () => { if (actions.redo()) say('Redone.'); }, { 'aria-keyshortcuts': 'Control+Shift+Z', disabled: actions.canRedo() ? undefined : 'true' }),
        ]),
        h('p', { class: 'stem-focus__hint', text: 'Every change here is one step in the Arrangement\'s own undo history. The stem file is never changed.' }),
      ]),
    ];
  }

  function renderTools() {
    if (st.closed) return;
    const open = tools.open;
    const keep = doc.activeElement && toolsBody.contains(doc.activeElement)
      ? (doc.activeElement.dataset?.focusAction ?? doc.activeElement.getAttribute('aria-label') ?? doc.activeElement.textContent)
      : null;
    if (st.rangeActive) return; // a slider drag in progress: rebuilt when it ends
    replaceChildren(toolsBody, stem ? (mode === 'asset' ? asset_tools() : clip_tools()) : []);
    tools.open = open;
    if (keep) {
      const back = [...toolsBody.querySelectorAll('button, input')].find((el) => (el.dataset?.focusAction ?? el.getAttribute('aria-label') ?? el.textContent) === keep);
      if (back && !back.disabled) back.focus();
    }
  }

  // ------------------------------------------------------------ live updates
  if (mode === 'asset') {
    listeners.push(onStemCard((card) => {
      if (st.closed || card?.stem_set_id !== stem.stemSetId) return;
      stem = withCard(stem, card);
      renderIdentity();
      renderTools();
    }));
  } else {
    listeners.push(adapter.onChange(() => {
      if (st.closed) return;
      stem = adapter.identity();
      const span = stem ? adapter.sourceSpan() : null;
      if (span && Math.abs(span.durationSec - st.duration) > 1e-6) setDuration(span.durationSec);
      renderIdentity();
      renderTools();
      renderTime();
    }));
  }

  // ------------------------------------------------------------ open / close
  function close() {
    if (st.closed) return;
    st.closed = true;
    if (st.raf) win.cancelAnimationFrame?.(st.raf);
    if (ours()) { st.selfPause = true; audio.stop(); st.selfPause = false; }
    for (const off of listeners.splice(0)) { try { off(); } catch { /* already gone */ } }
    if (dialog.open) dialog.close();
    dialog.remove();
    if (active === handle) active = null;
    // A re-render behind the panel (a rename updates the row) rebuilds the
    // button that opened it: find its successor by the same data-key.
    const sameKey = !trigger?.isConnected && trigger?.dataset?.key
      ? [...doc.querySelectorAll('[data-key]')].find((el) => el.dataset.key === trigger.dataset.key) ?? null
      : null;
    const back = trigger?.isConnected ? trigger : sameKey ?? opts.fallbackFocus?.();
    back?.focus?.();
    opts.onClose?.();
  }
  on(closeBtn, 'click', () => close());
  on(dialog, 'cancel', (ev) => { ev.preventDefault(); close(); });
  on(dialog, 'close', () => close());
  // Canvas pixels are not recoloured by forced colours: redraw when it changes.
  const forced = win.matchMedia?.('(forced-colors: active)');
  if (forced?.addEventListener) on(forced, 'change', () => drawWave());
  if (win.ResizeObserver) {
    const ro = new win.ResizeObserver(() => drawWave());
    ro.observe(wave);
    listeners.push(() => ro.disconnect());
  }

  const handle = {
    el: dialog, mode, close,
    state: () => ({ ...st, stem }),
    play, pause, stop, setWindow, moveCursor,
  };
  active = handle;

  (doc.getElementById('dialog-layer') ?? doc.body).appendChild(dialog);
  dialog.showModal();
  renderIdentity();
  if (mode === 'clip') {
    const span = adapter.sourceSpan();
    if (span) setDuration(span.durationSec);
    st.cursor = st.inSec;
  }
  renderTime();
  renderTools();
  playBtn.focus();
  say(mode === 'clip'
    ? 'Nothing is playing. Play auditions the clip\'s source in the shared preview; Hear it in place plays the Arrangement.'
    : 'Nothing is playing. Drag across the waveform to select, or set In and Out.');
  void loadPeaks();
  return handle;
}
