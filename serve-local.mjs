/**
 * Friendly ERP — local server.
 *
 * Serves the built app (dist/) on your PC with no dependencies — just Node.
 * Mirrors the production nginx behaviour: SPA fallback, correct MIME types, and
 * no-cache on the app shell + service worker so updates land. localhost is a
 * secure context, so the installable-app / offline features work here too.
 *
 *   node serve-local.mjs            # port 8080
 *   node serve-local.mjs 9000       # custom port
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, p);

    // Keep requests inside dist/ (no path traversal).
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

    let body, ext;
    try {
      const s = await stat(file);
      if (!s.isFile()) throw 0;
      body = await readFile(file);
      ext = extname(file);
    } catch {
      // SPA fallback: unknown paths serve the app shell so client routes work.
      body = await readFile(join(ROOT, 'index.html'));
      ext = '.html';
    }

    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (p === '/sw.js' || p === '/index.html') headers['Cache-Control'] = 'no-cache';
    else if (p.startsWith('/icons/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';

    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error');
    console.error(err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node serve-local.mjs 9000\n`);
    process.exit(1);
  }
  throw err;
});

// Bind to all interfaces so it also works from other devices on your network
// (phone/tablet) via this PC's LAN address.
server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('\n  Friendly ERP is running.\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  lan.forEach((ip) => console.log(`  On your network:   http://${ip}:${PORT}   (phone/tablet on the same Wi-Fi)`));
  console.log('\n  Press Ctrl+C to stop.\n');
});
