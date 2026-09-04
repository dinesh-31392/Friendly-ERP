import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Sign-in history, and the attendance it may propose (migration 060).
 *
 * WHAT A SESSION IS EVIDENCE OF
 *
 * That an account was signed in. Not that a person was at work, and certainly
 * not how long they worked. Those are three different claims and this module
 * is careful never to let one quietly become another.
 *
 * WHY DERIVATION IS A BUTTON AND NOT A TRIGGER
 *
 * Payroll pays staff a monthly salary — attendance does not enter that figure.
 * It pays contract workers days × daily wage, and contract workers are site
 * crew with no ERP account at all. So deriving attendance from logins:
 *
 *   changes nothing for the people who log in       (they are salaried)
 *   would pay nothing to the people who do not      (they never log in)
 *
 * Which is exactly why it must be an explicit act by somebody who can see what
 * it proposes, never a trigger on the login path. What it IS good for is the
 * presence record — who was working when — which HR needs and had no way to
 * see.
 */

const DATE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name ?? '',
  loginAt: r.login_at,
  logoutAt: r.logout_at ?? null,
  expiresAt: r.expires_at,
  endedBy: r.ended_by,
  ip: r.ip ?? '',
  userAgent: r.user_agent ?? '',
  /** Minutes the session was usable, capped at its expiry when never closed. */
  minutes: Number(r.minutes ?? 0),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/sessions — sign-in history.
   *
   * Gated on view_hr rather than a security key, because the question this
   * answers day to day is an HR one. A user always sees their own regardless,
   * since "when was I signed in" is not somebody else's business to withhold.
   */
  app.get<{ Querystring: { from?: string; to?: string; userId?: string; mine?: string } }>(
    '/api/sessions',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            from: { type: 'string', pattern: DATE },
            to: { type: 'string', pattern: DATE },
            userId: { type: 'string' },
            mine: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const mine = req.query.mine === 'true';
        if (!mine && !await gate(db, 'view_hr')) {
          return reply.code(403).send({ error: 'Missing permission: view_hr' });
        }

        const who = mine ? req.ctx.userId : (req.query.userId || null);
        const { rows } = await db.query(
          `SELECT s.*, u.name AS user_name,
                  EXTRACT(EPOCH FROM (
                    -- An unclosed session is capped at its expiry, never at
                    -- now(): a browser closed on Friday must not read as a
                    -- weekend of work.
                    LEAST(COALESCE(s.logout_at, s.expires_at), s.expires_at) - s.login_at
                  )) / 60 AS minutes
             FROM user_sessions s
             LEFT JOIN users u ON u.id = s.user_id
            WHERE ($1::uuid IS NULL OR s.user_id = $1)
              AND ($2::date IS NULL OR s.login_at >= $2::date)
              AND ($3::date IS NULL OR s.login_at < ($3::date + 1))
            ORDER BY s.login_at DESC
            LIMIT 500`,
          [who, req.query.from ?? null, req.query.to ?? null]);
        return { sessions: rows.map(toApi) };
      }),
  );

  /**
   * GET /api/sessions/attendance-preview — what derivation WOULD write.
   *
   * Read-only and side-effect free. Every row says whether it would be created
   * or skipped and why, so nobody has to run it to find out.
   */
  app.get<{ Querystring: { from: string; to: string } }>(
    '/api/sessions/attendance-preview',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object', required: ['from', 'to'], additionalProperties: false,
          properties: { from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_hr')) {
          return reply.code(403).send({ error: 'Missing permission: view_hr' });
        }
        return { days: await derive(db, req.query.from, req.query.to) };
      }),
  );

  /**
   * POST /api/sessions/derive-attendance — write the proposed rows.
   *
   * manage_attendance, the same key a geo or manual check-in needs: this is
   * recording attendance, and the fact that a computer worked out the times
   * does not make it a lesser act.
   */
  app.post<{ Body: { from: string; to: string } }>(
    '/api/sessions/derive-attendance',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['from', 'to'], additionalProperties: false,
          properties: { from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_attendance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_attendance' });
        }

        const days = await derive(db, req.body.from, req.body.to);
        const writable = days.filter(d => d.willCreate);

        for (const d of writable) {
          // ON CONFLICT DO NOTHING, not DO UPDATE. The unique key is
          // (tenant_id, employee_id, date), so an existing row means a human
          // already recorded that day — by geo check-in or by hand — and a
          // derived guess must not overwrite what somebody asserted.
          await db.query(
            `INSERT INTO attendance (tenant_id, employee_id, date, check_in, check_out, method)
             VALUES (app_current_tenant(), $1, $2::date, $3, $4, 'session')
             ON CONFLICT (tenant_id, employee_id, date) DO NOTHING`,
            [d.employeeId, d.date, d.firstLogin, d.lastLogout]);
        }

        return {
          created: writable.length,
          skipped: days.length - writable.length,
          days,
        };
      }),
  );
}

interface DerivedDay {
  employeeId: string;
  employeeName: string;
  userId: string;
  date: string;
  firstLogin: string;
  lastLogout: string;
  sessions: number;
  minutes: number;
  willCreate: boolean;
  /** Why not, when willCreate is false. */
  reason: string;
}

/**
 * One row per employee per day they were signed in.
 *
 * Only employees with a `user_id`. An employee without one is a person who
 * never signs in — site crew, almost always — and inventing a zero-hour day
 * for them would be worse than leaving the day blank, because a blank day is
 * visibly missing and a zero is quietly wrong.
 */
async function derive(
  db: import('pg').PoolClient, from: string, to: string,
): Promise<DerivedDay[]> {
  const { rows } = await db.query(
    `WITH day_sessions AS (
       SELECT e.id                AS employee_id,
              e.name              AS employee_name,
              s.user_id,
              (s.login_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
              min(s.login_at)     AS first_login,
              max(LEAST(COALESCE(s.logout_at, s.expires_at), s.expires_at)) AS last_out,
              count(*)::int       AS sessions,
              -- Summed per session, not first-to-last: two hours in the
              -- morning and two in the evening is four hours of presence, not
              -- the nine the clock between them would suggest.
              sum(EXTRACT(EPOCH FROM (
                LEAST(COALESCE(s.logout_at, s.expires_at), s.expires_at) - s.login_at
              )) / 60)::numeric   AS minutes
         FROM user_sessions s
         JOIN employees e
           ON e.user_id = s.user_id AND e.tenant_id = s.tenant_id
        WHERE s.login_at >= $1::date
          AND s.login_at < ($2::date + 1)
          AND e.active
        GROUP BY e.id, e.name, s.user_id, day
     )
     SELECT d.*,
            a.id AS existing_id, a.method AS existing_method
       FROM day_sessions d
       LEFT JOIN attendance a
         ON a.employee_id = d.employee_id AND a.date = d.day
      ORDER BY d.day DESC, d.employee_name`,
    [from, to]);

  const hhmm = (t: unknown) =>
    t ? new Date(t as string).toISOString().slice(11, 16) : '';

  return rows.map((r): DerivedDay => ({
    employeeId: r.employee_id as string,
    employeeName: r.employee_name as string,
    userId: r.user_id as string,
    date: String(r.day).slice(0, 10),
    firstLogin: hhmm(r.first_login),
    lastLogout: hhmm(r.last_out),
    sessions: Number(r.sessions ?? 0),
    minutes: Math.round(Number(r.minutes ?? 0)),
    willCreate: !r.existing_id,
    reason: r.existing_id
      ? `Already recorded as ${r.existing_method} — a derived time never overwrites one a person put there.`
      : '',
  }));
}
