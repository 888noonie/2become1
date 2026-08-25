// js/announce.js — debounced screen-reader announcements.
//
// Phase 4.7: visual progress may update continuously, but screen-reader
// announcements must be debounced — stage/terminal changes announce promptly,
// percentage announcements at most every two seconds or on meaningful
// increments. Uses aria-live="polite".

const MIN_INTERVAL = 2000;

let liveRegion = null;
let lastAnnouncement = '';
let lastAnnounceTime = 0;
let pendingTimer = null;

function getRegion() {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('role', 'status');
    liveRegion.className = 'sr-only';
    document.body.appendChild(liveRegion);
  }
  return liveRegion;
}

/**
 * Announce a message to screen readers, debounced.
 * @param {string} message
 * @param {{important?: boolean}} [opts] - important messages bypass the debounce.
 */
export function announce(message, opts = {}) {
  const now = Date.now();
  const important = opts.important === true;
  const elapsed = now - lastAnnounceTime;

  if (important || elapsed >= MIN_INTERVAL) {
    flush(message);
    return;
  }

  // Debounce: schedule the latest message.
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flush(message);
  }, MIN_INTERVAL - elapsed);
}

/** Announce a job update without flooding assistive technology. */
export function announceJob(job, previous = null) {
  const terminal = ['complete', 'failed', 'cancelled', 'interrupted'].includes(job.status);
  const changedStage = !previous || previous.status !== job.status || previous.stage !== job.stage;
  const percent = job.progress_detail?.percent ?? job.progress;
  const label = job.kind ? `${job.kind} job` : 'Job';
  const status = job.message || job.stage || job.status || 'updated';
  const progress = Number.isFinite(Number(percent)) ? ` ${Math.round(Number(percent))}%` : '';
  announce(`${label}: ${status}${progress}`, { important: terminal || changedStage });
}

function flush(message) {
  const region = getRegion();
  // Force a re-read by clearing then setting.
  region.textContent = '';
  region.textContent = message;
  lastAnnouncement = message;
  lastAnnounceTime = Date.now();
}

export function _resetForTest() {
  liveRegion = null;
  lastAnnouncement = '';
  lastAnnounceTime = 0;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}
