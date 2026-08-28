// tests/frontend/actions/parity.test.js — shared JSON contract vectors prove
// Python/Node parity (Phase 9A). The same file feeds the pytest suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateAction } from '../../../src/twobecomeone/studio_static/js/actions/contracts.js';

const vectorsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'action_contract_vectors.json');

test('shared contract vectors: Node accepts every valid case', () => {
  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
  assert.ok(vectors.valid.length >= 3);
  for (const caseItem of vectors.valid) {
    const result = validateAction(caseItem.action);
    assert.equal(result.ok, true, `${caseItem.name}: ${result.code || ''}`);
  }
});

test('shared contract vectors: Node rejects every invalid case with matching code', () => {
  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
  assert.ok(vectors.invalid.length >= 10);
  for (const caseItem of vectors.invalid) {
    const result = validateAction(caseItem.action);
    assert.equal(result.ok, false, caseItem.name);
    assert.equal(result.code, caseItem.node_code, caseItem.name);
  }
});