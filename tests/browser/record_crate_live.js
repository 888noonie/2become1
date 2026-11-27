// Exercise the real HTTP catalogue and existing Performance actions.
// Use an isolated Studio seeded with two complete Demucs tracks and the
// fixtures described in docs/record-crate.md. The desktop run submits one job.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8767').origin;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, 'use an isolated loopback verification port');
let passed = 0;
function pass(message) {
  passed += 1;
  console.log('PASS', message);
}

async function get(path) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  return response.json();
}

const health = await get('/api/health');
assert.ok(health.network_exposure.loopback_only && health.data_dir.includes('record-crate-stage1'),
  'run against the prepared scratch library');
const { items } = await get('/api/crate?limit=20&sort=name');
const a = items.find(item => item.name === 'lead-fixture.wav');
const b = items.find(item => item.name === 'paper-lanterns.wav');
const partial = items.find(item => item.name === 'Crate Stage Partial.wav');
const raw = items.find(item => item.name === 'Crate Stage Unseparated.wav');
for (const track of [a, b]) {
  assert.equal(track?.stems.status, 'quad');
  assert.deepEqual(track.stems.roles, ['vocals', 'drums', 'bass', 'other']);
  assert.equal(track.stems.method, 'demucs');
}
assert.equal(partial?.stems.status, 'partial');
assert.deepEqual(partial.stems.roles, ['vocals', 'bass']);
assert.equal(raw?.stems.status, 'none');
assert.ok(raw.actions.includes('separate') && !raw.actions.includes('choose_A'));
const library = await get('/api/tracks?limit=20');
for (const track of [a, b, partial, raw]) assert.ok(library.items.some(row => row.id === track.track_id));
pass('HTTP 200 projects actual Library IDs and validated quad, partial and empty sets');

