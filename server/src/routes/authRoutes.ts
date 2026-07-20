import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { platformPool, withTenantContext } from '../db.js';
import { signToken, verifyPassword, hashPassword, requireAuth } from '../auth.js';

/**
 * A real argon2id hash of a random value, computed once at boot. Login verifies
 * against this when the email is unknown, so the response costs the same argon2
 * work either way. Without it, an unknown email returned in ~0ms vs ~278ms for a
 * known one — a reliable account-enumeration oracle despite the identical body.
 */
const DUMMY_HASH_PROMISE = hashPassword(randomUUID());

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
    // Tight brute-force cap: 5 login attempts per IP per minute
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
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

    const { rows } = await platformPool.query(
      `SELECT u.id, u.tenant_id, u.name, u.email, u.password_hash, u.active,
              u.must_change_password,
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
    // suspended workspace, to avoid account enumeration.
    const fail = () => reply.code(401).send({ error: 'Invalid email or password' });

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

    await platformPool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

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
}
