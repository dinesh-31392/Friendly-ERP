import { platformPool } from './db.js';

/**
 * Making a background tick safe to run on more than one instance.
 *
 * WHAT WAS WRONG
 *
 * The outbox worker guarded itself with a module-level `running` flag, which
 * prevents a slow tick from overlapping ITSELF and nothing else. Run two
 * instances — which is what happens the moment anyone scales out, and also
 * happens for thirty seconds during every rolling deploy while the old
 * container drains — and both tick, both claim the same pending rows, and the
 * customer receives the greeting twice.
 *
 * A duplicate WhatsApp message to a lead is not a cosmetic failure. It is the
 * kind of thing that gets a sender number reported and blocked.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * A Postgres advisory lock, not a job framework. This product deploys as one
 * Node process beside one Postgres, and it has exactly one recurring worker; a
 * queue table with visibility timeouts, retry counts and dead-letter handling
 * would be a great deal of machinery guarding a single caller.
 *
 * What it does buy is the property that actually matters: at most one instance
 * in the cluster runs a given tick at a time, enforced by the database rather
 * than by a variable in one process's memory. If a third worker appears, or the
 * deployment grows past one instance, the guarantee already holds.
 *
 * The limit worth naming: an advisory lock is held for the life of a SESSION,
 * so a process that is killed mid-tick releases it when its connection dies —
 * which is the behaviour you want — but a process that hangs holds it until the
 * connection is reaped. That is why the lock is taken per tick rather than once
 * at boot.
 */

/**
 * Run `fn` only if this instance can take the named lock; otherwise skip.
 *
 * Returns `null` when the lock was already held elsewhere, so a caller can tell
 * "another instance is doing it" apart from "it ran and produced nothing".
 *
 * The platform pool is used deliberately: the lock is cluster-wide rather than
 * tenant-scoped, and it must not be entangled with a tenant's RLS session.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  // The lock must be taken, held and released on ONE connection — an advisory
  // lock belongs to a session, so acquiring it through the pool and releasing
  // it through a different checkout would leave it held forever.
  const client = await platformPool.connect();
  try {
    const { rows: [{ locked }] } = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!locked) return null;
    try {
      return await fn();
    } finally {
      // Released even if the tick threw. Without this a single unhandled error
      // would stop every instance from ever ticking again.
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    client.release();
  }
}

export interface LeaderIntervalOptions {
  /** Lock name. Two workers sharing a name will never run at the same time. */
  key: string;
  everyMs: number;
  log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * A repeating tick that only one instance runs at a time.
 *
 * The first fire is jittered. Instances started together by an orchestrator
 * otherwise tick in lockstep forever: every interval they all wake, all try the
 * lock, one wins and the rest do a pointless round trip. Spreading the start
 * means the winner is usually already inside the lock when the others look.
 */
export function startLeaderInterval(
  fn: () => Promise<void>,
  { key, everyMs, log }: LeaderIntervalOptions,
): NodeJS.Timeout {
  const run = async () => {
    try {
      const result = await withAdvisoryLock(key, fn);
      if (result === null) log?.info({ key }, 'tick skipped — another instance holds the lock');
    } catch (err) {
      // A tick that throws must not take the process with it, and must not stop
      // the interval: the next one may well succeed.
      log?.error({ key, err: String(err) }, 'scheduled tick failed');
    }
  };

  const jitter = Math.floor(Math.random() * Math.min(everyMs, 5_000));
  const timer = setInterval(run, everyMs);
  const first = setTimeout(run, jitter);
  // Neither should hold the process open at shutdown.
  timer.unref?.();
  first.unref?.();
  return timer;
}
