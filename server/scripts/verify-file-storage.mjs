/**
 * File storage: upload, download, isolation, and the ways it could leak.
 *
 * WHAT THIS IS FOR
 *
 * The documents module was a register with a `url` text column and no upload
 * endpoint, so every agreement and KYC scan in the product lived somewhere
 * else. Migration 049 and /api/documents/upload gave it real bytes — and a file
 * feature is the one that most reliably turns into an account takeover, so the
 * interesting assertions here are not "can I upload" but:
 *
 *   - can tenant B read tenant A's file by its id (RLS)
 *   - does an uploaded .html come back as something a browser will EXECUTE
 *   - does a filename with CRLF get to write its own response headers
 *   - does a filename with ../ escape the storage root
 *   - is the size limit enforced, and is the truncated file cleaned up
 *   - does deleting the row delete the bytes
 *
 * Each of those has a specific, known way of going wrong, and none of them is
 * visible from the happy path.
 */
import pg from 'pg';
import argon2 from 'argon2';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'fs' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/erp_test';
const admin = new pg.Client(ADMIN_URL);
await admin.connect();

const STORAGE_ROOT = path.resolve(process.env.FILE_STORAGE_DIR
  ?? path.join(process.cwd(), 'var', 'uploads'));

/** Two workspaces, each with an admin who can manage documents. Isolation is
 *  the point of half these assertions, and it cannot be tested with one. */
async function workspace(slug) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1, $1, $2, $3) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@fs.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'Admin', false) RETURNING id`,
    [t.id])).rows[0];
  await admin.query(
    `INSERT INTO role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest(ARRAY['view_documents','manage_documents']) k
     ON CONFLICT DO NOTHING`,
    [role.id]);
  const email = `${MARK}-${slug}@fs.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1, $2, 'FS Admin', $3, $4, true)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const body = await res.json();
  if (!body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return { tenantId: t.id, token: body.token };
}

const A = await workspace('a');
const B = await workspace('b');

/** Multipart built by hand — FormData is fine, but the header-injection and
 *  traversal cases need filenames a browser would never produce. */
function upload(token, { filename, contentType = 'application/octet-stream', bytes, fields = {} }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  return fetch(BASE + '/api/documents/upload', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
}

const get = (token, path) => fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });

console.log('\n=== A FILE GOES UP AND COMES BACK ===');
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x41)]);
const up = await upload(A.token, {
  filename: 'Allotment Letter.pdf', contentType: 'application/pdf', bytes: pdfBytes,
  fields: { name: 'Allotment Letter', type: 'Agreement', project: 'Skyline' },
});
ok('upload returns 201', up.status === 201, String(up.status));
const doc = (await up.json()).document;
ok('the register entry carries a fileId', !!doc?.fileId);
ok('metadata fields sent before the file are kept', doc?.project === 'Skyline', doc?.project);
ok('size is derived from the bytes, not invented', doc?.size === '2.0 KB', doc?.size);

const dl = await get(A.token, `/api/documents/${doc.id}/file`);
ok('download returns 200', dl.status === 200, String(dl.status));
const got = Buffer.from(await dl.arrayBuffer());
ok('the bytes come back byte-identical', got.equals(pdfBytes),
   `${got.length} vs ${pdfBytes.length}`);
ok('a PDF keeps its content type', dl.headers.get('content-type') === 'application/pdf',
   dl.headers.get('content-type'));
ok('nosniff is set', dl.headers.get('x-content-type-options') === 'nosniff');
ok('a tenant document is never cached by a proxy',
   /no-store/.test(dl.headers.get('cache-control') ?? ''), dl.headers.get('cache-control'));

console.log('\n=== ANOTHER TENANT CANNOT READ IT ===');
const cross = await get(B.token, `/api/documents/${doc.id}/file`);
ok('tenant B gets 404 for tenant A\'s file', cross.status === 404, String(cross.status));
ok('and 404 rather than 403 — no existence oracle', cross.status !== 403, String(cross.status));

const crossList = await (await get(B.token, '/api/documents')).json();
ok('tenant A\'s document is absent from tenant B\'s list',
   !(crossList.documents ?? []).some(d => d.id === doc.id));

