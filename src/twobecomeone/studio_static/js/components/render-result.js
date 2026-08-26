// components/render-result.js — actions and detail for a completed preview/render.
//
// Phase 6: Play/Stop, Download, Rename, Retry/Resume, "Use these settings in a
// new mix", and expandable request/result/error detail. All untrusted text is
// rendered via textContent. Playback goes through the global AudioController
// singleton and the UI is strictly reactive to its state emissions, so
// starting a render resets any previously-playing stem/track (and vice versa).
//
// Rename uses the native <dialog> element (showModal/close) so the browser
// owns focus trapping and Escape routing.

import { createElement, replaceChildren } from '../dom.js';
import { audioController } from '../audio.js';
import { openDialog } from './dialog.js';
import { showToast } from './toast.js';
import { announce } from '../announce.js';
import { formatTime } from '../format.js';
import {
  cancelJob,
  renameRenderResult,
  retryJob,
  renderAudioUrl,
  renderDownloadUrl,
} from '../api.js';

const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'interrupted']);

const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/** True when this job is the one currently playing through the singleton. */
function isPlaying(job, playback) {
  const current = audioController.current;
  if (current && current.jobId && current.jobId === job.id) {
    return audioController.playing;
  }
  return Boolean(
    playback?.playing &&
    playback.source?.jobId &&
    playback.source.jobId === job.id,
  );
}

/** Safe display name for a result, falling back to a kind label. */
export function resultDisplayName(job) {
  if (!job) return '';
  const name = job.result?.display_name;
  if (name) return name;
  return job.kind === 'preview' ? 'Preview result' : 'Render result';
}

/** Build a descriptor for the global AudioController from a completed job. */
export function resultPlaybackDescriptor(job) {
  const url = renderAudioUrl(job);
  if (!url) return null;
  return {
    trackId: null,
    url,
    kind: job.kind === 'preview' ? 'preview' : 'render',
    stemName: null,
    variant: 'full',
    jobId: job.id,
    title: resultDisplayName(job),
  };
}

/**
 * Render the action row for a completed preview/render job.
 * @param {object} opts
 * @param {object} opts.job - the completed job snapshot.
 * @param {object} opts.store - the shared store (for playback state + dispatch).
 * @param {object} opts.projectManager - for "Use these settings in a new mix".
 * @param {object} opts.jobCoordinator - to track a retried/cloned job.
 * @param {object} [opts.health] - health snapshot for reveal instructions.
 * @returns {HTMLElement}
 */
export function renderResultActions({
  job,
  store,
  projectManager,
  jobCoordinator,
  health = null,
}) {
  const actions = createElement('div', { class: 'render-result__actions' });
  if (!job) return actions;

  const playback = store.getState().playback;
  const playing = isPlaying(job, playback);
  const audioUrl = renderAudioUrl(job);
  const downloadUrl = renderDownloadUrl(job);
  const recovery = job.recovery || {};
  const canRetry = recovery.can_retry === true;
  const action = recovery.action || 'retry';

  // Activity history also renders active preview/render jobs. Keep their
  // cancellation path available here rather than relying on the Studio-only
  // sticky action surface.
  if (ACTIVE.has(job.status)) {
    const cancellationPending = Boolean(job.cancel_requested);
    actions.appendChild(createElement('button', {
      class: 'button button--sm button--danger',
      type: 'button',
      text: cancellationPending ? 'Cancellation requested…' : 'Cancel',
      disabled: cancellationPending ? 'true' : null,
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Requesting cancellation…';
        try {
          const updated = await cancelJob(job.id);
          if (jobCoordinator && typeof jobCoordinator.track === 'function') {
            jobCoordinator.track(updated);
          } else {
            store.dispatch({ type: 'jobs/upsert', job: updated });
          }
          showToast('Cancellation requested.');
        } catch (err) {
          button.disabled = false;
          button.textContent = 'Cancel';
          showToast(err.message || 'Could not cancel.', 'danger');
        }
      },
    }));
  }

  // Play/Stop for a completed result with a server-authored audio_url.
  if (job.status === 'complete' && audioUrl) {
    actions.appendChild(createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: playing ? 'Stop' : 'Play',
      'aria-label': `${playing ? 'Stop' : 'Play'} ${resultDisplayName(job)}`,
      onclick: () => {
        if (playing) {
          audioController.stop();
        } else {
          const descriptor = resultPlaybackDescriptor(job);
          if (descriptor) audioController.play(descriptor);
        }
      },
    }));
  }

  // Download uses only the server-authored download_url.
  if (job.status === 'complete' && downloadUrl) {
    actions.appendChild(createElement('a', {
      class: 'button button--sm',
      href: downloadUrl,
      download: job.download_name || '',
      text: 'Download',
    }));
  }

  // Rename a completed result via the native <dialog>.
  if (job.status === 'complete') {
    actions.appendChild(createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Rename',
      onclick: async (event) => {
        const input = createElement('input', {
          class: 'input', type: 'text',
          value: resultDisplayName(job),
          'aria-label': 'Result name', maxLength: '200',
        });
        const value = await openDialog({
          title: 'Rename result',
          body: [input],
          actions: [
            { label: 'Cancel', value: 'cancel' },
            { label: 'Rename', value: 'save', kind: 'primary' },
          ],
          trigger: event.currentTarget,
        });
        if (value !== 'save' || !input.value.trim()) return;
        try {
          const updated = await renameRenderResult(job.id, input.value.trim());
          store.dispatch({ type: 'jobs/upsert', job: updated });
          showToast('Result renamed.', 'success');
          announce('Result renamed.', { important: true });
        } catch (err) {
          showToast(err.message || 'Rename failed.', 'danger');
        }
      },
    }));
  }

  // Retry/Resume for failed/cancelled/interrupted jobs. Resume only when the
  // server says recovery.action === "resume"; otherwise Retry.
  if (canRetry && TERMINAL.has(job.status) && job.status !== 'complete') {
    const isResume = action === 'resume';
    actions.appendChild(createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: isResume ? 'Resume' : 'Retry',
      onclick: async () => {
        try {
          const cloned = await retryJob(job.id);
          store.dispatch({ type: 'jobs/upsert', job: cloned });
          if (jobCoordinator && typeof jobCoordinator.track === 'function') {
            jobCoordinator.track(cloned);
          }
          showToast(isResume ? 'Resume queued.' : 'Retry queued.', 'success');
          announce(isResume ? 'Resume queued.' : 'Retry queued.', { important: true });
        } catch (err) {
          showToast(err.message || 'Could not retry.', 'danger');
        }
      },
    }));
  }

  // "Use these settings in a new mix" for a completed result.
  if (job.status === 'complete' && job.request) {
    actions.appendChild(createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Use these settings in a new mix',
      onclick: async (event) => {
        const btn = event.currentTarget;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Creating mix…';
        try {
          await projectManager.newProjectFromRender(job.request);
          showToast('New mix created from this result.', 'success');
          announce('New mix created from this result.', { important: true });
        } catch (err) {
          showToast(err.message || 'Could not create a new mix.', 'danger');
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      },
    }));
  }

  return actions;
}

