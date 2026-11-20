import { createRequire } from 'node:module';
const require = createRequire('/home/richardn/MISIX-worktrees/all-the-time/package.json');
const { chromium } = require('playwright-core');
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const REPO = '/home/richardn/MISIX-worktrees/all-the-time';
const EXP = path.dirname(new URL(import.meta.url).pathname);
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const root = p.startsWith('/exp/') ? EXP : REPO;
  const file = path.normalize(path.join(root, p.startsWith('/exp/') ? p.slice(4) : p));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': /\.(m?js)$/.test(file) ? 'text/javascript' : 'text/html' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => console.error('[page]', m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/exp/probe.html`);
const res = await page.waitForFunction(() => window.__done, null, { timeout: 300000 }).then(() => page.evaluate(() => window.__results));
writeFileSync(path.join(EXP, 'probe-results.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
await browser.close(); server.close();