console.log('\n=== AN UPLOADED PAGE IS NEVER SERVED AS ONE ===');
// The classic file-upload-to-XSS chain: store HTML, get it served inline from
// the app's own origin, and any script in it runs with the victim's session.
const evil = await upload(A.token, {
  filename: 'invoice.html', contentType: 'text/html',
  bytes: Buffer.from('<script>alert(document.cookie)</script>'),
  fields: { name: 'Evil' },
});
const evilDoc = (await evil.json()).document;
const evilRes = await get(A.token, `/api/documents/${evilDoc.id}/file`);
ok('text/html degrades to octet-stream',
   evilRes.headers.get('content-type') === 'application/octet-stream',
   evilRes.headers.get('content-type'));
ok('and is sent as an attachment, not inline',
   /^attachment/.test(evilRes.headers.get('content-disposition') ?? ''),
   evilRes.headers.get('content-disposition'));

// SVG is an image to a user and a script host to a browser, so it must not be
// on the inline list even though every other image type is.
const svg = await upload(A.token, {
  filename: 'plan.svg', contentType: 'image/svg+xml',
  bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
  fields: { name: 'Plan' },
});
const svgDoc = (await svg.json()).document;
const svgRes = await get(A.token, `/api/documents/${svgDoc.id}/file`);
ok('SVG is not inline-safe either',
   svgRes.headers.get('content-type') === 'application/octet-stream',
   svgRes.headers.get('content-type'));

console.log('\n=== A HOSTILE FILENAME CANNOT WRITE HEADERS OR PATHS ===');
const crlf = await upload(A.token, {
  filename: 'a"\r\nX-Injected: yes\r\n.pdf', contentType: 'application/pdf',
  bytes: Buffer.from('%PDF-1.4'), fields: { name: 'CRLF' },
});
const crlfDoc = (await crlf.json()).document;
const crlfRes = await get(A.token, `/api/documents/${crlfDoc.id}/file`);
ok('a CRLF filename does not inject a header', crlfRes.headers.get('x-injected') === null,
   String(crlfRes.headers.get('x-injected')));
ok('the response is still well-formed', crlfRes.status === 200, String(crlfRes.status));

const trav = await upload(A.token, {
  filename: '../../../../etc/passwd', contentType: 'text/plain',
  bytes: Buffer.from('traversal'), fields: { name: 'Traversal' },
});
ok('a traversal filename is accepted but neutralised', trav.status === 201, String(trav.status));
const travDoc = (await trav.json()).document;
const travKey = (await admin.query(
  `SELECT f.storage_key FROM documents d JOIN stored_files f ON f.id=d.file_id WHERE d.id=$1`,
  [travDoc.id])).rows[0].storage_key;
ok('the storage key contains no path from the client',
   !travKey.includes('..') && !travKey.includes('passwd'), travKey);
ok('and it resolves inside the storage root',
   path.resolve(STORAGE_ROOT, travKey).startsWith(STORAGE_ROOT + path.sep), travKey);

console.log('\n=== THE SIZE LIMIT HOLDS ===');
const capMb = Number(process.env.MAX_UPLOAD_MB) || 25;
const tooBig = await upload(A.token, {
  filename: 'huge.bin', bytes: Buffer.alloc((capMb + 1) * 1024 * 1024, 0x42),
  fields: { name: 'Huge' },
});
ok('an oversized upload is refused with 413', tooBig.status === 413, String(tooBig.status));
const orphans = (await admin.query(
  `SELECT count(*)::int n FROM stored_files WHERE original_name='huge.bin'`)).rows[0].n;
ok('and leaves no row behind', orphans === 0, String(orphans));

console.log('\n=== PERMISSION IS CHECKED BEFORE THE DISK IS TOUCHED ===');
const noPermRole = (await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'Viewer', false) RETURNING id`,
  [A.tenantId])).rows[0];
const viewerEmail = `${MARK}-viewer@fs.test`;
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1, $2, 'Viewer', $3, $4, true)`,
  [A.tenantId, noPermRole.id, viewerEmail, await argon2.hash(PW, { type: argon2.argon2id })]);
