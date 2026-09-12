import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('crate panel lists items, disables stack placement, and keeps crate out of the store', async () => {
  const crateItem = {
    id: 'crate-1',
    stem_name: 'center',
    method: 'ffmpeg',
    role: 'other',
    provenance: 'source_track_inherited',
    effective_bpm: 100,
    effective_tonic: 'C',
    effective_mode: 'major',
    analysis_confidence: 0.8,
    content_sha256: 'deadbeefcafebabe',
    source_track_name: 'anchor.wav',
    track_id: 'track-a',
    loop_bars: 4,
    media_status: 'available',
    loop_truth: { grid_status: 'ok', low_confidence: false },
  };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).startsWith('/api/stem-crate') && !options.method) {
      return jsonResponse({ items: [crateItem], total: 1 });
    }
    if (String(url).includes('/stems')) {
      return jsonResponse({
        variants: [
          { name: 'full', stem_set_id: null },
          { name: 'center', stem_set_id: 'set-1', method: 'ffmpeg' },
          { name: 'sides', stem_set_id: 'set-1', method: 'ffmpeg' },
        ],
      });
    }
    if (String(url).startsWith('/api/jobs')) {
      return jsonResponse({ items: [] });
    }
    if (String(url).startsWith('/api/stem-crate/') && options.method === 'PATCH') {
      return jsonResponse({ ...crateItem, loop_bars: 2 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { StateStore, registerReducers } = await import(
    '../../src/twobecomeone/studio_static/js/state.js'
  );
  const store = registerReducers(new StateStore());
  store.dispatch({
    type: 'project/set',
    project: { id: 'p1', name: 'Mix', anchor_track_id: 'track-a', lead_track_id: null, settings: {} },
  });
  const { mountStemCratePanel } = await import(
    '../../src/twobecomeone/studio_static/js/components/stem-crate-panel.js'
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dispose = mountStemCratePanel({ container, store, onAnnounce: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(container.textContent, /ffmpeg center\/sides/);
  assert.doesNotMatch(container.textContent, /vocals/);
  assert.match(container.textContent, /Stem stack arrives in Phase 14C/);
  const place = container.querySelector('.stem-crate__place');
  assert.equal(place.disabled, true);
  assert.equal(store.getState().crate, undefined);
  assert.ok(!JSON.stringify(store.getState()).includes('crate-1'));

  const two = [...container.querySelectorAll('.stem-crate__bars button')]
    .find((button) => button.textContent === '2');
  two.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call.method === 'PATCH' && String(call.body).includes('"loop_bars":2')));
  dispose();
});
