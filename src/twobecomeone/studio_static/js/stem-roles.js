// js/stem-roles.js — OPERATION STUDIO SURGEON: one patchbay identity per role.
//
// Drums, Bass, Vocals and Other each have ONE colour token (studio.css
// `--color-role-*`), ONE glyph and ONE short signature word, used the same way
// in the Library, the Crate, Arrangement clips and Stem-Focus. Colour is never
// the only cue: the glyph and the written role go with it. Center and sides
// are a channel split, not instruments, so they get a neutral split glyph;
// anything else gets a neutral "unknown" glyph. A glyph is a fixed icon. It is
// never drawn from, or presented as, the stem's audio.

import { createElement } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const ROLE_TOKENS = Object.freeze({
  drums: Object.freeze({ token: 'drums', label: 'Drums', glyph: 'step-grid', signature: 'step grid' }),
  bass: Object.freeze({ token: 'bass', label: 'Bass', glyph: 'low-slab', signature: 'low slab' }),
  vocals: Object.freeze({ token: 'vocals', label: 'Vocals', glyph: 'diamond', signature: 'diamond' }),
  other: Object.freeze({ token: 'other', label: 'Other', glyph: 'harmonic-rings', signature: 'harmonic rings' }),
  center: Object.freeze({ token: 'split', label: 'Center', glyph: 'split-center', signature: 'channel split', neutral: true }),
  sides: Object.freeze({ token: 'split', label: 'Sides', glyph: 'split-sides', signature: 'channel split', neutral: true }),
});

const UNKNOWN = Object.freeze({ token: 'unknown', label: 'Unknown role', glyph: 'unknown', signature: 'unknown role', neutral: true });

/** The identity for a role token; unknown roles get the neutral one. */
export function roleToken(role) {
  return ROLE_TOKENS[role] ?? UNKNOWN;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const SHAPES = {
  // Four steps of a sequencer row, two lit.
  'step-grid': () => [
    svgEl('rect', { x: 1.5, y: 1.5, width: 5.5, height: 5.5, rx: 1, fill: 'currentColor' }),
    svgEl('rect', { x: 9, y: 1.5, width: 5.5, height: 5.5, rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
    svgEl('rect', { x: 1.5, y: 9, width: 5.5, height: 5.5, rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
    svgEl('rect', { x: 9, y: 9, width: 5.5, height: 5.5, rx: 1, fill: 'currentColor' }),
  ],
  // A wide, low block: weight at the bottom.
  'low-slab': () => [
    svgEl('rect', { x: 1, y: 8.5, width: 14, height: 6, rx: 1.5, fill: 'currentColor' }),
    svgEl('line', { x1: 3, y1: 5, x2: 13, y2: 5, stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
  ],
  diamond: () => [
    svgEl('polygon', { points: '8,1 15,8 8,15 1,8', fill: 'currentColor' }),
  ],
  'harmonic-rings': () => [
    svgEl('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
    svgEl('circle', { cx: 8, cy: 8, r: 3.8, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
    svgEl('circle', { cx: 8, cy: 8, r: 1.4, fill: 'currentColor' }),
  ],
  // Channel split: the middle (center) or the two edges (sides) of a circle.
  'split-center': () => [
    svgEl('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
    svgEl('rect', { x: 6, y: 2, width: 4, height: 12, fill: 'currentColor' }),
  ],
  'split-sides': () => [
    svgEl('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
    svgEl('path', { d: 'M5 2.6 A6.5 6.5 0 0 0 5 13.4 Z', fill: 'currentColor' }),
    svgEl('path', { d: 'M11 2.6 A6.5 6.5 0 0 1 11 13.4 Z', fill: 'currentColor' }),
  ],
  unknown: () => [
    svgEl('circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-dasharray': '2.5 2' }),
  ],
};

/** The role's glyph as an inline SVG (decorative: the role is always written next to it). */
export function roleGlyph(role, { size = 16, className = '' } = {}) {
  const t = roleToken(role);
  const svg = svgEl('svg', {
    viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
    class: `role-glyph role-glyph--${t.glyph}${className ? ` ${className}` : ''}`,
  });
  for (const node of SHAPES[t.glyph]()) svg.appendChild(node);
  return svg;
}

/**
 * A small role chip: glyph + written role. `text` overrides the label (for
 * example "Center (channel split)").
 */
export function roleChip(role, { text = null, className = '' } = {}) {
  const t = roleToken(role);
  return createElement('span', {
    class: `role-chip${className ? ` ${className}` : ''}`,
    dataset: { roleToken: t.token },
  }, [roleGlyph(role, { size: 14 }), createElement('span', { class: 'role-chip__text', text: text ?? (ROLE_TOKENS[role] ? t.label : String(role || t.label)) })]);
}
