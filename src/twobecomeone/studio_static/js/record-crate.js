// js/record-crate.js — The Crate (record-crate): data contract and labels.
//
// Translate the read-only Library projection once. Bank state and live job
// updates come from the existing desk bridge, outside the catalogue adapter.
// OPERATION OPEN THE RECORD SLEEVES: an item keeps the search's `match`
// (matching stems under their recording); a row is still one result.

import { stemMatch } from './stem-sleeve.js';

export const CRATE_PAGE_SIZE = 20;
const QUAD_ROLES = ['vocals', 'drums', 'bass', 'other'];
const STEM_ROLES = new Set([...QUAD_ROLES, 'center', 'sides']);
const ACTIVE_JOB = new Set(['queued', 'running']);
const ENDED_JOB = new Set(['failed', 'interrupted', 'cancelled']);
const SOURCE_LABELS = Object.freeze({ upload: 'Upload', local: 'Local file', youtube: 'YouTube import' });

function finiteOrNull(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

const strings = (values) => Array.isArray(values)
  ? [...new Set(values.filter((value) => typeof value === 'string' && value))]
  : [];

/** Adapt one GET /api/crate item. Never infer a quad from jobs or role counts. */
export function normalizeCrateItem(raw) {
  const trackId = raw?.track_id;
  if (typeof trackId !== 'string' || !trackId) return null;
  const stems = raw.stems || {};
  const roles = strings(stems.roles).filter((name) => STEM_ROLES.has(name));
  let readiness = 'none';
  if (stems.status === 'quad' && stems.quad === true && QUAD_ROLES.every((name) => roles.includes(name))) {
    readiness = 'ready';
  } else if (stems.status === 'center_sides' && roles.includes('center') && roles.includes('sides')) {
    readiness = 'center_sides';
  } else if (roles.length && ['quad', 'center_sides', 'partial'].includes(stems.status)) {
    readiness = 'partial';
  }
  const key = raw.key?.tonic
    ? { tonic: raw.key.tonic, mode: raw.key.mode ?? null }
    : null;
  const sep = raw.separation;
  const duplicates = raw.duplicates;
  const possibleVersions = Array.isArray(duplicates?.possible_versions)
    ? duplicates.possible_versions.filter((version) => typeof version?.track_id === 'string')
    : [];
  return {
    trackId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : trackId,
    artworkUrl: `/api/tracks/${encodeURIComponent(trackId)}/artwork`,
    duration: finiteOrNull(raw.duration),
    bpm: finiteOrNull(raw.bpm),
    key,
    sourceKind: raw.source?.kind ?? null,
    videoId: raw.source?.video_id ?? null,
    stems: {
      readiness,
      method: stems.method ?? null,
      roles,
      modelName: stems.model_name ?? null,
    },
    separation: sep && typeof sep.status === 'string'
      ? { jobId: sep.job_id ?? null, status: sep.status, progress: null, error: sep.error ?? null }
      : null,
    duplicates: {
      exactContent: strings(duplicates?.exact_content),
      sameSource: strings(duplicates?.same_source),
      possibleVersions,
    },
    actions: strings(raw.actions),
    match: stemMatch(raw.match, {
      trackId, trackName: typeof raw.name === 'string' && raw.name.trim() ? raw.name : trackId,
    }),
  };
}

export function normalizeCratePage(page, { limit = CRATE_PAGE_SIZE, offset = 0 } = {}) {
  const items = (Array.isArray(page?.items) ? page.items : []).map(normalizeCrateItem).filter(Boolean);
  const total = finiteOrNull(page?.total);
  return {
    items,
    total: total ?? items.length,
    limit: finiteOrNull(page?.limit) ?? limit,
    offset: finiteOrNull(page?.offset) ?? offset,
  };
}

export function formatDuration(seconds) {
  if (seconds == null || !(seconds >= 0)) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function formatKey(key) {
  if (!key?.tonic) return null;
  if (key.mode === 'major') return `${key.tonic} major`;
  if (key.mode === 'minor') return `${key.tonic} minor`;
  return key.tonic;
}

export function sourceLabel(kind) {
  return SOURCE_LABELS[kind] || (kind ? kind : 'Source not recorded');
}

/** The one-line summary under a title: only facts the Library has. */
export function summaryLine(item) {
  return [
    formatDuration(item.duration),
    item.bpm != null ? `${Number(item.bpm.toFixed(1))} BPM` : null,
    formatKey(item.key),
    sourceLabel(item.sourceKind),
  ].filter(Boolean).join(' · ');
}

function readyLabel(stems) {
  if (stems.method === 'demucs') return 'Stems ready · Demucs 4';
  if (stems.method === 'imported') return 'Stems ready · Imported 4';
  return 'Stems ready · 4 isolated';
}

export function separationActive(item) {
  return ACTIVE_JOB.has(item.separation?.status);
}

/** A finished job never supplies readiness. */
export function stemState(item) {
  const { separation: sep, stems } = item;
  if (stems.readiness === 'ready') return { code: 'ready', label: readyLabel(stems) };
  if (separationActive(item)) {
    const pct = Number.isFinite(sep.progress) && sep.progress >= 0 && sep.progress <= 100
      ? ` ${Math.round(sep.progress)}%` : '';
    return { code: 'separating', label: sep.status === 'queued' ? 'Separation queued' : `Separating${pct}` };
  }
  if (ENDED_JOB.has(sep?.status)) {
    return { code: 'failed', label: sep.status === 'cancelled' ? 'Separation cancelled' : 'Separation failed', reason: sep.error };
  }
  if (stems.readiness === 'center_sides') return { code: 'center_sides', label: 'Center/sides only' };
  if (stems.readiness === 'partial') {
    const isolated = QUAD_ROLES.filter((name) => stems.roles.includes(name)).length;
    return { code: 'partial', label: isolated > 0 && isolated < 4 ? `${isolated} of 4 stems` : 'Partial stem set' };
  }
  return { code: 'empty', label: 'No stems yet' };
}

/** Bank badges from the desk session: loaded wins over merely selected. */
export function bankStates(trackId, session) {
  const out = [];
  for (const groupId of ['A', 'B']) {
    const bank = session?.banks?.[groupId];
    if (!bank) continue;
    if (bank.loadedTrackId === trackId) out.push({ groupId, code: 'loaded', label: `On ${groupId}` });
    else if (bank.selectedTrackId === trackId) out.push({ groupId, code: 'selected', label: `Selected for ${groupId}` });
  }
  return out;
}

/** Stage 1 offers a subset of the actions permitted by the catalogue. */
export function separateAvailability(item) {
  if (separationActive(item)) return { enabled: false, label: 'Separating…', reason: 'A separation job is already running for this track.' };
  const label = stemState(item).code === 'failed' ? 'Try separation again' : 'Separate stems';
  if (item.stems.readiness === 'ready') {
    return { enabled: false, label, reason: 'Four isolated stems already exist.' };
  }
  const enabled = item.actions.includes('separate');
  return { enabled, label, reason: enabled ? null : 'Separation is unavailable for this track.' };
}

export function createCrateSource({ fetchJson, patchJson = null } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('createCrateSource requires fetchJson');
  return {
    fetchJson,
    patchJson,
    /** The validated stems of one recording (GET /api/tracks/{id}/stems). */
    listStems(trackId, signal) {
      return fetchJson(`/api/tracks/${encodeURIComponent(trackId)}/stems`, signal);
    },
    async search({ query = '', limit = CRATE_PAGE_SIZE, offset = 0, signal } = {}) {
      const qs = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: 'name' });
      if (query.trim()) qs.set('q', query.trim());
      return normalizeCratePage(await fetchJson(`/api/crate?${qs}`, signal), { limit, offset });
    },
  };
}
