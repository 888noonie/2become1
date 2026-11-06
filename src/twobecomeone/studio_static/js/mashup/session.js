// mashup/session.js — wires the queue governor to import jobs and the live mixer.
// The governor decides. This module performs the allowed side effects.

import { applyDirective } from './directive-executor.js';
import {
  createQueueState,
  decide,
  enqueueTrack as enqueueTrackItem,
  enqueueUrl,
  fillEmptyDeck,
  noteAsset,
  noteJob,
  removeItem,
  setArmed,
} from './queue-governor.js';

const BASS_CUE = 'I have dropped the bass to come in on the next suitable cue';
import { getTrack, interpretCommand, submitYouTube, watchJob } from '../api.js';

function assetFromJob(job) {
  const status = typeof job?.status === 'string' ? job.status : '';
  const trackId = job?.result && typeof job.result.track_id === 'string' ? job.result.track_id : '';
  if (status === 'complete' && trackId.trim()) {
    return { ok: true, status: 'complete', trackId, jobId: job.id, error: null };
  }
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
    const message = typeof job?.error === 'string' && job.error.trim() ? job.error : status;
    return {
      ok: false,
      status: 'failed',
      jobId: job?.id || null,
      error: { code: 'JOB_FAILED', message },
    };
  }
  return { ok: true, status: status || 'running', jobId: job?.id || null, trackId: null, error: null };
}

function throwIfFailed(result) {
  if (result && result.ok === false) {
    const code = result.code || 'PORT_FAILED';
    const message = result.message || 'The mixer rejected this control.';
    throw new Error(`${code}: ${message}`);
  }
}

