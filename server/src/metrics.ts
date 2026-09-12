import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool, platformPool } from './db.js';

/**
 * Metrics, in the one format every monitoring stack already reads.
 *
 * The product had `/api/health`, which answers "is the database reachable" and
 * nothing else. That is enough to restart a dead container and useless for the
 * failures that actually happen to this system: the pool saturating under a
 * report, one tenant's slow query dragging everyone's p99, a 500 rate climbing
 * for twenty minutes before a customer rings.
 *
 * Prometheus text format rather than a library. The exposition format is a
 * dozen lines of string building, and a dependency here would be one more thing
 * to keep current in a service whose whole appeal is that it deploys as one
 * Node process.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No tenant label on any series. Cardinality is the way a metrics endpoint
 * turns into an outage — one series per tenant per route per status multiplies
 * out to millions on a system that is meant to have thousands of workspaces —
 * and a per-tenant breakdown belongs in a query against the database, not in a
 * gauge scraped every fifteen seconds. Route labels use the ROUTE PATTERN
 * (/api/leads/:id), never the URL, for the same reason.
 */

/** Latency buckets in seconds. Chosen around what this API actually does: most
 *  reads land under 50 ms, a report is a second, and anything past ten is a
 *  bug rather than a slow day. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface RouteStat {
  count: number;
  sum: number;
  buckets: number[];
}

const byRoute = new Map<string, RouteStat>();
const byStatus = new Map<number, number>();
let inFlight = 0;
/** Requests that ended in a 5xx, kept separately so an alert can fire on the
 *  count without summing every status series. */
let serverErrors = 0;

const startedAt = Date.now();

function key(method: string, route: string): string {
  return `${method} ${route}`;
}

function observe(method: string, route: string, status: number, seconds: number): void {
  const k = key(method, route);
  let s = byRoute.get(k);
  if (!s) { s = { count: 0, sum: 0, buckets: new Array(BUCKETS.length).fill(0) }; byRoute.set(k, s); }
  s.count++;
  s.sum += seconds;
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) s.buckets[i]++;

  byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  if (status >= 500) serverErrors++;
}

/** Prometheus label values escape backslash, quote and newline — and a route
 *  pattern can contain none of those, which is exactly why patterns are used
 *  instead of URLs. Escaped anyway, because the day someone passes a raw URL
 *  in here should produce bad data, not a malformed scrape. */
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function render(): string {
  const out: string[] = [];
  const line = (s: string) => out.push(s);

  line('# HELP friendly_erp_up 1 when the process is serving.');
  line('# TYPE friendly_erp_up gauge');
  line('friendly_erp_up 1');

  line('# HELP friendly_erp_uptime_seconds Seconds since the process started.');
  line('# TYPE friendly_erp_uptime_seconds gauge');
  line(`friendly_erp_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(0)}`);

  line('# HELP friendly_erp_requests_in_flight Requests currently being served.');
  line('# TYPE friendly_erp_requests_in_flight gauge');
  line(`friendly_erp_requests_in_flight ${inFlight}`);

  line('# HELP friendly_erp_responses_total Responses by status code.');
  line('# TYPE friendly_erp_responses_total counter');
  for (const [status, n] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    line(`friendly_erp_responses_total{status="${status}"} ${n}`);
  }

  line('# HELP friendly_erp_server_errors_total Responses with a 5xx status.');
  line('# TYPE friendly_erp_server_errors_total counter');
  line(`friendly_erp_server_errors_total ${serverErrors}`);

  line('# HELP friendly_erp_request_duration_seconds Request latency by route.');
  line('# TYPE friendly_erp_request_duration_seconds histogram');
  for (const [k, s] of byRoute) {
    const sp = k.indexOf(' ');
    const labels = `method="${esc(k.slice(0, sp))}",route="${esc(k.slice(sp + 1))}"`;
    for (let i = 0; i < BUCKETS.length; i++) {
      line(`friendly_erp_request_duration_seconds_bucket{${labels},le="${BUCKETS[i]}"} ${s.buckets[i]}`);
    }
    line(`friendly_erp_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.count}`);
    line(`friendly_erp_request_duration_seconds_sum{${labels}} ${s.sum.toFixed(6)}`);
    line(`friendly_erp_request_duration_seconds_count{${labels}} ${s.count}`);
  }

  // The pool is the resource this service actually runs out of. `waiting` above
  // zero for any sustained period means requests are queueing for a connection,
  // which presents to a user as the whole app being slow rather than one page.
  //
  // Prometheus wants all samples of a metric together, so the three gauges are
  // emitted one metric at a time rather than one pool at a time.
  const pools = [['app', pool], ['platform', platformPool]] as const;
  for (const [metric, help, read] of [
    ['total',   'Connections held by each pool.',            (p: typeof pool) => p.totalCount],
    ['idle',    'Connections in each pool sitting idle.',    (p: typeof pool) => p.idleCount],
    ['waiting', 'Requests queued for a connection. Sustained above zero is the '
              + 'failure that presents as the whole app being slow.',
                                                             (p: typeof pool) => p.waitingCount],
  ] as const) {
    line(`# HELP friendly_erp_db_pool_${metric} ${help}`);
    line(`# TYPE friendly_erp_db_pool_${metric} gauge`);
    for (const [name, p] of pools) line(`friendly_erp_db_pool_${metric}{pool="${name}"} ${read(p)}`);
  }

  const mem = process.memoryUsage();
  line('# HELP friendly_erp_memory_bytes Process memory.');
  line('# TYPE friendly_erp_memory_bytes gauge');
  line(`friendly_erp_memory_bytes{kind="rss"} ${mem.rss}`);
  line(`friendly_erp_memory_bytes{kind="heap_used"} ${mem.heapUsed}`);
  line(`friendly_erp_memory_bytes{kind="heap_total"} ${mem.heapTotal}`);

  return out.join('\n') + '\n';
}

