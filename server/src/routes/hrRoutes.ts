import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  computeLine, totalsOf, workingDaysIn, DEFAULT_RATES, type StatutoryRates,
} from '../payroll.js';

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

/**
 * Who may see what a person is PAID, and why it is not view_hr.
 *
 * view_hr is held by three roles, and one of them is site_engineer — who has
 * it solely so they can mark a crew register with manage_attendance. Gating
 * salary on view_hr therefore handed every site engineer the monthly salary of
 * every colleague, every leave reason including medical ones, and every
 * payroll run with per-person gross. That was never the intent: ROLE_PERMS
 * describes site_engineer as marking attendance, not reading the payroll.
 *
 * Pay is visible to two roles and no others:
 *
 *   manage_hr        the desk that prepares payroll — it cannot do the job
 *                    without the figures.
 *   view_audit_log   the auditor, whose entire purpose is to read everything
 *                    and change nothing. Auditing a payroll run without the
 *                    amounts is not auditing it.
 *
 * The route gate stays at view_hr so the roster, attendance and leave dates
 * remain visible to whoever runs a site. What is redacted is the money and the
 * reason somebody was off sick.
 */
async function maySeePay(db: import('pg').PoolClient): Promise<boolean> {
  const { rows: [r] } = await db.query(
    `SELECT has_permission('manage_hr') OR has_permission('view_audit_log') AS allowed`);
  return !!r?.allowed;
}

/**
 * WHICH SITES THIS PERSON'S HR COVERS.
 *
 * A builder runs several projects at once and posts an HR manager to each.
 * Until migration 061 every HR key was company-wide, so four site managers
 * saw four crews, four sets of salaries and four payrolls between them.
 *
 * `all` is true when the reader is company-wide — the HR head
 * (manage_hr_all), the auditor (view_audit_log), or anyone with no postings
 * at all. That last case is what makes this safe to ship: every existing user
 * has no rows in user_project_assignments, so nothing narrows until somebody chooses to
 * narrow it.
 *
 * Head office (project_id IS NULL) belongs to the company-wide reader only. A
 * site HR manager's crew is the people on their site; the accountants are not
 * theirs to see.
 */
interface HrScope { all: boolean; projectIds: string[] }

async function hrScope(db: import('pg').PoolClient): Promise<HrScope> {
  const { rows: [r] } = await db.query(
    `SELECT app_hr_all() AS all, app_project_ids() AS ids`);
  return { all: !!r?.all, projectIds: (r?.ids as string[]) ?? [] };
}

/**
 * The WHERE fragment every scoped read shares, and the reason it is a
 * function rather than a string copied into five queries: a route that
 * forgets it does not fail, it leaks. There is exactly one way to spell this
 * and every list below uses it.
 *
 * `$1` is always the project-id array. `col` names the column holding the
 * project on whatever is being filtered — employees.project_id directly, or a
 * joined e.project_id for attendance and leave.
 */
const scopedWhere = (scope: HrScope, col: string): string =>
  scope.all ? 'TRUE' : `${col} = ANY($1::uuid[])`;

/**
 * The VALUES ARRAY for a scoped query — pass it as db.query's second argument,
 * never spread it.
 *
 * `[scope.projectIds]` is one parameter whose value is an array. Spreading it
 * (`db.query(sql, ...scopeValues(scope))`) hands pg the inner array as the
 * values list, so `$1` binds to the first uuid rather than to the array and
 * Postgres answers `malformed array literal`. That is the good outcome; the
 * bad one is a query that silently matches one project out of several.
 */
const scopeValues = (scope: HrScope): string[][] => (scope.all ? [] : [scope.projectIds]);

