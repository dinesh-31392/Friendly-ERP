import type { PoolClient } from 'pg';

/**
 * Answering an erasure request under the DPDP Act, 2023.
 *
 * The decision is per record, not per person. See migration 054 for why both
 * of the obvious answers are wrong; this is the machinery that produces the
 * third one:
 *
 *   ERASE    — no basis to keep it. A lead nobody converted, their activities,
 *              their site visits. Most of what a CRM holds.
 *   REDACT   — must be kept, but not under their name. A booking's personal
 *              identifiers can go while the financial record stays intact.
 *   RETAIN   — kept as it is, with a reason. Ledger rows and audit trails,
 *              where altering the record would destroy its point.
 *
 * The plan is computed BEFORE anything is touched and can be returned to the
 * caller for review. Someone answering a legal request needs to be able to see
 * what the system is about to do, and to put that in a reply.
 */

export type ErasureAction = 'erased' | 'redacted' | 'retained';

export interface ErasureStep {
  entity: string;
  action: ErasureAction;
  recordCount: number;
  /** Required by the schema whenever the action is `retained`. */
  legalBasis: string;
  detail: string;
  recordId?: string;
}

/** The value written over a redacted identifier. Deliberately not blank: a
 *  reader of the row needs to know the data was removed on request rather than
 *  never captured, and the two look identical if you just null it out. */
export const REDACTED = '[erased on request]';

const BOOKS_OF_ACCOUNT =
  'Books of account — Companies Act, 2013 s.128(5); retained for eight years from the end of the relevant financial year';
const AUDIT_BASIS =
  'Evidence of processing and access, retained to answer a supervisory enquiry';

/**
 * Work out what an erasure request would actually do.
 *
 * Read-only. The split that matters is whether the person ever became a
 * customer: a lead who never booked leaves nothing anyone is required to keep,
 * while a lead who did leaves a financial record that survives them.
 */
