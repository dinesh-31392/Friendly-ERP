import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  MAX_UPLOAD_BYTES, contentDisposition, deleteKey, keyExists,
  NOSNIFF, resolveKey, safeContentType, saveStream,
} from '../storage.js';

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
    // Present only when real bytes are attached. The SPA branches on this to
    // decide between "open the link" and "download from us", so it must be
    // null rather than absent for a link-only row.
    fileId: r.file_id ?? null,
  };
}

/** "2.4 MB" — the register stores a display string, so derive it once here
 *  rather than making every caller format the same number differently. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
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

  /**
   * POST /api/documents/upload — multipart; the register entry AND the bytes.
   *
   * Before this the module could only record that a document existed somewhere
   * else. Every field except the file is optional and arrives as a form field
   * beside it, so one request produces one consistent row rather than an upload
   * followed by a metadata PATCH that might never arrive.
   */
  app.post('/api/documents/upload', { preHandler: requireAuth }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) return reply.code(400).send({ error: 'No file in the request.' });

    // Permission BEFORE the bytes touch the disk. Checking afterwards would
    // let anyone who can authenticate fill the volume.
    const permitted = await withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_documents') AS allowed`);
      return allowed as boolean;
    });
    if (!permitted) return reply.code(403).send({ error: 'Missing permission: manage_documents' });

    const month = new Date().toISOString().slice(0, 7);
    let saved;
    try {
      saved = await saveStream(req.ctx.tenantId, part.file, month);
    } catch (err) {
      if ((err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.` });
      }
      throw err;
    }
    // @fastify/multipart sets this after the stream ends rather than throwing,
    // when the limit is hit mid-file. Without the check a truncated file would
    // be stored as if it were whole.
    if (part.file.truncated) {
      await deleteKey(saved.storageKey);
      return reply.code(413).send({ error: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.` });
    }

    // Form fields ride alongside the file; anything absent falls back to
    // something derived from the upload itself, so a bare file still produces
    // a usable register entry.
    const field = (n: string): string => {
      const v = (part.fields as Record<string, { value?: unknown } | undefined>)[n];
      return typeof v?.value === 'string' ? v.value.slice(0, 300) : '';
    };

    try {
      return await withTenantContext(req.ctx, async (db) => {
        const { rows: [file] } = await db.query(
          `INSERT INTO stored_files
             (tenant_id, storage_key, original_name, content_type, size_bytes, sha256, uploaded_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
          [saved.storageKey, part.filename || 'upload', part.mimetype || 'application/octet-stream',
           saved.sizeBytes, saved.sha256, req.ctx.userId],
        );
        const { rows } = await db.query(
          `INSERT INTO documents (tenant_id, name, type, project, doc_date, size, status, file_id)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [field('name') || part.filename || 'Untitled',
           field('type'), field('project'),
           field('date') || new Date().toISOString().slice(0, 10),
           humanSize(saved.sizeBytes),
           field('status') || 'Uploaded',
           file.id],
        );
        reply.code(201); return { document: toApiDocument(rows[0]) };
      });
    } catch (err) {
      // The row is the thing that makes a file reachable. If it fails to write,
      // the bytes on disk are unreferenced and must not be left behind.
      await deleteKey(saved.storageKey);
      throw err;
    }
  });

  /**
   * GET /api/documents/:id/file — stream the bytes back.
   *
   * Served through the API rather than from a static directory, because a
   * static path is readable by anyone who can guess it and carries no notion of
   * which workspace a file belongs to. Here RLS answers that: the SELECT simply
   * returns nothing for another tenant's id, and the caller gets the same 404
   * as for a document that never existed — no existence oracle.
   */
  app.get<{ Params: { id: string } }>(
    '/api/documents/:id/file',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const file = await withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_documents') AS allowed`);
        if (!allowed) return { forbidden: true } as const;
        const { rows } = await db.query(
          `SELECT f.storage_key, f.original_name, f.content_type, f.size_bytes
             FROM documents d JOIN stored_files f ON f.id = d.file_id
            WHERE d.id = $1`, [req.params.id]);
        return rows[0] ?? null;
      });

      if (file && 'forbidden' in file) return reply.code(403).send({ error: 'Missing permission: view_documents' });
      if (!file) return reply.code(404).send({ error: 'Document not found' });
      if (!(await keyExists(file.storage_key))) {
        // The row survived a restore that the volume did not.
        req.log.error({ storageKey: file.storage_key }, 'stored file missing from disk');
        return reply.code(404).send({ error: 'The stored file is no longer available.' });
      }

      const type = safeContentType(file.content_type);
      reply
        .header('Content-Type', type)
        .header('Content-Length', String(file.size_bytes))
        .header('Content-Disposition', contentDisposition(file.original_name, type !== 'application/octet-stream'))
        .headers(NOSNIFF)
        // A tenant's documents must never be held by a shared cache.
        .header('Cache-Control', 'private, no-store');
      return reply.send(createReadStream(resolveKey(file.storage_key)));
    },
  );

  /** DELETE /api/documents/:id — and the bytes with it. */
  app.delete<{ Params: { id: string } }>(
    '/api/documents/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const result = await withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_documents') AS allowed`);
        if (!allowed) return { forbidden: true } as const;
        // Read the key before the delete: afterwards the row is gone and the
        // bytes would be orphaned on the volume forever.
        const { rows } = await db.query(
          `SELECT f.id AS file_id, f.storage_key
             FROM documents d LEFT JOIN stored_files f ON f.id = d.file_id
            WHERE d.id = $1`, [req.params.id]);
        if (!rows.length) return { missing: true } as const;
        await db.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
        if (rows[0].file_id) await db.query('DELETE FROM stored_files WHERE id = $1', [rows[0].file_id]);
        return { storageKey: rows[0].storage_key as string | null };
      });

      if ('forbidden' in result) return reply.code(403).send({ error: 'Missing permission: manage_documents' });
      if ('missing' in result) return reply.code(404).send({ error: 'Document not found' });
      // After the commit. Unlinking inside the transaction would delete the
      // file even if the transaction then rolled back.
      if (result.storageKey) await deleteKey(result.storageKey);
      reply.code(204); return null;
    },
  );
}
