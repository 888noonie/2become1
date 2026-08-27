// render-actions.js — Phase 6 slice A sticky submission and compact results.

import { createElement, replaceChildren } from '../dom.js';
import { formatTime } from '../format.js';
import { buildRenderBody, submitCurrentRender } from '../render.js';
import { cancelJob } from '../api.js';
import { audioController } from '../audio.js';
import { jobCoordinator as globalJobCoordinator } from '../app-context.js';
import { showToast } from './toast.js';
import {
  renderResultActions,
  renderResultSummary,
  resultDisplayName,
} from './render-result.js';

const ACTIVE = new Set(['queued', 'running']);
const STATUS = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/** Deep equality for the nested EQ blobs (fresh objects each build). */
function valuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (
    typeof a === 'object' && a !== null &&
    typeof b === 'object' && b !== null
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => (
      Object.hasOwn(b, key) && valuesEqual(a[key], b[key])
    ));
  }
  return false;
}

/** True only when the plan request exactly represents the current project. */
export function planMatchesProject(plan, project) {
  if (!plan?.data || plan.loading || plan.error || !plan.request) return false;
  let expected;
  try {
    expected = buildRenderBody(project, { preview: false });
  } catch {
    return false;
  }
  const { preview: _preview, ...plannedFields } = expected;
  const requestKeys = Object.keys(plan.request).sort();
  const expectedKeys = Object.keys(plannedFields).sort();
  return (
    requestKeys.length === expectedKeys.length &&
    expectedKeys.every((key, index) => (
      requestKeys[index] === key &&
      Object.hasOwn(plan.request, key) &&
      valuesEqual(plan.request[key], plannedFields[key])
    ))
  );
}

function compactResult(label, job, store, projectManager, jobCoordinator, health) {
  const name = job ? resultDisplayName(job) : `No completed ${label.toLowerCase()} yet`;
  const detail = job
    ? `${STATUS[job.status] || job.status}${job.result?.duration != null ? ` · ${formatTime(job.result.duration)}` : ''}`
    : 'Your latest completed result will stay here.';
  const nodes = [
    createElement('span', { class: 'render-result__label', text: label }),
    createElement('strong', { class: 'render-result__name', text: name }),
    createElement('span', { class: 'render-result__detail', text: detail }),
  ];
  if (job) {
    nodes.push(renderResultSummary(job));
    nodes.push(renderResultActions({
      job, store, projectManager, jobCoordinator, health,
    }));
  }
  return createElement('article', {
    class: 'render-result',
    'aria-label': `Latest completed ${label.toLowerCase()}`,
  }, nodes);
}