const viewerToken = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: viewerEmail, password: PW }),
})).json()).token;
const denied = await upload(viewerToken, {
  filename: 'nope.pdf', bytes: Buffer.from('%PDF'), fields: { name: 'Nope' },
});
ok('a user without manage_documents cannot upload', denied.status === 403, String(denied.status));
const deniedRows = (await admin.query(
  `SELECT count(*)::int n FROM stored_files WHERE original_name='nope.pdf'`)).rows[0].n;
ok('and nothing was written', deniedRows === 0, String(deniedRows));

console.log('\n=== DELETING THE ROW DELETES THE BYTES ===');
const key = (await admin.query(
  `SELECT f.storage_key FROM documents d JOIN stored_files f ON f.id=d.file_id WHERE d.id=$1`,
  [doc.id])).rows[0].storage_key;
const onDiskBefore = await stat(path.resolve(STORAGE_ROOT, key)).then(() => true, () => false);
ok('the file is on disk before the delete', onDiskBefore);

const del = await fetch(BASE + `/api/documents/${doc.id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${A.token}` },
});
ok('delete returns 204', del.status === 204, String(del.status));
const onDiskAfter = await stat(path.resolve(STORAGE_ROOT, key)).then(() => true, () => false);
ok('the bytes are gone from disk', !onDiskAfter);
const rowsAfter = (await admin.query(
  `SELECT count(*)::int n FROM stored_files WHERE storage_key=$1`, [key])).rows[0].n;
ok('and the stored_files row with it', rowsAfter === 0, String(rowsAfter));
ok('the download 404s afterwards',
   (await get(A.token, `/api/documents/${doc.id}/file`)).status === 404);

console.log('\n=== A FILE THAT VANISHED FROM DISK 404s RATHER THAN HANGING ===');
// A database restored against an empty volume is the realistic version of this,
// and streaming a nonexistent path would otherwise produce a dangling request.
const ghost = await upload(A.token, {
  filename: 'ghost.pdf', contentType: 'application/pdf',
  bytes: Buffer.from('%PDF-1.4'), fields: { name: 'Ghost' },
});
const ghostDoc = (await ghost.json()).document;
const ghostKey = (await admin.query(
  `SELECT f.storage_key FROM documents d JOIN stored_files f ON f.id=d.file_id WHERE d.id=$1`,
  [ghostDoc.id])).rows[0].storage_key;
await (await import('node:fs/promises')).rm(path.resolve(STORAGE_ROOT, ghostKey), { force: true });
const ghostRes = await get(A.token, `/api/documents/${ghostDoc.id}/file`);
ok('a row whose file is missing returns 404', ghostRes.status === 404, String(ghostRes.status));

console.log('\n=== THE STORED HASH MATCHES THE STORED BYTES ===');
const hashRow = (await admin.query(
  `SELECT f.storage_key, f.sha256, f.size_bytes FROM documents d
     JOIN stored_files f ON f.id=d.file_id WHERE d.id=$1`, [crlfDoc.id])).rows[0];
const onDisk = await readFile(path.resolve(STORAGE_ROOT, hashRow.storage_key));
const { createHash } = await import('node:crypto');
ok('sha256 is of what was actually written',
   createHash('sha256').update(onDisk).digest('hex') === hashRow.sha256);
ok('size_bytes matches too', Number(hashRow.size_bytes) === onDisk.length,
   `${hashRow.size_bytes} vs ${onDisk.length}`);

console.log('\n=== DELETING THE WORKSPACE TAKES ITS FILES WITH IT ===');
// 048 made tenant deletion possible; a table added afterwards must not undo it.
await admin.query('DELETE FROM tenants WHERE id = $1', [B.tenantId]);
ok('a workspace with files can still be deleted', true);
await admin.query('DELETE FROM tenants WHERE id = $1', [A.tenantId]);
const leftovers = (await admin.query(
  `SELECT count(*)::int n FROM stored_files WHERE tenant_id = $1`, [A.tenantId])).rows[0].n;
ok('and its stored_files rows cascade away', leftovers === 0, String(leftovers));

await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
