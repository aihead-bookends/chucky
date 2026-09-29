// Local stand-in for Vercel: serves public/ and routes /api/* to the same handler files Vercel deploys
// (filesystem routing, [param] segments included), so what runs here is what ships.
//
//   npm run dev              http://localhost:3000, and every device on the same Wi-Fi (it prints the address)
//   npm run dev:local        this computer only
//   npm run dev -- --port 4000
//
// Storage: a JSON file in .data/ — unless Upstash env vars are set, in which case the real database.
// Keys: read from .env; any that are missing get a printed local-only default.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setStore, getStore } from '../api/_lib/store.mjs';
import { fileStore } from './filestore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const MAX_REQUEST = 5 * 1024 * 1024;   // Vercel's own cap is 4.5MB; the routes clamp far lower

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

// /api/menu-state/capiche -> api/menu-state/[editor].mjs, mirroring Vercel. Segments starting with
// '_' or '.' are never routable, so api/_lib/* stays private here as it does on Vercel.
function resolveApi(pathname) {
  const segs = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  if (!segs.length || segs.some((s) => s.startsWith('_') || s.startsWith('.'))) return null;
  let dir = API;
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const dynamic = (want) => entries.find((e) => /^\[[^\]]+\]/.test(e) && want(e));
    if (last) {
      const hit = entries.includes(segs[i] + '.mjs') ? segs[i] + '.mjs' : dynamic((e) => e.endsWith('.mjs'));
      return hit ? path.join(dir, hit) : null;
    }
    const sub = entries.includes(segs[i]) ? segs[i] : dynamic((e) => !path.extname(e));
    if (!sub) return null;
    dir = path.join(dir, sub);
  }
  return null;
}

const modules = new Map();
const loadHandler = async (file) => {
  if (!modules.has(file)) modules.set(file, import(pathToFileURL(file).href));
  return (await modules.get(file)).default;
};

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_REQUEST) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const file = resolveApi(url.pathname);
  if (!file) return sendJson(res, 404, { ok: false, error: 'no such route' });
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readRequestBody(req);
  const request = new Request(url, { method: req.method, headers: req.headers, body });
  const response = await (await loadHandler(file))(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  if (LOG) logRequest(req, url, response.status);
}

// One line per API call in the server window — which device, what, and the answer — so "Publish
// did nothing" can be told apart from "Publish was refused" and "Publish never arrived".
let LOG = false;   // on when run as `npm run dev`; off when the tests start the server
const MEANING = { 200: 'ok', 204: 'ok', 400: 'bad request', 403: 'wrong or missing key', 404: 'nothing there',
  409: 'refused: someone published a newer menu', 413: 'too large', 502: 'storage failed', 503: 'no storage' };
function logRequest(req, url, status) {
  if (url.pathname === '/api/health') return;
  const who = (req.socket.remoteAddress || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  const ua = req.headers['user-agent'] || '';
  const device = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : 'other';
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const what = req.method === 'POST' && url.pathname.startsWith('/api/menu-state/') ? 'PUBLISH ' + url.pathname.slice(16) : `${req.method} ${url.pathname}${url.search}`;
  console.log(`  ${time}  ${who.padEnd(15)} ${device.padEnd(11)} ${what}  →  ${status} ${MEANING[status] || ''}`);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file, status = 200, method = 'GET') {
  res.writeHead(status, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const file = path.resolve(PUBLIC, '.' + path.posix.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }

  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(308, { location: url.pathname + '/' + url.search }); return res.end(); }
    const index = path.join(file, 'index.html');
    if (fs.existsSync(index)) return sendFile(res, index, 200, req.method);
    stat = null;
  }
  if (stat?.isFile()) return sendFile(res, file, 200, req.method);
  const notFound = path.join(PUBLIC, '404.html');
  if (fs.existsSync(notFound)) return sendFile(res, notFound, 404, req.method);
  res.writeHead(404); res.end('not found');
}

export function createDevServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else handleStatic(req, res, url);
    } catch (e) {
      console.error(req.method, url.pathname, e);
      if (!res.headersSent) sendJson(res, e.status || 500, { ok: false, error: e.status ? String(e.message) : 'dev server error' });
      else res.end();
    }
  });
}

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function main() {
  const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
  const port = Number(arg('port', process.env.PORT || 3000));
  // on the network by default, so phones on the same Wi-Fi can open it; --local for this computer only
  const host = process.argv.includes('--local') ? '127.0.0.1' : arg('host', process.env.HOST || '0.0.0.0');

  loadDotEnv(path.join(ROOT, '.env'));
  const defaulted = [];
  for (const [name, value] of [['BUG_KEY', 'dev-bug-key'], ['PUBLISH_KEY', 'dev-publish-key']]) {
    if (!process.env[name]) { process.env[name] = value; defaulted.push(`${name}=${value}`); }
  }
  // --data <folder> keeps a separate store (tests use this, so they never touch your .data)
  const dataDir = path.resolve(ROOT, arg('data', '.data'));
  if (!getStore()) setStore(fileStore(path.join(dataDir, 'store.json')));

  LOG = true;
  const server = createDevServer();
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `\n  Port ${port} is already in use — another server is running. Stop it (Ctrl+C in its window), or add --port ${port + 1}.\n`
      : e);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const lan = host === '0.0.0.0';
    console.log(`\n  Chucky dev server`);
    console.log(`    this computer:   http://localhost:${port}/`);
    if (lan) {
      // every address other devices could use; Wi-Fi first, since that's what phones are on
      const addrs = Object.entries(os.networkInterfaces())
        .flatMap(([name, list]) => (list || []).filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map((a) => ({ name, address: a.address })))
        .sort((a, b) => /wi-?fi|wlan|wireless/i.test(b.name) - /wi-?fi|wlan|wireless/i.test(a.name));
      for (const a of addrs) console.log(`    other devices:   http://${a.address}:${port}/   (${a.name})`);
      console.log('    (phones must be on the same Wi-Fi as this computer)');
    } else {
      console.log('    other devices:   not reachable — this address works on this computer only.');
      console.log('                     For phones on the same Wi-Fi, run:  npm run dev');
    }
    console.log(`  storage: ${getStore().kind === 'file' ? path.relative(ROOT, path.join(dataDir, 'store.json')) + ' (local file)' : 'Upstash Redis (from env)'}`);
    console.log(`  publish key: ${process.env.PUBLISH_KEY}   (the Publish button asks for it once on each device)`);
    if (defaulted.length) console.log(`  local-only keys (set real ones in .env): ${defaulted.join('  ')}`);
    console.log('\n  Requests (publish, load, bug reports) appear below:\n');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
