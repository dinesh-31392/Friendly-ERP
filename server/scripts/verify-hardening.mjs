/**
 * Boot-time hardening checks. Runs in-process against the real dependencies —
 * no database required. Each case pins a defect found in the July 2026 audit so
 * it cannot silently regress.
 *
 *   npm run verify:hardening
 */
import assert from 'node:assert/strict';

const GOOD_SECRET = 'x'.repeat(48);
const baseEnv = {
  DATABASE_URL: 'postgres://app_user:p@localhost:5432/friendly_crm',
  DATABASE_PLATFORM_URL: 'postgres://app_platform:p@localhost:5432/friendly_crm',
  JWT_SECRET: GOOD_SECRET,
};
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([true, name]); console.log(`✅ ${name}`); }
  catch (e) { results.push([false, name]); console.log(`❌ ${name}\n   ${e.message}`); }
};

// Load ./src/env.ts fresh with a given process.env
const loadEnv = async (overrides) => {
  Object.assign(process.env, baseEnv, overrides);
  const mod = await import(`../dist/src/env.js?bust=${Math.random()}`);
  return mod.env;
};

// ── 1. JWT_SECRET must reject the shipped placeholder ────────────────────────
await check('JWT_SECRET rejects the .env.production.example placeholder', async () => {
  await assert.rejects(
    () => loadEnv({ JWT_SECRET: 'CHANGE_ME_min_32_chars_random_string!!' }),
    /placeholder/i,
    'a copy-pasted placeholder secret must not boot',
  );
});

// ── 2. JWT_SECRET must reject a short secret ─────────────────────────────────
await check('JWT_SECRET rejects a too-short secret', async () => {
  await assert.rejects(() => loadEnv({ JWT_SECRET: 'short' }), /at least 32/i);
});

// ── 3. PORT must reject non-numeric (NaN -> Node binds a random port) ────────
await check('PORT rejects a non-numeric value', async () => {
  await assert.rejects(() => loadEnv({ PORT: 'abc' }), /integer/i);
});

// ── 4. A valid config boots ──────────────────────────────────────────────────
await check('valid config loads', async () => {
  const env = await loadEnv({ PORT: '4000' });
  assert.equal(env.port, 4000);
  assert.equal(env.jwtSecret, GOOD_SECRET);
});

// ── 5. Both pools must have an 'error' listener ──────────────────────────────
// Without one, pg-pool's emit on an idle-client error is an uncaught exception
// and the API dies whenever Postgres restarts — with zero traffic.
await check("both pg pools register an 'error' listener", async () => {
  delete process.env.PORT;
  Object.assign(process.env, baseEnv);
  const db = await import(`../dist/src/db.js?bust=${Math.random()}`);
  assert.ok(db.pool.listenerCount('error') > 0, 'RLS pool has no error listener');
  assert.ok(db.platformPool.listenerCount('error') > 0, 'platform pool has no error listener');
  // Emitting must not throw now that a listener exists.
  db.pool.emit('error', new Error('simulated idle client failure'));
  db.platformPool.emit('error', new Error('simulated idle client failure'));
  await db.pool.end(); await db.platformPool.end();
});

// ── 6. Rate limiting must answer 429, not 500 ────────────────────────────────
await check('rate limiter returns 429 (not 500) and keeps its message', async () => {
  const Fastify = (await import('fastify')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  const app = Fastify({ logger: false, trustProxy: 1 });
  await app.register(rateLimit, {
    global: true, max: 2, timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => Object.assign(
      new Error('Too many requests — slow down and try again shortly.'),
      { statusCode: ctx.statusCode },
    ),
  });
  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });
  app.get('/t', async () => ({ ok: true }));
  await app.ready();
  let last;
  for (let i = 0; i < 4; i++) last = await app.inject({ method: 'GET', url: '/t' });
  assert.equal(last.statusCode, 429, `expected 429, got ${last.statusCode}`);
  assert.match(last.json().error, /Too many requests/, 'custom message must reach the client');
  await app.close();
});

console.log('\n' + '='.repeat(60));
const failed = results.filter(([ok]) => !ok);
console.log(`${results.length - failed.length}/${results.length} hardening checks passed`);
process.exit(failed.length ? 1 : 0);
