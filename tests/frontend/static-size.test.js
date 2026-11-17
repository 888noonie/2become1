// tests/frontend/static-size.test.js — measured evidence for static asset growth.
//
// This replaces a retired byte ceiling with an explicit, reviewable budget:
// the recorder walks the Studio static tree, reports its real size, and fails
// only when growth exceeds either threshold against the checked-in baseline.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const STATIC_ROOT = path.resolve(REPO_ROOT, 'src', 'twobecomeone', 'studio_static');
const BASELINE_PATH = path.resolve(HERE, 'static-size-baseline.json');

const MAX_GROWTH_PERCENT = 15;
const MAX_GROWTH_BYTES = 50_000;

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

test('static asset growth stays within the measured budget', () => {
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

  console.log('Static asset size report');
  console.log(`  Root:            ${path.relative(REPO_ROOT, STATIC_ROOT)}`);
  console.log(`  Total bytes:     ${totalBytes}`);
  console.log(`  Files:           ${fileCount}`);
  console.log(`  Baseline bytes:  ${baseline.bytes}`);
  console.log(`  Baseline files:  ${baseline.files}`);
  console.log(`  Delta bytes:     ${deltaBytes}`);
  console.log(`  Growth:          ${formatPercent(growthPercent)}%`);
  console.log(`  Limit:           > ${MAX_GROWTH_PERCENT}% or > ${MAX_GROWTH_BYTES} bytes fails`);
  console.log('  Five largest files:');
  largest.forEach((file, index) => {
    const relative = path.relative(STATIC_ROOT, file.path);
    console.log(`    ${index + 1}. ${String(file.bytes).padStart(8)} bytes  ${relative}`);
  });

  const exceedsPercent = growthPercent > MAX_GROWTH_PERCENT;
  const exceedsBytes = deltaBytes > MAX_GROWTH_BYTES;

  assert.ok(
    !exceedsPercent && !exceedsBytes,
    `static asset growth exceeded budget: +${deltaBytes} bytes (${formatPercent(growthPercent)}%) ` +
      `against baseline ${baseline.bytes} bytes; limits are ${MAX_GROWTH_PERCENT}% and ${MAX_GROWTH_BYTES} bytes`,
  );
});
