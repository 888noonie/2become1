// render.js — strict RenderBody construction and save-before-submit flow.

import { submitRender } from './api.js';

const VARIANTS = new Set([
  'full', 'vocals', 'drums', 'bass', 'other', 'center', 'sides',
]);
const PITCH_MODES = new Set(['match', 'preserve']);
const TEMPO_MODES = new Set(['foundation', 'lead', 'custom']);
const ARRANGEMENT_MODES = new Set(['overlay', 'transition']);
const CURVES = new Set(['equal_power', 'linear']);
const EQ_BANDS = ['low', 'mid', 'high'];

function finiteNumber(value, fallback, label, { min = -Infinity, max = Infinity } = {}) {
  const number = value == null ? fallback : value;
  if (typeof number !== 'number') {
    throw new Error(`${label} is invalid; save a valid project value before rendering.`);
  }
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} is invalid; save a valid project value before rendering.`);
  }
  return number;
}

function validEq(value) {
  if (value == null) return { low: 0, mid: 0, high: 0 };
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== EQ_BANDS.length ||
    !EQ_BANDS.every((band) => Object.hasOwn(value, band))
  ) {
    throw new Error('EQ settings are invalid; save a valid project value before rendering.');
  }
  const out = {};
  for (const band of EQ_BANDS) {
    const v = value[band];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -12 || v > 12) {
      throw new Error('EQ settings are invalid; save a valid project value before rendering.');
    }
    out[band] = v;
  }
  return out;
}

/**
 * Build the exact backend RenderBody allowlist from persisted project truth.
 * UI-only settings such as `snap` and every unknown field are intentionally
 * omitted. Preview duration is always positive and at most twelve seconds.
 */
export function buildRenderBody(project, { preview = false } = {}) {
  if (
    typeof project?.anchor_track_id !== 'string' || !project.anchor_track_id.trim() ||
    typeof project?.lead_track_id !== 'string' || !project.lead_track_id.trim()
  ) {
    throw new Error('Choose both Foundation and Lead tracks before rendering.');
  }
  const settings = project.settings || {};
  const configuredDuration = settings.duration == null
    ? null
    : finiteNumber(settings.duration, null, 'Duration', { min: Number.EPSILON, max: 3600 });
  const anchorVariant = project.anchor_variant || 'full';
  const leadVariant = project.lead_variant || 'full';
  const pitchMode = settings.pitch_mode || 'match';
  const tempoMode = settings.tempo_mode || 'foundation';
  const arrangementMode = settings.arrangement_mode || 'overlay';
  const curve = settings.crossfade_curve || 'equal_power';
  if (!VARIANTS.has(anchorVariant) || !VARIANTS.has(leadVariant)) {
    throw new Error('The selected source variant is invalid; choose it again.');
  }
  if (!PITCH_MODES.has(pitchMode)) {
    throw new Error('The saved pitch mode is invalid; choose it again.');
  }
  if (!TEMPO_MODES.has(tempoMode)) {
    throw new Error('The saved output BPM mode is invalid; choose it again.');
  }
  if (!ARRANGEMENT_MODES.has(arrangementMode)) {
    throw new Error('The saved arrangement mode is invalid; choose it again.');
  }
  if (!CURVES.has(curve)) {
    throw new Error('The saved crossfade curve is invalid; choose it again.');
  }

  const targetBpm = tempoMode === 'custom'
    ? finiteNumber(settings.target_bpm, null, 'Target BPM', { min: 20, max: 400 })
    : null;

  return {
    // Phase 11: scope committed layers to the authoritative project
    // projection. The client still supplies no layer identities or paths.
    project_id: typeof project.id === 'string' && project.id.trim() ? project.id : null,
    anchor_id: project.anchor_track_id,
    lead_id: project.lead_track_id,
    anchor_start: finiteNumber(settings.anchor_start, 0, 'Foundation cue', { min: 0 }),
    lead_start: finiteNumber(settings.lead_start, 0, 'Lead cue', { min: 0 }),
    duration: preview ? Math.min(configuredDuration ?? 12, 12) : configuredDuration,
    anchor_gain: finiteNumber(settings.anchor_gain, 0.8, 'Foundation gain', { min: 0, max: 2 }),
    lead_gain: finiteNumber(settings.lead_gain, 0.8, 'Lead gain', { min: 0, max: 2 }),
    preview: Boolean(preview),
    anchor_variant: anchorVariant,
    lead_variant: leadVariant,
    pitch_mode: pitchMode,
    tempo_mode: tempoMode,
    target_bpm: targetBpm,
    arrangement_mode: arrangementMode,
    transition_start: finiteNumber(settings.transition_start, 0, 'Transition start', { min: 0 }),
    crossfade_duration: finiteNumber(settings.crossfade_duration, 0, 'Crossfade duration', { min: 0, max: 30 }),
    crossfade_curve: curve,
    anchor_pan: finiteNumber(settings.anchor_pan, 0, 'Foundation pan', { min: -1, max: 1 }),
    lead_pan: finiteNumber(settings.lead_pan, 0, 'Lead pan', { min: -1, max: 1 }),
    anchor_eq: validEq(settings.anchor_eq),
    lead_eq: validEq(settings.lead_eq),
  };
}

/** Flush serialized autosave, submit the authoritative project, and track it. */
export async function submitCurrentRender({
  store,
  projectManager,
  jobCoordinator,
  preview = false,
}) {
  const flushed = await projectManager.flushNow();
  const afterFlush = store.getState();
  if (
    !flushed ||
    afterFlush.save.status === 'error' ||
    afterFlush.save.status === 'saving'
  ) {
    throw new Error(
      afterFlush.save.lastError
      || 'Project settings are not saved yet. Retry the save before rendering.',
    );
  }
  const body = buildRenderBody(afterFlush.currentProject, { preview });
  const job = await submitRender(body);
  jobCoordinator.track(job);
  return job;
}
