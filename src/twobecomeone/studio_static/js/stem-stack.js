// js/stem-stack.js — Phase 14C stack helpers. No DOM, fetch, or StateStore.

import { CRATE_ROLES, LOOP_BARS } from './stem-crate.js';

export function preparedAssetAudioUrl(asset) {
  if (asset?.audioUrl) return asset.audioUrl;
  const id = asset?.id;
  if (!id) return null;
  if (String(id).startsWith('ss-')) return `/api/stem-stack-assets/${encodeURIComponent(id)}/audio`;
  return `/api/ghost-assets/${encodeURIComponent(id)}/audio`;
}

export function crateComponentPayload(item, role) {
  return {
    crateItemId: item.id,
    expected: {
      contentSha256: item.content_sha256,
      gridRevision: item.grid_revision,
      stemName: item.stem_name,
      stemSetId: item.stem_set_id,
    },
    role,
    loopBars: item.loop_bars,
    gainDb: Number.isFinite(item.gain_db) ? item.gain_db : 0,
  };
}

export function destinationBarsFromSlots(slots) {
  const bars = CRATE_ROLES
    .map((role) => slots[role]?.loop_bars)
    .filter((value) => LOOP_BARS.includes(value));
  return bars.length ? Math.max(...bars) : 4;
}

export function feverRecipe(slots) {
  const filled = CRATE_ROLES.filter((role) => slots[role]);
  if (filled.length !== 4) {
    return {
      unlocked: false,
      label: `Fever needs all four roles (${filled.length}/4)`,
    };
  }
  const stale = CRATE_ROLES.some((role) => {
    const item = slots[role];
    return item.media_status !== 'available' || item.loop_truth?.grid_status === 'stale_revision';
  });
  if (stale) {
    return { unlocked: false, label: 'Fever blocked: a slot is stale or unavailable' };
  }
  return {
    unlocked: true,
    label: 'Fever recipe: beat + bass + other + voice',
  };
}

export function stackStateLabel(phase) {
  if (phase === 'preparing') return 'loading';
  if (phase === 'armed') return 'scheduled';
  if (phase === 'auditioning') return 'live';
  if (phase === 'committed') return 'idle';
  if (phase === 'failed') return 'error';
  return phase || 'idle';
}
