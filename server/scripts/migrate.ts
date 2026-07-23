/**
 * Migration runner. Connects as the ADMIN role (DATABASE_ADMIN_URL), creates
 * the runtime roles if missing (passwords from env — never in SQL files),
 * then applies migrations/*.sql in filename order, tracking what has run.
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
// Fail closed. The old `|| 'app_user_dev_only'` fallback would create the
// RLS-bound and BYPASSRLS roles with well-known, source-visible passwords if
// these env vars were ever missing — a predictable-credential footgun on the
// two most sensitive DB roles. Require them, matching the admin-URL guard above.
const appPassword = process.env.APP_USER_PASSWORD
  ?? (() => { throw new Error('APP_USER_PASSWORD is required'); })();
const platformPassword = process.env.APP_PLATFORM_PASSWORD
  ?? (() => { throw new Error('APP_PLATFORM_PASSWORD is required'); })();

// CREATE ROLE cannot be parameterized, so the two passwords are interpolated
// into DDL below with '' doubling under standard_conforming_strings. That is
// safe for ordinary text but a NUL byte or backslash can still confuse the
// wire/parse layer — reject those outright so a hostile or fat-fingered
// secret can never reach the DDL string. (Normal random secrets pass.)
for (const [name, pw] of [['APP_USER_PASSWORD', appPassword], ['APP_PLATFORM_PASSWORD', platformPassword]] as const) {
  if (/[\0\\]/.test(pw)) throw new Error(`${name} must not contain NUL or backslash characters`);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
// CREATE ROLE cannot be parameterized; the '' doubling below is only safe
// with standard conforming strings, so pin it for this session
await client.query('SET standard_conforming_strings = on');

// 1. Runtime roles (idempotent; passwords come from env)
const { rows: existing } = await client.query(
  `SELECT rolname FROM pg_roles WHERE rolname IN ('app_user', 'app_platform')`,
);
const have = new Set(existing.map(r => r.rolname));
if (!have.has('app_user')) {
  await client.query(`CREATE ROLE app_user LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}' NOBYPASSRLS`);
  console.log('created role app_user');
}
if (!have.has('app_platform')) {
  await client.query(`CREATE ROLE app_platform LOGIN PASSWORD '${platformPassword.replace(/'/g, "''")}' BYPASSRLS`);
  console.log('created role app_platform');
}

// 2. Migration bookkeeping
await client.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

// 3. Apply pending migrations in order, each in its own transaction
const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
for (const file of files) {
  const { rows } = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
  if (rows.length > 0) { console.log(`skip    ${file} (already applied)`); continue; }
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAILED  ${file}`);
    throw err;
  }
}

await client.end();
console.log('migrations complete');
