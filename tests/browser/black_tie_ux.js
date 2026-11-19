import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.js';
// Run the real app with two prepared, four-stem tracks before capturing.
const [out, base = 'http://127.0.0.1:8766'] = process.argv.slice(2);
if (!out) throw new Error('Usage: node tests/browser/black_tie_ux.js OUT [BASE_URL]');
const baseline = process.env.SILK_TIE_BASELINE === '1';
await mkdir(out, { recursive: true });
const tracks = (await (await fetch(base + '/api/tracks')).json()).items;
const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
const checks = [];
try {
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width <= 768 });
    const errors = [];
    await page.emulateMedia({ reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    const save = (name, fullPage = true) => page.screenshot({
      path: `${out}/${width}-${name}.png`, fullPage, animations: 'disabled',
    });
    const check = async name => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      checks.push({ width, name, overflow });
    };
    await page.goto(base+'/#/library');
    await page.locator('.track-card').first().waitFor();
    await check('library');
    await save('library');
    if ([1440,390].includes(width)) {
      const add = page.locator('.library-add');
      await add.click();
      const dialog = page.locator('dialog[open]');
      for (const name of ['Library','Upload','YouTube']) {
        await dialog.getByRole('tab',{name,exact:true}).click();
        await save('add-' + name, false);
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      const addFocusRestored = await add.evaluate((el) => el === document.activeElement);
      assert.ok(addFocusRestored, 'Escape returns focus to Add a track');
      checks.push({ width, addFocusRestored });
      if (!baseline) {
        await add.click();
        await dialog.getByRole('tab', { name: 'Library' }).focus();
        await page.keyboard.press('End');
        assert.equal(await dialog.getByRole('tab', { name: 'YouTube' }).getAttribute('aria-selected'), 'true');
        await page.keyboard.press('ArrowRight');
        assert.equal(await dialog.getByRole('tab', { name: 'Library' }).getAttribute('aria-selected'), 'true');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      }
      const rename = page.locator('[data-action=rename]').first();
      await rename.click();
      await save('rename', false);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.ok(await rename.evaluate((el) => el === document.activeElement));
      for (const route of ['activity','engine']) {
        await page.goto(base+'/#/'+route);
        await page.waitForTimeout(300);
        await check(route);
        await save(route);
      }
    }
    await page.goto(base+'/#/studio');
    const desk = page.locator('.stem-desk');
    await desk.waitFor();
    await check('studio-empty');
    await save('studio');
    const started = Date.now();
    for (const [index, group] of ['A', 'B'].entries()) {
      const track = page.getByLabel('Track for group '+group,{exact:true});
      await track.focus();
      await page.waitForFunction(label => document.querySelector('select[aria-label="'+label+'"]').options.length > 1, 'Track for group '+group);
      await track.selectOption(tracks[index].id);
      const options = desk.locator('.source-options summary').nth(index);
      if (await options.count()) await options.click();
      const duration = page.getByLabel('Section for group '+group);
      await duration.selectOption('30');
      if (group==='A' && [1440,390].includes(width)) {
        await desk.getByRole('button',{name:'Import My Stems for group A'}).click();
        await save('import-stems', false);
        await page.keyboard.press('Escape');
        await page.locator('dialog[open]').waitFor({state:'hidden'});
        await duration.focus();
        await page.keyboard.press('ArrowUp');
        assert.equal(await duration.inputValue(),'60');
        await duration.selectOption('30');
        const memory = desk.locator('.stem-desk__memory summary');
        if (!baseline) await memory.click();
        await desk.screenshot({ path: out + '/' + width + '-section.png' });
        if (!baseline) await memory.click();
      }
      if (await options.count()) await options.click();
      await page.getByRole('button',{name:'Load stems '+group}).click();
      await page.waitForFunction(g=>document.querySelectorAll('.stem-desk__group[data-group="'+g+'"] .stem-desk__row').length===4,group,{timeout:75000});
    }
    assert.equal(await desk.locator('.stem-desk__row').count(), 8);
    checks.push({ width, bothTracksLoadedMs: Date.now() - started, includesDialogChecks: [1440, 390].includes(width) });
    const frameTimes = await page.evaluate(async () => {
      const gain = document.querySelector('.stem-desk__row input[type="range"]');
      const samples = [];
      for (let n = 0; n < 20; n++) {
        await new Promise(requestAnimationFrame);
        const start = performance.now();
        gain.value = String(-(n % 2));
        gain.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(requestAnimationFrame);
        samples.push(performance.now() - start);
      }
      gain.value = '0';
      gain.dispatchEvent(new Event('input', { bubbles: true }));
      return samples.sort((a, b) => a - b);
    });
    checks.push({ width, laneInputFrameMs: { median: frameTimes[10], p95: frameTimes[18] } });
    await check('eight-stem');
    await page.evaluate(() => scrollTo(0, 0));
    await save('console', false);
    await desk.screenshot({path:out+'/'+width+'-eight-stems.png'});
    if (!baseline) {
      if (width === 768) {
        const targets = desk.locator('.stem-desk__lane-controls button');
        assert.ok(await targets.evaluateAll(buttons => buttons.every(button =>
          button.offsetWidth >= 44 && button.offsetHeight >= 44)), 'tablet lane buttons meet the touch target');
      }
      const minimumWidth = async (selector) => desk.locator(selector).evaluateAll(
        (elements) => Math.min(...elements.map((el) => el.getBoundingClientRect().width)),
      );
      assert.ok(await desk.locator('.stem-desk__lane-controls input').evaluateAll(inputs => inputs.every(el => Math.max(el.offsetWidth, el.offsetHeight) >= 96)));
      assert.ok(await minimumWidth('.stem-desk__crossfader') >= 96);
      await page.locator('summary').filter({hasText:'Queue & advanced mixing'}).click();
      const eq = page.getByRole('group', { name: 'Deck A', exact: true }).getByRole('slider', { name: 'Low' });
      await eq.focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.activeElement?.value === '-1');
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.activeElement?.value === '-2');
      const mute = desk.getByRole('button', { name: 'Mute A · Vocals' });
      await mute.focus();
      await page.keyboard.press('Space');
      assert.equal(await mute.getAttribute('aria-pressed'), 'true');
      assert.ok(await mute.evaluate((el) => el === document.activeElement));
      await page.keyboard.press('Space');
      const gain = desk.getByRole('slider', { name: 'A · Vocals gain' });
      await gain.focus();
      if (width === 1440) await save('focus', false);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await gain.inputValue(), '-1');
      await page.keyboard.press('ArrowRight');
    }
    if ([1440,390].includes(width)) {
      await desk.getByRole('button',{name:'Ask for a proposal'}).click();
      await save('proposal', false);
      await desk.getByRole('button', { name: 'Preview', exact: true }).click();
      if (!baseline) {
        const details = desk.locator('.stem-desk__proposal-details');
        assert.match(await details.innerText(), /Crossfader at 50% toward B/);
        assert.match(await details.innerText(), /Group A · 0 dB · entry 0 ms/);
        assert.match(await details.innerText(), /Drums open, 0 dB/);
      }
      await desk.screenshot({path:out+'/'+width+'-preview.png'});
      await desk.getByRole('button',{name:'Approve',exact:true}).click();
      await desk.screenshot({path:out+'/'+width+'-approved.png'});
    }
    if (!baseline && width === 390) {
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      await check('200-percent-mobile-stress');
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
      for (const testWidth of [320, 561]) {
        await page.setViewportSize({ width: testWidth, height });
        await check(`reflow-${testWidth}`);
        const fader = await desk.locator('.stem-desk__crossfader').boundingBox();
        assert.ok(fader.width >= 96, `crossfader at ${testWidth}px is ${fader.width}px wide`);
        const laneWidths = await desk.locator('.stem-desk__lane-controls input')
          .evaluateAll((sliders) => sliders.map((slider) => slider.getBoundingClientRect().width));
        const narrowestLane = Math.min(...laneWidths);
        assert.ok(narrowestLane >= 96, `lane gain at ${testWidth}px is ${narrowestLane}px wide`);
        if (testWidth === 320) await save('320-reflow');
      }
      await page.setViewportSize({ width, height });
      await page.route('**/api/tracks?**', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const name = 'A long library track name with a detailed take description '.repeat(3).trim();
        if (data.items.length) Object.assign(data.items[0], { name, title: name });
        await route.fulfill({ response, json: data });
      });
      await page.goto(base + '/#/library');
      await page.reload();
      await page.locator('.track-card__title').filter({ hasText: 'A long library track name' }).waitFor();
      await check('long-name-library');
      await save('long-name-library');
      await page.goto(base + '/#/studio');
      const track = page.getByRole('combobox', { name: 'Track for group A', exact: true });
      await track.focus();
      await track.locator('option').filter({ hasText: 'A long library track name' }).waitFor({ state: 'attached' });
      await check('long-name-select');
      await save('long-name-select');
    }
    assert.deepEqual(errors, []);
    checks.push({ width, errors });
    await page.close();
    console.log(width+' captured');
  }
  assert.ok(checks.every((row) => !row.overflow || row.name === '200-percent-mobile-stress'));
} finally {
  await writeFile(`${out}/checks.json`, JSON.stringify(checks, null, 2));
  await browser.close();
}
