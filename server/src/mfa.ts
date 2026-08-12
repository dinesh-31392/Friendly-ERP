import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { platformPool } from './db.js';
import { env } from './env.js';
import { sendLoginCode, mailConfigured } from './mailer.js';

/**
 * Email one-time codes as a second factor.
 *
 * Runs on the platform pool because it operates BEFORE a session exists —
 * there is no tenant context to scope by yet, which is the same reason the
 * credential lookup in authRoutes does.
 */

const CODE_TTL_MINUTES = Number(process.env.MFA_CODE_TTL_MINUTES ?? 10);
const MAX_ATTEMPTS = 5;
/** Resends per user per hour. Stops the login form being used as a mail cannon. */
const MAX_CHALLENGES_PER_HOUR = 6;

/**
 * HMAC, not a plain hash. Six digits is a 10^6 space — a bare SHA-256 of it
 * falls to an exhaustive search in milliseconds, so a leaked table would hand
 * over live codes. Keyed with the app secret, which lives outside the database,
 * a reader who has the dump still cannot verify a guess.
 */
function hashCode(code: string, challengeSalt: string): string {
  return createHmac('sha256', env.jwtSecret).update(`${challengeSalt}:${code}`).digest('hex');
}

/** Constant-time compare so a wrong code cannot be narrowed down by timing. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface MfaUser { id: string; email: string; name: string }

/**
 * Issue a challenge and email the code.
 *
 * Throws only when the code could not be delivered — the caller must NOT hand
 * out a token in that case. Silently continuing would let a misconfigured SMTP
 * server turn MFA off without anyone noticing.
 */
export async function startEmailChallenge(user: MfaUser, ip: string): Promise<string> {
  if (!mailConfigured()) {
    throw new Error('Two-factor authentication is enabled for this account but email is not configured on the server');
  }

  const { rows: [recent] } = await platformPool.query(
    `SELECT count(*)::int AS n FROM login_challenges
      WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id]);
  if (recent.n >= MAX_CHALLENGES_PER_HOUR) {
    throw new Error('Too many sign-in codes requested. Try again later.');
  }

  // Any earlier live challenge is retired, so only the newest code works — two
  // valid codes in a mailbox is a needless second thing to steal.
  await platformPool.query(
    `UPDATE login_challenges SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]);

  // randomInt is CSPRNG-backed; Math.random here would be predictable.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

  const { rows: [row] } = await platformPool.query(
    `INSERT INTO login_challenges (user_id, code_hash, expires_at, request_ip)
     VALUES ($1, 'pending', now() + ($2 || ' minutes')::interval, $3)
     RETURNING id`,
    [user.id, String(CODE_TTL_MINUTES), ip || null]);

  // Salt with the row id so two users holding the same code have different
  // hashes, and a hash cannot be replayed against another challenge.
  await platformPool.query(
    `UPDATE login_challenges SET code_hash = $2 WHERE id = $1`,
    [row.id, hashCode(code, row.id)]);

  try {
    await sendLoginCode(user.email, user.name, code, CODE_TTL_MINUTES);
  } catch (err) {
    // Burn the challenge: an undeliverable code must not sit there valid.
    await platformPool.query(`UPDATE login_challenges SET consumed_at = now() WHERE id = $1`, [row.id]);
    throw new Error('Could not send the sign-in code. Check the server mail configuration.');
  }

  return row.id as string;
}

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/**
 * Check a submitted code and consume the challenge.
 *
 * Every failure returns the same message. Distinguishing "expired" from "wrong"
 * from "no such challenge" tells an attacker which of their guesses was close
 * to a real one.
 */
export async function verifyEmailChallenge(challengeId: string, code: string): Promise<VerifyResult> {
  const generic = { ok: false as const, error: 'That code is not valid. Request a new one.' };

  const { rows: [ch] } = await platformPool.query(
    `SELECT id, user_id, code_hash, attempts, consumed_at, expires_at
       FROM login_challenges WHERE id = $1`, [challengeId]);
  if (!ch || ch.consumed_at || new Date(ch.expires_at) < new Date()) return generic;

  if (ch.attempts >= MAX_ATTEMPTS) {
    await platformPool.query(`UPDATE login_challenges SET consumed_at = now() WHERE id = $1`, [ch.id]);
    return generic;
  }

  // Count the attempt BEFORE comparing, so a crash mid-verify cannot be used to
  // retry for free.
  await platformPool.query(`UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1`, [ch.id]);

  if (!sameHash(ch.code_hash, hashCode(code, ch.id))) return generic;

  // Consume on success. The UPDATE is conditional on it still being unconsumed,
  // so two requests racing with the same correct code produce exactly one login.
  const { rowCount } = await platformPool.query(
    `UPDATE login_challenges SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`, [ch.id]);
  if (!rowCount) return generic;

  return { ok: true, userId: ch.user_id as string };
}

/** Housekeeping: drop challenges nobody can use any more. */
export async function purgeExpiredChallenges(): Promise<number> {
  const { rowCount } = await platformPool.query(
    `DELETE FROM login_challenges WHERE created_at < now() - interval '7 days'`);
  return rowCount ?? 0;
}
