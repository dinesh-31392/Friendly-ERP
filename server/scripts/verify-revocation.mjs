/**
 * A session can be ended (migration 037).
 *
 * WHAT THIS IS FOR
 *
 * Before 037 a staff token was valid for its full 24 hours no matter what
 * happened in between. There was no jti, no deny-list, and no way to end a
 * session — a leaked token could only be answered by deactivating the whole
 * account, which locks the employee out of their job to contain one credential.
 *
 * Two mechanisms answer two different questions, and both are asserted here:
 *
 *   revoked_tokens            kill ONE token   — "sign out of this device"
 *   users.sessions_valid_from kill EVERY token — "my phone was stolen"
 *
 * THE ASSERTION THAT MATTERS MOST
 *
 * That a revoked token stops working while an UNREVOKED one for the same user
 * keeps working. Half of these tests would pass against a server that simply
 * rejected everything, so every revocation is paired with a survivor.
 */
import pg from 'pg';
import argon2 from 'argon2';

// CI runs the API on 4055; API_BASE points the suite at another instance.
const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'RVK';
const email = `${MARK.toLowerCase()}@revoke.test`;
const other = `${MARK.toLowerCase()}2@revoke.test`;
const clean = async () => {
  const probes = `SELECT id FROM users WHERE email IN ('${email}','${other}')`;
  await admin.query(`DELETE FROM revoked_tokens WHERE user_id IN (${probes})`);
  await admin.query(`DELETE FROM users WHERE email IN ('${email}','${other}')`);
};
await clean();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
const { rows: [role] } = await admin.query(
  `SELECT id FROM roles WHERE tenant_id=$1 AND name='sales_executive'`, [t.id]);
