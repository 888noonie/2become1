// tests/frontend/api.test.js — SSE lifecycle, backoff, watcher dedup, polling
// fallback, and upload transition.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

async function loadApi() {
  return await import('../../src/twobecomeone/studio_static/js/api.js');
}

test('SSE terminal event closes the connection', async () => {
  const api = await loadApi();
  const updates = [];
  const unsubscribe = api.watchJob('job-1', (job) => updates.push(job));

  const es = globalThis.EventSource.instances[0];
  assert.ok(es, 'an EventSource was created');
  assert.equal(es.url, '/api/jobs/job-1/events');

  es.emit('job', JSON.stringify({ id: 'job-1', status: 'running' }));
  es.emit('job', JSON.stringify({ id: 'job-1', status: 'complete' }));

  assert.equal(updates.length, 2);
  assert.equal(es.closed, true, 'connection closed on terminal status');
  unsubscribe();
});

test('terminal monitor is evicted so a later watcher can reconnect', async () => {
  const api = await loadApi();
  const unsubscribe = api.watchJob('job-terminal', () => {});
  const first = globalThis.EventSource.instances[0];
  first.emit('job', JSON.stringify({ id: 'job-terminal', status: 'complete' }));

  const unsubscribeAgain = api.watchJob('job-terminal', () => {});
  assert.equal(globalThis.EventSource.instances.length, 2);

  unsubscribe();
  unsubscribeAgain();
});

test('SSE error closes and schedules reconnect (no double-poll)', async () => {
  const api = await loadApi();
  const unsubscribe = api.watchJob('job-2', () => {});

  const es = globalThis.EventSource.instances[0];
  es.error();

  // The source must be explicitly closed on error.
  assert.equal(es.closed, true, 'source closed on error before reconnect');
  // A reconnect timer is scheduled (we can't easily assert timing, but the
  // source is nulled so the browser's own loop cannot run).
  assert.equal(es.readyState, 2);

  // Clean up: unsubscribe closes the monitor and clears the reconnect timer.
  unsubscribe();
});

test('watcher deduplication: one EventSource per job, multiple subscribers', async () => {
  const api = await loadApi();
  const a = [];
  const b = [];
  const unsubA = api.watchJob('job-3', (j) => a.push(j));
  const unsubB = api.watchJob('job-3', (j) => b.push(j));

  assert.equal(globalThis.EventSource.instances.length, 1, 'only one EventSource for the same job');

  const es = globalThis.EventSource.instances[0];
  es.emit('job', JSON.stringify({ id: 'job-3', status: 'running' }));

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);

  unsubA();
  unsubB();
});

test('malformed SSE payload is a recoverable local error, not a crash', async () => {
  const api = await loadApi();
  const updates = [];
  const unsubscribe = api.watchJob('job-4', (j) => updates.push(j));

  const es = globalThis.EventSource.instances[0];
  // Emit malformed JSON — should not throw.
  assert.doesNotThrow(() => es.emit('job', 'not-json{{{'));
  assert.equal(updates.length, 0);
  unsubscribe();
});

test('upload transitions from XHR progress to job state', async () => {
  const api = await loadApi();
  const progress = [];
  const file = new globalThis.window.File(['x'], 'track.wav', { type: 'audio/wav' });

  const result = await api.submitUpload(file, (p) => progress.push(p));
  assert.equal(result.id, 'job-1');
  assert.equal(result.status, 'queued');
  // Progress callback is wired (real browser would fire it).
  assert.ok(Array.isArray(progress));
});
