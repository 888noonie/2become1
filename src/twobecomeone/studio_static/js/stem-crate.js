// js/stem-crate.js — Phase 14B.3 crate presentation helpers.
// No DOM, fetch, or StateStore. ffmpeg center/sides stay center/sides.

export const PLACE_STACK_COPY = 'Stem stack arrives in Phase 14C';
export const LOOP_BARS = Object.freeze([1, 2, 4, 8]);
export const CRATE_ROLES = Object.freeze(['beat', 'bass', 'other', 'voice']);

export function roleForStemName(name) {
  if (name === 'drums') return 'beat';
  if (name === 'bass') return 'bass';
  if (name === 'vocals') return 'voice';
  return 'other';
}

export function methodLabel(method, stemName) {
  if (method === 'ffmpeg' || stemName === 'center' || stemName === 'sides') {
    return 'ffmpeg center/sides';
  }
  if (method === 'demucs') return 'demucs';
  return method || 'unknown';
}

export function hashShorthand(value) {
  if (!value) return '';
  const hex = String(value).replace(/^sha256:/i, '');
  return hex.slice(0, 8);
}

export function mediaStatusLabel(item) {
  const grid = item?.loop_truth?.grid_status;
  if (item?.media_status === 'stale_hash' || grid === 'stale_revision') return 'stale';
  if (item?.media_status === 'unavailable' || grid === 'missing') return 'unavailable';
  if (item?.loop_truth?.low_confidence) return 'check this';
  return item?.media_status || 'available';
}

export function separationOutcome({ variants = [], jobs = [], hasTrack = false } = {}) {
  const names = new Set((variants || []).map((entry) => entry.name));
  const running = (jobs || []).find((job) => job.status === 'queued' || job.status === 'running');
  if (running) {
    return {
      code: 'separating',
      label: `Separating… ${running.stage || running.status}`,
    };
  }
  const failed = (jobs || []).find((job) => job.status === 'failed' || job.status === 'interrupted');
  const demucs = ['vocals', 'drums', 'bass', 'other'].every((name) => names.has(name));
  const ffmpeg = names.has('center') && names.has('sides');
  if (failed && !demucs && !ffmpeg) {
    return { code: 'error', label: failed.error || failed.message || 'Separation failed' };
  }
  const parts = [];
  if (hasTrack) parts.push('Full track available');
  if (demucs) parts.push('Demucs four-stem set');
  if (ffmpeg) parts.push('ffmpeg center/sides only');
  if (parts.length === 0) {
    return { code: 'empty', label: 'No separated stems yet' };
  }
  return { code: demucs ? 'demucs' : ffmpeg ? 'ffmpeg' : 'full', label: parts.join(' · ') };
}
