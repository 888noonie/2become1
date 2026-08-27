// tests/browser/run.js — Phase 7A browser acceptance harness.
//
// Drives the real 2become1 Studio in system Chromium (via playwright-core,
// which never downloads a browser) against the fixture server
// (tests/browser/fixture_server.py). Covers the primary V0.3 journeys and runs
// the deterministic accessibility audit. Exits non-zero on any failure so it
// can gate CI.
//
// Usage:
//   node tests/browser/run.js [--viewport 390x844] [--no-seed] [--out DIR]
//
// Environment:
//   CHROMIUM_PATH  override the system Chromium executable (default /usr/bin/chromium)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { auditDocument } from './a11y.js';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
async function availablePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}
const PORT = await availablePort();
const BASE = `http://127.0.0.1:${PORT}`;

// Build a browser-safe copy of the a11y module (strip ES exports, expose on
// window) so it can be injected into the page context.
const A11Y_SOURCE = readFileSync(new URL('./a11y.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export \{.*$/m, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export \{/gm, '')
  .replace(/^export /gm, '')
  + '\nwindow.auditDocument = auditDocument;\nwindow.accessibleName = accessibleName;\nwindow.isHidden = isHidden;\n';

// ---- argument parsing ------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const viewportArg = argValue('--viewport', '1280x800');
const [vw, vh] = viewportArg.split('x').map(Number);
const noSeed = args.includes('--no-seed');
const outDir = argValue('--out', join(ROOT, 'tests', 'browser', 'artifacts'));

// ---- results ---------------------------------------------------------------
const results = [];
let failures = 0;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- helpers ---------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* retry */ }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Collect console errors and page errors for the no-uncaught-errors assertion.
function attachErrorCollector(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      sink.push(`console.error: ${msg.text()}${loc && loc.url ? ` @ ${loc.url}` : ''}`);
    }
  });
  page.on('pageerror', (err) => sink.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    if (failure && failure.errorText !== 'net::ERR_ABORTED') {
      sink.push(`requestfailed: ${req.url()} (${failure.errorText})`);
    }
  });
}

async function screenshot(page, name) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function auditCurrentPage(page, label) {
  const loaded = await page.evaluate(() => typeof window.auditDocument === 'function');
  if (!loaded) await page.addScriptTag({ content: A11Y_SOURCE });
  const audit = await page.evaluate(
    (w) => window.auditDocument(document, { viewportWidth: w }), vw,
  );
  const clean = audit.serious === 0 && audit.moderate === 0 && audit.info === 0;
  record(
    `accessibility: ${label}`,
    clean,
    `${audit.serious} serious, ${audit.moderate} moderate, ${audit.info} info`,
  );
  if (audit.findings.length) {
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    writeFileSync(
      join(outDir, `a11y-${safeLabel}-${viewportArg}.json`),
      JSON.stringify(audit.findings, null, 2),
    );
  }
  return audit;
}

