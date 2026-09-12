import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Where uploaded bytes live.
 *
 * A local directory rather than an object store, because that is what this
 * product actually deploys onto: one Node process behind nginx with Postgres
 * beside it (see deploy/). Point FILE_STORAGE_DIR at a mounted volume and the
 * files outlive the container. The interface below is the only thing the routes
 * know about, so swapping in S3 later is a new implementation of four
 * functions, not a change to every caller.
 */
const ROOT = path.resolve(process.env.FILE_STORAGE_DIR ?? path.join(process.cwd(), 'var', 'uploads'));

/** Per-file ceiling. Multipart enforces it while streaming, so an oversized
 *  upload is cut off mid-flight rather than buffered and then rejected. */
export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;

/**
 * Types a browser may render inline. Everything else is served as an
 * octet-stream attachment.
 *
 * The list is short on purpose. An uploaded .html or .svg served inline from
 * the app's own origin is stored XSS with a session cookie attached — the
 * classic way a file feature becomes an account-takeover feature. SVG is
 * absent for exactly that reason: it is an image to a user and a script host to
 * a browser.
 */
const INLINE_SAFE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

/**
 * What the download route puts in Content-Type.
 *
 * The stored value is whatever the uploader's browser claimed, which is a hint,
 * not a fact — a .html file uploaded as image/png would be sniffed and executed
 * by some clients. Anything not on the inline list degrades to octet-stream, so
 * an unexpected type is a download, never a page.
 */
export function safeContentType(declared: string): string {
  return INLINE_SAFE.has(declared) ? declared : 'application/octet-stream';
}

/** Header that stops the file being interpreted as something other than what
 *  we labelled it. Paired with the type above, not a substitute for it. */
export const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' } as const;

/**
 * A filename safe to put in a header.
 *
 * `original_name` came from the uploader and may contain CR/LF — which would
 * end the Content-Disposition header and start an attacker-chosen one. Quotes
 * and backslashes would break out of the quoted-string. RFC 5987's `filename*`
 * carries the real UTF-8 name for clients that understand it; the plain
 * `filename` is the ASCII fallback.
 */
export function contentDisposition(name: string, inline: boolean): string {
  const clean = (name || 'download').replace(/[\r\n"\\]/g, '_').slice(0, 200);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/**
 * The path a new file gets, and the only place a storage key is minted.
 *
 * Every segment is server-generated. The uploader's filename contributes
 * nothing: it is kept in the database for display and never joined to a path,
 * because `../../.env` is a perfectly valid thing for a client to send as a
 * filename and a single `path.join` away from reading the secret.
 *
 * Fanned out by tenant and month so no directory grows without bound — ext4
 * and NTFS both degrade badly past a few hundred thousand entries in one
 * directory, and a busy workspace reaches that in a year of site photos.
 */
function newStorageKey(tenantId: string, isoMonth: string): string {
  return `${tenantId}/${isoMonth}/${randomUUID()}`;
}

/**
 * Resolve a stored key to an absolute path, refusing anything outside ROOT.
 *
 * Keys are server-generated, so this should be unreachable — which is why it
 * is here. It is the check that turns a future bug (a key built from user
 * input, a migration that imports legacy paths) from a filesystem read
 * primitive into a 404.
 */
export function resolveKey(key: string): string {
  const full = path.resolve(ROOT, key);
  const root = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!full.startsWith(root)) throw new Error('storage key escapes the storage root');
  return full;
}

export interface SavedFile {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Stream a file to disk, hashing as it goes.
 *
 * Streamed rather than buffered because a 25 MB upload per concurrent request
 * is memory the process does not have to spend, and because the size limit can
 * then be enforced by the transport instead of after the fact.
 *
 * The hash is computed from the bytes actually written, not from anything the
 * client said about them.
 */
export async function saveStream(
  tenantId: string,
  source: Readable,
  isoMonth: string,
): Promise<SavedFile> {
  const key = newStorageKey(tenantId, isoMonth);
  const dest = resolveKey(key);
  await mkdir(path.dirname(dest), { recursive: true });

  const hash = createHash('sha256');
  let size = 0;
  source.on('data', (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });

  try {
    await pipeline(source, createWriteStream(dest, { flags: 'wx' }));
  } catch (err) {
    // A half-written file with no row pointing at it is invisible garbage that
    // still consumes the disk. Clean up before the error propagates.
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  }

  return { storageKey: key, sizeBytes: size, sha256: hash.digest('hex') };
}

/** Remove the bytes. Missing is success: the caller's goal is that the file is
 *  gone, and a delete that fails because it already succeeded is noise. */
export async function deleteKey(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true }).catch(() => {});
}

/** Whether the bytes are still there. A row whose file vanished (a restored
 *  database pointed at an empty volume) should 404, not stream an error. */
export async function keyExists(key: string): Promise<boolean> {
  try { return (await stat(resolveKey(key))).isFile(); } catch { return false; }
}

export const STORAGE_ROOT = ROOT;
