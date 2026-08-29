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
});

const ACTIVE_LIFECYCLES = Object.freeze(['ready', 'scheduled', 'auditioning']);

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

    // Runtime machinery (NEVER StateStore):
    this._ctx = null;
    this._scheduler = null;
    this._gen = null;          // active generation: { id, projectId, proposalId, asset, receipt, released, pendingPromise, pendingAction }
    this._launchObserver = null;
    this._schedulingInFlight = false;
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
      launchBeat: receipt.launchBeat,
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
          launchBeat: generation.receipt.launchBeat,
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
  // A7: destination ownership loss (pause/stop/ended/re-seek/replacement)
  // ------------------------------------------------------------------

  handleAudioEvent(type) {
    if (this._disposed || !this._gen || this._gen.released) return;
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
    this._setStatus({
      phase: GHOST_PHASES.IDLE,
      activeProposalId: null,
      receipt: null,
      summary: null,
      error: null,
    });
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
