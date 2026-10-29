// Local development server: serves public/ and runs the same API code as Netlify, with an
// in-memory store. Demo mode (no API key) and sign-in links are shown on screen instead of emailed.
//   npm run dev          → http://localhost:8888
//   ANTHROPIC_API_KEY=sk-ant-... npm run dev   → live AI
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/app.js';
import { buildDeps } from '../src/runtime.js';
import { memoryStore } from '../src/store.js';

const PORT = Number(process.env.PORT ?? 8888);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const env = { DEV_LOGIN_LINKS: '1', SITE_URL: `http://localhost:${PORT}`, ...process.env };
const deps = { ...buildDeps(env), store: memoryStore() };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    // Browsers drop "Secure" cookies on plain http except on localhost, so this works locally.
    const response = await handle(request, { ...deps, ip: req.socket.remoteAddress ?? 'local' });
    const headers = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  try {
    const file = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`EngineCheckLight dev server: http://localhost:${PORT} (${deps.env.LIVE === '1' ? 'live AI' : 'demo mode'})`));