export function mountRenderActions({
  container,
  store,
  projectManager,
  jobCoordinator = globalJobCoordinator,
  health = null,
}) {
  const root = createElement('section', {
    class: 'render-actions',
    'aria-label': 'Preview and render',
  });
  container.replaceChildren(root);
  let submitting = false;
  let cancelling = false;
  let actionFeedback = '';

  const submit = async (preview) => {
    if (submitting) return;
    actionFeedback = '';
    submitting = true;
    render(store.getState());
    try {
      const job = await submitCurrentRender({
        store, projectManager, jobCoordinator, preview,
      });
      showToast(
        preview ? 'Preview queued.' : 'Full render queued.',
        'success',
      );
      return job;
    } catch (err) {
      showToast(err.message || 'Render could not be queued.', 'danger');
      return null;
    } finally {
      submitting = false;
      render(store.getState());
    }
  };

  const cancel = async (job) => {
    if (!job || cancelling) return;
    cancelling = true;
    actionFeedback = '';
    render(store.getState());
    try {
      const updated = await cancelJob(job.id);
      jobCoordinator.track(updated);
      actionFeedback = ['cancelled', 'interrupted'].includes(updated.status)
        ? `${updated.kind === 'preview' ? 'Preview' : 'Full render'} ${updated.status}.`
        : 'Cancellation requested. The engine will stop at a safe stage.';
      showToast('Cancellation requested.');
    } catch (err) {
      actionFeedback = `Could not cancel: ${err.message || 'request failed'}`;
      showToast(actionFeedback, 'danger');
    } finally {
      cancelling = false;
      render(store.getState());
    }
  };

  function render(state) {
    const project = state.currentProject;
    const plan = state.plan || {};
    const jobs = state.jobs || { items: [] };
    const currentHealth = health || state.health || null;
    const ready = planMatchesProject(plan, project);
    const active = jobs.items.find(
      (job) => ACTIVE.has(job.status) && (job.kind === 'preview' || job.kind === 'render'),
    ) || null;
    const recent = jobs.items.find(
      (job) => job.kind === 'preview' || job.kind === 'render',
    ) || null;
    const disabled = !ready || Boolean(active) || submitting;
    const statusText = submitting
      ? 'Submitting saved settings…'
      : active
        ? active.cancel_requested
          ? `${active.kind === 'preview' ? 'Preview' : 'Full render'} cancellation requested; stopping safely.`
          : `${active.kind === 'preview' ? 'Preview' : 'Full render'} ${STATUS[active.status]?.toLowerCase() || active.status}.`
        : recent
          ? `${recent.kind === 'preview' ? 'Preview' : 'Full render'} ${STATUS[recent.status]?.toLowerCase() || recent.status}.`
          : ready
            ? 'Arrangement verified and ready.'
            : 'Choose both tracks and wait for a verified plan.';

    const buttonNodes = [
      createElement('button', {
        class: 'button button--primary',
        type: 'button',
        text: 'Preview 12s',
        disabled: disabled ? 'true' : null,
        onclick: () => submit(true),
      }),
      createElement('button', {
        class: 'button',
        type: 'button',
        text: 'Render full mix',
        disabled: disabled ? 'true' : null,
        onclick: () => submit(false),
      }),
    ];
    if (active) {
      const label = `Cancel ${active.kind === 'preview' ? 'preview' : 'full render'}`;
      const cancellationPending = Boolean(active.cancel_requested);
      buttonNodes.push(createElement('button', {
        class: 'button button--danger render-actions__cancel',
        type: 'button',
        text: cancelling
          ? 'Requesting cancellation…'
          : cancellationPending ? 'Cancellation requested…' : label,
        'aria-label': cancellationPending
          ? `Cancellation requested for ${active.kind === 'preview' ? 'preview' : 'full render'}`
          : label,
        disabled: cancelling || cancellationPending ? 'true' : null,
        onclick: () => cancel(active),
      }));
    }
    const buttons = createElement('div', {
      class: `render-actions__buttons${active ? ' render-actions__buttons--active' : ''}`,
    }, buttonNodes);

    replaceChildren(root, [
      createElement('div', { class: 'render-actions__status', role: 'status', 'aria-live': 'polite', text: statusText }),
      actionFeedback
        ? createElement('div', {
            class: 'render-actions__feedback', role: 'status',
            'aria-live': 'polite', text: actionFeedback,
          })
        : null,
      buttons,
      createElement('div', { class: 'render-results' }, [
        compactResult('Preview', jobs.latestPreview, store, projectManager, jobCoordinator, currentHealth),
        compactResult('Full render', jobs.latestRender, store, projectManager, jobCoordinator, currentHealth),
      ]),
    ]);
  }

  const unsubscribeProject = store.subscribeSlice('currentProject', () => render(store.getState()));
  const unsubscribePlan = store.subscribeSlice('plan', () => render(store.getState()));
  const unsubscribeJobs = store.subscribeSlice('jobs', () => render(store.getState()));
  const unsubscribeSave = store.subscribeSlice('save', () => render(store.getState()));
  const unsubscribePlayback = store.subscribeSlice('playback', () => render(store.getState()));
  const unsubscribeHealth = store.subscribeSlice('health', () => render(store.getState()));
  // The Play/Stop UI must be strictly reactive to the singleton controller's
  // own state emissions, so a render started elsewhere (or a track/stem that
  // supersedes it) repaints immediately without local drift.
  const unsubscribeAudio = audioController.on(() => render(store.getState()));
  render(store.getState());

  return () => {
    unsubscribeProject();
    unsubscribePlan();
    unsubscribeJobs();
    unsubscribeSave();
    unsubscribePlayback();
    unsubscribeHealth();
    unsubscribeAudio();
  };
}