/**
 * Who may scrape.
 *
 * The endpoint is unauthenticated, because a Prometheus scraper has no session
 * and giving it a long-lived token is worse than not having one. It is instead
 * restricted to callers on the local network, and a METRICS_TOKEN can be set to
 * require a bearer token as well when the scraper lives elsewhere.
 *
 * It leaks no tenant data by construction — there are no tenant labels — but it
 * does describe the shape of the deployment, which is not something to publish.
 */
function mayScrape(req: FastifyRequest): boolean {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${token}`;
  }
  const ip = req.ip ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
    || /^10\./.test(ip) || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * Attach the hooks and the endpoint.
 *
 * Called DIRECTLY — `installMetrics(app)` — and never through `app.register()`.
 * A registered plugin gets its own encapsulated context, so hooks added inside
 * it apply only to that context and its children, not to routes registered on
 * the parent afterwards. Registering this produced a `/metrics` endpoint that
 * served pool gauges and memory but had never observed a single request: the
 * onResponse hook was scoped to a context containing no routes. Breaking
 * encapsulation properly would mean adding `fastify-plugin`; calling the
 * function is the same thing without the dependency.
 */
export async function installMetrics(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    inFlight++;
    (req as FastifyRequest & { _t0?: bigint })._t0 = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    inFlight = Math.max(0, inFlight - 1);
    const t0 = (req as FastifyRequest & { _t0?: bigint })._t0;
    if (t0 === undefined) return;
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    // The ROUTE PATTERN, not the URL. `/api/leads/:id` is one series;
    // `/api/leads/<uuid>` would be one series per lead, which is how a metrics
    // endpoint becomes the thing that takes the service down.
    const route = req.routeOptions?.url ?? 'unmatched';
    observe(req.method, route, reply.statusCode, seconds);
  });

  app.get('/metrics', async (req, reply) => {
    if (!mayScrape(req)) return reply.code(404).send({ error: 'Not found' });
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return render();
  });

  /**
   * GET /api/health/deep — health that fails when the service is unusable.
   *
   * `/api/health` runs `SELECT 1`, which passes while every request is queueing
   * for a connection that never frees. This checks the things whose absence
   * actually makes the product not work, and returns 503 so a load balancer
   * takes the instance out rather than sending traffic at it.
   */
  app.get('/api/health/deep', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    for (const [name, p] of [['db', pool], ['db_platform', platformPool]] as const) {
      const t0 = Date.now();
      try {
        await p.query('SELECT 1');
        checks[name] = { ok: true, detail: `${Date.now() - t0}ms` };
      } catch (err) {
        checks[name] = { ok: false, detail: (err as Error).message };
      }
    }

    // A saturated pool is the failure that presents as "the app is slow" and
    // never shows up in a SELECT 1.
    checks.db_pool = pool.waitingCount === 0
      ? { ok: true, detail: `${pool.idleCount}/${pool.totalCount} idle` }
      : { ok: false, detail: `${pool.waitingCount} request(s) waiting for a connection` };

    const ok = Object.values(checks).every(c => c.ok);
    if (!ok) reply.code(503);
    return { ok, checks, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
  });
}

/** Test seam — the suite asserts the exposition format without a live server. */
export const __metrics = { observe, render };
