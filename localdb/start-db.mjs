/**
 * Local PostgreSQL for Friendly CRM — no Docker, no installer.
 *
 * Runs the REAL Postgres 18 binary (bundled by embedded-postgres) on port 5433,
 * with a persistent data directory. The Fastify backend connects to it exactly
 * as it would to a production Postgres.
 *
 *   node start-db.mjs        # starts + keeps running (Ctrl+C to stop)
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'pgdata');
const PORT = 5433;

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  authMethod: 'password',        // cleartext over loopback only — local dev
  persistent: true,              // keep data across restarts
  onLog: (m) => { if (/error|fatal|ready/i.test(m)) console.log('[pg]', m.trim()); },
});

const fresh = !existsSync(join(DATA_DIR, 'PG_VERSION'));
if (fresh) {
  console.log('initialising data directory (first run)...');
  await pg.initialise();
}
await pg.start();
console.log(`PostgreSQL 18 running on localhost:${PORT} (data: ${DATA_DIR})`);

try {
  await pg.createDatabase('friendly_crm');
  console.log('created database: friendly_crm');
} catch (e) {
  console.log(`database friendly_crm: ${/already exists/i.test(e.message) ? 'already exists' : e.message}`);
}

console.log('\nDB ready. Leave this running. Ctrl+C to stop.\n');

const shutdown = async () => { try { await pg.stop(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