// ---- server lifecycle ------------------------------------------------------
function startServer(dataDir) {
  const child = spawn(
    process.env.PYTHON || '.venv/bin/python',
    ['-m', 'tests.browser.fixture_server', '--data-dir', dataDir, '--port', String(PORT), ...(noSeed ? ['--no-seed'] : [])],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  return { child, log };
}

async function waitForServer(child, log) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited early (${child.exitCode}): ${log.join('')}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`fixture server did not become ready: ${log.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null) {
    const killed = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill('SIGKILL');
    await Promise.race([killed, sleep(2000)]);
  }
}

// ---- journeys --------------------------------------------------------------

async function journeyFirstRun(page) {
  // Fresh data root: no projects, no tracks. Boot creates "Untitled mix".
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => {
    const title = await page.locator('.project-title').textContent().catch(() => '');
    return title && title.trim().length > 0;
  }, { label: 'project title' });
  const title = (await page.locator('.project-title').textContent()).trim();
  record('first-run creates Untitled mix', title === 'Untitled mix', `title="${title}"`);

  // Both decks show the empty "Choose Track" state.
  const chooseButtons = await page.locator('.deck__empty button', { hasText: 'Choose Track' }).count();
  record('first-run shows two empty decks', chooseButtons === 2, `${chooseButtons} choose buttons`);
}

async function journeyAssignAndSwap(page) {
  // Seeded library: assign the two tracks via the source picker.
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => (await page.locator('.deck__empty button').count()) === 2, { label: 'empty decks' });

  // Assign Foundation.
  await page.locator('.deck-slot--anchor .deck__empty button').click();
  await waitFor(async () => (await page.locator('.picker__panel .track-card').count()) >= 2, { label: 'picker tracks' });
  await page.locator('.picker__panel .track-card').first().locator('button', { hasText: 'Select' }).click();
  await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, { label: 'anchor assigned' });
  // The picker stays open after assignment; dismiss it.
  await page.locator('dialog[open] button', { hasText: 'Close' }).click();
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 0, { label: 'picker closed' });

  // Assign Lead.
  await page.locator('.deck-slot--lead .deck__empty button').click();
  await waitFor(async () => (await page.locator('.picker__panel .track-card').count()) >= 2, { label: 'picker tracks 2' });
  await page.locator('.picker__panel .track-card').nth(1).locator('button', { hasText: 'Select' }).click();
  await waitFor(async () => (await page.locator('.deck-slot--lead .deck__title').count()) === 1, { label: 'lead assigned' });
  await auditCurrentPage(page, 'source picker');
  await page.locator('dialog[open] button', { hasText: 'Close' }).click();
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 0, { label: 'picker closed 2' });

  const anchorName = (await page.locator('.deck-slot--anchor .deck__title').textContent()).trim();
  const leadName = (await page.locator('.deck-slot--lead .deck__title').textContent()).trim();
  record('both decks assigned', Boolean(anchorName && leadName), `${anchorName} / ${leadName}`);

  // Swap.
  await page.locator('button', { hasText: 'Swap Foundation & Lead' }).click();
  await waitFor(async () => {
    const a = (await page.locator('.deck-slot--anchor .deck__title').textContent()).trim();
    return a === leadName;
  }, { label: 'swap applied' });
  record('swap exchanges decks', true, `${anchorName} <-> ${leadName}`);
  await waitFor(async () => /saved locally/i.test(
    await page.locator('.save-status').textContent().catch(() => ''),
  ), { label: 'swap autosave' });

  // Refresh restores the swapped assignment.
  await page.reload();
  await waitFor(async () => {
    const restored = await page.locator('.deck-slot--anchor .deck__title').textContent().catch(() => '');
    const cueReady = await page.locator('input[aria-label="Cue position in seconds (foundation)"]').count();
    return restored.trim() === leadName && cueReady === 1;
  }, { label: 'restore after refresh' });
  const restoredAnchor = (await page.locator('.deck-slot--anchor .deck__title').textContent()).trim();
  record('refresh restores project', true, `anchor="${restoredAnchor}"`);

  // Persist an exact cue through the accessible numeric control.
  const cue = page.locator('input[aria-label="Cue position in seconds (foundation)"]');
  await cue.fill('1.3');
  await cue.dispatchEvent('change');
  await waitFor(async () => /saved locally/i.test(
    await page.locator('.save-status').textContent().catch(() => ''),
  ), { label: 'cue autosave' });
  const savedCue = await page.locator('input[aria-label="Cue position in seconds (foundation)"]').inputValue();
  await page.reload();
  await waitFor(async () => (
    await page.locator('input[aria-label="Cue position in seconds (foundation)"]').inputValue().catch(() => '')
  ) === savedCue, { label: 'cue restored' });
  record('cue change survives refresh', true, `cue=${savedCue}s`);

  // Persist an analysis override and verify the deck reflects it after reload.
  await page.locator('.deck-slot--anchor button', { hasText: 'Edit Analysis' }).click();
  await page.locator('input[aria-label="Override BPM"]').fill('101.1');
  await page.locator('dialog[open] button', { hasText: 'Save Analysis' }).click();
  await waitFor(async () => /101\.1 BPM/.test(
    await page.locator('.deck-slot--anchor .deck__meta-row').textContent().catch(() => ''),
  ), { label: 'analysis override applied' });
  await page.reload();
  await waitFor(async () => /101\.1 BPM/.test(
    await page.locator('.deck-slot--anchor .deck__meta-row').textContent().catch(() => ''),
  ), { label: 'analysis override restored' });
  record('analysis override survives refresh', true, '101.1 BPM');
}

async function journeySeparation(page) {
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, { label: 'anchor present' });

  // Open the stem dialog on the anchor deck.
  await page.locator('.deck-slot--anchor button', { hasText: 'Separate' }).click();
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 1, { label: 'stem dialog open' });

  // Choose the ffmpeg center/side method (no GPU) and start.
  await page.locator('select[aria-label="Separation method"]').selectOption('ffmpeg');
  await page.locator('button', { hasText: 'Start Separation' }).click();
  await waitFor(async () => {
    const text = await page.locator('.stem-dialog__status').textContent().catch(() => '');
    return /complete|cached/i.test(text);
  }, { timeout: 30000, label: 'separation complete' });

  // Truthful center/side labels appear; "vocals" must not.
  await waitFor(async () => {
    const text = await page.locator('.stem-tray__list').textContent().catch(() => '');
    return /center/i.test(text) && /sides/i.test(text);
  }, { label: 'center/side stems rendered' });
  const trayText = await page.locator('.stem-tray__list').textContent();
  record('separation shows center/side (not vocals)', /center/i.test(trayText) && !/vocals/i.test(trayText), trayText.trim().slice(0, 60));
  await auditCurrentPage(page, 'stem dialog');

  const audition = page.locator('.stem-tray__list button', { hasText: 'Audition' }).first();
  await audition.click();
  await waitFor(async () => (
    await page.locator('.stem-tray__list button', { hasText: 'Stop' }).count()
  ) >= 1, { label: 'stem audition starts' });
  record('stem can be auditioned', true);
  await page.locator('.stem-tray__list button', { hasText: 'Stop' }).first().click();

  await page.locator('.stem-tray__list button', { hasText: 'Use in Deck' }).first().click();
  await waitFor(async () => (
    await page.locator('.stem-tray__list button', { hasText: 'Active in Deck' }).count()
  ) >= 1, { label: 'stem selected in deck' });
  record('stem can be selected for the deck', true);

  // Close the dialog.
  await page.locator('dialog[open] button', { hasText: 'Done' }).click();
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 0, { label: 'stem dialog closed' });
}

async function journeyRender(page) {
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, { label: 'anchor present' });

  // Wait for the server-authored plan to verify.
  await waitFor(async () => {
    const text = await page.locator('.plan-ready').textContent().catch(() => '');
    return /verified/i.test(text);
  }, { timeout: 20000, label: 'plan verified' });

  // Preview.
  await page.locator('button', { hasText: 'Preview 12s' }).click();
  await waitFor(async () => {
    const text = await page.locator('.render-actions__status').textContent().catch(() => '');
    return /complete/i.test(text);
  }, { timeout: 30000, label: 'preview complete' });

  // Full render.
  await page.locator('button', { hasText: 'Render full mix' }).click();
  await waitFor(async () => {
    const text = await page.locator('.render-actions__status').textContent().catch(() => '');
    return /complete/i.test(text);
  }, { timeout: 30000, label: 'render complete' });

  // A completed result offers Play and Download.
  const playCount = await page.locator('.render-result button', { hasText: 'Play' }).count();
  const downloadCount = await page.locator('.render-result a', { hasText: 'Download' }).count();
  record('render result offers play/download', playCount >= 1 && downloadCount >= 1, `play=${playCount} download=${downloadCount}`);
  await auditCurrentPage(page, 'completed render result');

  const rename = page.locator('.render-result button', { hasText: 'Rename' }).last();
  await rename.click();
  await page.locator('dialog[open] input[aria-label="Result name"]').fill('Phase 7 accepted mix');
  await page.locator('dialog[open] button', { hasText: 'Rename' }).click();
  await waitFor(async () => /Phase 7 accepted mix/.test(
    await page.locator('.render-result').last().textContent().catch(() => ''),
  ), { label: 'result renamed' });
  record('completed result can be renamed', true);

  await page.locator('.render-result button', { hasText: 'Use these settings in a new mix' }).last().click();
  await waitFor(async () => (
    await page.locator('.project-title').textContent().catch(() => '')
  ).trim() !== 'Untitled mix', { label: 'new mix from render' });
  record('render settings create a new mix', true, (await page.locator('.project-title').textContent()).trim());
}

async function journeyRecovery(page) {
  await page.goto(`${BASE}/#/activity`);
  await waitFor(async () => (await page.locator('.job-item button', { hasText: 'Retry' }).count()) >= 1, { label: 'retryable failed job' });
  const retry = page.locator('.job-item button', { hasText: 'Retry' }).first();
  const originalId = await retry.locator('xpath=ancestor::*[@data-job-id][1]').getAttribute('data-job-id');
  await retry.click();
  await waitFor(async () => page.evaluate(async (parentId) => {
    const response = await fetch('/api/jobs?limit=100');
    const payload = await response.json();
    return payload.items.some((job) => job.parent_job_id === parentId && job.status === 'complete');
  }, originalId), { timeout: 30000, label: 'retried render completes' });
  record('failed render retries as a new completed job', true, `parent=${originalId}`);
}

