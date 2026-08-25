// js/dom.js — DOM-safe element construction.
//
// Phase 4.2 security rules are absolute: dynamic/API/user text is assigned via
// textContent, dynamic lists use replaceChildren/fragments/element nodes, and
// no dynamic innerHTML/outerHTML/insertAdjacentHTML/document.write is used.
// This module is the single sanctioned builder.

/**
 * Create an element with attributes and children.
 *
 * @param {string} tag - element tag name.
 * @param {Object} [attributes] - attribute map. `text` sets textContent (safe);
 *   `class` sets className; `dataset` sets data-*; `on*` keys (e.g. `onclick`)
 *   attach listeners; `style` sets inline styles; everything else is set via
 *   setAttribute.
 * @param {Array} [children] - child nodes, strings (assigned as textContent-safe
 *   text nodes), or elements.
 * @returns {HTMLElement}
 */
export function createElement(tag, attributes = {}, children = []) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') {
      el.textContent = value;
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) {
        el.dataset[dk] = dv;
      }
    } else if (key === 'style') {
      for (const [sk, sv] of Object.entries(value)) {
        el.style[sk] = sv;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      const event = key.slice(2).toLowerCase();
      el.addEventListener(event, value);
    } else if (key === 'html') {
      // Explicitly unsupported: refuse to set innerHTML.
      throw new Error('createElement does not support "html"; use textContent or child nodes');
    } else {
      el.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      el.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      throw new Error('createElement child must be a string, number, or Node');
    }
  }

  return el;
}

/**
 * Replace all children of `parent` with `children` (safe list rendering).
 * @param {HTMLElement} parent
 * @param {Array} children
 */
export function replaceChildren(parent, children) {
  parent.replaceChildren(...children);
}

/**
 * Build a DocumentFragment from a list of nodes.
 * @param {Array} children
 * @returns {DocumentFragment}
 */
export function fragment(children) {
  const frag = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    frag.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return frag;
}
