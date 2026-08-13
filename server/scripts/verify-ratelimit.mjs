/**
 * Rate limiting is keyed on identity, not on address.
 *
 * WHY THIS SUITE EXISTS
 *
 * The limiter's default key is the client IP, which is the wrong unit for this
 * product. A builder's sales team works from one office behind one public
 * address, so under an IP key ten reps spend a single 120/min budget between
 * them. Normal work then returns 429 and the app looks broken, with nothing in
 * the UI to explain why. The inverse failed too: one tenant's runaway
 * integration could not be throttled without throttling every other tenant
 * sharing that address.
 *
 * The fix keys authenticated requests on tenant + user and leaves everything
 * unauthenticated on IP, because that is where brute force lives.
 *
 * HOW IT IS ASSERTED
 *
 * By reading the x-ratelimit-remaining header rather than by sending 120
 * requests until something breaks. Exhausting a bucket would prove the same
 * thing, but the limiter holds that state for a full minute and the other
 * suites share this server — a suite that leaves real throttling behind it
 * makes whatever runs next fail for reasons that have nothing to do with it.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

// exec1 and exec2 are two people in ONE tenant — the office-behind-one-IP case
// this exists for. Their passwords are set here because the fixtures seed a
// placeholder hash nobody can sign in with.
const hash = await argon2.hash(PW, { type: argon2.argon2id });
await admin.query(
  `UPDATE users SET password_hash=$1, active=true, mfa_email_enabled=false
    WHERE email IN ('exec1@erptest.local','exec2@erptest.local')`, [hash]);

const login = async (email) => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }) });
  const b = await r.json();
  if (!b?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(b)}`);
  return b.token;
};

const remaining = async (token) => {
  const r = await fetch(BASE + '/api/health', token
    ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
  const v = r.headers.get('x-ratelimit-remaining');
  return v === null ? null : Number(v);
};

const t1 = await login('exec1@erptest.local');
const t2 = await login('exec2@erptest.local');

console.log('\n=== THE HEADER IS THERE TO READ ===');
const first = await remaining(t1);
ok('the limiter reports a remaining budget', first !== null && Number.isFinite(first), String(first));

console.log('\n=== TWO PEOPLE IN ONE OFFICE DO NOT SHARE A BUDGET ===');
// Spend a few of exec1's requests. Under the old IP key these would come out of
// the same bucket exec2 draws from, and exec2's next request would show a
// budget several lower than its own maximum.
for (let i = 0; i < 5; i++) await remaining(t1);
const afterSpending = await remaining(t1);
const execTwo = await remaining(t2);

ok("exec1's own budget goes down as it spends", afterSpending < first,
   `${first} -> ${afterSpending}`);
ok('exec2 is unaffected by what exec1 spent', execTwo > afterSpending,
   `exec1=${afterSpending} exec2=${execTwo}`);

console.log('\n=== UNAUTHENTICATED TRAFFIC STILL KEYS ON ADDRESS ===');
// This is the half that must NOT change: with no identity to key on, the only
// thing left is the address, and that is what makes a login brute force
// expensive. If this ever keyed on something an attacker controls, the tighter
// 5/min cap on /api/auth/login would be free to bypass.
const anon1 = await remaining(null);
const anon2 = await remaining(null);
ok('anonymous requests share one bucket', anon2 < anon1, `${anon1} -> ${anon2}`);
ok('that bucket is not the signed-in one', anon1 !== afterSpending,
   `anon=${anon1} exec1=${afterSpending}`);

console.log('\n=== A FORGED TOKEN CANNOT MINT ITSELF A BUCKET ===');
// The key comes from a VERIFIED token. Decoding without verifying would let
// anyone invent a `sub` per request and never be limited at all — a limiter
// that an attacker opts out of by editing a header.
const forged = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
  + Buffer.from(JSON.stringify({ sub: 'made-up', tid: 'made-up', rol: 'super_admin' })).toString('base64url')
  + '.not-a-real-signature';
const f1 = await remaining(forged);
const f2 = await remaining(forged);
ok('a forged token is refused a bucket of its own', f2 < f1, `${f1} -> ${f2}`);
ok('it falls back to the anonymous bucket', f1 < anon2 + 1, `forged=${f1} anon=${anon2}`);

const authed = await fetch(BASE + '/api/leads', { headers: { Authorization: 'Bearer ' + forged } });
ok('and it still cannot reach a protected route', authed.status === 401, String(authed.status));

await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
