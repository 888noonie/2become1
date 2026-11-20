#!/usr/bin/env node
// tests/browser/signalsmith_spike.js — GATE 1 feasibility spike driver.
//
// Serves the repo over loopback HTTP (so AudioWorklet modules load the way the
// Studio will load them), runs tests/browser/signalsmith/spike.js in headless
// Chromium, samples this driver's Chromium child-tree RSS during the heavy
// experiments, and writes the machine-readable results.
//
// Usage: node tests/browser/signalsmith_spike.js [--out /tmp/opencode/living-daylights]

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

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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

/** RSS (KiB) of the Chromium process tree rooted at this driver's children. */
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
const samples = [];
let sampling = false;
const sampler = setInterval(() => {
  if (sampling) samples.push({ t: Date.now(), treeRssKb: sampleTreeRss() });
}, 250);

try {
  const page = await browser.newPage();
  await page.exposeFunction('__spikeRssStart', () => {
    sampling = true;
    return { stop: () => { sampling = false; } };
  });
  // The page-side hook is a factory returning {stop}; bridge via evaluate.
  await page.addInitScript(() => {
    window.__spikeRssHook = () => {
      window.__spikeRssStart();
      return { stop: () => window.__spikeRssStop && window.__spikeRssStop() };
    };
  });
  await page.exposeFunction('__spikeRssStop', () => { sampling = false; });

  await page.goto(`http://127.0.0.1:${port}/tests/browser/signalsmith/spike.html`);
  await page.waitForFunction('window.__spikeDone === true', null, { timeout: 480000 });
  const results = await page.evaluate('window.__spikeResults');
  const error = await page.evaluate('window.__spikeError || null');

  const report = {
    startedAt: new Date().toISOString(),
    chromium: resolveChromium(),
    error,
    rssSamplesKb: samples,
    maxTreeRssKb: samples.length ? Math.max(...samples.map((s) => s.treeRssKb)) : null,
    results,
  };
  writeFileSync(path.join(OUT, 'spike-results.json'), `${JSON.stringify(report, null, 2)}\n`);

  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.ok) pass += 1;
    else fail += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}`);
    console.log(`     ${JSON.stringify(r.metrics)}`);
    for (const n of r.notes) console.log(`     note: ${n}`);
  }
  if (fail > 0) process.exitCode = 1;
  console.log(`\n${pass} pass, ${fail} fail — results in ${path.join(OUT, 'spike-results.json')}`);
  if (samples.length) console.log(`chromium tree RSS: max ${report.maxTreeRssKb} KiB over ${samples.length} samples`);
  if (error) {
    console.log(`spike error: ${error}`);
    process.exitCode = 1;
  }
} finally {
  clearInterval(sampler);
  await browser.close();
  server.close();
}
