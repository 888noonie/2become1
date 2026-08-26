// views/activity.js — Activity view (full) and reusable drawer content.
//
// Phase 4.9 + Phase 6: active jobs first; imports/separations/previews/renders;
// truthful measured/stage-only progress; current stage and message; OOM
// warning; cancel for active jobs; retry/resume for supported terminal jobs;
// plain-language error with optional technical detail. Application-lifetime job
// monitoring updates the shared store; this route owns only its abortable
// history load. Preview/render items render full result detail (display name,
// source names, request fields, output metrics, Play/Download/Rename/Retry,
// expandable request/result/error, and local reveal instructions).

import { createElement, replaceChildren } from '../dom.js';
import { showToast } from '../components/toast.js';
import { listJobs, cancelJob } from '../api.js';
import { jobCoordinator as globalJobCoordinator, projectManager as globalProjectManager } from '../app-context.js';
import {
  renderResultActions,
  renderResultDetail,
  renderResultSummary,
  renderRevealInstructions,
  resultDisplayName,
  STATUS_LABEL,
} from '../components/render-result.js';

const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['queued', 'running']);

const KIND_LABEL = {
  import: 'Import',
  separate: 'Separation',
  preview: 'Preview',
  render: 'Render',
};

export function mountActivity({
  store,
  container,
  projectManager = globalProjectManager,
  jobCoordinator = globalJobCoordinator,
  health = null,
}) {
  const disposers = [];
  let abortController = null;

  const listEl = createElement('div', { class: 'job-list', role: 'list' });
  container.replaceChildren(listEl);

  const render = (state) => {
    const jobs = state.jobs.items;
    const currentHealth = health || state.health || null;
    if (jobs.length === 0) {
      listEl.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('p', { class: 'state__title', text: 'No activity yet.' }),
        createElement('p', { text: 'Imports, separations, previews, and renders will appear here.' }),
      ]));
      return;
    }
    const items = jobs.map((job) => renderJobItem(job, store, projectManager, jobCoordinator, currentHealth));
    replaceChildren(listEl, items);
  };

  const renderJobItem = (job, store, projectManager, jobCoordinator, health) => {
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

    // Preview/render items get full result detail.
    if (job.kind === 'preview' || job.kind === 'render') {
      if (job.status === 'complete') {
        nodes.push(createElement('div', { class: 'job-item__result-name', text: resultDisplayName(job) }));
        nodes.push(renderResultSummary(job));
        nodes.push(renderRevealInstructions(health));
      }
      nodes.push(renderResultActions({
        job, store, projectManager, jobCoordinator, health,
      }));
      nodes.push(renderExpandableDetail(job));
    } else {
      // Import/separation recovery labels from the server recovery object.
      const recovery = job.recovery || {};
      const canRetry = recovery.can_retry === true;
      const action = recovery.action || 'retry';
      const actions = createElement('div', { class: 'job-item__actions' });
      if (ACTIVE.has(job.status)) {
        actions.appendChild(createElement('button', {
          class: 'button button--danger', type: 'button', text: 'Cancel',
          onclick: () => cancel(job),
        }));
      }
      if (TERMINAL.has(job.status) && job.status !== 'complete' && canRetry) {
        const isResume = action === 'resume';
        actions.appendChild(createElement('button', {
          class: 'button', type: 'button', text: isResume ? 'Resume' : 'Retry',
          onclick: () => retry(job, isResume),
        }));
      }
      nodes.push(actions);
      nodes.push(renderExpandableDetail(job));
    }

    return createElement('div', { class: 'job-item', role: 'listitem', 'data-job-id': job.id }, nodes);
  };

  const renderExpandableDetail = (job) => {
    const wrapper = createElement('div', { class: 'job-item__expand' });
    const toggle = createElement('button', {
      class: 'button button--sm', type: 'button',
      'aria-expanded': 'false',
      text: 'Show technical details',
      onclick: () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        toggle.textContent = expanded ? 'Show technical details' : 'Hide technical details';
        if (expanded) {
          replaceChildren(wrapper, [toggle]);
        } else {
          wrapper.appendChild(renderResultDetail(job));
        }
      },
    });
    wrapper.appendChild(toggle);
    return wrapper;
  };

  const statusKind = (status) => {
    if (status === 'complete') return 'success';
    if (status === 'failed' || status === 'cancelled') return 'danger';
    if (status === 'queued' || status === 'running') return 'waiting';
    return 'waiting';
  };

  const cancel = async (job) => {
    try {
      const updated = await cancelJob(job.id);
      store.dispatch({ type: 'jobs/upsert', job: updated });
      showToast('Cancellation requested.');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const retry = async (job, isResume) => {
    try {
      const { retryJob } = await import('../api.js');
      const cloned = await retryJob(job.id);
      store.dispatch({ type: 'jobs/upsert', job: cloned });
      jobCoordinator.track(cloned);
      showToast(isResume ? 'Resume queued.' : 'Retry queued.');
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
    } catch (err) {
      if (err.name === 'AbortError') return;
      showToast(err.message, 'danger');
    }
  };

  const unsubscribe = store.subscribeSlice('jobs', () => render(store.getState()));
  const unsubscribePlayback = store.subscribeSlice('playback', () => render(store.getState()));
  const unsubscribeHealth = store.subscribeSlice('health', () => render(store.getState()));
  disposers.push(() => {
    unsubscribe();
    unsubscribePlayback();
    unsubscribeHealth();
    if (abortController) abortController.abort();
  });

  // Paint the snapshot already loaded by app boot. If the refresh returns the
  // same data, the slice subscription intentionally will not fire again.
  render(store.getState());
  load();

  return () => {
    for (const dispose of disposers) dispose();
  };
}
