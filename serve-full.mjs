/**
 * Friendly ERP — FULL local stack server (SPA + API proxy).
 *
 * Serves the built app (dist/) AND reverse-proxies /api/* to the Fastify backend
 * on 127.0.0.1:4000 — exactly like nginx does in production. Because the API is
 * same-origin (served through this port), there's no CORS, and it works from
 * other devices on your Wi-Fi too (their request hits this PC, which proxies to
 * the local backend + Postgres here).
 *
 * Requires: the DB (localdb/start-db.mjs) and the API (server, port 4000) running.
 *
 *   node serve-full.mjs           # port 8080
 */
import { createServer, request as httpRequest } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const API_TARGET = { host: '127.0.0.1', port: 4000 };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function proxyApi(req, res) {
  const proxyReq = httpRequest(
    { host: API_TARGET.host, port: API_TARGET.port, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => { res.writeHead(proxyRes.statusCode || 502, proxyRes.headers); proxyRes.pipe(res); },
  );
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API not reachable — is the backend (port 4000) running?' }));
  });
  req.pipe(proxyReq);
}

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // Same-origin API: forward to the Fastify backend.
  if (p === '/api' || p.startsWith('/api/')) return proxyApi(req, res);

  try {
    let file = join(ROOT, p === '/' ? '/index.html' : p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    let body, ext;
    try {
      const s = await stat(file); if (!s.isFile()) throw 0;
      body = await readFile(file); ext = extname(file);
    } catch {
      body = await readFile(join(ROOT, 'index.html')); ext = '.html';   // SPA fallback
    }
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (p === '/sw.js' || p === '/index.html') headers['Cache-Control'] = 'no-cache';
    else if (p.startsWith('/icons/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers); res.end(body);
  } catch (err) { res.writeHead(500); res.end('Server error'); console.error(err); }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') { console.error(`\n  Port ${PORT} in use. Try: node serve-full.mjs 9000\n`); process.exit(1); }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('\n  Friendly ERP (full stack: app + API + Postgres) is running.\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  lan.forEach((ip) => console.log(`  On your network:   http://${ip}:${PORT}`));
  console.log('\n  Proxying /api -> 127.0.0.1:4000. Ctrl+C to stop this server.\n');
});
