import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Land acquisition (parcels + feasibility runs + land documents) and Business
 * development (opportunities + market reports). Tables added in migration 019.
 * RLS + RBAC (view_land / manage_land, view_bd / manage_bd).
 */

const UUID = '^[0-9a-fA-F-]{36}$';
// Pinned to the client's unions (LandLeadStatus / BdStage). These were free-form
// strings defaulting to 'sourced' / 'prospecting', which the SPA cannot render —
// its status lookup is a non-null assertion, so such a row white-screened the page.
const LAND_STATUSES = ['lead_reference', 'property_details', 'feasibility_working', 'qualified', 'converted_to_project', 'rejected'];
const BD_STAGES = ['identified', 'initial_discussion', 'terms_negotiation', 'handed_to_land', 'closed_lost'];
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

/**
 * Which permission a status change needs.
 *
 * Two transitions in the land pipeline and one in BD are approvals, not edits:
 * qualifying a parcel commits the diligence budget, converting one commits the
 * company to building, and handing a JV to the land team starts both. Migration
 * 028 created a key for each and the SPA has always read them — Land.tsx picks
 * its buttons from approve_land_qualify / approve_land_convert, and BD.tsx shows
 * the maker "Awaiting hand-off approval". Only the API never checked them, so
 * the separation of duties existed everywhere except where it counts.
 *
 * The approval key REPLACES the maker key for these transitions rather than
 * adding to it, and that direction matters: bd_manager is the designated
 * checker for qualification and deliberately does not hold manage_land. Requiring
 * both would keep the role locked out of the one action it exists to perform.
 *
 * `carries` is the one field that belongs TO the approval rather than being a
 * separate edit smuggled alongside it. Converting a parcel creates the project
 * and links it in the same call (`{status:'converted_to_project', projectId}`),
 * and a hand-off links the parcel it just created — so demanding the maker key
 * for those would refuse the very call the approval exists to make. Every OTHER
 * field still needs it.
 */
interface Approval { key: string; carries?: string }
const LAND_APPROVAL: Record<string, Approval> = {
  qualified: { key: 'approve_land_qualify' },
  converted_to_project: { key: 'approve_land_convert', carries: 'projectId' },
};
const BD_APPROVAL: Record<string, Approval> = {
  handed_to_land: { key: 'approve_bd_handoff', carries: 'landLeadId' },
};

/**
 * True when the body changes anything beyond the transition itself — which the
 * approver may only do if they also hold the maker key.
 */
function editsBeyond(body: Record<string, unknown>, transitionField: string, carries?: string): boolean {
  return Object.keys(body).some(k => k !== transitionField && k !== carries && body[k] !== undefined);
}

