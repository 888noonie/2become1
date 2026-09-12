// js/runtime/crossfader.js — equal-power live crossfader coefficients.
//
// Phase 15B. Pure module: no DOM, Web Audio, or timers. Maps a 0–100
// crossfader position to deck-bus gain multipliers using the standard
// sin/cos equal-power law. Render-plan blend settings remain separate.

/**
 * @param {number} position 0 = hard left (A only), 100 = hard right (B only)
 * @returns {{ gainA: number, gainB: number }}
 */
export function equalPowerGains(position) {
  const clamped = Math.max(0, Math.min(100, Number(position)));
  const angle = (Number.isFinite(clamped) ? clamped : 50) * Math.PI / 200;
  return Object.freeze({
    gainA: Math.cos(angle),
    gainB: Math.sin(angle),
  });
}
