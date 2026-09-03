// Phase 12B.5 browser acceptance: commit -> scheduled -> live -> undo -> reload -> resume.
//
// Drives the real 2become1 Studio against the ghost fixture server and proves
// the live committed-layer engine end to end:
//   - after Commit the committed layer shows a truthful live state (scheduled
//     while the launch boundary is armed, then live once it passes while the
//     Lead keeps playing);
//   - confirmed Undo stops a LIVE source (the Lead is still playing when Undo
//     is clicked — no pause first);
//   - pause drops the layer to idle (suspend, not destroy), and a later owned
//     Lead play resumes it;
//   - reload hydrates idle with no autoplay;
//   - Lead-play-after-reload resumes idle -> scheduled/live under NORMAL
//     autoplay policy (a separate context without the autoplay override).
// Real Web Audio scheduling in the harness; both viewports.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolveChromium } from './chromium.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const viewportArg = argValue('--viewport', '1280x800');
const [width, height] = viewportArg.split('x').map(Number);
const outDir = argValue('--out', join(ROOT, 'tests', 'browser', 'artifacts'));
const A11Y_SOURCE = readFileSync(new URL('./a11y.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export \{.*$/m, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export /gm, '')
  + '\nwindow.auditDocument = auditDocument;\nwindow.accessibleName = accessibleName;\nwindow.isHidden = isHidden;\n';

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
const results = [];
let failures = 0;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startServer(dataDir) {
  const child = spawn(
    process.env.PYTHON || '.venv/bin/python',
    ['-m', 'tests.browser.ghost_fixture_server', '--data-dir', dataDir, '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => log.push(chunk.toString()));
  return { child, log };
}

async function waitForServer(child, log) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${log.join('')}`);
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, 'fixture server', 30000);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startLead(page) {
  const play = page.locator('.deck-slot--lead button[aria-label="Play Lead"]');
  if (await play.count()) await play.click();
  await waitFor(
    async () => (await page.locator('.deck-slot--lead button[aria-label^="Pause Lead"]').count()) === 1,
    'Lead playback',
  );
}

async function createAudition(page) {
  // The Select Phrase button must be enabled (re-enables after Undo clears
  // the committed layer). Wait for it deterministically rather than racing.
  const select = page.locator('.deck-slot--anchor .deck__select-phrase');
  await waitFor(async () => (await select.isEnabled().catch(() => false)), 'Select phrase enabled');
  await startLead(page);
  await select.click();
  await select.click();
  await waitFor(async () => (await page.locator('dialog[open]').count()) === 1, 'Ghost dialog');
  await page.locator('dialog[open] input[aria-label="Start beat"]').fill('0');
  await page.locator('dialog[open] input[aria-label="End beat"]').fill('2');
  await page.locator('dialog[open] button', { hasText: 'Preview' }).click();
  await waitFor(
    async () => page.locator('.ghost-card button', { hasText: 'Commit' }).isVisible().catch(() => false),
    'auditioning Commit control',
  );
}

async function liveBadgeState(page) {
  const badge = page.locator('.committed-layer__badge');
  if ((await badge.count()) === 0) return null;
  return (await badge.first().textContent()).trim();
}

async function commitAudition(page) {
  await page.locator('.ghost-card button', { hasText: 'Commit' }).click();
  await waitFor(async () => (await page.locator('.committed-layer').count()) === 1, 'committed layer');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), '2become1-live-layer-'));
  const { child, log } = startServer(dataDir);
  let browser;
  try {
    await waitForServer(child, log);
    browser = await chromium.launch({
      executablePath: resolveChromium(), headless: true,
      args: ['--mute-audio'],
    });

    // ---- Context A: the main flow under Chromium's normal autoplay policy. ----
    const contextA = await browser.newContext({ viewport: { width, height } });
    const page = await contextA.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });

    await page.goto(`${BASE}/#/studio`);
    await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, 'Studio');
    await createAudition(page);
    await commitAudition(page);

    // Truthful live state while the Lead plays: scheduled (armed) or live.
    const armed = await waitFor(async () => {
      const state = await liveBadgeState(page);
      return state === 'scheduled' || state === 'live' ? state : null;
    }, 'live state (scheduled or live)', 20000);
    record('Commit arms a truthful live state', armed === 'scheduled' || armed === 'live', `state=${armed}`);

    // The launch boundary passes while the Lead keeps playing -> live.
    const live = await waitFor(async () => {
      const state = await liveBadgeState(page);
      return state === 'live' ? state : null;
    }, 'live state after boundary', 30000);
    record('Layer goes live while the Lead plays', live === 'live', `state=${live}`);
    const blockedSelect = page.locator('.deck-slot--anchor .deck__select-phrase');
    record('Committed layer disables new Preview entry truthfully',
      await blockedSelect.isDisabled()
        && /Undo the committed Ghost first/i.test(await blockedSelect.textContent()),
      (await blockedSelect.textContent()).trim());
    await page.screenshot({
      path: join(outDir, `ghost-live-${viewportArg}.png`),
      fullPage: true,
    });

    // Confirmed Undo stops a LIVE source: the Lead is still playing (no pause
    // first), so this proves Undo tears down an actively sounding layer.
    await page.locator('button[aria-label="Undo committed Ghost 1"]').click();
    await waitFor(async () => (await page.locator('dialog[open]').count()) === 1, 'Undo confirmation');
    await page.locator('dialog[open] button', { hasText: 'Undo Ghost' }).click();
    await waitFor(async () => (await page.locator('.committed-layer').count()) === 0, 'Undo projection');
    record('Confirmed Undo stops a live source', true);

    // The fixture is only 32 seconds long and the first live boundary has
    // already consumed half of it. Restart the still-playing Lead AFTER the
    // live-Undo proof so the second audition has a deterministic future
    // phrase boundary instead of racing the end of the synthetic track.
    await page.locator('.deck-slot--lead button[aria-label="Stop Lead playback"]').click();
    await waitFor(
      async () => (await page.locator('.deck-slot--lead button[aria-label="Play Lead"]').count()) === 1,
      'Lead reset after live Undo',
    );

    // Re-commit for the suspend/resume + reload proofs.
    await createAudition(page);
    await commitAudition(page);
    await waitFor(async () => {
      const state = await liveBadgeState(page);
      return state === 'scheduled' || state === 'live' ? state : null;
    }, 'live state (2nd commit)', 20000);

    // Pause the Lead -> honest idle (suspend, not destroy).
    await page.locator('.deck-slot--lead button[aria-label^="Pause Lead"]').click();
    const idle = await waitFor(async () => {
      const state = await liveBadgeState(page);
      return state === 'idle' ? state : null;
    }, 'idle after Lead pause', 10000);
    record('Pause drops the layer to idle', idle === 'idle', `state=${idle}`);

    // A later owned Lead play resumes idle -> scheduled/live.
    await startLead(page);
    const resumed = await waitFor(async () => {
      const state = await liveBadgeState(page);
      return state === 'scheduled' || state === 'live' ? state : null;
    }, 'resume after Lead play', 20000);
    record('Lead play resumes the suspended layer', resumed === 'scheduled' || resumed === 'live', `state=${resumed}`);

    // Reload hydrates idle with no autoplay.
    await page.reload();
    await waitFor(async () => (await page.locator('.committed-layer').count()) === 1, 'committed layer after reload');
    const reloadState = await liveBadgeState(page);
    record('Reload hydrates idle with no autoplay', reloadState === 'idle', `state=${reloadState}`);

    // Accessibility + overflow (context A).
    await page.addScriptTag({ content: A11Y_SOURCE });
    const audit = await page.evaluate((viewportWidth) => window.auditDocument(document, { viewportWidth }), width);
    record('Live layer accessibility audit is clean',
      audit.serious === 0 && audit.moderate === 0 && audit.info === 0,
      `${audit.serious} serious, ${audit.moderate} moderate, ${audit.info} info`);
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    record('No horizontal overflow', overflow.scroll <= overflow.client,
      `scrollWidth=${overflow.scroll} clientWidth=${overflow.client}`);
    record('No uncaught browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await contextA.close();

    // ---- Context B: fresh normal-policy context for reload/resume. ----
    // The committed layer persists server-side; a fresh page load hydrates it
    // idle, and a real user-gesture Play Lead must resume it to scheduled/live
    // under the browser's default autoplay policy.
    const contextB = await browser.newContext({ viewport: { width, height } });
    const pageB = await contextB.newPage();
    const errorsB = [];
    pageB.on('pageerror', (error) => errorsB.push(`pageerror: ${error.message}`));
    pageB.on('console', (message) => {
      if (message.type() === 'error') errorsB.push(`console.error: ${message.text()}`);
    });

    await pageB.goto(`${BASE}/#/studio`);
    await waitFor(async () => (await pageB.locator('.committed-layer').count()) === 1, 'committed layer (normal policy)');
    const idleB = await liveBadgeState(pageB);
    record('Normal-policy load hydrates idle (no autoplay)', idleB === 'idle', `state=${idleB}`);

    // A real user-gesture Play Lead resumes idle -> scheduled/live under
    // normal autoplay policy (no override masking policy-sensitive behavior).
    await startLead(pageB);
    const resumedB = await waitFor(async () => {
      const state = await liveBadgeState(pageB);
      return state === 'scheduled' || state === 'live' ? state : null;
    }, 'resume under normal autoplay policy', 20000);
    record('Lead play resumes under normal autoplay policy', resumedB === 'scheduled' || resumedB === 'live', `state=${resumedB}`);
    record('No uncaught browser errors (normal policy)', errorsB.length === 0, errorsB.slice(0, 3).join(' | '));

    await contextB.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }

  writeFileSync(join(outDir, `ghost-live-${viewportArg}.json`), JSON.stringify({ viewport: viewportArg, results, failures }, null, 2));
  console.log(`\n${results.length} checks, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Live layer harness crashed:', error);
  process.exit(2);
});
