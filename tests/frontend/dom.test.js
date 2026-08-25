// tests/frontend/dom.test.js — DOM-safe construction and forbidden sinks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

test('createElement assigns hostile text via textContent (literal)', async () => {
  const { createElement } = await import('../../src/twobecomeone/studio_static/js/dom.js');
  const hostile = 'Band <3 You <img src=x onerror=alert(1)>';
  const el = createElement('div', { text: hostile });
  assert.equal(el.textContent, hostile);
  // No child element was created from the markup.
  assert.equal(el.children.length, 0);
  assert.equal(el.querySelector('img'), null);
});

test('createElement refuses the "html" attribute', async () => {
  const { createElement } = await import('../../src/twobecomeone/studio_static/js/dom.js');
  assert.throws(() => createElement('div', { html: '<b>x</b>' }), /does not support "html"/);
});

test('createElement builds nested children and attributes', async () => {
  const { createElement } = await import('../../src/twobecomeone/studio_static/js/dom.js');
  const el = createElement('button', { class: 'button', type: 'button', 'aria-label': 'Play' }, [
    createElement('span', { text: '▶' }),
  ]);
  assert.equal(el.className, 'button');
  assert.equal(el.getAttribute('aria-label'), 'Play');
  assert.equal(el.querySelector('span').textContent, '▶');
});

test('replaceChildren clears and repopulates safely', async () => {
  const { createElement, replaceChildren } = await import('../../src/twobecomeone/studio_static/js/dom.js');
  const parent = createElement('div');
  parent.appendChild(createElement('span', { text: 'old' }));
  replaceChildren(parent, [createElement('span', { text: 'new' })]);
  assert.equal(parent.children.length, 1);
  assert.equal(parent.textContent, 'new');
});

test('source scan: no forbidden DOM sinks in frontend modules', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join, extname } = await import('node:path');

  const root = new URL('../../src/twobecomeone/studio_static/js/', import.meta.url).pathname;
  const forbidden = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'];

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(name) === '.js') files.push(full);
    }
  };
  walk(root);

  assert.ok(files.length > 0, 'expected frontend modules to exist');

  for (const file of files) {
    let source = readFileSync(file, 'utf8');
    // Strip comments so docstrings mentioning the sinks don't false-positive.
    source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const sink of forbidden) {
      assert.ok(
        !source.includes(sink),
        `${file} uses forbidden DOM sink: ${sink}`,
      );
    }
  }
});

test('component styles use color tokens instead of literal colors', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../src/twobecomeone/studio_static/styles/', import.meta.url).pathname;
  const literalColor = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.css'))) {
    const source = readFileSync(join(root, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(literalColor.test(source), false, `${name} contains a literal color`);
  }
});