const browser = await chromium.launch({
  executablePath: resolveChromium(), headless: true,
  args: ['--mute-audio', '--disable-audio-output', '--disable-background-networking'],
});
try {
  for (const width of [1280, 390]) {
    const mobile = width === 390;
    const context = await browser.newContext({
      viewport: { width, height: mobile ? 844 : 800 }, hasTouch: mobile, serviceWorkers: 'block',
    });
    const unexpected = [];
    const responses = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base || /\/api\/(producer|imports|renders)(\/|$)/.test(url.pathname)) {
        unexpected.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const uncaught = [];
    const audio = [];
    const stemLists = [];
    page.on('pageerror', error => uncaught.push(error.message));
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/crate') responses.push(response.status());
    });
    page.on('request', request => {
      if (/\/api\/stems\/.*\/audio/.test(request.url())) audio.push(request.url());
      if (/\/api\/tracks\/[^/]+\/stems$/.test(request.url())) stemLists.push(request.url());
    });
    await page.addInitScript(() => {
      const Original = window.AudioContext;
      window.deskContexts = 0;
      window.AudioContext = class extends Original {
        constructor(...options) {
          super(...options);
          window.deskContexts += 1;
        }
      };
    });
    const started = Date.now();
    await page.goto(base + '/#/studio');
    const desk = page.locator('.stem-desk');
    // The Producer/Crate rail lives in the shell sidebar (wide) or under the desk (narrow).
    const studio = page.locator('.stem-desk, .workspace-sidebar');
    const panel = page.locator('.record-crate');
    const crateTab = studio.getByRole('tab', { name: 'Crate', exact: true });
    const headingButton = desk.getByRole('button', { name: 'Crate', exact: true });
    const open = () => mobile ? headingButton.tap() : crateTab.click();
    const search = panel.getByRole('searchbox', { name: 'Search the Library' });
    const row = track => panel.locator(`.record-crate__row[data-track-id="${track.track_id}"]`);
    const toggle = track => row(track).locator('.record-crate__item');
    const button = name => studio.getByRole('button', { name, exact: true });
    await desk.waitFor();
    const deskReadyMs = Date.now() - started;
    assert.deepEqual(responses, []);
    const opened = Date.now();
    await open();
    await row(partial).waitFor();
    console.log(`${width}px desk available in ${deskReadyMs} ms, first Crate results in ${Date.now() - opened} ms`);
    assert.match(await row(partial).innerText(), /2 of 4 stems/);
    assert.doesNotMatch(await row(partial).innerText(), /Stems ready/);
    assert.match(await row(a).innerText(), /Stems ready · Demucs 4/);
    assert.equal(await panel.getAttribute('data-source'), 'projection');
    assert.equal(await search.evaluate(node => node === document.activeElement), mobile);
    const result = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/crate' && url.searchParams.get('q') === 'paper-lanterns';
    });
    await search.fill('paper-lanterns');
    const filtered = await result;
    assert.equal(filtered.status(), 200);
    assert.deepEqual((await filtered.json()).items.map(item => item.track_id), [b.track_id]);
    await row(a).waitFor({ state: 'hidden' });
    await search.fill('');
    await row(a).waitFor();
    assert.deepEqual(stemLists, [], 'catalogue search never fans out to per-track stem reads');
    assert.doesNotMatch(await row(a).innerText(), /Selected for|On A|On B/);
    assert.doesNotMatch(await row(b).innerText(), /Selected for|On A|On B/);
    pass(`${width}px renders readiness and search results from real catalogue responses`);

    // Load B first, then A. The renderer must still mount A before B.
    for (const [bank, track] of [['B', b], ['A', a]]) {
      const requestCount = audio.length;
      const before = await page.evaluate(() => window.deskContexts);
      await toggle(track).click();
      const choose = row(track).getByRole('button', { name: `Choose for ${bank}, ${track.name}` });
      await choose.press('Enter');
      const load = row(track).getByRole('button', { name: `Load ${bank}, ${track.name}` });
      await page.waitForFunction(({ bank, id }) =>
        document.querySelector(`select[aria-label="Track for group ${bank}"]`).value === id, { bank, id: track.track_id });
      assert.equal(audio.length, requestCount);
      assert.equal(await page.evaluate(() => window.deskContexts), before);
      assert.match(await row(track).innerText(), new RegExp(`Selected for ${bank}`));
      await load.press('Enter');
      await page.waitForFunction(bank => document.querySelectorAll(
        `.stem-desk__group[data-group="${bank}"] .stem-desk__row`).length === 4, bank);
      assert.match(await row(track).innerText(), new RegExp(`On ${bank}`));
    }
    assert.equal(audio.length, 8);
    assert.equal(await page.evaluate(() => window.deskContexts), 1);
    const positions = await desk.locator('.stem-desk__group').evaluateAll(nodes => nodes.map(node => {
      const { x, y } = node.getBoundingClientRect();
      return { bank: node.dataset.group, x, y };
    }));
    assert.deepEqual(positions.map(({ bank }) => bank), ['A', 'B']);
    assert.ok(mobile ? positions[0].y < positions[1].y : positions[0].x < positions[1].x);
    pass(`${width}px loads eight lanes in one context and orders A/B after selecting without audio`);

    if (mobile) {
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog', { name: 'Producer & Crate' }).count(), 0);
      assert.ok(await headingButton.evaluate(node => node === document.activeElement));
    } else {
      const expand = button('Expand');
      await expand.press('Enter');
      assert.ok(await search.evaluate(node => node === document.activeElement));
      assert.equal(Math.round((await studio.locator('.desk-rail__crate').boundingBox()).width), 430);
      await page.keyboard.press('Escape');
      assert.ok(await expand.evaluate(node => node === document.activeElement));
    }
    pass(`${width}px Crate panel closes with focus returned`);
    await button('Play').click();
    await page.waitForFunction(() => document.querySelector('.stem-desk__transport').dataset.playing === 'true');
    await button('Mute A · Drums').click();
    assert.equal(await button('Mute A · Drums').getAttribute('aria-pressed'), 'true');
    await button('Stop').click();
    assert.equal(await desk.locator('.stem-desk__transport').getAttribute('data-playing'), 'false');
    pass(`${width}px eight-lane Play, mute and shared Stop work`);

    if (!mobile) {
      const producer = studio.getByRole('tab', { name: 'Producer' });
      await producer.click();
      await button('Ask for a proposal').click();
      await button('Hear it').click();
      await open();
      assert.match(await studio.locator('.desk-rail__idea').innerText(), /Hearing the Producer/);
      await button('Show Producer').click();
      assert.ok(await button('Hear mine').isVisible());
      await button('Keep it').click();
      await open();
      assert.match(await studio.locator('.desk-rail__idea').innerText(), /Undo/);
      await button('Show Producer').click();
      await button('Undo').click();
      assert.equal(await button('Mute A · Drums').getAttribute('aria-pressed'), 'true');
      pass('Producer audition and kept Undo survive Crate tab changes');

      await open();
      await toggle(raw).click();
      assert.ok(await row(raw).getByRole('button', { name: `Choose for A, ${raw.name}` }).isDisabled());
      const posted = page.waitForResponse(response =>
        response.request().method() === 'POST' && response.url().endsWith(`/api/tracks/${raw.track_id}/separations`));
      await row(raw).getByRole('button', { name: `Separate stems, ${raw.name}` }).click();
      const response = await posted;
      assert.equal(response.status(), 202, await response.text());
      assert.deepEqual(response.request().postDataJSON(), { method: 'demucs' });
      const job = await response.json();
      const deadline = Date.now() + 90_000;
      let finalJob;
      while (Date.now() < deadline) {
        finalJob = await get(`/api/jobs/${job.id}`);
        if (!['queued', 'running'].includes(finalJob.status)) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.equal(finalJob?.status, 'complete', JSON.stringify(finalJob));
      assert.equal((await get('/api/crate?q=Crate%20Stage%20Unseparated')).items[0].stems.status, 'quad');
      await row(raw).locator('.record-crate__badge--ready').waitFor();
      pass(`existing HTTP job ${job.id} completed and the catalogue supplied verified readiness`);
    }

    assert.ok(responses.length && responses.every(code => code === 200), JSON.stringify(responses));
    assert.deepEqual(unexpected, []);
    assert.deepEqual(uncaught, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`${passed} live Crate checks passed`);
