import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crateComponentPayload,
  destinationBarsFromSlots,
  feverRecipe,
  preparedAssetAudioUrl,
} from '../../src/twobecomeone/studio_static/js/stem-stack.js';
import { validateAction, ACTION_TYPES } from '../../src/twobecomeone/studio_static/js/actions/contracts.js';
import { ERROR_CODES } from '../../src/twobecomeone/studio_static/js/actions/errors.js';
import { checkPermission } from '../../src/twobecomeone/studio_static/js/actions/permission.js';

const component = crateComponentPayload({
  id: 'crate-1',
  content_sha256: 'sha256:aaa',
  grid_revision: 'grid-v1:' + 'a'.repeat(64),
  stem_name: 'vocals',
  stem_set_id: 'set-1',
  loop_bars: 4,
  gain_db: -3,
}, 'voice');

function stackAction(overrides = {}) {
  return {
    id: 's-1',
    schemaVersion: 1,
    type: ACTION_TYPES.PREVIEW_STEM_STACK,
    actor: { type: 'human', id: 'richard' },
    requestedAt: 't',
    idempotencyKey: 'k',
    payload: {
      components: [component],
      destinationBars: 4,
      timing: { launch: 'next_phrase', quantize: true },
      ...overrides,
    },
  };
}

test('prepared stack URLs never use the ghost audio route', () => {
  assert.equal(
    preparedAssetAudioUrl({ id: 'ss-' + 'a'.repeat(32) }),
    `/api/stem-stack-assets/ss-${'a'.repeat(32)}/audio`,
  );
  assert.match(preparedAssetAudioUrl({ id: 'ga-' + 'b'.repeat(32) }), /\/api\/ghost-assets\//);
});

test('fever recipe is inspectable and needs four available roles', () => {
  const empty = feverRecipe({ beat: null, bass: null, other: null, voice: null });
  assert.equal(empty.unlocked, false);
  const item = { media_status: 'available', loop_truth: { grid_status: 'ok' } };
  const ready = feverRecipe({ beat: item, bass: item, other: item, voice: item });
  assert.equal(ready.unlocked, true);
  assert.match(ready.label, /beat \+ bass \+ other \+ voice/);
  const dest = destinationBarsFromSlots({
    beat: { loop_bars: 2 }, bass: { loop_bars: 8 }, other: null, voice: null,
  });
  assert.equal(dest, 8);
});

test('Node accepts a valid preview_stem_stack and rejects five components', () => {
  const ok = validateAction(stackAction());
  assert.equal(ok.ok, true);
  const five = stackAction({
    components: [1, 2, 3, 4, 5].map((i) => ({
      ...component,
      crateItemId: `c${i}`,
      role: i === 5 ? 'voice' : ['beat', 'bass', 'other', 'voice'][i - 1],
    })),
  });
  const bad = validateAction(five);
  assert.equal(bad.ok, false);
  assert.ok([
    ERROR_CODES.V_INVALID_COMPONENT_COUNT,
    ERROR_CODES.V_DUPLICATE_ROLE,
  ].includes(bad.code));
});

test('producer cannot preview or commit a stem stack', () => {
  const preview = checkPermission({
    ...stackAction(),
    actor: { type: 'producer', id: 'bot' },
  }, {});
  assert.equal(preview.ok, false);
  assert.equal(preview.code, ERROR_CODES.P_PRODUCER_PREVIEW_DENIED);
  const commit = checkPermission({
    id: 'c-1',
    schemaVersion: 1,
    type: ACTION_TYPES.COMMIT_STEM_STACK,
    actor: { type: 'producer', id: 'bot' },
    requestedAt: 't',
    idempotencyKey: 'k',
    payload: {
      proposalId: 's-1',
      acceptedAt: 't',
      acceptedAsset: { id: 'ss-1', contentHash: 'h', transformSpec: {} },
    },
  }, {});
  assert.equal(commit.ok, false);
  assert.equal(commit.code, ERROR_CODES.P_ACTOR_NOT_ALLOWED);
});
