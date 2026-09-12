/**
 * The lock that stops two instances doing the same work.
 *
 * WHAT THIS IS FOR
 *
 * The outbox worker guarded itself with a module-level `running` flag. That
 * prevents a slow tick from overlapping ITSELF, and nothing else. Run two
 * instances — which happens the moment anyone scales out, and also happens for
 * thirty seconds during every rolling deploy while the old container drains —
 * and both tick, both claim the same pending rows, and the lead receives the
 * greeting twice.
 *
 * A duplicate WhatsApp to a customer is not cosmetic. It is how a sender number
 * gets reported and blocked.
 *
 * This exercises the lock directly rather than through the worker, because the
 * property under test is "two callers, one winner", and reproducing that with
 * two API processes and a real gateway would test the gateway instead.
 */
import pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';

const ADMIN = process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

/**
 * A stand-in for one API instance: its own connection, exactly as the real
 * scheduler takes one from the pool. Two of these ARE two instances as far as
 * an advisory lock is concerned — the lock is per session, not per process.
 */
class Instance {
  constructor(name) { this.name = name; this.client = new pg.Client(ADMIN); }
  async connect() { await this.client.connect(); return this; }
  async close() { await this.client.end(); }

  async withLock(key, fn) {
    const { rows: [{ locked }] } = await this.client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!locked) return null;
    try { return await fn(); }
    finally { await this.client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
  }

  heldLocks() {
    return this.client.query(
      `SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`)
      .then(r => r.rows[0].n);
  }
}

const KEY = 'verify-scheduler-' + Math.random().toString(36).slice(2, 8);
const a = await new Instance('a').connect();
const b = await new Instance('b').connect();

console.log('\n=== TWO INSTANCES, ONE WINNER ===');
// The shape of the real failure: both tick at the same moment, both look at the
// same queue. Exactly one must get through.
const sent = [];
const [ra, rb] = await Promise.all([
  a.withLock(KEY, async () => { await sleep(120); sent.push('a'); return 'a'; }),
  // Started a beat later, which is what a lockstep interval actually looks like.
  sleep(15).then(() => b.withLock(KEY, async () => { sent.push('b'); return 'b'; })),
]);
ok('exactly one instance ran the work', sent.length === 1, `ran: ${sent.join(',') || 'none'}`);
ok('the other was told it was locked out, not silently no-opped',
   (ra === null) !== (rb === null), `a=${ra} b=${rb}`);
ok('and the winner returned its result', (ra ?? rb) === sent[0], `${ra ?? rb} vs ${sent[0]}`);

console.log('\n=== THE LOCK IS RELEASED AFTERWARDS ===');
ok('the winner holds nothing once it is done', (await a.heldLocks()) === 0, String(await a.heldLocks()));
const second = await b.withLock(KEY, async () => 'b-later');
ok('so the next tick can take it', second === 'b-later', String(second));

console.log('\n=== A TICK THAT THROWS DOES NOT WEDGE THE LOCK FOREVER ===');
// Without a finally, one unhandled error would stop EVERY instance from ever
// ticking again — a failure that looks like the feature quietly disappearing.
let threw = false;
try {
  await a.withLock(KEY, async () => { throw new Error('gateway exploded'); });
} catch { threw = true; }
ok('the error still propagates to the caller', threw);
ok('but the lock is not left held', (await a.heldLocks()) === 0, String(await a.heldLocks()));
const afterThrow = await b.withLock(KEY, async () => 'recovered');
ok('and the next tick runs normally', afterThrow === 'recovered', String(afterThrow));

console.log('\n=== A DEAD INSTANCE RELEASES ITS LOCK ===');
// The realistic crash: a container is killed mid-tick. Postgres drops the
// session, and with it the advisory lock — which is the whole reason to use one
// rather than a row someone has to remember to clear.
const doomed = await new Instance('doomed').connect();
const held = await doomed.client.query(
  'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [KEY]);
ok('the doomed instance took the lock', held.rows[0].locked === true);
const blockedWhileHeld = await a.withLock(KEY, async () => 'should not run');
ok('and blocks the others while it lives', blockedWhileHeld === null, String(blockedWhileHeld));

await doomed.close();          // the crash
await sleep(150);
const afterDeath = await a.withLock(KEY, async () => 'took over');
ok('once it dies, another instance takes over', afterDeath === 'took over', String(afterDeath));

console.log('\n=== DIFFERENT WORKERS DO NOT BLOCK EACH OTHER ===');
// A single global lock would serialise unrelated workers, so adding a second
// one would silently halve the throughput of the first.
const other = KEY + '-other';
const both = await Promise.all([
  a.withLock(KEY, async () => { await sleep(80); return 'first'; }),
  b.withLock(other, async () => { await sleep(80); return 'second'; }),
]);
ok('two different keys run concurrently', both[0] === 'first' && both[1] === 'second',
   JSON.stringify(both));

console.log('\n=== THE KEY IS STABLE ACROSS PROCESSES ===');
// hashtext must give the same number everywhere, or two instances would take
// two different locks and both run — the bug this exists to prevent, hidden.
const h1 = (await a.client.query('SELECT hashtext($1) AS h', ['whatsapp-outbox'])).rows[0].h;
const h2 = (await b.client.query('SELECT hashtext($1) AS h', ['whatsapp-outbox'])).rows[0].h;
ok('the same name hashes the same on every connection', h1 === h2, `${h1} vs ${h2}`);
const h3 = (await a.client.query('SELECT hashtext($1) AS h', ['whatsapp-outbox-2'])).rows[0].h;
ok('and different names do not collide', h1 !== h3, `${h1} vs ${h3}`);

await a.close(); await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
