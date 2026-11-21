// js/components/arrangement-panel.js — the Studio arrangement editor.
//
// OPERATION FULL HOUSE. The musician's eight-lane, non-linear working surface:
// A Vocals/Drums/Bass/Other (copper) and B Vocals/Drums/Bass/Other (aqua) on a
// bars-and-beats ruler, with real waveform peaks, clip move/trim/split/
// duplicate/delete/gain/fades/stretch/pitch, track gain/pan/mute/solo/EQ, a
// master level, Play/Pause/Stop/Seek/Loop on the Clockwork transport, Undo/
// Redo, Save/Open and Export.
//
// Every change goes through DawSession.apply -> EditEngine (one validated,
// atomic, undoable ProjectState). This file only reads that state and turns
// pointer and keyboard gestures into commands. Nothing here plays sound by
// itself: the AudioContext is created by the Play button.

import { createElement as h, replaceChildren } from '../dom.js';
import {
  DawSession, GROUP_BASE, ROLES, ROLE_LABEL, SAMPLE_RATE, peaksFor,
} from '../arrangement/daw-session.js';
import {
  MAX_CLIP_GAIN_DB, MAX_EQ_GAIN_DB, MAX_PITCH_SEMITONES, MAX_VOLUME_DB,
  MIN_CLIP_GAIN_DB, MIN_EQ_GAIN_DB, MIN_PITCH_SEMITONES, MIN_VOLUME_DB,
  MAX_AUTOMATION_POINTS,
} from '../arrangement/project-state.js';
import { dbToLinear } from '../arrangement/render-plan.js';
import {
  MIN_CLIP_DURATION_BEATS, beatsToSourceSeconds, slipLimitsSec, sourceAdvanceRate,
} from '../arrangement/time-math.js';

export const ZOOM_LEVELS = Object.freeze([6, 10, 16, 24, 36, 54, 80, 120]); // px per beat
export const SNAP_CHOICES = Object.freeze([
  ['bar', 'Bar'], ['1', 'Beat'], ['0.5', '½ beat'], ['0.25', '¼ beat'], ['0.125', '⅛ beat'], ['off', 'Off'],
]);
const LANE_HEIGHT = 64;
/** Same event the Performance desk fires: one Studio instrument sounds at a time. */
export const EXCLUSIVE_PLAY_EVENT = 'twobecomeone:exclusive-play';
const SECTION_CHOICES = Object.freeze([['30', '30 s'], ['60', '60 s'], ['90', '90 s'], ['full', 'Full length']]);

function fmtDb(db) { return `${db > 0 ? '+' : ''}${Number(db).toFixed(1)} dB`; }
function fmtPan(p) {
  if (Math.abs(p) < 0.005) return 'C';
  return `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`;
}
function fmtBeats(b) {
  const r = Math.round(b * 1000) / 1000;
  return `${r} beat${r === 1 ? '' : 's'}`;
}

const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const roundNs = (v) => Math.round(v * 1e9) / 1e9;

/** bar · beat · tick (960 ticks per beat), 1-based like every DAW ruler. */
export function formatPosition(beat, beatsPerBar) {
  const safe = Math.max(0, beat);
  const bar = Math.floor(safe / beatsPerBar) + 1;
  const inBar = safe - (bar - 1) * beatsPerBar;
  const b = Math.floor(inBar) + 1;
  const tick = Math.floor((inBar - Math.floor(inBar)) * 960);
  return `${bar} · ${b} · ${String(tick).padStart(3, '0')}`;
}

function withSection(url, start, seconds) {
  const [path, query = ''] = String(url).split('?');
  const params = new URLSearchParams(query);
  params.set('start', String(start));
  params.set('duration', String(seconds));
  return `${path}?${params.toString()}`;
}

/** The four isolated stems of a track (Demucs or owner-imported), or null. */
export function completeQuad(variants) {
  const usable = (variants ?? []).filter((v) => v && ROLES.includes(v.name) && v.audio_url);
  const bySet = new Map();
  for (const v of usable) {
    const key = v.stem_set_id ?? 'set';
    if (!bySet.has(key)) bySet.set(key, new Map());
    bySet.get(key).set(v.name, v);
  }
  for (const set of bySet.values()) {
    if (ROLES.every((r) => set.has(r))) return ROLES.map((r) => set.get(r));
  }
  return null;
}

/**
 * @param {object} opts {container, onAnnounce?, session? (tests inject one),
 *   sessionDeps?, listTracks, listStems, saveFile?, producer?}
 */