async function journeyOffline(page) {
  // Invalid YouTube URL must surface a toast, not a crash.
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__empty button').count()) >= 1 || (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, { label: 'studio ready' });

  // Clear any stale toast from a prior journey so we observe this one's result.
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) { t.hidden = true; t.textContent = ''; } });

  // Open a source picker and submit an invalid URL.
  const anchorEmpty = await page.locator('.deck-slot--anchor .deck__empty button').count();
  if (anchorEmpty >= 1) {
    await page.locator('.deck-slot--anchor .deck__empty button').click();
  } else {
    await page.locator('.deck-slot--anchor button', { hasText: 'Replace' }).click();
  }
  await waitFor(async () => (await page.locator('.picker__tabs').count()) === 1, { label: 'picker open' });
  await page.locator('.picker__tab', { hasText: 'YouTube' }).click();
  await page.locator('input[aria-label="YouTube URL"]').fill('not-a-valid-url');
  await page.locator('.picker__panel button', { hasText: 'Import' }).click();
  await waitFor(async () => {
    const toast = await page.locator('#toast').textContent().catch(() => '');
    return toast.length > 0;
  }, { label: 'toast shown' });
  const toast = await page.locator('#toast').textContent();
  record('invalid URL surfaces a toast', toast.length > 0, toast.trim().slice(0, 60));
}

