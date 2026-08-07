/**
 * Document mutations — the single place that decides whether a write goes to the
 * Fastify/PostgreSQL backend or the localStorage demo store. Mirrors
 * leadWrites.ts / projectWrites.ts. The register is a leaf entity (create +
 * delete only), so there is no patch dispatcher.
 */
import type { Document } from '../types';
import { create, remove } from './db';
import { isApiEnabled, apiCreateDocument, apiDeleteDocument } from './apiClient';

/** Register a document. Returns the stored record (server-assigned id in API mode). */
export async function createDocument(input: Partial<Document> & { tenantId: string }): Promise<Document> {
  if (isApiEnabled()) return apiCreateDocument(input);
  return create<Document>('documents', { id: '', ...input } as Document);
}

/** Delete a document. */
export async function deleteDocument(id: string): Promise<void> {
  if (isApiEnabled()) {
    await apiDeleteDocument(id);
    return;
  }
  remove('documents', id);
}
