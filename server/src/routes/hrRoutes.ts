import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * HR & workforce: employees, daily attendance, leave requests (maker-checker),
 * and monthly payroll runs. Tables added in migration 015. RLS + RBAC
 * (view_hr / manage_hr / manage_attendance).
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function hrRoutes(app: FastifyInstance): Promise<void> {
  // ── Employees ───────────────────────────────────────────────────────────
  const empToApi = (r: Record<string, unknown>) => ({
    id: r.id, name: r.name, phone: r.phone, email: r.email, designation: r.designation, department: r.department,
    type: r.type, projectId: r.project_id, monthlySalary: num(r.monthly_salary), dailyWage: num(r.daily_wage),
    joinDate: r.join_date, active: r.active, userId: r.user_id,
  });

  app.get('/api/employees', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const { rows } = await db.query('SELECT * FROM employees ORDER BY name');
      return { employees: rows.map(empToApi) };
    }),
  );

  app.post<{ Body: { name: string; phone?: string; email?: string; designation?: string; department?: string; type?: string; projectId?: string; monthlySalary?: number; dailyWage?: number; joinDate?: string } }>(
    '/api/employees',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, phone: { type: 'string', maxLength: 32 }, email: { type: 'string', maxLength: 160 },
        designation: { type: 'string', maxLength: 80 }, department: { type: 'string', maxLength: 80 }, type: { type: 'string', enum: ['staff', 'contract_worker'] },
        projectId: { type: 'string', pattern: UUID }, monthlySalary: { type: 'number', minimum: 0 }, dailyWage: { type: 'number', minimum: 0 }, joinDate: { type: 'string' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO employees (tenant_id, name, phone, email, designation, department, type, project_id, monthly_salary, daily_wage, join_date)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, CURRENT_DATE)) RETURNING *`,
          [b.name, b.phone || '', b.email || null, b.designation || '', b.department || '', b.type || 'staff', b.projectId || null, b.monthlySalary ?? null, b.dailyWage ?? null, b.joinDate || null]);
        reply.code(201); return { employee: empToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { active?: boolean; monthlySalary?: number; dailyWage?: number; designation?: string; department?: string } }>(
    '/api/employees/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          active: { type: 'boolean' }, monthlySalary: { type: 'number', minimum: 0 }, dailyWage: { type: 'number', minimum: 0 }, designation: { type: 'string', maxLength: 80 }, department: { type: 'string', maxLength: 80 },
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const b = req.body;
        const { rows } = await db.query(
          `UPDATE employees SET
             active = COALESCE($1, active), monthly_salary = COALESCE($2, monthly_salary), daily_wage = COALESCE($3, daily_wage),
             designation = COALESCE($4, designation), department = COALESCE($5, department)
           WHERE id = $6 RETURNING *`,
          [b.active ?? null, b.monthlySalary ?? null, b.dailyWage ?? null, b.designation ?? null, b.department ?? null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Employee not found' });
        return { employee: empToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/employees/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const { rowCount } = await db.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Employee not found' });
        reply.code(204); return null;
      }),
  );

  // ── Attendance (geo/manual, upsert per employee/day) ────────────────────
  const attToApi = (r: Record<string, unknown>) => ({ id: r.id, employeeId: r.employee_id, date: r.date, checkIn: r.check_in, checkOut: r.check_out, projectId: r.project_id, lat: num(r.lat), lng: num(r.lng), method: r.method });

  app.get<{ Querystring: { date?: string } }>('/api/attendance', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const { rows } = req.query.date
        ? await db.query('SELECT * FROM attendance WHERE date = $1 ORDER BY created_at', [req.query.date])
        : await db.query('SELECT * FROM attendance ORDER BY date DESC LIMIT 1000');
      return { attendance: rows.map(attToApi) };
    }),
  );

  app.post<{ Body: { employeeId: string; date?: string; checkIn?: string; checkOut?: string; projectId?: string; lat?: number; lng?: number; method?: string } }>(
    '/api/attendance',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['employeeId'], additionalProperties: false, properties: {
        employeeId: { type: 'string', pattern: UUID }, date: { type: 'string' },
        // Full ISO timestamps (24 chars) — the SPA stores check-in/out as ISO strings
        checkIn: { type: 'string', maxLength: 40 }, checkOut: { type: 'string', maxLength: 40 },
        projectId: { type: 'string', pattern: UUID }, lat: { type: 'number' }, lng: { type: 'number' }, method: { type: 'string', enum: ['geo', 'manual'] },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_attendance')) return reply.code(403).send({ error: 'Missing permission: manage_attendance' });
        const { rows: emp } = await db.query('SELECT id FROM employees WHERE id = $1', [req.body.employeeId]);
        if (!emp[0]) return reply.code(404).send({ error: 'Employee not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO attendance (tenant_id, employee_id, date, check_in, check_out, project_id, lat, lng, method)
           VALUES (app_current_tenant(), $1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, employee_id, date) DO UPDATE SET
             check_in = EXCLUDED.check_in, check_out = COALESCE(EXCLUDED.check_out, attendance.check_out),
             project_id = EXCLUDED.project_id, lat = EXCLUDED.lat, lng = EXCLUDED.lng, method = EXCLUDED.method
           RETURNING *`,
          [b.employeeId, b.date || null, b.checkIn || '', b.checkOut || null, b.projectId || null, b.lat ?? null, b.lng ?? null, b.method || 'manual']);
        reply.code(201); return { attendance: attToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/attendance/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_attendance')) return reply.code(403).send({ error: 'Missing permission: manage_attendance' });
        const { rowCount } = await db.query('DELETE FROM attendance WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Attendance record not found' });
        reply.code(204); return null;
      }),
  );

  // ── Leave requests (maker-checker) ──────────────────────────────────────
  const leaveToApi = (r: Record<string, unknown>) => ({ id: r.id, employeeId: r.employee_id, type: r.type, from: r.from_date, to: r.to_date, days: r.days, reason: r.reason, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at });

  app.get('/api/leave-requests', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const { rows } = await db.query('SELECT * FROM leave_requests ORDER BY created_at DESC');
      return { leaveRequests: rows.map(leaveToApi) };
    }),
  );

  app.post<{ Body: { employeeId: string; type?: string; from: string; to: string; days?: number; reason?: string } }>(
    '/api/leave-requests',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['employeeId', 'from', 'to'], additionalProperties: false, properties: {
        employeeId: { type: 'string', pattern: UUID }, type: { type: 'string', enum: ['casual', 'sick', 'earned', 'unpaid'] },
        from: { type: 'string' }, to: { type: 'string' }, days: { type: 'integer', minimum: 1 }, reason: { type: 'string', maxLength: 500 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const { rows: emp } = await db.query('SELECT id FROM employees WHERE id = $1', [req.body.employeeId]);
        if (!emp[0]) return reply.code(404).send({ error: 'Employee not found' });
        const { rows } = await db.query(
          `INSERT INTO leave_requests (tenant_id, employee_id, type, from_date, to_date, days, reason)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.employeeId, req.body.type || 'casual', req.body.from, req.body.to, req.body.days ?? 1, req.body.reason || null]);
        reply.code(201); return { leaveRequest: leaveToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/leave-requests/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const decided = req.body.status !== 'pending';
        const { rows } = await db.query(
          `UPDATE leave_requests SET status = $1,
             decided_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
             decided_at = CASE WHEN $2 THEN now() ELSE NULL END
           WHERE id = $4 RETURNING *`,
          [req.body.status, decided, req.ctx.userId || null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Leave request not found' });
        return { leaveRequest: leaveToApi(rows[0]) };
      }),
  );

  // ── Payroll runs ────────────────────────────────────────────────────────
  const payrollToApi = (r: Record<string, unknown>) => ({ id: r.id, month: r.month, status: r.status, items: r.items, processedBy: r.processed_by, processedAt: r.processed_at });

  app.get('/api/payroll-runs', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const { rows } = await db.query('SELECT * FROM payroll_runs ORDER BY month DESC');
      return { payrollRuns: rows.map(payrollToApi) };
    }),
  );

  app.post<{ Body: { month: string; items?: unknown[] } }>(
    '/api/payroll-runs',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['month'], additionalProperties: false, properties: {
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, items: { type: 'array', maxItems: 5000 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const { rows } = await db.query(
          `INSERT INTO payroll_runs (tenant_id, month, items) VALUES (app_current_tenant(), $1, $2::jsonb)
           ON CONFLICT (tenant_id, month) DO UPDATE SET items = EXCLUDED.items WHERE payroll_runs.status = 'draft'
           RETURNING *`,
          [req.body.month, JSON.stringify(req.body.items || [])]);
        if (!rows[0]) return reply.code(409).send({ error: 'Payroll for this month is already processed' });
        reply.code(201); return { payrollRun: payrollToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/payroll-runs/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['processed'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const { rows } = await db.query(
          `UPDATE payroll_runs SET status = 'processed', processed_by = $1, processed_at = now() WHERE id = $2 AND status = 'draft' RETURNING *`,
          [req.ctx.userId || null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Draft payroll run not found' });
        return { payrollRun: payrollToApi(rows[0]) };
      }),
  );
}