export function mountArrangementPanel(opts) {
  const { container, onAnnounce = () => {} } = opts;
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const listeners = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };

  const ui = {
    zoomIndex: 3,
    snap: '0.25',
    selectedClipId: null,
    selectedTrack: 0,
    lastLoop: null,
    drag: null,
    envDrag: null,
    selectedPoint: null,
    rafId: null,
    tracks: [],
    disposed: false,
  };

  let session = opts.session ?? null;
  const onChange = (kind) => {
    if (ui.disposed) return;
    if (kind === 'transport') { renderTransport(); startPlayheadLoop(); return; }
    if (ui.envDrag) {
      paintLiveEnvelope(ui.envDrag.trackIndex);
      renderInspector();
      return;
    }
    render();
  };
  const onMessage = (entry) => {
    if (ui.disposed) return;
    renderMessages();
    if (entry.kind === 'error' || entry.kind === 'refused') onAnnounce(`${entry.code}: ${entry.message}`);
  };
  if (session) {
    session.deps.onChange = onChange;
    session.deps.onMessage = onMessage;
  } else {
    session = new DawSession({ ...opts.sessionDeps, onChange, onMessage });
  }

  const esc = (value) => (win.CSS?.escape ? win.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
  const pxPerBeat = () => ZOOM_LEVELS[ui.zoomIndex];
  const beatsPerBar = () => session.state.transport.timeSignature[0];
  const snapBeats = () => (ui.snap === 'off' ? 0 : ui.snap === 'bar' ? beatsPerBar() : Number(ui.snap));
  const snap = (beat, force = false) => {
    const g = snapBeats();
    if (!g || force === 'off') return Math.max(0, beat);
    return Math.max(0, Math.round(beat / g) * g);
  };
  const clipById = (id) => session.state.clips.find((c) => c.id === id) ?? null;
  const trackGroup = (i) => (i < 4 ? 'A' : 'B');

  // ------------------------------------------------------------- skeleton

  const root = h('section', {
    class: 'daw', 'aria-label': 'Arrangement', 'data-testid': 'arrangement',
  });

  // Transport row
  const playBtn = h('button', { type: 'button', class: 'button daw__play', 'aria-label': 'Play', text: 'Play' });
  const pauseBtn = h('button', { type: 'button', class: 'button', 'aria-label': 'Pause', text: 'Pause' });
  const stopBtn = h('button', { type: 'button', class: 'button daw__stop', 'aria-label': 'Stop', text: 'Stop' });
  const posMain = h('strong', { class: 'daw__pos-main', 'data-field': 'position', text: '1 · 1 · 000' });
  const posSec = h('span', { class: 'daw__pos-sec', 'data-field': 'seconds', text: '0:00.00 heard' });
  const phaseText = h('span', { class: 'daw__phase', 'data-field': 'phase', text: 'audio off' });
  const readout = h('div', { class: 'daw__readout', role: 'status', 'aria-live': 'off' }, [posMain, posSec, phaseText]);
  const bpmInput = h('input', {
    type: 'number', min: '30', max: '300', step: '0.01', class: 'daw__bpm', 'aria-label': 'Project tempo (BPM)',
  });
  const snapSelect = h('select', { 'aria-label': 'Snap' }, SNAP_CHOICES.map(([v, t]) => h('option', { value: v, text: t })));
  snapSelect.value = ui.snap;
  const zoomOut = h('button', { type: 'button', class: 'button button--small', 'aria-label': 'Zoom out', text: '−' });
  const zoomIn = h('button', { type: 'button', class: 'button button--small', 'aria-label': 'Zoom in', text: '+' });
  const zoomText = h('span', { class: 'daw__chip-text', 'data-field': 'zoom' });
  const loopBtn = h('button', { type: 'button', class: 'button daw__chip', 'aria-pressed': 'false', 'aria-label': 'Loop' });
  const undoBtn = h('button', { type: 'button', class: 'button', text: 'Undo', 'aria-keyshortcuts': 'Control+Z' });
  const redoBtn = h('button', { type: 'button', class: 'button', text: 'Redo', 'aria-keyshortcuts': 'Control+Shift+Z' });
  const masterRange = h('input', {
    type: 'range', min: String(MIN_VOLUME_DB), max: String(MAX_VOLUME_DB), step: '0.5', 'aria-label': 'Master level (exported)',
  });
  const masterOut = h('output', { class: 'daw__value' });
  const monitorRange = h('input', { type: 'range', min: '-48', max: '0', step: '1', 'aria-label': 'Listening level (not exported)' });
  const monitorOut = h('output', { class: 'daw__value' });

  const transport = h('div', { class: 'daw__transport', role: 'group', 'aria-label': 'Transport' }, [
    h('div', { class: 'daw__transport-buttons' }, [playBtn, pauseBtn, stopBtn]),
    readout,
    h('label', { class: 'daw__field' }, ['Tempo', bpmInput, h('span', { class: 'daw__unit', text: 'BPM' })]),
    h('label', { class: 'daw__field' }, ['Snap', snapSelect]),
    h('div', { class: 'daw__field daw__zoom', role: 'group', 'aria-label': 'Zoom' }, ['Zoom', zoomOut, zoomText, zoomIn]),
    loopBtn,
    h('div', { class: 'daw__history', role: 'group', 'aria-label': 'Edit history' }, [undoBtn, redoBtn]),
  ]);

  const levels = h('div', { class: 'daw__levels' }, [
    h('label', { class: 'daw__field' }, ['Master', masterRange, masterOut]),
    h('label', { class: 'daw__field daw__field--quiet' }, ['Listening level', monitorRange, monitorOut]),
  ]);

  // Project row
  const nameInput = h('input', { type: 'text', class: 'daw__name', maxlength: '120', 'aria-label': 'Arrangement name' });
  const saveBtn = h('button', { type: 'button', class: 'button', text: 'Save' });
  const openSelect = h('select', { 'aria-label': 'Saved arrangements' }, [h('option', { value: '', text: 'Open saved…' })]);
  const openBtn = h('button', { type: 'button', class: 'button', text: 'Open' });
  const newBtn = h('button', { type: 'button', class: 'button', text: 'New' });
  const exportBtn = h('button', { type: 'button', class: 'button button--primary', text: 'Export WAV' });
  const saveState = h('span', { class: 'daw__save-state', 'data-field': 'save-state' });
  const projectRow = h('div', { class: 'daw__project', role: 'group', 'aria-label': 'Project' }, [
    nameInput, saveBtn, openSelect, openBtn, newBtn, exportBtn, saveState, levels,
  ]);

  // Import ("Bring in stems")
  const importRows = {};
  const importBox = h('details', { class: 'daw__import' }, [h('summary', { text: 'Bring in stems' })]);
  const importNote = h('p', {
    class: 'daw__note',
    text: 'Each track brings its four separated stems onto its four lanes (A: lanes 1–4, B: lanes 5–8). Separate a new track on the Performance desk first. A section is decoded at 48 kHz within the desk’s memory limits; Full length uses the higher limit.',
  });
  importBox.append(importNote);
  for (const group of ['A', 'B']) {
    const select = h('select', { 'aria-label': `Track for ${group}` }, [h('option', { value: '', text: 'Choose a track…' })]);
    const section = h('select', { 'aria-label': `Section length for ${group}` },
      SECTION_CHOICES.map(([v, t]) => h('option', { value: v, text: t })));
    section.value = '60';
    const start = h('input', { type: 'number', min: '0', max: '3600', step: '1', value: '0', 'aria-label': `Section start for ${group} (seconds)` });
    const go = h('button', { type: 'button', class: `button daw__bring daw__bring--${group}`, text: `Bring in ${group}` });
    importRows[group] = { select, section, start, go };
    importBox.append(h('div', { class: `daw__import-row daw__import-row--${group}` }, [
      h('span', { class: 'daw__bank', text: group }), select,
      h('label', { class: 'daw__field' }, ['Length', section]),
      h('label', { class: 'daw__field' }, ['From', start, h('span', { class: 'daw__unit', text: 's' })]),
      go,
    ]));
  }

  // Timeline: headers | scroller(ruler + lanes)
  const headers = h('div', { class: 'daw__headers', role: 'list', 'aria-label': 'Tracks' });
  const ruler = h('div', { class: 'daw__ruler', 'aria-label': 'Ruler: click to cue, drag to set the loop', role: 'slider', tabindex: '0', 'aria-valuemin': '0' });
  const loopBand = h('div', { class: 'daw__loop-band', hidden: 'true' });
  const cueMark = h('div', { class: 'daw__cue', 'aria-hidden': 'true' });
  ruler.append(loopBand);
  const lanes = h('div', { class: 'daw__lanes' });
  const playhead = h('div', { class: 'daw__playhead', 'aria-hidden': 'true' });
  const content = h('div', { class: 'daw__content' }, [ruler, lanes, cueMark, playhead]);
  const scroller = h('div', { class: 'daw__scroller', tabindex: '-1' }, [content]);
  const headerCorner = h('div', { class: 'daw__corner', text: 'Tracks' });
  const timeline = h('div', { class: 'daw__timeline' }, [
    h('div', { class: 'daw__header-col' }, [headerCorner, headers]), scroller,
  ]);
  // One quiet line under the timeline that names what the pointer is over.
  const hintLine = h('p', { class: 'daw__tip', 'data-field': 'hint', role: 'note' });
  const timelineWrap = h('div', { class: 'daw__timeline-wrap' }, [timeline, hintLine]);

  // Inspector + producer
  const inspector = h('aside', { class: 'daw__inspector', 'aria-label': 'Inspector' });
  const producerMount = h('div', { class: 'daw__producer' });
  const side = h('div', { class: 'daw__side' }, [inspector, producerMount]);

  const messages = h('ul', { class: 'daw__messages', role: 'log', 'aria-live': 'polite', 'aria-label': 'Arrangement messages' });
  const honesty = h('p', {
    class: 'daw__note',
    text: 'Every lane starts on one clock. A shared start is not beat matching: a clip follows the project tempo only after Fit to project tempo, using its track’s measured tempo.',
  });

  root.append(
    h('div', { class: 'daw__top' }, [transport]),
    projectRow,
    importBox,
    h('div', { class: 'daw__body' }, [timelineWrap, side]),
    honesty,
    messages,
  );
  container.replaceChildren(root);

  // ------------------------------------------------------------- render

  function renderTransport() {
    const phase = session.phase();
    root.dataset.phase = phase;
    phaseText.textContent = phase;
    const active = ['starting', 'playing', 'seeking'].includes(phase);
    playBtn.setAttribute('aria-pressed', String(active));
    playBtn.disabled = phase === 'preparing';
    updatePlayhead();
  }

  function updatePlayhead() {
    const beat = session.playheadBeat();
    const x = beat * pxPerBeat();
    playhead.style.transform = `translateX(${x}px)`;
    const cueBeat = session.cueBeat;
    cueMark.style.transform = `translateX(${cueBeat * pxPerBeat()}px)`;
    posMain.textContent = formatPosition(beat, beatsPerBar());
    const sec = beat * (60 / session.bpm);
    const m = Math.floor(sec / 60);
    posSec.textContent = `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')} heard`;
    ruler.setAttribute('aria-valuenow', String(Math.round(beat * 100) / 100));
    ruler.setAttribute('aria-valuetext', `bar ${formatPosition(beat, beatsPerBar())}`);
    return x;
  }

  function startPlayheadLoop() {
    if (ui.rafId !== null || ui.disposed) return;
    const step = () => {
      ui.rafId = null;
      if (ui.disposed) return;
      const x = updatePlayhead();
      if (session.isPlaying()) {
        // Follow the heard position: page the view when the playhead leaves it.
        const left = scroller.scrollLeft;
        const width = scroller.clientWidth;
        if (width > 0 && !ui.drag && (x < left || x > left + width - 40)) scroller.scrollLeft = Math.max(0, x - 80);
        ui.rafId = win.requestAnimationFrame(step);
      } else if (session.phase() === 'stopping' || session.phase() === 'preparing') {
        ui.rafId = win.requestAnimationFrame(step);
      }
    };
    ui.rafId = win.requestAnimationFrame(step);
  }

  function drawWaveform(canvas, clip, widthPx) {
    const asset = session.state.assets[clip.assetId];
    const peaks = asset ? peaksFor(asset.bufferReference) : null;
    const ratio = Math.min(win.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.min(8192, Math.round(widthPx * ratio)));
    const hgt = Math.max(8, Math.round((canvas.clientHeight || LANE_HEIGHT - 22) * ratio));
    canvas.width = w;
    canvas.height = hgt;
    const g = canvas.getContext?.('2d');
    if (!g || !peaks) return;
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = getComputedStyle(canvas).color || '#ccc';
    let rate;
    try { rate = sourceAdvanceRate(clip, asset, session.bpm); } catch { rate = 1; }
    const spb = 60 / session.bpm;
    const srcStart = clip.sourceOffsetSec * SAMPLE_RATE;
    const srcSpan = clip.durationBeats * spb * rate * SAMPLE_RATE;
    const mid = hgt / 2;
    const lin = 10 ** (clip.clipGainDb / 20);
    const dur = clip.durationBeats;
    // The drawn height is what will sound: clip gain times the linear fade
    // envelope the engine and the bounce both apply.
    const envAt = (frac) => {
      const beat = frac * dur;
      let e = 1;
      if (clip.fadeInBeats > 0) e = Math.min(e, beat / clip.fadeInBeats);
      if (clip.fadeOutBeats > 0) e = Math.min(e, (dur - beat) / clip.fadeOutBeats);
      return clampTo(e, 0, 1);
    };
    const line = [];
    for (let px = 0; px < w; px += 1) {
      const a = Math.floor((srcStart + (px / w) * srcSpan) / peaks.bucketFrames);
      const b = Math.max(a + 1, Math.floor((srcStart + ((px + 1) / w) * srcSpan) / peaks.bucketFrames));
      let lo = 0;
      let hi = 0;
      for (let i = a; i < b && i < peaks.min.length; i += 1) {
        if (peaks.min[i] < lo) lo = peaks.min[i];
        if (peaks.max[i] > hi) hi = peaks.max[i];
      }
      const gain = lin * envAt((px + 0.5) / w);
      const top = mid - Math.min(1, hi * gain) * mid;
      const bot = mid - Math.max(-1, lo * gain) * mid;
      g.fillRect(px, top, 1, Math.max(1, bot - top));
      line.push(mid - Math.min(1, gain) * mid);
    }
    // Envelope outline: the loudest a full-scale sample could be here.
    g.globalAlpha = 0.85;
    g.beginPath();
    line.forEach((y, px) => { if (px === 0) g.moveTo(px, y + 0.5); else g.lineTo(px, y + 0.5); });
    g.lineWidth = Math.max(1, ratio);
    g.strokeStyle = g.fillStyle;
    g.stroke();
    g.globalAlpha = 1;
  }

  /** Redraw one clip's waveform from `clip` fields (a live gesture preview). */
  function previewWave(el, clip) {
    const canvas = el?.querySelector('canvas');
    if (canvas) drawWaveform(canvas, clip, el.offsetWidth || 4);
  }

  function clipEl(clip) {
    const ppb = pxPerBeat();
    const asset = session.state.assets[clip.assetId];
    const group = trackGroup(clip.trackIndex);
    const left = clip.timelineStartBeat * ppb;
    const width = Math.max(4, clip.durationBeats * ppb);
    const selected = clip.id === ui.selectedClipId;
    const canvas = h('canvas', { class: 'daw__wave', 'aria-hidden': 'true' });
    const fadeIn = h('div', { class: 'daw__fade daw__fade--in', style: { width: `${clip.fadeInBeats * ppb}px` }, 'aria-hidden': 'true' });
    const fadeOut = h('div', { class: 'daw__fade daw__fade--out', style: { width: `${clip.fadeOutBeats * ppb}px` }, 'aria-hidden': 'true' });
    const stretched = clip.stretchMode === 'beat_sync' || clip.customStretchRatio !== 1;
    const badges = [
      stretched ? (clip.stretchMode === 'beat_sync' ? 'tempo' : `×${clip.customStretchRatio}`) : null,
      clip.pitchSemitones ? `${clip.pitchSemitones > 0 ? '+' : ''}${clip.pitchSemitones} st` : null,
      clip.clipGainDb && !(selected && width >= 96) ? fmtDb(clip.clipGainDb) : null, // the gain grip shows it when selected
    ].filter(Boolean).join(' · ');
    const el = h('div', {
      class: `daw__clip daw__clip--${group}${selected ? ' is-selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-pressed': String(selected),
      'aria-label': `${asset?.name ?? clip.id}, bar ${formatPosition(clip.timelineStartBeat, beatsPerBar())}, ${fmtBeats(clip.durationBeats)}`,
      dataset: { clipId: clip.id },
      style: { left: `${left}px`, width: `${width}px` },
    }, [
      h('span', { class: 'daw__clip-label', text: `${session.state.tracks[clip.trackIndex].name}${badges ? ` · ${badges}` : ''}` }),
      canvas, fadeIn, fadeOut,
      h('span', { class: 'daw__handle daw__handle--start', dataset: { grip: 'start' }, 'aria-hidden': 'true' }),
      h('span', { class: 'daw__handle daw__handle--end', dataset: { grip: 'end' }, 'aria-hidden': 'true' }),
      h('span', { class: 'daw__fade-grip daw__fade-grip--in', dataset: { grip: 'fadeIn' }, title: 'Fade in: drag to set how long the sound takes to come in', 'aria-hidden': 'true' }),
      h('span', { class: 'daw__fade-grip daw__fade-grip--out', dataset: { grip: 'fadeOut' }, title: 'Fade out: drag to set how long the sound takes to go', 'aria-hidden': 'true' }),
      h('span', { class: 'daw__gain-grip', dataset: { grip: 'gain' }, title: 'Clip gain: drag up or down (Alt for fine). Track level is separate.', 'aria-hidden': 'true', text: fmtDb(clip.clipGainDb), hidden: width < 96 ? 'true' : undefined }),
      h('span', { class: 'daw__slip-grip', dataset: { grip: 'slip' }, title: 'Slip: drag to choose which part of the stem plays here. The clip does not move.', 'aria-hidden': 'true' }),
    ]);
    el.title = 'Drag to move this clip. Shift-drag slips the audio inside it. Drag its edges to trim.';
    win.requestAnimationFrame(() => drawWaveform(canvas, clip, width));
    return el;
  }

  let producerPreview = () => [];
  let producerHandle = null;

  function dropEnvelopePreview(trackIndex) {
    if (typeof producerHandle?.dropEnvelopePreview === 'function') {
      producerHandle.dropEnvelopePreview(trackIndex);
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const linearFloor = () => dbToLinear(MIN_VOLUME_DB);
  const linearCeil = () => dbToLinear(MAX_VOLUME_DB);

  function linearToY(lin, height) {
    const pad = 8;
    const t = (lin - linearFloor()) / (linearCeil() - linearFloor());
    return (height - pad) - Math.min(1, Math.max(0, t)) * (height - pad * 2);
  }

  function yToOffsetDb(y, track, height) {
    const pad = 8;
    const t = ((height - pad) - y) / (height - pad * 2);
    const lin = linearFloor() + Math.min(1, Math.max(0, t)) * (linearCeil() - linearFloor());
    const absolute = 20 * Math.log10(Math.max(lin, linearFloor()));
    return clampTo(absolute - track.volumeDb, MIN_VOLUME_DB, MAX_VOLUME_DB);
  }

  function pointLinear(track, point) {
    const absolute = clampTo(track.volumeDb + point.db, MIN_VOLUME_DB, MAX_VOLUME_DB);
    return dbToLinear(absolute);
  }

  /** Vertices in linear amplitude, so a straight stroke is the sound. */
  function curveVertices(track, width) {
    const height = LANE_HEIGHT;
    const stored = track.gainPoints ?? [];
    if (!stored.length) {
      const y = linearToY(dbToLinear(track.volumeDb), height);
      return [{ x: 0, y }, { x: width, y }];
    }
    const sorted = stored.map((point, index) => ({ point, index }))
      .sort((a, b) => (a.point.beat - b.point.beat) || (a.index - b.index));
    const xOf = (beat) => beat * pxPerBeat();
    const verts = [];
    const first = sorted[0].point;
    const last = sorted[sorted.length - 1].point;
    if (first.beat > 0) verts.push({ x: 0, y: linearToY(pointLinear(track, first), height) });
    for (const row of sorted) {
      verts.push({
        x: xOf(row.point.beat),
        y: linearToY(pointLinear(track, row.point), height),
        index: row.index,
      });
    }
    verts.push({ x: Math.max(width, xOf(last.beat)), y: linearToY(pointLinear(track, last), height) });
    return verts;
  }

  function envelopeLayer(track, width) {
    const height = LANE_HEIGHT;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'daw__env');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('aria-hidden', 'true');
    const poly = doc.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('class', `daw__env-line daw__env-line--${trackGroup(track.trackIndex)}`);
    poly.setAttribute('fill', 'none');
    const verts = curveVertices(track, width);
    poly.setAttribute('points', verts.map((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' '));
    svg.append(poly);
    const layer = h('div', {
      class: 'daw__env-layer',
      dataset: { track: String(track.trackIndex) },
    }, [svg]);
    (track.gainPoints ?? []).forEach((point, index) => {
      const absolute = clampTo(track.volumeDb + point.db, MIN_VOLUME_DB, MAX_VOLUME_DB);
      const selected = ui.selectedPoint?.trackIndex === track.trackIndex && ui.selectedPoint?.index === index;
      const handle = h('button', {
        type: 'button',
        class: `daw__env-handle daw__env-handle--${trackGroup(track.trackIndex)}${selected ? ' is-selected' : ''}`,
        style: {
          left: `${point.beat * pxPerBeat()}px`,
          top: `${linearToY(pointLinear(track, point), height)}px`,
        },
        title: `${formatPosition(point.beat, beatsPerBar())}, ${fmtDb(absolute)} absolute`,
        'aria-label': `Level point ${formatPosition(point.beat, beatsPerBar())}, ${fmtDb(absolute)} absolute`,
        dataset: { track: String(track.trackIndex), index: String(index), envPoint: '1' },
      });
      layer.append(handle);
    });
    return layer;
  }

  function paintLiveEnvelope(trackIndex) {
    const row = lanes.querySelector(`.daw__lane[data-track="${trackIndex}"]`);
    const track = session.state.tracks[trackIndex];
    if (!row || !track) return;
    const width = parseFloat(content.style.width) || row.clientWidth || 1;
    const next = envelopeLayer(track, width);
    const prev = row.querySelector('.daw__env-layer');
    if (prev) prev.replaceWith(next);
    else row.prepend(next);
  }

  function distToSegment(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  /**
   * Hit the curve only when the pointer is not on a clip grip. Fade, slip,
   * trim, and move handles stay in charge; this returns null for those.
   */
  function envelopeHit(ev) {
    if (ev.target.closest?.('.daw__clip') || ev.target.closest?.('[data-grip]')) return null;
    const handle = ev.target.closest?.('.daw__env-handle');
    if (handle) {
      return {
        kind: 'point',
        trackIndex: Number(handle.dataset.track),
        index: Number(handle.dataset.index),
      };
    }
    const laneEl = ev.target.closest?.('.daw__lane');
    if (!laneEl) return null;
    const trackIndex = Number(laneEl.dataset.track);
    const track = session.state.tracks[trackIndex];
    if (!track) return null;
    const width = parseFloat(content.style.width) || laneEl.clientWidth || 1;
    const rect = laneEl.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const verts = curveVertices(track, width);
    let nearest = null;
    for (const vert of verts) {
      if (vert.index == null) continue;
      const d = Math.hypot(x - vert.x, y - vert.y);
      if (d <= 10 && (!nearest || d < nearest.d)) nearest = { d, index: vert.index };
    }
    if (nearest) return { kind: 'point', trackIndex, index: nearest.index };
    let best = Infinity;
    for (let i = 1; i < verts.length; i += 1) best = Math.min(best, distToSegment(x, y, verts[i - 1], verts[i]));
    if (best > 10) return null;
    return {
      kind: 'add',
      trackIndex,
      beat: Math.max(0, x / pxPerBeat()),
      db: yToOffsetDb(y, track, LANE_HEIGHT),
    };
  }

  function beginEnvelopeDrag(hit, ev) {
    const track = session.state.tracks[hit.trackIndex];
    let points = (track.gainPoints ?? []).map((p) => ({ beat: p.beat, db: p.db }));
    let index = hit.index;
    if (hit.kind === 'add') {
      if (points.length >= MAX_AUTOMATION_POINTS) {
        session.apply({
          name: 'setTrackGainEnvelope',
          args: { trackIndex: hit.trackIndex, points: [...points, { beat: hit.beat, db: hit.db }] },
        });
        return;
      }
      points = [...points, { beat: hit.beat, db: hit.db }];
      index = points.length - 1;
    }
    ui.selectedPoint = { trackIndex: hit.trackIndex, index };
    ui.selectedTrack = hit.trackIndex;
    ui.envDrag = { trackIndex: hit.trackIndex, index, pointerId: ev.pointerId };
    const outcome = session.apply({
      name: 'setTrackGainEnvelope',
      args: { trackIndex: hit.trackIndex, points },
    }, `gain-envelope-${hit.trackIndex}`);
    if (!outcome.ok) ui.envDrag = null;
    else dropEnvelopePreview(hit.trackIndex);
  }

  function nudgeSelectedPoint(key) {
    const sel = ui.selectedPoint;
    if (!sel) return;
    const track = session.state.tracks[sel.trackIndex];
    const points = (track.gainPoints ?? []).map((p) => ({ beat: p.beat, db: p.db }));
    const point = points[sel.index];
    if (!point) return;
    if (key === 'ArrowLeft') point.beat = Math.max(0, point.beat - 0.25);
    if (key === 'ArrowRight') point.beat += 0.25;
    if (key === 'ArrowUp') point.db = Math.min(MAX_VOLUME_DB, point.db + 1);
    if (key === 'ArrowDown') point.db = Math.max(MIN_VOLUME_DB, point.db - 1);
    const outcome = session.apply({
      name: 'setTrackGainEnvelope',
      args: { trackIndex: sel.trackIndex, points },
    });
    if (outcome.ok) dropEnvelopePreview(sel.trackIndex);
  }

  function deleteSelectedPoint() {
    const sel = ui.selectedPoint;
    if (!sel) return;
    const track = session.state.tracks[sel.trackIndex];
    const points = (track.gainPoints ?? []).filter((_, i) => i !== sel.index);
    ui.selectedPoint = null;
    const outcome = session.apply({
      name: 'setTrackGainEnvelope',
      args: { trackIndex: sel.trackIndex, points },
    });
    if (outcome.ok) dropEnvelopePreview(sel.trackIndex);
  }

  function selectedPointLine(track) {
    const sel = ui.selectedPoint;
    if (!sel || sel.trackIndex !== track.trackIndex) return null;
    const point = track.gainPoints?.[sel.index];
    if (!point) return null;
    const absolute = clampTo(track.volumeDb + point.db, MIN_VOLUME_DB, MAX_VOLUME_DB);
    return h('p', {
      class: 'daw__ins-sub',
      text: `Point ${formatPosition(point.beat, beatsPerBar())}, ${fmtDb(absolute)} absolute`,
    });
  }

  function renderLanes() {
    const ppb = pxPerBeat();
    const bpb = beatsPerBar();
    const endBeat = Math.max(session.arrangementEndBeat() + 8 * bpb, 32 * bpb);
    const width = Math.ceil(endBeat * ppb);
    content.style.width = `${width}px`;
    // Ruler ticks: every bar labelled; beats ticked when there is room.
    const ticks = [];
    const labelEvery = ppb * bpb < 36 ? Math.ceil(36 / (ppb * bpb)) : 1;
    for (let bar = 0; bar * bpb <= endBeat; bar += 1) {
      const x = bar * bpb * ppb;
      if (bar % labelEvery === 0) ticks.push(h('span', { class: 'daw__bar', style: { left: `${x}px` }, text: String(bar + 1) }));
      if (ppb >= 10) {
        for (let b = 1; b < bpb; b += 1) ticks.push(h('span', { class: 'daw__beat', style: { left: `${x + b * ppb}px` } }));
      }
    }
    replaceChildren(ruler, [loopBand, ...ticks]);
    const loop = session.state.transport.loopRange;
    loopBand.hidden = !loop;
    if (loop) {
      loopBand.style.left = `${loop[0] * ppb}px`;
      loopBand.style.width = `${(loop[1] - loop[0]) * ppb}px`;
    }
    content.style.setProperty('--bar-px', `${bpb * ppb}px`);
    content.style.setProperty('--beat-px', `${ppb}px`);
    const rows = session.state.tracks.map((track) => {
      const row = h('div', {
        class: `daw__lane daw__lane--${trackGroup(track.trackIndex)}${ui.selectedTrack === track.trackIndex ? ' is-selected' : ''}`,
        dataset: { track: String(track.trackIndex) },
        role: 'group',
        'aria-label': `Lane ${track.name}`,
      });
      row.append(envelopeLayer(track, width));
      for (const clip of session.state.clips) if (clip.trackIndex === track.trackIndex) row.append(clipEl(clip));
      for (const ghost of producerPreview()) {
        if (ghost.trackIndex !== track.trackIndex) continue;
        row.append(h('div', {
          class: `daw__ghost daw__ghost--${trackGroup(track.trackIndex)}`,
          dataset: { ghostFor: ghost.clipId },
          style: { left: `${ghost.startBeat * ppb}px`, width: `${Math.max(4, ghost.durationBeats * ppb)}px` },
          title: 'The Producer’s idea: press Hear it to play it here',
        }, [h('span', { class: 'daw__ghost-label', text: `Idea · ${ghost.label}` })]));
      }
      return row;
    });
    const focused = doc.activeElement?.dataset?.clipId;
    replaceChildren(lanes, rows);
    if (focused) lanes.querySelector(`[data-clip-id="${esc(focused)}"]`)?.focus({ preventScroll: true });
  }

  function renderHeaders() {
    const anySolo = session.state.tracks.some((t) => t.solo);
    replaceChildren(headers, session.state.tracks.map((track) => {
      const i = track.trackIndex;
      const group = trackGroup(i);
      const mute = h('button', {
        type: 'button', class: 'daw__ms', 'aria-pressed': String(track.mute), 'aria-label': `Mute ${track.name}`, text: 'M',
      });
      const solo = h('button', {
        type: 'button', class: 'daw__ms', 'aria-pressed': String(track.solo), 'aria-label': `Solo ${track.name}`, text: 'S',
      });
      mute.addEventListener('click', () => session.apply({ name: 'setTrackMute', args: { trackIndex: i, mute: !track.mute } }));
      solo.addEventListener('click', () => session.apply({ name: 'setTrackSolo', args: { trackIndex: i, solo: !track.solo } }));
      const vol = h('input', {
        type: 'range', min: String(MIN_VOLUME_DB), max: String(MAX_VOLUME_DB), step: '0.5',
        value: String(track.volumeDb), 'aria-label': `${track.name} level`, class: 'daw__head-fader',
      });
      bindGesture(vol, `vol:${i}`, (v) => ({ name: 'setTrackVolume', args: { trackIndex: i, volumeDb: v } }));
      const audible = anySolo ? track.solo : !track.mute;
      const head = h('div', {
        class: `daw__head daw__head--${group}${ui.selectedTrack === i ? ' is-selected' : ''}${audible ? '' : ' is-silent'}`,
        role: 'listitem',
      }, [
        h('button', { type: 'button', class: 'daw__head-name', 'aria-label': `Select ${track.name}`, dataset: { trackSelect: String(i) } }, [
          h('span', { class: 'daw__head-index', text: `TRACK ${i + 1} · ${group}` }),
          h('strong', { text: track.name }),
        ]),
        h('div', { class: 'daw__head-ms' }, [mute, solo]),
        vol,
      ]);
      head.querySelector('.daw__head-name').addEventListener('click', () => { ui.selectedTrack = i; ui.selectedClipId = null; render(); });
      return head;
    }));
  }

  /** A range bound to one command; a drag is one undo step. */
  function bindGesture(input, key, build) {
    input.addEventListener('input', () => {
      const outcome = session.apply(build(Number(input.value)), key);
      if (outcome?.ok && key.startsWith('vol:')) dropEnvelopePreview(Number(key.slice(4)));
    });
    input.addEventListener('change', () => { session.endGesture(); });
  }

  function rangeRow(label, { min, max, step, value, format, key, build, hint }) {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
    const out = h('output', { class: 'daw__value', text: format(value) });
    input.addEventListener('input', () => { out.textContent = format(Number(input.value)); });
    bindGesture(input, key, build);
    return h('label', { class: 'daw__row' }, [h('span', { class: 'daw__row-label', text: label }), input, out, hint ? h('span', { class: 'daw__hint', text: hint }) : null]);
  }

  function renderInspector() {
    const clip = ui.selectedClipId ? clipById(ui.selectedClipId) : null;
    if (clip) return renderClipInspector(clip);
    const i = ui.selectedTrack;
    const track = session.state.tracks[i];
    const group = trackGroup(i);
    replaceChildren(inspector, [
      h('h3', { class: `daw__ins-title daw__ins-title--${group}`, text: `Track · ${track.name}` }),
      h('p', { class: 'daw__ins-sub', text: `Lane ${i + 1} · bank ${group}. Select a clip to edit it.` }),
      selectedPointLine(track),
      rangeRow('Level', {
        min: MIN_VOLUME_DB, max: MAX_VOLUME_DB, step: 0.5, value: track.volumeDb, format: fmtDb,
        key: `vol:${i}`, build: (v) => ({ name: 'setTrackVolume', args: { trackIndex: i, volumeDb: v } }),
      }),
      rangeRow('Pan', {
        min: -1, max: 1, step: 0.01, value: track.pan, format: fmtPan,
        key: `pan:${i}`, build: (v) => ({ name: 'setTrackPan', args: { trackIndex: i, pan: v } }),
      }),
      ...[['lowGainDb', 'EQ low (250 Hz shelf)'], ['midGainDb', 'EQ mid (1 kHz)'], ['highGainDb', 'EQ high (4 kHz shelf)']].map(([band, label]) => rangeRow(label, {
        min: MIN_EQ_GAIN_DB, max: MAX_EQ_GAIN_DB, step: 0.5, value: track.eq[band], format: fmtDb,
        key: `eq:${i}:${band}`, build: (v) => ({ name: 'setTrackEq', args: { trackIndex: i, eq: { [band]: v } } }),
      })),
      h('div', { class: 'daw__ins-actions' }, [
        h('button', {
          type: 'button', class: 'button', 'aria-pressed': String(track.mute), text: track.mute ? 'Unmute' : 'Mute',
          onclick: () => session.apply({ name: 'setTrackMute', args: { trackIndex: i, mute: !track.mute } }),
        }),
        h('button', {
          type: 'button', class: 'button', 'aria-pressed': String(track.solo), text: track.solo ? 'Unsolo' : 'Solo',
          onclick: () => session.apply({ name: 'setTrackSolo', args: { trackIndex: i, solo: !track.solo } }),
        }),
        h('button', {
          type: 'button', class: 'button', text: 'Reset EQ',
          onclick: () => session.apply({ name: 'setTrackEq', args: { trackIndex: i, eq: { lowGainDb: 0, midGainDb: 0, highGainDb: 0 } } }),
        }),
      ]),
    ]);
  }

  const fmtFade = (v) => `${fmtBeats(v)} · ${(v * 60 / session.bpm).toFixed(2)} s`;

  function renderClipInspector(clip) {
    const asset = session.state.assets[clip.assetId];
    const group = trackGroup(clip.trackIndex);
    const bpb = beatsPerBar();
    const src = asset?.source ?? {};
    let rate = 1;
    try { rate = sourceAdvanceRate(clip, asset, session.bpm); } catch { /* unknown tempo */ }
    const tempoKnown = asset?.nativeBpm != null;
    const fadeMax = Math.max(MIN_CLIP_DURATION_BEATS, Math.min(clip.durationBeats, 16));
    const ratioInput = h('input', {
      type: 'number', min: '0.25', max: '4', step: '0.01', value: String(Math.round(rate * 1000) / 1000),
      'aria-label': 'Speed (source seconds per second; pitch is kept)',
    });
    const applyRatio = h('button', { type: 'button', class: 'button button--small', text: 'Apply speed' });
    applyRatio.addEventListener('click', () => {
      const v = Number(ratioInput.value);
      session.apply({ name: 'stretchClipKeepingSource', args: { clipId: clip.id, ratioOrAuto: v } });
    });
    const fit = h('button', {
      type: 'button', class: 'button', text: clip.stretchMode === 'beat_sync' ? 'Following project tempo' : 'Fit to project tempo',
      disabled: tempoKnown && clip.stretchMode !== 'beat_sync' ? undefined : 'true',
    });
    fit.addEventListener('click', () => session.apply({ name: 'stretchClipKeepingSource', args: { clipId: clip.id, ratioOrAuto: 'auto' } }));
    const tempoEntry = h('input', {
      type: 'number', min: '20', max: '400', step: '0.01', value: tempoKnown ? String(asset.nativeBpm) : '',
      placeholder: 'BPM', 'aria-label': 'Source tempo (BPM)',
    });
    tempoEntry.addEventListener('change', () => {
      const v = Number(tempoEntry.value);
      if (Number.isFinite(v) && v > 0) session.apply({ name: 'setAssetTempo', args: { assetId: clip.assetId, nativeBpm: v } });
    });
    // Slip (source in-point): which part of the stem fills this clip.
    const lim = asset ? slipLimitsSec(clip, asset, session.bpm) : { min: 0, max: 0 };
    const inPoint = h('input', {
      type: 'number', min: '0', max: String(lim.max), step: '0.001', value: clip.sourceOffsetSec.toFixed(3),
      'aria-label': 'Source in-point (seconds)',
    });
    inPoint.addEventListener('change', () => {
      const v = Number(inPoint.value);
      if (!Number.isFinite(v)) render();
      else if (Math.abs(v - (clipById(clip.id)?.sourceOffsetSec ?? v)) > 5e-10) session.apply({ name: 'slipClip', args: { clipId: clip.id, sourceOffsetSec: v } });
    });
    const slipEarlier = h('button', { type: 'button', class: 'button button--small', text: '◀ Earlier', 'aria-label': 'Slip source earlier', 'aria-keyshortcuts': ',', onclick: () => slipSelectedBy(-1) });
    const slipLater = h('button', { type: 'button', class: 'button button--small', text: 'Later ▶', 'aria-label': 'Slip source later', 'aria-keyshortcuts': '.', onclick: () => slipSelectedBy(1) });
    const stemBeats = tempoKnown ? (clip.sourceOffsetSec * asset.nativeBpm) / 60 : null;
    const slipFacts = [
      h('dt', { text: 'Plays from' }),
      h('dd', { text: `${clip.sourceOffsetSec.toFixed(3)} s · frame ${Math.round(clip.sourceOffsetSec * SAMPLE_RATE)}` }),
      h('dt', { text: 'In the stem' }),
      h('dd', { text: stemBeats === null ? 'tempo unknown' : `bar ${formatPosition(stemBeats, bpb).split(' · ').slice(0, 2).join(' · beat ')} at ${asset.nativeBpm} BPM` }),
      h('dt', { text: 'Room to slip' }),
      h('dd', { text: lim.max <= 0 ? 'none: trim the end first' : `${clip.sourceOffsetSec.toFixed(2)} s earlier · ${(lim.max - clip.sourceOffsetSec).toFixed(2)} s later` }),
    ];
    const formants = h('input', { type: 'checkbox', 'aria-label': 'Keep formants' });
    formants.checked = clip.preserveFormants;
    formants.addEventListener('change', () => session.apply({ name: 'setClipPitch', args: { clipId: clip.id, semitones: clip.pitchSemitones, preserveFormants: formants.checked } }));
    const tempoText = tempoKnown
      ? `${asset.nativeBpm} BPM (${asset.nativeBpmSource === 'owner' ? 'entered' : 'measured'})`
      : 'unknown';

    replaceChildren(inspector, [
      h('h3', { class: `daw__ins-title daw__ins-title--${group}`, text: `Clip · ${session.state.tracks[clip.trackIndex].name}` }),
      h('p', { class: 'daw__ins-sub', text: [src.title, src.method, src.stemSetId ? `set ${String(src.stemSetId).slice(0, 8)}` : null, `lane ${clip.trackIndex + 1}`].filter(Boolean).join(' · ') }),
      h('dl', { class: 'daw__facts' }, [
        h('dt', { text: 'Starts' }), h('dd', { text: `bar ${formatPosition(clip.timelineStartBeat, bpb)}` }),
        h('dt', { text: 'Length' }), h('dd', { text: `${(clip.durationBeats / bpb).toFixed(2)} bars` }),
        h('dt', { text: 'Source tempo' }), h('dd', { text: tempoText }),
      ]),
      h('fieldset', { class: 'daw__group daw__group--slip' }, [
        h('legend', { text: 'Source in-point (slip)' }),
        h('dl', { class: 'daw__facts' }, slipFacts),
        lim.max > 0 ? rangeRow('Slip', {
          min: 0, max: lim.max, step: 0.001, value: clip.sourceOffsetSec, format: (v) => `${v.toFixed(3)} s`,
          key: `slip:${clip.id}`, build: (v) => ({ name: 'slipClip', args: { clipId: clip.id, sourceOffsetSec: v } }),
        }) : null,
        h('label', { class: 'daw__row' }, [h('span', { class: 'daw__row-label', text: 'In-point' }), inPoint, h('span', { class: 'daw__unit', text: 's' })]),
        h('div', { class: 'daw__ins-actions' }, [slipEarlier, slipLater]),
        h('p', { class: 'daw__hint', text: `Changes which audio plays. The clip stays at bar ${formatPosition(clip.timelineStartBeat, bpb).split(' · ')[0]} and keeps its length.` }),
      ]),
      rangeRow('Gain', {
        min: MIN_CLIP_GAIN_DB, max: MAX_CLIP_GAIN_DB, step: 0.5, value: clip.clipGainDb, format: fmtDb,
        key: `gain:${clip.id}`, build: (v) => ({ name: 'setClipGain', args: { clipId: clip.id, gainDb: v } }),
      }),
      rangeRow('Fade in', {
        min: 0, max: fadeMax / 2, step: 1 / 64, value: Math.min(clip.fadeInBeats, fadeMax / 2), format: fmtFade,
        key: `fadein:${clip.id}`, build: (v) => ({ name: 'setClipFades', args: { clipId: clip.id, fadeInBeats: v, fadeOutBeats: clipById(clip.id)?.fadeOutBeats ?? clip.fadeOutBeats } }),
      }),
      rangeRow('Fade out', {
        min: 0, max: fadeMax / 2, step: 1 / 64, value: Math.min(clip.fadeOutBeats, fadeMax / 2), format: fmtFade,
        key: `fadeout:${clip.id}`, build: (v) => ({ name: 'setClipFades', args: { clipId: clip.id, fadeInBeats: clipById(clip.id)?.fadeInBeats ?? clip.fadeInBeats, fadeOutBeats: v } }),
      }),
      h('fieldset', { class: 'daw__group' }, [
        h('legend', { text: 'Time (pitch kept)' }),
        h('div', { class: 'daw__ins-actions' }, [fit]),
        h('label', { class: 'daw__row' }, [h('span', { class: 'daw__row-label', text: 'Speed ×' }), ratioInput, applyRatio]),
        h('label', { class: 'daw__row' }, [h('span', { class: 'daw__row-label', text: 'Source BPM' }), tempoEntry]),
      ]),
      h('fieldset', { class: 'daw__group' }, [
        h('legend', { text: 'Pitch (time kept)' }),
        rangeRow('Semitones', {
          min: MIN_PITCH_SEMITONES, max: MAX_PITCH_SEMITONES, step: 1, value: clip.pitchSemitones, format: (v) => `${v > 0 ? '+' : ''}${v} st`,
          key: `pitch:${clip.id}`, build: (v) => ({ name: 'setClipPitch', args: { clipId: clip.id, semitones: v, preserveFormants: clipById(clip.id)?.preserveFormants ?? clip.preserveFormants } }),
        }),
        h('label', { class: 'daw__check' }, [formants, 'Keep formants (Signalsmith formant compensation)']),
      ]),
      h('div', { class: 'daw__ins-actions' }, [
        h('button', { type: 'button', class: 'button', text: 'Cue at clip start', onclick: () => session.seek(clip.timelineStartBeat) }),
        h('button', { type: 'button', class: 'button', text: 'Split at playhead', 'aria-keyshortcuts': 'S', onclick: () => splitSelected() }),
        h('button', { type: 'button', class: 'button', text: 'Duplicate', 'aria-keyshortcuts': 'Control+D', onclick: () => duplicateSelected() }),
        h('button', { type: 'button', class: 'button button--danger', text: 'Delete', 'aria-keyshortcuts': 'Delete', onclick: () => deleteSelected() }),
      ]),
      h('details', { class: 'daw__exact' }, [
        h('summary', { text: 'Exact values' }),
        h('dl', { class: 'daw__facts' }, [
          h('dt', { text: 'Start' }), h('dd', { text: `${clip.timelineStartBeat} beats` }),
          h('dt', { text: 'Duration' }), h('dd', { text: `${clip.durationBeats} beats` }),
          h('dt', { text: 'Source offset' }), h('dd', { text: `${clip.sourceOffsetSec.toFixed(4)} s (frame ${Math.round(clip.sourceOffsetSec * SAMPLE_RATE)})` }),
          h('dt', { text: 'Clip gain' }), h('dd', { text: fmtDb(clip.clipGainDb) }),
          h('dt', { text: 'Fades' }), h('dd', { text: `in ${clip.fadeInBeats} · out ${clip.fadeOutBeats} beats` }),
          h('dt', { text: 'Source rate' }), h('dd', { text: `${rate.toFixed(4)} (${clip.stretchMode})` }),
          h('dt', { text: 'Asset' }), h('dd', { text: asset?.bufferReference ?? '' }),
        ]),
      ]),
    ]);
  }

  function renderMessages() {
    replaceChildren(messages, session.messages.slice(-5).map((m) => h('li', {
      class: `daw__msg daw__msg--${m.kind}`, dataset: { code: m.code }, text: `${m.message}`,
    })));
  }

  function renderProject() {
    if (doc.activeElement !== nameInput) nameInput.value = session.projectName;
    saveState.textContent = session.projectId
      ? (session.dirty ? 'unsaved changes' : 'all edits saved')
      : (session.state.clips.length ? 'not saved yet' : '');
    exportBtn.disabled = session.state.clips.length === 0;
  }

  function renderControls() {
    const t = session.state.transport;
    if (doc.activeElement !== bpmInput) bpmInput.value = String(t.masterBpm);
    zoomText.textContent = `${Math.round(((zoomScrollerWidth() / pxPerBeat()) / beatsPerBar()))} bars`;
    loopBtn.setAttribute('aria-pressed', String(Boolean(t.loopRange)));
    loopBtn.textContent = t.loopRange
      ? `Loop ${formatPosition(t.loopRange[0], beatsPerBar()).split(' · ')[0]}–${formatPosition(t.loopRange[1], beatsPerBar()).split(' · ')[0]}`
      : 'Loop off';
    undoBtn.disabled = !session.edit.canUndo;
    redoBtn.disabled = !session.edit.canRedo;
    undoBtn.textContent = `Undo${session.edit.canUndo ? ` (${session.edit.historyDepth.past})` : ''}`;
    const master = session.state.master?.volumeDb ?? 0;
    if (doc.activeElement !== masterRange) masterRange.value = String(master);
    masterOut.textContent = fmtDb(master);
    monitorRange.value = String(session.monitorDb);
    monitorOut.textContent = fmtDb(session.monitorDb);
  }

  function zoomScrollerWidth() { return scroller.clientWidth || 900; }

  function render() {
    if (ui.disposed) return;
    if (ui.selectedClipId && !clipById(ui.selectedClipId)) ui.selectedClipId = null;
    renderControls();
    renderHeaders();
    renderLanes();
    renderInspector();
    renderProject();
    renderMessages();
    renderTransport();
  }

  // ------------------------------------------------------------- clip actions

  function select(clipId) {
    ui.selectedClipId = clipId;
    const clip = clipById(clipId);
    if (clip) ui.selectedTrack = clip.trackIndex;
    render();
  }

  function splitSelected() {
    const clip = clipById(ui.selectedClipId);
    if (!clip) return;
    const at = session.playheadBeat();
    const outcome = session.apply({ name: 'splitClipAtBeat', args: { clipId: clip.id, splitBeat: at } });
    if (outcome.ok) onAnnounce(`Split at ${formatPosition(at, beatsPerBar())}.`);
  }

  function duplicateSelected() {
    const clip = clipById(ui.selectedClipId);
    if (!clip) return;
    const outcome = session.apply({ name: 'duplicateClip', args: { clipId: clip.id } });
    if (outcome.ok) select(outcome.result.clipId);
  }

  function deleteSelected() {
    const clip = clipById(ui.selectedClipId);
    if (!clip) return;
    const outcome = session.apply({ name: 'deleteClip', args: { clipId: clip.id } });
    if (outcome.ok) { ui.selectedClipId = null; render(); onAnnounce('Clip deleted. Undo brings it back.'); }
  }

  function nudgeSelected(direction) {
    const clip = clipById(ui.selectedClipId);
    if (!clip) return;
    const step = snapBeats() || 0.25;
    session.apply({ name: 'moveClip', args: { clipId: clip.id, newTrackIndex: clip.trackIndex, newStartBeat: Math.max(0, clip.timelineStartBeat + direction * step) } });
  }

  /**
   * Keyboard/button slip: `direction` -1 hears earlier source material, +1
   * later, by one snap step of timeline time (a quarter beat with Snap off).
   */
  function slipSelectedBy(direction) {
    const clip = clipById(ui.selectedClipId);
    if (!clip) return;
    const asset = session.state.assets[clip.assetId];
    const lim = slipLimitsSec(clip, asset, session.bpm);
    if (lim.max <= 0) { session.say('refused', 'NO_SLIP_ROOM', 'This clip already uses the whole stem. Trim its end first to make room to slip.'); return; }
    const step = snapBeats() || 0.25;
    const wanted = clip.sourceOffsetSec + direction * beatsToSourceSeconds(step, clip, asset, session.bpm);
    const target = roundNs(clampTo(wanted, lim.min, lim.max));
    if (target === clip.sourceOffsetSec) return;
    const outcome = session.apply({ name: 'slipClip', args: { clipId: clip.id, sourceOffsetSec: target } });
    if (outcome.ok) onAnnounce(`Source in-point ${target.toFixed(3)} seconds.`);
  }

  // ------------------------------------------------------------- pointer gestures

  const beatAt = (clientX) => (clientX - content.getBoundingClientRect().left) / pxPerBeat();
  const laneHeight = () => lanes.firstElementChild?.offsetHeight || LANE_HEIGHT;
  const laneAt = (clientY) => {
    const r = lanes.getBoundingClientRect();
    return Math.max(0, Math.min(7, Math.floor((clientY - r.top) / laneHeight())));
  };

  on(lanes, 'pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // Clip grips win. A point hit does not stop the event when the pointer is
    // on a grip, and it does not fall through to the empty-lane seek.
    const onGrip = ev.target.closest?.('[data-grip]');
    const onClip = ev.target.closest?.('.daw__clip');
    if (!onGrip && !onClip) {
      const hit = envelopeHit(ev);
      if (hit) {
        ev.preventDefault();
        ev.stopPropagation();
        beginEnvelopeDrag(hit, ev);
        return;
      }
    }
    const el = ev.target.closest('.daw__clip');
    if (!el) {
      // Empty lane: select the track, cue there.
      const laneEl = ev.target.closest('.daw__lane');
      if (laneEl) {
        ui.selectedTrack = Number(laneEl.dataset.track);
        ui.selectedClipId = null;
        session.seek(snap(beatAt(ev.clientX)));
        render();
      }
      return;
    }
    const clip = clipById(el.dataset.clipId);
    if (!clip) return;
    ev.preventDefault();
    if (ui.selectedClipId !== clip.id) select(clip.id);
    const live = lanes.querySelector(`[data-clip-id="${esc(clip.id)}"]`);
    let grip = ev.target.dataset?.grip ?? 'move';
    if (grip === 'move' && ev.shiftKey) grip = 'slip';
    ui.drag = {
      grip, clip: { ...clip }, el: live, startX: ev.clientX, startY: ev.clientY, pointer0: beatAt(ev.clientX),
      grabOffset: beatAt(ev.clientX) - clip.timelineStartBeat, moved: false, pointerId: ev.pointerId,
    };
    try { live?.setPointerCapture?.(ev.pointerId); } catch { /* window listeners still follow */ }
  });

  on(win, 'pointermove', (ev) => {
    const env = ui.envDrag;
    if (env && ev.pointerId === env.pointerId) {
      const laneEl = lanes.querySelector(`.daw__lane[data-track="${env.trackIndex}"]`);
      const track = session.state.tracks[env.trackIndex];
      if (!laneEl || !track) return;
      const rect = laneEl.getBoundingClientRect();
      const beat = Math.max(0, (ev.clientX - rect.left) / pxPerBeat());
      const db = yToOffsetDb(ev.clientY - rect.top, track, LANE_HEIGHT);
      const points = (track.gainPoints ?? []).map((p) => ({ beat: p.beat, db: p.db }));
      if (!points[env.index]) return;
      points[env.index] = { beat, db };
      session.apply({
        name: 'setTrackGainEnvelope',
        args: { trackIndex: env.trackIndex, points },
      }, `gain-envelope-${env.trackIndex}`);
      return;
    }
    const d = ui.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    if (!d.moved && Math.abs(ev.clientX - d.startX) < 3 && Math.abs(ev.clientY - d.startY) < 3) return;
    d.moved = true;
    const ppb = pxPerBeat();
    const c = d.clip;
    const pointer = beatAt(ev.clientX);
    const free = ev.altKey ? 'off' : false;
    if (d.grip === 'move') {
      d.start = snap(pointer - d.grabOffset, free);
      d.lane = laneAt(ev.clientY);
      d.el.style.left = `${d.start * ppb}px`;
      d.el.style.transform = `translateY(${(d.lane - c.trackIndex) * laneHeight()}px)`;
      d.el.classList.add('is-dragging');
    } else if (d.grip === 'start') {
      const end = c.timelineStartBeat + c.durationBeats;
      d.start = Math.min(snap(pointer, free), end - MIN_CLIP_DURATION_BEATS);
      d.el.style.left = `${d.start * ppb}px`;
      d.el.style.width = `${(end - d.start) * ppb}px`;
    } else if (d.grip === 'end') {
      d.end = Math.max(snap(pointer, free), c.timelineStartBeat + MIN_CLIP_DURATION_BEATS);
      d.el.style.width = `${(d.end - c.timelineStartBeat) * ppb}px`;
    } else if (d.grip === 'fadeIn' || d.grip === 'fadeOut') {
      const len = d.grip === 'fadeIn' ? pointer - c.timelineStartBeat : c.timelineStartBeat + c.durationBeats - pointer;
      const other = d.grip === 'fadeIn' ? c.fadeOutBeats : c.fadeInBeats;
      d.fade = Math.max(0, Math.min(c.durationBeats - other, Math.round(len * 64) / 64));
      d.el.querySelector(d.grip === 'fadeIn' ? '.daw__fade--in' : '.daw__fade--out').style.width = `${d.fade * ppb}px`;
      d.el.dataset.live = `${d.grip === 'fadeIn' ? 'Fade in' : 'Fade out'} ${fmtBeats(d.fade)} · ${(d.fade * 60 / session.bpm).toFixed(2)} s`;
      previewWave(d.el, { ...c, [d.grip === 'fadeIn' ? 'fadeInBeats' : 'fadeOutBeats']: d.fade });
    } else if (d.grip === 'slip') {
      const asset = session.state.assets[c.assetId];
      const lim = slipLimitsSec(c, asset, session.bpm);
      const g = snapBeats();
      let deltaBeats = pointer - d.pointer0;
      if (g && !ev.altKey) deltaBeats = Math.round(deltaBeats / g) * g;
      // Dragging right shows earlier material (the audio moves with the pointer).
      const wanted = c.sourceOffsetSec - beatsToSourceSeconds(deltaBeats, c, asset, session.bpm);
      d.slip = lim.max <= 0 ? c.sourceOffsetSec : roundNs(clampTo(wanted, lim.min, lim.max));
      d.el.dataset.live = lim.max <= 0
        ? 'No room to slip: trim the clip shorter first'
        : `Source in-point ${d.slip.toFixed(3)} s`;
      previewWave(d.el, { ...c, sourceOffsetSec: d.slip });
    } else if (d.grip === 'gain') {
      const step = ev.altKey ? 0.1 : 0.5;
      const raw = c.clipGainDb - (ev.clientY - d.startY) * 0.2;
      d.gain = clampTo(Math.round(raw / step) * step, MIN_CLIP_GAIN_DB, MAX_CLIP_GAIN_DB);
      d.el.dataset.live = `Clip gain ${fmtDb(d.gain)}`;
      d.el.querySelector('.daw__gain-grip').textContent = fmtDb(d.gain);
      previewWave(d.el, { ...c, clipGainDb: d.gain });
    }
  });

  const endDrag = (ev) => {
    if (ui.envDrag && (!ev || ev.pointerId === ui.envDrag.pointerId)) {
      ui.envDrag = null;
      session.endGesture();
      render();
      return;
    }
    const d = ui.drag;
    if (!d || (ev && ev.pointerId !== d.pointerId)) return;
    ui.drag = null;
    if (d.el) delete d.el.dataset.live;
    if (!d.moved) return;
    const c = d.clip;
    let outcome = null;
    if (d.grip === 'move' && d.start !== undefined) {
      outcome = session.apply({ name: 'moveClip', args: { clipId: c.id, newTrackIndex: d.lane, newStartBeat: d.start } });
      if (outcome.ok) onAnnounce(`Moved to ${session.state.tracks[d.lane].name}, bar ${formatPosition(d.start, beatsPerBar())}.`);
    } else if (d.grip === 'start' && d.start !== undefined) {
      outcome = session.apply({ name: 'trimClip', args: { clipId: c.id, edge: 'start', deltaBeats: d.start - c.timelineStartBeat } });
    } else if (d.grip === 'end' && d.end !== undefined) {
      outcome = session.apply({ name: 'trimClip', args: { clipId: c.id, edge: 'end', deltaBeats: d.end - (c.timelineStartBeat + c.durationBeats) } });
    } else if (d.grip === 'slip') {
      if (d.slip !== undefined && d.slip !== c.sourceOffsetSec) {
        outcome = session.apply({ name: 'slipClip', args: { clipId: c.id, sourceOffsetSec: d.slip } });
        if (outcome.ok) onAnnounce(`Source in-point ${d.slip.toFixed(3)} seconds. The clip stayed at bar ${formatPosition(c.timelineStartBeat, beatsPerBar())}.`);
      } else { render(); return; }
    } else if (d.grip === 'gain') {
      if (d.gain !== undefined && d.gain !== c.clipGainDb) {
        outcome = session.apply({ name: 'setClipGain', args: { clipId: c.id, gainDb: d.gain } });
      } else { render(); return; }
    } else if (d.fade !== undefined) {
      const fadeInBeats = d.grip === 'fadeIn' ? d.fade : c.fadeInBeats;
      const fadeOutBeats = d.grip === 'fadeOut' ? d.fade : c.fadeOutBeats;
      outcome = session.apply({ name: 'setClipFades', args: { clipId: c.id, fadeInBeats, fadeOutBeats } });
    }
    if (!outcome || !outcome.ok) render(); // a refused edit snaps the preview back
  };
  on(win, 'pointerup', endDrag);
  on(win, 'pointercancel', (ev) => {
    if (ui.envDrag) { ui.envDrag = null; session.endGesture(); render(); }
    if (ui.drag) { ui.drag = null; render(); }
    void ev;
  });

  // Contextual hint: one quiet line that names what the pointer is over.
  const HINTS = {
    idle: 'Click the ruler to put the play cue where Play should start. Select a clip to move, trim, slip, fade or change its gain.',
    ruler: 'Play cue: click to choose where Play starts (no clip moves). Drag to set a loop.',
    move: 'Move: drag to put this clip somewhere else. Shift-drag slips the audio inside it instead.',
    start: 'Trim: drag the edge to change where the clip starts. The audio keeps its place on the timeline.',
    end: 'Trim: drag the edge to change where the clip ends.',
    fadeIn: 'Fade in: drag to set how long the sound takes to come in.',
    fadeOut: 'Fade out: drag to set how long the sound takes to go.',
    gain: 'Clip gain: drag up or down (Alt for fine). Track level is separate.',
    slip: 'Slip: drag to choose which part of the stem plays here. The clip stays where it is.',
  };
  hintLine.textContent = HINTS.idle;
  on(timeline, 'pointerover', (ev) => {
    if (ui.drag) return;
    const grip = ev.target.dataset?.grip;
    let key = 'idle';
    if (ev.target.closest?.('.daw__ruler')) key = 'ruler';
    else if (grip && HINTS[grip]) key = grip;
    else if (ev.target.closest?.('.daw__clip')) key = 'move';
    hintLine.textContent = HINTS[key];
  });
  on(timeline, 'pointerleave', () => { if (!ui.drag) hintLine.textContent = HINTS.idle; });

  // Ruler: click cues, drag sets the loop.
  on(ruler, 'pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const start = snap(beatAt(ev.clientX));
    ui.drag = { grip: 'ruler', start, startX: ev.clientX, moved: false, pointerId: ev.pointerId };
    try { ruler.setPointerCapture?.(ev.pointerId); } catch { /* best effort */ }
  });
  on(ruler, 'pointermove', (ev) => {
    const d = ui.drag;
    if (!d || d.grip !== 'ruler' || ev.pointerId !== d.pointerId) return;
    if (Math.abs(ev.clientX - d.startX) < 4 && !d.moved) return;
    d.moved = true;
    const end = snap(beatAt(ev.clientX));
    const [a, b] = end >= d.start ? [d.start, end] : [end, d.start];
    loopBand.hidden = false;
    loopBand.style.left = `${a * pxPerBeat()}px`;
    loopBand.style.width = `${(b - a) * pxPerBeat()}px`;
    d.range = [a, b];
  });
  on(ruler, 'pointerup', (ev) => {
    const d = ui.drag;
    if (!d || d.grip !== 'ruler') return;
    ui.drag = null;
    if (d.moved && d.range && d.range[1] - d.range[0] > 0) {
      ui.lastLoop = d.range;
      const outcome = session.setLoop(d.range[0], d.range[1]);
      if (outcome.ok) onAnnounce(`Loop bars ${formatPosition(d.range[0], beatsPerBar())} to ${formatPosition(d.range[1], beatsPerBar())}.`);
    } else {
      session.seek(d.start);
    }
    render();
    void ev;
  });
  on(ruler, 'keydown', (ev) => {
    const step = snapBeats() || 1;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); session.seek(snap(session.playheadBeat() + step)); }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); session.seek(snap(Math.max(0, session.playheadBeat() - step))); }
    if (ev.key === 'Home') { ev.preventDefault(); session.seek(0); }
  });

  on(lanes, 'keydown', (ev) => {
    const el = ev.target.closest?.('.daw__clip');
    if (!el) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(el.dataset.clipId); }
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      if (ui.selectedClipId !== el.dataset.clipId) select(el.dataset.clipId);
      nudgeSelected(ev.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  on(lanes, 'focusin', (ev) => {
    const el = ev.target.closest?.('.daw__clip');
    if (el && ui.selectedClipId !== el.dataset.clipId && !ui.drag) {
      ui.selectedClipId = el.dataset.clipId;
      ui.selectedTrack = clipById(el.dataset.clipId)?.trackIndex ?? ui.selectedTrack;
      renderInspector();
      lanes.querySelectorAll('.daw__clip').forEach((c) => {
        const sel = c.dataset.clipId === ui.selectedClipId;
        c.classList.toggle('is-selected', sel);
        c.setAttribute('aria-pressed', String(sel));
      });
    }
  });

  // ------------------------------------------------------------- toolbar wiring

  const play = () => {
    win.dispatchEvent(new win.CustomEvent(EXCLUSIVE_PLAY_EVENT, { detail: { owner: 'arrangement' } }));
    return session.play();
  };
  on(win, EXCLUSIVE_PLAY_EVENT, (ev) => { if (ev.detail?.owner !== 'arrangement') session.stop(); });
  playBtn.addEventListener('click', () => { void play(); });
  pauseBtn.addEventListener('click', () => session.pause());
  stopBtn.addEventListener('click', () => session.stop());
  undoBtn.addEventListener('click', () => { if (session.undo()) onAnnounce('Undone.'); });
  redoBtn.addEventListener('click', () => { if (session.redo()) onAnnounce('Redone.'); });
  snapSelect.addEventListener('change', () => { ui.snap = snapSelect.value; });
  zoomIn.addEventListener('click', () => setZoom(ui.zoomIndex + 1));
  zoomOut.addEventListener('click', () => setZoom(ui.zoomIndex - 1));
  bpmInput.addEventListener('change', () => {
    const v = Number(bpmInput.value);
    if (Number.isFinite(v) && v > 0) session.apply({ name: 'setMasterBpm', args: { masterBpm: v } });
    else render();
  });
  loopBtn.addEventListener('click', () => toggleLoop());
  bindGesture(masterRange, 'master', (v) => ({ name: 'setMasterVolume', args: { volumeDb: v } }));
  monitorRange.addEventListener('input', () => {
    session.setMonitorDb(Number(monitorRange.value));
    monitorOut.textContent = fmtDb(session.monitorDb);
  });

  function setZoom(index) {
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
    if (next === ui.zoomIndex) return;
    const centreBeat = (scroller.scrollLeft + scroller.clientWidth / 2) / pxPerBeat();
    ui.zoomIndex = next;
    render();
    scroller.scrollLeft = Math.max(0, centreBeat * pxPerBeat() - scroller.clientWidth / 2);
  }

  function toggleLoop() {
    const loop = session.state.transport.loopRange;
    if (loop) {
      ui.lastLoop = loop;
      session.setLoop(null, null);
      return;
    }
    const bpb = beatsPerBar();
    const from = Math.floor(session.playheadBeat() / bpb) * bpb;
    const range = ui.lastLoop ?? [from, from + 4 * bpb];
    session.setLoop(range[0], range[1]);
  }

  nameInput.addEventListener('change', () => { session.projectName = nameInput.value.trim() || session.projectName; renderProject(); });
  saveBtn.addEventListener('click', async () => {
    try {
      await session.save(nameInput.value);
      await refreshSaved();
      onAnnounce(`Saved ${session.projectName}.`);
    } catch (err) { session.say('error', 'SAVE_FAILED', err.message); }
  });
  openBtn.addEventListener('click', async () => {
    const id = openSelect.value;
    if (!id) { await refreshSaved(); return; }
    try {
      await session.open(id);
      ui.selectedClipId = null;
      render();
      onAnnounce(`Opened ${session.projectName}.`);
    } catch (err) { session.say('error', 'OPEN_FAILED', err.message); }
  });
  openSelect.addEventListener('focus', () => { void refreshSaved(); });
  newBtn.addEventListener('click', async () => {
    await session.newProject();
    ui.selectedClipId = null;
    render();
  });
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Rendering…';
    try {
      session.projectName = nameInput.value.trim() || session.projectName;
      const { wav, fileName, report } = await session.exportMix();
      (opts.saveFile ?? defaultSaveFile)(wav, fileName, report);
      onAnnounce(`Exported ${fileName}.`);
    } catch (err) {
      session.say('error', 'EXPORT_FAILED', err.message);
    } finally {
      exportBtn.textContent = 'Export WAV';
      renderProject();
    }
  });

  function defaultSaveFile(wav, fileName) {
    const blob = new win.Blob([wav], { type: 'audio/wav' });
    const url = win.URL.createObjectURL(blob);
    const a = h('a', { href: url, download: fileName, hidden: 'true' });
    doc.body.append(a);
    a.click(); // the musician's own Export click; the browser offers the file
    a.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 30000);
  }

  async function refreshSaved() {
    try {
      const items = await session.listSaved();
      const current = openSelect.value;
      replaceChildren(openSelect, [
        h('option', { value: '', text: items.length ? 'Open saved…' : 'No saved arrangements' }),
        ...items.map((it) => h('option', { value: it.id, text: `${it.name} (${it.clipCount} clips)` })),
      ]);
      if (items.some((it) => it.id === current)) openSelect.value = current;
    } catch (err) { session.say('error', 'LIST_FAILED', err.message); }
  }

  // Import
  async function loadTrackChoices() {
    try {
      const page = await opts.listTracks({ limit: 50 });
      ui.tracks = Array.isArray(page?.items) ? page.items : (Array.isArray(page) ? page : []);
      for (const group of ['A', 'B']) {
        const { select } = importRows[group];
        const previous = select.value;
        replaceChildren(select, [
          h('option', { value: '', text: ui.tracks.length ? 'Choose a track…' : 'No tracks in the library' }),
          ...ui.tracks.map((t) => h('option', { value: t.id, text: t.name || t.display_name || t.id })),
        ]);
        if (previous) select.value = previous;
      }
    } catch (err) { session.say('error', 'TRACKS_FAILED', err.message); }
  }
  importBox.addEventListener('toggle', () => { if (importBox.open && !ui.tracks.length) void loadTrackChoices(); });
  for (const group of ['A', 'B']) {
    const row = importRows[group];
    row.select.addEventListener('focus', () => { if (!ui.tracks.length) void loadTrackChoices(); });
    row.go.addEventListener('click', () => { void bringIn(group); });
  }

  async function bringIn(group) {
    const row = importRows[group];
    const track = ui.tracks.find((t) => t.id === row.select.value);
    if (!track) { session.say('notice', 'CHOOSE_TRACK', `Choose a track for ${group} first.`); return; }
    row.go.disabled = true;
    row.go.textContent = 'Decoding…';
    try {
      const stems = await opts.listStems(track.id);
      const quad = completeQuad(stems?.variants);
      if (!quad) {
        session.say('notice', 'NO_STEMS', `${track.name} has no complete vocals/drums/bass/other set yet. Separate it on the Performance desk (Add / Process Track), then bring it in.`);
        return;
      }
      const choice = row.section.value;
      const startSec = Math.max(0, Math.min(3600, Number(row.start.value) || 0));
      const section = choice === 'full' ? 'full' : { startSec, seconds: Number(choice) };
      await session.importGroup(group, {
        trackId: track.id,
        title: track.name || track.id,
        bpm: Number(track.bpm) || null,
        section,
        stems: quad.map((v) => ({
          role: v.name,
          url: choice === 'full' ? v.audio_url : withSection(v.audio_url, startSec, choice),
          method: v.method, modelName: v.model_name, stemSetId: v.stem_set_id,
        })),
      });
      ui.selectedTrack = GROUP_BASE[group];
      ui.selectedClipId = null;
      // Both banks are on the lanes: fold the import away so the lanes lead.
      const used = new Set(session.state.clips.map((c) => (c.trackIndex < 4 ? 'A' : 'B')));
      if (used.has('A') && used.has('B')) importBox.open = false;
      render();
    } catch (err) {
      session.say('error', 'IMPORT_FAILED', `${group}: ${err.message}`);
    } finally {
      row.go.disabled = false;
      row.go.textContent = `Bring in ${group}`;
    }
  }

  // ------------------------------------------------------------- keyboard

  const typing = (t) => t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)
    || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  on(doc, 'keydown', (ev) => {
    if (ui.disposed || !root.isConnected || root.closest('[hidden]')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Escape') { session.stop(); return; }
    if (typing(ev.target)) return;
    const onClipTarget = ev.target.closest?.('.daw__clip');
    const pointHandle = ev.target.closest?.('[data-env-point]');
    if (pointHandle) {
      ui.selectedPoint = {
        trackIndex: Number(pointHandle.dataset.track),
        index: Number(pointHandle.dataset.index),
      };
      ui.selectedTrack = ui.selectedPoint.trackIndex;
    }
    if (!mod && pointHandle && !onClipTarget) {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        nudgeSelectedPoint(ev.key);
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelectedPoint();
        return;
      }
    }
    if (ev.key === ' ' && !mod) {
      if (ev.target.closest?.('.daw__clip')) return; // Space selects a focused clip
      ev.preventDefault();
      if (ev.repeat) return;
      if (session.isPlaying()) session.stop(); else void play();
    } else if (mod && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) session.redo(); else session.undo();
    } else if (mod && (ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault(); session.redo();
    } else if (mod && (ev.key === 'd' || ev.key === 'D')) {
      ev.preventDefault(); duplicateSelected();
    } else if (!mod && (ev.key === 'Delete' || ev.key === 'Backspace') && ui.selectedClipId) {
      ev.preventDefault(); deleteSelected();
    } else if (!mod && (ev.key === 's' || ev.key === 'S') && ui.selectedClipId) {
      ev.preventDefault(); splitSelected();
    } else if (!mod && (ev.key === ',' || ev.key === '.') && ui.selectedClipId) {
      ev.preventDefault(); slipSelectedBy(ev.key === ',' ? -1 : 1);
    } else if (!mod && (ev.key === 'l' || ev.key === 'L')) {
      toggleLoop();
    } else if (!mod && (ev.key === '+' || ev.key === '=')) {
      setZoom(ui.zoomIndex + 1);
    } else if (!mod && ev.key === '-') {
      setZoom(ui.zoomIndex - 1);
    }
  });
  on(win, 'pagehide', () => { void session.closeAudio(); });

  // AI Producer mount point (Stage D): given the session, it proposes edits
  // through the same command path.
  // OPERATION THE LISTENING ROOM: the producer may also draw its idea on the
  // timeline (outlines of clips that are not playing yet).
  producerHandle = opts.producer?.({ container: producerMount, session, onAnnounce, rerender: () => render(), selectedClipId: () => ui.selectedClipId }) ?? null;
  const producerDispose = typeof producerHandle === 'function' ? producerHandle : producerHandle?.dispose ?? null;
  producerPreview = typeof producerHandle?.preview === 'function' ? producerHandle.preview : () => [];

  render();

  const api = {
    session,
    ui,
    render,
    select,
    elements: {
      root, playBtn, pauseBtn, stopBtn, loopBtn, undoBtn, redoBtn, bpmInput, snapSelect, zoomIn, zoomOut,
      masterRange, monitorRange, nameInput, saveBtn, openSelect, openBtn, newBtn, exportBtn, ruler, lanes,
      headers, inspector, messages, importRows, scroller, playhead, producerMount,
    },
    dispose() {
      if (ui.disposed) return;
      ui.disposed = true;
      if (ui.rafId !== null) win.cancelAnimationFrame(ui.rafId);
      for (const off of listeners) off();
      producerDispose?.();
      void session.dispose();
      container.replaceChildren();
    },
  };
  return api;
}
