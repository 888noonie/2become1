// js/arrangement/daw-session.js — the Studio arrangement session.
//
// OPERATION FULL HOUSE. One musician-facing session joins the pieces that were
// built and tested separately:
//
//   EditEngine (edit-api.js)        the ONE authoritative ProjectState, every
//                                   edit validated, atomic and undoable
//   compileRenderPlan               the shared plan both hosts consume
//   RealtimeEngine (Clockwork)      the live transport: Play, Stop, Pause,
//                                   Seek and Loop on the actual arrangement
//   renderOffline + encodeWav24     the accepted offline bounce for Export
//   /api/arrangements               save and reopen (asset references only)
//
// Decoded audio lives here, in `buffers`, keyed by each asset's persistent
// bufferReference (a Studio stem URL). It never enters the project JSON.
// No AudioContext exists until the musician presses Play; loading, editing,
// saving and opening make no sound and open no audio device.

import { EditEngine, InvalidEditError } from './edit-api.js';
import { compileRenderPlan, LIMITER_CEILING_DB } from './render-plan.js';
import { encodeWav24 } from './wav.js';

export const SAMPLE_RATE = 48000;
export const ROLES = Object.freeze(['vocals', 'drums', 'bass', 'other']);
export const GROUP_BASE = Object.freeze({ A: 0, B: 4 });
export const ROLE_LABEL = Object.freeze({ vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other' });
export const DEFAULT_MONITOR_DB = -12;
export const EXPORT_TAIL_SEC = 0.5;
export const EXPORT_CLIP_LIMIT = 32;
const MIB = 1024 * 1024;
/** The Stem Desk's accepted decoded-PCM budgets, unchanged. */
export const DECODE_LIMITS = Object.freeze({
  section: Object.freeze({ perStem: 40 * MIB, total: 320 * MIB }),
  full: Object.freeze({ perStem: 128 * MIB, total: 1024 * MIB }),
});
export const PEAK_BUCKET_FRAMES = 256;

const peakCache = new Map();

/** Min/max waveform peaks from REAL decoded PCM (cached per reference). */
export function computePeaks(channels, bucketFrames = PEAK_BUCKET_FRAMES) {
  const l = channels[0];
  const r = channels[1] ?? channels[0];
  const n = Math.ceil(l.length / bucketFrames);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let b = 0; b < n; b += 1) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(l.length, (b + 1) * bucketFrames);
    for (let i = b * bucketFrames; i < end; i += 1) {
      const v = (l[i] + r[i]) * 0.5;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { bucketFrames, sampleRate: SAMPLE_RATE, min, max };
}

export function peaksFor(reference) {
  return peakCache.get(reference) ?? null;
}

export function beatsToFrames(beats, bpm) {
  return Math.round(beats * (60 / bpm) * SAMPLE_RATE);
}

export function framesToBeats(frames, bpm) {
  return (frames / SAMPLE_RATE) * (bpm / 60);
}

function slug(text) {
  const s = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'arrangement';
}

function errorText(err) {
  if (err instanceof InvalidEditError) return err.message;
  return err?.message || String(err);
}

const ACTIVE = new Set(['starting', 'playing', 'seeking']);

export class DawSession {
  /**
   * @param {object} deps {fetchImpl, createContext, decodeAudio?, RealtimeEngine,
   *   renderOffline, StretchFactory, modules:{limiterModuleUrl}, onChange?,
   *   onMessage?, randomId?, engineOptions?}
   */
  constructor(deps) {
    this.deps = deps;
    this.edit = new EditEngine();
    this.buffers = {}; // ONE object for the whole session: the engine reads it live
    this.decodedBytes = 0;
    this.ctx = null;
    this.monitor = null;
    this.monitorDb = DEFAULT_MONITOR_DB;
    this.engine = null;
    this.enginePrep = null;
    this.cueFrame = 0;
    this.cueBeat = 0; // exact musical cue (frames round; splits at the cue must not)
    this.projectId = null;
    this.projectName = 'Untitled arrangement';
    this.savedRevision = null;
    this.lastExport = null;
    this.messages = [];
    this._sync = Promise.resolve();
    this._disposed = false;
  }

  // ---------------------------------------------------------------- reading

  get state() { return this.edit.state; }

  get bpm() { return this.edit.state.transport.masterBpm; }

  get dirty() { return this.savedRevision !== this.edit.revision; }

  phase() {
    if (this.enginePrep) return 'preparing';
    return this.engine ? this.engine.state().phase : 'audio off';
  }

  isPlaying() { return ACTIVE.has(this.phase()); }

  /** The beat being HEARD now (the engine clock minus output + limiter delay). */
  playheadBeat() {
    const e = this.engine;
    if (e && ACTIVE.has(e.state().phase)) {
      const heardAt = this.ctx.currentTime - e.outputDelaySec();
      return framesToBeats(Math.max(0, e.playheadAt(heardAt)), this.bpm);
    }
    return this.cueBeat;
  }

  arrangementEndBeat() {
    let end = 0;
    for (const c of this.edit.state.clips) end = Math.max(end, c.timelineStartBeat + c.durationBeats);
    return end;
  }

  #emit(kind = 'state') {
    if (!this._disposed) this.deps.onChange?.(kind);
  }

  say(kind, code, message) {
    const entry = { kind, code, message, at: Date.now() };
    this.messages.push(entry);
    if (this.messages.length > 20) this.messages.shift();
    this.deps.onMessage?.(entry);
    return entry;
  }

  // ---------------------------------------------------------------- editing

  /** Run one edit (or a coalesced gesture step); refusals are reported, never thrown. */
  apply(command, gestureKey = null) {
    try {
      const result = gestureKey ? this.edit.runGesture(command, gestureKey) : this.edit.run(command).result;
      this.#afterEdit();
      return { ok: true, result };
    } catch (err) {
      this.say('refused', err.code || 'EDIT_REFUSED', errorText(err));
      this.#emit('refused');
      return { ok: false, error: err };
    }
  }

  endGesture() { this.edit.endGesture(); }

  undo() {
    if (!this.edit.undo()) return false;
    this.#afterEdit();
    return true;
  }

  redo() {
    if (!this.edit.redo()) return false;
    this.#afterEdit();
    return true;
  }

  #afterEdit() {
    this.#emit('edit');
    this.sync();
  }

  /**
   * Push the current ProjectState to the live engine: mixer moves ramp on the
   * shared backbone; clip edits re-anchor through the Seek handover; a loop
   * change goes through the engine's own setLoop. Serialized, so edits apply
   * in order.
   */
  sync() {
    this._sync = this._sync.then(async () => {
      const e = this.engine;
      if (!e || this._disposed) return;
      const plan = compileRenderPlan(this.edit.state);
      const outcome = await e.replacePlan(plan);
      if (outcome?.refused) this.#emit('refused');
      this.#syncLoop();
    }).catch((err) => { this.say('error', 'SYNC_FAILED', errorText(err)); });
    return this._sync;
  }

  #loopFrames() {
    const loop = this.edit.state.transport.loopRange;
    return loop ? [beatsToFrames(loop[0], this.bpm), beatsToFrames(loop[1], this.bpm)] : null;
  }

  #syncLoop() {
    const e = this.engine;
    if (!e) return;
    const want = this.#loopFrames();
    const have = e.state().loop;
    if (JSON.stringify(want) === JSON.stringify(have)) return;
    e.setLoop(want);
    if (JSON.stringify(e.state().loop) !== JSON.stringify(want)) {
      // Refused by the engine (too short): the reason is in the messages. The
      // project keeps the owner's loop; the engine plays what it accepted.
      this.say('notice', 'LOOP_NOT_PLAYED', 'the loop is shorter than the transport can hand over safely; widen it to at least one beat');
    }
  }

  // ---------------------------------------------------------------- assets

  async #decode(url, limits, signal) {
    if (this.buffers[url]) return this.buffers[url];
    const res = await this.deps.fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const bytes = await res.arrayBuffer();
    const audio = await (this.deps.decodeAudio
      ? this.deps.decodeAudio(bytes)
      : new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(bytes));
    if (audio.sampleRate !== SAMPLE_RATE) throw new Error(`decoded at ${audio.sampleRate} Hz, expected ${SAMPLE_RATE}`);
    if (audio.numberOfChannels > 2) throw new Error('only mono or stereo stems are supported');
    const decoded = audio.length * audio.numberOfChannels * 4;
    if (decoded > limits.perStem) {
      throw new Error(`decodes to ${(decoded / MIB).toFixed(1)} MiB, over the ${limits.perStem / MIB} MiB per-stem limit; choose a shorter section`);
    }
    if (this.decodedBytes + decoded > limits.total) {
      throw new Error(`would hold ${((this.decodedBytes + decoded) / MIB).toFixed(1)} MiB of decoded audio, over the ${limits.total / MIB} MiB limit`);
    }
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c += 1) channels.push(audio.getChannelData(c));
    const record = { channels, durationSec: audio.length / SAMPLE_RATE, bytes: decoded };
    this.buffers[url] = record;
    this.decodedBytes += decoded;
    if (!peakCache.has(url)) peakCache.set(url, computePeaks(channels));
    return record;
  }

  /**
   * Bring one track's four stems onto its four lanes (A: 0-3, B: 4-7) as ONE
   * undoable step. Clips already on those lanes are replaced; their sources
   * stay referenced by history so Undo brings them back.
   *
   * @param {'A'|'B'} group
   * @param {{trackId, title, bpm?, stems: Array<{role,url,method?,modelName?,stemSetId?}>,
   *          section: {startSec, seconds}|'full'}} source
   */
  async importGroup(group, source, { signal } = {}) {
    const base = GROUP_BASE[group];
    if (base === undefined) throw new RangeError('group must be A or B');
    const limits = source.section === 'full' ? DECODE_LIMITS.full : DECODE_LIMITS.section;
    const byRole = new Map(source.stems.map((s) => [s.role, s]));
    const missing = ROLES.filter((r) => !byRole.has(r));
    if (missing.length) throw new Error(`track ${source.title} is missing ${missing.join(', ')} stems`);
    const decoded = [];
    for (const role of ROLES) {
      const stem = byRole.get(role);
      decoded.push([role, stem, await this.#decode(stem.url, limits, signal)]);
      if (this._disposed) return null;
    }
    const empty = this.edit.state.clips.length === 0;
    const bpm = Number.isFinite(source.bpm) && source.bpm > 0 ? source.bpm : null;
    const commands = [];
    if (empty && bpm && Math.abs(bpm - this.bpm) > 1e-6) {
      // A fresh arrangement takes the first track's measured tempo, so the
      // bar ruler lines up with what is heard. Said in the message below.
      commands.push({ name: 'setMasterBpm', args: { masterBpm: Math.round(bpm * 100) / 100 } });
    }
    for (const clip of this.edit.state.clips) {
      if (clip.trackIndex >= base && clip.trackIndex < base + 4) commands.push({ name: 'deleteClip', args: { clipId: clip.id } });
    }
    decoded.forEach(([role, stem, record], i) => {
      const label = `${group} ${ROLE_LABEL[role]}`;
      commands.push({ name: 'setTrackName', args: { trackIndex: base + i, name: label } });
      commands.push({
        name: 'loadStemToTrack',
        args: {
          trackIndex: base + i,
          naturalSpeed: true,
          audioFile: {
            name: `${source.title} — ${ROLE_LABEL[role]}`,
            durationSec: record.durationSec,
            bufferReference: stem.url,
            nativeBpm: bpm,
            nativeBpmSource: bpm ? 'analysis' : undefined,
            source: {
              trackId: source.trackId, title: source.title, role, group,
              method: stem.method ?? null, modelName: stem.modelName ?? null, stemSetId: stem.stemSetId ?? null,
              section: source.section,
            },
          },
        },
      });
    });
    const outcome = this.apply({ name: 'batch', args: { commands } });
    if (outcome.ok) {
      const tempoNote = commands[0]?.name === 'setMasterBpm'
        ? ` Project tempo set to ${commands[0].args.masterBpm} BPM from ${source.title}'s analysis.`
        : '';
      this.say('notice', 'IMPORTED', `${source.title}: four stems on lanes ${group} Vocals to ${group} Other, at their own speed.${tempoNote}`);
    }
    return outcome;
  }

  /**
   * Decode one more source (a passage the Producer found) under the same
   * per-stem and total budgets, before any edit refers to it. Makes no sound.
   */
  async loadSource(url, { signal } = {}) {
    const usesFull = Object.values(this.edit.state.assets).some((a) => a.source?.section === 'full');
    return this.#decode(url, usesFull ? DECODE_LIMITS.full : DECODE_LIMITS.section, signal);
  }

  /** Which library track each bank holds, read from the clips on its lanes. */
  groups() {
    const out = {};
    for (const [group, base] of Object.entries(GROUP_BASE)) {
      const clip = this.edit.state.clips.find((c) => c.trackIndex >= base && c.trackIndex < base + 4
        && this.edit.state.assets[c.assetId]?.source?.trackId);
      const src = clip ? this.edit.state.assets[clip.assetId].source : null;
      if (src) {
        out[group] = { trackId: src.trackId, title: src.title, stemSetId: src.stemSetId ?? null,
          bpm: this.edit.state.assets[clip.assetId].nativeBpm ?? null };
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- transport

  async #ensureEngine() {
    if (this.engine) return this.engine;
    if (this.enginePrep) return this.enginePrep;
    this.enginePrep = (async () => {
      if (!this.ctx) {
        this.ctx = this.deps.createContext(); // only ever reached from Play
        const monitor = this.ctx.createGain();
        monitor.gain.value = 10 ** (this.monitorDb / 20); // unconnected: not a live write
        monitor.connect(this.ctx.destination);
        this.monitor = monitor;
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
      const plan = compileRenderPlan(this.edit.state);
      const engine = new this.deps.RealtimeEngine(this.ctx, plan, this.buffers, {
        ...this.deps.modules,
        StretchFactory: this.deps.StretchFactory,
        destination: this.monitor,
        onStateChange: () => this.#emit('transport'),
        onParked: (frame) => {
          // A new engine parks at frame 0 while it prepares. That is not the
          // musician moving the cue: Play from a cue chosen before the first
          // Play must start there.
          if (!this.engine) return;
          if (frame !== this.cueFrame) { this.cueFrame = frame; this.cueBeat = framesToBeats(frame, this.bpm); }
          try { this.edit.setPlayhead(this.cueBeat); } catch { /* bookkeeping only */ }
          this.#emit('transport');
        },
        onFail: (e) => { this.say('error', e.code, e.message); this.#emit('transport'); },
        onWarn: (e) => { this.say('warning', e.code, e.message); this.#emit('transport'); },
        onCapacityError: (e) => { this.say('refused', e.code, e.message); this.#emit('transport'); },
        onNotice: (e) => { this.say('notice', e.code, e.message); },
        ...(this.deps.engineOptions ?? {}),
      });
      await engine.prepare();
      if (this._disposed) { engine.dispose(); return null; }
      this.engine = engine;
      this.#syncLoop();
      return engine;
    })();
    try {
      return await this.enginePrep;
    } finally {
      this.enginePrep = null;
      this.#emit('transport');
    }
  }

  async play() {
    if (!this.edit.state.clips.length) {
      this.say('notice', 'NOTHING_TO_PLAY', 'bring stems onto the lanes first');
      return false;
    }
    if (this.isPlaying()) return true;
    try {
      const engine = await this.#ensureEngine();
      if (!engine) return false;
      await this._sync;
      if (this.ctx.state !== 'running') await this.ctx.resume();
      engine.play(this.cueFrame);
      this.#emit('transport');
      return ACTIVE.has(engine.state().phase);
    } catch (err) {
      this.say('error', 'PLAY_FAILED', errorText(err));
      this.#emit('transport');
      return false;
    }
  }

  /** Stop fades out and returns to the cue (where Play last started). */
  stop() {
    const e = this.engine;
    if (e && ACTIVE.has(e.state().phase)) e.stop();
    this.#emit('transport');
  }

  /** Pause fades out and moves the cue to the position heard. */
  pause() {
    const e = this.engine;
    if (!e || !ACTIVE.has(e.state().phase)) return;
    const heard = Math.round(e.playheadAt(this.ctx.currentTime - e.outputDelaySec()));
    e.pause();
    this.cueFrame = Math.max(0, heard);
    this.cueBeat = framesToBeats(this.cueFrame, this.bpm);
    try { this.edit.setPlayhead(this.cueBeat); } catch { /* bookkeeping */ }
    this.#emit('transport');
  }

  /** Move the cue (stopped) or hand playback over to `beat` (playing). */
  seek(beat) {
    const frame = Math.max(0, beatsToFrames(beat, this.bpm));
    this.cueFrame = frame;
    this.cueBeat = Math.max(0, beat);
    try { this.edit.setPlayhead(this.cueBeat); } catch { /* bookkeeping */ }
    this.engine?.seek(frame);
    this.#emit('transport');
  }

  setLoop(startBeat, endBeat) {
    return this.apply({ name: 'setLoopRange', args: { startBeat, endBeat } });
  }

  setMonitorDb(db) {
    this.monitorDb = Math.max(-48, Math.min(0, db));
    if (this.monitor && this.ctx) {
      const g = this.monitor.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(10 ** (this.monitorDb / 20), now + 0.05);
    }
  }

  async #retireEngine() {
    const e = this.engine;
    if (!e) return;
    if (ACTIVE.has(e.state().phase) || e.state().phase === 'stopping') {
      e.stop();
      for (let i = 0; i < 40 && !['stopped', 'failed'].includes(e.state().phase); i += 1) {
        await new Promise((r) => globalThis.setTimeout(r, 20));
      }
    }
    e.dispose();
    if (this.engine === e) this.engine = null;
  }

  /** Release the audio device entirely (also on page hide). */
  async closeAudio() {
    await this.#retireEngine();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
    this.ctx = null;
    this.monitor = null;
    this.#emit('transport');
  }

  // ---------------------------------------------------------------- persistence

  #savedDocument() {
    const doc = JSON.parse(this.edit.serialize());
    doc.transport.isPlaying = false;
    return doc;
  }

  async listSaved() {
    const res = await this.deps.fetchImpl('/api/arrangements');
    if (!res.ok) throw new Error(`listing saved arrangements answered ${res.status}`);
    return (await res.json()).items ?? [];
  }

  async save(name = this.projectName) {
    const label = String(name || '').trim() || 'Untitled arrangement';
    const rand = this.deps.randomId ?? (() => Math.random().toString(36).slice(2, 8));
    const id = this.projectId ?? `${slug(label)}-${rand()}`;
    const revision = this.edit.revision;
    const res = await this.deps.fetchImpl(`/api/arrangements/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: label, project: this.#savedDocument() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || `save answered ${res.status}`);
    }
    this.projectId = id;
    this.projectName = label;
    this.savedRevision = revision;
    this.say('notice', 'SAVED', `Saved “${label}”.`);
    this.#emit('saved');
    return { id, name: label, revision };
  }

  /** Reopen a saved arrangement: validated restore, then its stems decoded. */
  async open(id) {
    const res = await this.deps.fetchImpl(`/api/arrangements/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`opening answered ${res.status}`);
    const envelope = await res.json();
    const restored = EditEngine.deserialize(JSON.stringify(envelope.project)); // throws on invalid
    const refs = [...new Set(Object.values(restored.state.assets).map((a) => a.bufferReference))];
    const usesFull = Object.values(restored.state.assets).some((a) => a.source?.section === 'full');
    const limits = usesFull ? DECODE_LIMITS.full : DECODE_LIMITS.section;
    await this.#retireEngine();
    // Release the previous project's decoded audio before decoding this one.
    for (const key of Object.keys(this.buffers)) delete this.buffers[key];
    this.decodedBytes = 0;
    for (const ref of refs) await this.#decode(ref, limits);
    this.edit = restored;
    this.projectId = envelope.id;
    this.projectName = envelope.name;
    this.savedRevision = this.edit.revision;
    this.cueBeat = restored.state.transport.playheadBeat;
    this.cueFrame = beatsToFrames(this.cueBeat, this.bpm);
    this.say('notice', 'OPENED', `Opened “${envelope.name}” (${restored.state.clips.length} clips). Undo history starts fresh after opening.`);
    this.#emit('opened');
    return envelope;
  }

  /** Start a new, empty arrangement (the current one is left as saved). */
  async newProject() {
    await this.#retireEngine();
    this.edit = new EditEngine();
    this.projectId = null;
    this.projectName = 'Untitled arrangement';
    this.savedRevision = null;
    this.cueFrame = 0;
    this.cueBeat = 0;
    this.#emit('opened');
  }

  // ---------------------------------------------------------------- export

  /**
   * Export: SAVE first, then render that saved state through the accepted
   * offline bounce (shared plan, Signalsmith, limiter) and encode 24-bit WAV.
   * Nothing is uploaded or written over any source; the caller offers the
   * file to the musician as a download.
   */
  async exportMix() {
    if (!this.edit.state.clips.length) throw new Error('there is nothing on the lanes to export');
    if (this.edit.state.clips.length > EXPORT_CLIP_LIMIT) {
      throw new Error(`the offline bounce renders at most ${EXPORT_CLIP_LIMIT} clips at once; this arrangement has ${this.edit.state.clips.length}`);
    }
    const saved = await this.save();
    const state = this.edit.snapshot();
    const tailFrames = Math.round(EXPORT_TAIL_SEC * SAMPLE_RATE);
    const plan = compileRenderPlan(state, { tailFrames });
    const { audioBuffer, limiterStats } = await this.deps.renderOffline(plan, this.buffers, {
      ...this.deps.modules,
      StretchFactory: this.deps.StretchFactory,
    });
    const channels = [audioBuffer.getChannelData(0), audioBuffer.getChannelData(1)];
    let peak = 0;
    let nonFinite = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i += 1) {
        const v = ch[i];
        if (!Number.isFinite(v)) nonFinite += 1;
        else if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
    const wav = encodeWav24(channels, SAMPLE_RATE);
    const report = {
      arrangementId: saved.id,
      name: saved.name,
      revision: saved.revision,
      sampleRate: SAMPLE_RATE,
      channels: channels.length,
      frames: channels[0].length,
      durationSec: channels[0].length / SAMPLE_RATE,
      arrangementEndSec: plan.output.arrangementEndFrame / SAMPLE_RATE,
      tailSec: EXPORT_TAIL_SEC,
      peakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      ceilingDbfs: LIMITER_CEILING_DB,
      nonFiniteSamples: nonFinite + limiterStats.reduce((n, s) => n + (s.nonFiniteCount || 0), 0),
      clips: plan.clips.length,
      bytes: wav.byteLength,
    };
    this.lastExport = report;
    this.say('notice', 'EXPORTED', `Exported “${saved.name}”: ${report.durationSec.toFixed(2)} s, ${report.channels} channels, ${SAMPLE_RATE} Hz, 24-bit, peak ${report.peakDbfs.toFixed(2)} dBFS.`);
    this.#emit('exported');
    return { wav, report, fileName: `${slug(saved.name)}.wav` };
  }

  async dispose() {
    this._disposed = true;
    await this.closeAudio().catch(() => {});
  }
}
