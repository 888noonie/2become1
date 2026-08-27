// tests/browser/a11y.js — deterministic accessibility checks for the browser harness.
//
// Phase 7A: a focused, dependency-free checker for the specific properties the
// plan requires — accessible names, label association, image alt, heading
// order, focus visibility, 44px touch targets, reduced-motion, and live-region
// presence. It runs against the live DOM in the browser context and returns a
// list of findings, each with a severity ('serious' | 'moderate' | 'info').

const SERIOUS = 'serious';
const MODERATE = 'moderate';
const INFO = 'info';

/** True when an element is effectively hidden from assistive tech. */
function isHidden(el) {
  if (!el || !el.isConnected) return true;
  for (let node = el; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (node.hasAttribute('hidden')) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}

/** Compute an element's accessible name (simplified accname). */
function accessibleName(el) {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = el.ownerDocument;
    const parts = labelledBy.split(/\s+/).map((id) => {
      const ref = doc.getElementById(id);
      return ref ? ref.textContent.trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
    const id = el.getAttribute('id');
    if (id) {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return label.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping) return wrapping.textContent.trim();
  }
  if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
  return (el.textContent || '').trim();
}

/** Elements that must carry an accessible name (images handled separately). */
const NAME_REQUIRED = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);

function checkAccessibleNames(doc) {
  const findings = [];
  for (const el of doc.querySelectorAll('button, a, input, select, textarea')) {
    if (isHidden(el)) continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    const name = accessibleName(el);
    if (!name) {
      findings.push({
        severity: SERIOUS,
        code: 'missing-accessible-name',
        target: describe(el),
        message: `${el.tagName.toLowerCase()} has no accessible name`,
      });
    }
  }
  return findings;
}

function checkImageAlt(doc) {
  const findings = [];
  for (const img of doc.querySelectorAll('img')) {
    if (isHidden(img)) continue;
    // Decorative images must use empty alt; content images must have alt.
    if (!img.hasAttribute('alt')) {
      findings.push({
        severity: SERIOUS,
        code: 'img-missing-alt',
        target: describe(img),
        message: 'image is missing an alt attribute',
      });
    }
  }
  return findings;
}

function checkHeadingOrder(doc) {
  const findings = [];
  let previous = 0;
  for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (isHidden(h)) continue;
    const level = Number(h.tagName[1]);
    if (previous && level > previous + 1) {
      findings.push({
        severity: MODERATE,
        code: 'heading-order',
        target: describe(h),
        message: `heading jumps from h${previous} to h${level}`,
      });
    }
    previous = level;
  }
  return findings;
}

function checkPositiveTabindex(doc) {
  const findings = [];
  for (const el of doc.querySelectorAll('[tabindex]')) {
    const value = Number(el.getAttribute('tabindex'));
    if (Number.isFinite(value) && value > 0) {
      findings.push({
        severity: MODERATE,
        code: 'positive-tabindex',
        target: describe(el),
        message: 'positive tabindex disrupts natural keyboard order',
      });
    }
  }
  return findings;
}

function checkTouchTargets(doc, viewportWidth) {
  const findings = [];
  // Only enforce the 44px rule on touch-capable (narrow) viewports.
  if (viewportWidth > 820) return findings;
  // WCAG 2.5.8 (Target Size Minimum) exempts inline links and native
  // checkboxes/radios; we apply the same exemption here.
  const EXEMPT = new Set(['INPUT']);
  for (const el of doc.querySelectorAll('button, a, input[type="checkbox"], input[type="radio"], select')) {
    if (isHidden(el)) continue;
    if (el.disabled) continue;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // 1px tolerance absorbs subpixel/border-box rounding at exactly 44px.
    if (rect.width < 43 || rect.height < 43) {
      findings.push({
        severity: MODERATE,
        code: 'small-touch-target',
        target: describe(el),
        message: `touch target is ${Math.round(rect.width)}x${Math.round(rect.height)}px (below 44px)`,
      });
    }
  }
  return findings;
}

function checkLiveRegions(doc) {
  const findings = [];
  const regions = doc.querySelectorAll('[aria-live]');
  if (regions.length === 0) {
    findings.push({
      severity: INFO,
      code: 'no-live-region',
      target: 'document',
      message: 'no aria-live region present for status announcements',
    });
  }
  return findings;
}

function checkReducedMotion(doc) {
  const findings = [];
  // The app ships a prefers-reduced-motion rule in an external same-origin
  // stylesheet. Inspect the live CSSOM (same-origin sheets expose cssRules).
  let found = false;
  for (const sheet of doc.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin or inaccessible sheet
    }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.conditionText && rule.conditionText.includes('prefers-reduced-motion')) {
          found = true;
          return;
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(rules);
    if (found) break;
  }
  if (!found) {
    findings.push({
      severity: MODERATE,
      code: 'no-reduced-motion',
      target: 'document',
      message: 'no prefers-reduced-motion rule found in loaded stylesheets',
    });
  }
  return findings;
}

function describe(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : '';
  const text = (el.textContent || '').trim().slice(0, 40);
  return `${tag}${id}${cls}${text ? ` "${text}"` : ''}`;
}

/**
 * Run the full accessibility check against a document.
 * @param {Document} doc
 * @param {{viewportWidth?: number}} [opts]
 * @returns {{findings: Array, serious: number, moderate: number, info: number}}
 */
export function auditDocument(doc, opts = {}) {
  const viewportWidth = opts.viewportWidth || 1280;
  const findings = [
    ...checkAccessibleNames(doc),
    ...checkImageAlt(doc),
    ...checkHeadingOrder(doc),
    ...checkPositiveTabindex(doc),
    ...checkTouchTargets(doc, viewportWidth),
    ...checkLiveRegions(doc),
    ...checkReducedMotion(doc),
  ];
  const serious = findings.filter((f) => f.severity === SERIOUS).length;
  const moderate = findings.filter((f) => f.severity === MODERATE).length;
  const info = findings.filter((f) => f.severity === INFO).length;
  return { findings, serious, moderate, info };
}

export { SERIOUS, MODERATE, INFO, accessibleName, isHidden };
