#!/usr/bin/env node
// tests/browser/daw_bounce.js — GATE 3/4/5/7 bounce harness driver.
//
// Serves the repo over loopback HTTP, runs tests/browser/daw/bounce.js in headless
// Chromium, samples the Chromium child-tree RSS during the bounce, and saves the
// WAV artifact plus the measurement report.
//
// Usage: node tests/browser/daw_bounce.js [--out /tmp/opencode/living-daylights]

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveChromium } from './chromium.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : '/tmp/opencode/living-daylights';
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
  '.wav': 'audio/wav', '.css': 'text/css',
};

let artifactBytes = null;
let resultsJson = null;
const samples = [];
let sampling = false;

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && urlPath === '/artifact') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      artifactBytes = Buffer.concat(chunks);
      sampling = false;
      res.writeHead(200).end('ok');
    });
    return;
  }
  if (req.method === 'POST' && urlPath === '/results') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      resultsJson = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200).end('ok');
    });
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

function sampleTreeRss() {
  try {
    const rows = execSync('ps -eo pid,ppid,rss,comm', { encoding: 'utf8' })
      .trim().split('\n').slice(1)
      .map((l) => {
        const [pid, ppid, rss, ...comm] = l.trim().split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), comm: comm.join(' ') };
      });
    const children = new Map();
    for (const r of rows) {
      if (!children.has(r.ppid)) children.set(r.ppid, []);
      children.get(r.ppid).push(r);
    }
    let total = 0;
    const stack = [process.pid];
    while (stack.length) {
      for (const child of children.get(stack.pop()) ?? []) {
        if (/chrome|chromium/i.test(child.comm)) {
          total += child.rss;
          stack.push(child.pid);
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const sampler = setInterval(() => {
  if (sampling) samples.push({ t: Date.now(), treeRssKb: sampleTreeRss() });
}, 500);

try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log(`page error: ${err}`));
  sampling = true;
  await page.goto(`http://127.0.0.1:${port}/tests/browser/daw/bounce.html`);
  let pageError = null;
  try {
    await page.waitForFunction('window.__bounceDone === true', null, { timeout: 900000 });
    pageError = await page.evaluate('window.__bounceError || null');
  } catch (err) {
    pageError = `harness crashed or timed out: ${err.message}`;
  }

  const wavPath = path.join(OUT, 'living-daylights-bounce.wav');
  if (artifactBytes) writeFileSync(wavPath, artifactBytes);
  const resultsPath = path.join(OUT, 'bounce-results.json');
  let report = {};
  if (resultsJson) {
    report = JSON.parse(resultsJson);
    report.rssSamplesKb = samples;
    report.maxTreeRssKb = samples.length ? Math.max(...samples.map((s) => s.treeRssKb)) : null;
    report.artifactBytes = artifactBytes ? artifactBytes.length : null;
    writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  for (const c of report.checks ?? []) {
    console.log(`${c.passed ? 'PASS' : 'FAIL'} check: ${c.name} ${JSON.stringify(c.detail).slice(0, 160)}`);
  }
  for (const nc of report.negativeControls ?? []) {
    console.log(`${nc.detected ? 'PASS' : 'FAIL'} negative control detected: ${nc.name} ${JSON.stringify(nc.check).slice(0, 160)}`);
  }
  console.log(`GATE5: ${JSON.stringify(report.gate5 ?? {})}`);
  console.log(`measurements: ${JSON.stringify(report.measurements ?? {}).slice(0, 900)}`);
  if (samples.length) console.log(`chromium tree RSS: max ${report.maxTreeRssKb} KiB over ${samples.length} samples`);
  console.log(`artifact: ${wavPath} (${artifactBytes ? artifactBytes.length : 0} bytes)`);
  if (pageError) {
    console.log(`page error: ${pageError}`);
    process.exitCode = 1;
  }
  if ((report.errors ?? []).length) {
    console.log(`harness errors: ${JSON.stringify(report.errors)}`);
    process.exitCode = 1;
  }
} finally {
  clearInterval(sampler);
  await browser.close();
  server.close();
}
