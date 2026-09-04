import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { renderLetter, pdfMoney, pdfDate } from '../pdf.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * Possession and snags (migration 053).
 *
 * The product could sell a flat, demand money for it and cancel it, and had
 * nothing for handing it over — which is where a residential project generates
 * its complaints, its retention releases and its RERA exposure.
 *
 * The gates are the point. A handover is signed at a site office by whoever is
 * standing there, under real pressure to give the keys out on the day, so
 * "there are three open leaks" and "eleven lakh is still owing" have to be
 * facts the system holds rather than things someone remembers to check.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApiSnag = (r: Record<string, unknown>) => ({
  id: r.id,
  possessionId: r.possession_id,
  raisedOn: r.raised_on,
  location: r.location ?? '',
  category: r.category,
  description: r.description,
  severity: r.severity,
  status: r.status,
  assignedTo: r.assigned_to ?? null,
  assignedName: r.assigned_name ?? undefined,
  targetDate: r.target_date ?? null,
  resolvedOn: r.resolved_on ?? null,
  resolution: r.resolution ?? '',
  photoFileId: r.photo_file_id ?? null,
});

const toApi = (r: Record<string, unknown>, snags: Record<string, unknown>[] = []) => ({
  id: r.id,
  bookingId: r.booking_id,
  status: r.status,
  ocReference: r.oc_reference,
  ocDatedOn: r.oc_dated_on ?? null,
  offeredOn: r.offered_on,
  inspectedOn: r.inspected_on ?? null,
  acceptedOn: r.accepted_on ?? null,
  duesOutstanding: Number(r.dues_outstanding),
  receivedBy: r.received_by ?? '',
  notes: r.notes ?? '',
  createdAt: r.created_at,
  customerName: r.customer_name ?? undefined,
  unitCode: r.unit_code ?? undefined,
  projectName: r.project_name ?? undefined,
  // Computed rather than stored: it changes every time a snag is resolved, and
  // a stale copy is exactly the number someone would hand over against.
  blockingSnags: Number(r.blocking_snags ?? 0),
  duesNow: r.dues_now === undefined ? undefined : Number(r.dues_now),
  snags: snags.map(toApiSnag),
});

const SELECT_WITH_CONTEXT = `
  SELECT p.*, l.name AS customer_name, u.unit_code, pr.name AS project_name,
         blocking_snag_count(p.id) AS blocking_snags,
         GREATEST(0, COALESCE(b.total_consideration, 0) - booking_total_received(b.id)) AS dues_now
    FROM possessions p
    JOIN bookings b        ON b.id = p.booking_id
    LEFT JOIN leads l      ON l.id = b.lead_id
    LEFT JOIN units u      ON u.id = b.unit_id
    LEFT JOIN projects pr  ON pr.id = u.project_id`;

const SNAGS_SQL = `
  SELECT s.*, us.name AS assigned_name
    FROM snags s
    LEFT JOIN users us ON us.id = s.assigned_to
   WHERE s.possession_id = $1
   ORDER BY CASE s.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,
            s.created_at`;

