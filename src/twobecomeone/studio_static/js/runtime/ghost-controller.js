// js/runtime/ghost-controller.js — app-scoped Ghost preview controller.
//
// Phase 10B. Owns ALL Ghost runtime machinery (AudioContext, GhostScheduler,
// launch-boundary observer timers, generation tokens, pending-outcome
// barriers). The StateStore only ever receives serializable semantic facts
// via the narrow `ghostStatus` slice (Sol amendment 9 — the slice is
// `ghostStatus`, never `ghostRuntime`).
//
// Amendment responsibilities baked in here:
//   A1  Release outcome barrier: aborting the browser fetch is NOT
//       cancellation. Release marks the generation released, keeps the
//       authoring POST promise alive, reconciles the original intent with the
//       SAME envelope (same action ID + idempotency key + payload), and
//       durably appends exactly one human reject_proposal once the outcome is
//       known. A network failure of the POST is an unknown outcome: the
//       envelope is replayed once to resolve it before rejecting; a failure
//       of the REPLAY is an unreconciled release (retryable), never silence.
//   A2  Truthful auditioning: `auditioning` is recorded only by a
//       controller-owned, cancellable launch-boundary observer after
//       ctx.currentTime >= receipt.launchAudioTime, with generation,
//       proposal, destination ownership, and a running context verified.
//       A late observer records auditioning late, never early. The
//       scheduler's STARTED state only means start() was CALLED.
//   A3  Server grid identity: the transport carries
//       transformSpec.destinationGridRevision and live Lead facts are
//       compared against transformSpec.destinationGrid before scheduling.
//   A7  Ownership proof: every transport read and boundary check requires
//       audioController.current.trackId === current project lead_track_id and
//       audioController.playing. Store playback ticks are display state only.
//       Pause/stop/natural-ended/re-seek/source-replacement cancel the Ghost
//       runtime (no machine reject — the human still Releases).
//   A8  Project switch and hydration are hard cancellation boundaries.
//       Hydrated active proposals cannot resume (no autoplay): shown as
//       interrupted with human Release/Retry; >1 non-terminal proposal is a
//       deterministic recovery state, never a silent pick.
//   A10 Retry is serialized: the replacement preview is authored only after
//       the prior human reject is durably confirmed. Rejection failure keeps
//       a retryable state; nothing new is authored.
//   A12 resolveNextPhrase()/source.start() run exactly once per proposal
//       generation, after decode — never in a tick/render/poll loop.
//
// No DOM imports. Nothing is exposed on window. The AudioContext is only
// created/resumed inside the Preview/Retry click gesture.

import { GhostScheduler } from './ghost-scheduler.js';
import { buildDeckTransport, checkGridParity } from './transport-bridge.js';
import { CommittedLayerEngine } from './committed-layer-engine.js';

const LAUNCH_OBSERVER_INTERVAL_MS = 150;

export const GHOST_PHASES = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing',
  ARMED: 'armed',
  AUDITIONING: 'auditioning',
  ENDED: 'ended',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  RELEASING: 'releasing',
  INTERRUPTED: 'interrupted',
  CONFLICT: 'conflict',
  COMMITTING: 'committing',
  COMMITTED: 'committed',
});

const ACTIVE_LIFECYCLES = Object.freeze(['ready', 'scheduled', 'auditioning']);