export async function landBdRoutes(app: FastifyInstance): Promise<void> {
  // ── Land leads (parcels) ────────────────────────────────────────────────
  const landToApi = (r: Record<string, unknown>) => ({
    id: r.id, referenceSource: r.reference_source, ownerName: r.owner_name, ownerContact: r.owner_contact,
    location: r.location, city: r.city, state: r.state, pincode: r.pincode, surveyNumber: r.survey_number,
    areaAcres: num(r.area_acres), askingPrice: num(r.asking_price), status: r.status, rejectionReason: r.rejection_reason,
    assignedTo: r.assigned_to, ownershipType: r.ownership_type, zoning: r.zoning, fsiPermissible: num(r.fsi_permissible),
    fsiConsumed: num(r.fsi_consumed), roadWidthFt: num(r.road_width_ft), isEncumbered: r.is_encumbered, encumbranceNotes: r.encumbrance_notes,
    litigationStatus: r.litigation_status, duplicateOf: r.duplicate_of, projectId: r.project_id, latestScore: r.latest_score,
    createdBy: r.created_by, createdAt: r.created_at,
  });

  // One shape for feasibility runs, land documents and market reports, so the
  // list and the create response agree — a create that returned a thinner
  // record than the list left the client's cache missing fields until a reload.
  const feasToApi = (r: Record<string, unknown>) => ({
    id: r.id, landLeadId: r.land_lead_id, costPerSqft: num(r.cost_per_sqft), saleableArea: num(r.saleable_area),
    estimatedRevenue: num(r.estimated_revenue), marginPercent: num(r.margin_percent), score: r.score,
    cappedByRisk: r.capped_by_risk, computedBy: r.computed_by, computedAt: r.computed_at,
  });
  const docToApi = (r: Record<string, unknown>) => ({
    id: r.id, landLeadId: r.land_lead_id, docType: r.doc_type, version: r.version, fileName: r.file_name,
    verificationStatus: r.verification_status, verifiedBy: r.verified_by, verifiedAt: r.verified_at,
    uploadedBy: r.uploaded_by, createdAt: r.created_at,
  });
  const reportToApi = (r: Record<string, unknown>) => ({
    id: r.id, areaName: r.area_name, reportType: r.report_type, findings: r.findings,
    dataSources: r.data_sources, createdBy: r.created_by, createdAt: r.created_at,
  });

  app.get('/api/land-leads', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_land')) return reply.code(403).send({ error: 'Missing permission: view_land' });
      const { rows } = await db.query('SELECT * FROM land_leads ORDER BY created_at DESC');
      return { landLeads: rows.map(landToApi) };
    }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/land-leads',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['ownerName', 'surveyNumber'], additionalProperties: false, properties: {
        referenceSource: { type: 'string', maxLength: 60 }, ownerName: { type: 'string', minLength: 1, maxLength: 160 }, ownerContact: { type: 'string', maxLength: 60 },
        location: { type: 'string', maxLength: 200 }, city: { type: 'string', maxLength: 80 }, state: { type: 'string', maxLength: 80 }, pincode: { type: 'string', maxLength: 12 },
        surveyNumber: { type: 'string', maxLength: 80 }, areaAcres: { type: 'number', minimum: 0 }, askingPrice: { type: 'number', minimum: 0 }, status: { type: 'string', enum: LAND_STATUSES },
        ownershipType: { type: 'string', maxLength: 40 }, zoning: { type: 'string', maxLength: 80 }, fsiPermissible: { type: 'number', minimum: 0 }, fsiConsumed: { type: 'number', minimum: 0 },
        roadWidthFt: { type: 'number', minimum: 0 }, isEncumbered: { type: 'boolean' }, encumbranceNotes: { type: 'string', maxLength: 1000 }, litigationStatus: { type: 'string', maxLength: 40 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_land')) return reply.code(403).send({ error: 'Missing permission: manage_land' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO land_leads (tenant_id, reference_source, owner_name, owner_contact, location, city, state, pincode, survey_number,
             area_acres, asking_price, status, ownership_type, zoning, fsi_permissible, fsi_consumed, road_width_ft, is_encumbered, encumbrance_notes, litigation_status, created_by)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11,'lead_reference'), $12,$13,$14,$15,$16, COALESCE($17,false), $18, COALESCE($19,'clear'), $20) RETURNING *`,
          [b.referenceSource || '', b.ownerName, b.ownerContact || '', b.location || '', b.city || '', b.state || '', b.pincode || '', b.surveyNumber,
           b.areaAcres ?? 0, b.askingPrice ?? 0, b.status ?? null, b.ownershipType ?? null, b.zoning ?? null, b.fsiPermissible ?? null, b.fsiConsumed ?? null,
           b.roadWidthFt ?? null, b.isEncumbered ?? null, b.encumbranceNotes ?? null, b.litigationStatus ?? null, req.ctx.userId || null]);
        reply.code(201); return { landLead: landToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; assignedTo?: string; rejectionReason?: string; projectId?: string } }>(
    '/api/land-leads/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: LAND_STATUSES }, assignedTo: { type: 'string', pattern: UUID }, rejectionReason: { type: 'string', maxLength: 1000 }, projectId: { type: 'string', pattern: UUID } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const b = req.body;
        // An approval transition needs its own key; every other edit — assigning,
        // rejecting, moving through diligence — stays with the maker.
        const approval = b.status ? LAND_APPROVAL[b.status] : undefined;
        const needed = approval?.key ?? 'manage_land';
        if (!await gate(db, needed)) return reply.code(403).send({ error: `Missing permission: ${needed}` });
        // A body that approves AND edits must satisfy both, or a checker could
        // change fields they have no rights to under cover of an approval.
        if (approval && editsBeyond(b as Record<string, unknown>, 'status', approval.carries)) {
          if (!await gate(db, 'manage_land')) return reply.code(403).send({ error: 'Missing permission: manage_land' });
        }
        const { rows } = await db.query(
          `UPDATE land_leads SET status = COALESCE($1,status), assigned_to = COALESCE($2,assigned_to), rejection_reason = COALESCE($3,rejection_reason), project_id = COALESCE($4,project_id) WHERE id = $5 RETURNING *`,
          [b.status ?? null, b.assignedTo ?? null, b.rejectionReason ?? null, b.projectId ?? null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Land lead not found' });
        return { landLead: landToApi(rows[0]) };
      }),
  );

  // ── Feasibility runs (bumps latest_score on the parcel) ─────────────────
  app.get<{ Querystring: { landLeadId?: string } }>('/api/feasibility', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_land')) return reply.code(403).send({ error: 'Missing permission: view_land' });
      const { rows } = req.query.landLeadId
        ? await db.query('SELECT * FROM feasibility_records WHERE land_lead_id = $1 ORDER BY computed_at DESC', [req.query.landLeadId])
        : await db.query('SELECT * FROM feasibility_records ORDER BY computed_at DESC LIMIT 500');
      return { feasibility: rows.map(r => ({ id: r.id, landLeadId: r.land_lead_id, costPerSqft: num(r.cost_per_sqft), saleableArea: num(r.saleable_area), estimatedRevenue: num(r.estimated_revenue), marginPercent: num(r.margin_percent), score: r.score, cappedByRisk: r.capped_by_risk, computedAt: r.computed_at })) };
    }),
  );

  app.post<{ Body: { landLeadId: string; costPerSqft: number; saleableArea: number; estimatedRevenue: number; marginPercent: number; score: number; cappedByRisk?: boolean } }>(
    '/api/feasibility',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['landLeadId', 'score'], additionalProperties: false, properties: {
        landLeadId: { type: 'string', pattern: UUID }, costPerSqft: { type: 'number', minimum: 0 }, saleableArea: { type: 'number', minimum: 0 },
        estimatedRevenue: { type: 'number', minimum: 0 }, marginPercent: { type: 'number' }, score: { type: 'integer', minimum: 0, maximum: 100 }, cappedByRisk: { type: 'boolean' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_land')) return reply.code(403).send({ error: 'Missing permission: manage_land' });
        const { rows: ll } = await db.query('SELECT id FROM land_leads WHERE id = $1', [req.body.landLeadId]);
        if (!ll[0]) return reply.code(404).send({ error: 'Land lead not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO feasibility_records (tenant_id, land_lead_id, cost_per_sqft, saleable_area, estimated_revenue, margin_percent, score, capped_by_risk, computed_by)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [b.landLeadId, b.costPerSqft ?? 0, b.saleableArea ?? 0, b.estimatedRevenue ?? 0, b.marginPercent ?? 0, b.score, b.cappedByRisk ?? false, req.ctx.userId || null]);
        await db.query('UPDATE land_leads SET latest_score = $1 WHERE id = $2', [b.score, b.landLeadId]);
        const r = rows[0];
        reply.code(201); return { feasibility: feasToApi(r) };
      }),
  );

  // ── Land documents ──────────────────────────────────────────────────────
  app.get<{ Querystring: { landLeadId?: string } }>('/api/land-documents', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_land')) return reply.code(403).send({ error: 'Missing permission: view_land' });
      const { rows } = req.query.landLeadId
        ? await db.query('SELECT * FROM land_documents WHERE land_lead_id = $1 ORDER BY created_at DESC', [req.query.landLeadId])
        : await db.query('SELECT * FROM land_documents ORDER BY created_at DESC LIMIT 500');
      return { documents: rows.map(docToApi) };
    }),
  );

  app.post<{ Body: { landLeadId: string; docType: string; fileName: string; version?: number } }>(
    '/api/land-documents',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['landLeadId', 'docType', 'fileName'], additionalProperties: false, properties: {
        landLeadId: { type: 'string', pattern: UUID }, docType: { type: 'string', maxLength: 60 }, fileName: { type: 'string', maxLength: 200 }, version: { type: 'integer', minimum: 1 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_land')) return reply.code(403).send({ error: 'Missing permission: manage_land' });
        const { rows: ll } = await db.query('SELECT id FROM land_leads WHERE id = $1', [req.body.landLeadId]);
        if (!ll[0]) return reply.code(404).send({ error: 'Land lead not found' });
        const { rows } = await db.query(
          `INSERT INTO land_documents (tenant_id, land_lead_id, doc_type, file_name, version, uploaded_by) VALUES (app_current_tenant(), $1,$2,$3,$4,$5) RETURNING *`,
          [req.body.landLeadId, req.body.docType, req.body.fileName, req.body.version ?? 1, req.ctx.userId || null]);
        const r = rows[0];
        reply.code(201); return { document: docToApi(r) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { verificationStatus: string } }>(
    '/api/land-documents/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['verificationStatus'], additionalProperties: false, properties: { verificationStatus: { type: 'string', enum: ['pending', 'verified', 'rejected'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // Verifying a title deed is diligence sign-off, not filing: the person
        // who uploaded the document must not be the one who attests to it. The
        // SPA has always agreed — Land.tsx gates this control on
        // canVerifyDocs = approve_land_qualify — while the API asked for
        // manage_land, so the checker was shown the button and refused, and the
        // uploader could verify their own upload.
        if (!await gate(db, 'approve_land_qualify')) return reply.code(403).send({ error: 'Missing permission: approve_land_qualify' });
        const verified = req.body.verificationStatus !== 'pending';
        const { rows } = await db.query(
          `UPDATE land_documents SET verification_status = $1,
             verified_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
             verified_at = CASE WHEN $2 THEN now() ELSE NULL END
           WHERE id = $4 RETURNING *`,
          [req.body.verificationStatus, verified, req.ctx.userId || null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Document not found' });
        const r = rows[0];
        return { document: docToApi(r) };
      }),
  );

  // ── BD leads (opportunities) ────────────────────────────────────────────
  const bdToApi = (r: Record<string, unknown>) => ({ id: r.id, opportunityType: r.opportunity_type, source: r.source, counterpartyName: r.counterparty_name, counterpartyContact: r.counterparty_contact, city: r.city, stage: r.stage, estimatedDealValue: num(r.estimated_deal_value), closedLostReason: r.closed_lost_reason, ownedBy: r.owned_by, jvStructure: r.jv_structure, revenueSharePercent: num(r.revenue_share_percent), areaSharePercent: num(r.area_share_percent), jvNotes: r.jv_notes, landLeadId: r.land_lead_id, createdBy: r.created_by, createdAt: r.created_at });

  app.get('/api/bd-leads', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_bd')) return reply.code(403).send({ error: 'Missing permission: view_bd' });
      const { rows } = await db.query('SELECT * FROM bd_leads ORDER BY created_at DESC');
      return { bdLeads: rows.map(bdToApi) };
    }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/bd-leads',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['counterpartyName'], additionalProperties: false, properties: {
        opportunityType: { type: 'string', maxLength: 40 }, source: { type: 'string', maxLength: 60 }, counterpartyName: { type: 'string', minLength: 1, maxLength: 160 }, counterpartyContact: { type: 'string', maxLength: 60 },
        city: { type: 'string', maxLength: 80 }, stage: { type: 'string', enum: BD_STAGES }, estimatedDealValue: { type: 'number', minimum: 0 },
        jvStructure: { type: 'string', maxLength: 40 }, revenueSharePercent: { type: 'number', minimum: 0, maximum: 100 }, areaSharePercent: { type: 'number', minimum: 0, maximum: 100 }, jvNotes: { type: 'string', maxLength: 1000 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bd')) return reply.code(403).send({ error: 'Missing permission: manage_bd' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO bd_leads (tenant_id, opportunity_type, source, counterparty_name, counterparty_contact, city, stage, estimated_deal_value, jv_structure, revenue_share_percent, area_share_percent, jv_notes, created_by)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5, COALESCE($6,'identified'), $7,$8,$9,$10,$11, $12) RETURNING *`,
          [b.opportunityType || '', b.source || '', b.counterpartyName, b.counterpartyContact || '', b.city || '', b.stage ?? null, b.estimatedDealValue ?? 0, b.jvStructure ?? null, b.revenueSharePercent ?? null, b.areaSharePercent ?? null, b.jvNotes ?? null, req.ctx.userId || null]);
        reply.code(201); return { bdLead: bdToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { stage?: string; closedLostReason?: string; landLeadId?: string } }>(
    '/api/bd-leads/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { stage: { type: 'string', enum: BD_STAGES }, closedLostReason: { type: 'string', maxLength: 1000 }, landLeadId: { type: 'string', pattern: UUID } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const b = req.body;
        const approval = b.stage ? BD_APPROVAL[b.stage] : undefined;
        const needed = approval?.key ?? 'manage_bd';
        if (!await gate(db, needed)) return reply.code(403).send({ error: `Missing permission: ${needed}` });
        if (approval && editsBeyond(b as Record<string, unknown>, 'stage', approval.carries)) {
          if (!await gate(db, 'manage_bd')) return reply.code(403).send({ error: 'Missing permission: manage_bd' });
        }
        const { rows } = await db.query(
          `UPDATE bd_leads SET stage = COALESCE($1,stage), closed_lost_reason = COALESCE($2,closed_lost_reason), land_lead_id = COALESCE($3,land_lead_id) WHERE id = $4 RETURNING *`,
          [b.stage ?? null, b.closedLostReason ?? null, b.landLeadId ?? null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'BD lead not found' });
        return { bdLead: bdToApi(rows[0]) };
      }),
  );

  // ── Market reports ──────────────────────────────────────────────────────
  app.get('/api/market-reports', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_bd')) return reply.code(403).send({ error: 'Missing permission: view_bd' });
      const { rows } = await db.query('SELECT * FROM market_reports ORDER BY created_at DESC');
      return { reports: rows.map(reportToApi) };
    }),
  );

  app.post<{ Body: { areaName: string; reportType?: string; findings?: string; dataSources?: string } }>(
    '/api/market-reports',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['areaName'], additionalProperties: false, properties: {
      areaName: { type: 'string', minLength: 1, maxLength: 160 }, reportType: { type: 'string', maxLength: 40 }, findings: { type: 'string', maxLength: 4000 }, dataSources: { type: 'string', maxLength: 500 },
    } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bd')) return reply.code(403).send({ error: 'Missing permission: manage_bd' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO market_reports (tenant_id, area_name, report_type, findings, data_sources, created_by) VALUES (app_current_tenant(), $1, COALESCE($2,'pricing_benchmark'), $3, $4, $5) RETURNING *`,
          [b.areaName, b.reportType ?? null, b.findings || '', b.dataSources ?? null, req.ctx.userId || null]);
        const r = rows[0];
        reply.code(201); return { report: reportToApi(r) };
      }),
  );
}
