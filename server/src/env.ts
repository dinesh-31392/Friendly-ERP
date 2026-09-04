import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Tenant identity comes SOLELY from the JWT, so a weak or placeholder secret
 * means anyone can forge a token for any tenant — total cross-tenant
 * compromise. `.env.production.example` ships
 * `CHANGE_ME_min_32_chars_random_string!!`, which satisfied a mere presence
 * check, so a copy-paste deploy would boot happily with a publicly known
 * secret. Fail fast at boot instead.
 */
function requiredSecret(name: string, min = 32): string {
  const v = required(name);
  if (/change[_-]?me/i.test(v)) {
    throw new Error(`${name} is still the example placeholder — generate one: openssl rand -base64 48`);
  }
  if (v.length < min) {
    throw new Error(`${name} must be at least ${min} characters (got ${v.length}) — openssl rand -base64 48`);
  }
  return v;
}

/** `Number('abc')` is NaN, and Node binds a RANDOM port for NaN — nginx's
 *  proxy_pass to :4000 would then 502 with no obvious cause. */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer 1-65535 (got "${raw}")`);
  }
  return n;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  databasePlatformUrl: required('DATABASE_PLATFORM_URL'),
  jwtSecret: requiredSecret('JWT_SECRET'),
  port: port('PORT', 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  /**
   * Login attempts allowed per address per minute. Five is the production
   * value and the default, because the login route is the one place an
   * attacker can guess a password and the cap is what makes guessing
   * expensive.
   *
   * It is settable only so the verification suites can run back to back.
   * Thirteen suites signing in sequentially exhaust five attempts in the
   * first minute, and every suite after that fails for a reason that has
   * nothing to do with what it tests. CI raises this; nothing else should.
   */
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 5,

  /**
   * The address this API is reachable at from the outside world, with no
   * trailing slash. Empty when the deployment has not been told.
   *
   * TWO NAMES, ONE MEANING, AND THE BUG THAT CAUSED.
   *
   * WhatsApp read `PUBLIC_URL || PUBLIC_BASE_URL`; telephony read only
   * `PUBLIC_BASE_URL`. deploy/docker-compose.prod.yml sets only `PUBLIC_URL`.
   * So a correct production deploy gave WhatsApp its webhook host and left
   * click-to-call with an empty string — and click-to-call treats empty as
   * "this deployment does not know its own address" and places the call with
   * NO callback URL. The call connects; the status, duration and recording
   * never come back; nothing errors. A silent half-working feature.
   *
   * Resolved once, here, so a third caller cannot invent a third spelling.
   */
  publicBaseUrl: (process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL || '')
    .trim().replace(/\/+$/, ''),
};
