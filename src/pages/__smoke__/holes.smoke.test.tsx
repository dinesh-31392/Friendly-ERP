import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderPage, apiClientStub, FULL_ACCESS_AUTH } from '../../test/renderPage';

/**
 * Every page mounts when the API returns rows with FIELDS MISSING.
 *
 * This is the case the empty-workspace suite cannot reach, and the one that
 * actually shipped. The partner portal did not break on an empty list — it
 * broke on a list containing a row whose optional field the payload omitted,
 * which the page then handed to a currency formatter.
 *
 * Verified as a real gap rather than assumed: reintroducing that exact bug
 * left the empty-workspace tests green, because with no rows the formatter is
 * never called. These stubs return one row per list carrying nothing but an
 * id, so every optional field a component reads is absent.
 *
 * A page that survives this survives a backend that changed shape, a partial
 * migration, or an older row written before a column existed — all of which
 * happen, and none of which are caught by a fixture built to be complete.
 */

vi.mock('../../services/apiClient', () => apiClientStub({}, 'holed'));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => FULL_ACCESS_AUTH,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('react-hot-toast', () => {
  const t = Object.assign(
    () => {},
    { success: () => {}, error: () => {}, loading: () => {}, dismiss: () => {}, custom: () => {} },
  );
  return { default: t, toast: t, Toaster: () => null };
});

const PAGES: [string, () => Promise<{ default: React.ComponentType }>][] = [
  ['Dashboard',   () => import('../Dashboard')],
  ['Leads',       () => import('../Leads')],
  ['SiteVisits',  () => import('../SiteVisits')],
  ['Bookings',    () => import('../Bookings')],
  ['CostSheets',  () => import('../CostSheets')],
  ['Billing',     () => import('../Billing')],
  ['Accounts',    () => import('../Accounts')],
  ['HR',          () => import('../HR')],
  ['Inventory',   () => import('../Inventory')],
  ['Leasing',     () => import('../Leasing')],
  ['Land',        () => import('../Land')],
  ['BD',          () => import('../BD')],
  ['Calendar',    () => import('../Calendar')],
  ['Brokers',     () => import('../Brokers')],
];

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  // Unmount before restoring the spy. A page's effects keep resolving after
  // the test body returns, and without this their errors land in the NEXT
  // page's assertion — which made SiteVisits fail in sequence and pass alone.
  cleanup();
  await new Promise(r => setTimeout(r, 0));
  errorSpy.mockRestore();
});

describe('every page mounts when fields are missing from the payload', () => {
  for (const [name, load] of PAGES) {
    it(`${name} survives a holed payload`, async () => {
      const { default: Page } = await load();
      expect(() => renderPage(<Page />)).not.toThrow();
      // Effects fire after mount; the crash we are hunting usually happens in the

      // re-render that follows a resolved fetch, not in the first paint.

      await new Promise(r => setTimeout(r, 0));

      // React logs a render throw before the boundary swallows it, which is
      // exactly how the portal crash presented to a user: a successful login
      // and then an error card where the product should be.
      const thrown = errorSpy.mock.calls
        .map(c => c.map(String).join(' '))
        .filter(s => /Cannot read propert|is not a function|is not iterable|undefined is not/.test(s));
      expect(thrown, `${name} threw on a holed payload:\n${thrown[0] ?? ''}`).toHaveLength(0);
    });
  }
});