export async function possessionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/possessions — the handover pipeline. */
  app.get<{ Querystring: { status?: string } }>(
    '/api/possessions',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['offered', 'inspected', 'accepted', 'withdrawn'] } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        }
        const { rows } = await db.query(
          `${SELECT_WITH_CONTEXT}
            WHERE ($1::text IS NULL OR p.status = $1)
            ORDER BY p.offered_on DESC LIMIT 500`, [req.query.status ?? null]);
        return { possessions: rows.map(r => toApi(r)) };
      }),
  );

  /** GET /api/possessions/:id — with its snag list. */
  app.get<{ Params: { id: string } }>(
    '/api/possessions/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        }
        const { rows: [p] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE p.id = $1`, [req.params.id]);
        if (!p) return reply.code(404).send({ error: 'Possession not found' });
        const { rows: snags } = await db.query(SNAGS_SQL, [p.id]);
        return { possession: toApi(p, snags) };
      }),
  );

  /**
   * POST /api/possessions — offer possession.
   *
   * The occupancy certificate is required by the schema, not by this handler.
   * Offering possession of a building nobody may lawfully occupy is the
   * complaint that gets filed, and a NOT NULL is harder to talk past than a
   * validation someone can be persuaded to skip.
   */
  app.post<{ Body: { bookingId: string; ocReference: string; ocDatedOn?: string; notes?: string } }>(
    '/api/possessions',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['bookingId', 'ocReference'], additionalProperties: false,
          properties: {
            bookingId: { type: 'string', pattern: UUID },
            ocReference: { type: 'string', minLength: 1, maxLength: 120 },
            ocDatedOn: { type: 'string', maxLength: 40 },
            notes: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const { rows: [b] } = await db.query('SELECT id, status FROM bookings WHERE id = $1', [req.body.bookingId]);
        if (!b) return reply.code(404).send({ error: 'Booking not found' });
        if (b.status === 'cancelled') {
          return reply.code(409).send({ error: 'That booking is cancelled.' });
        }
        try {
          const { rows: [created] } = await db.query(
            `INSERT INTO possessions (tenant_id, booking_id, oc_reference, oc_dated_on, notes, created_by)
             VALUES (app_current_tenant(), $1, $2, $3, COALESCE($4,''), $5) RETURNING id`,
            [req.body.bookingId, req.body.ocReference, req.body.ocDatedOn ?? null,
             req.body.notes ?? null, req.ctx.userId]);
          const { rows: [full] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE p.id = $1`, [created.id]);
          reply.code(201);
          return { possession: toApi(full) };
        } catch (err) {
          if ((err as { code?: string })?.code === '23505') {
            return reply.code(409).send({ error: 'Possession is already offered for that booking.' });
          }
          throw err;
        }
      }),
  );

  /**
   * PATCH /api/possessions/:id — move the handover along.
   *
   * Accepting is the one that matters. Two conditions are checked here rather
   * than left to the site office:
   *
   *   no open major or critical snag — minor ones do not block, because a gate
   *   that fires on a chipped skirting board is a gate people learn to override
   *
   *   nothing outstanding on the booking — handing over the keys is the last
   *   leverage a builder has, and once they are gone the balance is a lawsuit
   *
   * Both can be overridden with `force`, because a builder sometimes decides to
   * hand over anyway — and when they do, the reason and the outstanding balance
   * are frozen onto the record instead of being lost.
   */
  app.patch<{ Params: { id: string }; Body: {
    status?: string; receivedBy?: string; notes?: string; force?: boolean;
  } }>(
    '/api/possessions/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['inspected', 'accepted', 'withdrawn'] },
            receivedBy: { type: 'string', maxLength: 200 },
            notes: { type: 'string', maxLength: 4000 },
            force: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const { rows: [p] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE p.id = $1`, [req.params.id]);
        if (!p) return reply.code(404).send({ error: 'Possession not found' });

        const next = req.body.status;
        if (next) {
          const ALLOWED: Record<string, string[]> = {
            offered:   ['inspected', 'accepted', 'withdrawn'],
            inspected: ['accepted', 'withdrawn'],
            accepted:  [],
            withdrawn: [],
          };
          if (!ALLOWED[p.status]?.includes(next)) {
            return reply.code(409).send({ error: `A ${p.status} possession cannot become ${next}.` });
          }
        }

        if (next === 'accepted' && !req.body.force) {
          const blocking = Number(p.blocking_snags ?? 0);
          if (blocking > 0) {
            return reply.code(409).send({
              error: `${blocking} major or critical snag(s) are still open. Resolve them, or accept with an override.`,
              blockingSnags: blocking,
            });
          }
          const dues = Number(p.dues_now ?? 0);
          if (dues > 0.009) {
            return reply.code(409).send({
              error: `${dues.toFixed(2)} is still outstanding on this booking. Collect it, or hand over with an override.`,
              duesOutstanding: dues,
            });
          }
        }
        if (next === 'accepted' && !req.body.receivedBy?.trim()) {
          // A handover is signed for. An acceptance with nobody's name on it is
          // not a record of anything.
          return reply.code(400).send({ error: 'Record who took possession.' });
        }

        const { rows: [updated] } = await db.query(
          `UPDATE possessions
              SET status = COALESCE($1, status),
                  inspected_on = CASE WHEN $1 = 'inspected' AND inspected_on IS NULL
                                      THEN CURRENT_DATE ELSE inspected_on END,
                  accepted_on  = CASE WHEN $1 = 'accepted' THEN CURRENT_DATE ELSE accepted_on END,
                  -- Frozen at the moment the keys change hands, so a handover
                  -- made against a balance is a fact rather than an argument.
                  dues_outstanding = CASE WHEN $1 = 'accepted' THEN $2 ELSE dues_outstanding END,
                  received_by = COALESCE($3, received_by),
                  notes = COALESCE($4, notes)
            WHERE id = $5 RETURNING id`,
          [next ?? null, Number(p.dues_now ?? 0), req.body.receivedBy ?? null,
           req.body.notes ?? null, req.params.id]);

        const { rows: [full] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE p.id = $1`, [updated.id]);
        const { rows: snags } = await db.query(SNAGS_SQL, [updated.id]);
        return { possession: toApi(full, snags) };
      }),
  );

  /** POST /api/possessions/:id/snags — raise one. */
  app.post<{ Params: { id: string }; Body: {
    description: string; location?: string; category?: string; severity?: string;
    assignedTo?: string; targetDate?: string; photoFileId?: string;
  } }>(
    '/api/possessions/:id/snags',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['description'], additionalProperties: false,
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 2000 },
            location: { type: 'string', maxLength: 160 },
            category: { type: 'string', enum: ['civil', 'plumbing', 'electrical', 'carpentry', 'painting', 'flooring', 'fittings', 'other'] },
            severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
            assignedTo: { type: 'string', pattern: UUID },
            targetDate: { type: 'string', maxLength: 40 },
            photoFileId: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const { rows: [p] } = await db.query('SELECT id, status FROM possessions WHERE id = $1', [req.params.id]);
        if (!p) return reply.code(404).send({ error: 'Possession not found' });

        const { rows: [created] } = await db.query(
          `INSERT INTO snags (tenant_id, possession_id, description, location, category,
                              severity, assigned_to, target_date, photo_file_id, created_by)
           VALUES (app_current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,'other'),
                   COALESCE($5,'minor'), $6, $7, $8, $9) RETURNING id`,
          [req.params.id, req.body.description, req.body.location ?? null, req.body.category ?? null,
           req.body.severity ?? null, req.body.assignedTo ?? null, req.body.targetDate ?? null,
           req.body.photoFileId ?? null, req.ctx.userId]);

        // Raising a snag is an inspection happening. Advancing the status here
        // saves a second call nobody would remember to make.
        if (p.status === 'offered') {
          await db.query(
            `UPDATE possessions SET status = 'inspected',
                    inspected_on = COALESCE(inspected_on, CURRENT_DATE) WHERE id = $1`,
            [req.params.id]);
        }

        const { rows: [full] } = await db.query(`${SNAGS_SQL.replace('s.possession_id = $1', 's.id = $1')}`, [created.id]);
        reply.code(201);
        return { snag: toApiSnag(full) };
      }),
  );

  /** PATCH /api/snags/:id — work it, or close it. */
  app.patch<{ Params: { id: string }; Body: {
    status?: string; resolution?: string; assignedTo?: string; targetDate?: string; severity?: string;
  } }>(
    '/api/snags/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'rejected'] },
            resolution: { type: 'string', maxLength: 2000 },
            assignedTo: { type: 'string', pattern: UUID },
            targetDate: { type: 'string', maxLength: 40 },
            severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        // The schema refuses a resolution with no account of it; catching it
        // here gives a usable message instead of a constraint violation.
        if (req.body.status === 'resolved' && !req.body.resolution?.trim()) {
          return reply.code(400).send({ error: 'Say how the snag was resolved.' });
        }
        const { rowCount } = await db.query(
          `UPDATE snags
              SET status = COALESCE($1, status),
                  resolution = COALESCE($2, resolution),
                  resolved_on = CASE WHEN $1 = 'resolved' THEN CURRENT_DATE
                                     WHEN $1 IN ('open','in_progress') THEN NULL
                                     ELSE resolved_on END,
                  assigned_to = COALESCE($3, assigned_to),
                  target_date = COALESCE($4, target_date),
                  severity = COALESCE($5, severity)
            WHERE id = $6`,
          [req.body.status ?? null, req.body.resolution ?? null, req.body.assignedTo ?? null,
           req.body.targetDate ?? null, req.body.severity ?? null, req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Snag not found' });

        const { rows: [full] } = await db.query(`${SNAGS_SQL.replace('s.possession_id = $1', 's.id = $1')}`, [req.params.id]);
        return { snag: toApiSnag(full) };
      }),
  );

  /**
   * GET /api/possessions/:id/pdf — the possession letter, or the handover
   * acknowledgement once the keys are gone.
   *
   * Which one it is depends on the status, because they are different
   * documents doing different jobs: one starts a clock, the other closes it.
   */
  app.get<{ Params: { id: string } }>(
    '/api/possessions/:id/pdf',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const data = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) return { forbidden: true } as const;
        const { rows: [p] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE p.id = $1`, [req.params.id]);
        if (!p) return null;
        const { rows: snags } = await db.query(SNAGS_SQL, [p.id]);
        const { rows: [t] } = await db.query(
          `SELECT name, company, address, email, phone, currency FROM tenants WHERE id = app_current_tenant()`);
        return { p, snags, tenant: t };
      });

      if (data && 'forbidden' in data) return reply.code(403).send({ error: 'Missing permission: view_bookings' });
      if (!data) return reply.code(404).send({ error: 'Possession not found' });

      const { p, snags, tenant } = data;
      const ccy = (tenant?.currency as string) || 'INR';
      const locale = ccy === 'INR' ? 'en-IN' : 'en-US';
      const money = (n: unknown) => pdfMoney(Number(n ?? 0), ccy, locale);
      const unit = [p.project_name, p.unit_code].filter(Boolean).join(' — ');
      const handedOver = p.status === 'accepted';

      const rows: { label: string; value: string; strong?: boolean }[] = [
        { label: 'Occupancy certificate', value: String(p.oc_reference) },
      ];
      if (p.oc_dated_on) rows.push({ label: 'Certificate dated', value: pdfDate(p.oc_dated_on as string, locale) });
      rows.push({ label: 'Possession offered on', value: pdfDate(p.offered_on as string, locale) });
      if (p.inspected_on) rows.push({ label: 'Inspected on', value: pdfDate(p.inspected_on as string, locale) });
      if (handedOver) {
        rows.push({ label: 'Possession taken on', value: pdfDate(p.accepted_on as string, locale), strong: true });
        rows.push({ label: 'Received by', value: String(p.received_by || '—') });
      }

      const open = snags.filter((s: Record<string, unknown>) => s.status === 'open' || s.status === 'in_progress');
      if (open.length) {
        rows.push({ label: 'SNAGS OUTSTANDING', value: '' });
        for (const s of open) {
          rows.push({
            label: `  ${s.location ? `${s.location} — ` : ''}${s.description}`,
            value: String(s.severity).toUpperCase(),
          });
        }
      }

      const outro: string[] = [];
      if (handedOver) {
        outro.push('Possession of the said premises has been handed over and taken as recorded above. The allottee confirms having inspected the premises and, save for the snags listed (if any), having found them in order.');
        if (Number(p.dues_outstanding) > 0.009) {
          // The whole reason the figure is frozen: a handover against a balance
          // must be visible on the document, not only in the database.
          outro.push(`An amount of ${money(p.dues_outstanding)} remained outstanding on the date of handover. Possession was given without prejudice to the developer's right to recover it, and the allottee remains liable for the same.`);
        }
      } else {
        outro.push('You are requested to inspect the premises and take possession within the period stipulated in the agreement. Please carry a copy of this letter and proof of identity.');
        if (Number(p.dues_now ?? 0) > 0.009) {
          outro.push(`An amount of ${money(p.dues_now)} is outstanding and is payable before possession is handed over.`);
        }
        if (open.length) {
          outro.push('The snags listed above have been recorded and will be attended to. Their rectification is not a condition of the offer of possession unless the agreement provides otherwise.');
        }
      }
      outro.push('Maintenance charges become payable from the date of the offer of possession in accordance with the agreement.');

      const pdf = await renderLetter({
        from: {
          name: (tenant?.company as string) || (tenant?.name as string) || 'Developer',
          address: (tenant?.address as string) || undefined,
          email: (tenant?.email as string) || undefined,
          phone: (tenant?.phone as string) || undefined,
        },
        title: handedOver ? 'Handover Acknowledgement' : 'Offer of Possession',
        reference: `${unit || 'Unit'}  ·  ${pdfDate((handedOver ? p.accepted_on : p.offered_on) as string, locale)}`,
        to: { name: (p.customer_name as string) || 'Allottee', lines: unit ? [unit] : [] },
        intro: [
          handedOver
            ? `This is to record the handover of ${unit || 'the premises'} to the allottee.`
            : `We are pleased to inform you that ${unit || 'your unit'} is complete and the occupancy certificate has been obtained. Possession is hereby offered.`,
        ],
        rows,
        outro,
        footer: 'Issued from the developer’s records and subject to the terms of the agreement between the parties.',
      });

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Length', String(pdf.length))
        .header('Content-Disposition', contentDisposition(
          `${handedOver ? 'Handover' : 'Possession-Offer'}-${String(p.unit_code || p.id).slice(0, 12)}.pdf`, true))
        .headers(NOSNIFF)
        .header('Cache-Control', 'private, no-store');
      return reply.send(pdf);
    },
  );
}
