import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';
import { startOutboxWorker } from './autoReply.js';
import { pool, platformPool } from './db.js';
import { authRoutes } from './routes/authRoutes.js';
import { leadsRoutes } from './routes/leadsRoutes.js';
import { metaRoutes } from './routes/metaRoutes.js';
import { usersRoutes } from './routes/usersRoutes.js';
import { projectsRoutes } from './routes/projectsRoutes.js';
import { inventoryRoutes } from './routes/inventoryRoutes.js';
import { bookingsRoutes } from './routes/bookingsRoutes.js';
import { documentsRoutes } from './routes/documentsRoutes.js';
import { costSheetRoutes } from './routes/costSheetRoutes.js';
import { campaignsRoutes } from './routes/campaignsRoutes.js';
import { quotationsRoutes } from './routes/quotationsRoutes.js';
import { serviceRoutes } from './routes/serviceRoutes.js';
import { brokersRoutes } from './routes/brokersRoutes.js';
import { financeRoutes } from './routes/financeRoutes.js';
import { whatsappRoutes } from './routes/whatsappRoutes.js';
import { chatbotRoutes } from './routes/chatbotRoutes.js';
import { publicRoutes } from './routes/publicRoutes.js';
import { paymentsRoutes } from './routes/paymentsRoutes.js';
import { financeApRoutes } from './routes/financeApRoutes.js';
import { financeBankRoutes } from './routes/financeBankRoutes.js';
import { configRoutes } from './routes/configRoutes.js';
import { crmRoutes } from './routes/crmRoutes.js';
import { opsRoutes } from './routes/opsRoutes.js';
import { hrRoutes } from './routes/hrRoutes.js';
import { procurementRoutes } from './routes/procurementRoutes.js';
import { executionRoutes } from './routes/executionRoutes.js';
import { complianceRoutes } from './routes/complianceRoutes.js';
import { landBdRoutes } from './routes/landBdRoutes.js';
import { branchCallRoutes } from './routes/branchCallRoutes.js';
import { tenantRoutes } from './routes/tenantRoutes.js';
import { invoiceRoutes } from './routes/invoiceRoutes.js';
import { crmTaskRoutes } from './routes/crmTaskRoutes.js';
import { portalRoutes } from './routes/portalRoutes.js';
import { notificationsRoutes } from './routes/notificationsRoutes.js';
import { demandRoutes } from './routes/demandRoutes.js';
import { reraRoutes } from './routes/reraRoutes.js';
import { siteVisitRoutes } from './routes/siteVisitRoutes.js';
import { leasingRoutes } from './routes/leasingRoutes.js';
import { ownerPayoutsRoutes } from './routes/ownerPayoutsRoutes.js';
// Used by the rate limiter to key on identity rather than address.
import { verifyToken } from './auth.js';

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

/**
 * Multipart, for the document upload route.
 *
 * `attachFieldsToBody` is deliberately OFF: it buffers the whole file into
 * memory before a handler sees it, which turns a 25 MB upload into 25 MB of
 * heap per concurrent request. The route consumes `req.file()` as a stream and
 * writes it to disk as it arrives, so the process holds a chunk, not a file.
 *
 * The size ceiling is set per-request by the route (MAX_UPLOAD_BYTES) so the
 * transport aborts an oversized body mid-flight instead of accepting it and
 * rejecting it afterwards.
 */
await app.register(multipart);

/**
 * Rate limiting, keyed by WHO rather than by where they are sitting.
 *
 * The default key is the IP, which is wrong for this product. A builder's
 * sales team shares one office and therefore one public address, so ten reps
 * doing ordinary work spend a single 120/min budget between them and the app
 * starts returning 429 for no reason the user can see. The opposite also
 * failed: one tenant's runaway integration could not be throttled without
 * throttling everyone else behind that address.
 *
 * So an authenticated request is keyed on tenant + user, and each person gets
 * their own budget. Anything unauthenticated — login, the public chatbot,
 * portal sign-in — still keys on IP, because that is where brute force lives
 * and there is no identity to key on yet.
 *
 * The token is VERIFIED here, not merely decoded. A decoded-only key would let
 * anyone mint a fresh bucket per request by inventing a `sub`, which is a
 * rate limiter that does nothing.
 */
await app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      try {
        const claims = verifyToken(header.slice(7));
        return `u:${claims.tid}:${claims.sub}`;
      } catch {
        // Expired or forged: fall through to IP so a stream of bad tokens is
        // still throttled rather than being handed an unlimited bucket.
      }
    }
    return `ip:${req.ip}`;
  },
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
/**
 * Accept an empty body on a JSON request.
 *
 * Fastify's default parser rejects `Content-Type: application/json` with a
 * zero-length body as a 400. That is defensible in the abstract and wrong in
 * practice: a browser `fetch` that sets JSON headers for every call — which is
 * what the SPA's api client does — cannot POST to an endpoint that takes no
 * arguments. Sign-out was the first such endpoint and returned 400 for every
 * caller until this existed.
 *
 * An empty body becomes `{}`, so a route that genuinely requires fields still
 * fails at schema validation with a message naming them, rather than at the
 * parser with one that does not.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
  if (body === '' || body === undefined) return done(null, {});
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    (err as Error & { statusCode?: number }).statusCode = 400;
    done(err as Error, undefined);
  }
});

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  // A revoked session is a 401, not a 500. It surfaces as a thrown error rather
  // than a reply because the check runs inside withTenantContext, after the
  // transaction has opened — throwing is what rolls it back.
  if (err.name === 'RevokedSessionError') {
    return reply.code(401).send({ error: 'Session is no longer valid' });
  }
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
await app.register(projectsRoutes);
await app.register(inventoryRoutes);
await app.register(bookingsRoutes);
await app.register(documentsRoutes);
await app.register(costSheetRoutes);
await app.register(campaignsRoutes);
await app.register(quotationsRoutes);
await app.register(serviceRoutes);
await app.register(brokersRoutes);
await app.register(financeRoutes);
await app.register(whatsappRoutes);
await app.register(chatbotRoutes);
await app.register(publicRoutes);
await app.register(paymentsRoutes);
await app.register(financeApRoutes);
await app.register(financeBankRoutes);
await app.register(configRoutes);
await app.register(crmRoutes);
await app.register(opsRoutes);
await app.register(hrRoutes);
await app.register(procurementRoutes);
await app.register(executionRoutes);
await app.register(complianceRoutes);
await app.register(landBdRoutes);
await app.register(branchCallRoutes);
await app.register(tenantRoutes);
await app.register(invoiceRoutes);
await app.register(crmTaskRoutes);
await app.register(portalRoutes);
await app.register(notificationsRoutes);
await app.register(demandRoutes);
await app.register(reraRoutes);
await app.register(siteVisitRoutes);
await app.register(leasingRoutes);
await app.register(ownerPayoutsRoutes);

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

// Queued WhatsApp auto-replies carry a time promise (20-60s), so something has
// to tick — page-triggered drains alone would leave a greeting waiting until
// someone happened to open the inbox. WHATSAPP_WORKER=off disables it.
startOutboxWorker(app.log);
