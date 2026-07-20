import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { pool, platformPool } from './db.js';
import { authRoutes } from './routes/authRoutes.js';
import { leadsRoutes } from './routes/leadsRoutes.js';
import { metaRoutes } from './routes/metaRoutes.js';
import { usersRoutes } from './routes/usersRoutes.js';

// trustProxy MUST be a hop count, not `true`. nginx sets
// `X-Forwarded-For: $proxy_add_x_forwarded_for`, which APPENDS the real peer to
// whatever the client sent — so `true` (trust every hop) resolves req.ip to the
// leftmost, ATTACKER-CONTROLLED entry. That let a single spoofed header rotate
// the rate-limit key and walk straight through the 5/min login cap (verified:
// 8/8 spoofed attempts passed vs 429 at attempt 6 for an honest client), and it
// let the attacker forge audit_logs.ip_address. `1` trusts exactly one hop —
// our nginx — so req.ip is the real peer.
const app = Fastify({ logger: true, trustProxy: 1 });

// Security headers on every API response (nosniff, frame-deny, HSTS, no-referrer).
// CSP is left to nginx, which serves the HTML the browser actually renders.
await app.register(helmet, { contentSecurityPolicy: false });

// Rate limiting — blunts brute force and abuse. Auth routes get a tighter cap
// applied per-route (see authRoutes). This is the global default.
await app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  // @fastify/rate-limit THROWS whatever this returns. A plain object carries no
  // `statusCode`, so the error handler below fell through to 500 — clients saw
  // "Internal server error" instead of 429, and every throttled bot scan logged
  // a bogus level:50 "unhandled error" with a correlation id, burying real
  // incidents. Throwing a real Error with ctx.statusCode restores the 429.
  errorResponseBuilder: (_req, ctx) => Object.assign(
    new Error('Too many requests — slow down and try again shortly.'),
    { statusCode: ctx.statusCode },
  ),
});

// Never leak DB/internal error text to clients — log it against a correlation
// id, return a generic 500. 4xx errors we raised ourselves pass through.
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) {
    const correlationId = randomUUID();
    req.log.error({ err, correlationId }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error', correlationId });
  }
  return reply.code(status).send({ error: err.message });
});

// CORS_ORIGIN accepts a comma-separated list (app + admin subdomains, previews)
await app.register(cors, { origin: env.corsOrigin.split(',').map(o => o.trim()) });
await app.register(authRoutes);
await app.register(leadsRoutes);
await app.register(metaRoutes);
await app.register(usersRoutes);

app.get('/api/health', async () => {
  const { rows: [r] } = await pool.query('SELECT 1 AS ok');
  return { ok: r.ok === 1, service: 'friendly-crm-api' };
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  await platformPool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.port, host: '0.0.0.0' });