// Phase 12: live committed-layer engine wake cadence is injected by the
// controller so Node tests and the browser share one deterministic policy.
export const LIVE_TIMER_POLICY = Object.freeze({
  pollMs: 150,
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function scrubError(err) {
  if (err && typeof err === 'object') {
    return {
      code: typeof err.code === 'string' ? err.code : null,
      status: typeof err.status === 'number' ? err.status : null,
      message: typeof err.message === 'string' ? err.message.slice(0, 200) : 'Ghost preview failed',
    };
  }
  return { code: null, status: null, message: 'Ghost preview failed' };
}

/**
 * @param {object} deps
 * @param {import('../state.js').StateStore} deps.store
 * @param {object} deps.api — { postProjectAction, postProposalLifecycle, buildPreviewAction, buildRejectAction, buildLifecycleBody }
 * @param {object} [deps.audioController] — singleton player; defaults to a stub
 * @param {() => string|null} [deps.leadTrackId]
 * @param {() => object|null} [deps.leadTrack]
 * @param {(message: string) => void} [deps.onAnnounce]
 * @param {{ create: () => AudioContext }} deps.audioContextFactory
 * @param {(deps: object) => GhostScheduler} [deps.schedulerFactory]
 */
export class GhostController {
  constructor(deps) {
    if (!deps || !deps.store || !deps.api || !deps.audioContextFactory) {
      throw new Error('GhostController requires store, api, and audioContextFactory');
    }
    this.store = deps.store;
    this.api = deps.api;
    this.audioController = deps.audioController || { current: null, playing: false, time: 0 };
    this.getLeadTrackId = deps.leadTrackId
      || (() => this.store.getState().currentProject?.lead_track_id ?? null);
    this.getLeadTrack = deps.leadTrack || (() => {
      const state = this.store.getState();
      const id = state.currentProject?.lead_track_id;
      return id ? (state.deckTracks[id] ?? null) : null;
    });
    this.onAnnounce = deps.onAnnounce || (() => {});
    this._ctxFactory = deps.audioContextFactory;
    this._schedulerFactory = deps.schedulerFactory || ((d) => new GhostScheduler(d));
    this._liveEngineFactory = deps.liveEngineFactory || null; // Phase 12

    // Runtime machinery (NEVER StateStore):
    this._ctx = null;
    this._scheduler = null;
    this._liveEngine = null;
    this._liveEngineTornDown = false;
    this._liveLayerStates = new Map(); // serializable per-layer live records
    this._gen = null;          // active generation: { id, projectId, proposalId, asset, receipt, released, pendingPromise, pendingAction }
    this._launchObserver = null;
    this._schedulingInFlight = false;
    this._revertActions = new Map();
    this._revertPromises = new Map();
    this._disposed = false;
  }

  // ------------------------------------------------------------------
  // Store helpers (semantic facts only — A9)
  // ------------------------------------------------------------------

  _status() {
    return this.store.getState().ghostStatus || { phase: 'idle' };
  }

  _setStatus(patch) {
    this.store.dispatch({ type: 'v1/ghost-status/set', patch });
  }

  _announce(message) {
    try { this.onAnnounce(message); } catch { /* announcer failures never break the Ghost */ }
  }

  /** A7 ownership proof: the singleton player currently owns LEAD and plays. */
  _destinationOwnedAndPlaying() {
    const leadId = this.getLeadTrackId();
    const current = this.audioController.current;
    if (!leadId || !current || current.trackId !== leadId) return false;
    return this.audioController.playing === true;
  }

  _transportProvider() {
    const leadTrack = this.getLeadTrack();
    const result = buildDeckTransport({
      deck: 'B',
      track: leadTrack,
      elementSeconds: this.audioController.time,
      playing: this._destinationOwnedAndPlaying(),
      audioClockNow: this._ctx ? this._ctx.currentTime : 0,
      serverGridRevision: this._gen?.asset?.transformSpec?.destinationGridRevision || null,
      expectTrackId: this.getLeadTrackId(),
    });
    if (!result.ok) {
      throw Object.assign(new Error(`transport unavailable: ${result.code}`), { code: result.code });
    }
    return result.value;
  }

  // ------------------------------------------------------------------
  // Invoke (Preview gesture)
  // ------------------------------------------------------------------

  async invoke(region, gainDb) {
    if (this._disposed) return { ok: false, code: 'DISPOSED' };

    // One-active rule: any pending intent or non-terminal proposal blocks (A8).
    const blockers = this._blockingProposals();
    if (blockers.length > 0) {
      const conflict = blockers.length > 1 || this._serverConflictActive()
        ? { code: 'GHOST_STATE_CONFLICT', message: `${blockers.length} unresolved Ghost previews need Release.` }
        : { code: 'GHOST_ACTIVE', message: 'A Ghost preview is already active. Release or Retry it first.' };
      this._setStatus({
        phase: GHOST_PHASES.BLOCKED,
        error: conflict,
        activeProposalId: this._gen?.proposalId || blockers[0] || null,
      });
      return { ok: false, code: conflict.code };
    }

    const projectId = this.store.getState().currentProject?.id;
    if (!projectId) return { ok: false, code: 'NO_PROJECT' };

    // AudioContext is created and resumed synchronously inside the gesture.
    this._ensureContext();

    const generation = {
      id: Math.random().toString(36).slice(2) + String(Date.now()),
      projectId,
      proposalId: null,
      asset: null,
      receipt: null,
      released: false,
      pendingPromise: null,
      pendingAction: null,
    };
    this._gen = generation;
    this._receipt = null;

    const action = this.api.buildPreviewAction({ region, gainDb });
    this._setStatus({
      phase: GHOST_PHASES.PREPARING,
      activeProposalId: null,
      summary: {
        sourceLabel: 'Foundation vocals',
        destinationLabel: 'Lead',
        startBeat: region.startBeat,
        endBeat: region.endBeat,
        gainDb,
      },
      error: null,
    });
    this._announce('Preparing Ghost preview…');

    // A1: the authoring POST promise is kept alive behind the generation even
    // if Release/switch happens while ffmpeg runs. Aborting the browser fetch
    // cannot prove server rollback; the outcome is always reconciled.
    generation.pendingAction = action;
    const pendingPromise = this.api.postProjectAction(projectId, action);
    generation.pendingPromise = pendingPromise;

    let outcome;
    try {
      outcome = await pendingPromise;
    } catch (err) {
      if (generation !== this._gen || generation.released) {
        // release()/switch owns reconciliation from here.
        return { ok: false, code: 'RELEASED' };
      }
      const failure = scrubError(err);
      const unknownOutcome = failure.status === null || failure.status >= 500;
      if (!unknownOutcome) this._gen = null;
      this._setStatus({
        phase: GHOST_PHASES.FAILED,
        error: unknownOutcome
          ? {
              code: 'GHOST_PREVIEW_OUTCOME_UNKNOWN',
              message: 'The preview outcome is unknown. Use Release to reconcile it safely.',
            }
          : { code: failure.code, message: failure.message },
      });
      this._announce(failure.message || 'Ghost preview failed.');
      return {
        ok: false,
        code: unknownOutcome ? 'GHOST_PREVIEW_OUTCOME_UNKNOWN' : (failure.code || 'PREVIEW_FAILED'),
      };
    }

    // Idempotent replay after a Release-before-outcome (A1): the proposal now
    // exists server-side; reject it durably, never schedule it.
    if (generation !== this._gen || generation.released) {
      const proposal = outcome?.outcome?.proposal;
      if (proposal) {
        await this._rejectDurably(generation, proposal.id, 'released before scheduling');
      }
      return { ok: false, code: 'RELEASED' };
    }
    generation.pendingPromise = null;
    generation.pendingAction = null;

    const proposal = outcome?.outcome?.proposal;
    const asset = outcome?.outcome?.asset;
    if (!proposal || !asset) {
      const failure = { code: 'PREVIEW_MALFORMED', message: 'Ghost preview response was incomplete.' };
      this._gen = null;
      this._setStatus({ phase: GHOST_PHASES.FAILED, error: failure });
      return { ok: false, code: failure.code };
    }

    generation.proposalId = proposal.id;
    generation.asset = asset;
    this.store.dispatch({ type: 'v1/proposal/record', proposal });
    this._setStatus({
      activeProposalId: proposal.id,
      summary: {
        sourceLabel: 'Foundation vocals',
        destinationLabel: 'Lead',
        startBeat: proposal.payload?.source?.region?.startBeat ?? region.startBeat,
        endBeat: proposal.payload?.source?.region?.endBeat ?? region.endBeat,
        gainDb: proposal.payload?.gainDb ?? gainDb,
      },
      error: null,
    });

    // A3: verify the LIVE Lead grid still matches the server facts BEFORE
    // scheduling. A mismatch requires a fresh preview after human Release.
    const parity = checkGridParity(
      this.getLeadTrack(),
      asset.transformSpec?.destinationGrid || null,
      asset.transformSpec?.targetBpm,
    );
    if (parity) {
      this._gen = null;
      const failure = {
        code: 'GHOST_GRID_STALE',
        message: 'Lead analysis changed since the preview. Release it and preview again.',
      };
      this._setStatus({ phase: GHOST_PHASES.FAILED, error: failure });
      this._announce(failure.message);
      return { ok: false, code: failure.code };
    }

    // A2 truthfulness: persist `scheduled` only after the server accepts.
    try {
      await this.api.postProposalLifecycle(
        projectId, proposal.id, this.api.buildLifecycleBody('scheduled'),
      );
    } catch (err) {
      if (generation !== this._gen || generation.released) return { ok: false, code: 'RELEASED' };
      const failure = scrubError(err);
      this._gen = null;
      this._setStatus({ phase: GHOST_PHASES.FAILED, error: { code: failure.code, message: failure.message } });
      return { ok: false, code: failure.code || 'SCHEDULE_FAILED' };
    }
    if (generation !== this._gen || generation.released) return { ok: false, code: 'RELEASED' };
    this.store.dispatch({ type: 'v1/proposal/transition', proposalId: proposal.id, toState: 'scheduled' });
    this._setStatus({ phase: GHOST_PHASES.ARMED, error: null });

    // A12: schedule EXACTLY once for this generation, after decode.
    this._schedulingInFlight = true;
    let result;
    try {
      result = await this._ensureScheduler().schedule(
        { ...proposal, lifecycle: 'scheduled' }, asset,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ghost] schedule threw', err?.code, err?.message);
      result = { ok: false, code: err?.code || 'SCHEDULE_FAILED' };
    } finally {
      this._schedulingInFlight = false;
    }
    if (generation !== this._gen || generation.released) {
      return { ok: false, code: 'RELEASED' };
    }
    if (!result.ok) {
      this._gen = null;
      // eslint-disable-next-line no-console
      console.error('[ghost] schedule failed', result.code);
      const notPlaying = result.code === 'T_TRANSPORT_NOT_PLAYING';
      const failure = {
        code: notPlaying ? 'LEAD_NOT_PLAYING' : (result.code || 'SCHEDULE_FAILED'),
        message: notPlaying
          ? 'Start Lead playback first, then preview again.'
          : 'The Ghost preview could not be scheduled.',
      };
      this._setStatus({ phase: GHOST_PHASES.FAILED, error: failure });
      this._announce(failure.message);
      return { ok: false, code: failure.code };
    }

    // Armed: source.start(futureAudioTime) was CALLED — not yet audible (A2).
    generation.receipt = result.receipt;
    this._receipt = result.receipt;
    this._setStatus({
      phase: GHOST_PHASES.ARMED,
      receipt: this._serializableReceipt(result.receipt),
      error: null,
    });
    this._announce(`Ghost armed: launches at phrase ${result.receipt.phraseIndex + 1}.`);
    this._startLaunchObserver(generation);
    return { ok: true, receipt: result.receipt };
  }

  _serializableReceipt(receipt) {
    return {
      proposalId: receipt.proposalId,
      assetId: receipt.assetId,
      assetContentHash: receipt.assetContentHash,
      gridRevision: receipt.gridRevision,
      resolvedBeat: receipt.resolvedBeat ?? receipt.launchBeat,
      launchBeat: receipt.resolvedBeat ?? receipt.launchBeat,
      phraseIndex: receipt.phraseIndex,
    };
  }

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = this._ctxFactory.create();
    }
    if (this._ctx.state === 'suspended') {
      const resume = this._ctx.resume();
      if (resume && typeof resume.catch === 'function') {
        resume.catch(() => { /* the boundary observer reports honestly */ });
      }
    }
    return this._ctx;
  }

  _ensureScheduler() {
    if (!this._scheduler) {
      this._scheduler = this._schedulerFactory({
        audioContext: this._ctx,
        loadAsset: async (asset, signal) => {
          const response = await fetch(asset.audioUrl, { signal });
          if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
          return response.arrayBuffer();
        },
        transportProvider: () => this._transportProvider(),
        onStateChange: (proposalId, state) => {
          if (this._disposed) return;
          const gen = this._gen;
          if (!gen || proposalId !== gen.proposalId) return;
          if (state === 'ended') {
            this._stopLaunchObserver();
            this._setStatus({ phase: GHOST_PHASES.ENDED, error: null });
            this._announce('Ghost preview finished. Release or Retry it.');
          } else if (state === 'failed' || state === 'cancelled') {
            this._stopLaunchObserver();
          }
        },
      });
    }
    return this._scheduler;
  }

  // ------------------------------------------------------------------
  // A2: launch-boundary observer — auditioning is recorded LATE, never early
  // ------------------------------------------------------------------

  _startLaunchObserver(generation) {
    this._stopLaunchObserver();
    this._launchObserver = setInterval(() => {
      if (generation !== this._gen || generation.released || this._disposed) {
        this._stopLaunchObserver();
        return;
      }
      if (!this._ctx || this._ctx.state !== 'running') return;
      if (!(this._ctx.currentTime >= generation.receipt.launchAudioTime)) return;
      // A7: re-prove ownership AT the boundary.
      if (!this._destinationOwnedAndPlaying()) {
        this._stopLaunchObserver();
        this._cancelRuntimeKeepProposal('LEAD_STOPPED');
        this._setStatus({
          phase: GHOST_PHASES.INTERRUPTED,
          error: { code: 'LEAD_STOPPED', message: 'Lead stopped before the Ghost launch. Release or Retry.' },
        });
        this._announce('Lead stopped before the Ghost launch.');
        return;
      }
      this._stopLaunchObserver();
      this._recordAuditioning(generation);
    }, LAUNCH_OBSERVER_INTERVAL_MS);
  }

  async _recordAuditioning(generation) {
    try {
      await this.api.postProposalLifecycle(
        generation.projectId,
        generation.proposalId,
        this.api.buildLifecycleBody('auditioning', {
          assetId: generation.asset?.id,
          contentHash: generation.asset?.contentHash,
          launchBeat: generation.receipt.resolvedBeat ?? generation.receipt.launchBeat,
          launchAudioTime: generation.receipt.launchAudioTime,
          gridRevision: generation.receipt.gridRevision,
        }),
      );
      if (generation !== this._gen || generation.released) return;
      this.store.dispatch({
        type: 'v1/proposal/transition',
        proposalId: generation.proposalId,
        toState: 'auditioning',
      });
      this._setStatus({ phase: GHOST_PHASES.AUDITIONING, error: null });
      this._announce('Ghost auditioning over Lead.');
    } catch {
      if (generation !== this._gen || generation.released) return;
      // The audition is still running audibly; only the FACT failed to
      // record. Stay armed with an honest, retryable error.
      this._setStatus({
        error: {
          code: 'AUDITION_FACT_FAILED',
          message: 'Could not record the audition state. The preview is still running.',
        },
      });
      // Retryable: the next Release/Retry reconcile or a fresh preview fixes it
    }
  }

  _stopLaunchObserver() {
    if (this._launchObserver !== null) {
      clearInterval(this._launchObserver);
      this._launchObserver = null;
    }
  }

  _storeTransitionIfCurrent(gen, toState) {
    if (this._disposed || !gen.proposalId) return;
    if (gen !== this._gen) return;
    this.store.dispatch({ type: 'v1/proposal/transition', proposalId: gen.proposalId, toState });
  }

  // ------------------------------------------------------------------
  // Phase 12A.6: live committed-layer engine wiring
  // ------------------------------------------------------------------

  /**
   * Build (once) the live committed-layer engine with injected timers.
   * The engine is created lazily: no AudioContext work happens until an
   * authoritative projection actually holds a committed layer.
   */
  _ensureLiveEngine() {
    if (this._disposed || this._liveEngineTornDown) return null;
    if (this._liveEngine) return this._liveEngine;
    const factory = this._liveEngineFactory;
    if (!factory) return null;
    this._liveEngine = factory({
      audioContext: this._ensureContext(),
      loadAsset: async (asset) => {
        const audioUrl = asset?.audioUrl
          || (asset?.id ? `/api/ghost-assets/${asset.id}/audio` : null);
        if (!audioUrl) throw new Error('committed asset has no audio URL');
        const response = await fetch(audioUrl);
        if (!response.ok) throw new Error(`committed asset fetch failed: ${response.status}`);
        return response.arrayBuffer();
      },
      transportProvider: (layer) => this._liveTransportProvider(layer),
      setTimer: (delayMs, fn) => setTimeout(fn, delayMs),
      clearTimer: (id) => clearTimeout(id),
      onStateChange: (layerId, state, detail) => this._onLiveStateChange(layerId, state, detail),
    });
    return this._liveEngine;
  }

  /**
   * A7 ownership proof + A3 grid identity for the live layer. The transport
   * follows the destination Lead exactly like the preview path, carrying the
   * layer's server-authored destinationGridRevision.
   */
  _liveTransportProvider(layer) {
    const leadTrack = this.getLeadTrack();
    const gridRevision = layer?.launchReceipt?.destinationGridRevision
      || layer?.transformSpec?.destinationGridRevision || null;
    const result = buildDeckTransport({
      deck: 'B',
      track: leadTrack,
      elementSeconds: this.audioController.time,
      playing: this._destinationOwnedAndPlaying(),
      audioClockNow: this._ctx ? this._ctx.currentTime : 0,
      serverGridRevision: gridRevision,
      expectTrackId: this.getLeadTrackId(),
    });
    if (!result.ok) {
      throw Object.assign(new Error(`transport unavailable: ${result.code}`), { code: result.code });
    }
    return result.value;
  }

  /** Engine -> serializable ghostLiveStatus slice (Amendment 9 discipline). */
  _onLiveStateChange(layerId, state, detail) {
    if (this._disposed) return;
    const record = this._liveLayerStates.get(layerId);
    if (record) {
      record.state = state;
      record.error = detail?.code
        ? { code: detail.code, message: detail.message || null }
        : null;
    }
    this._publishLiveSlice();
  }

  /** Publish the controller-owned per-layer live states to the store. */
  _publishLiveSlice() {
    const layers = [...this._liveLayerStates.values()].map((record) => ({
      layerId: record.layerId,
      actionId: record.actionId,
      state: record.state,
      launchBeat: record.launchBeat,
      error: record.error,
    }));
    this.store.dispatch({ type: 'v1/ghost-live-status/set', patch: { layers } });
  }

  /**
   * Authoritative sync of the live engine from a refreshed projection
   * (Amendment 2). Called after commit success, hydration, reconciliation,
   * and an owned Lead play. Never invents a layer from client state.
   */
  async _syncLiveEngine() {
    if (this._disposed || this._liveEngineTornDown) return { ok: false, code: 'DISPOSED' };
    const session = this.store.getState().session || {};
    const committed = Array.isArray(session.committedLayers) ? session.committedLayers : [];
    // Seed/trim the controller-owned per-layer records from authority, then
    // converge the engine. Engine state events refine the seeded records.
    const nextIds = new Set();
    for (const layer of committed) {
      const layerId = layer?.layerId || layer?.actionId;
      if (!layerId) continue;
      nextIds.add(layerId);
      if (!this._liveLayerStates.has(layerId)) {
        this._liveLayerStates.set(layerId, {
          layerId,
          actionId: layer.actionId,
          state: 'idle', // honest seed: committed, not yet known to play
          launchBeat: layer?.launchReceipt?.launchBeat ?? null,
          error: null,
        });
      }
    }
    for (const layerId of [...this._liveLayerStates.keys()]) {
      if (!nextIds.has(layerId)) this._liveLayerStates.delete(layerId);
    }
    if (committed.length === 0) {
      // Nothing to play: clear any suspended engine state honestly.
      if (this._liveEngine) await this._liveEngine.sync([]);
      this._publishLiveSlice();
      return { ok: true, code: 'empty' };
    }
    const engine = this._ensureLiveEngine();
    if (!engine) {
      this._publishLiveSlice();
      return { ok: false, code: 'NO_ENGINE' };
    }
    const result = await engine.sync(committed);
    this._publishLiveSlice();
    return result;
  }

  // ------------------------------------------------------------------
  // A7: destination ownership loss (pause/stop/ended/re-seek/replacement)
  // ------------------------------------------------------------------

  handleAudioEvent(type) {
    if (this._disposed) return;
    // Phase 12: transport changes suspend the live committed-layer engine
    // (Amendment 4); a later owned Lead play re-syncs it from authority.
    if (this._liveEngine && !this._liveEngineTornDown) {
      if (type === 'pause' || type === 'stop' || type === 'ended' || type === 'seek') {
        this._liveEngine.suspend(`lead-${type}`);
      } else if (type === 'play') {
        // Re-prove ownership lazily inside the provider; sync is authoritative.
        this._syncLiveEngine().catch(() => { /* the slice shows the honest state */ });
      }
    }
    if (!this._gen || this._gen.released) return;
    const gen = this._gen;
    if (!gen.proposalId) return; // still preparing: the POST barrier handles stale outcomes
    const phase = this._status().phase;
    const armed = phase === 'armed' || phase === 'auditioning';
    if (!armed) return;
    let canceled = false;
    if (type === 'pause' || type === 'stop' || type === 'ended' || type === 'seek') {
      canceled = true;
    } else if (type === 'play') {
      // Any element restart is a new anchor (re-seek/replacement/same replay).
      canceled = true;
    }
    if (!canceled) return;
    // Cancel runtime; do NOT machine-reject (constitutional: only a human).
    this._cancelRuntimeKeepProposal();
    this._setStatus({
      phase: GHOST_PHASES.INTERRUPTED,
      error: {
        code: 'LEAD_STOPPED',
        message: 'Lead playback changed. Release or Retry the Ghost.',
      },
    });
    this._announce('Lead playback changed. The Ghost awaits Release or Retry.');
  }

  _cancelRuntimeKeepProposal() {
    this._stopLaunchObserver();
    const gen = this._gen;
    if (gen) gen.released = true; // generation is stale; no later lifecycle/start
    if (this._scheduler && gen?.proposalId) {
      this._scheduler.cancel(gen.proposalId);
    }
    // Keep gen.proposalId + this._gen so Release can durably reject it.
  }

  // ------------------------------------------------------------------
  // Release (A1 outcome barrier) and Retry (A10 serialization)
  // ------------------------------------------------------------------

  async release(reason = null) {
    if (this._disposed) return { ok: false, code: 'DISPOSED' };
    let gen = this._gen;

    // Hydrated proposals have no runtime generation, but the recovery card's
    // Release control must still append the durable human rejection.
    if (!gen) {
      const proposalId = this._activeProposalIdForRelease();
      const projectId = this.store.getState().currentProject?.id;
      if (proposalId && projectId) {
        gen = {
          id: `hydrated-${proposalId}`,
          projectId,
          proposalId,
          asset: null,
          receipt: null,
          released: false,
          pendingPromise: null,
          pendingAction: null,
        };
        this._gen = gen;
      }
    }

    if (!gen && !this._hasServerActiveProposals()) {
      this._setStatus({
        phase: GHOST_PHASES.IDLE,
        activeProposalId: null,
        receipt: null,
        summary: null,
        error: null,
      });
      return { ok: true, note: 'nothing to release' };
    }

    // Phase 11 terminal barrier: Commit and Release never author competing
    // outcomes concurrently from this controller. If Commit already owns the
    // barrier, wait for its authoritative result before deciding truthfully.
    if (gen?.terminalKind === 'commit' && gen.terminalPromise) {
      const committed = await gen.terminalPromise;
      if (committed.ok) {
        return { ok: false, code: 'ALREADY_COMMITTED' };
      }
    }
    if (gen) gen.terminalKind = 'release';

    this._setStatus({ phase: GHOST_PHASES.RELEASING, error: null });
    this._announce('Releasing Ghost preview…');

    // Cancel all runtime machinery immediately — zero later starts (A1).
    this._stopLaunchObserver();
    if (gen) gen.released = true;
    if (this._scheduler && gen?.proposalId) this._scheduler.cancel(gen.proposalId);

    let barrierError = null;
    // 1. Reconcile the in-flight preview intent FIRST (A1 outcome barrier).
    if (gen && gen.pendingPromise) {
      let outcome = null;
      try {
        outcome = await gen.pendingPromise;
      } catch (err) {
        const failure = scrubError(err);
        if (failure.status !== null && failure.status < 500) {
          // HTTP-level envelope: the outcome IS known (no proposal survived —
          // validation/preparation failures are atomic). Reconciled, record it.
        } else {
          // A network failure or 5xx is an UNKNOWN outcome. Idempotently replay
          // the SAME envelope (same ID/key/payload) to resolve it (A1).
          try {
            outcome = await this.api.postProjectAction(gen.projectId, gen.pendingAction);
          } catch (retryErr) {
            const retryFailure = scrubError(retryErr);
            if (retryFailureHasKnownFailure(retryFailure)) {
              // A 4xx replay is a known atomic rejection/no-proposal outcome.
              outcome = null;
            } else {
              barrierError = {
                code: 'GHOST_RELEASE_UNRECONCILED',
                message: 'Release could not confirm the pending preview outcome. Try again.',
              };
            }
          }
        }
      }
      const proposal = outcome?.outcome?.proposal;
      if (!barrierError && proposal) {
        const rejectResult = await this._rejectDurably(gen, proposal.id, reason || 'released');
        if (!rejectResult.ok) barrierError = rejectResult.error;
      }
    } else if (gen?.proposalId) {
      const rejectResult = await this._rejectDurably(gen, gen.proposalId, reason || 'released');
      if (!rejectResult.ok) barrierError = rejectResult.error;
    }

    if (barrierError) {
      // Retryable releasing state (A1/A10): Release can be pressed again.
      this._setStatus({
        phase: GHOST_PHASES.FAILED,
        error: barrierError,
        activeProposalId: gen?.proposalId || null,
      });
      if (gen) gen.terminalKind = null;
      return { ok: false, error: barrierError };
    }

    this._gen = null;
    const remaining = this._activeProposalIds();
    if (remaining.length > 0) {
      this._publishRecoveryStatus(remaining);
      return { ok: true, remaining: remaining.length };
    }
    this._setStatus({
      phase: GHOST_PHASES.IDLE,
      activeProposalId: null,
      receipt: null,
      summary: null,
      error: null,
    });
    this._announce('Ghost preview released.');
    return { ok: true };
  }

  /**
   * A10 Retry: resume the context synchronously (gesture), then await the
   * durable release barrier; only then author the replacement preview.
   */
  async retry(region, gainDb) {
    if (this._disposed) return { ok: false, code: 'DISPOSED' };
    this._ensureContext();
    const releaseResult = await this.release();
    if (!releaseResult.ok) {
      return { ok: false, code: 'RELEASE_FAILED', error: releaseResult.error };
    }
    return this.invoke(region, gainDb);
  }

  // ------------------------------------------------------------------
  // Phase 11A: Commit (outcome barrier + idempotency) and 11C: Revert
  // ------------------------------------------------------------------

  /**
   * Commit the auditioned Ghost as a durable committed layer.
   *
   * Amendment 3: clicking Commit enters `committing` and blocks further
   * terminal controls. On a definite server rejection, return to `auditioning`
   * with the mapped error. On an ambiguous network failure, fetch the
   * authoritative action state to reconcile (committed / still auditioning /
   * released). Reconciliation failure leaves a retryable unknown state.
   */
  async commit() {
    if (this._disposed) return { ok: false, code: 'DISPOSED' };
    const gen = this._gen;
    if (!gen || !gen.proposalId || !gen.asset) {
      return { ok: false, code: 'NOTHING_TO_COMMIT' };
    }
    if (gen.terminalKind === 'release') {
      return {
        ok: false,
        code: 'RELEASE_IN_PROGRESS',
        error: { code: 'RELEASE_IN_PROGRESS', message: 'Release is already in progress.' },
      };
    }
    if (gen.terminalKind === 'commit' && gen.terminalPromise) {
      return gen.terminalPromise;
    }
    // Only a proposal that actually reached the launch boundary is committable
    // (the exact Ghost Richard heard). The controller records `auditioning`
    // only at the launch boundary (A2), so the store lifecycle is the gate.
    const proposal = this.store.getState().proposals?.byId?.[gen.proposalId];
    if (!proposal || proposal.lifecycle !== 'auditioning') {
      return {
        ok: false,
        code: 'NOT_AUDITIONING',
        error: { code: 'NOT_AUDITIONING', message: 'The Ghost is not auditioning yet.' },
      };
    }

    const promise = this._commitGeneration(gen);
    gen.terminalKind = 'commit';
    gen.terminalPromise = promise;
    const result = await promise;
    if (!result.ok && this._gen === gen) {
      gen.terminalKind = null;
      gen.terminalPromise = null;
    }
    return result;
  }

  async _commitGeneration(gen) {
    this._setStatus({ phase: GHOST_PHASES.COMMITTING, error: null });
    this._announce('Committing Ghost…');

    // Memoize the commit envelope (Amendment 1): built once, reused on retry.
    if (!gen.commitAction) {
      gen.commitAction = this.api.buildCommitAction(gen.proposalId, gen.asset);
    }

    try {
      await this.api.postProjectAction(gen.projectId, gen.commitAction);
      // Success: re-fetch the authoritative projection so the client holds the
      // server's committed layer (with launchReceipt + pinned asset) verbatim.
      if (gen.projectId === this.store.getState().currentProject?.id) {
        try {
          const state = await this.api.getActionState(gen.projectId);
          this.store.dispatch({
            type: 'v1/hydrate-projection',
            projection: { session: state.session, proposals: state.proposals },
            lastSequence: state.last_sequence,
          });
          // Phase 12: the refreshed projection now holds the committed layer;
          // converge the live engine through the authoritative sync path.
          await this._syncLiveEngine();
        } catch {
          // Hydration refresh is best-effort; the durable commit already held.
          // Amendment 2: a failed refresh never invents a live layer — the
          // slice keeps its prior honest state.
        }
      }
      this._setStatus({
        phase: GHOST_PHASES.COMMITTED,
        activeProposalId: null,
        receipt: null,
        summary: null,
        error: null,
      });
      this._announce('Ghost committed. It will be included in the next preview/render.');
      this._gen = null;
      return { ok: true };
    } catch (err) {
      const failure = scrubError(err);
      // Definite server rejection (4xx): return to auditioning with the error.
      if (failure.status !== null && failure.status < 500) {
        this._setStatus({
          phase: GHOST_PHASES.AUDITIONING,
          error: { code: failure.code, message: failure.message },
        });
        return { ok: false, code: failure.code, error: { code: failure.code, message: failure.message } };
      }
      // Ambiguous outcome (timeout/disconnect/5xx): fetch authoritative state.
      const reconciled = await this._reconcileCommitOutcome(gen);
      if (reconciled === 'committed') {
        this._setStatus({
          phase: GHOST_PHASES.COMMITTED,
          activeProposalId: null,
          receipt: null,
          summary: null,
          error: null,
        });
        this._announce('Ghost committed. It will be included in the next preview/render.');
        this._gen = null;
        return { ok: true };
      }
      if (reconciled === 'auditioning') {
        this._setStatus({
          phase: GHOST_PHASES.AUDITIONING,
          error: { code: 'COMMIT_UNKNOWN', message: 'Commit outcome unknown. Try again.' },
        });
        return { ok: false, code: 'COMMIT_UNKNOWN' };
      }
      if (reconciled === 'released') {
        this._setStatus({
          phase: GHOST_PHASES.FAILED,
          error: { code: 'RELEASED', message: 'The Ghost was released before it could be committed.' },
        });
        return { ok: false, code: 'RELEASED' };
      }
      // Reconciliation itself failed: retryable unknown state.
      this._setStatus({
        phase: GHOST_PHASES.FAILED,
        error: {
          code: 'COMMIT_UNRECONCILED',
          message: 'Commit outcome could not be confirmed. Try Commit again.',
        },
      });
      return { ok: false, code: 'COMMIT_UNRECONCILED' };
    }
  }

  async _reconcileCommitOutcome(gen) {
    try {
      const state = await this.api.getActionState(gen.projectId);
      const proposal = state?.proposals?.byId?.[gen.proposalId];
      if (!proposal) return 'released';
      if (proposal.lifecycle === 'accepted') return 'committed';
      if (proposal.lifecycle === 'rejected') return 'released';
      return 'auditioning';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Revert a committed layer (Phase 11C). Append-only; the layer moves from
   * committedLayers to revertedLayers with full provenance retained.
   */
  async revert(commitActionId) {
    if (this._disposed) return { ok: false, code: 'DISPOSED' };
    const projectId = this.store.getState().currentProject?.id;
    if (!projectId) return { ok: false, code: 'NO_PROJECT' };
    if (typeof commitActionId !== 'string' || !commitActionId) {
      return { ok: false, code: 'INVALID_COMMIT' };
    }
    // Both the envelope and in-flight promise are memoized per commit. Rapid
    // clicks share one POST; a retry after failure reuses the same Action.
    const pending = this._revertPromises.get(commitActionId);
    if (pending) return pending;
    let action = this._revertActions.get(commitActionId);
    if (!action) {
      action = this.api.buildRevertAction(commitActionId);
      this._revertActions.set(commitActionId, action);
    }
    const promise = this._revertInner(projectId, commitActionId, action);
    this._revertPromises.set(commitActionId, promise);
    const result = await promise;
    if (!result.ok) this._revertPromises.delete(commitActionId);
    return result;
  }

  async _revertInner(projectId, commitActionId, action) {
    try {
      const result = await this.api.postProjectAction(projectId, action);
      this.store.dispatch({
        type: 'v1/commit/reverted',
        commitActionId,
        revertActionId: action.id,
      });
      // Phase 12 (Amendment 6): the server confirmed the reversal — stop the
      // live layer immediately. A failed Undo above leaves playback and
      // projection unchanged (durable-first ordering).
      if (this._liveEngine && !this._liveEngineTornDown) {
        this._liveEngine.remove(commitActionId);
      }
      return { ok: true, result: result?.outcome?.result || 'commit_reverted' };
    } catch (err) {
      const failure = scrubError(err);
      // Any ambiguous response, and the explicit already-reverted conflict,
      // must reconcile against authoritative projection truth.
      if (failure.code === 'L_ALREADY_REVERTED'
          || failure.status === null || failure.status >= 500) {
        const reconciled = await this._reconcileRevertOutcome(projectId, commitActionId);
        if (reconciled === 'reverted') return { ok: true, reconciled: failure.code || 'network' };
        if (reconciled === 'committed') {
          return {
            ok: false,
            code: failure.code || 'REVERT_UNKNOWN',
            error: { code: failure.code, message: 'Undo was not confirmed. Try again.' },
          };
        }
      }
      return {
        ok: false,
        code: failure.code || 'REVERT_FAILED',
        error: { code: failure.code, message: failure.message },
      };
    }
  }

  async _reconcileRevertOutcome(projectId, commitActionId) {
    try {
      const state = await this.api.getActionState(projectId);
      const session = state?.session || {};
      const reverted = (session.revertedLayers || []).some(
        (layer) => layer?.actionId === commitActionId,
      );
      const committed = (session.committedLayers || []).some(
        (layer) => layer?.actionId === commitActionId,
      );
      if (projectId === this.store.getState().currentProject?.id) {
        this.store.dispatch({
          type: 'v1/hydrate-projection',
          projection: { session: state.session, proposals: state.proposals },
          lastSequence: state.last_sequence,
        });
      }
      if (reverted) return 'reverted';
      if (committed) return 'committed';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async _rejectDurably(generation, proposalId, reason) {
    // Exactly ONE human reject per proposal per release (A1/A10): both the
    // release barrier and the stale invoke path can request it.
    if (generation.rejectedPromise) return generation.rejectedPromise;
    generation.rejectedPromise = this._rejectDurablyInner(generation, proposalId, reason);
    const result = await generation.rejectedPromise;
    if (!result.ok) generation.rejectedPromise = null; // retry SAME envelope
    return result;
  }

  async _rejectDurablyInner(generation, proposalId, reason) {
    try {
      generation.rejectAction ||= this.api.buildRejectAction(proposalId, reason || 'released');
      await this.api.postProjectAction(generation.projectId, generation.rejectAction);
      if (generation.projectId === this.store.getState().currentProject?.id) {
        this.store.dispatch({ type: 'v1/proposal/rejected', proposalId });
      }
      return { ok: true };
    } catch (err) {
      const failure = scrubError(err);
      // Honest durable-success equivalences: the proposal is already terminal
      // (double Release / idempotent race) or never existed (unknown ID).
      if (failure.code === 'L_INVALID_TRANSITION' || failure.code === 'L_UNKNOWN_PROPOSAL') {
        return { ok: true, reconciled: failure.code };
      }
      return {
        ok: false,
        error: {
          code: 'GHOST_RELEASE_UNRECONCILED',
          message: 'The Ghost could not be released durably. Try Release again.',
        },
      };
    }
  }

  _hasServerActiveProposals() {
    const state = this.store.getState();
    return (state.proposals?.activeIds || []).some((id) => {
      const proposal = state.proposals?.byId?.[id];
      return proposal && ACTIVE_LIFECYCLES.includes(proposal.lifecycle);
    });
  }

  _serverConflictActive() {
    const state = this.store.getState();
    const actives = (state.proposals?.activeIds || [])
      .map((id) => state.proposals?.byId?.[id])
      .filter((p) => p && ACTIVE_LIFECYCLES.includes(p.lifecycle));
    return actives.length > 1;
  }

  _activeProposalIds() {
    const state = this.store.getState();
    return (state.proposals?.activeIds || []).filter((id) => {
      const proposal = state.proposals?.byId?.[id];
      return proposal && ACTIVE_LIFECYCLES.includes(proposal.lifecycle);
    });
  }

  _activeProposalIdForRelease() {
    const activeIds = this._activeProposalIds();
    const selected = this._status().activeProposalId;
    return activeIds.includes(selected) ? selected : (activeIds[0] || null);
  }

  _proposalSummary(proposal) {
    const region = proposal?.payload?.source?.region;
    if (!region) return null;
    return {
      sourceLabel: 'Foundation vocals',
      destinationLabel: 'Lead',
      startBeat: region.startBeat,
      endBeat: region.endBeat,
      gainDb: proposal.payload?.gainDb,
    };
  }

  _publishRecoveryStatus(activeIds) {
    const state = this.store.getState();
    const first = activeIds[0];
    this._setStatus({
      phase: activeIds.length > 1 ? GHOST_PHASES.CONFLICT : GHOST_PHASES.INTERRUPTED,
      activeProposalId: first,
      receipt: null,
      summary: this._proposalSummary(state.proposals?.byId?.[first]),
      error: activeIds.length > 1
        ? { code: 'GHOST_STATE_CONFLICT', message: `${activeIds.length} unresolved Ghost previews need Release.` }
        : { code: 'GHOST_INTERRUPTED', message: 'An interrupted Ghost preview was restored. Release or Retry it.' },
    });
  }

  _blockingProposals() {
    const state = this.store.getState();
    if (this._gen) return [this._gen.proposalId || 'pending'];
    return (state.proposals?.activeIds || []).filter((id) => {
      const proposal = state.proposals?.byId?.[id];
      return proposal && ACTIVE_LIFECYCLES.includes(proposal.lifecycle);
    });
  }

  // ------------------------------------------------------------------
  // A8: hydration / project-switch boundaries
  // ------------------------------------------------------------------

  /** Hydration failed (A8): visible, retryable — never fabricated empty truth. */
  handleHydrationFailed() {
    if (this._disposed) return;
    this._setStatus({
      hydrating: false,
      error: {
        code: 'GHOST_HYDRATION_FAILED',
        message: 'Could not restore Ghost state from the server.',
      },
    });
  }

  /** Called by app.js after hydration dispatches a new projection. */
  handleHydratedProjection(projection) {
    if (this._disposed) return;
    const byId = projection?.proposals?.byId || this.store.getState().proposals?.byId || {};
    const activeIds = (projection?.proposals?.activeIds
      || this.store.getState().proposals?.activeIds || [])
      .filter((id) => byId[id] && ACTIVE_LIFECYCLES.includes(byId[id].lifecycle));

    // Any previous generation is gone: the old project's clock is dead (A8).
    this._cancelGenerationRuntime();

    // Phase 12: every authoritative projection refresh converges the live
    // engine through the one sync() path (Amendment 2). A refresh after a
    // project switch may build a fresh engine for the new project.
    this._liveEngineTornDown = false;
    this._syncLiveEngine().catch(() => { /* the slice shows the honest state */ });

    if (activeIds.length === 0) {
      this._setStatus({
        phase: GHOST_PHASES.IDLE,
        activeProposalId: null,
        receipt: null,
        summary: null,
        error: null,
      });
      return;
    }
    // Hydrated actives can never resume automatically (no autoplay, old clock
    // gone). Deterministic recovery: block previews, first-in-order adoptable,
    // >1 → an honest conflict state instead of a silent pick.
    this._publishRecoveryStatus(activeIds);
    this._announce('An interrupted Ghost preview was restored.');
  }

  /** ProjectManager hook: hard cancel BEFORE the new project can be set (A8). */
  onBeforeProjectChange() {
    if (this._disposed) return;
    this._cancelGenerationRuntime();
    // Phase 12: project switch hard-tears-down the live engine (old project's
    // clock is dead); the next hydration builds a fresh one.
    this._teardownLiveEngine();
    this._setStatus({
      phase: GHOST_PHASES.IDLE,
      activeProposalId: null,
      receipt: null,
      summary: null,
      error: null,
    });
  }

  _teardownLiveEngine() {
    if (this._liveEngine && !this._liveEngineTornDown) {
      this._liveEngine.shutdown();
    }
    this._liveEngine = null;
    this._liveEngineTornDown = true;
  }

  _cancelGenerationRuntime() {
    this._stopLaunchObserver();
    const gen = this._gen;
    if (gen) gen.released = true;
    if (this._scheduler && gen?.proposalId) this._scheduler.cancel(gen.proposalId);
    this._gen = null;
    this._receipt = null;
  }

  // ------------------------------------------------------------------
  // Hydration status (A8: visible, retryable — never fabricated empty truth)
  // ------------------------------------------------------------------

  setHydrating(flag) {
    if (this._disposed) return;
    this._setStatus({ hydrating: Boolean(flag) });
  }

  // ------------------------------------------------------------------
  // Teardown
  // ------------------------------------------------------------------

  async shutdown() {
    if (this._disposed) return;
    this._disposed = true;
    this._cancelGenerationRuntime();
    this._teardownLiveEngine();
    if (this._scheduler) {
      this._scheduler.shutdown();
      this._scheduler = null;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch { /* already closed */ }
      this._ctx = null;
    }
  }
}

function retryFailureHasKnownFailure(failure) {
  return failure && typeof failure === 'object'
    && typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500;
}
