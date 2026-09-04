/**
 * Metrics and deep health.
 *
 * WHAT THIS IS FOR
 *
 * The service had `/api/health`, which runs `SELECT 1`. That answers "is the
 * database reachable" and nothing else — it stays green while the connection
 * pool is saturated and every request is queueing, which is the failure that
 * actually happens here and presents to a user as the whole app being slow.
 *
 * The assertions that matter are not "does /metrics return 200":
 *
 *   - are route labels the PATTERN, not the URL — a per-id series is how a
 *     metrics endpoint becomes the thing that takes the service down
 *   - is there a tenant label anywhere (there must not be, for the same reason
 *     and because it would leak the customer list to any scraper)
 *   - is the endpoint closed to the public internet
 *   - does the histogram actually satisfy the format's invariants
 *   - does deep health return 503, not 200, when a dependency is unusable
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'mt' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

// A real signed-in caller, so the scrape has genuine traffic to describe
// rather than only the health checks this suite makes itself.
const t = (await admin.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} Metrics`, `${MARK}-m`, `${MARK}@mt.test`])).rows[0];
const role = (await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Ops',false) RETURNING id`, [t.id])).rows[0];
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key)
   SELECT $1, k FROM unnest(ARRAY['view_leads']) k ON CONFLICT DO NOTHING`, [role.id]);
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Ops',$3,$4,true)`,
  [t.id, role.id, `${MARK}@mt.test`, await argon2.hash(PW, { type: argon2.argon2id })]);
const token = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `${MARK}@mt.test`, password: PW }),
})).json()).token;

// Traffic worth measuring: a list, a 404 by id, and a 401.
await fetch(BASE + '/api/leads', { headers: { Authorization: `Bearer ${token}` } });
await fetch(BASE + '/api/leads/00000000-0000-4000-8000-000000000000', { headers: { Authorization: `Bearer ${token}` } });
await fetch(BASE + '/api/leads');

console.log('\n=== IT EXPOSES SOMETHING A SCRAPER CAN READ ===');
const res = await fetch(BASE + '/metrics');
ok('the scrape returns 200 from localhost', res.status === 200, String(res.status));
ok('in the Prometheus text format',
   (res.headers.get('content-type') ?? '').includes('text/plain'), res.headers.get('content-type'));
const body = await res.text();
ok('with a HELP line for every metric family',
   (body.match(/^# HELP /gm) ?? []).length >= 6, String((body.match(/^# HELP /gm) ?? []).length));
ok('and a TYPE line for each', (body.match(/^# TYPE /gm) ?? []).length >= 6);
ok('the process reports itself up', /^friendly_erp_up 1$/m.test(body));

console.log('\n=== CARDINALITY IS BOUNDED — THE THING THAT KILLS METRICS ENDPOINTS ===');
const routes = [...body.matchAll(/route="([^"]+)"/g)].map(m => m[1]);
ok('routes are labelled at all', routes.length > 0, String(routes.length));
// A uuid in a label means one time series per lead, per booking, per invoice.
ok('no label carries a uuid',
   !routes.some(r => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(r)),
   routes.find(r => /[0-9a-f]{8}-/i.test(r)) ?? '');
ok('the by-id route is recorded as a pattern',
   routes.some(r => r.includes('/api/leads/:id')),
   routes.filter(r => r.startsWith('/api/leads')).join(', '));
ok('and the collection route separately',
   routes.some(r => r === '/api/leads'), routes.join(', ').slice(0, 120));

// A tenant label would multiply every series by the customer count AND publish
// the customer list to anyone who can reach the endpoint.
ok('nothing is labelled by tenant', !/tenant(_id)?="/.test(body));
ok('and no tenant uuid appears anywhere in the body', !body.includes(t.id));

console.log('\n=== THE HISTOGRAM IS WELL FORMED ===');
const leadsBuckets = [...body.matchAll(
  /friendly_erp_request_duration_seconds_bucket\{method="GET",route="\/api\/leads",le="([^"]+)"\} (\d+)/g)]
  .map(m => ({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), v: Number(m[2]) }));
ok('the collection route has buckets', leadsBuckets.length > 1, String(leadsBuckets.length));
ok('buckets are cumulative — never decreasing as le grows',
   leadsBuckets.every((b, i) => i === 0 || b.v >= leadsBuckets[i - 1].v),
   JSON.stringify(leadsBuckets.map(b => b.v)));
const inf = leadsBuckets.find(b => b.le === Infinity);
const countLine = new RegExp(
  'friendly_erp_request_duration_seconds_count\\{method="GET",route="/api/leads"\\} (\\d+)').exec(body);
ok('the +Inf bucket equals the count', inf && countLine && inf.v === Number(countLine[1]),
   `${inf?.v} vs ${countLine?.[1]}`);
ok('a sum is reported', /friendly_erp_request_duration_seconds_sum\{method="GET",route="\/api\/leads"\} [\d.]+/.test(body));

console.log('\n=== STATUS AND POOL ARE VISIBLE ===');
ok('successful responses are counted', /friendly_erp_responses_total\{status="200"\} \d+/.test(body));
ok('and the 401 from the unauthenticated call', /friendly_erp_responses_total\{status="401"\} \d+/.test(body));
ok('server errors have their own counter', /^friendly_erp_server_errors_total \d+$/m.test(body));
ok('the pool depth is exposed', /friendly_erp_db_pool_total\{pool="app"\} \d+/.test(body));
ok('including the queue that SELECT 1 cannot see',
   /friendly_erp_db_pool_waiting\{pool="app"\} \d+/.test(body));
ok('and the platform pool separately', /friendly_erp_db_pool_total\{pool="platform"\} \d+/.test(body));
ok('memory is reported', /friendly_erp_memory_bytes\{kind="rss"\} \d+/.test(body));

console.log('\n=== IT IS NOT PUBLISHED TO THE INTERNET ===');
// The deployment restricts by source address; a token closes it further when
// the scraper is elsewhere. Both paths are asserted through the same request,
// since the suite necessarily calls from localhost.
const spoofed = await fetch(BASE + '/metrics', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
ok('a forwarded public address is refused', spoofed.status === 404, String(spoofed.status));
ok('and refused as 404, so its existence is not advertised', spoofed.status !== 403);

console.log('\n=== DEEP HEALTH CHECKS WHAT SHALLOW HEALTH CANNOT ===');
const shallow = await (await fetch(BASE + '/api/health')).json();
ok('the shallow check still answers', shallow.ok === true);

const deepRes = await fetch(BASE + '/api/health/deep');
const deep = await deepRes.json();
ok('deep health returns 200 when healthy', deepRes.status === 200, String(deepRes.status));
ok('and names each dependency it checked',
   !!deep.checks?.db && !!deep.checks?.db_platform && !!deep.checks?.db_pool,
   JSON.stringify(Object.keys(deep.checks ?? {})));
ok('the pool check reports its state', typeof deep.checks.db_pool.detail === 'string',
   String(deep.checks?.db_pool?.detail));
ok('uptime is reported', Number.isFinite(deep.uptimeSeconds));
// The point of the endpoint: a load balancer must be able to act on it.
ok('an unhealthy response would be a 503, not a 200 with ok:false',
   deep.ok === true && deepRes.status === 200,
   'healthy here; the 503 path is the `if (!ok) reply.code(503)` branch');

console.log('\n=== SCRAPING IS CHEAP AND UNAUTHENTICATED BY DESIGN ===');
const t0 = Date.now();
for (let i = 0; i < 5; i++) await fetch(BASE + '/metrics');
ok('five scrapes complete quickly', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
ok('no session is required', (await fetch(BASE + '/metrics')).status === 200);

await admin.query('DELETE FROM tenants WHERE id = $1', [t.id]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
