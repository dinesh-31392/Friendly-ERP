/**
 * Export every row of a workspace database as re-runnable SQL.
 *
 *   node scripts/export-data.mjs [outfile]
 *
 * WHY NOT pg_dump
 *
 * The embedded Postgres this project runs locally ships only `pg_ctl` — there is
 * no `pg_dump` or `psql` binary anywhere in the tree. Copying `localdb/pgdata`
 * instead would mean shipping 262 MB for a 23 MB database, and a physical copy
 * only restores into the same major version on the same architecture. This
 * writes plain SQL that loads into any Postgres of the right schema.
 *
 * WHAT IT DOES NOT DO
 *
 * Schema. The schema is `server/migrations/*.sql`, applied in order by
 * `migrate.ts`, and that is the only thing that should ever create it — a
 * deployment built from a dump of somebody's laptop is a deployment nobody can
 * reproduce. Run the migrations first, then load this.
 *
 * FOREIGN KEYS
 *
 * Rows are written table by table, and the order is not a topological sort, so
 * a child can precede its parent. Rather than compute the order, the output
 * wraps itself in `session_replication_role = replica`, which defers FK and
 * trigger checks for the load and restores them at the end. Postgres still
 * validates the constraints on the next write; this only relaxes them while the
 * data goes in, which is exactly what pg_dump --disable-triggers does.
 */
import 'dotenv/config';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) { console.error('DATABASE_ADMIN_URL is required'); process.exit(1); }
const out = process.argv[2] ?? 'data.sql';

const c = new pg.Client(url);
await c.connect();

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

/**
 * A JS value as a SQL literal.
 *
 * standard_conforming_strings is on by default, so a backslash is an ordinary
 * character and only the quote needs doubling. Buffers become bytea hex, which
 * round-trips exactly; Date becomes an ISO string so the timezone survives.
 */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (Array.isArray(v) || typeof v === 'object') {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const { rows: tables } = await c.query(`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name`);

/**
 * Columns Postgres computes for itself, which an INSERT may not supply.
 *
 * `SELECT *` returns them like any other column, so a naive export writes them
 * into the INSERT and the whole load aborts on the first row with
 * "cannot insert a non-DEFAULT value into column". Three exist today —
 * leads.phone_normalized, lease_invoices.total_amount, owner_payouts.net_payable
 * — but this reads the catalog rather than naming them, so a generated column
 * added later does not quietly break the export.
 *
 * Found by restoring into a scratch database rather than by reading the schema.
 */
const { rows: generated } = await c.query(`
  SELECT table_name, column_name FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (is_generated = 'ALWAYS' OR identity_generation = 'ALWAYS')`);
const skip = new Map();
for (const g of generated) {
  if (!skip.has(g.table_name)) skip.set(g.table_name, new Set());
  skip.get(g.table_name).add(g.column_name);
}

const parts = [
  '-- Friendly ERP — data export',
  `-- ${new Date().toISOString()}`,
  '--',
  '-- Load AFTER the schema exists (npx tsx scripts/migrate.ts).',
  '-- Wrapped in a transaction: it either all lands or none of it does.',
  '',
  'BEGIN;',
  "SET session_replication_role = replica;   -- defer FK checks during the load",
  '',
];

let totalRows = 0, nonEmpty = 0;
for (const { table_name: t } of tables) {
  const { rows } = await c.query(`SELECT * FROM ${ident(t)}`);
  if (!rows.length) continue;
  nonEmpty++; totalRows += rows.length;
  const omit = skip.get(t) ?? new Set();
  const cols = Object.keys(rows[0]).filter(k => !omit.has(k));
  parts.push(`-- ${t} (${rows.length})`);
  parts.push(`DELETE FROM ${ident(t)};`);
  for (const r of rows) {
    parts.push(
      `INSERT INTO ${ident(t)} (${cols.map(ident).join(', ')}) VALUES (${cols.map(k => lit(r[k])).join(', ')});`,
    );
  }
  parts.push('');
}

// Sequences carry their own state; without this a later INSERT reuses an id
// that is already taken and fails on the primary key.
const { rows: seqs } = await c.query(
  `SELECT sequence_schema, sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'`);
if (seqs.length) {
  parts.push('-- sequence positions');
  for (const s of seqs) {
    const { rows: [v] } = await c.query(`SELECT last_value, is_called FROM ${ident(s.sequence_name)}`);
    parts.push(`SELECT setval('${s.sequence_name}', ${v.last_value}, ${v.is_called});`);
  }
  parts.push('');
}

parts.push("SET session_replication_role = DEFAULT;", 'COMMIT;', '');
writeFileSync(out, parts.join('\n'), 'utf8');

console.log(`  ${out}`);
console.log(`  ${nonEmpty} tables with data, ${totalRows} rows, ${seqs.length} sequences`);
await c.end();