export async function hrRoutes(app: FastifyInstance): Promise<void> {
  // ── Employees ───────────────────────────────────────────────────────────
  const empToApi = (r: Record<string, unknown>, canSeePay = false) => ({
    id: r.id, name: r.name, phone: r.phone, email: r.email, designation: r.designation, department: r.department,
    type: r.type, projectId: r.project_id,
    // Null rather than absent: a client that shows a dash for "not disclosed"
    // is honest, where a missing key looks like an employee on no salary.
    monthlySalary: canSeePay ? num(r.monthly_salary) : null,
    dailyWage: canSeePay ? num(r.daily_wage) : null,
    payHidden: !canSeePay,
    joinDate: r.join_date, active: r.active, userId: r.user_id,
    // Statutory identity (migration 062). Behind the same gate as pay: a UAN
    // and a bank account are how somebody is paid, and belong to whoever may
    // see what they are paid. The Aadhaar field is only ever four digits.
    uan: canSeePay ? r.uan : '',
    esicNumber: canSeePay ? r.esic_number : '',
    pan: canSeePay ? r.pan : '',
    aadhaarLast4: canSeePay ? r.aadhaar_last4 : '',
    bankAccount: canSeePay ? r.bank_account : '',
    bankIfsc: canSeePay ? r.bank_ifsc : '',
    pfOpted: r.pf_opted,
    ptMonthly: canSeePay ? num(r.pt_monthly) : null,
  });

  app.get('/api/employees', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const canSeePay = await maySeePay(db);
      const scope = await hrScope(db);
      const { rows } = await db.query(
        `SELECT * FROM employees WHERE ${scopedWhere(scope, 'project_id')} ORDER BY name`,
        scopeValues(scope));
      return { employees: rows.map(r => empToApi(r, canSeePay)), scopedToProjects: !scope.all };
    }),
  );

  /** The statutory identity fields, shared by create and update. */
  const STATUTORY_PROPS = {
    uan: { type: 'string', maxLength: 12 },
    esicNumber: { type: 'string', maxLength: 17 },
    pan: { type: 'string', maxLength: 10 },
    aadhaarLast4: { type: 'string', maxLength: 4 },
    bankAccount: { type: 'string', maxLength: 34 },
    bankIfsc: { type: 'string', maxLength: 11 },
    pfOpted: { type: 'boolean' },
    ptMonthly: { type: 'number', minimum: 0 },
  } as const;

  interface StatutoryBody {
    uan?: string; esicNumber?: string; pan?: string; aadhaarLast4?: string;
    bankAccount?: string; bankIfsc?: string; pfOpted?: boolean; ptMonthly?: number;
  }

  // The DB check constraints are written against upper case, and a person
  // typing a PAN or an IFSC will not hold shift. Normalising here turns a 500
  // from a constraint into a saved record.
  const upper = (s?: string) => (s ?? '').trim().toUpperCase();

  app.post<{ Body: { name: string; phone?: string; email?: string; designation?: string; department?: string; type?: string; projectId?: string; monthlySalary?: number; dailyWage?: number; joinDate?: string } & StatutoryBody }>(
    '/api/employees',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, phone: { type: 'string', maxLength: 32 }, email: { type: 'string', maxLength: 160 },
        designation: { type: 'string', maxLength: 80 }, department: { type: 'string', maxLength: 80 }, type: { type: 'string', enum: ['staff', 'contract_worker'] },
        projectId: { type: 'string', pattern: UUID }, monthlySalary: { type: 'number', minimum: 0 }, dailyWage: { type: 'number', minimum: 0 }, joinDate: { type: 'string' },
        ...STATUTORY_PROPS,
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const b = req.body;

        // A site HR manager hires onto their own site. Without this a manager
        // posted to Skyline could add a person to Riverfront — and then lose
        // sight of the record they had just created, because every read is
        // scoped. Hiring into head office (no project) needs company-wide HR.
        const scope = await hrScope(db);
        if (!scope.all && (!b.projectId || !scope.projectIds.includes(b.projectId))) {
          return reply.code(403).send({
            error: 'You can only add people to the projects you are assigned to',
          });
        }

        const { rows } = await db.query(
          `INSERT INTO employees (tenant_id, name, phone, email, designation, department, type, project_id, monthly_salary, daily_wage, join_date,
                                  uan, esic_number, pan, aadhaar_last4, bank_account, bank_ifsc, pf_opted, pt_monthly)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, CURRENT_DATE),
                   $11,$12,$13,$14,$15,$16, COALESCE($17, true), COALESCE($18, 0)) RETURNING *`,
          [b.name, b.phone || '', b.email || null, b.designation || '', b.department || '', b.type || 'staff', b.projectId || null, b.monthlySalary ?? null, b.dailyWage ?? null, b.joinDate || null,
           (b.uan ?? '').trim(), (b.esicNumber ?? '').trim(), upper(b.pan), (b.aadhaarLast4 ?? '').trim(),
           (b.bankAccount ?? '').trim(), upper(b.bankIfsc), b.pfOpted ?? null, b.ptMonthly ?? null]);
        // `true`: this route is gated on manage_hr, which is one of the two keys
        // maySeePay grants on — and the caller just typed the salary in. Handing
        // back a redacted row would make a client that refreshes from the
        // response show a dash for the figure it had only just saved.
        reply.code(201); return { employee: empToApi(rows[0], true) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { active?: boolean; monthlySalary?: number; dailyWage?: number; designation?: string; department?: string; projectId?: string } & StatutoryBody }>(
    '/api/employees/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          active: { type: 'boolean' }, monthlySalary: { type: 'number', minimum: 0 }, dailyWage: { type: 'number', minimum: 0 }, designation: { type: 'string', maxLength: 80 }, department: { type: 'string', maxLength: 80 },
          projectId: { type: 'string', pattern: UUID },
          ...STATUTORY_PROPS,
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const b = req.body;
        const scope = await hrScope(db);

        // Transferring somebody OUT of your sites is a one-way door: after the
        // write you could not read the row back to undo it. Only company-wide
        // HR moves people between projects.
        if (!scope.all && b.projectId !== undefined && !scope.projectIds.includes(b.projectId)) {
          return reply.code(403).send({
            error: 'You can only move people between the projects you are assigned to',
          });
        }

        // The scope clause sits in the UPDATE itself rather than in a prior
        // SELECT: a check-then-write leaves a window, and here the window is
        // somebody else's salary.
        const { rows } = await db.query(
          `UPDATE employees SET
             active = COALESCE($1, active), monthly_salary = COALESCE($2, monthly_salary), daily_wage = COALESCE($3, daily_wage),
             designation = COALESCE($4, designation), department = COALESCE($5, department),
             project_id = COALESCE($7, project_id),
             uan = COALESCE($8, uan), esic_number = COALESCE($9, esic_number), pan = COALESCE($10, pan),
             aadhaar_last4 = COALESCE($11, aadhaar_last4), bank_account = COALESCE($12, bank_account),
             bank_ifsc = COALESCE($13, bank_ifsc), pf_opted = COALESCE($14, pf_opted),
             pt_monthly = COALESCE($15, pt_monthly)
           WHERE id = $6 AND ${scope.all ? 'TRUE' : 'project_id = ANY($16::uuid[])'} RETURNING *`,
          [b.active ?? null, b.monthlySalary ?? null, b.dailyWage ?? null, b.designation ?? null, b.department ?? null, req.params.id,
           b.projectId ?? null,
           b.uan === undefined ? null : b.uan.trim(),
           b.esicNumber === undefined ? null : b.esicNumber.trim(),
           b.pan === undefined ? null : upper(b.pan),
           b.aadhaarLast4 === undefined ? null : b.aadhaarLast4.trim(),
           b.bankAccount === undefined ? null : b.bankAccount.trim(),
           b.bankIfsc === undefined ? null : upper(b.bankIfsc),
           b.pfOpted ?? null, b.ptMonthly ?? null,
           ...(scope.all ? [] : [scope.projectIds])]);
        if (!rows[0]) return reply.code(404).send({ error: 'Employee not found' });
        // manage_hr again — same reason as the create above.
        return { employee: empToApi(rows[0], true) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/employees/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const scope = await hrScope(db);
        // Scoped in the DELETE, not before it. Deleting a person off another
        // site is the least recoverable thing in this file.
        const { rowCount } = await db.query(
          `DELETE FROM employees WHERE id = $1 AND ${scope.all ? 'TRUE' : 'project_id = ANY($2::uuid[])'}`,
          [req.params.id, ...(scope.all ? [] : [scope.projectIds])]);
        if (!rowCount) return reply.code(404).send({ error: 'Employee not found' });
        reply.code(204); return null;
      }),
  );

  // ── Attendance (geo/manual, upsert per employee/day) ────────────────────
  const attToApi = (r: Record<string, unknown>) => ({ id: r.id, employeeId: r.employee_id, date: r.date, checkIn: r.check_in, checkOut: r.check_out, projectId: r.project_id, lat: num(r.lat), lng: num(r.lng), method: r.method, overtimeHours: num(r.overtime_hours) ?? 0 });

  app.get<{ Querystring: { date?: string } }>('/api/attendance', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const scope = await hrScope(db);
      // Scoped on the EMPLOYEE's project, not the attendance row's. A worker
      // on Skyline who is lent to Riverfront for a day is still Skyline's
      // person, and their register is still Skyline's manager's to read.
      // Filtering on attendance.project_id would hand that day to the other
      // site and hide it from their own.
      const where = scope.all ? 'TRUE' : 'e.project_id = ANY($1::uuid[])';
      const args = scope.all ? [] : [scope.projectIds];
      const { rows } = req.query.date
        ? await db.query(
            `SELECT a.* FROM attendance a JOIN employees e ON e.id = a.employee_id
              WHERE ${where} AND a.date = $${args.length + 1} ORDER BY a.created_at`,
            [...args, req.query.date])
        : await db.query(
            `SELECT a.* FROM attendance a JOIN employees e ON e.id = a.employee_id
              WHERE ${where} ORDER BY a.date DESC LIMIT 1000`, args);
      return { attendance: rows.map(attToApi) };
    }),
  );

  app.post<{ Body: { employeeId: string; date?: string; checkIn?: string; checkOut?: string; projectId?: string; lat?: number; lng?: number; method?: string; overtimeHours?: number } }>(
    '/api/attendance',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['employeeId'], additionalProperties: false, properties: {
        employeeId: { type: 'string', pattern: UUID }, date: { type: 'string' },
        // Full ISO timestamps (24 chars) — the SPA stores check-in/out as ISO strings
        checkIn: { type: 'string', maxLength: 40 }, checkOut: { type: 'string', maxLength: 40 },
        projectId: { type: 'string', pattern: UUID }, lat: { type: 'number' }, lng: { type: 'number' }, method: { type: 'string', enum: ['geo', 'manual'] },
        overtimeHours: { type: 'number', minimum: 0, maximum: 16 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_attendance')) return reply.code(403).send({ error: 'Missing permission: manage_attendance' });
        // The employee lookup carries the scope, so marking somebody on
        // another site returns the same 404 as marking somebody who does not
        // exist. A different answer would confirm the person is real.
        const scope = await hrScope(db);
        const { rows: emp } = await db.query(
          `SELECT id FROM employees WHERE id = $1 AND ${scope.all ? 'TRUE' : 'project_id = ANY($2::uuid[])'}`,
          [req.body.employeeId, ...(scope.all ? [] : [scope.projectIds])]);
        if (!emp[0]) return reply.code(404).send({ error: 'Employee not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO attendance (tenant_id, employee_id, date, check_in, check_out, project_id, lat, lng, method, overtime_hours)
           VALUES (app_current_tenant(), $1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8, COALESCE($9, 0))
           ON CONFLICT (tenant_id, employee_id, date) DO UPDATE SET
             check_in = EXCLUDED.check_in, check_out = COALESCE(EXCLUDED.check_out, attendance.check_out),
             project_id = EXCLUDED.project_id, lat = EXCLUDED.lat, lng = EXCLUDED.lng, method = EXCLUDED.method,
             -- Overtime only moves when the caller says so. A plain re-mark of
             -- a check-out must not silently wipe hours somebody recorded.
             --
             -- $9 directly, NOT EXCLUDED.overtime_hours: the INSERT list above
             -- already coalesced it to 0, so EXCLUDED is never null here and
             -- coalescing it would overwrite every recorded hour with zero.
             overtime_hours = COALESCE($9, attendance.overtime_hours)
           RETURNING *`,
          [b.employeeId, b.date || null, b.checkIn || '', b.checkOut || null, b.projectId || null, b.lat ?? null, b.lng ?? null, b.method || 'manual',
           b.overtimeHours ?? null]);
        reply.code(201); return { attendance: attToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/attendance/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_attendance')) return reply.code(403).send({ error: 'Missing permission: manage_attendance' });
        const scope = await hrScope(db);
        const { rowCount } = await db.query(
          `DELETE FROM attendance a WHERE a.id = $1 AND ${scope.all ? 'TRUE' : `EXISTS (
             SELECT 1 FROM employees e WHERE e.id = a.employee_id AND e.project_id = ANY($2::uuid[]))`}`,
          [req.params.id, ...(scope.all ? [] : [scope.projectIds])]);
        if (!rowCount) return reply.code(404).send({ error: 'Attendance record not found' });
        reply.code(204); return null;
      }),
  );

  // ── Leave requests (maker-checker) ──────────────────────────────────────
  // The TYPE (sick, casual, earned) stays visible — a site manager planning a
  // week needs to know who is off. The free-text REASON does not: it is where
  // "chemotherapy" gets written, and that is health data about a colleague.
  const leaveToApi = (r: Record<string, unknown>, canSeeReason = false) => ({
    id: r.id, employeeId: r.employee_id, type: r.type, from: r.from_date, to: r.to_date,
    days: r.days,
    reason: canSeeReason ? r.reason : '',
    reasonHidden: !canSeeReason && !!r.reason,
    status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at,
  });

  app.get('/api/leave-requests', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const scope = await hrScope(db);
      const { rows } = await db.query(
        `SELECT l.* FROM leave_requests l JOIN employees e ON e.id = l.employee_id
          WHERE ${scopedWhere(scope, 'e.project_id')} ORDER BY l.created_at DESC`,
        scopeValues(scope));
      const canSeeReason = await maySeePay(db);
      // Explicit arrow, never bare .map(leaveToApi): map passes the index as the
      // second argument, which would hide row 0 and reveal every row after it.
      return { leaveRequests: rows.map(r => leaveToApi(r, canSeeReason)) };
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
        const scope = await hrScope(db);
        const { rows: emp } = await db.query(
          `SELECT id FROM employees WHERE id = $1 AND ${scope.all ? 'TRUE' : 'project_id = ANY($2::uuid[])'}`,
          [req.body.employeeId, ...(scope.all ? [] : [scope.projectIds])]);
        if (!emp[0]) return reply.code(404).send({ error: 'Employee not found' });
        const { rows } = await db.query(
          `INSERT INTO leave_requests (tenant_id, employee_id, type, from_date, to_date, days, reason)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.employeeId, req.body.type || 'casual', req.body.from, req.body.to, req.body.days ?? 1, req.body.reason || null]);
        reply.code(201); return { leaveRequest: leaveToApi(rows[0], true) };
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
        const scope = await hrScope(db);
        // Approving leave for another site's crew changes that site's headcount
        // for the week. Scoped in the UPDATE for the same reason as the others.
        const { rows } = await db.query(
          `UPDATE leave_requests l SET status = $1,
             decided_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
             decided_at = CASE WHEN $2 THEN now() ELSE NULL END
           WHERE l.id = $4 AND ${scope.all ? 'TRUE' : `EXISTS (
             SELECT 1 FROM employees e WHERE e.id = l.employee_id AND e.project_id = ANY($5::uuid[]))`}
           RETURNING *`,
          [req.body.status, decided, req.ctx.userId || null, req.params.id,
           ...(scope.all ? [] : [scope.projectIds])]);
        if (!rows[0]) return reply.code(404).send({ error: 'Leave request not found' });
        return { leaveRequest: leaveToApi(rows[0], true) };
      }),
  );

  // ── Payroll runs ────────────────────────────────────────────────────────
  // `items` is the whole payroll: every name with what they were paid. It is
  // the single most sensitive array in the product, and it was being handed to
  // anyone holding view_hr.
  const payrollToApi = (r: Record<string, unknown>, canSeePay = false) => ({
    id: r.id, month: r.month, status: r.status,
    projectId: r.project_id,
    items: canSeePay ? r.items : [],
    itemsHidden: !canSeePay,
    // The count survives redaction so a run still reads as a run rather than
    // an empty one — "48 people, figures not shown" is useful and discloses
    // nothing.
    itemCount: Array.isArray(r.items) ? (r.items as unknown[]).length : 0,
    // The stored totals, which are money and follow the same rule as items.
    grossTotal: canSeePay ? num(r.gross_total) : null,
    deductionTotal: canSeePay ? num(r.deduction_total) : null,
    netTotal: canSeePay ? num(r.net_total) : null,
    employerCost: canSeePay ? num(r.employer_cost) : null,
    processedBy: r.processed_by, processedAt: r.processed_at,
  });

  app.get<{ Querystring: { projectId?: string } }>('/api/payroll-runs', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const canSeePay = await maySeePay(db);
      const scope = await hrScope(db);
      // A site manager sees their own sites' runs. Not the company-wide run
      // (project_id IS NULL), which covers head office and every other site —
      // reading it would undo the whole scoping in one query.
      const { rows } = await db.query(
        `SELECT * FROM payroll_runs WHERE ${scopedWhere(scope, 'project_id')} ORDER BY month DESC, project_id NULLS FIRST`,
        scopeValues(scope));
      return { payrollRuns: rows.map(r => payrollToApi(r, canSeePay)), scopedToProjects: !scope.all };
    }),
  );

  app.post<{ Body: { month: string; items?: unknown[]; projectId?: string | null } }>(
    '/api/payroll-runs',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['month'], additionalProperties: false, properties: {
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, items: { type: 'array', maxItems: 5000 },
        projectId: { type: ['string', 'null'], pattern: UUID },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const scope = await hrScope(db);
        const projectId = req.body.projectId ?? null;

        // A site manager prepares their own site's run and only that. The
        // company-wide run (projectId null) belongs to company-wide HR.
        if (!scope.all && (projectId === null || !scope.projectIds.includes(projectId))) {
          return reply.code(403).send({
            error: 'You can only prepare payroll for the projects you are assigned to',
          });
        }

        const items = (req.body.items || []) as Array<Record<string, unknown>>;
        // The client may post lines it computed itself (the demo path still
        // does). Totals are recomputed here rather than trusted, so the stored
        // header always adds up to the stored lines.
        const totals = items.reduce<{ gross: number; deductions: number; net: number; employerCost: number }>((t, i) => ({
          gross: t.gross + (Number(i.gross) || 0),
          deductions: t.deductions + (Number(i.deductions) || 0),
          net: t.net + (Number(i.net) || 0),
          employerCost: t.employerCost + (Number(i.employerCost) || 0),
        }), { gross: 0, deductions: 0, net: 0, employerCost: 0 });

        const { rows } = await db.query(
          `INSERT INTO payroll_runs (tenant_id, month, project_id, items, gross_total, deduction_total, net_total, employer_cost)
           VALUES (app_current_tenant(), $1, $2, $3::jsonb, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, month, project_id) DO UPDATE SET
             items = EXCLUDED.items, gross_total = EXCLUDED.gross_total,
             deduction_total = EXCLUDED.deduction_total, net_total = EXCLUDED.net_total,
             employer_cost = EXCLUDED.employer_cost
           WHERE payroll_runs.status = 'draft'
           RETURNING *`,
          [req.body.month, projectId, JSON.stringify(items),
           totals.gross, totals.deductions, totals.net, totals.employerCost]);
        if (!rows[0]) return reply.code(409).send({ error: 'Payroll for this month is already processed' });
        reply.code(201); return { payrollRun: payrollToApi(rows[0], true) };
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
        const scope = await hrScope(db);
        const { rows } = await db.query(
          `UPDATE payroll_runs SET status = 'processed', processed_by = $1, processed_at = now()
            WHERE id = $2 AND status = 'draft' AND ${scope.all ? 'TRUE' : 'project_id = ANY($3::uuid[])'}
            RETURNING *`,
          [req.ctx.userId || null, req.params.id, ...(scope.all ? [] : [scope.projectIds])]);
        if (!rows[0]) return reply.code(404).send({ error: 'Draft payroll run not found' });

        // Processing is what moves an advance from outstanding to recovered.
        // Doing it here rather than when the draft is built means a draft can
        // be rebuilt as many times as HR likes without a worker's advance
        // being marked repaid by a run that was never paid.
        //
        // Oldest advance first, and never past what is still owed on it: the
        // `recovered <= amount` constraint would reject the statement outright
        // rather than let a worker appear to have repaid more than they took.
        const items = Array.isArray(rows[0].items) ? rows[0].items as Array<Record<string, unknown>> : [];
        for (const line of items) {
          let left = Number(line.advanceRecovery) || 0;
          if (left <= 0) continue;
          const { rows: open } = await db.query(
            `SELECT id, amount - recovered AS due FROM employee_advances
              WHERE employee_id = $1 AND recovered < amount ORDER BY issued_on, created_at`,
            [line.employeeId]);
          for (const adv of open) {
            if (left <= 0) break;
            const take = Math.min(left, Number(adv.due));
            await db.query(
              'UPDATE employee_advances SET recovered = recovered + $1 WHERE id = $2',
              [take, adv.id]);
            left -= take;
          }
        }

        return { payrollRun: payrollToApi(rows[0], true) };
      }),
  );

  /**
   * GET /api/hr/me — a person's own HR record.
   *
   * NO HR PERMISSION, deliberately. Every read above is gated on view_hr,
   * which three roles hold — so a sales executive, a telecaller, an accountant
   * and a BD manager could not see their own attendance, their own leave or
   * their own payslip. Their data was in the product and closed to them.
   *
   * Scoped by the SESSION, never by a parameter: the employee row is found
   * through app_current_user(), so there is no id to tamper with and no way
   * to ask for somebody else by changing a number in the URL.
   *
   * Pay appears here in full. It is their own salary — the redaction above
   * exists to stop people reading each other's, not their own.
   */
  app.get('/api/hr/me', { preHandler: requireAuth }, async (req) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [emp] } = await db.query(
        'SELECT * FROM employees WHERE user_id = app_current_user() LIMIT 1');
      if (!emp) {
        // A real state, not an error: plenty of users are not employees —
        // a platform admin, or a login created before the HR record.
        return {
          employee: null, attendance: [], leave: [], payslips: [],
          note: 'No employee record is linked to this account. HR can link one.',
        };
      }

      const { rows: att } = await db.query(
        `SELECT * FROM attendance WHERE employee_id = $1
          ORDER BY date DESC LIMIT 120`, [emp.id]);
      const { rows: lv } = await db.query(
        `SELECT * FROM leave_requests WHERE employee_id = $1
          ORDER BY from_date DESC LIMIT 60`, [emp.id]);

      // PROCESSED runs only. A draft is a working figure that HR may still
      // change, and showing somebody a number that later moves is worse than
      // showing them nothing yet.
      const { rows: runs } = await db.query(
        `SELECT month, items, processed_at FROM payroll_runs
          WHERE status = 'processed' ORDER BY month DESC LIMIT 24`);

      const payslips = runs
        .map(r => {
          const items = Array.isArray(r.items) ? r.items as Array<Record<string, unknown>> : [];
          // Their line and nobody else's — the array holds the whole company.
          const mine = items.find(i => i.employeeId === emp.id);
          return mine ? { month: r.month, processedAt: r.processed_at, ...mine } : null;
        })
        .filter(Boolean);

      // Their own outstanding advances. A worker who drew ₹5,000 and is
      // about to be paid ₹5,000 less should not learn that from the payslip.
      const { rows: adv } = await db.query(
        `SELECT id, amount, recovered, per_month, reason, issued_on
           FROM employee_advances WHERE employee_id = $1 AND recovered < amount
          ORDER BY issued_on`, [emp.id]);

      return {
        employee: empToApi(emp, true),
        attendance: att.map(attToApi),
        leave: lv.map(r => leaveToApi(r, true)),
        payslips,
        advances: adv.map(a => ({
          id: a.id, amount: num(a.amount), recovered: num(a.recovered),
          outstanding: (num(a.amount) ?? 0) - (num(a.recovered) ?? 0),
          perMonth: num(a.per_month), reason: a.reason, issuedOn: a.issued_on,
        })),
      };
    }),
  );

  // ── Which sites this person's HR covers ─────────────────────────────────
  //
  // The client cannot work this out for itself: whether somebody is
  // company-wide depends on a permission AND on whether any posting exists,
  // and getting that wrong in the UI means a screen that offers a project
  // filter the server will reject. So the server says.
  app.get('/api/hr/scope', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_hr')) return reply.code(403).send({ error: 'Missing permission: view_hr' });
      const scope = await hrScope(db);
      const { rows } = await db.query(
        `SELECT id, name, city, status FROM projects
          WHERE ${scope.all ? 'TRUE' : 'id = ANY($1::uuid[])'} ORDER BY name`,
        scopeValues(scope));
      return {
        companyWide: scope.all,
        projectIds: scope.projectIds,
        projects: rows.map(p => ({ id: p.id, name: p.name, city: p.city, status: p.status })),
      };
    }),
  );

  // ── Postings ────────────────────────────────────────────────────────────
  //
  // Who is posted where. Changing a posting changes what somebody can see, so
  // it needs manage_users — the key that already governs "what may this
  // person reach", rather than an HR key, which would let a site HR manager
  // widen their own scope by posting themselves to another site.

  app.get<{ Querystring: { userId?: string } }>('/api/hr/postings', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_users')) return reply.code(403).send({ error: 'Missing permission: manage_users' });
      const { rows } = await db.query(
        `SELECT up.user_id, up.project_id, up.role_note, up.assigned_at,
                u.name AS user_name, p.name AS project_name
           FROM user_project_assignments up
           JOIN users u    ON u.id = up.user_id
           JOIN projects p ON p.id = up.project_id
          WHERE ($1::uuid IS NULL OR up.user_id = $1)
          ORDER BY u.name, p.name`,
        [req.query.userId ?? null]);
      return { postings: rows.map(r => ({
        userId: r.user_id, userName: r.user_name,
        projectId: r.project_id, projectName: r.project_name,
        roleNote: r.role_note, assignedAt: r.assigned_at,
      })) };
    }),
  );

  app.post<{ Body: { userId: string; projectId: string; roleNote?: string } }>(
    '/api/hr/postings',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['userId', 'projectId'], additionalProperties: false, properties: {
        userId: { type: 'string', pattern: UUID }, projectId: { type: 'string', pattern: UUID },
        roleNote: { type: 'string', maxLength: 120 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_users')) return reply.code(403).send({ error: 'Missing permission: manage_users' });
        // The table's key IS (user_id, project_id) — 003 gave it no surrogate
        // id, which is right: a posting is that pair, and a second row for the
        // same pair would be a duplicate rather than a stronger claim.
        const { rows } = await db.query(
          `INSERT INTO user_project_assignments (tenant_id, user_id, project_id, role_note, assigned_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4)
           ON CONFLICT (user_id, project_id) DO UPDATE SET role_note = EXCLUDED.role_note
           RETURNING *`,
          [req.body.userId, req.body.projectId, req.body.roleNote ?? '', req.ctx.userId || null]);
        reply.code(201);
        return { posting: { userId: rows[0].user_id, projectId: rows[0].project_id, roleNote: rows[0].role_note } };
      }),
  );

  app.delete<{ Params: { userId: string; projectId: string } }>(
    '/api/hr/postings/:userId/:projectId',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['userId', 'projectId'], properties: {
      userId: { type: 'string', pattern: UUID }, projectId: { type: 'string', pattern: UUID },
    } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_users')) return reply.code(403).send({ error: 'Missing permission: manage_users' });
        const { rowCount } = await db.query(
          'DELETE FROM user_project_assignments WHERE user_id = $1 AND project_id = $2',
          [req.params.userId, req.params.projectId]);
        if (!rowCount) return reply.code(404).send({ error: 'Posting not found' });
        reply.code(204); return null;
      }),
  );

  // ── Advances ────────────────────────────────────────────────────────────
  //
  // Money handed to a worker before payday. It is pay, so it sits behind
  // manage_hr and is scoped to the site like everything else.

  const advToApi = (r: Record<string, unknown>) => ({
    id: r.id, employeeId: r.employee_id, amount: num(r.amount), recovered: num(r.recovered),
    outstanding: (num(r.amount) ?? 0) - (num(r.recovered) ?? 0),
    perMonth: num(r.per_month), reason: r.reason, issuedOn: r.issued_on, issuedBy: r.issued_by,
  });

  app.get<{ Querystring: { employeeId?: string; open?: string } }>('/api/hr/advances', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
      const scope = await hrScope(db);
      const args: unknown[] = scope.all ? [] : [scope.projectIds];
      const clauses = [scopedWhere(scope, 'e.project_id')];
      if (req.query.employeeId) { args.push(req.query.employeeId); clauses.push(`a.employee_id = $${args.length}`); }
      if (req.query.open === 'true') clauses.push('a.recovered < a.amount');
      const { rows } = await db.query(
        `SELECT a.* FROM employee_advances a JOIN employees e ON e.id = a.employee_id
          WHERE ${clauses.join(' AND ')} ORDER BY a.issued_on DESC, a.created_at DESC`, args);
      return { advances: rows.map(advToApi) };
    }),
  );

  app.post<{ Body: { employeeId: string; amount: number; perMonth?: number; reason?: string; issuedOn?: string } }>(
    '/api/hr/advances',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['employeeId', 'amount'], additionalProperties: false, properties: {
        employeeId: { type: 'string', pattern: UUID }, amount: { type: 'number', exclusiveMinimum: 0 },
        perMonth: { type: 'number', minimum: 0 }, reason: { type: 'string', maxLength: 200 }, issuedOn: { type: 'string' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const scope = await hrScope(db);
        const { rows: emp } = await db.query(
          `SELECT id FROM employees WHERE id = $1 AND ${scope.all ? 'TRUE' : 'project_id = ANY($2::uuid[])'}`,
          [req.body.employeeId, ...(scope.all ? [] : [scope.projectIds])]);
        if (!emp[0]) return reply.code(404).send({ error: 'Employee not found' });
        const { rows } = await db.query(
          `INSERT INTO employee_advances (tenant_id, employee_id, amount, per_month, reason, issued_on, issued_by)
           VALUES (app_current_tenant(), $1, $2, COALESCE($3, 0), $4, COALESCE($5::date, CURRENT_DATE), $6) RETURNING *`,
          [req.body.employeeId, req.body.amount, req.body.perMonth ?? null, req.body.reason ?? '',
           req.body.issuedOn || null, req.ctx.userId || null]);
        reply.code(201); return { advance: advToApi(rows[0]) };
      }),
  );

  /**
   * POST /api/hr/payroll/prepare — build a month's run from the record.
   *
   * WHY THIS IS ON THE SERVER
   *
   * The SPA already had `buildPayrollItemsFrom`, which computed gross from a
   * daily wage and days present. It could not do more, because everything the
   * rest of the figure needs — outstanding advances, the statutory rates in
   * force for the month, the employee's PF election — lives here and some of
   * it is redacted before it reaches a browser. A client cannot compute a
   * deduction from data it is not allowed to read.
   *
   * It PREVIEWS by default. Preparing payroll is the moment somebody checks
   * the numbers, and a route that wrote on sight would make "let me look at
   * March" an act with consequences. Pass save:true to store the draft.
   *
   * Advances are proposed for recovery here and marked recovered only when
   * the run is PROCESSED — so a draft can be rebuilt as often as HR likes
   * without a worker's advance being written off by a run nobody paid.
   */
  app.post<{ Body: { month: string; projectId?: string | null; workingDays?: number; save?: boolean } }>(
    '/api/hr/payroll/prepare',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['month'], additionalProperties: false, properties: {
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        projectId: { type: ['string', 'null'], pattern: UUID },
        workingDays: { type: 'integer', minimum: 1, maximum: 31 },
        save: { type: 'boolean' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_hr')) return reply.code(403).send({ error: 'Missing permission: manage_hr' });
        const scope = await hrScope(db);
        const { month } = req.body;
        const projectId = req.body.projectId ?? null;

        if (!scope.all && (projectId === null || !scope.projectIds.includes(projectId))) {
          return reply.code(403).send({
            error: 'You can only prepare payroll for the projects you are assigned to',
          });
        }

        // The rates in force FOR THIS MONTH, not today's. Re-opening last
        // March must compute it with last March's ceilings; resolving to the
        // current row would silently restate a run every time a rate moves.
        // A workspace's own row beats the platform default at the same date.
        const { rows: [rate] } = await db.query(
          `SELECT * FROM statutory_rates
            WHERE effective_from <= ($1 || '-01')::date
            ORDER BY effective_from DESC, tenant_id NULLS LAST LIMIT 1`, [month]);
        const rates: StatutoryRates = rate ? {
          pfEmployeePct: Number(rate.pf_employee_pct), pfEmployerPct: Number(rate.pf_employer_pct),
          pfWageCeiling: Number(rate.pf_wage_ceiling),
          esiEmployeePct: Number(rate.esi_employee_pct), esiEmployerPct: Number(rate.esi_employer_pct),
          esiWageCeiling: Number(rate.esi_wage_ceiling),
          overtimeMultiple: Number(rate.overtime_multiple),
        } : DEFAULT_RATES;

        // Whose payroll this is. A company-wide run pays everyone including
        // head office; a project run pays that project's people only.
        const empWhere = projectId === null ? 'active' : 'active AND project_id = $1';
        const { rows: emps } = await db.query(
          `SELECT * FROM employees WHERE ${empWhere} ORDER BY name`,
          projectId === null ? [] : [projectId]);

        if (emps.length === 0) {
          return { month, projectId, workingDays: req.body.workingDays ?? workingDaysIn(month), items: [], totals: totalsOf([]), saved: false };
        }

        const ids = emps.map(e => e.id);

        // Days present and overtime for the month, per person.
        const { rows: att } = await db.query(
          `SELECT employee_id, count(*)::int AS days, COALESCE(sum(overtime_hours), 0) AS ot
             FROM attendance
            WHERE employee_id = ANY($1::uuid[]) AND to_char(date, 'YYYY-MM') = $2
            GROUP BY employee_id`, [ids, month]);
        const attBy = new Map(att.map(a => [a.employee_id, { days: a.days as number, ot: Number(a.ot) }]));

        // Approved UNPAID leave that falls inside the month. Only 'unpaid'
        // reduces a salary — approving somebody's casual leave and then
        // docking them for it would be the opposite of granting it.
        const { rows: unpaid } = await db.query(
          `SELECT employee_id, COALESCE(sum(days), 0)::int AS days
             FROM leave_requests
            WHERE employee_id = ANY($1::uuid[]) AND status = 'approved' AND type = 'unpaid'
              AND to_char(from_date, 'YYYY-MM') = $2
            GROUP BY employee_id`, [ids, month]);
        const unpaidBy = new Map(unpaid.map(u => [u.employee_id, u.days as number]));

        // What is still owed. `per_month` caps the instalment; 0 means take
        // it all this month, which is what a small advance normally is.
        const { rows: advs } = await db.query(
          `SELECT employee_id,
                  COALESCE(sum(CASE WHEN per_month > 0
                                    THEN LEAST(per_month, amount - recovered)
                                    ELSE amount - recovered END), 0) AS due
             FROM employee_advances
            WHERE employee_id = ANY($1::uuid[]) AND recovered < amount
            GROUP BY employee_id`, [ids]);
        const advBy = new Map(advs.map(a => [a.employee_id, Number(a.due)]));

        const workingDays = req.body.workingDays ?? workingDaysIn(month);

        const items = emps.map(e => computeLine(
          {
            id: e.id, name: e.name, designation: e.designation, type: e.type,
            monthlySalary: e.monthly_salary === null ? null : Number(e.monthly_salary),
            dailyWage: e.daily_wage === null ? null : Number(e.daily_wage),
            pfOpted: e.pf_opted, ptMonthly: Number(e.pt_monthly ?? 0), projectId: e.project_id,
          },
          {
            daysPresent: attBy.get(e.id)?.days ?? 0,
            workingDays,
            overtimeHours: attBy.get(e.id)?.ot ?? 0,
            unpaidLeaveDays: unpaidBy.get(e.id) ?? 0,
            advanceRecovery: advBy.get(e.id) ?? 0,
          },
          rates,
        ));

        const totals = totalsOf(items);

        if (!req.body.save) {
          return { month, projectId, workingDays, rates, items, totals, saved: false };
        }

        const { rows } = await db.query(
          `INSERT INTO payroll_runs (tenant_id, month, project_id, items, gross_total, deduction_total, net_total, employer_cost)
           VALUES (app_current_tenant(), $1, $2, $3::jsonb, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, month, project_id) DO UPDATE SET
             items = EXCLUDED.items, gross_total = EXCLUDED.gross_total,
             deduction_total = EXCLUDED.deduction_total, net_total = EXCLUDED.net_total,
             employer_cost = EXCLUDED.employer_cost
           WHERE payroll_runs.status = 'draft'
           RETURNING *`,
          [month, projectId, JSON.stringify(items),
           totals.gross, totals.deductions, totals.net, totals.employerCost]);
        if (!rows[0]) return reply.code(409).send({ error: 'Payroll for this month is already processed' });

        return { month, projectId, workingDays, rates, items, totals, saved: true, payrollRun: payrollToApi(rows[0], true) };
      }),
  );

}
