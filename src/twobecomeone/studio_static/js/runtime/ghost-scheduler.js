// js/runtime/ghost-scheduler.js — deterministic Web Audio scheduling bridge.
//
// Phase 9C. A leaf frontend runtime module that connects a durable prepared
// Ghost asset to a controller-owned, disposable AudioContext source. It is
// NOT a second visible player and does NOT replace audioController's single
// HTMLAudioElement.
//
// Design rules (from the plan):
//   - Constructor dependencies are injected (AudioContext, asset loader,
//     destination-transport provider) so Node tests can use a fake context.
//   - No DOM imports; no runtime object ever enters StateStore.
//   - It schedules only a HUMAN proposal explicitly marked `scheduled` by the
//     narrow runtime/test seam. It never promotes `ready` itself, never starts
//     Producer work, and never commits.
//   - After fetch/decode it calls the pure `resolveNextPhrase()` with
//     `audioContext.currentTime`, target Deck B facts, and the Phase 8 epsilon
//     rule, then calls `source.start(launchAudioTime)` exactly once.
//   - Finite minimum lead-time policy: if decoding makes the computed boundary
//     unsafe (launchAudioTime - now < MIN_LEAD_SECONDS), re-resolve the
//     FOLLOWING phrase rather than starting late.
//   - Cancellable/stale-safe: a refreshed/removed/rejected proposal, shutdown,
//     or stale async response cancels/disconnects its runtime work and never
//     starts later.
//   - Exposes an immutable schedule receipt (proposal ID, asset content hash,
//     transport grid revision, resolved beat, launchAudioTime). This proves
//     Web Audio scheduling intent — NOT physical speaker/sample accuracy.

import { resolveNextPhrase } from '../transport/derive.js';

export const MIN_LEAD_SECONDS = 0.25;

