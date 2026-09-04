import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderPage, apiClientStub, FULL_ACCESS_AUTH } from '../../test/renderPage';

/**
 * Every page mounts on an EMPTY workspace without throwing.
 *
 * This is the class of bug that has cost the most and been caught the latest:
 * a component that renders fine with data and throws without it, behind a
 * successful login, showing an error boundary where the product should be.
 * Twenty-two API suites could not see it, because the failure is in the render.
 *
 * The assertion is deliberately weak — "did not throw" — because that is the
 * property worth protecting. Pinning copy would make this a maintenance chore
 * and would not have caught either of the real bugs.
 */

vi.mock('../../services/apiClient', () => apiClientStub());

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => FULL_ACCESS_AUTH,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Toasts reach for DOM APIs jsdom does not fully implement, and a page's
// correctness never depends on one appearing.
vi.mock('react-hot-toast', () => {
  const t = Object.assign(
    () => {},
    { success: () => {}, error: () => {}, loading: () => {}, dismiss: () => {}, custom: () => {} },
  );
  return { default: t, toast: t, Toaster: () => null };
});

const PAGES: [name: string, load: () => Promise<{ default: React.ComponentType }>][] = [
  ['Dashboard',        () => import('../Dashboard')],
  ['Leads',            () => import('../Leads')],
  ['SiteVisits',       () => import('../SiteVisits')],
  ['Bookings',         () => import('../Bookings')],
  ['CostSheets',       () => import('../CostSheets')],
  ['Customers',        () => import('../Customers')],
  ['Possession',       () => import('../Possession')],
  ['Inventory',        () => import('../Inventory')],
  ['Projects',         () => import('../Projects')],
  ['Billing',          () => import('../Billing')],
  ['Accounts',         () => import('../Accounts')],
  ['HR',               () => import('../HR')],
  ['Execution',        () => import('../Execution')],
  ['Procurement',      () => import('../Procurement')],
  ['Land',             () => import('../Land')],
  ['BD',               () => import('../BD')],
  ['Calendar',         () => import('../Calendar')],
  ['Documents',        () => import('../Documents')],
  ['Settings',         () => import('../Settings')],
  ['Reports',          () => import('../Reports')],
  ['Service',          () => import('../Service')],
  ['Brokers',          () => import('../Brokers')],
  ['Leasing',          () => import('../Leasing')],
  ['SalesPerformance', () => import('../SalesPerformance')],
  ['Campaigns',        () => import('../Campaigns')],
];

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  // React reports a render throw through console.error before the boundary
  // catches it, so this both silences the noise and gives us the evidence.
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

describe('every page mounts on an empty workspace', () => {
  for (const [name, load] of PAGES) {
    it(`${name} renders without throwing`, async () => {
      const { default: Page } = await load();
      expect(() => renderPage(<Page />)).not.toThrow();
      // Effects fire after mount; the crash we are hunting usually happens in the

      // re-render that follows a resolved fetch, not in the first paint.

      await new Promise(r => setTimeout(r, 0));

      // A render that threw and was swallowed by an error boundary still shows
      // up here — which is exactly how the portal crash presented.
      const thrown = errorSpy.mock.calls
        .map(c => c.map(String).join(' '))
        .filter(s => /Cannot read propert|is not a function|is not defined|undefined is not/.test(s));
      expect(thrown, `${name} threw during render:\n${thrown[0] ?? ''}`).toHaveLength(0);
    });
  }
});
