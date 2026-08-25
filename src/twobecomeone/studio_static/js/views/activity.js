// views/activity.js — Activity view (full) and reusable drawer content.
//
// Phase 4.9: active jobs first; imports/separations/previews/renders; truthful
// measured/stage-only progress; current stage and message; OOM warning; cancel
// for active jobs; retry/resume for supported terminal jobs; plain-language
// error with optional technical detail. Each item owns its state by job ID.

import { createElement, replaceChildren } from '../dom.js';
import { showToast } from '../components/toast.js';
import { listJobs, cancelJob, retryJob, watchJob } from '../api.js';
import { announceJob } from '../announce.js';

const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['queued', 'running']);

const KIND_LABEL = {
  import: 'Import',
  separate: 'Separation',
  preview: 'Preview',
  render: 'Render',
};

const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function mountActivity({ store, container }) {
  const disposers = [];
  const watchers = new Map(); // jobId -> unsubscribe
  let abortController = null;

  const listEl = createElement('div', { class: 'job-list', role: 'list' });
  container.replaceChildren(listEl);

  const render = (state) => {
    const jobs = state.jobs.items;
    if (jobs.length === 0) {
      listEl.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('p', { class: 'state__title', text: 'No activity yet.' }),
        createElement('p', { text: 'Imports, separations, previews, and renders will appear here.' }),
      ]));
      return;
    }
    const items = jobs.map((job) => renderJobItem(job, store));
    replaceChildren(listEl, items);
  };

  const renderJobItem = (job, store) => {
    const statusBadge = createElement('span', {
      class: `badge badge--${statusKind(job.status)}`,
      text: STATUS_LABEL[job.status] || job.status,
    });

    const title = createElement('div', { class: 'job-item__title', text: KIND_LABEL[job.kind] || job.kind });

    const head = createElement('div', { class: 'job-item__head' }, [title, statusBadge]);

    const stage = createElement('div', { class: 'job-item__stage', text: job.message || job.stage || '' });

    const nodes = [head, stage];

    // Progress bar (per-job, never a shared global bar).
    if (ACTIVE.has(job.status)) {
      const progress = createElement('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(job.progress || 0) }, [
        createElement('span', { class: 'progress__bar', style: { width: `${job.progress || 0}%` } }),
      ]);
      nodes.push(progress);
    }

    // OOM warning.
    const detail = job.progress_detail || {};
    if (detail.warning) {
      nodes.push(createElement('div', { class: 'job-item__warning', text: detail.warning }));
    }

    // Error (plain language) + optional technical detail.
    if (job.status === 'failed' && job.error) {
      nodes.push(createElement('div', { class: 'job-item__error', text: job.error }));
    }

    // Actions.
    const actions = createElement('div', { class: 'job-item__actions' });
    if (ACTIVE.has(job.status)) {
      actions.appendChild(createElement('button', {
        class: 'button button--danger', type: 'button', text: 'Cancel',
        onclick: () => cancel(job),
      }));
    }
    if (TERMINAL.has(job.status) && job.status !== 'complete') {
      actions.appendChild(createElement('button', {
        class: 'button', type: 'button', text: 'Retry',
        onclick: () => retry(job),
      }));
    }
    nodes.push(actions);

    return createElement('div', { class: 'job-item', role: 'listitem', 'data-job-id': job.id }, nodes);
  };

  const statusKind = (status) => {
    if (status === 'complete') return 'success';
    if (status === 'failed' || status === 'cancelled') return 'danger';
    if (status === 'queued' || status === 'running') return 'waiting';
    return 'waiting';
  };

  const cancel = async (job) => {
    try {
      await cancelJob(job.id);
      showToast('Cancellation requested.');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const retry = async (job) => {
    try {
      await retryJob(job.id);
      showToast('Retry queued.');
      load();
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const load = async () => {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    try {
      const data = await listJobs({ limit: 100 }, abortController.signal);
      const items = data.items || data.jobs || [];
      const activeCount = items.filter((j) => ACTIVE.has(j.status)).length;
      store.dispatch({ type: 'jobs/set', items, total: items.length, activeCount });
      // Watch active jobs for live updates.
      watchActive(items);
    } catch (err) {
      if (err.name === 'AbortError') return;
      showToast(err.message, 'danger');
    }
  };

  const watchActive = (jobs) => {
    const activeIds = new Set(jobs.filter((j) => ACTIVE.has(j.status)).map((j) => j.id));
    // Close watchers for jobs no longer active.
    for (const [id, unsubscribe] of watchers) {
      if (!activeIds.has(id)) {
        unsubscribe();
        watchers.delete(id);
      }
    }
    // Open watchers for newly active jobs.
    for (const id of activeIds) {
      if (!watchers.has(id)) {
        const unsubscribe = watchJob(id, (job) => {
          const previous = store.getState().jobs.items.find((item) => item.id === job.id) || null;
          store.dispatch({ type: 'jobs/upsert', job });
          announceJob(job, previous);
        });
        watchers.set(id, unsubscribe);
      }
    }
  };

  const unsubscribe = store.subscribeSlice('jobs', (jobs) => render({ jobs }));
  disposers.push(() => {
    unsubscribe();
    if (abortController) abortController.abort();
    for (const unsub of watchers.values()) unsub();
    watchers.clear();
  });

  load();

  return () => {
    for (const dispose of disposers) dispose();
  };
}
