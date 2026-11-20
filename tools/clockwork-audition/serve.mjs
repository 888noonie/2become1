#!/usr/bin/env node
// tools/clockwork-audition/serve.mjs — loopback-only static server for the C1
// owner audition page (OPERATION THE GOLDEN EAR II).
//
//   node tools/clockwork-audition/serve.mjs
//   -> http://127.0.0.1:8777/tools/clockwork-audition/
//
// Serves this checkout read-only (GET/HEAD only) on 127.0.0.1. It does not open
// a browser, start audio, touch the Studio on :8765, or read
// ~/.local/share/2become1. Ctrl-C stops it.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.AUDITION_PORT ?? 8777);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
};
const ALLOWED = ['/tools/clockwork-audition/', '/src/twobecomeone/studio_static/'];

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/' || urlPath === '/tools/clockwork-audition') urlPath = '/tools/clockwork-audition/';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  const rel = `/${path.relative(ROOT, file)}`;
  if (!file.startsWith(ROOT) || !ALLOWED.some((p) => rel.startsWith(p)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Clockwork audition: http://${HOST}:${PORT}/tools/clockwork-audition/`);
  console.log('Loopback only. Opening the page plays nothing; press Play to start, Esc to stop.');
});
