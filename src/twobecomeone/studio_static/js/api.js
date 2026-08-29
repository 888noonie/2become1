// js/api.js — API client and managed job monitoring.
//
// Phase 4.7: JSON request/error-envelope handling, abortable requests, XHR
// upload with real transfer percentage, YouTube job submission, cancel/retry,
// list/detail calls, and a shared job-monitor registry with explicit SSE
// lifecycle (no reliance on EventSource's opaque auto-reconnect).

const BACKOFF = [1000, 2000, 5000, 10000];
const POLL_INTERVAL = 2000;

/** Parse the error envelope into a plain-language message. */
export function errorMessage(body, status) {
  if (body && body.error) {
    return body.error.message || body.error.code || `Request failed (${status})`;
  }
  if (body && body.detail) return String(body.detail);
  return `Request failed (${status})`;
}

/**
 * JSON request with abort support.
 * @param {string} path
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>}
 */
export async function request(path, options = {}) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* empty or non-JSON */
  }
  if (!response.ok) {
    const err = new Error(errorMessage(body, response.status));
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** GET JSON. */
export function get(path, signal) {
  return request(path, { signal });
}

/** POST JSON. */
export function post(path, data, signal) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });
}

/** PATCH JSON. */
export function patch(path, data, signal) {
  return request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });
}

/** DELETE. */
export function del(path, signal) {
  return request(path, { method: 'DELETE', signal });
}

/**
 * Upload a file with XHR so the browser reports real transfer percentage.
 * @param {string} path
 * @param {File} file
 * @param {(percent: number) => void} onProgress
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
export function upload(path, file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'json';

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    if (signal) {
      signal.addEventListener('abort', () => xhr.abort());
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        const err = new Error(errorMessage(xhr.response, xhr.status));
        err.status = xhr.status;
        reject(err);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// Job monitor registry
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'interrupted']);

class JobMonitor {
  constructor(jobId, onClose) {
    this.jobId = jobId;
    this.onClose = onClose;
    this.subscribers = new Set();
    this.source = null;
    this.retryIndex = 0;
    this.retryTimer = null;
    this.pollTimer = null;
    this.closed = false;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify(job) {
    for (const fn of this.subscribers) {
      try { fn(job); } catch (err) { console.error(err); }
    }
  }

  start() {
    this._openSSE();
  }

  _openSSE() {
    if (this.closed) return;
    this.source = new EventSource(`/api/jobs/${this.jobId}/events`);

    this.source.addEventListener('job', (event) => {
      // A successful message resets the backoff.
      this.retryIndex = 0;
      let job;
      try {
        job = JSON.parse(event.data);
      } catch (err) {
        // Malformed payload is a recoverable local error, not a crash.
        console.error('malformed SSE payload', err);
        return;
      }
      this._notify(job);
      if (TERMINAL.has(job.status)) {
        this.close();
      }
    });

    this.source.onerror = () => {
      // Explicitly close so the browser's own reconnect loop does not run
      // alongside our custom backoff (avoids double-polling).
      const failedSource = this.source;
      if (failedSource) failedSource.close();
      if (this.source === failedSource) this.source = null;
      if (this.closed) return;
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this.closed) return;
    const delay = BACKOFF[Math.min(this.retryIndex, BACKOFF.length - 1)];
    this.retryIndex += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      if (this.retryIndex >= BACKOFF.length) {
        // Cap retries; fall back to bounded polling.
        this._startPolling();
      } else {
        this._openSSE();
      }
    }, delay);
  }

  _startPolling() {
    if (this.closed) return;
    const tick = async () => {
      if (this.closed) return;
      try {
        const job = await get(`/api/jobs/${this.jobId}`);
        this._notify(job);
        if (TERMINAL.has(job.status)) {
          this.close();
          return;
        }
      } catch (err) {
        console.error('poll error', err);
      }
      this.pollTimer = setTimeout(tick, POLL_INTERVAL);
    };
    tick();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscribers.clear();
    this.onClose?.(this);
  }
}

const monitors = new Map();

/**
 * Watch a job. Returns an unsubscribe function. Only one monitor (and thus one
 * EventSource) exists per job; multiple subscribers share it.
 * @param {string} jobId
 * @param {(job: object) => void} onUpdate
 * @returns {() => void}
 */
