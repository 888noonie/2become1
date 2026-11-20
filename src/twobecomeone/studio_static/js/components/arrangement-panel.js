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
} from '../arrangement/project-state.js';
import { MIN_CLIP_DURATION_BEATS, sourceAdvanceRate } from '../arrangement/time-math.js';

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
    rafId: null,
    tracks: [],
    disposed: false,
  };

  let session = opts.session ?? null;
  const onChange = (kind) => {
    if (ui.disposed) return;
    if (kind === 'transport') { renderTransport(); startPlayheadLoop(); return; }
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
    h('div', { class: 'daw__body' }, [timeline, side]),
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
    for (let px = 0; px < w; px += 1) {
      const a = Math.floor((srcStart + (px / w) * srcSpan) / peaks.bucketFrames);
      const b = Math.max(a + 1, Math.floor((srcStart + ((px + 1) / w) * srcSpan) / peaks.bucketFrames));
      let lo = 0;
      let hi = 0;
      for (let i = a; i < b && i < peaks.min.length; i += 1) {
        if (peaks.min[i] < lo) lo = peaks.min[i];
        if (peaks.max[i] > hi) hi = peaks.max[i];
      }
      const gain = 10 ** (clip.clipGainDb / 20);
      const top = mid - Math.min(1, hi * gain) * mid;
      const bot = mid - Math.max(-1, lo * gain) * mid;
      g.fillRect(px, top, 1, Math.max(1, bot - top));
    }
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
      clip.clipGainDb ? fmtDb(clip.clipGainDb) : null,
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
      h('span', { class: 'daw__fade-grip daw__fade-grip--in', dataset: { grip: 'fadeIn' }, title: 'Drag to set the fade in', 'aria-hidden': 'true' }),
      h('span', { class: 'daw__fade-grip daw__fade-grip--out', dataset: { grip: 'fadeOut' }, title: 'Drag to set the fade out', 'aria-hidden': 'true' }),
    ]);
    win.requestAnimationFrame(() => drawWaveform(canvas, clip, width));
    return el;
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
      for (const clip of session.state.clips) if (clip.trackIndex === track.trackIndex) row.append(clipEl(clip));
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
    input.addEventListener('input', () => { session.apply(build(Number(input.value)), key); });
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
      rangeRow('Gain', {
        min: MIN_CLIP_GAIN_DB, max: MAX_CLIP_GAIN_DB, step: 0.5, value: clip.clipGainDb, format: fmtDb,
        key: `gain:${clip.id}`, build: (v) => ({ name: 'setClipGain', args: { clipId: clip.id, gainDb: v } }),
      }),
      rangeRow('Fade in', {
        min: 0, max: fadeMax / 2, step: 1 / 64, value: Math.min(clip.fadeInBeats, fadeMax / 2), format: (v) => fmtBeats(v),
        key: `fadein:${clip.id}`, build: (v) => ({ name: 'setClipFades', args: { clipId: clip.id, fadeInBeats: v, fadeOutBeats: clipById(clip.id)?.fadeOutBeats ?? clip.fadeOutBeats } }),
      }),
      rangeRow('Fade out', {
        min: 0, max: fadeMax / 2, step: 1 / 64, value: Math.min(clip.fadeOutBeats, fadeMax / 2), format: (v) => fmtBeats(v),
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
        h('button', { type: 'button', class: 'button', text: 'Split at playhead', 'aria-keyshortcuts': 'S', onclick: () => splitSelected() }),
        h('button', { type: 'button', class: 'button', text: 'Duplicate', 'aria-keyshortcuts': 'Control+D', onclick: () => duplicateSelected() }),
        h('button', { type: 'button', class: 'button button--danger', text: 'Delete', 'aria-keyshortcuts': 'Delete', onclick: () => deleteSelected() }),
      ]),
      h('details', { class: 'daw__exact' }, [
        h('summary', { text: 'Exact values' }),
        h('dl', { class: 'daw__facts' }, [
          h('dt', { text: 'Start' }), h('dd', { text: `${clip.timelineStartBeat} beats` }),
          h('dt', { text: 'Duration' }), h('dd', { text: `${clip.durationBeats} beats` }),
          h('dt', { text: 'Source offset' }), h('dd', { text: `${clip.sourceOffsetSec.toFixed(4)} s` }),
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

  // ------------------------------------------------------------- pointer gestures

  const beatAt = (clientX) => (clientX - content.getBoundingClientRect().left) / pxPerBeat();
  const laneHeight = () => lanes.firstElementChild?.offsetHeight || LANE_HEIGHT;
  const laneAt = (clientY) => {
    const r = lanes.getBoundingClientRect();
    return Math.max(0, Math.min(7, Math.floor((clientY - r.top) / laneHeight())));
  };

  on(lanes, 'pointerdown', (ev) => {
    if (ev.button !== 0) return;
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
    const grip = ev.target.dataset?.grip ?? 'move';
    ui.drag = {
      grip, clip: { ...clip }, el: live, startX: ev.clientX, startY: ev.clientY,
      grabOffset: beatAt(ev.clientX) - clip.timelineStartBeat, moved: false, pointerId: ev.pointerId,
    };
    try { live?.setPointerCapture?.(ev.pointerId); } catch { /* window listeners still follow */ }
  });

  on(win, 'pointermove', (ev) => {
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
    }
  });

  const endDrag = (ev) => {
    const d = ui.drag;
    if (!d || (ev && ev.pointerId !== d.pointerId)) return;
    ui.drag = null;
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
    } else if (d.fade !== undefined) {
      const fadeInBeats = d.grip === 'fadeIn' ? d.fade : c.fadeInBeats;
      const fadeOutBeats = d.grip === 'fadeOut' ? d.fade : c.fadeOutBeats;
      outcome = session.apply({ name: 'setClipFades', args: { clipId: c.id, fadeInBeats, fadeOutBeats } });
    }
    if (!outcome || !outcome.ok) render(); // a refused edit snaps the preview back
  };
  on(win, 'pointerup', endDrag);
  on(win, 'pointercancel', (ev) => { if (ui.drag) { ui.drag = null; render(); } void ev; });

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
  const producerDispose = opts.producer?.({ container: producerMount, session, onAnnounce, rerender: () => render() }) ?? null;

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
