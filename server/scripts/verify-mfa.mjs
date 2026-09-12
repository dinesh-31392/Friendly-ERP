/**
 * Email second factor at login.
 *
 * Mostly negative testing: the whole point is what a stolen password does NOT
 * get you. The code is read straight from login_challenges (the test knows the
 * HMAC key) rather than from a mailbox, so SMTP is stubbed out.
 *
 * Run against erp_test with the API on 4055.
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import 'dotenv/config';

// CI runs the API on 4055; API_BASE points the suite at another instance.
const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'MFA';
const clean = async () => {
  await admin.query(`DELETE FROM login_challenges WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${MARK.toLowerCase()}%@mfa.test')`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@mfa.test'`);
  await admin.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM roles WHERE name LIKE '${MARK}%'`);
};
await clean();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants LIMIT 1`);
const { rows: [role] } = await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'${MARK}_role',false)
   ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=false RETURNING id`, [t.id]);
await admin.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'view_dashboard') ON CONFLICT DO NOTHING`, [role.id]);
const hash = await argon2.hash(PW, { type: argon2.argon2id });

const mkUser = async (slug, mfa) => (await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
   VALUES ($1,$2,'MFA Tester',$3,$4,true,$5) RETURNING id`,
  [t.id, role.id, `${MARK.toLowerCase()}${slug}@mfa.test`, hash, mfa])).rows[0].id;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let logins = 0;
/** The login route allows 5 per IP per minute; pause before tripping it. */
const paced = async () => { if (++logins % 4 === 0) { console.log('   … pausing for the login rate limit'); await sleep(62_000); } };

const rawLogin = (email, password = PW) => fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const login = async (email, password = PW) => { await paced(); return rawLogin(email, password); };
const verify = (challengeId, code) => fetch(BASE + '/api/auth/verify-code', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ challengeId, code }),
});

// The server stores HMAC(jwtSecret, "<challengeId>:<code>"). Recover the code by
// searching the 10^6 space — which is exactly the attack the HMAC key prevents
// for someone who has the DB but NOT the secret. The test has both.
const codeFor = async (challengeId) => {
  const { rows: [ch] } = await admin.query(`SELECT code_hash FROM login_challenges WHERE id=$1`, [challengeId]);
  if (!ch) throw new Error(`no challenge row for ${challengeId} — the login probably returned an error instead of a challenge`);
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, '0');
    if (createHmac('sha256', process.env.JWT_SECRET).update(`${challengeId}:${c}`).digest('hex') === ch.code_hash) return c;
  }
  throw new Error('code not recovered');
};

// ── A password alone is not a session ───────────────────────────────────────
console.log('\n=== MFA ACCOUNT ===');
const mfaUser = await mkUser('on', true);
const r1 = await login(`${MARK.toLowerCase()}on@mfa.test`);
const b1 = await r1.json();
ok('correct password returns no token', r1.status === 200 && !b1.token, `${r1.status} ${JSON.stringify(b1).slice(0,80)}`);
ok('it asks for a code instead', b1.mfaRequired === true && typeof b1.challengeId === 'string');
ok('the address is masked', typeof b1.sentTo === 'string' && b1.sentTo.includes('•') && !b1.sentTo.includes('mfaon'), b1.sentTo);

console.log('\n=== WRONG CODES ===');
const bad = await verify(b1.challengeId, '000000');
const realCode = await codeFor(b1.challengeId);
ok('a wrong code is refused (401)', bad.status === 401 || realCode === '000000', String(bad.status));
ok('the failure message says nothing useful',
   (await bad.clone().json()).error === 'That code is not valid. Request a new one.');

console.log('\n=== THE RIGHT CODE ===');
const good = await verify(b1.challengeId, realCode);
const gb = await good.json();
ok('the correct code returns a session', good.status === 200 && !!gb.token, `${good.status}`);

console.log('\n=== REPLAY ===');
const replay = await verify(b1.challengeId, realCode);
ok('the same code cannot be used twice (401)', replay.status === 401, String(replay.status));

console.log('\n=== ATTEMPT CAP ===');
const r2 = await login(`${MARK.toLowerCase()}on@mfa.test`);
const b2 = await r2.json();
const realCode2 = await codeFor(b2.challengeId);
for (let i = 0; i < 5; i++) await verify(b2.challengeId, realCode2 === '111111' ? '222222' : '111111');
const afterCap = await verify(b2.challengeId, realCode2);
ok('the correct code is dead after 5 wrong ones', afterCap.status === 401, String(afterCap.status));

