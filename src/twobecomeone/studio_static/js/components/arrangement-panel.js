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
import { clipboardFromClips, clipboardFromRegion } from '../arrangement/edit-api.js';
import {
  MIN_CLIP_DURATION_BEATS, beatsToSourceSeconds, slipLimitsSec, sourceAdvanceRate,
} from '../arrangement/time-math.js';
import {
  clearStemOffer, liveStemLabel, loadStemCard, methodLabel, onStemCard, onStemOffer, roleLabel, stemOffer,
} from '../stem-sleeve.js';
import { fmtTime, openStemFocus, sectionForWindow } from '../stem-focus.js';
import { roleGlyph, roleToken } from '../stem-roles.js';

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

const BEAT_FRACTIONS = Object.freeze([
  [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'],
  [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'],
]);

/**
 * Arrangement position in a musician's words: "bar 5", "bar 5, beat 3",
 * "bar 5, beat 2½". Off-grid positions keep their precision as a decimal
 * beat ("beat 2.371"). Read to the nearest of 960 ticks, the same grid as
 * the transport counter, so float noise never shows as 2.999.
 */
export function musicalPosition(beat, beatsPerBar) {
  const ticks = Math.round(Math.max(0, beat) * 960);
  const perBar = Math.round(beatsPerBar * 960);
  const bar = Math.floor(ticks / perBar) + 1;
  const inBar = ticks - (bar - 1) * perBar;
  const b = Math.floor(inBar / 960) + 1;
  const rest = (inBar % 960) / 960;
  if (rest === 0) return b === 1 ? `bar ${bar}` : `bar ${bar}, beat ${b}`;
  const glyph = BEAT_FRACTIONS.find(([v]) => Math.abs(v - rest) <= 0.5 / 960)?.[1];
  if (glyph) return `bar ${bar}, beat ${b}${glyph}`;
  return `bar ${bar}, beat ${String(Number((b + rest).toFixed(3)))}`;
}

/** A gain point's level, said against the fader it rides on. */
export function pointLevelText(absoluteDb, offsetDb) {
  const off = Math.round(offsetDb * 10) / 10;
  const rel = off === 0 ? 'at the fader' : `${Math.abs(off).toFixed(1)} dB ${off < 0 ? 'under' : 'over'} the fader`;
  return `${fmtDb(absoluteDb)}, ${rel}`;
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
    drawLevels: false,
    pendingTap: null,
    rafId: null,
    tracks: [],
    disposed: false,
    clipboard: null, // OPERATION THE CUTTING ROOM: plain data, never ProjectState
    regionScope: 'all', // a ruler range edits all eight lanes, or only the selected lane
    menu: null,
  };

  let session = opts.session ?? null;
  const focusListeners = new Set(); // OPERATION STUDIO SURGEON: an open clip Focus panel
  const tellFocus = (kind) => { for (const fn of [...focusListeners]) { try { fn(kind); } catch (err) { console.error(err); } } };
  const onChange = (kind) => {
    if (ui.disposed) return;
    if (kind === 'transport') { renderTransport(); startPlayheadLoop(); tellFocus(kind); return; }
    tellFocus(kind);
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
  const levelsBtn = h('button', {
    type: 'button', class: 'button daw__chip daw__levels', text: 'Draw levels', 'aria-pressed': 'false',
    'aria-keyshortcuts': 'G',
    title: 'Draw volume changes over time (G): click a lane to add a point, drag to move it, double-click to remove. Clips are held still while this is on; Esc returns to clip editing.',
  });
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
    levelsBtn,
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

  // OPERATION OPEN THE RECORD SLEEVES: one Library stem the musician chose
  // (Library or Crate → Use in Arrangement), placed where THEY say. Nothing
  // decodes or plays until Place, and Place never moves or replaces a clip.
  const placeBox = h('details', { class: 'daw__place', hidden: 'true', 'data-testid': 'place-stem' }, [
    h('summary', { text: 'Place a Library stem' }),
  ]);
  const placeWhat = h('p', { class: 'daw__place-what', 'data-field': 'place-what' });
  const placeFrom = h('p', { class: 'daw__note', 'data-field': 'place-from' });
  const placeLane = h('select', { 'aria-label': 'Lane for the stem' });
  const placeBar = h('input', { type: 'number', min: '1', max: '999', step: '1', 'aria-label': 'Bar the stem starts at', placeholder: 'bar' });
  const placeAtPlayhead = h('button', { type: 'button', class: 'button button--small', text: 'Playhead bar' });
  const placeLength = h('select', { 'aria-label': 'Length of the stem to place' }, SECTION_CHOICES.map(([v, t]) => h('option', { value: v, text: t })));
  placeLength.value = '60';
  const placeStart = h('input', { type: 'number', min: '0', max: '3600', step: '1', value: '0', 'aria-label': 'Start inside the stem (seconds)' });
  const placeGo = h('button', { type: 'button', class: 'button button--primary daw__place-go', text: 'Place on lane' });
  const placeDismiss = h('button', { type: 'button', class: 'button button--ghost', text: 'Not now' });
  placeBox.append(
    placeWhat, placeFrom,
    h('div', { class: 'daw__import-row' }, [
      h('label', { class: 'daw__field' }, ['Lane', placeLane]),
      h('label', { class: 'daw__field' }, ['At bar', placeBar]), placeAtPlayhead,
    ]),
    h('div', { class: 'daw__import-row' }, [
      h('label', { class: 'daw__field' }, ['Length', placeLength]),
      h('label', { class: 'daw__field' }, ['From', placeStart, h('span', { class: 'daw__unit', text: 's into the stem' })]),
    ]),
    h('div', { class: 'daw__import-row' }, [placeGo, placeDismiss]),
    h('p', { class: 'daw__note', text: 'You choose the lane and the bar. Placing adds one clip at the stem’s own speed; it never moves, trims or replaces a clip, so a span that is already in use is refused. Nothing plays until you press Play. Undo removes it.' }),
  );

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

  const menuEl = h('div', { class: 'daw__menu', role: 'menu', 'aria-label': 'Edit', hidden: 'true' });

  root.append(
    h('div', { class: 'daw__top' }, [transport]),
    projectRow,
    importBox,
    placeBox,
    h('div', { class: 'daw__body' }, [timelineWrap, side]),
    honesty,
    messages,
    menuEl,
  );
  container.replaceChildren(root);

  // ------------------------------------------------------------- render

  const fetchJson = opts.fetchJson ?? (async (url) => {
    const res = await (opts.sessionDeps?.fetchImpl ?? win.fetch.bind(win))(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  });
  /** The owner's live label for a Library stem clip, or null (never stored). */
  function stemLabelOf(asset) {
    const src = asset?.source;
    if (!src?.stemSetId || !src.role) return null;
    const label = liveStemLabel(src.stemSetId, src.role);
    if (label === null) void loadStemCard(src.stemSetId, fetchJson);
    return label;
  }

  function renderPlace() {
    const offer = stemOffer();
    placeBox.hidden = !offer;
    if (!offer) return;
    const label = liveStemLabel(offer.stemSetId, offer.role) ?? (offer.customName ? offer.displayName : offer.role);
    placeWhat.replaceChildren(h('strong', { text: label }), ` · ${roleLabel(offer.role)} stem`);
    placeFrom.textContent = `From the recording “${offer.trackName || offer.trackId}” · ${methodLabel(offer.method)} · set ${offer.stemSetId.slice(0, 8)}. The recording and its stem file stay as they are.`;
    const chosen = placeLane.value;
    replaceChildren(placeLane, [
      h('option', { value: '', text: 'Choose a lane…' }),
      ...session.state.tracks.map((t, i) => {
        const n = session.state.clips.filter((c) => c.trackIndex === i).length;
        return h('option', { value: String(i), text: `${i + 1}. ${t.name}${n ? ` (${n} ${n === 1 ? 'clip' : 'clips'})` : ' (empty)'}` });
      }),
    ]);
    placeLane.value = chosen;
    // OPERATION STUDIO SURGEON: a Stem-Focus selection travels with the offer.
    const sel = offer.window ? sectionForWindow(offer.window.startSec, offer.window.endSec) : null;
    let opt = placeLength.querySelector('option[value="selection"]');
    if (sel) {
      if (!opt) { opt = h('option', { value: 'selection' }); placeLength.prepend(opt); }
      opt.textContent = `Focus selection (${sel.lengthSec.toFixed(2)} s from ${fmtTime(sel.startSec)})`;
      if (placeLength.dataset.offerKey !== offerKey(offer)) placeLength.value = 'selection';
    } else if (opt) {
      opt.remove();
      if (!placeLength.value) placeLength.value = '60';
    }
    placeLength.dataset.offerKey = offerKey(offer);
    placeStart.disabled = placeLength.value === 'selection';
  }
  const offerKey = (o) => `${o.stemSetId}:${o.role}:${o.window ? `${o.window.startSec}-${o.window.endSec}` : 'whole'}`;
  placeLength.addEventListener('change', () => { placeStart.disabled = placeLength.value === 'selection'; });

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
    ruler.setAttribute('aria-valuetext', musicalPosition(beat, beatsPerBar()));
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
    const role = asset?.source?.role ?? null;
    const token = role ? roleToken(role) : null;
    const el = h('div', {
      class: `daw__clip daw__clip--${group}${selected ? ' is-selected' : ''}${token ? ' has-role' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-pressed': String(selected),
      'aria-keyshortcuts': 'F',
      'data-role-token': token?.token,
      'aria-label': `${stemLabelOf(asset) ? `${stemLabelOf(asset)}, ` : ''}${asset?.name ?? clip.id}, ${musicalPosition(clip.timelineStartBeat, beatsPerBar())}, ${fmtBeats(clip.durationBeats)}`,
      dataset: { clipId: clip.id },
      style: { left: `${left}px`, width: `${width}px` },
    }, [
      token ? h('span', { class: 'daw__clip-role', 'aria-hidden': 'true' }, [roleGlyph(role, { size: 12 })]) : null,
      h('span', { class: 'daw__clip-label', text: `${session.state.tracks[clip.trackIndex].name}${stemLabelOf(asset) ? ` · ${stemLabelOf(asset)}` : ''}${badges ? ` · ${badges}` : ''}` }),
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
  let producerEnvelopes = () => [];
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

  /**
   * A pointer-placed level: tenths of a dB (what the readout shows is what is
   * stored), with a detent on the fader so "back to the fader" is exact.
   * Alt keeps the raw pointer value.
   */
  function pointerDb(y, track, free) {
    const db = yToOffsetDb(y, track, LANE_HEIGHT);
    if (free) return db;
    if (Math.abs(db) < 0.5) return 0;
    return clampTo(Math.round(db * 10) / 10, MIN_VOLUME_DB, MAX_VOLUME_DB);
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
    // The Producer's entrance, while it is still an idea: a dashed curve the
    // musician can see before Hear it, and a marked curve while it sounds.
    const idea = producerEnvelopes().find((e) => e.trackIndex === track.trackIndex);
    if (idea?.status === 'proposed') {
      const ghost = doc.createElementNS(SVG_NS, 'polyline');
      ghost.setAttribute('class', `daw__env-line daw__env-line--idea daw__env-line--${trackGroup(track.trackIndex)}`);
      ghost.setAttribute('fill', 'none');
      const gv = curveVertices({ ...track, gainPoints: idea.points }, width);
      ghost.setAttribute('points', gv.map((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' '));
      svg.append(ghost);
    } else if (idea?.status === 'hearing') {
      poly.classList.add('is-idea');
    }
    if (idea) {
      const first = idea.points[0]?.beat ?? 0;
      layer.append(h('span', {
        class: `daw__env-idea daw__env-idea--${idea.status}`,
        style: { left: `${first * pxPerBeat()}px` },
        text: idea.status === 'proposed' ? 'Idea · not playing' : 'Idea · playing, not kept',
      }));
    }
    const selPoint = ui.selectedPoint?.trackIndex === track.trackIndex
      ? track.gainPoints?.[ui.selectedPoint.index] : null;
    if (selPoint && (ui.envDrag || ui.drawLevels)) {
      layer.append(h('span', {
        class: 'daw__env-readout',
        style: { left: `${selPoint.beat * pxPerBeat()}px` },
        text: `${musicalPosition(selPoint.beat, beatsPerBar())} · ${fmtDb(clampTo(track.volumeDb + selPoint.db, MIN_VOLUME_DB, MAX_VOLUME_DB))}`,
      }));
    }
    (track.gainPoints ?? []).forEach((point, index) => {
      const absolute = clampTo(track.volumeDb + point.db, MIN_VOLUME_DB, MAX_VOLUME_DB);
      const selected = ui.selectedPoint?.trackIndex === track.trackIndex && ui.selectedPoint?.index === index;
      const said = `${musicalPosition(point.beat, beatsPerBar())}: ${pointLevelText(absolute, point.db)}`;
      const handle = h('button', {
        type: 'button',
        class: `daw__env-handle daw__env-handle--${trackGroup(track.trackIndex)}${selected ? ' is-selected' : ''}`,
        style: {
          left: `${point.beat * pxPerBeat()}px`,
          top: `${linearToY(pointLinear(track, point), height)}px`,
        },
        title: said,
        'aria-label': `${track.name} level point at ${said}`,
        'aria-pressed': String(selected),
        'aria-keyshortcuts': 'ArrowLeft ArrowRight ArrowUp ArrowDown Delete',
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
    if (!ui.drawLevels && (ev.target.closest?.('.daw__clip') || ev.target.closest?.('[data-grip]'))) return null;
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
    if (best > 10 && !ui.drawLevels) return null;
    // A new point lands on the Snap grid, like a clip; Alt places it freely.
    return {
      kind: 'add',
      trackIndex,
      beat: snap(x / pxPerBeat(), ev.altKey ? 'off' : false),
      db: pointerDb(y, track, ev.altKey),
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
    ui.envDrag = {
      trackIndex: hit.trackIndex, index, pointerId: ev.pointerId,
      // Where the pointer grabbed the point, so a press without a move never
      // shifts it, and the curve before the gesture, so a cancelled touch can
      // be taken back.
      grabX: ev.clientX, grabY: ev.clientY, moved: hit.kind === 'add', slid: false,
      startBeat: points[index]?.beat ?? 0,
      before: (track.gainPoints ?? []).map((p) => ({ beat: p.beat, db: p.db })),
    };
    const outcome = session.apply({
      name: 'setTrackGainEnvelope',
      args: { trackIndex: hit.trackIndex, points },
    }, `gain-envelope-${hit.trackIndex}`);
    if (!outcome.ok) ui.envDrag = null;
    else dropEnvelopePreview(hit.trackIndex);
  }

  function nudgeSelectedPoint(key, fine = false) {
    const sel = ui.selectedPoint;
    if (!sel) return;
    const track = session.state.tracks[sel.trackIndex];
    const points = (track.gainPoints ?? []).map((p) => ({ beat: p.beat, db: p.db }));
    const point = points[sel.index];
    if (!point) return;
    // Left/Right step by the Snap grid (¼ beat when Snap is off), Up/Down by
    // 1 dB. Shift is fine: 1/16 beat and 0.1 dB.
    const beatStep = fine ? 1 / 16 : (snapBeats() || 0.25);
    const dbStep = fine ? 0.1 : 1;
    const r = (v) => Math.round(v * 1e6) / 1e6; // float noise only; the value keeps its precision
    if (key === 'ArrowLeft') point.beat = Math.max(0, roundNs(point.beat - beatStep));
    if (key === 'ArrowRight') point.beat = roundNs(point.beat + beatStep);
    if (key === 'ArrowUp') point.db = Math.min(MAX_VOLUME_DB, r(point.db + dbStep));
    if (key === 'ArrowDown') point.db = Math.max(MIN_VOLUME_DB, r(point.db - dbStep));
    const outcome = session.apply({
      name: 'setTrackGainEnvelope',
      args: { trackIndex: sel.trackIndex, points },
    });
    if (outcome.ok) dropEnvelopePreview(sel.trackIndex);
  }

  function deleteSelectedPoint({ refocus = false } = {}) {
    const sel = ui.selectedPoint;
    if (!sel) return;
    const track = session.state.tracks[sel.trackIndex];
    const gone = track.gainPoints?.[sel.index];
    const points = (track.gainPoints ?? []).filter((_, i) => i !== sel.index);
    // Keyboard removal moves focus to the nearest remaining point on that
    // lane, so the next Delete or arrow keeps working.
    let next = null;
    if (refocus && gone && points.length) {
      next = points.reduce((best, p, i) => (Math.abs(p.beat - gone.beat) < Math.abs(points[best].beat - gone.beat) ? i : best), 0);
    }
    ui.selectedPoint = next === null ? null : { trackIndex: sel.trackIndex, index: next };
    const outcome = session.apply({
      name: 'setTrackGainEnvelope',
      args: { trackIndex: sel.trackIndex, points },
    });
    if (outcome.ok) dropEnvelopePreview(sel.trackIndex);
    if (outcome.ok) onAnnounce(`Removed the level point at ${musicalPosition(gone?.beat ?? 0, beatsPerBar())}.`);
    if (refocus) {
      const target = next === null
        ? null
        : lanes.querySelector(`[data-env-point][data-track="${sel.trackIndex}"][data-index="${next}"]`);
      if (target) target.focus({ preventScroll: true });
      else lanes.querySelector(`.daw__lane[data-track="${sel.trackIndex}"]`)?.focus?.({ preventScroll: true });
    }
  }

  function selectedPointLine(track) {
    const sel = ui.selectedPoint;
    if (!sel || sel.trackIndex !== track.trackIndex) return null;
    const point = track.gainPoints?.[sel.index];
    if (!point) return null;
    const absolute = clampTo(track.volumeDb + point.db, MIN_VOLUME_DB, MAX_VOLUME_DB);
    return h('div', { class: 'daw__ins-point' }, [
      h('p', {
        class: 'daw__ins-sub',
        text: `Level point at ${musicalPosition(point.beat, beatsPerBar())} · ${pointLevelText(absolute, point.db)}`,
      }),
      h('p', {
        class: 'daw__hint',
        text: 'Arrows move it along the Snap grid and by 1 dB; hold Shift for fine steps. Delete removes it.',
      }),
    ]);
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
    const focusedPoint = doc.activeElement?.dataset?.envPoint
      ? { track: doc.activeElement.dataset.track, index: doc.activeElement.dataset.index }
      : null;
    replaceChildren(lanes, rows);
    if (focused) lanes.querySelector(`[data-clip-id="${esc(focused)}"]`)?.focus({ preventScroll: true });
    else if (focusedPoint) {
      lanes.querySelector(`[data-env-point][data-track="${focusedPoint.track}"][data-index="${focusedPoint.index}"]`)?.focus({ preventScroll: true });
    }
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
      editFieldset(),
    ]);
  }

  /** Cut / Copy / Paste / Delete / Split for the ruler range and this lane. */
  function editFieldset() {
    const range = session.state.transport.loopRange;
    const bpb = beatsPerBar();
    const scope = h('select', { 'aria-label': 'Range applies to', 'data-field': 'region-scope' }, [
      h('option', { value: 'all', text: 'All 8 lanes' }),
      h('option', { value: 'lane', text: `${session.state.tracks[ui.selectedTrack].name} only` }),
    ]);
    scope.value = ui.regionScope;
    scope.addEventListener('change', () => { ui.regionScope = scope.value; });
    const off = range ? undefined : 'true';
    return h('fieldset', { class: 'daw__group daw__group--edit', 'data-testid': 'edit-tools' }, [
      h('legend', { text: 'Edit' }),
      h('p', {
        class: 'daw__hint', 'data-field': 'region',
        text: range
          ? `Range ${musicalPosition(range[0], bpb)} to ${musicalPosition(range[1], bpb)} (drag on the ruler to change it).`
          : 'Drag on the ruler to choose a range to cut, copy or delete.',
      }),
      h('label', { class: 'daw__row' }, [h('span', { class: 'daw__row-label', text: 'Range on' }), scope]),
      h('div', { class: 'daw__ins-actions' }, [
        h('button', { type: 'button', class: 'button', text: 'Cut range', 'aria-keyshortcuts': 'Control+X', disabled: off, onclick: () => cutSelection() }),
        h('button', { type: 'button', class: 'button', text: 'Copy range', 'aria-keyshortcuts': 'Control+C', disabled: off, onclick: () => copySelection() }),
        h('button', { type: 'button', class: 'button button--danger', text: 'Delete range', 'aria-keyshortcuts': 'Delete', disabled: off, onclick: () => deleteRange() }),
      ]),
      h('div', { class: 'daw__ins-actions' }, [
        h('button', {
          type: 'button', class: 'button', text: 'Paste at playhead', 'aria-keyshortcuts': 'Control+V',
          disabled: ui.clipboard ? undefined : 'true', onclick: () => { void pasteAt(session.playheadBeat(), ui.selectedTrack); },
        }),
        h('button', { type: 'button', class: 'button', text: 'Split lane at playhead', 'aria-keyshortcuts': 'S', onclick: () => splitLaneAt(ui.selectedTrack, session.playheadBeat()) }),
      ]),
      clipboardLine(),
    ]);
  }

  function clipboardLine() {
    return h('p', { class: 'daw__hint', 'data-field': 'clipboard', text: ui.clipboard ? `Clipboard: ${describeBoard(ui.clipboard)}.` : 'Clipboard empty.' });
  }

  function describeBoard(board) {
    const n = board.pieces.length;
    const lanesText = board.lanes.length === 1
      ? session.state.tracks[board.lanes[0]]?.name ?? `lane ${board.lanes[0] + 1}`
      : `${board.lanes.length} lanes`;
    return `${n} clip${n === 1 ? '' : 's'} from ${lanesText}, ${(board.lengthBeats / beatsPerBar()).toFixed(2)} bars`;
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
      h('dd', { text: stemBeats === null ? 'tempo unknown' : `${musicalPosition(stemBeats, bpb)} of the stem at its own ${asset.nativeBpm} BPM` }),
      h('dt', { text: 'Room to slip' }),
      h('dd', { text: lim.max <= 0 ? 'none: trim the end first' : `${clip.sourceOffsetSec.toFixed(2)} s earlier · ${Math.max(0, lim.max - clip.sourceOffsetSec).toFixed(2)} s later` }),
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
      src.stemSetId && src.role ? h('p', {
        class: 'daw__ins-sub daw__ins-stem', 'data-field': 'stem-identity',
        text: `Stem: ${stemLabelOf(asset) ?? src.role} · ${roleLabel(src.role)} of “${src.title || src.trackId || 'its recording'}”`,
      }) : null,
      h('dl', { class: 'daw__facts' }, [
        h('dt', { text: 'Starts' }), h('dd', { text: musicalPosition(clip.timelineStartBeat, bpb) }),
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
        h('p', { class: 'daw__hint', text: `Changes which audio plays. The clip stays at ${musicalPosition(clip.timelineStartBeat, bpb)} and keeps its length.` }),
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
        h('button', {
          type: 'button', class: 'button button--primary daw__focus', text: 'Focus', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': 'F',
          'aria-label': 'Focus on this clip: audition and edit it in a larger view', 'data-action': 'focus-clip',
          onclick: (ev) => openClipFocus(clip.id, ev.currentTarget),
        }),
        h('button', { type: 'button', class: 'button', text: 'Cue at clip start', onclick: () => session.seek(clip.timelineStartBeat) }),
        h('button', { type: 'button', class: 'button', text: 'Split at playhead', 'aria-keyshortcuts': 'S', onclick: () => splitSelected() }),
        h('button', { type: 'button', class: 'button', text: 'Duplicate', 'aria-keyshortcuts': 'Control+D', onclick: () => duplicateSelected() }),
        h('button', { type: 'button', class: 'button button--danger', text: 'Delete', 'aria-keyshortcuts': 'Delete', onclick: () => deleteSelected() }),
      ]),
      h('div', { class: 'daw__ins-actions', 'data-testid': 'clip-clipboard' }, [
        h('button', { type: 'button', class: 'button', text: 'Cut', 'aria-keyshortcuts': 'Control+X', onclick: () => cutSelection() }),
        h('button', { type: 'button', class: 'button', text: 'Copy', 'aria-keyshortcuts': 'Control+C', onclick: () => copySelection() }),
        h('button', {
          type: 'button', class: 'button', text: 'Paste at playhead', 'aria-keyshortcuts': 'Control+V',
          disabled: ui.clipboard ? undefined : 'true', onclick: () => { void pasteAt(session.playheadBeat(), clip.trackIndex); },
        }),
      ]),
      clipboardLine(),
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
    renderPlace();
  }

  // ------------------------------------------------------------- clip actions

  function select(clipId) {
    ui.selectedClipId = clipId;
    const clip = clipById(clipId);
    if (clip) ui.selectedTrack = clip.trackIndex;
    render();
  }

  function splitSelected(at = session.playheadBeat()) {
    const clip = clipById(ui.selectedClipId);
    if (!clip) return;
    if (at <= clip.timelineStartBeat || at >= clip.timelineStartBeat + clip.durationBeats) {
      session.say('refused', 'SPLIT_OUTSIDE_CLIP', `The playhead (${musicalPosition(at, beatsPerBar())}) is not inside this clip. Click the ruler inside the clip, or right-click the clip where you want the cut.`);
      return;
    }
    const outcome = session.apply({ name: 'splitClipAtBeat', args: { clipId: clip.id, splitBeat: at } });
    if (outcome.ok) onAnnounce(`Split at ${musicalPosition(at, beatsPerBar())}.`);
  }

  /** Split every clip on one lane that the beat falls inside, as one undo step. */
  function splitLaneAt(trackIndex, at) {
    const under = session.state.clips.filter((c) => c.trackIndex === trackIndex
      && at > c.timelineStartBeat + MIN_CLIP_DURATION_BEATS && at < c.timelineStartBeat + c.durationBeats - MIN_CLIP_DURATION_BEATS);
    const where = musicalPosition(at, beatsPerBar());
    if (!under.length) {
      session.say('refused', 'SPLIT_OUTSIDE_CLIP', `No clip on ${session.state.tracks[trackIndex].name} is under ${where}.`);
      return;
    }
    const outcome = session.apply({
      name: 'batch', args: { commands: under.map((c) => ({ name: 'splitClipAtBeat', args: { clipId: c.id, splitBeat: at } })) },
    });
    if (outcome.ok) onAnnounce(`Split ${session.state.tracks[trackIndex].name} at ${where}.`);
  }

  // ---- clipboard (OPERATION THE CUTTING ROOM). Cut and Delete are ordinary
  // deleteClip / deleteRegion edits; Paste is one pasteClipboard edit. The
  // clipboard itself is plain data in this panel and never enters history.

  function currentRegion() {
    const r = session.state.transport.loopRange;
    if (!r) return null;
    return { startBeat: r[0], endBeat: r[1], trackIndices: ui.regionScope === 'lane' ? [ui.selectedTrack] : [0, 1, 2, 3, 4, 5, 6, 7] };
  }

  function describeRegion(region) {
    const bpb = beatsPerBar();
    const where = region.trackIndices.length === 8 ? 'all lanes' : session.state.tracks[region.trackIndices[0]].name;
    return `${musicalPosition(region.startBeat, bpb)} to ${musicalPosition(region.endBeat, bpb)} on ${where}`;
  }

  /** What Cut/Copy act on: the selected clip, else the ruler range, else nothing. */
  function selectionBoard() {
    const clip = clipById(ui.selectedClipId);
    try {
      if (clip) return { board: clipboardFromClips(session.state, [clip.id]), clip };
      const region = currentRegion();
      if (region) return { board: clipboardFromRegion(session.state, region), region };
    } catch (err) {
      session.say('refused', err.code || 'COPY_REFUSED', err.message);
      return null;
    }
    session.say('notice', 'NOTHING_SELECTED', 'Select a clip, or drag a range on the ruler, first.');
    return null;
  }

  function copySelection() {
    const picked = selectionBoard();
    if (!picked) return false;
    ui.clipboard = picked.board;
    render();
    onAnnounce(`Copied ${describeBoard(picked.board)}.`);
    return true;
  }

  function cutSelection() {
    const picked = selectionBoard();
    if (!picked) return false;
    const outcome = picked.clip
      ? session.apply({ name: 'deleteClip', args: { clipId: picked.clip.id } })
      : session.apply({ name: 'deleteRegion', args: picked.region });
    if (!outcome.ok) return false;
    ui.clipboard = picked.board;
    if (picked.clip) ui.selectedClipId = null;
    render();
    onAnnounce(`Cut ${describeBoard(picked.board)}. Paste puts it back anywhere; Undo restores it here.`);
    return true;
  }

  function deleteRange() {
    const region = currentRegion();
    if (!region) { session.say('notice', 'NOTHING_SELECTED', 'Drag a range on the ruler first.'); return; }
    const outcome = session.apply({ name: 'deleteRegion', args: region });
    if (outcome.ok) onAnnounce(`Removed ${describeRegion(region)}. The source audio is kept; Undo brings it back.`);
  }

  async function pasteAt(beat, trackIndex) {
    const board = ui.clipboard;
    if (!board) { session.say('notice', 'CLIPBOARD_EMPTY', 'Nothing to paste: cut or copy a clip or a range first.'); return; }
    const at = Math.max(0, beat);
    const outcome = await session.pasteClipboard(board, at, trackIndex);
    if (!outcome.ok || ui.disposed) return;
    const ids = outcome.result.clipIds;
    const pasted = ids.map(clipById).filter(Boolean);
    const overlaps = pasted.some((p) => session.state.clips.some((c) => !ids.includes(c.id) && c.trackIndex === p.trackIndex
      && c.timelineStartBeat < p.timelineStartBeat + p.durationBeats - 1e-9 && p.timelineStartBeat < c.timelineStartBeat + c.durationBeats - 1e-9));
    if (pasted.length === 1) select(pasted[0].id); else { ui.selectedClipId = null; render(); }
    const where = board.lanes.length === 1 ? session.state.tracks[trackIndex].name : 'their own lanes';
    onAnnounce(`Pasted ${pasted.length} clip${pasted.length === 1 ? '' : 's'} at ${musicalPosition(at, beatsPerBar())} on ${where}.${overlaps ? ' It overlaps audio already there; both play.' : ''}`);
  }

  // ---- right-click (or the Menu key) on a clip or a lane

  function closeMenu({ refocus = false } = {}) {
    if (!ui.menu) return;
    const back = ui.menu.returnFocus;
    ui.menu = null;
    menuEl.hidden = true;
    replaceChildren(menuEl, []);
    if (refocus && back?.isConnected) back.focus();
  }

  function openMenu(x, y, items, returnFocus) {
    closeMenu();
    ui.menu = { returnFocus };
    replaceChildren(menuEl, items.map(([label, keys, fn, disabled]) => h('button', {
      type: 'button', class: 'daw__menu-item', role: 'menuitem', disabled: disabled ? 'true' : undefined,
      'aria-keyshortcuts': keys || undefined, dataset: { action: label },
      onclick: () => { closeMenu({ refocus: true }); fn(); },
    }, [h('span', { text: label }), keys ? h('kbd', { text: keys.replace('Control+', 'Ctrl+') }) : null])));
    menuEl.hidden = false;
    const vw = win.innerWidth || 1280;
    const vh = win.innerHeight || 800;
    const w = menuEl.offsetWidth || 220;
    const hgt = menuEl.offsetHeight || 260;
    menuEl.style.left = `${Math.max(8, Math.min(x, vw - w - 8))}px`;
    menuEl.style.top = `${Math.max(8, Math.min(y, vh - hgt - 8))}px`;
    menuEl.querySelector('.daw__menu-item:not([disabled])')?.focus();
  }

  function menuFor(clientX, clientY, clipEl, returnFocus, laneEl = null) {
    const at = snap(beatAt(clientX));
    const lane = clipEl
      ? clipById(clipEl.dataset.clipId)?.trackIndex ?? laneAt(clientY)
      : (laneEl ? Number(laneEl.dataset.track) : laneAt(clientY));
    const where = musicalPosition(at, beatsPerBar());
    const region = currentRegion();
    const paste = ['Paste here', 'Control+V', () => { void pasteAt(at, lane); }, !ui.clipboard];
    if (clipEl) {
      const id = clipEl.dataset.clipId;
      if (ui.selectedClipId !== id) select(id);
      const c = clipById(id);
      const inside = c && at > c.timelineStartBeat && at < c.timelineStartBeat + c.durationBeats;
      openMenu(clientX, clientY, [
        ['Cut', 'Control+X', () => cutSelection()],
        ['Copy', 'Control+C', () => copySelection()],
        paste,
        [`Split here (${where})`, '', () => splitSelected(at), !inside],
        ['Split at playhead', 'S', () => splitSelected()],
        ['Duplicate', 'Control+D', () => duplicateSelected()],
        ['Delete', 'Delete', () => deleteSelected()],
      ], returnFocus);
      return;
    }
    ui.selectedTrack = lane;
    ui.selectedClipId = null;
    render();
    openMenu(clientX, clientY, [
      paste,
      [`Split lane here (${where})`, '', () => splitLaneAt(lane, at)],
      ['Cut range', 'Control+X', () => cutSelection(), !region],
      ['Copy range', 'Control+C', () => copySelection(), !region],
      ['Delete range', 'Delete', () => deleteRange(), !region],
    ], returnFocus);
  }

  on(menuEl, 'keydown', (ev) => {
    const items = [...menuEl.querySelectorAll('.daw__menu-item:not([disabled])')];
    const i = items.indexOf(doc.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (ev.key === 'Tab') closeMenu();
  });
  on(doc, 'pointerdown', (ev) => { if (ui.menu && !menuEl.contains(ev.target)) closeMenu(); }, true);

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
    const onGrip = !ui.drawLevels && ev.target.closest?.('[data-grip]');
    const onClip = !ui.drawLevels && ev.target.closest?.('.daw__clip');
    if (!onGrip && !onClip) {
      const hit = envelopeHit(ev);
      if (hit && hit.kind === 'add' && ev.pointerType === 'touch') {
        // A finger on an empty stretch of lane may be the start of a pan.
        // The point is placed on lift, only if the finger did not travel.
        ui.pendingTap = { hit, pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
        return;
      }
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
    // preventDefault keeps the browser from moving focus, and render() puts
    // focus back on whichever clip had it (focusin then selects it). Focus the
    // pressed clip first so another clip that held focus cannot steal the
    // selection back.
    if (doc.activeElement !== el) el.focus({ preventScroll: true });
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

  on(lanes, 'contextmenu', (ev) => {
    if (ui.drawLevels) return;
    if (!ev.target.closest?.('.daw__lane, .daw__clip')) return;
    ev.preventDefault();
    const clipEl = ev.target.closest('.daw__clip');
    menuFor(ev.clientX, ev.clientY, clipEl, clipEl ?? lanes, ev.target.closest('.daw__lane'));
  });

  // OPERATION STUDIO SURGEON: double-click a clip (not in Draw levels) opens Stem-Focus.
  on(lanes, 'dblclick', (ev) => {
    if (ui.drawLevels || ev.target.closest?.('[data-env-point], [data-grip="gain"]')) return;
    const clipNode = ev.target.closest?.('.daw__clip');
    if (!clipNode) return;
    ev.preventDefault();
    openClipFocus(clipNode.dataset.clipId, clipNode);
  });

  on(lanes, 'dblclick', (ev) => {
    const handle = ev.target.closest?.('[data-env-point]');
    if (!handle || (!ui.drawLevels && ev.target.closest?.('.daw__clip'))) return;
    ev.preventDefault();
    ui.selectedPoint = { trackIndex: Number(handle.dataset.track), index: Number(handle.dataset.index) };
    deleteSelectedPoint();
  });

  /** Take back a point gesture the browser cancelled (a touch that became a pan). */
  function cancelEnvelopeDrag() {
    const env = ui.envDrag;
    if (!env) return;
    ui.envDrag = null;
    const now = session.state.tracks[env.trackIndex]?.gainPoints ?? [];
    session.endGesture();
    if (env.moved && JSON.stringify(now) !== JSON.stringify(env.before)) {
      session.undo();
      ui.selectedPoint = null;
    }
    render();
  }

  on(win, 'pointermove', (ev) => {
    const tap = ui.pendingTap;
    if (tap && ev.pointerId === tap.pointerId && Math.hypot(ev.clientX - tap.x, ev.clientY - tap.y) > 8) ui.pendingTap = null;
    const env = ui.envDrag;
    if (env && ev.pointerId === env.pointerId) {
      // A press that has not travelled is a selection, not a move: the point
      // keeps its exact position (a click must not re-snap or re-quantise it).
      if (!env.moved && Math.hypot(ev.clientX - env.grabX, ev.clientY - env.grabY) < 3) return;
      env.moved = true;
      const laneEl = lanes.querySelector(`.daw__lane[data-track="${env.trackIndex}"]`);
      const track = session.state.tracks[env.trackIndex];
      if (!laneEl || !track) return;
      const rect = laneEl.getBoundingClientRect();
      // A level-only drag keeps the point's exact beat; it snaps to the grid
      // only once the pointer has travelled sideways.
      if (!env.slid && Math.abs(ev.clientX - env.grabX) >= 4) env.slid = true;
      const beat = env.slid ? snap((ev.clientX - rect.left) / pxPerBeat(), ev.altKey ? 'off' : false) : env.startBeat;
      const db = pointerDb(ev.clientY - rect.top, track, ev.altKey);
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
    const tap = ui.pendingTap;
    if (tap && (!ev || ev.pointerId === tap.pointerId)) {
      ui.pendingTap = null;
      beginEnvelopeDrag(tap.hit, { pointerId: tap.pointerId, clientX: tap.x, clientY: tap.y });
    }
    if (ui.envDrag && (!ev || ev.pointerId === ui.envDrag.pointerId)) {
      const { trackIndex, moved } = ui.envDrag;
      ui.envDrag = null;
      session.endGesture();
      // A hand-shaped curve is the musician's from the moment the pointer lifts.
      if (moved) dropEnvelopePreview(trackIndex);
      render();
      const sp = ui.selectedPoint;
      if (sp) lanes.querySelector(`[data-env-point][data-track="${sp.trackIndex}"][data-index="${sp.index}"]`)?.focus({ preventScroll: true });
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
      if (outcome.ok) onAnnounce(`Moved to ${session.state.tracks[d.lane].name}, ${musicalPosition(d.start, beatsPerBar())}.`);
    } else if (d.grip === 'start' && d.start !== undefined) {
      outcome = session.apply({ name: 'trimClip', args: { clipId: c.id, edge: 'start', deltaBeats: d.start - c.timelineStartBeat } });
    } else if (d.grip === 'end' && d.end !== undefined) {
      outcome = session.apply({ name: 'trimClip', args: { clipId: c.id, edge: 'end', deltaBeats: d.end - (c.timelineStartBeat + c.durationBeats) } });
    } else if (d.grip === 'slip') {
      if (d.slip !== undefined && d.slip !== c.sourceOffsetSec) {
        outcome = session.apply({ name: 'slipClip', args: { clipId: c.id, sourceOffsetSec: d.slip } });
        if (outcome.ok) onAnnounce(`Source in-point ${d.slip.toFixed(3)} seconds. The clip stayed at ${musicalPosition(c.timelineStartBeat, beatsPerBar())}.`);
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
    if (ui.pendingTap && ev.pointerId === ui.pendingTap.pointerId) ui.pendingTap = null;
    if (ui.envDrag && ev.pointerId === ui.envDrag.pointerId) cancelEnvelopeDrag();
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
    levels: 'Draw levels: click a lane to add a point on the Snap grid (Alt places it freely), drag a point to shape the curve, double-click or Delete removes it. Clips stay still. Esc or G returns to clip editing.',
  };
  hintLine.textContent = HINTS.idle;
  on(timeline, 'pointerover', (ev) => {
    if (ui.drag) return;
    const grip = ev.target.dataset?.grip;
    let key = ui.drawLevels ? 'levels' : 'idle';
    if (ev.target.closest?.('.daw__ruler')) key = 'ruler';
    else if (ui.drawLevels) key = 'levels';
    else if (grip && HINTS[grip]) key = grip;
    else if (ev.target.closest?.('.daw__clip')) key = 'move';
    hintLine.textContent = HINTS[key];
  });
  on(timeline, 'pointerleave', () => { if (!ui.drag) hintLine.textContent = ui.drawLevels ? HINTS.levels : HINTS.idle; });

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
      if (outcome.ok) onAnnounce(`Loop from ${musicalPosition(d.range[0], beatsPerBar())} to ${musicalPosition(d.range[1], beatsPerBar())}.`);
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
  function setDrawLevels(on) {
    ui.drawLevels = Boolean(on);
    root.classList.toggle('is-drawing-levels', ui.drawLevels);
    levelsBtn.setAttribute('aria-pressed', String(ui.drawLevels));
    hintLine.textContent = ui.drawLevels ? HINTS.levels : HINTS.idle;
    onAnnounce(ui.drawLevels
      ? 'Draw levels on. Click a lane to add a point, drag to move it, double-click to remove it. Clips are held still. Escape returns to clip editing.'
      : 'Draw levels off. Clips can be moved again.');
  }
  levelsBtn.addEventListener('click', () => setDrawLevels(!ui.drawLevels));
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

  // ------------------------------------------------------------- place a stem

  function playheadBar() {
    const beat = session.playheadBeat();
    return Math.floor((Number.isFinite(beat) ? beat : 0) / beatsPerBar()) + 1;
  }
  placeAtPlayhead.addEventListener('click', () => { placeBar.value = String(playheadBar()); });
  placeDismiss.addEventListener('click', () => { clearStemOffer(); onAnnounce('The Library stem was set aside. Nothing was placed.'); });
  placeGo.addEventListener('click', () => { void placeOffered(); });

  async function placeOffered() {
    const offer = stemOffer();
    if (!offer) return;
    if (placeLane.value === '') { session.say('refused', 'PLACE_LANE_REQUIRED', 'Choose the lane the stem goes on.'); placeLane.focus(); return; }
    const bar = Number(placeBar.value);
    if (!Number.isInteger(bar) || bar < 1) { session.say('refused', 'PLACE_POSITION_REQUIRED', 'Choose the bar the stem starts at (1 or later).'); placeBar.focus(); return; }
    const trackIndex = Number(placeLane.value);
    const choice = placeLength.value;
    const startSec = Math.max(0, Math.min(3600, Number(placeStart.value) || 0));
    const sel = choice === 'selection' && offer.window ? sectionForWindow(offer.window.startSec, offer.window.endSec) : null;
    if (choice === 'selection' && !sel) { session.say('refused', 'PLACE_SELECTION_INVALID', 'The Focus selection cannot be placed; choose a length.'); return; }
    placeGo.disabled = true;
    placeGo.textContent = 'Decoding…';
    try {
      const card = await loadStemCard(offer.stemSetId, fetchJson);
      const outcome = await session.placeStem(offer, {
        trackIndex,
        startBeat: (bar - 1) * beatsPerBar(),
        section: sel ? { startSec: sel.startSec, seconds: sel.seconds } : choice === 'full' ? 'full' : { startSec, seconds: Number(choice) },
        url: sel ? withSection(offer.audioUrl, sel.startSec, sel.seconds) : choice === 'full' ? offer.audioUrl : withSection(offer.audioUrl, startSec, choice),
        lengthSec: sel ? sel.lengthSec : undefined,
        bpm: Number(card?.bpm) || null,
        bpmSource: card?.bpm_source ?? null,
      });
      if (!outcome.ok || ui.disposed) return;
      ui.selectedTrack = trackIndex;
      ui.selectedClipId = outcome.result.clipId;
      const label = liveStemLabel(offer.stemSetId, offer.role) ?? offer.displayName;
      clearStemOffer();
      session.say('notice', 'STEM_PLACED', `${label} (${roleLabel(offer.role)} of ${offer.trackName || 'its recording'}) is on ${session.state.tracks[trackIndex].name} at bar ${bar}. Nothing is playing; press Play to hear it.`);
      onAnnounce(`Placed ${label} on ${session.state.tracks[trackIndex].name} at bar ${bar}.`);
      render();
    } finally {
      placeGo.disabled = false;
      placeGo.textContent = 'Place on lane';
    }
  }

  const offStemOffer = onStemOffer((offer) => {
    if (ui.disposed || !root.isConnected) return;
    renderPlace();
    if (offer) placeBox.open = true;
  });
  listeners.push(offStemOffer);
  listeners.push(onStemCard(() => { if (!ui.disposed && root.isConnected) render(); }));

  // ------------------------------------------------------------- Stem-Focus (clip mode)
  // OPERATION STUDIO SURGEON. The shared Focus panel drives THIS clip through
  // the same DawSession.apply commands as the inspector: every change is one
  // undoable step in the one history, and the stem file never changes.

  function focusAdapter(clipId) {
    const clipNow = () => clipById(clipId);
    const assetNow = () => { const c = clipNow(); return c ? session.state.assets[c.assetId] ?? null : null; };
    const rateOf = (c, a) => { try { return sourceAdvanceRate(c, a, session.bpm); } catch { return 1; } };
    const spanOf = (c, a) => {
      let used = 0;
      try { used = beatsToSourceSeconds(c.durationBeats, c, a, session.bpm); } catch { used = (c.durationBeats * 60) / session.bpm; }
      return { startSec: c.sourceOffsetSec, endSec: Math.min(a.durationSec, c.sourceOffsetSec + used), durationSec: a.durationSec, rate: rateOf(c, a) };
    };
    return {
      clip: clipNow,
      identity() {
        const c = clipNow();
        const a = assetNow();
        if (!c || !a) return null;
        const src = a.source ?? {};
        const live = stemLabelOf(a);
        return {
          displayName: live ?? (src.role ?? a.name), customName: Boolean(live && live !== src.role),
          role: src.role ?? null, trackName: src.title ?? null, trackId: src.trackId ?? null,
          stemSetId: src.stemSetId ?? null, method: src.method ?? null, modelName: src.modelName ?? null,
          available: Boolean(session.buffers[a.bufferReference]),
        };
      },
      describe() {
        const c = clipNow();
        const a = assetNow();
        if (!c || !a) return null;
        const rate = rateOf(c, a);
        return [
          `${session.state.tracks[c.trackIndex].name} (lane ${c.trackIndex + 1}, bank ${trackGroup(c.trackIndex)})`,
          musicalPosition(c.timelineStartBeat, beatsPerBar()),
          `${(c.durationBeats / beatsPerBar()).toFixed(2)} bars`,
          Math.abs(rate - 1) < 1e-6 ? 'own speed' : `speed ×${rate.toFixed(3)}`,
          c.pitchSemitones ? `${c.pitchSemitones > 0 ? '+' : ''}${c.pitchSemitones} st` : null,
          c.clipGainDb ? fmtDb(c.clipGainDb) : null,
        ].filter(Boolean).join(' · ');
      },
      previewUrl() {
        const a = assetNow();
        const ref = a?.bufferReference;
        return typeof ref === 'string' && ref.startsWith('/api/stems/') ? ref : null;
      },
      sourceSpan() {
        const c = clipNow();
        const a = assetNow();
        return c && a ? spanOf(c, a) : null;
      },
      peaks() {
        const a = assetNow();
        const p = a ? peaksFor(a.bufferReference) : null;
        return p ? { min: p.min, max: p.max } : null;
      },
      beatAtSource(sec) {
        const c = clipNow();
        const a = assetNow();
        if (!c || !a || !Number.isFinite(sec)) return null;
        const span = spanOf(c, a);
        const beat = c.timelineStartBeat + ((sec - span.startSec) / span.rate) * (session.bpm / 60);
        const rel = beat - c.timelineStartBeat;
        return rel >= MIN_CLIP_DURATION_BEATS && rel <= c.durationBeats - MIN_CLIP_DURATION_BEATS ? beat : null;
      },
      trimToSource(inSec, outSec) {
        const c = clipNow();
        const a = assetNow();
        if (!c || !a) return null;
        const rate = rateOf(c, a);
        const from = Math.max(0, Math.min(a.durationSec, inSec));
        const to = Math.max(from, Math.min(a.durationSec, outSec));
        const beats = ((to - from) / rate) * (session.bpm / 60);
        if (beats < MIN_CLIP_DURATION_BEATS) {
          session.say('refused', 'TRIM_TOO_SHORT', 'The selection is shorter than the shortest clip; widen it first.');
          return { ok: false, error: new Error('the selection is shorter than the shortest clip') };
        }
        // Shorten first, slip, then lengthen: each step stays inside the stem.
        const shorter = Math.min(c.durationBeats, beats);
        const commands = [];
        if (shorter < c.durationBeats - 1e-9) commands.push({ name: 'trimClip', args: { clipId, edge: 'end', deltaBeats: shorter - c.durationBeats } });
        if (Math.abs(from - c.sourceOffsetSec) > 1e-9) commands.push({ name: 'slipClip', args: { clipId, sourceOffsetSec: from } });
        if (beats > shorter + 1e-9) commands.push({ name: 'trimClip', args: { clipId, edge: 'end', deltaBeats: beats - shorter } });
        if (!commands.length) return { ok: true, result: 'noop' };
        return session.apply({ name: 'batch', args: { commands } });
      },
      splitAtBeat(beat) {
        if (beat === null) return null;
        return session.apply({ name: 'splitClipAtBeat', args: { clipId, splitBeat: beat } });
      },
      apply: (command, key) => session.apply(command, key),
      endGesture: () => session.endGesture(),
      limits: () => ({ gainMin: MIN_CLIP_GAIN_DB, gainMax: MAX_CLIP_GAIN_DB }),
      fadeMax() {
        const c = clipNow();
        return c ? Math.max(MIN_CLIP_DURATION_BEATS, Math.min(c.durationBeats, 16)) / 2 : 1;
      },
      tempoKnown: () => assetNow()?.nativeBpm != null,
      actions: {
        cut: () => { select(clipId); return cutSelection(); },
        copy: () => { select(clipId); return copySelection(); },
        duplicate: () => {
          const outcome = session.apply({ name: 'duplicateClip', args: { clipId } });
          if (outcome.ok) render();
          return outcome;
        },
        delete: () => { select(clipId); deleteSelected(); },
        undo: () => session.undo(),
        redo: () => session.redo(),
        canUndo: () => session.edit.canUndo,
        canRedo: () => session.edit.canRedo,
        fitTempo: () => session.apply({ name: 'stretchClipKeepingSource', args: { clipId, ratioOrAuto: 'auto' } }),
      },
      hearInPlace() {
        const c = clipNow();
        if (!c) return;
        session.seek(c.timelineStartBeat);
        void play();
      },
      stopArrangement: () => { if (session.isPlaying()) session.stop(); },
      arrangementPlaying: () => session.isPlaying(),
      onChange(fn) { focusListeners.add(fn); return () => focusListeners.delete(fn); },
    };
  }

  function openClipFocus(clipId, trigger) {
    if (!clipById(clipId)) return null;
    if (ui.selectedClipId !== clipId) select(clipId);
    return openStemFocus({
      mode: 'clip', clip: focusAdapter(clipId), win, announce: onAnnounce,
      // The clip element is rebuilt by every render: return focus to its
      // current element, else to the inspector's Focus button.
      trigger: null,
      fallbackFocus: () => (clipById(clipId)
        ? lanes.querySelector(`[data-clip-id="${esc(clipId)}"]`)
        : null) ?? inspector.querySelector('[data-action="focus-clip"]') ?? (trigger?.isConnected ? trigger : null),
    });
  }

  // ------------------------------------------------------------- keyboard

  const pageTextSelected = () => {
    const sel = win.getSelection?.();
    return Boolean(sel && !sel.isCollapsed && String(sel).trim().length);
  };
  const typing = (t) => t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)
    || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  on(doc, 'keydown', (ev) => {
    if (ui.disposed || !root.isConnected || root.closest('[hidden]')) return;
    // Keys inside a dialog (Stem-Focus, Save, Open) belong to that dialog.
    if (ev.target?.closest?.('dialog')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Escape' && ui.menu) { ev.preventDefault(); closeMenu({ refocus: true }); return; }
    if (ui.menu && menuEl.contains(ev.target)) return; // the menu's own keys
    if (ev.key === 'Escape') {
      // Leaving Draw levels is a mode change, not a transport command: the
      // music keeps playing. A second Escape stops as it always has.
      if (ui.drawLevels && !typing(ev.target)) { ev.preventDefault(); setDrawLevels(false); return; }
      session.stop();
      return;
    }
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
        nudgeSelectedPoint(ev.key, ev.shiftKey);
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelectedPoint({ refocus: true });
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
    } else if (mod && !ev.shiftKey && !ev.altKey && (ev.key === 'x' || ev.key === 'X' || ev.key === 'c' || ev.key === 'C')
      && (ui.selectedClipId || session.state.transport.loopRange) && !pageTextSelected()) {
      // Only when there is an arrangement selection: otherwise the browser's
      // own copy of selected page text is left alone.
      ev.preventDefault();
      if (ev.key === 'x' || ev.key === 'X') cutSelection(); else copySelection();
    } else if (mod && !ev.shiftKey && !ev.altKey && (ev.key === 'v' || ev.key === 'V') && ui.clipboard) {
      ev.preventDefault();
      const target = clipById(ui.selectedClipId)?.trackIndex ?? ui.selectedTrack;
      void pasteAt(session.playheadBeat(), target);
    } else if (!mod && (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) && onClipTarget) {
      ev.preventDefault();
      const r = onClipTarget.getBoundingClientRect();
      menuFor(r.left + Math.min(r.width / 2, 40), r.top + r.height / 2, onClipTarget, onClipTarget);
    } else if (!mod && (ev.key === 'Delete' || ev.key === 'Backspace') && ui.selectedClipId) {
      ev.preventDefault(); deleteSelected();
    } else if (!mod && (ev.key === 'Delete' || ev.key === 'Backspace') && session.state.transport.loopRange
      && (ev.target === doc.body || root.contains(ev.target))) {
      ev.preventDefault(); deleteRange();
    } else if (!mod && (ev.key === 's' || ev.key === 'S') && ui.selectedClipId) {
      ev.preventDefault(); splitSelected();
    } else if (!mod && !ev.altKey && (ev.key === 's' || ev.key === 'S')
      && (ev.target === doc.body || root.contains(ev.target))) {
      ev.preventDefault(); splitLaneAt(ui.selectedTrack, session.playheadBeat());
    } else if (!mod && !ev.altKey && (ev.key === 'f' || ev.key === 'F') && ui.selectedClipId) {
      ev.preventDefault();
      openClipFocus(ui.selectedClipId, onClipTarget ?? lanes.querySelector(`[data-clip-id="${esc(ui.selectedClipId)}"]`));
    } else if (!mod && (ev.key === ',' || ev.key === '.') && ui.selectedClipId) {
      ev.preventDefault(); slipSelectedBy(ev.key === ',' ? -1 : 1);
    } else if (!mod && !ev.altKey && (ev.key === 'g' || ev.key === 'G')
      && (ev.target === doc || ev.target === doc.body || ev.target === doc.documentElement || root.contains(ev.target))) {
      // Only from the arrangement (or nowhere in particular): G pressed on
      // the Performance desk or in another panel is not a levels gesture.
      ev.preventDefault();
      setDrawLevels(!ui.drawLevels);
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
  producerHandle = opts.producer?.({ container: producerMount, session, onAnnounce, rerender: () => (ui.envDrag ? paintLiveEnvelope(ui.envDrag.trackIndex) : render()), selectedClipId: () => ui.selectedClipId }) ?? null;
  const producerDispose = typeof producerHandle === 'function' ? producerHandle : producerHandle?.dispose ?? null;
  producerPreview = typeof producerHandle?.preview === 'function' ? producerHandle.preview : () => [];
  producerEnvelopes = typeof producerHandle?.envelopes === 'function' ? producerHandle.envelopes : () => [];

  render();
  if (stemOffer()) placeBox.open = true; // chosen in the Library before the Arrangement opened

  const api = {
    session,
    ui,
    render,
    select,
    clipboard: () => ui.clipboard,
    cutSelection,
    copySelection,
    pasteAt,
    deleteRange,
    splitLaneAt,
    elements: {
      root, playBtn, pauseBtn, stopBtn, loopBtn, undoBtn, redoBtn, bpmInput, snapSelect, zoomIn, zoomOut,
      masterRange, monitorRange, nameInput, saveBtn, openSelect, openBtn, newBtn, exportBtn, ruler, lanes,
      headers, inspector, messages, importRows, scroller, playhead, producerMount, menu: menuEl,
      place: { box: placeBox, lane: placeLane, bar: placeBar, length: placeLength, start: placeStart, go: placeGo, dismiss: placeDismiss, atPlayhead: placeAtPlayhead },
    },
    placeOffered,
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