export const SCHEDULE_STATES = Object.freeze({
  IDLE: 'idle',
  FETCHING: 'fetching',
  DECODING: 'decoding',
  SCHEDULED: 'scheduled',
  STARTED: 'started',
  ENDED: 'ended',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

/**
 * @param {object} deps
 * @param {AudioContext} deps.audioContext — injected (fake in Node tests)
 * @param {(asset: object, signal: AbortSignal) => Promise<ArrayBuffer>} deps.loadAsset
 * @param {(deck: string) => object} deps.transportProvider — returns raw Deck B transport
 * @param {(proposalId: string, receipt: object) => void} [deps.onScheduled]
 * @param {(proposalId: string, state: string, error?: object) => void} [deps.onStateChange]
 * @param {number} [deps.minLeadSeconds]
 */
export class GhostScheduler {
  constructor(deps) {
    if (!deps || !deps.audioContext || !deps.loadAsset || !deps.transportProvider) {
      throw new Error('GhostScheduler requires audioContext, loadAsset, and transportProvider');
    }
    this.ctx = deps.audioContext;
    this.loadAsset = deps.loadAsset;
    this.transportProvider = deps.transportProvider;
    this.onScheduled = deps.onScheduled || (() => {});
    this.onStateChange = deps.onStateChange || (() => {});
    this.minLeadSeconds = deps.minLeadSeconds ?? MIN_LEAD_SECONDS;

    // One active scheduling job per proposal id.
    this._jobs = new Map();
    this._shutdown = false;
  }

  /**
   * Schedule a human proposal's prepared asset on the Web Audio clock.
   *
   * @param {object} proposal — must be lifecycle 'scheduled' and actor human
   * @param {object} asset — { id, contentHash, audioUrl, transformSpec }
   * @returns {Promise<{ok: boolean, receipt?: object, code?: string}>}
   */
  async schedule(proposal, asset) {
    if (this._shutdown) return { ok: false, code: 'SHUTDOWN' };
    if (!proposal || proposal.actor?.type !== 'human') {
      return { ok: false, code: 'NOT_HUMAN' };
    }
    if (proposal.lifecycle !== 'scheduled') {
      return { ok: false, code: 'NOT_SCHEDULED' };
    }
    if (!asset || !asset.audioUrl) {
      return { ok: false, code: 'NO_ASSET' };
    }
    // One scheduled source per proposal.
    if (this._jobs.has(proposal.id)) {
      return { ok: false, code: 'ALREADY_SCHEDULED' };
    }

    const controller = new AbortController();
    const job = {
      proposalId: proposal.id,
      controller,
      source: null,
      gainNode: null,
      state: SCHEDULE_STATES.FETCHING,
      receipt: null,
    };
    this._jobs.set(proposal.id, job);
    this._setState(job, SCHEDULE_STATES.FETCHING);

    try {
      // 1. Fetch the prepared asset bytes.
      const buffer = await this.loadAsset(asset, controller.signal);
      if (this._isStale(job)) return this._staleResult(job);

      // 2. Decode asynchronously.
      this._setState(job, SCHEDULE_STATES.DECODING);
      const audioBuffer = await this.ctx.decodeAudioData(buffer);
      if (this._isStale(job)) return this._staleResult(job);

      // 3. Resolve the next phrase on the Web Audio clock.
      const now = this.ctx.currentTime;
      const rawTransport = this.transportProvider('B');
      let resolved = resolveNextPhrase(rawTransport, now);
      if (!resolved.ok) {
        this._fail(job, resolved.code);
        return { ok: false, code: resolved.code };
      }

      // 4. Finite minimum lead-time policy: if the computed boundary is too
      //    close (decode took too long), re-resolve the FOLLOWING phrase
      //    rather than starting late.
      let launch = resolved.value;
      while (launch.launchAudioTime - now < this.minLeadSeconds) {
        const later = resolveNextPhrase(rawTransport, launch.launchAudioTime + 1e-9);
        if (!later.ok) {
          this._fail(job, later.code);
          return { ok: false, code: later.code };
        }
        launch = later.value;
      }

      // 5. Build the disposable source + controller-owned gain node.
      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      const gainNode = this.ctx.createGain();
      const gainDb = proposal.payload?.gainDb ?? 0;
      gainNode.gain.value = Math.pow(10, gainDb / 20);
      source.connect(gainNode);
      gainNode.connect(this.ctx.destination);

      job.source = source;
      job.gainNode = gainNode;
      job.state = SCHEDULE_STATES.SCHEDULED;

      // 6. Immutable schedule receipt (proof of scheduling intent).
      const receipt = Object.freeze({
        proposalId: proposal.id,
        assetId: asset.id,
        assetContentHash: asset.contentHash,
        gridRevision: launch.gridRevision,
        resolvedBeat: launch.launchBeat,
        phraseIndex: launch.phraseIndex,
        launchAudioTime: launch.launchAudioTime,
        requestedAt: now,
        deck: launch.deck,
      });
      job.receipt = receipt;

      // 7. Schedule exactly once; clean up on ended.
      source.onended = () => {
        this._cleanup(job);
        this._setState(job, SCHEDULE_STATES.ENDED);
      };
      source.start(launch.launchAudioTime);
      job.state = SCHEDULE_STATES.STARTED;
      this._setState(job, SCHEDULE_STATES.STARTED);
      this.onScheduled(proposal.id, receipt);

      return { ok: true, receipt };
    } catch (error) {
      if (this._isStale(job)) return this._staleResult(job);
      if (error && error.name === 'AbortError') {
        this._cleanup(job);
        this._setState(job, SCHEDULE_STATES.CANCELLED);
        return { ok: false, code: 'ABORTED' };
      }
      // eslint-disable-next-line no-console
      console.error('[ghost-scheduler] failed', error?.code, error?.message);
      this._fail(job, 'SCHEDULE_FAILED', error);
      return { ok: false, code: 'SCHEDULE_FAILED' };
    }
  }

  /**
   * Cancel a proposal's runtime work (reject/refresh/teardown). Never starts
   * later.
   */
  cancel(proposalId) {
    const job = this._jobs.get(proposalId);
    if (!job) return;
    job.controller.abort();
    this._cleanup(job);
    this._setState(job, SCHEDULE_STATES.CANCELLED);
    this._jobs.delete(proposalId);
  }

  /** Cancel all jobs and prevent any future scheduling. */
  shutdown() {
    this._shutdown = true;
    for (const proposalId of [...this._jobs.keys()]) {
      this.cancel(proposalId);
    }
  }

  /** Immutable snapshot of active jobs (for tests/diagnostics). */
  snapshot() {
    return Object.freeze(
      [...this._jobs.entries()].map(([id, job]) => ({
        proposalId: id,
        state: job.state,
        receipt: job.receipt ? structuredClone(job.receipt) : null,
      })),
    );
  }

  _isStale(job) {
    return this._shutdown || !this._jobs.has(job.proposalId) || job.state === SCHEDULE_STATES.CANCELLED;
  }

  _staleResult(job) {
    this._cleanup(job);
    return { ok: false, code: 'STALE' };
  }

  _cleanup(job) {
    if (job.source) {
      try {
        job.source.onended = null;
        job.source.disconnect();
        job.source.stop();
      } catch {
        /* already stopped/disconnected */
      }
      job.source = null;
    }
    if (job.gainNode) {
      try {
        job.gainNode.disconnect();
      } catch {
        /* already disconnected */
      }
      job.gainNode = null;
    }
  }

  _fail(job, code, error) {
    this._cleanup(job);
    this._setState(job, SCHEDULE_STATES.FAILED, { code, message: error?.message });
    this._jobs.delete(job.proposalId);
  }

  _setState(job, state, error) {
    job.state = state;
    this.onStateChange(job.proposalId, state, error);
  }
}