console.log('\n=== SUPERSEDING ===');
const a = await (await login(`${MARK.toLowerCase()}on@mfa.test`)).json();
const bch = await (await login(`${MARK.toLowerCase()}on@mfa.test`)).json();
const codeA = await codeFor(a.challengeId);
const oldOne = await verify(a.challengeId, codeA);
ok('requesting a new code kills the previous one', oldOne.status === 401, String(oldOne.status));
const codeB = await codeFor(bch.challengeId);
ok('the newest code still works', (await verify(bch.challengeId, codeB)).status === 200);

console.log('\n=== EXPIRY ===');
const e = await (await login(`${MARK.toLowerCase()}on@mfa.test`)).json();
const codeE = await codeFor(e.challengeId);
await admin.query(`UPDATE login_challenges SET expires_at = now() - interval '1 minute' WHERE id=$1`, [e.challengeId]);
ok('an expired code is refused', (await verify(e.challengeId, codeE)).status === 401);

console.log('\n=== DEACTIVATION MID-FLOW ===');
const d = await (await login(`${MARK.toLowerCase()}on@mfa.test`)).json();
const codeD = await codeFor(d.challengeId);
await admin.query(`UPDATE users SET active=false WHERE id=$1`, [mfaUser]);
ok('a user deactivated after the password step cannot finish',
   (await verify(d.challengeId, codeD)).status === 401);
await admin.query(`UPDATE users SET active=true WHERE id=$1`, [mfaUser]);

console.log('\n=== BAD PASSWORD ===');
const wrong = await login(`${MARK.toLowerCase()}on@mfa.test`, 'not-the-password');
const wb = await wrong.json().catch(() => ({}));
ok('a wrong password issues no challenge (401)', wrong.status === 401 && !wb.challengeId, String(wrong.status));

console.log('\n=== MFA OFF ===');
const plain = await mkUser('off', false);
const p1 = await login(`${MARK.toLowerCase()}off@mfa.test`);
const pb = await p1.json();
ok('an account without MFA still logs in directly', p1.status === 200 && !!pb.token && !pb.mfaRequired, `${p1.status}`);

console.log('\n=== PLATFORM STAFF ARE ENROLLED ===');
// Assert the RULE from migration 031, not the state of a shared test database.
// The other suites deliberately opt their fixture admin out so they can log in,
// so a count over global state just measures that instead.
const { rows: [pt] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
if (!pt) {
  console.log('  (no platform tenant here — enrolment rule not exercised)');
} else {
  const { rows: [prole] } = await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'super_admin',true)
     ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=true RETURNING id`, [pt.id]);
  // A platform admin without the flag — as one would be before 031 ran.
  const { rows: [fresh] } = await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'MFA Fresh Platform',$3,$4,true,false) RETURNING id`,
    [pt.id, prole.id, `${MARK.toLowerCase()}fresh@mfa.test`, hash]);

  // The exact predicate migration 031 runs — scoped to THIS SUITE'S rows.
  //
  // It used to run unscoped, exactly as the migration does. That is fine in a
  // migration, which runs once against a fresh deployment, and wrong in a test,
  // which runs against a database twenty other suites share: it enrolled every
  // platform super_admin and tech_team present, including the fixtures
  // admin@erptest.local and tech@erptest.local, and clean() below only removes
  // rows matching this suite's own MARK — so the flag stayed on for good.
  //
  // Nothing caught it because until verify-role-logins existed, no later suite
  // signed in as those two. Then they started returning an MFA challenge
  // instead of a token and the failure pointed at the roles code, which was
  // fine, rather than here.
  //
  // The role/tenant predicate is still what is under test; the email filter
  // only stops the blast radius from reaching rows this suite does not own.
  await admin.query(
    `UPDATE users u SET mfa_email_enabled = true
       FROM roles r, tenants t
      WHERE r.id = u.role_id AND t.id = u.tenant_id
        AND t.slug = 'platform' AND r.name IN ('super_admin','tech_team')
        AND u.email LIKE $1`,
    [`${MARK.toLowerCase()}%@mfa.test`]);

  const { rows: [after] } = await admin.query(`SELECT mfa_email_enabled FROM users WHERE id=$1`, [fresh.id]);
  ok('the migration enrols a platform admin that lacked a second factor', after.mfa_email_enabled === true);

  const { rows: [b] } = await admin.query(`SELECT mfa_email_enabled FROM users WHERE email=$1`,
    [`${MARK.toLowerCase()}off@mfa.test`]);
  ok('it does not enrol ordinary tenant users', b?.mfa_email_enabled === false, String(b?.mfa_email_enabled));
}

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
