#!/usr/bin/env node
// tests/browser/clockwork.js — Milestone C1 transport-proof driver.
//
// Serves the repo over loopback HTTP, runs tests/browser/clockwork/harness.js in
// headless Chromium, and saves the measurement report to a bounded state dir.
//
// Usage: node tests/browser/clockwork.js [--out ~/.local/state/clockwork]

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(os.homedir(), '.local', 'state', 'clockwork');
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
  '.wav': 'audio/wav', '.css': 'text/css', '.wasm': 'application/wasm',
};

let resultsJson = null;
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && urlPath === '/results') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { resultsJson = Buffer.concat(chunks).toString('utf8'); res.writeHead(200).end('ok'); });
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log(`page error: ${err}`));
  await page.goto(`http://127.0.0.1:${port}/tests/browser/clockwork/harness.html`);
  let pageError = null;
  try {
    await page.waitForFunction('window.__clockworkDone === true', null, { timeout: 600000 });
    resultsJson = await page.evaluate('JSON.stringify(window.__clockworkResults)');
    pageError = await page.evaluate('window.__clockworkError || null');
  } catch (err) {
    pageError = `harness crashed or timed out: ${err.message}`;
  }

  const resultsPath = path.join(OUT, 'clockwork-results.json');
  let report = {};
  if (resultsJson) {
    report = JSON.parse(resultsJson);
    writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  for (const c of report.checks ?? []) {
    console.log(`${c.passed ? 'PASS' : 'FAIL'} check: ${c.name} ${JSON.stringify(c.detail).slice(0, 200)}`);
    if (!c.passed) process.exitCode = 1;
  }
  for (const nc of report.negativeControls ?? []) {
    console.log(`${nc.detected ? 'PASS' : 'FAIL'} negative control detected: ${nc.name} ${JSON.stringify(nc.check).slice(0, 160)}`);
    if (!nc.detected) process.exitCode = 1;
  }
  console.log(`GATE2 horizon: ${JSON.stringify(report.measurements?.schedulingHorizonMs)} (priming ${report.measurements?.primingRequiredMs} + wake ${report.measurements?.primingWakeMs} + jitter ${report.measurements?.primingJitterMs})`);
  console.log(`measurements: ${JSON.stringify(report.measurements ?? {}).slice(0, 1200)}`);
  console.log(`results: ${resultsPath}`);
  if (pageError) { console.log(`page error: ${pageError}`); process.exitCode = 1; }
  if ((report.errors ?? []).length) { console.log(`harness errors: ${JSON.stringify(report.errors)}`); process.exitCode = 1; }
} finally {
  await browser.close();
  server.close();
}