const hash = await argon2.hash(PW, { type: argon2.argon2id });
for (const e of [email, other]) {
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'Revoke Probe',$3,$4,true,false)`, [t.id, role.id, e, hash]);
}

const login = async (e) => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: PW }) });
  const b = await r.json();
  if (!b?.token) throw new Error(`login failed for ${e}: ${r.status} ${JSON.stringify(b)}`);
  return b.token;
};
const H = (tok) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok });
const me   = (tok) => fetch(BASE + '/api/auth/me', { headers: H(tok) });
const post = (p, tok) => fetch(BASE + p, { method: 'POST', headers: H(tok) });

// ── Every token now carries a handle to revoke it by ───────────────────────
console.log('\n=== TOKENS ARE IDENTIFIABLE ===');
const phone   = await login(email);   // pretend: the stolen phone
const desktop = await login(email);   // same user, second device
const claims  = JSON.parse(Buffer.from(phone.split('.')[1], 'base64url').toString());
ok('a freshly issued token carries a jti', typeof claims.jti === 'string' && claims.jti.length === 36, String(claims.jti));
ok('…and an issued-at', Number.isInteger(claims.iat), String(claims.iat));
ok('two logins get different jtis',
   claims.jti !== JSON.parse(Buffer.from(desktop.split('.')[1], 'base64url').toString()).jti);

console.log('\n=== BOTH SESSIONS WORK TO BEGIN WITH ===');
ok('phone session works',   (await me(phone)).status === 200);
ok('desktop session works', (await me(desktop)).status === 200);

// ── Single-session sign-out ───────────────────────────────────────────────
console.log('\n=== SIGNING OUT ONE DEVICE LEAVES THE OTHER ALONE ===');
const out = await post('/api/auth/logout', phone);
ok('logout succeeds', out.status === 200, String(out.status));
ok('the signed-out token is refused', (await me(phone)).status === 401, String((await me(phone)).status));
ok('the OTHER device is untouched', (await me(desktop)).status === 200, String((await me(desktop)).status));

ok('the revocation was recorded', (await admin.query(
  `SELECT count(*)::int n FROM revoked_tokens WHERE jti=$1`, [claims.jti])).rows[0].n === 1);

console.log('\n=== SIGNING OUT TWICE IS NOT AN ERROR ===');
// The client retries on a flaky connection; a second sign-out must not 500.
// It is refused now only because the token itself is already dead.
const twice = await post('/api/auth/logout', phone);
ok('a second logout with the dead token is a clean 401', twice.status === 401, String(twice.status));

// ── Sign out everywhere ───────────────────────────────────────────────────
console.log('\n=== SIGN OUT EVERYWHERE KILLS SESSIONS THE DENY-LIST NEVER SAW ===');
const tabA = await login(email);
const tabB = await login(email);
ok('two new sessions work', (await me(tabA)).status === 200 && (await me(tabB)).status === 200);

const all = await post('/api/auth/logout-all', tabA);
ok('logout-all succeeds', all.status === 200, String(all.status));
ok('the session that asked for it is dead', (await me(tabA)).status === 401, String((await me(tabA)).status));
ok('and so is the one it never knew about', (await me(tabB)).status === 401, String((await me(tabB)).status));
ok('the earlier desktop session died too', (await me(desktop)).status === 401, String((await me(desktop)).status));

console.log('\n=== …AND A DIFFERENT USER IS UNAFFECTED ===');
// The watermark is per-user. If this fails, one person signing out has just
// signed out the whole company.
const bystander = await login(other);
ok('another user in the same tenant still works', (await me(bystander)).status === 200,
   String((await me(bystander)).status));

console.log('\n=== A NEW SIGN-IN AFTER SIGN-OUT-EVERYWHERE STILL WORKS ===');
// The wait is not padding. The watermark is the start of the next second, so a
// token minted during the same second as the sign-out is deliberately dead —
// that is what makes the control fail closed. A human takes far longer than
// this to retype a password; the test has to be told to.
await new Promise(r => setTimeout(r, 1100));
const fresh = await login(email);
ok('signing in again produces a working session', (await me(fresh)).status === 200,
   String((await me(fresh)).status));

// ── Deactivation and password reset end sessions ──────────────────────────
console.log('\n=== THE WATERMARK BOUNDARY, EXACTLY ===');
// Asserted against the function rather than through a login, because a login
// takes an unpredictable slice of a second (argon2 is deliberately slow) and
// would land on either side of the boundary at random. The rule is: a token
// stamped with the second BEFORE the watermark is dead, one stamped AT it is
// alive. Off by one in either direction is either a security hole or an
// account nobody can sign into.
const { rows: [u] } = await admin.query(`SELECT id, tenant_id FROM users WHERE email=$1`, [email]);
await admin.query(
  `UPDATE users SET sessions_valid_from = to_timestamp(1800000000) WHERE id=$1`, [u.id]);
const live = async (iat) => (await admin.query(
  `SELECT token_is_live($1,$2,NULL,$3) AS ok`, [u.tenant_id, u.id, iat])).rows[0].ok;
ok('a token from the second before the watermark is dead', (await live(1799999999)) === false);
ok('a token from exactly the watermark second is alive', (await live(1800000000)) === true);
ok('a token from after it is alive', (await live(1800000001)) === true);
await admin.query(`UPDATE users SET sessions_valid_from = NULL WHERE id=$1`, [u.id]);

console.log('\n=== DEACTIVATING AN ACCOUNT ENDS ITS SESSIONS ===');
await admin.query(
  `UPDATE users SET active=false, sessions_valid_from=date_trunc('second', now()) WHERE email=$1`, [email]);
ok('a deactivated user\'s live token is refused', (await me(fresh)).status === 401,
   String((await me(fresh)).status));
await admin.query(`UPDATE users SET active=true, sessions_valid_from=NULL WHERE email=$1`, [email]);

console.log('\n=== PRE-037 TOKENS ARE NOT MASS-INVALIDATED ===');
// Deploying revocation must not sign the whole company out. A token minted
// before 037 has no jti; it is on no deny-list and must still work.
const legacy = await login(email);
const [h, p] = legacy.split('.');
const legacyClaims = JSON.parse(Buffer.from(p, 'base64url').toString());
delete legacyClaims.jti;
const jwt = (await import('jsonwebtoken')).default;
const legacyToken = jwt.sign(legacyClaims, process.env.JWT_SECRET
  || (await import('node:fs')).readFileSync('.env', 'utf8').match(/JWT_SECRET=(.+)/)[1].trim(),
  { algorithm: 'HS256' });
const legacyRes = await me(legacyToken);
ok('a token with no jti is still accepted', legacyRes.status === 200, String(legacyRes.status));

console.log('\n=== EXPIRED DENY-LIST ROWS ARE PRUNED ===');
// Otherwise the table grows by one row per sign-out, forever.
await admin.query(
  `INSERT INTO revoked_tokens (jti, tenant_id, user_id, expires_at, reason)
   SELECT gen_random_uuid(), $1, id, now() - interval '2 days', 'stale-probe'
     FROM users WHERE email=$2`, [t.id, email]);
const before = (await admin.query(`SELECT count(*)::int n FROM revoked_tokens WHERE reason='stale-probe'`)).rows[0].n;
ok('a stale row exists to prune', before === 1, String(before));
await post('/api/auth/logout', await login(email));
const after = (await admin.query(`SELECT count(*)::int n FROM revoked_tokens WHERE reason='stale-probe'`)).rows[0].n;
ok('signing out prunes it', after === 0, String(after));

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
