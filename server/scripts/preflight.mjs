/**
 * Is this deployment actually ready to serve real customers?
 *
 * WHY THIS EXISTS
 *
 * Every defect this script checks for was found by hand, in a deployment that
 * looked correct. The pattern was always the same and it is not a pattern a
 * unit test can see: a setting documented in `.env.production.example`, filled
 * in correctly by the operator, and then never wired through to the container
 * — or a library default that is right on a laptop and wrong on a VPS.
 *
 *   · SMTP_* were in the example and absent from the api service, so sign-in
 *     codes could not be sent and the only symptom was a log line.
 *   · FILE_STORAGE_DIR defaulted inside the image, under a directory the
 *     non-root user could not write, so document upload failed outright — and
 *     would have been destroyed by the next rebuild had it worked.
 *   · PUBLIC_BASE_URL and PUBLIC_URL meant the same thing; compose set one and
 *     click-to-call read the other, so calls connected and their outcome never
 *     came back.
 *
 * None of those break the boot. That is exactly what makes them dangerous:
 * the container comes up healthy and the product is quietly missing pieces.
 * This asserts the running configuration instead of the intended one.
 *
 * RUN IT WHERE THE API RUNS, because that is the only place the answers are
 * true — the same environment, the same filesystem, the same database:
 *
 *   docker compose -f docker-compose.prod.yml run --rm \
 *     -v friendly_uploads:/data/uploads api node scripts/preflight.mjs
 *
 * EXIT CODES
 *   0  ready, though there may be advisories worth reading
 *   1  at least one BLOCKER — something a customer would hit on day one
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * In a container the configuration IS the environment and there is no file.
 * Run from a checkout — to check a `.env` before shipping it — there is a file
 * and no environment. Load one if present so both uses work, and say which was
 * used, because "everything is missing" is otherwise indistinguishable from
 * "you ran this in the wrong directory".
 *
 * Pass a path to check a specific file:  node scripts/preflight.mjs ../deploy/.env
 */
const envFile = process.argv[2] ?? '.env';
let envSource = 'the process environment';
if (existsSync(envFile)) {
  const { config } = await import('dotenv');
  // override: false — a real environment variable beats the file, which is
  // what happens in the container and what an operator expects.
  config({ path: envFile, override: false });
  envSource = `${envFile} + the process environment`;
}

const PROD = process.env.NODE_ENV === 'production';
let blockers = 0, warnings = 0, okCount = 0;

