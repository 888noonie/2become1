// job-coordinator.js — application-lifetime monitoring for active jobs.
//
// Views may subscribe to the shared API monitor registry for their own paint,
// but this coordinator owns the persistent store update subscription. That
// keeps restored/submitted jobs alive across route changes without opening a
// second EventSource for the same job.

import { watchJob } from './api.js';
import { announceJob } from './announce.js';

const ACTIVE = new Set(['queued', 'running']);

export class JobCoordinator {
  constructor(store, watch = watchJob) {
    this.store = store;
    this._watch = watch;
    this._watched = new Map();
    this._unsubscribeStore = null;
  }

  start() {
    if (this._unsubscribeStore) return;
    this._unsubscribeStore = this.store.subscribeSlice('jobs', (jobs) => {
      this._reconcile(jobs.items);
    });
    this._reconcile(this.store.getState().jobs.items);
  }

  /** Upsert a newly queued job; store subscription starts its shared monitor. */
  track(job) {
    this.start();
    this.store.dispatch({ type: 'jobs/upsert', job });
    return job;
  }

  /** Reconcile jobs restored by boot or refreshed by another view. */
  restore(items) {
    this.start();
    this._reconcile(items || []);
  }

  _reconcile(items) {
    const activeIds = new Set(
      (items || []).filter((job) => ACTIVE.has(job.status)).map((job) => job.id),
    );

    for (const [jobId, unsubscribe] of this._watched) {
      if (!activeIds.has(jobId)) {
        unsubscribe();
        this._watched.delete(jobId);
      }
    }

    for (const jobId of activeIds) {
      if (this._watched.has(jobId)) continue;
      // Reserve the ID before subscribing so even a synchronous test monitor
      // callback cannot recursively create a duplicate subscription.
      this._watched.set(jobId, () => {});
      const unsubscribe = this._watch(jobId, (job) => {
        const previous = this.store.getState().jobs.items.find(
          (item) => item.id === job.id,
        ) || null;
        this.store.dispatch({ type: 'jobs/upsert', job });
        announceJob(job, previous);
      });
      const current = this.store.getState().jobs.items.find((job) => job.id === jobId);
      if (current && ACTIVE.has(current.status)) {
        this._watched.set(jobId, unsubscribe);
      } else {
        unsubscribe();
        this._watched.delete(jobId);
      }
    }
  }

  dispose() {
    if (this._unsubscribeStore) {
      this._unsubscribeStore();
      this._unsubscribeStore = null;
    }
    for (const unsubscribe of this._watched.values()) unsubscribe();
    this._watched.clear();
  }
}
