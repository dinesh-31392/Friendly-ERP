import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { platformPool, withTenantContext } from '../db.js';
import { startEmailChallenge, verifyEmailChallenge } from '../mfa.js';
import { signToken, verifyPassword, hashPassword, requireAuth } from '../auth.js';
import { env } from '../env.js';

/**
 * A real argon2id hash of a random value, computed once at boot. Login verifies
 * against this when the email is unknown, so the response costs the same argon2
 * work either way. Without it, an unknown email returned in ~0ms vs ~278ms for a
 * known one — a reliable account-enumeration oracle despite the identical body.
 */
const DUMMY_HASH_PROMISE = hashPassword(randomUUID());

/**
 * Per-account failed-login throttle. The route's per-IP cap (5/min) does not
 * stop DISTRIBUTED credential stuffing — a botnet gets 5 tries per IP against
 * one known admin email. This adds an account-level brake: after
 * MAX_FAILS failed attempts for an email within WINDOW_MS, further attempts
 * are refused until the window rolls off, independent of source IP.
 *
 * Tradeoff (accepted, standard): an attacker can briefly lock a victim out by
 * burning failures against their email. The window is short and self-healing,
 * a correct login clears the counter immediately, and the threshold is set
 * well above normal fat-finger retries. In-memory + size-capped so a flood of
 * distinct emails can't exhaust the heap; good enough for a single node, and
 * the honest place for this state at scale is Redis.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 15;
const MAX_TRACKED = 20_000;
const failByEmail = new Map<string, { count: number; first: number }>();

function throttleState(email: string): { blocked: boolean } {
  const rec = failByEmail.get(email);
  if (!rec) return { blocked: false };
  if (Date.now() - rec.first > WINDOW_MS) { failByEmail.delete(email); return { blocked: false }; }
  return { blocked: rec.count >= MAX_FAILS };
}

function recordFail(email: string): void {
  const now = Date.now();
  const rec = failByEmail.get(email);
  if (!rec || now - rec.first > WINDOW_MS) {
    // Opportunistic prune before growing the map, so distinct-email floods
    // can't grow it without bound.
    if (failByEmail.size >= MAX_TRACKED) {
      for (const [k, v] of failByEmail) if (now - v.first > WINDOW_MS) failByEmail.delete(k);
    }
    if (failByEmail.size < MAX_TRACKED) failByEmail.set(email, { count: 1, first: now });
    return;
  }
  rec.count += 1;
}

function clearFails(email: string): void {
  failByEmail.delete(email);
}

interface LoginBody {
  email?: string;
  password?: string;
  tenantSlug?: string;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/auth/login
   * Credential lookup runs on the platform pool (BYPASSRLS) because identity
   * — and therefore tenant context — is not yet known. This is the ONLY
   * route allowed to touch that pool, and it reads exactly one user row.
   */
  app.post<{ Body: LoginBody }>('/api/auth/login', {
    // Tight brute-force cap, per address — see env.authRateLimitMax.
    config: { rateLimit: { max: env.authRateLimitMax, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 200 },
          tenantSlug: { type: 'string', maxLength: 80 },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password, tenantSlug } = req.body || {};
    if (!email || !password) {
      return reply.code(400).send({ error: 'email and password are required' });
    }
    const emailKey = email.toLowerCase();

    // Account-level brake against distributed stuffing (see failByEmail above).
    if (throttleState(emailKey).blocked) {
      return reply.code(429).send({ error: 'Too many failed attempts for this account. Try again later.' });
    }

    const { rows } = await platformPool.query(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.password_hash, u.active,
              u.must_change_password, u.mfa_email_enabled,
              r.name AS role_name,
              t.name AS tenant_name, t.company, t.slug, t.plan, t.status,
              t.currency, t.country, t.primary_color, t.logo_url
         FROM users u
         JOIN roles r   ON r.id = u.role_id
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.email = $1
          AND ($2::text IS NULL OR t.slug = $2)
        LIMIT 2`,
      [email.toLowerCase(), tenantSlug ?? null],
    );

    // Constant-shape failure: same message for unknown email / bad password /
    // suspended workspace, to avoid account enumeration. Each failure also
    // feeds the per-account throttle.
    const fail = () => {
      recordFail(emailKey);
      return reply.code(401).send({ error: 'Invalid email or password' });
    };

    const user = rows[0];
    // Always spend one argon2 verify — against the user's hash when we have one,
    // against DUMMY_HASH otherwise — so an unknown email cannot be distinguished
    // by response time. Returning early here (before verify) was the enumeration
    // oracle the comment above claims to prevent. Every failure mode below is
    // collapsed into a single fail() with identical body AND comparable timing.
    const dummyHash = await DUMMY_HASH_PROMISE;
    const passwordOk = await verifyPassword(user?.password_hash ?? dummyHash, password);
    if (!user || rows.length > 1) return fail();       // ambiguous email → require tenantSlug
    if (!passwordOk) return fail();
    if (!user.active) return fail();
    // Deliberate divergence from the constant-shape rule: this fires only
    // AFTER password verification, so it informs a legitimate credential
    // holder (correct UX) without enabling unauthenticated enumeration.
    if (user.status === 'suspended') {
      return reply.code(403).send({ error: 'This workspace has been suspended. Contact support.' });
    }

    // Genuine success clears the account's failed-attempt counter at once, so
    // a real user who mistyped a few times is never left throttled.
    clearFails(emailKey);
    await platformPool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    // ── Second factor ───────────────────────────────────────────────────
    // Password alone is not enough for an account that has MFA on. The token
    // is NOT minted here — a challenge is issued and the caller must come back
    // to /api/auth/verify-code with what landed in their inbox.
    if (user.mfa_email_enabled) {
      try {
        const challengeId = await startEmailChallenge(
          { id: user.id, email: user.email, name: user.name }, req.ip);
        reply.code(200);
        return {
          mfaRequired: true,
          challengeId,
          // Enough to render "we sent a code to p•••@example.com" without
          // printing an address the person at the keyboard may not own.
          sentTo: maskEmail(user.email),
        };
      } catch (err) {
        // Mail is down, or the resend cap was hit. Never fall through to a
        // token — a broken mail server must not silently disable MFA.
        return reply.code(503).send({
          error: err instanceof Error ? err.message : 'Could not send the sign-in code',
        });
      }
    }

    const token = signToken({ sub: user.id, tid: user.tenant_id, rol: user.role_name });
    return {
      token,
      // mustChangePassword drives the blocking ForcePasswordChange screen. It
      // has to travel with the login response, or an admin-issued temporary
      // password silently becomes the user's permanent one.
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role_name,
        mustChangePassword: user.must_change_password,
      },
      tenant: {
        id: user.tenant_id, name: user.tenant_name, company: user.company,
        slug: user.slug, plan: user.plan, status: user.status,
        currency: user.currency, country: user.country,
        primaryColor: user.primary_color, logoUrl: user.logo_url,
      },
    };
  });

  /** GET /api/auth/me — whoami + permission list (RLS-scoped, RBAC from DB). */
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [me] } = await db.query(
        `SELECT u.id, u.name, u.email, u.must_change_password AS "mustChangePassword",
                r.name AS role
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.id = app_current_user() AND u.active`,
      );
      // No active user for this token — deactivated/deleted since it was issued,
      // or the row is otherwise gone. Return 401 rather than 200 with a null user.
      if (!me) return reply.code(401).send({ error: 'Account is inactive' });
      const { rows: perms } = await db.query(
        `SELECT rp.permission_key
           FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id
          WHERE u.id = app_current_user()`,
      );
      return { user: me, permissions: perms.map(p => p.permission_key) };
    }),
  );

  /**
   * POST /api/auth/logout — end THIS session.
   *
   * Discarding the token client-side was the whole of "logging out" before
   * this, which is not a logout at all: the token stayed valid for the rest of
   * its 24 hours in anyone's hands, including whoever picked up the shared
   * tablet in the site office. Recording the jti is what makes the word true.
   *
   * Idempotent by ON CONFLICT: signing out twice is not an error, and a client
   * retrying on a flaky connection should not see one.
   */
  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!req.ctx.jti) {
        // A token minted before migration 037 has no handle to revoke. Say so
        // rather than reporting a success that did nothing.
        reply.code(409);
        return { error: 'This session predates revocation support — sign out everywhere instead.' };
      }
      await db.query(
        `INSERT INTO revoked_tokens (jti, tenant_id, user_id, expires_at, reason)
         VALUES ($1, app_current_tenant(), app_current_user(), to_timestamp($2), 'logout')
         ON CONFLICT (jti) DO NOTHING`,
        [req.ctx.jti, (req.ctx.issuedAt ?? 0) + 24 * 60 * 60]);
      // Opportunistic pruning: once a token's own expiry has passed, the
      // deny-list row is dead weight — signature verification would refuse it
      // anyway. Doing this here means there is no scheduled job to forget to
      // deploy, and the cost lands on the rare request rather than every one.
      await db.query(`DELETE FROM revoked_tokens WHERE expires_at < now()`);
      reply.code(200);
      return { ok: true, scope: 'this-session' };
    }),
  );

  /**
   * POST /api/auth/logout-all — end EVERY session for this user.
   *
   * The deny-list cannot express this: the other outstanding jtis were never
   * stored anywhere. Moving the watermark forward invalidates them by their
   * issue time instead, which is why the column exists.
   *
   * This is the honest answer to "my phone was stolen".
   */
  app.post('/api/auth/logout-all', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      // A JWT `iat` counts whole seconds, so "issued just before this call" and
      // "issued just after" are indistinguishable within the same second. That
      // ambiguity has to break one way or the other, and a security control
      // breaks closed: the watermark is set to the START OF THE NEXT SECOND, so
      // every token bearing this second or earlier is dead.
      //
      // The cost is that signing back in during the same second yields a token
      // that is already invalid. That is under a second of delay for a human
      // who just asked to be signed out everywhere, and the alternative is a
      // one-second window in which a stolen token still works.
      await db.query(
        `UPDATE users
            SET sessions_valid_from = date_trunc('second', now()) + interval '1 second'
          WHERE id = app_current_user()`);
      reply.code(200);
      return { ok: true, scope: 'all-sessions' };
    }),
  );
  /**
   * POST /api/auth/verify-code — exchange an emailed code for a session.
   *
   * The second half of an MFA login. Rate limited harder than the password
   * step: six digits is a small space, and the per-challenge attempt cap only
   * protects one challenge at a time.
   */
  app.post<{ Body: { challengeId: string; code: string } }>('/api/auth/verify-code', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['challengeId', 'code'], additionalProperties: false,
        properties: {
          challengeId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
          code: { type: 'string', pattern: '^[0-9]{6}$' },
        },
      },
    },
  }, async (req, reply) => {
    const result = await verifyEmailChallenge(req.body.challengeId, req.body.code);
    if (!result.ok) return reply.code(401).send({ error: result.error });

    // Re-read the user AFTER the code checks out. Anything could have changed
    // between the password step and now — deactivation especially, which must
    // take effect immediately rather than at the next login.
    const { rows } = await platformPool.query(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.active, u.must_change_password,
              r.name AS role_name,
              t.name AS tenant_name, t.company, t.slug, t.plan, t.status,
              t.currency, t.country, t.primary_color, t.logo_url
         FROM users u
         JOIN roles r   ON r.id = u.role_id
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [result.userId],
    );
    const user = rows[0];
    if (!user || !user.active) return reply.code(401).send({ error: 'That code is not valid. Request a new one.' });
    if (user.status === 'suspended') {
      return reply.code(403).send({ error: 'This workspace has been suspended. Contact support.' });
    }

    await platformPool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const token = signToken({ sub: user.id, tid: user.tenant_id, rol: user.role_name });
    return {
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role_name,
        mustChangePassword: user.must_change_password,
      },
      tenant: {
        id: user.tenant_id, name: user.tenant_name, company: user.company,
        slug: user.slug, plan: user.plan, status: user.status,
        currency: user.currency, country: user.country,
        primaryColor: user.primary_color, logoUrl: user.logo_url,
      },
    };
  });

/** p•••a@example.com — enough to recognise, not enough to learn. */
function maskEmail(email: string): string {
  const [local, domain] = String(email).split('@');
  if (!domain) return '•••';
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : '';
  return `${head}${'•'.repeat(3)}${tail}@${domain}`;
}

}