const ok   = (m) => { okCount++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const warn = (m, why) => { warnings++; console.log('  \x1b[33m!\x1b[0m ' + m + (why ? '\n      ' + why : '')); };
const bad  = (m, why) => { blockers++; console.log('  \x1b[31m✗\x1b[0m ' + m + (why ? '\n      ' + why : '')); };

console.log('\nFriendly ERP — deployment preflight');
console.log(`  reading  ${envSource}`);
console.log(`  NODE_ENV ${process.env.NODE_ENV ?? 'unset'}`);

// ─── 1. The things the process refuses to start without ─────────────────────
console.log('\n── Identity and secrets ──');
for (const v of ['DATABASE_URL', 'DATABASE_PLATFORM_URL', 'JWT_SECRET']) {
  if (process.env[v]) ok(`${v} is set`);
  else bad(`${v} is missing`, 'the API cannot boot without it (server/src/env.ts)');
}

const secret = process.env.JWT_SECRET ?? '';
if (secret) {
  // env.ts enforces both at boot; repeated here so preflight can be run
  // against a compose file BEFORE anything is started.
  if (/change[_-]?me/i.test(secret)) {
    bad('JWT_SECRET is still the example placeholder',
      'tenant identity comes solely from the JWT — a known secret is total cross-tenant compromise. openssl rand -base64 48');
  } else if (secret.length < 32) {
    bad(`JWT_SECRET is ${secret.length} characters`, 'needs at least 32 — openssl rand -base64 48');
  } else ok('JWT_SECRET is strong and not the placeholder');
}

// The two runtime roles must be distinct, and neither may be the superuser.
// An API holding the superuser connection string defeats RLS entirely: one
// dependency compromise reads every tenant.
const url = process.env.DATABASE_URL ?? '';
if (/^postgres(ql)?:\/\/postgres[:@]/.test(url)) {
  bad('DATABASE_URL connects as the postgres superuser',
    'the superuser BYPASSes RLS, so tenant isolation stops existing. Use app_user.');
} else if (url) ok('DATABASE_URL is not the superuser');

if (process.env.DATABASE_ADMIN_URL && PROD) {
  warn('DATABASE_ADMIN_URL is present in the API environment',
    'migrations should run in their own one-shot container so the long-lived API never holds a superuser credential');
}

// ─── 2. Where this deployment thinks it lives ───────────────────────────────
console.log('\n── Public address ──');
const publicUrl = (process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
if (!publicUrl) {
  bad('Neither PUBLIC_URL nor PUBLIC_BASE_URL is set',
    'WhatsApp connect refuses outright; click-to-call places calls whose status never returns');
} else if (!/^https?:\/\//i.test(publicUrl)) {
  bad(`PUBLIC_URL is not a URL: "${publicUrl}"`, 'it must include the scheme, e.g. https://erp.example.com');
} else if (/localhost|127\.0\.0\.1/i.test(publicUrl)) {
  bad(`PUBLIC_URL points at localhost: ${publicUrl}`,
    'a provider calling this back reaches its own container, and retries for hours');
} else {
  ok(`PUBLIC_URL is ${publicUrl}`);
  if (PROD && publicUrl.startsWith('http://')) {
    warn('PUBLIC_URL is http, not https',
      'sign-in credentials and every document download cross the network in clear text. deploy/enable-https.sh');
  }
}

const cors = process.env.CORS_ORIGIN ?? '';
if (PROD && /localhost/i.test(cors || 'http://localhost:5173')) {
  warn(`CORS_ORIGIN is "${cors || 'http://localhost:5173 (default)'}"`,
    'harmless when nginx serves the SPA and the API on one origin, wrong if the app is hosted separately');
} else if (cors) ok(`CORS_ORIGIN is ${cors}`);

// ─── 3. Uploaded documents ─────────────────────────────────────────────────
console.log('\n── Document storage ──');
const root = path.resolve(process.env.FILE_STORAGE_DIR ?? path.join(process.cwd(), 'var', 'uploads'));
if (!process.env.FILE_STORAGE_DIR) {
  warn(`FILE_STORAGE_DIR is unset, defaulting to ${root}`,
    'inside the image: uploads are destroyed by the next rebuild. Mount a volume and point this at it.');
} else if (root.startsWith(process.cwd())) {
  bad(`FILE_STORAGE_DIR (${root}) is inside the application directory`,
    'a rebuild replaces that layer and every stored agreement with it');
} else ok(`FILE_STORAGE_DIR is ${root}`);

// Writability is the one that actually broke: correct path, wrong owner.
try {
  await mkdir(root, { recursive: true });
  const probe = path.join(root, `.preflight-${process.pid}`);
  await writeFile(probe, 'ok');
  await unlink(probe);
  ok('the storage directory exists and is writable by this user');
} catch (err) {
  bad(`cannot write to ${root}: ${err.code ?? err.message}`,
    'document upload will fail with a 500. The image must create this path owned by the user the process runs as.');
}

// ─── 4. Mail ───────────────────────────────────────────────────────────────
console.log('\n── Outbound mail ──');
const consoleMail = process.env.MAIL_TRANSPORT === 'console';
const smtpReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
if (consoleMail) {
  if (PROD) bad('MAIL_TRANSPORT=console in production',
    'sign-in codes are PRINTED TO THE LOG instead of emailed — working credentials in plain text');
  else warn('MAIL_TRANSPORT=console', 'fine for a staging box, never for real users');
} else if (smtpReady) {
  ok('SMTP is configured');
  if (!process.env.SMTP_FROM) {
    warn('SMTP_FROM is unset', 'many providers reject a message with no From the account may send as');
  }
} else {
  bad('SMTP is not configured and MAIL_TRANSPORT is not console',
    'anyone with MFA enabled cannot sign in, and password reset is dead. Check the vars reach the CONTAINER, not just .env.');
}

// ─── 5. Optional integrations — reported, never failed ─────────────────────
console.log('\n── Optional integrations ──');
const group = (name, vars, note) => {
  const set = vars.filter(v => process.env[v]);
  if (set.length === 0) console.log(`  \x1b[90m·\x1b[0m ${name}: not configured — ${note}`);
  else if (set.length === vars.length) ok(`${name}: configured`);
  else warn(`${name}: PARTIALLY configured (${set.join(', ')})`,
    `missing ${vars.filter(v => !process.env[v]).join(', ')} — half-configured usually fails at the moment of use, not at boot`);
};
group('Razorpay payments', ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  'demands are still raised, payment is recorded by hand');
group('Exotel click-to-call', ['EXOTEL_ACCOUNT_SID', 'EXOTEL_API_KEY', 'EXOTEL_API_TOKEN'],
  'the call button reports telephony is unavailable');
group('WhatsApp gateway', ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY'],
  'the app falls back to click-to-chat links');

// ─── 6. The database it will actually talk to ──────────────────────────────
console.log('\n── Database ──');
if (url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    ok('the API role can connect');

    const { rows: [v] } = await client.query('SHOW server_version');
    ok(`PostgreSQL ${v.server_version}`);

    // Migrations. The API role can usually read _migrations; if it cannot,
    // say so rather than reporting a false all-clear.
    try {
      const { rows: applied } = await client.query('SELECT filename FROM _migrations');
      const seen = new Set(applied.map(r => r.filename));
      const dir = path.join(process.cwd(), 'migrations');
      if (existsSync(dir)) {
        const { readdir } = await import('node:fs/promises');
        const onDisk = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
        const pending = onDisk.filter(f => !seen.has(f));
        if (pending.length === 0) ok(`all ${onDisk.length} migrations are applied`);
        else bad(`${pending.length} migration(s) NOT applied: ${pending.join(', ')}`,
          'run the one-shot migrate service before serving traffic');
      } else {
        warn('migrations/ is not present in this container', 'cannot compare applied against on-disk');
      }
    } catch {
      warn('could not read _migrations as the API role', 'run this check from the migrate container to verify schema state');
    }

    // RLS is the guarantee the whole product rests on. A table carrying a
    // tenant_id with RLS off is a cross-tenant leak waiting for one query.
    try {
      const { rows: leaky } = await client.query(`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
           AND EXISTS (SELECT 1 FROM information_schema.columns col
                        WHERE col.table_name = c.relname AND col.column_name = 'tenant_id')
         ORDER BY 1`);
      if (leaky.length === 0) ok('every tenant-scoped table has RLS enabled and forced');
      else bad(`${leaky.length} tenant table(s) without forced RLS: ${leaky.map(r => r.relname).join(', ')}`,
        'these are readable across workspaces');
    } catch {
      warn('could not inspect RLS from this role', 'verify with npm run verify:rls against an admin connection');
    }

    await client.end();
  } catch (err) {
    bad(`cannot reach the database: ${err.message.slice(0, 120)}`);
    await client.end().catch(() => {});
  }
}

// ─── Verdict ───────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(64));
console.log(`  ${okCount} ok · ${warnings} advisory · ${blockers} blocker(s)`);
if (blockers) {
  console.log('\n  \x1b[31mNOT READY.\x1b[0m Each blocker above is something a customer meets on day one.');
} else if (warnings) {
  console.log('\n  \x1b[32mReady to serve.\x1b[0m Read the advisories — most are deliberate choices, some are not.');
} else {
  console.log('\n  \x1b[32mReady to serve.\x1b[0m');
}
console.log('');
process.exit(blockers ? 1 : 0);