export function createMashupController(deps) {
  const store = deps.store;
  const liveMixer = deps.liveMixer;
  const projectManager = deps.projectManager;
  const submit = deps.submitYouTube || submitYouTube;
  const watch = deps.watchJob || watchJob;
  const fetchTrack = deps.getTrack || getTrack;
  const interpret = deps.interpret || interpretCommand;
  const stops = new Set();
  let rampTimer = null;
  let stopped = false;

  function queue() {
    return store.getState().urlQueue || createQueueState();
  }

  function commit(next) {
    store.dispatch({ type: 'mashup/queue', urlQueue: next });
  }

  function playheads() {
    const snap = liveMixer.snapshot();
    const deck = (name) => {
      const row = snap?.decks?.[name] || {};
      return {
        playing: row.playing === true,
        ended: row.ended === true,
        time: Number(row.time) || 0,
        duration: Number(row.duration) || 0,
      };
    };
    return { A: deck('A'), B: deck('B') };
  }

  function occupancy() {
    const project = store.getState().currentProject || {};
    return {
      A: Boolean(project.anchor_track_id),
      B: Boolean(project.lead_track_id),
    };
  }

  function trackFor(deck) {
    const project = store.getState().currentProject || {};
    const id = deck === 'A' ? project.anchor_track_id : project.lead_track_id;
    if (!id) return null;
    return store.getState().deckTracks?.[id] || { id };
  }

  function isBassDrop(directive) {
    const ops = Array.isArray(directive?.ops) ? directive.ops : [];
    return ops.some((op) => (
      op
      && op.op === 'eq'
      && op.deck === 'A'
      && op.band === 'low'
      && Number(op.db) === -12
    ));
  }

  function report(directive, outcome) {
    const declined = outcome?.declined?.[0];
    const lastError = outcome?.error
      || (declined ? { code: declined.code || 'DECLINED', message: declined.message || 'Declined.' } : null);
    // This sentence is the visible confirmation for that one applied EQ cut.
    const agentReply = !lastError && isBassDrop(directive) ? BASS_CUE : '';
    store.dispatch({
      type: 'mashup/daw',
      lastDirective: directive || null,
      lastError,
      agentReply,
    });
  }

  function ports() {
    return {
      setEq(deck, band, db) {
        const result = liveMixer.setDeckEq(deck, band, db);
        throwIfFailed(result);
        const applied = Number(result?.value?.db);
        store.dispatch({
          type: 'mashup/daw',
          eq: {
            deck,
            band,
            db: Number.isFinite(applied) ? applied : Number(db),
          },
        });
      },
      setGain(deck, value) {
        throwIfFailed(liveMixer.setDeckTrim(deck, value));
      },
      setCrossfader(position) {
        throwIfFailed(liveMixer.setCrossfader(position));
      },
      setFilter(deck, mode, amount) {
        throwIfFailed(liveMixer.setDeckFilter(deck, mode, amount));
      },
      setLoop(deck, spec) {
        if (!spec || spec.enabled === false) {
          throwIfFailed(liveMixer.setDeckLoop(deck, { enabled: false }));
          return;
        }
        const track = trackFor(deck);
        throwIfFailed(liveMixer.setDeckLoop(deck, {
          enabled: true,
          bars: spec.bars,
          bpm: Number(track?.bpm),
          firstBeat: Number(track?.beat_grid?.first_beat) || 0,
        }));
      },
      play(deck) {
        const track = trackFor(deck);
        if (!track?.id) throw new Error('NO_TRACK: Load a track on that deck first.');
        const url = track.audio_url || `/api/tracks/${encodeURIComponent(track.id)}/audio`;
        const pending = liveMixer.play(deck, {
          trackId: track.id,
          url,
          kind: 'track',
          variant: 'full',
          title: track.name || null,
        });
        if (pending && typeof pending.then === 'function') {
          pending.catch((err) => {
            report(null, { error: { code: 'PLAY_FAILED', message: err?.message || 'Play failed.' } });
          });
        }
      },
      pause(deck) {
        throwIfFailed(liveMixer.pause(deck));
      },
    };
  }

  function rampTo(position) {
    if (rampTimer != null) clearInterval(rampTimer);
    const start = Number(liveMixer.getMixerState()?.crossfaderPosition);
    const from = Number.isFinite(start) ? start : 50;
    let step = 0;
    rampTimer = setInterval(() => {
      step += 1;
      liveMixer.setCrossfader(from + (position - from) * (step / 8));
      if (step >= 8) {
        clearInterval(rampTimer);
        rampTimer = null;
      }
    }, 250);
  }

  async function runEvents(events) {
    for (const event of events) {
      if (stopped) return;
      if (event.type === 'import_next') await runImport(event);
      else if (event.type === 'assign_deck') await runAssign(event);
      else if (event.type === 'transition') rampTo(event.toDeck === 'B' ? 100 : 0);
      // Import failures stay on the queue item. A blocked queue event must
      // not replace the mix-command result on the command bar.
    }
  }

  async function runImport(event) {
    try {
      const job = await submit(event.url);
      if (stopped) return;
      store.dispatch({ type: 'jobs/upsert', job });
      commit(noteJob(queue(), event.itemId, job));
      const stop = watch(job.id, (updated) => {
        if (stopped) return;
        store.dispatch({ type: 'jobs/upsert', job: updated });
        if (updated.status === 'queued' || updated.status === 'running') {
          commit(noteJob(queue(), event.itemId, updated));
          return;
        }
        const noted = noteAsset(queue(), event.itemId, assetFromJob(updated), playheads());
        commit(noted.state);
        void runEvents(noted.events).then(() => { if (!stopped) pump(); });
      });
      if (typeof stop === 'function') stops.add(stop);
    } catch (err) {
      const noted = noteAsset(queue(), event.itemId, {
        ok: false,
        status: 'failed',
        error: { code: 'JOB_FAILED', message: err?.message || 'Import failed.' },
      }, playheads());
      commit(noted.state);
      await runEvents(noted.events);
      pump();
    }
  }

  async function runAssign(event) {
    const slot = event.deck === 'A' ? 'anchor' : 'lead';
    projectManager.assign(slot, event.trackId);
    let track = null;
    try {
      track = await fetchTrack(event.trackId);
    } catch {
      track = null;
    }
    if (stopped) return;
    if (track?.id) store.dispatch({ type: 'deckTrack/set', trackId: track.id, track });
    const url = track?.audio_url || `/api/tracks/${encodeURIComponent(event.trackId)}/audio`;
    const result = await liveMixer.play(event.deck, {
      trackId: event.trackId,
      url,
      kind: 'track',
      variant: 'full',
      title: track?.name || null,
    });
    if (result && result.ok === false) {
      store.dispatch({
        type: 'mashup/daw',
        lastError: { code: result.code || 'PLAY_FAILED', message: result.message || 'Could not play the imported track.' },
      });
    }
  }

  function pump() {
    if (stopped) return;
    const current = queue();
    let next = decide(current, playheads());
    if (next.events.length === 0) next = fillEmptyDeck(next.state, occupancy());
    if (next.events.length === 0) return;
    commit(next.state);
    void runEvents(next.events);
  }

  function armIfIdle(state) {
    const active = state.items.some((item) => (
      item.status === 'pending'
      || item.status === 'importing'
      || item.status === 'ready'
      || item.status === 'loaded'
    ));
    return active ? state : setArmed(state, true);
  }

  function enqueue(urls) {
    let state = armIfIdle(queue());
    for (const url of urls || []) {
      state = enqueueUrl(state, url).state;
    }
    commit(state);
    pump();
  }

  function enqueueTrack(track) {
    const state = enqueueTrackItem(armIfIdle(queue()), track).state;
    commit(state);
    pump();
  }

  function setArm(armed) {
    commit(setArmed(queue(), armed === true));
    if (armed === true) pump();
  }

  function remove(itemId) {
    commit(removeItem(queue(), itemId));
  }

  async function command(text) {
    try {
      const directive = await interpret(text);
      report(directive, applyDirective(directive, ports()));
    } catch (err) {
      report(null, { error: { code: 'COMMAND_FAILED', message: err?.message || 'Command failed.' } });
    }
  }

  function directive(body) {
    const outcome = applyDirective(body, ports());
    if (outcome.error || outcome.declined.length) report(body, outcome);
  }

  function stop() {
    stopped = true;
    if (rampTimer != null) clearInterval(rampTimer);
    for (const stopWatch of stops) stopWatch();
    stops.clear();
  }

  return { enqueue, enqueueTrack, setArmed: setArm, remove, command, directive, pump, stop };
}

export function startMashupSession(deps) {
  const controller = createMashupController(deps);
  const off = deps.liveMixer.on((event) => {
    if (event?.type === 'timeupdate' || event?.type === 'ended') controller.pump();
  });
  return {
    ...controller,
    stop() {
      if (typeof off === 'function') off();
      controller.stop();
    },
  };
}
