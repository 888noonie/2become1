// render.js — strict RenderBody construction and save-before-submit flow.

import { submitRender } from './api.js';

const VARIANTS = new Set([
  'full', 'vocals', 'drums', 'bass', 'other', 'center', 'sides',
]);
const PITCH_MODES = new Set(['match', 'preserve']);

function finiteNumber(value, fallback, label, { min = -Infinity, max = Infinity } = {}) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} is invalid; save a valid project value before rendering.`);
  }
  return number;
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
  if (!VARIANTS.has(anchorVariant) || !VARIANTS.has(leadVariant)) {
    throw new Error('The selected source variant is invalid; choose it again.');
  }
  if (!PITCH_MODES.has(pitchMode)) {
    throw new Error('The saved pitch mode is invalid; choose it again.');
  }

  return {
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
