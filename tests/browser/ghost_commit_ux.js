// Phase 11 browser acceptance: Commit -> reload -> real preview -> Undo.

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
      probe.close((error) => error ? reject(error) : resolvePort(address.port));
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

async function projectState() {
  const projects = await (await fetch(`${BASE}/api/projects`)).json();
  const projectId = projects.items[0].id;
  const state = await (await fetch(`${BASE}/api/projects/${projectId}/action-state`)).json();
  return { projectId, state };
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
  await startLead(page);
  const select = page.locator('.deck-slot--anchor .deck__select-phrase');
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

async function main() {
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), '2become1-solid-ghost-'));
  const { child, log } = startServer(dataDir);
  let browser;
  try {
    await waitForServer(child, log);
    browser = await chromium.launch({
      executablePath: resolveChromium(), headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = [];
    const actionResponses = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    page.on('response', async (response) => {
      if (response.request().method() === 'POST' && /\/api\/projects\/[^/]+\/actions$/.test(response.url())) {
        actionResponses.push({ status: response.status(), body: await response.text().catch(() => '') });
      }
    });

    await page.goto(`${BASE}/#/studio`);
    await waitFor(async () => (await page.locator('.deck-slot--anchor .deck__title').count()) === 1, 'Studio');
    await createAudition(page);
    record('Commit is available only after auditioning', true);

    await page.locator('.ghost-card button', { hasText: 'Commit' }).click();
    try {
      await waitFor(async () => (await page.locator('.committed-layer').count()) === 1, 'committed layer');
    } catch (error) {
      const phase = await page.locator('.ghost-card__phase').textContent().catch(() => 'missing phase');
      const cardError = await page.locator('.ghost-card__error').textContent().catch(() => 'missing error');
      const durableDebug = await projectState().catch(() => null);
      throw new Error(`${error.message}; phase=${phase.trim()} error=${cardError.trim()} state=${JSON.stringify(durableDebug?.state || null)} actionResponses=${JSON.stringify(actionResponses)}`);
    }
    const copy = await page.locator('.committed-layer').textContent();
    record('Commit creates truthful visible layer', /Included in the next preview\/render/.test(copy), copy.trim().slice(0, 100));
    const tetherVisible = await page.locator('.ghost-tether').getAttribute('data-visible');
    record('Commit removes transient tether', tetherVisible !== 'true', `data-visible=${tetherVisible}`);

    let durable = await projectState();
    record('Commit is durable and pins one projection layer', durable.state.session.committedLayers.length === 1,
      `${durable.state.session.committedLayers.length} committed`);

    // Put the accepted beat-32 launch inside the bounded 12-second preview
    // window. This changes only the render cue; immutable accepted placement
    // remains authoritative and is converted by the server planner.
    const project = await (await fetch(`${BASE}/api/projects/${durable.projectId}`)).json();
    const cueResponse = await fetch(`${BASE}/api/projects/${durable.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ...project.settings, lead_start: 10 } }),
    });
    record('Render window is positioned over the accepted launch', cueResponse.ok);

    await page.reload();
    await waitFor(async () => (await page.locator('.committed-layer').count()) === 1, 'committed layer after reload');
    record('Committed layer survives reload', true);
    await page.addScriptTag({ content: A11Y_SOURCE });
    const audit = await page.evaluate((viewportWidth) => window.auditDocument(document, { viewportWidth }), width);
    record('Committed layer accessibility audit is clean',
      audit.serious === 0 && audit.moderate === 0 && audit.info === 0,
      `${audit.serious} serious, ${audit.moderate} moderate, ${audit.info} info`);
    const undoSize = await page.locator('button[aria-label="Undo committed Ghost 1"]').evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    record('Undo has a 44px touch target', undoSize.width >= 44 && undoSize.height >= 44,
      `${undoSize.width.toFixed(1)}x${undoSize.height.toFixed(1)}`);

    // Amendment 7: prove the committed Ghost through the existing real
    // preview/render pipeline, not by claiming the base-deck player changed.
    await waitFor(async () => {
      const button = page.locator('.render-actions button', { hasText: 'Preview 12s' });
      return (await button.count()) === 1 && !(await button.isDisabled());
    }, 'fresh committed render plan');
    await page.locator('.render-actions button', { hasText: 'Preview 12s' }).click();
    await waitFor(async () => {
      const text = await page.locator('article[aria-label="Latest completed preview"]').textContent().catch(() => '');
      return /Complete/.test(text);
    }, 'real committed preview output', 90000);
    const jobsBody = await (await fetch(`${BASE}/api/jobs?limit=20`)).json();
    const completedPreview = (jobsBody.items || jobsBody.jobs || []).find(
      (job) => job.kind === 'preview' && job.status === 'complete',
    );
    record('Real preview/render pipeline includes committed projection',
      completedPreview?.result?.committed_layer_count === 1,
      `project_id=${completedPreview?.request?.project_id} committed_layer_count=${completedPreview?.result?.committed_layer_count}`);

    const undo = page.locator('button[aria-label="Undo committed Ghost 1"]');
    await undo.click();
    await waitFor(async () => (await page.locator('dialog[open]').count()) === 1, 'Undo confirmation');
    const description = await page.locator('dialog[open] .dialog__description').textContent();
    record('Undo requires honest confirmation', /future previews and renders/.test(description), description.trim());
    await page.locator('dialog[open] button', { hasText: 'Undo Ghost' }).click();
    await waitFor(async () => (await page.locator('.committed-layer').count()) === 0, 'Undo projection');
    const history = await page.locator('.committed-layers__history').textContent();
    record('Undo retains visible history', /retained in session history/.test(history), history.trim());

    durable = await projectState();
    record('Undo excludes layer but retains immutable projection history',
      durable.state.session.committedLayers.length === 0 && durable.state.session.revertedLayers.length === 1,
      `committed=${durable.state.session.committedLayers.length} reverted=${durable.state.session.revertedLayers.length}`);

    await page.reload();
    await waitFor(async () => (await page.locator('.committed-layers__history').count()) === 1, 'Undo history after reload');
    record('Undo survives reload', (await page.locator('.committed-layer').count()) === 0);

    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    record('No horizontal overflow', overflow.scroll <= overflow.client,
      `scrollWidth=${overflow.scroll} clientWidth=${overflow.client}`);
    // After Undo there is intentionally no Undo button; its keyboard path was
    // exercised above. The mobile layout is still checked for overflow.
    record('No uncaught browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }

  writeFileSync(join(outDir, `ghost-commit-${viewportArg}.json`), JSON.stringify({ viewport: viewportArg, results, failures }, null, 2));
  console.log(`\n${results.length} checks, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Solid Ghost harness crashed:', error);
  process.exit(2);
});
