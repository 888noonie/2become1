// tests/frontend/static-size.test.js — measured evidence for static asset growth.
//
// This replaces the retired byte ceiling with a recorder, not a gate. It walks
// the Studio static tree and always reports the real size, file count, delta
// against the checked-in baseline and the five largest files.
//
// The 15% / 50,000-byte thresholds are INVESTIGATION TRIGGERS, per the owner's
// 2026-11-17 policy: crossing one is a reason to look at load cost, not an
// automatic release rejection. Set STATIC_GROWTH_ENFORCE=1 (for example in a
// release job) to turn the same thresholds into a failing assertion.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const STATIC_ROOT = path.resolve(REPO_ROOT, 'src', 'twobecomeone', 'studio_static');
const BASELINE_PATH = path.resolve(HERE, 'static-size-baseline.json');

const TRIGGER_GROWTH_PERCENT = 15;
const TRIGGER_GROWTH_BYTES = 50_000;
const ENFORCE = /^(1|true|yes)$/i.test(process.env.STATIC_GROWTH_ENFORCE ?? '');

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push({ path: fullPath, bytes: fs.statSync(fullPath).size });
    }
  }
  return files;
}

function formatPercent(percent) {
  return Number.isFinite(percent) ? percent.toFixed(2) : 'infinite';
}

test('static asset size is measured and growth is reported', () => {
  assert.ok(fs.existsSync(STATIC_ROOT), `missing static root: ${STATIC_ROOT}`);

  const files = walkFiles(STATIC_ROOT);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const fileCount = files.length;

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.equal(typeof baseline.bytes, 'number', 'baseline.bytes must be a number');
  assert.equal(typeof baseline.files, 'number', 'baseline.files must be a number');

  const deltaBytes = totalBytes - baseline.bytes;
  const growthPercent = baseline.bytes > 0 ? (deltaBytes / baseline.bytes) * 100 : 0;
  const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5);

  const exceedsPercent = growthPercent > TRIGGER_GROWTH_PERCENT;
  const exceedsBytes = deltaBytes > TRIGGER_GROWTH_BYTES;
  const triggered = exceedsPercent || exceedsBytes;

  console.log('Static asset size report');
  console.log(`  Root:            ${path.relative(REPO_ROOT, STATIC_ROOT)}`);
  console.log(`  Total bytes:     ${totalBytes}`);
  console.log(`  Files:           ${fileCount}`);
  console.log(`  Baseline bytes:  ${baseline.bytes}`);
  console.log(`  Baseline files:  ${baseline.files}`);
  console.log(`  Delta bytes:     ${deltaBytes}`);
  console.log(`  Growth:          ${formatPercent(growthPercent)}%`);
  console.log(
    `  Triggers:        > ${TRIGGER_GROWTH_PERCENT}% or > ${TRIGGER_GROWTH_BYTES} bytes ` +
      `(investigate; ${ENFORCE ? 'enforced' : 'not enforced'})`,
  );
  console.log('  Five largest files:');
  largest.forEach((file, index) => {
    const relative = path.relative(STATIC_ROOT, file.path);
    console.log(`    ${index + 1}. ${String(file.bytes).padStart(8)} bytes  ${relative}`);
  });
  if (triggered) {
    console.log(
      `  Investigation trigger: +${deltaBytes} bytes (${formatPercent(growthPercent)}%) ` +
        `against baseline ${baseline.bytes} bytes. Record what grew and why.`,
    );
  }

  if (ENFORCE) {
    assert.ok(
      !triggered,
      `static asset growth crossed the enforced trigger: +${deltaBytes} bytes ` +
        `(${formatPercent(growthPercent)}%) against baseline ${baseline.bytes} bytes; ` +
        `thresholds are ${TRIGGER_GROWTH_PERCENT}% and ${TRIGGER_GROWTH_BYTES} bytes`,
    );
  }
});
