// js/runtime/stem-stack-controller.js — FUN stem-stack preview/commit runtime.
//
// Schedules one server-prepared stereo asset. Prefers the LiveMixer AudioContext
// when one is already running so preview shares the three-bus graph clock.
// Does not use the footer audioController singleton. GhostScheduler is reused
// as the one-buffer scheduler; commit hydrates into LiveMixer.stemStack.

import { GhostScheduler } from './ghost-scheduler.js';
import { preparedAssetAudioUrl } from '../stem-stack.js';

const LAUNCH_OBSERVER_INTERVAL_MS = 150;

export class StemStackController {
  constructor(deps) {
    if (!deps || !deps.api || !deps.audioContextFactory) {
      throw new Error('StemStackController requires api and audioContextFactory');
    }
    this.api = deps.api;
    this.onAnnounce = deps.onAnnounce || (() => {});
    this._ctxFactory = deps.audioContextFactory;
    this.liveMixer = deps.liveMixer || null;
    this.onPhaseChange = deps.onPhaseChange || null;
    this._schedulerFactory = deps.schedulerFactory || ((d) => new GhostScheduler(d));
    this._disposed = false;
    this._ctx = null;
    this._scheduler = null;
    this._gen = null;
    this._observer = null;
    this._phase = 'idle';
  }

  snapshot() {
    return {
      phase: this._phase,
      proposalId: this._gen?.proposalId || null,
      assetId: this._gen?.asset?.id || null,
      launchAudioTime: this._gen?.receipt?.launchAudioTime ?? null,
    };
  }

  _setPhase(phase) {
    this._phase = phase;
    try { this.onPhaseChange?.(this.snapshot()); } catch { /* chrome refresh is best-effort */ }
  }

  async preview({ projectId, action, outcome }) {
    if (this._disposed) return;
    this.cancel();
    const proposal = outcome?.proposal || outcome?.outcome?.proposal;
    const asset = outcome?.asset || outcome?.outcome?.asset;
    if (!proposal || !asset) throw new Error('stem stack preview returned no asset');
    this._setPhase('preparing');
    if (this.liveMixer?.ensureGraph) await this.liveMixer.ensureGraph();
    const ctx = this._ensureContext();
    if (ctx.resume) await ctx.resume().catch(() => {});
    this._gen = { projectId, proposal, asset, proposalId: proposal.id };
    await this.api.postProposalLifecycle(
      projectId,
      proposal.id,
      this.api.buildLifecycleBody('scheduled'),
    );
    proposal.lifecycle = 'scheduled';
    const scheduler = this._ensureScheduler();
    const scheduled = await scheduler.schedule(proposal, {
      ...asset,
      audioUrl: preparedAssetAudioUrl(asset),
    });
    if (!scheduled.ok) {
      this._setPhase('failed');
      throw new Error(scheduled.code || 'stack schedule failed');
    }
    this._gen.receipt = scheduled.receipt;
    this._setPhase('armed');
    this._watchLaunch(scheduled.receipt);
    this.onAnnounce('Stem stack scheduled for the next phrase.');
  }

  async commit() {
    const gen = this._gen;
    if (!gen || this._phase !== 'auditioning') {
      throw new Error('Commit needs an auditioning stem stack');
    }
    this._setPhase('committing');
    const action = this.api.buildCommitStemStackAction(gen.proposalId, gen.asset);
    const result = await this.api.postProjectAction(gen.projectId, action);
    this._stopObserver();
    if (this._scheduler && gen.proposalId) this._scheduler.cancel(gen.proposalId);
    this._setPhase('committed');
    this.onAnnounce('Stem stack committed.');
    return result;
  }

  async revert(commitActionId) {
    const action = this.api.buildRevertAction(commitActionId);
    const result = await this.api.postProjectAction(this._gen?.projectId, action);
    this.cancel();
    this.onAnnounce('Stem stack undone.');
    return result;
  }

  cancel() {
    this._stopObserver();
    if (this._scheduler && this._gen?.proposalId) {
      this._scheduler.cancel(this._gen.proposalId);
    }
    this._gen = null;
    this._setPhase('idle');
  }

  dispose() {
    this.cancel();
    this._disposed = true;
    if (this._scheduler) this._scheduler.shutdown?.();
  }

  _ensureContext() {
    const shared = this.liveMixer?.audioContext?.();
    if (shared) {
      this._ctx = shared;
      return this._ctx;
    }
    if (!this._ctx) this._ctx = this._ctxFactory.create();
    return this._ctx;
  }

  _ensureScheduler() {
    if (!this._scheduler) {
      this._scheduler = this._schedulerFactory({
        audioContext: this._ctx,
        loadAsset: async (asset, signal) => {
          const response = await fetch(preparedAssetAudioUrl(asset), { signal });
          if (!response.ok) throw new Error(`stack asset fetch failed: ${response.status}`);
          return response.arrayBuffer();
        },
        transportProvider: () => this._stackTransport(),
      });
    }
    return this._scheduler;
  }

  _stackTransport() {
    const spec = this._gen?.asset?.transformSpec || {};
    return {
      deck: 'B',
      playing: true,
      tempoBpm: Number(spec.targetBpm) || 120,
      beatsPerBar: 4,
      phraseBars: Number(spec.destinationBars) || 4,
      beatAtStart: 0,
      startedAtAudioTime: this._ctx ? this._ctx.currentTime : 0,
      gridRevision: spec.destinationGridRevision || 'grid-v1-stack',
    };
  }

  _watchLaunch(receipt) {
    this._stopObserver();
    this._observer = setInterval(() => {
      if (this._disposed || !this._gen || !this._ctx) return;
      if (this._ctx.currentTime + 1e-9 < receipt.launchAudioTime) return;
      this._stopObserver();
      this._recordAuditioning(receipt).catch((err) => {
        this._setPhase('failed');
        this.onAnnounce(err.message || 'Could not record stack auditioning');
      });
    }, LAUNCH_OBSERVER_INTERVAL_MS);
  }

  async _recordAuditioning(receipt) {
    const gen = this._gen;
    if (!gen) return;
    await this.api.postProposalLifecycle(
      gen.projectId,
      gen.proposalId,
      this.api.buildLifecycleBody('auditioning', {
        assetId: gen.asset.id,
        contentHash: gen.asset.contentHash,
        gridRevision: gen.asset.transformSpec.destinationGridRevision,
        launchBeat: receipt.resolvedBeat ?? receipt.launchBeat ?? 0,
      }),
    );
    this._setPhase('auditioning');
    this.onAnnounce('Stem stack is auditioning.');
  }

  _stopObserver() {
    if (this._observer !== null) {
      clearInterval(this._observer);
      this._observer = null;
    }
  }
}
