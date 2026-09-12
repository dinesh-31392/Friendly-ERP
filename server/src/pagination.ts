/**
 * Keyset pagination for the list endpoints.
 *
 * WHY KEYSET AND NOT OFFSET
 *
 * `OFFSET n` makes the database walk and discard n rows before returning
 * anything, so page 200 costs two hundred times page 1 — it degrades on
 * exactly the tables that got large enough to need paging. A keyset carries
 * the last row's sort key and asks for "the next N after this", which is an
 * index seek whatever page you are on.
 *
 * WHY (timestamp, id) AND NOT TIMESTAMP ALONE
 *
 * `created_at` is not unique. Two leads captured in the same millisecond — a
 * bulk import does this constantly — would sit either side of a page boundary
 * with no stable order between them, so one could be shown twice and the other
 * never. The id breaks the tie, and both travel in the cursor.
 *
 * WHY THE RESPONSE SHAPE DID NOT CHANGE
 *
 * Every endpoint still returns its original array key and simply gains
 * `nextCursor`. A caller that ignores it behaves exactly as before, which is
 * what let this be added to live endpoints without a coordinated client
 * release — the SPA follows the cursor, the verification suites do not, and
 * both are correct.
 */

/** Fastify querystring properties. Spread into a route's schema. */
export const PAGE_QUERY = {
  limit: { type: 'integer', minimum: 1, maximum: 500 },
  cursor: { type: 'string', maxLength: 200 },
} as const;

export interface PageRequest {
  limit: number;
  /** Undefined on the first page. */
  after?: { ts: string; id: string };
}

/** Bounded by default. An endpoint with no limit is the bug this module exists
 *  to remove, so there is deliberately no way to ask for "everything". */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export function readPage(q: { limit?: number; cursor?: string }): PageRequest {
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  if (!q.cursor) return { limit };
  try {
    const raw = Buffer.from(q.cursor, 'base64url').toString('utf8');
    const [ts, id] = raw.split('|');
    // A malformed cursor returns the FIRST page rather than an error: cursors
    // end up in shared links and browser history, and a stale one should show
    // the top of the list, not a failure.
    if (!ts || !id) return { limit };
    return { limit, after: { ts, id } };
  } catch {
    return { limit };
  }
}

export function encodeCursor(ts: string | Date, id: string): string {
  const s = ts instanceof Date ? ts.toISOString() : String(ts);
  return Buffer.from(`${s}|${id}`, 'utf8').toString('base64url');
}

/**
 * The WHERE fragment and parameters for "strictly after this key", descending.
 *
 * Returns SQL against a row-value comparison — `(created_at, id) < ($1, $2)` —
 * which Postgres can satisfy from a composite index in one seek, unlike the
 * equivalent OR-expansion.
 *
 * `nextParamIndex` is where the caller's existing parameter list has got to,
 * so this composes with routes that already bind filters.
 */
export function keysetWhere(
  page: PageRequest, tsColumn: string, idColumn: string, nextParamIndex: number,
): { sql: string; params: unknown[] } {
  if (!page.after) return { sql: '', params: [] };
  return {
    sql: `(${tsColumn}, ${idColumn}) < ($${nextParamIndex}::timestamptz, $${nextParamIndex + 1}::uuid)`,
    params: [page.after.ts, page.after.id],
  };
}

/**
 * Split the over-fetched rows into the page and the cursor that follows it.
 *
 * The caller asks the database for `limit + 1`. If it comes back, there is
 * another page and the extra row is dropped — which is how "is there more?" is
 * answered without a second COUNT over the whole table.
 */
export function takePage<T extends Record<string, unknown>>(
  rows: T[], page: PageRequest, tsField: string, idField = 'id',
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= page.limit) return { rows, nextCursor: null };
  const kept = rows.slice(0, page.limit);
  const last = kept[kept.length - 1];
  return {
    rows: kept,
    nextCursor: encodeCursor(last[tsField] as string | Date, last[idField] as string),
  };
}
