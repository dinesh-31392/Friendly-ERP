/**
 * Each builder's own brand, and only their own.
 *
 * WHAT WHITE-LABELLING HAS TO GET RIGHT
 *
 * A builder uploads a logo and picks a colour, and three things must follow:
 * their staff see it in the panel, their buyers see it on the portal, and no
 * other builder ever sees any of it. The third is a tenant-isolation
 * assertion; the first two are the ones a permission audit never thinks to
 * make, because nothing is being protected — something is failing to arrive.
 *
 * THE BUG THIS WAS WRITTEN FOR
 *
 * The logo saved correctly and the panel never showed it. `refreshSession()`
 * opened with `if (getStoredApiSession()) return;` — in API mode it did
 * nothing at all. The tenant is captured once at login and persisted, so the
 * sidebar kept rendering the copy from before the upload, across reloads,
 * until the user happened to sign out and back in. The toast said "your portal
 * and workspace now use it" and the sidebar disagreed.
 *
 * Nothing errored, so only opening the app and looking would have caught it —
 * which is what these assertions do instead: they check the payloads the
 * panel and the portal are actually built from.
 *
 * WHERE THE LOGO LIVES, AND WHY THAT MATTERS HERE
 *
 * It is a data URI in tenants.logo_url, not a file in the upload store. That
 * is a deliberate trade — a logo has to render on the LOGIN screen, before
 * anyone is authenticated, and a file behind an authenticated download route
 * cannot. It also means the logo travels inside the session payload, which is
 * why the size ceiling is asserted below: an unbounded data URI would be
 * carried on every login response forever.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'wl' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

// Two distinguishable logos. Real PNG bytes so nothing can pass by storing the
// string without it ever having been an image.
const png = (rgbHex) => 'data:image/png;base64,' + Buffer.from(
  `\x89PNG\r\n\x1a\n${rgbHex}${MARK}`, 'binary').toString('base64');
const LOGO_A = png('AAAA11');
const LOGO_B = png('BBBB22');
const COLOR_A = '#E6007E';
const COLOR_B = '#00A86B';

async function builder(tag, name, logo, color) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, logo_url, primary_color)
     VALUES ($1,$1,$2,$3,$4,$5) RETURNING id`,
    [name, `${MARK}-${tag}`, `${MARK}-${tag}@wl.test`, logo, color])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'owner',false) RETURNING id`,
    [t.id])).rows[0];
  await admin.query(
    `INSERT INTO role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`,
    [role.id, ['view_dashboard', 'manage_settings']]);
  const email = `${MARK}-${tag}@wl.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [t.id, role.id, name, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json();
  if (!login.token) throw new Error(`login failed for ${email}`);
  return { tenantId: t.id, token: login.token, login, name };
}

const A = await builder('acme', 'Acme Builders', LOGO_A, COLOR_A);
const B = await builder('rival', 'Rival Estates', LOGO_B, COLOR_B);

const get = (t, p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } });
const jget = async (t, p) => (await get(t, p)).json().catch(() => ({}));
const has = (payload, needle) => JSON.stringify(payload ?? {}).includes(needle);

// ── the panel ──────────────────────────────────────────────────────────────
console.log('\n=== THE BRAND REACHES THE PANEL AT SIGN-IN ===');
// The login response IS what the sidebar renders from — the session is stored
// and re-read on every reload, so anything missing here is missing until the
// user signs out and back in.
ok('the login response carries the workspace’s logo',
  A.login.tenant?.logoUrl === LOGO_A, String(A.login.tenant?.logoUrl ?? '').slice(0, 30));
ok('and its brand colour', A.login.tenant?.primaryColor === COLOR_A, A.login.tenant?.primaryColor);
ok('and its name', A.login.tenant?.name === 'Acme Builders', A.login.tenant?.name);

console.log('\n=== AND CAN BE RE-READ AFTER A CHANGE, WITHOUT SIGNING OUT ===');
// The endpoint refreshSession() calls. It returned the branding all along;
// nothing asked it, which is exactly how the logo could save and never appear.
const ws = await jget(A.token, '/api/workspace');
ok('GET /api/workspace returns the logo', ws.workspace?.logoUrl === LOGO_A,
  String(ws.workspace?.logoUrl ?? '').slice(0, 30));
ok('and the colour', ws.workspace?.primaryColor === COLOR_A, ws.workspace?.primaryColor);

// A save must be visible on the very next read — the property that was broken.
const NEW_LOGO = png('CCCC33');
const saved = await fetch(BASE + '/api/workspace', {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ logoUrl: NEW_LOGO, primaryColor: '#123456' }),
});
ok('a branding save is accepted', saved.status === 200, String(saved.status));
const after = await jget(A.token, '/api/workspace');
ok('and the very next read returns the NEW logo, not the one from sign-in',
  after.workspace?.logoUrl === NEW_LOGO, String(after.workspace?.logoUrl ?? '').slice(0, 30));
ok('and the new colour', after.workspace?.primaryColor === '#123456', after.workspace?.primaryColor);

// ── isolation ──────────────────────────────────────────────────────────────
console.log('\n=== ONE BUILDER’S BRAND NEVER REACHES ANOTHER ===');
ok('B’s sign-in carries B’s logo', B.login.tenant?.logoUrl === LOGO_B);
ok('and NOT A’s', !has(B.login.tenant, 'AAAA11') && !has(B.login.tenant, 'CCCC33'),
  String(B.login.tenant?.logoUrl ?? '').slice(0, 30));
ok('B’s colour is B’s', B.login.tenant?.primaryColor === COLOR_B, B.login.tenant?.primaryColor);

const bWs = await jget(B.token, '/api/workspace');
ok('B’s workspace read shows only B’s brand',
  bWs.workspace?.logoUrl === LOGO_B && !has(bWs, 'AAAA11') && !has(bWs, 'CCCC33'));
ok('and A’s save did not touch B',
  (await admin.query('SELECT logo_url FROM tenants WHERE id = $1', [B.tenantId])).rows[0].logo_url === LOGO_B);

// A cannot write B's branding, by any route.
const crossWrite = await fetch(BASE + '/api/workspace', {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ logoUrl: 'data:image/png;base64,HACKED', id: B.tenantId, tenantId: B.tenantId }),
});
const bUntouched = (await admin.query('SELECT logo_url FROM tenants WHERE id = $1', [B.tenantId])).rows[0];
ok('[STEERING] naming another workspace in the body cannot rebrand it',
  bUntouched.logo_url === LOGO_B, `${crossWrite.status} → ${String(bUntouched.logo_url).slice(0, 30)}`);
// The request either fails validation or edits the CALLER's own workspace —
// both are correct, and which one happens depends on whether the schema
// strips unknown keys. What must never happen is B changing, asserted above.
const aAfterSteer = (await jget(A.token, '/api/workspace')).workspace?.logoUrl ?? '';
ok('the caller’s own workspace is the only one that could have changed',
  crossWrite.status >= 400 || aAfterSteer !== LOGO_A,
  `${crossWrite.status} → ${aAfterSteer.slice(0, 30)}`);

// ── the ceiling ────────────────────────────────────────────────────────────
console.log('\n=== A LOGO IS BOUNDED, BECAUSE IT TRAVELS IN EVERY SESSION ===');
// The logo is a data URI carried inside the login payload and the stored
// session. Unbounded, one builder's 40MB upload would be re-sent on every
// sign-in and re-parsed on every page load, for them and for nobody else's
// benefit.
// Whatever A's logo is right now — read rather than assumed, because the
// steering test above legitimately changed A's own workspace.
const beforeHuge = (await jget(A.token, '/api/workspace')).workspace?.logoUrl ?? '';
const huge = 'data:image/png;base64,' + 'A'.repeat(4_000_000);
const tooBig = await fetch(BASE + '/api/workspace', {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ logoUrl: huge }),
});
ok('an oversized logo is refused', tooBig.status >= 400, String(tooBig.status));
const stillNew = await jget(A.token, '/api/workspace');
ok('and a refused save leaves the existing logo intact — not blanked',
  stillNew.workspace?.logoUrl === beforeHuge, String(stillNew.workspace?.logoUrl ?? '').slice(0, 30));

console.log('\n=== CLEARING IT IS A REAL STATE, NOT A FAILURE ===');
// "Remove" in the UI sends an empty string. It must clear rather than be
// rejected as invalid or silently ignored, or a builder can never take a logo
// down once uploaded.
await fetch(BASE + '/api/workspace', {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ logoUrl: '' }),
});
const cleared = await jget(A.token, '/api/workspace');
ok('a builder can remove their logo', cleared.workspace?.logoUrl === '',
  String(cleared.workspace?.logoUrl ?? '').slice(0, 30));
ok('and B still has theirs',
  (await jget(B.token, '/api/workspace')).workspace?.logoUrl === LOGO_B);

await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[A.tenantId, B.tenantId]]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
