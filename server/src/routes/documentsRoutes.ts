import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * DB row → the SPA's `Document` shape. Near 1:1; the only rename is
 * `doc_date` ↔ `date` (SPA carries a preformatted display date string).
 */
function toApiDocument(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    type: r.type ?? '',
    project: r.project ?? '',
    date: r.doc_date ?? '',
    size: r.size ?? '',
    status: r.status ?? '',
    url: r.url ?? '',
  };
}

// camelCase → column. tenant_id/id/created_at are DB-owned.
const WRITABLE: Record<string, string> = {
  name: 'name',
  type: 'type',
  project: 'project',
  date: 'doc_date',
  size: 'size',
  status: 'status',
  url: 'url',
};

const DOC_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 300 },
  type: { type: 'string', maxLength: 60 },
  project: { type: 'string', maxLength: 200 },
  date: { type: 'string', maxLength: 60 },
  size: { type: 'string', maxLength: 40 },
  status: { type: 'string', maxLength: 40 },
  url: { type: 'string', maxLength: 4000 },
} as const;

interface DocBody {
  name?: string; type?: string; project?: string; date?: string;
  size?: string; status?: string; url?: string;
}

function collectWrites(body: DocBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(WRITABLE)) {
    if (body[key as keyof DocBody] === undefined) continue;
    params.push(body[key as keyof DocBody]);
    cols.push(col);
    exprs.push(`$${params.length}`);
  }
  return { cols, exprs, params };
}

export async function documentsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/documents — RLS-scoped; view_documents gates access. */
  app.get('/api/documents', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_documents') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_documents' });
      const { rows } = await db.query('SELECT * FROM documents ORDER BY created_at DESC');
      return { documents: rows.map(toApiDocument) };
    }),
  );

  /** POST /api/documents — register a document. */
  app.post<{ Body: DocBody }>(
    '/api/documents',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: DOC_PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_documents') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_documents' });
          const { cols, exprs, params } = collectWrites(req.body);
          const { rows } = await db.query(
            `INSERT INTO documents (tenant_id${cols.length ? ', ' + cols.join(', ') : ''})
             VALUES (app_current_tenant()${exprs.length ? ', ' + exprs.join(', ') : ''})
             RETURNING *`,
            params,
          );
          reply.code(201); return { document: toApiDocument(rows[0]) };
        });
      } catch (err) {
        if ((err as { code?: string })?.code === '23502') return reply.code(400).send({ error: 'A required field is missing.' });
        throw err;
      }
    },
  );

  /** DELETE /api/documents/:id */
  app.delete<{ Params: { id: string } }>(
    '/api/documents/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_documents') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_documents' });
        const { rowCount } = await db.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Document not found' });
        reply.code(204); return null;
      }),
  );
}
