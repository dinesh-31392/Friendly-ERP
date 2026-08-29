import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No screen writes a server-backed table straight to localStorage.
 *
 * `leadWrites.ts` opens by explaining why it exists: the SPA had ~15 direct
 * `create/update/remove('leads', …)` call sites, and in API mode a write that
 * only touched localStorage was "worse than useless — the next apiGetLeads()
 * refetch overwrote it, so edits silently reverted".
 *
 * That reasoning was written down and then broken three more times, because
 * nothing enforced it:
 *
 *   Settings   the entire team screen. Inviting a member wrote a localStorage
 *              row and said "Team member added" while the server had never
 *              heard of them, so they could not sign in. Worse, Deactivate
 *              reported success and left the account working — the opposite of
 *              what an admin revoking access believes they just did.
 *   Dashboard  "reassign at-risk lead" reverted at the next refetch.
 *   AIStudio   a saved AI draft vanished at the next campaigns refetch.
 *
 * None of it was visible in a test, because every one of those writes SUCCEEDS
 * — against the wrong store. The bug only appears on the next fetch.
 *
 * So this is a static check rather than a behavioural one. A file that writes
 * one of these tables must either route through the matching `*Writes` module
 * or branch on `isApiEnabled()` itself. Both are legitimate; doing neither is
 * the bug.
 */

const UI_DIRS = ['src/pages', 'src/components'];

/**
 * Tables the server owns. Writing one of these locally in API mode is the bug.
 * `tenants` and `portalUsers` are deliberately absent — the platform-admin and
 * portal surfaces manage them through their own API calls, checked separately.
 */
const SERVER_BACKED = [
  'users', 'leads', 'invoices', 'bookings', 'commissions', 'brokers',
  'branches', 'tickets', 'paymentPlans', 'raBills', 'activities', 'campaigns',
];

const WRITE = new RegExp(
  String.raw`\b(?:create|update|remove)\s*(?:<[^>]*>)?\s*\(\s*'(${SERVER_BACKED.join('|')})'`,
  'g',
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    // Test files may construct fixtures however they like.
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('server-backed tables are never written straight to localStorage', () => {
  const files = UI_DIRS.flatMap(walk);

  it('finds the UI files to check', () => {
    // A broken glob would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(20);
  });

  it('every direct write is either routed or mode-guarded', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const tables = [...src.matchAll(WRITE)].map(m => m[1]);
      if (!tables.length) continue;

      // Routed through a *Writes module, or branching on the mode itself.
      const routed = /from '[^']*Writes'/.test(src);
      const guarded = /isApiEnabled/.test(src);
      if (routed || guarded) continue;

      offenders.push(`${file.replace(/\\/g, '/')} writes [${[...new Set(tables)].join(', ')}]`);
    }

    expect(
      offenders,
      'These write a server-backed table with no API path and no mode branch, so\n' +
      'in API mode the write lands in localStorage and disappears at the next\n' +
      'refetch — after the UI has already reported success. Route them through\n' +
      'the matching src/services/*Writes.ts module.\n\n' +
      offenders.join('\n'),
    ).toEqual([]);
  });
});
