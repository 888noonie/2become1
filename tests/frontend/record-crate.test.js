// The Crate adapter consumes the Library catalogue's HTTP shape.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bankStates, createCrateSource, normalizeCrateItem, separateAvailability, stemState, summaryLine,
} from '../../src/twobecomeone/studio_static/js/record-crate.js';

const roles = ['vocals', 'drums', 'bass', 'other'];
const item = (overrides = {}) => normalizeCrateItem({
  track_id: 't1', name: 'Paper Lanterns', duration: 171.2, bpm: 84.3, key: { tonic: 'F', mode: 'major' },
  source: { kind: 'upload' }, stems: { status: 'none', quad: false, roles: [] },
  actions: ['separate'], ...overrides,
});

test('catalogue rows require a Library id and use the Studio artwork route', () => {
  assert.equal(normalizeCrateItem({ name: 'no id' }), null);
  const external = normalizeCrateItem({ track_id: 'abc', artwork_url: 'https://i.ytimg.com/vi/x/hq.jpg' });
  assert.equal(external.artworkUrl, '/api/tracks/abc/artwork');
  assert.equal(item({ stems: { status: 'quad', quad: true, roles: ['vocals'] } }).stems.readiness, 'partial');
});

test('stem labels distinguish imported, center/sides and absent sets', () => {
  assert.equal(stemState(item()).label, 'No stems yet');
  const imported = item({ stems: { status: 'quad', quad: true, method: 'imported', roles } });
  assert.equal(stemState(imported).label, 'Stems ready · Imported 4');
  const split = item({ stems: { status: 'center_sides', method: 'ffmpeg', roles: ['center', 'sides'] } });
  assert.equal(stemState(split).label, 'Center/sides only');
  const incomplete = item({ stems: { status: 'partial', roles: ['vocals', 'bass', 'center', 'sides'] } });
  assert.equal(stemState(incomplete).label, '2 of 4 stems');
});

test('catalogue progress is ignored and a completed job does not supply stems', () => {
  const running = item({ separation: { job_id: 'j', status: 'running', active: true, progress: 41.6 } });
  assert.equal(stemState(running).label, 'Separating');
  assert.equal(stemState(item({ separation: { status: 'complete' } })).code, 'empty');
  const failed = item({ separation: { status: 'failed', error: 'Demucs ran out of memory' } });
  assert.equal(stemState(failed).reason, 'Demucs ran out of memory');
});

test('provenance and the three match classes stay distinct', () => {
  assert.equal(summaryLine(item()), '2:51 · 84.3 BPM · F major · Upload');
  const row = normalizeCrateItem({
    track_id: 't1', source: { kind: 'youtube', video_id: 'abc' },
    duplicates: { exact_content: ['a'], same_source: ['b'], possible_versions: [{ track_id: 'c', name: 'Live' }] },
  });
  assert.equal(summaryLine(row), 'YouTube import');
  assert.equal(row.videoId, 'abc');
  assert.deepEqual(row.duplicates, { exactContent: ['a'], sameSource: ['b'], possibleVersions: [{ track_id: 'c', name: 'Live' }] });
});

test('bank badges: loaded wins over selected, per bank', () => {
  const session = { banks: { A: { selectedTrackId: 't1', loadedTrackId: 't1' }, B: { selectedTrackId: 't1', loadedTrackId: null } } };
  assert.deepEqual(bankStates('t1', session).map((b) => b.label), ['On A', 'Selected for B']);
  assert.deepEqual(bankStates('t2', session), []);
});

test('Separate stems requires catalogue permission and an idle job', () => {
  assert.equal(separateAvailability(item()).enabled, true);
  assert.equal(separateAvailability(item({ actions: ['open'] })).enabled, false);
  assert.equal(separateAvailability(item({ separation: { status: 'queued' } })).enabled, false);
  assert.equal(separateAvailability(item({ separation: { status: 'failed' } })).label, 'Try separation again');
});

test('the source reads only /api/crate, including retries after a 404', async () => {
  const requests = [];
  const source = createCrateSource({
    fetchJson: async (url) => {
      requests.push(url);
      if (requests.length === 1) throw Object.assign(new Error('Catalogue unavailable'), { status: 404 });
      return { items: [{ track_id: 't1', name: 'Paper Lanterns' }], total: 1, limit: 20, offset: 0 };
    },
  });
  await assert.rejects(source.search({ query: ' lanterns ' }), /Catalogue unavailable/);
  const page = await source.search({ query: ' lanterns ' });
  assert.deepEqual(requests, Array(2).fill('/api/crate?limit=20&offset=0&sort=name&q=lanterns'));
  assert.equal(page.items[0].trackId, 't1');
});

test('an authoritative quad appears ready even when an old job failed', () => {
  const ready = item({
    source: { kind: 'local' },
    stems: { status: 'quad', quad: true, roles: ['vocals', 'drums', 'bass', 'other'], method: 'demucs' },
    separation: { status: 'failed' },
    actions: ['choose_A', 'choose_B'],
  });
  assert.equal(stemState(ready).label, 'Stems ready · Demucs 4');
  assert.equal(ready.sourceKind, 'local');
  assert.equal(separateAvailability(ready).enabled, false);
});

test('a partial set with all roles across different sets cannot appear ready', () => {
  const partial = item({
    stems: { status: 'partial', quad: false, roles: ['vocals', 'drums', 'bass', 'other'], readiness: 'ready' },
    separation: { status: 'complete' },
    actions: ['choose_A', 'separate'],
  });
  assert.deepEqual(stemState(partial), { code: 'partial', label: 'Partial stem set' });
  assert.equal(separateAvailability(partial).enabled, true);
});
