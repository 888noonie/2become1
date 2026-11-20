#!/usr/bin/env node
// tests/browser/clockwork-rescue/legacy-control.mjs — negative control for the
// engine-level reproductions (OPERATION THE GOLDEN EAR II).
//
// Extracts the unrepaired C1 engine (ec74085) into a temporary sibling of the
// repaired engine (so its relative imports resolve against the same shared
// modules), runs tests/frontend/arrangement/c1-engine-repro.test.js against it,
// and REQUIRES both N1 and N2 to fail there. The temporary file is removed in
// every case. Exit 0 = the reproductions detect the original defects.

import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const LEGACY_SHA = 'ec7408594d47c8870a946aa9d7fb25d1fd013c60';
const target = path.join(ROOT, 'src/twobecomeone/studio_static/js/realtime-engine.legacy-c1.tmp.js');
const test = path.join(ROOT, 'tests/frontend/arrangement/c1-engine-repro.test.js');

const legacy = execFileSync('git', ['-C', ROOT, 'show', `${LEGACY_SHA}:src/twobecomeone/studio_static/js/realtime-engine.js`]);
writeFileSync(target, legacy);
let out = '';
try {
  const run = spawnSync(process.execPath, ['--test', test], {
    cwd: ROOT, env: { ...process.env, CLOCKWORK_ENGINE_MODULE: target }, encoding: 'utf8', timeout: 120000,
  });
  out = `${run.stdout}${run.stderr}`;
} finally {
  rmSync(target, { force: true });
}
const failed = (name) => new RegExp(`✖ ${name}`).test(out);
const n1 = failed('N1 \\(Grok repro\\)');
const n2 = failed('N2 \\(Grok repro\\)');
console.log(`legacy ${LEGACY_SHA.slice(0, 7)}: N1 ${n1 ? 'FAILS (detected)' : 'passes (NOT detected)'}; N2 ${n2 ? 'FAILS (detected)' : 'passes (NOT detected)'}`);
for (const line of out.split('\n').filter((l) => /AssertionError/.test(l)).slice(0, 4)) console.log(`  ${line.trim()}`);
process.exitCode = n1 && n2 ? 0 : 1;