export function watchJob(jobId, onUpdate) {
  let monitor = monitors.get(jobId);
  let shouldStart = false;
  if (!monitor) {
    monitor = new JobMonitor(jobId, (closedMonitor) => {
      if (monitors.get(jobId) === closedMonitor) monitors.delete(jobId);
    });
    monitors.set(jobId, monitor);
    shouldStart = true;
  }
  const unsubscribe = monitor.subscribe(onUpdate);
  if (shouldStart) monitor.start();
  return () => {
    unsubscribe();
    // Close the connection when the last subscriber disposes.
    if (monitor.subscribers.size === 0) {
      monitor.close();
      monitors.delete(jobId);
    }
  };
}

/** Close all monitors (e.g. on app teardown). */
export function closeAllMonitors() {
  for (const monitor of monitors.values()) {
    monitor.close();
  }
  monitors.clear();
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

export function submitYouTube(url) {
  return post('/api/imports/youtube', { url });
}

export function submitUpload(file, onProgress, signal) {
  return upload('/api/imports/upload', file, onProgress, signal);
}

export function cancelJob(jobId) {
  return post(`/api/jobs/${jobId}/cancel`, {});
}

export function retryJob(jobId) {
  return post(`/api/jobs/${jobId}/retry`, {});
}

export function listTracks(params, signal) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', params.limit);
  if (params.offset) qs.set('offset', params.offset);
  if (params.query) qs.set('q', params.query);
  if (params.status) qs.set('status', params.status);
  if (params.sort) qs.set('sort', params.sort);
  if (params.source) qs.set('source', params.source);
  return get(`/api/tracks?${qs.toString()}`, signal);
}

export function listJobs(params, signal) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', params.limit);
  if (params.offset) qs.set('offset', params.offset);
  if (params.status) qs.set('status', params.status);
  if (params.kind) qs.set('kind', params.kind);
  return get(`/api/jobs?${qs.toString()}`, signal);
}

export function getHealth(signal) {
  return get('/api/health', signal);
}

export function getTrack(trackId, signal) {
  return get(`/api/tracks/${trackId}`, signal);
}

export function renameTrack(trackId, displayName) {
  return patch(`/api/tracks/${trackId}`, { display_name: displayName });
}

export function trashTrack(trackId) {
  return del(`/api/tracks/${trackId}`);
}

export function restoreTrack(trackId) {
  return post(`/api/tracks/${trackId}/restore`, {});
}

// ---------------------------------------------------------------------------
// Projects (Phase 5)
// ---------------------------------------------------------------------------

export function listProjects(params = {}, signal) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', params.limit);
  if (params.offset) qs.set('offset', params.offset);
  const suffix = qs.toString();
  return get(`/api/projects${suffix ? `?${suffix}` : ''}`, signal);
}

export function createProject(name, signal) {
  return post('/api/projects', { name }, signal);
}

export function getProject(projectId, signal) {
  return get(`/api/projects/${projectId}`, signal);
}

export function patchProject(projectId, fields, signal) {
  return patch(`/api/projects/${projectId}`, fields, signal);
}

export function deleteProject(projectId, signal) {
  return del(`/api/projects/${projectId}`, signal);
}

// ---------------------------------------------------------------------------
// Separations, stems, and the exact render plan (Phase 5)
// ---------------------------------------------------------------------------

export function submitSeparation(trackId, method = 'auto', signal) {
  return post(`/api/tracks/${trackId}/separations`, { method }, signal);
}

export function listStems(trackId, signal) {
  return get(`/api/tracks/${trackId}/stems`, signal);
}

/** Server-authored stem audio URL; add download=true for an attachment. */
export function stemAudioUrl(stemSetId, name, { download = false } = {}) {
  const qs = new URLSearchParams({ name });
  if (download) qs.set('download', 'true');
  return `/api/stems/${stemSetId}/audio?${qs.toString()}`;
}

export function planRender(fields, signal) {
  return post('/api/renders/plan', fields, signal);
}

/** Queue a preview or full render through the canonical V0.3 endpoint. */
export function submitRender(fields, signal) {
  return post('/api/renders', fields, signal);
}