/** Render the expandable request/result/error detail for a job. */
export function renderResultDetail(job) {
  const detail = createElement('div', { class: 'render-result__detail' });
  if (!job) return detail;

  const sections = [];

  if (job.request) {
    const requestEl = createElement('div', { class: 'render-result__section' }, [
      createElement('h4', { class: 'render-result__section-title', text: 'Request' }),
      createElement('pre', { class: 'render-result__code', text: JSON.stringify(job.request, null, 2) }),
    ]);
    sections.push(requestEl);
  }

  if (job.result) {
    const resultEl = createElement('div', { class: 'render-result__section' }, [
      createElement('h4', { class: 'render-result__section-title', text: 'Result' }),
      createElement('pre', { class: 'render-result__code', text: JSON.stringify(job.result, null, 2) }),
    ]);
    sections.push(resultEl);
  }

  if (job.error) {
    const errorEl = createElement('div', { class: 'render-result__section' }, [
      createElement('h4', { class: 'render-result__section-title', text: 'Error' }),
      createElement('pre', { class: 'render-result__code render-result__code--error', text: job.error }),
    ]);
    sections.push(errorEl);
  }

  replaceChildren(detail, sections);
  return detail;
}

/** Render the summary metrics for a completed preview/render job. */
export function renderResultSummary(job) {
  const summary = createElement('div', { class: 'render-result__summary' });
  if (!job) return summary;

  const request = job.request || {};
  const result = job.result || {};
  const rows = [];

  const addRow = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    rows.push(createElement('div', { class: 'render-result__row' }, [
      createElement('span', { class: 'render-result__row-label', text: label }),
      createElement('span', { class: 'render-result__row-value', text: String(value) }),
    ]));
  };

  // Foundation and Lead source names from the request metadata.
  const sourceNames = request.source_names || {};
  addRow('Foundation', sourceNames.anchor);
  addRow('Lead', sourceNames.lead);

  // Request fields.
  addRow('Cues', `${request.anchor_start ?? 0}s / ${request.lead_start ?? 0}s`);
  addRow('Duration', request.duration != null ? `${request.duration}s` : 'auto');
  addRow('Gains', `${request.anchor_gain ?? 0.8} / ${request.lead_gain ?? 0.8}`);
  addRow('Variants', `${request.anchor_variant || 'full'} / ${request.lead_variant || 'full'}`);
  addRow('Pitch mode', request.pitch_mode === 'preserve' ? 'Preserve' : 'Match');

  // Output metrics when present.
  if (result.duration != null) addRow('Output duration', formatTime(result.duration));
  if (result.tempo_ratio != null) addRow('Tempo ratio', `${result.tempo_ratio}x`);
  if (result.semitone_shift != null) {
    addRow('Semitone shift', `${result.semitone_shift > 0 ? '+' : ''}${result.semitone_shift}`);
  }
  if (result.true_peak_db != null) addRow('True peak', `${result.true_peak_db} dBFS`);

  replaceChildren(summary, rows);
  return summary;
}

/** Render local reveal instructions using health.data_dir/renders. */
export function renderRevealInstructions(health) {
  const el = createElement('div', { class: 'render-result__reveal' });
  if (!health?.data_dir) {
    el.appendChild(createElement('p', {
      text: 'Open the Engine view to find your local data folder.',
    }));
    return el;
  }
  el.appendChild(createElement('p', {
    text: `Your rendered files are stored locally in the “renders” folder inside: ${health.data_dir}`,
  }));
  return el;
}

export { ACTIVE, STATUS_LABEL };
