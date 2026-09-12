import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACE_STACK_COPY,
  roleForStemName,
  methodLabel,
  hashShorthand,
  mediaStatusLabel,
  separationOutcome,
} from '../../src/twobecomeone/studio_static/js/stem-crate.js';

test('ffmpeg names stay center/sides and never become vocals', () => {
  assert.equal(roleForStemName('center'), 'other');
  assert.equal(roleForStemName('sides'), 'other');
  assert.equal(roleForStemName('vocals'), 'voice');
  assert.equal(roleForStemName('drums'), 'beat');
  assert.equal(methodLabel('ffmpeg', 'center'), 'ffmpeg center/sides');
  assert.equal(methodLabel('demucs', 'vocals'), 'demucs');
  assert.doesNotMatch(methodLabel('ffmpeg', 'center'), /vocal/i);
});

test('hash shorthand and media status stay honest', () => {
  assert.equal(hashShorthand('sha256:abcdef0123456789'), 'abcdef01');
  assert.equal(mediaStatusLabel({ media_status: 'available', loop_truth: { grid_status: 'ok' } }), 'available');
  assert.equal(mediaStatusLabel({ media_status: 'available', loop_truth: { grid_status: 'stale_revision' } }), 'stale');
  assert.equal(mediaStatusLabel({ media_status: 'unavailable' }), 'unavailable');
});

test('separation outcomes distinguish Demucs, ffmpeg, full track, and jobs', () => {
  assert.equal(
    separationOutcome({ hasTrack: true, variants: [{ name: 'full' }] }).label,
    'Full track available',
  );
  assert.match(
    separationOutcome({
      hasTrack: true,
      variants: [
        { name: 'full' }, { name: 'vocals' }, { name: 'drums' },
        { name: 'bass' }, { name: 'other' },
      ],
    }).label,
    /Demucs four-stem set/,
  );
  const ffmpeg = separationOutcome({
    hasTrack: true,
    variants: [{ name: 'full' }, { name: 'center' }, { name: 'sides' }],
  });
  assert.match(ffmpeg.label, /ffmpeg center\/sides only/);
  assert.doesNotMatch(ffmpeg.label, /vocal/i);
  assert.equal(
    separationOutcome({ jobs: [{ status: 'running', stage: 'separating' }] }).code,
    'separating',
  );
  assert.equal(PLACE_STACK_COPY, 'Stem stack arrives in Phase 14C');
});
