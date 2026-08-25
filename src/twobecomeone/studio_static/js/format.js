// js/format.js — small formatting helpers (no DOM, no state).

export function formatTime(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(value / 60);
  const secs = String(value % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatKey(track) {
  const key = track.key || {};
  const mode = key.mode === 'major' ? 'maj' : key.mode === 'minor' ? 'min' : '';
  return `${key.tonic || '—'}${mode ? ' ' + mode : ''}`;
}

export function formatBpm(track) {
  const bpm = Number(track.bpm);
  return Number.isFinite(bpm) ? bpm.toFixed(1) : '—';
}

export function sourceLabel(kind) {
  if (kind === 'youtube') return 'YouTube';
  if (kind === 'local') return 'Local';
  return 'Upload';
}