async function journeyKeyboard(page) {
  // Keyboard-only: open a dialog, verify focus trap + Escape close + focus return.
  await page.goto(`${BASE}/#/studio`);
  await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, { label: 'anchor present' });

  // Focus the "Edit Analysis" button via keyboard (Tab until it is focused).
  const editBtn = page.locator('.deck-slot--anchor button', { hasText: 'Edit Analysis' });
  await editBtn.focus();
  const focusedBefore = await page.evaluate(() => document.activeElement?.textContent || '');
  record('keyboard: Edit Analysis is focusable', /Edit Analysis/.test(focusedBefore), focusedBefore.trim());

  // Open the dialog with Enter.
  await page.keyboard.press('Enter');
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 1, { label: 'analysis dialog open' });

  // Focus is trapped inside the dialog (activeElement is within it).
  const focusInDialog = await page.evaluate(() => {
    const dlg = document.querySelector('dialog[open]');
    return dlg ? dlg.contains(document.activeElement) : false;
  });
  record('keyboard: focus trapped in dialog', focusInDialog === true);
  await auditCurrentPage(page, 'analysis dialog');

  // Escape closes the dialog.
  await page.keyboard.press('Escape');
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 0, { label: 'dialog closed via Escape' });
  record('keyboard: Escape closes dialog', true);

  // Focus returns to the trigger.
  const focusedAfter = await page.evaluate(() => document.activeElement?.textContent || '');
  record('keyboard: focus returns to trigger', /Edit Analysis/.test(focusedAfter), focusedAfter.trim());
}

// ---- main ------------------------------------------------------------------

async function main() {
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), '2become1-browser-'));
  const { child, log } = startServer(dataDir);
  let browser;
  try {
    await waitForServer(child, log);

    browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
    const context = await browser.newContext({ viewport: { width: vw, height: vh } });
    const page = await context.newPage();
    const errors = [];
    attachErrorCollector(page, errors);

    // Run journeys in a deterministic order. The offline journey intentionally
    // triggers a handled 400, so it runs last and is excluded from the
    // no-uncaught-errors assertion.
    await journeyFirstRun(page);
    await journeyAssignAndSwap(page);
    await journeySeparation(page);
    await journeyRender(page);
    await journeyKeyboard(page);
    await journeyRecovery(page);

    // No uncaught console/page errors across the happy-path journeys.
    record('no uncaught console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await journeyOffline(page);

    // No page-level horizontal overflow at the current viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    record('no horizontal overflow', !overflow, `scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`);

    // Accessibility audit across every first-class populated view. Dialog and
    // result states are audited in their journeys above.
    for (const view of ['studio', 'library', 'activity', 'engine']) {
      await page.goto(`${BASE}/#/${view}`);
      await waitFor(async () => {
        const content = await page.locator('#main').textContent().catch(() => '');
        return content && content.trim().length > 0;
      }, { label: `${view} populated` });
      await sleep(300);
      await auditCurrentPage(page, `${view} view`);
    }

    await page.goto(`${BASE}/#/studio`);
    await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, { label: 'studio populated for screenshot' });

    // Capture a screenshot of the populated Studio.
    const shot = await screenshot(page, `studio-${viewportArg}`);
    record('screenshot captured', existsSync(shot), shot);

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }

  // Summary.
  console.log(`\n${results.length} checks, ${failures} failure(s)`);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ viewport: viewportArg, results, failures }, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('browser harness crashed:', err);
  process.exit(2);
});