/** Rename a completed preview/render result; returns the authoritative job. */
export function renameRenderResult(jobId, displayName, signal) {
  return patch(`/api/renders/${jobId}`, { display_name: displayName }, signal);
}

/** Server-authored playback URL for a completed preview/render job. */
export function renderAudioUrl(job) {
  return job?.audio_url || null;
}

/** Server-authored download URL (attachment disposition) for a result. */
export function renderDownloadUrl(job) {
  return job?.download_url || null;
}

export function patchTrack(trackId, fields, signal) {
  return patch(`/api/tracks/${trackId}`, fields, signal);
}

export function updateTrackAnalysis(trackId, overrides, signal) {
  const fields = {};
  if ('bpm' in overrides) fields.bpm = overrides.bpm;
  if ('tonic' in overrides) fields.tonic = overrides.tonic;
  if ('mode' in overrides) fields.mode = overrides.mode;
  if ('first_beat' in overrides) fields.first_beat = overrides.first_beat;
  if ('suggested_downbeat' in overrides) fields.suggested_downbeat = overrides.suggested_downbeat;
  return patchTrack(trackId, fields, signal);
}

export function getTrackWaveform(trackId, signal) {
  return get(`/api/tracks/${trackId}/waveform`, signal);
}

// ---------------------------------------------------------------------------
// V1 Action/lifecycle client (Phase 10B)
// ---------------------------------------------------------------------------

/**
 * POST one V1 Action (preview_layer / commit_layer / reject_proposal).
 * The error envelope's stable code (e.g. S_STEM_UNAVAILABLE) is attached as
 * `err.code` so the Ghost UI can map it to friendly copy.
 */
export function postProjectAction(projectId, action, signal) {
  return post(`/api/projects/${encodeURIComponent(projectId)}/actions`, action, signal).catch(
    (err) => {
      if (err && err.body && err.body.error && err.body.error.code) {
        err.code = err.body.error.code;
      }
      throw err;
    },
  );
}

/**
 * POST one proposal lifecycle fact (scheduled / auditioning bridge).
 * Envelope errors also expose `err.code`.
 */
export function postProposalLifecycle(projectId, proposalId, body, signal) {
  return post(
    `/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/lifecycle`,
    body,
    signal,
  ).catch((err) => {
    if (err && err.body && err.body.error && err.body.error.code) {
      err.code = err.body.error.code;
    }
    throw err;
  });
}

/** GET the finite bootstrap projection for a project (used by tests/hydration seam). */
export function getActionState(projectId, signal) {
  return get(`/api/projects/${encodeURIComponent(projectId)}/action-state`, signal);
}

/**
 * Build the human preview_layer Action envelope with a fresh intent identity.
 * A network retry of the SAME intent must call this once and reuse the same
 * envelope (IDs/keys stay stable per intent), never regenerate it.
 */
export function buildPreviewAction({ region, gainDb, actorId = 'local-human', timestamp = null }) {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    type: 'preview_layer',
    actor: { type: 'human', id: actorId },
    requestedAt: timestamp || new Date().toISOString(),
    idempotencyKey: crypto.randomUUID(),
    payload: {
      source: {
        deck: 'A',
        stem: 'vocal',
        region: {
          id: region.id || crypto.randomUUID(),
          startBeat: region.startBeat,
          endBeat: region.endBeat,
          ...(region.gridRevision ? { gridRevision: region.gridRevision } : {}),
        },
      },
      destination: { deck: 'B' },
      timing: { launch: 'next_phrase', quantize: true },
      gainDb,
    },
  };
}

/** Build the human reject_proposal Action envelope for one proposal. */
export function buildRejectAction(proposalId, reason = null) {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    type: 'reject_proposal',
    actor: { type: 'human', id: 'local-human' },
    requestedAt: new Date().toISOString(),
    idempotencyKey: crypto.randomUUID(),
    payload: {
      proposalId,
      rejectedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    },
  };
}

/** Body for the proposal lifecycle-fact endpoint. */
export function buildLifecycleBody(to, fact = null) {
  return {
    to,
    actor: { type: 'human', id: 'local-human' },
    at: new Date().toISOString(),
    ...(fact && Object.keys(fact).length ? { fact } : {}),
  };
}