export async function planErasure(
  db: PoolClient,
  subject: { leadId?: string | null; email?: string; phone?: string },
): Promise<{ steps: ErasureStep[]; leadIds: string[] }> {
  const steps: ErasureStep[] = [];

  // Resolve the person to lead rows. An email or phone can match several — the
  // same buyer enquiring twice about two projects is ordinary — and all of them
  // are the same Data Principal.
  const { rows: leads } = await db.query(
    `SELECT id, name, email, phone FROM leads
      WHERE ($1::uuid IS NOT NULL AND id = $1)
         OR ($2::text <> '' AND lower(email) = lower($2))
         OR ($3::text <> '' AND phone = $3)`,
    [subject.leadId ?? null, subject.email ?? '', subject.phone ?? '']);

  const leadIds = leads.map(l => l.id as string);
  if (!leadIds.length) return { steps, leadIds };

  // Which of them carry a booking. That is the whole fork.
  const { rows: booked } = await db.query(
    `SELECT DISTINCT lead_id FROM bookings WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
  const bookedLeadIds = new Set(booked.map(b => b.lead_id as string));

  for (const lead of leads) {
    if (bookedLeadIds.has(lead.id as string)) {
      steps.push({
        entity: 'leads', action: 'redacted', recordCount: 1, recordId: lead.id as string,
        legalBasis: BOOKS_OF_ACCOUNT,
        detail: 'Name, email and phone removed. The record is kept because a booking references it.',
      });
    } else {
      steps.push({
        entity: 'leads', action: 'erased', recordCount: 1, recordId: lead.id as string,
        legalBasis: '',
        detail: 'No booking, invoice or payment references this lead.',
      });
    }
  }

  /**
   * Count, with NO defensive catch.
   *
   * A caught query error does not un-poison a Postgres transaction: the
   * statement aborts the block, every later statement fails with 25P02, and the
   * `catch` hides the cause. An earlier version wrapped these in `.catch(() => 0)`
   * to tolerate an optional table, and one wrong column name (`audit_logs`
   * keys on `record_id`, not `entity_id`) turned the whole erasure into an
   * opaque 500 with the real error swallowed. If a query here is wrong, it
   * should say so.
   */
  const countIn = async (sql: string, params: unknown[] = [leadIds]) =>
    Number((await db.query(sql, params)).rows[0]?.n ?? 0);

  // Activities and visits follow the lead they belong to. They carry the
  // conversation, not the contract, so nothing requires them to be kept.
  const activities = await countIn(
    `SELECT count(*)::int n FROM lead_activities WHERE lead_id = ANY($1::uuid[])`);
  if (activities) {
    steps.push({
      entity: 'lead_activities', action: 'erased', recordCount: activities, legalBasis: '',
      detail: 'Calls, notes and messages recorded against the lead.',
    });
  }

  const visits = await countIn(
    `SELECT count(*)::int n FROM site_visits WHERE lead_id = ANY($1::uuid[])`);
  if (visits) {
    steps.push({
      entity: 'site_visits', action: 'erased', recordCount: visits, legalBasis: '',
      detail: 'Site visit records for the lead.',
    });
  }

  if (bookedLeadIds.size) {
    const ids = [...bookedLeadIds];
    const bookings = await countIn(
      `SELECT count(*)::int n FROM bookings WHERE lead_id = ANY($1::uuid[])`, [ids]);
    steps.push({
      entity: 'bookings', action: 'retained', recordCount: bookings,
      legalBasis: BOOKS_OF_ACCOUNT,
      detail: 'The booking, its payment schedule and its receipts form part of the books of account.',
    });

    const invoices = await countIn(
      `SELECT count(*)::int n FROM invoices WHERE lead_id = ANY($1::uuid[])`, [ids]);
    if (invoices) {
      steps.push({
        entity: 'invoices', action: 'retained', recordCount: invoices,
        legalBasis: BOOKS_OF_ACCOUNT,
        detail: 'Tax invoices raised against the allottee.',
      });
    }
  }

  // The audit trail is the record of who did what, including this erasure. It
  // is not altered, because a trail that can be rewritten on request is not a
  // trail — and the Act's own accountability obligations depend on it.
  const audits = await countIn(
    `SELECT count(*)::int n FROM audit_logs WHERE record_id = ANY($1::uuid[])`);
  if (audits) {
    steps.push({
      entity: 'audit_logs', action: 'retained', recordCount: audits,
      legalBasis: AUDIT_BASIS,
      detail: 'Access and change history. Not altered — a trail that can be rewritten on request is not a trail.',
    });
  }

  return { steps, leadIds };
}

/**
 * Carry out a plan.
 *
 * Order matters. Children go before parents, or a foreign key stops the erasure
 * halfway and leaves the subject partly deleted with no record of where it got
 * to. Everything runs inside the caller's transaction so a failure leaves the
 * request untouched rather than half-answered.
 */
export async function executeErasure(
  db: PoolClient,
  plan: { steps: ErasureStep[]; leadIds: string[] },
): Promise<void> {
  const erasedLeadIds = plan.steps
    .filter(s => s.entity === 'leads' && s.action === 'erased' && s.recordId)
    .map(s => s.recordId as string);
  const redactedLeadIds = plan.steps
    .filter(s => s.entity === 'leads' && s.action === 'redacted' && s.recordId)
    .map(s => s.recordId as string);

  if (plan.leadIds.length) {
    // Children first, and only for leads that are actually going. A redacted
    // lead keeps its booking, and its activities go either way — they are the
    // conversation, and nothing requires keeping it.
    await db.query('DELETE FROM lead_activities WHERE lead_id = ANY($1::uuid[])', [plan.leadIds]);
    await db.query('DELETE FROM site_visits WHERE lead_id = ANY($1::uuid[])', [plan.leadIds]);
  }

  if (redactedLeadIds.length) {
    // The row survives so the booking still resolves; the person does not.
    //
    // `phone_normalized` is deliberately absent: it is a GENERATED column
    // derived from `phone`, so Postgres refuses an explicit assignment and
    // clearing `phone` clears it anyway. Naming it here fails the whole
    // erasure with "cannot insert a non-DEFAULT value into column".
    await db.query(
      `UPDATE leads
          SET name = $2, email = '', phone = ''
        WHERE id = ANY($1::uuid[])`,
      [redactedLeadIds, REDACTED]);
  }

  if (erasedLeadIds.length) {
    await db.query('DELETE FROM leads WHERE id = ANY($1::uuid[])', [erasedLeadIds]);
  }
}

/**
 * Records past their retention period, by entity.
 *
 * Only ever offered for entities whose policy has no statutory basis. A sweep
 * that can reach the books of account is one bad configuration away from
 * destroying them, so it cannot reach them at all: the query filters on
 * `statutory = false` rather than trusting the days column to be sensible.
 */
export async function findExpired(
  db: PoolClient,
): Promise<Array<{ entity: string; retainDays: number; count: number }>> {
  const { rows: policies } = await db.query(
    `SELECT entity, retain_days FROM retention_policies
      WHERE statutory = false AND retain_days IS NOT NULL AND retain_days > 0`);

  const out: Array<{ entity: string; retainDays: number; count: number }> = [];
  for (const p of policies) {
    // Only the entities a sweep is allowed to touch, named explicitly. A
    // table name taken from a config row and interpolated into SQL is an
    // injection waiting for someone to edit a policy.
    const SWEEPABLE: Record<string, string> = {
      leads: `SELECT count(*)::int n FROM leads l
               WHERE l.created_at < now() - ($1 || ' days')::interval
                 AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.lead_id = l.id)`,
      lead_activities: `SELECT count(*)::int n FROM lead_activities
                         WHERE created_at < now() - ($1 || ' days')::interval`,
      site_visits: `SELECT count(*)::int n FROM site_visits
                     WHERE created_at < now() - ($1 || ' days')::interval`,
    };
    const sql = SWEEPABLE[p.entity as string];
    if (!sql) continue;
    const n = Number((await db.query(sql, [String(p.retain_days)]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n ?? 0);
    if (n > 0) out.push({ entity: p.entity as string, retainDays: Number(p.retain_days), count: n });
  }
  return out;
}
