import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderPage, apiClientStub, FULL_ACCESS_AUTH } from '../../test/renderPage';

/**
 * The dashboard must still fetch when permission arrives AFTER the first render.
 *
 * THE BUG THIS PINS
 *
 * Found by signing in as a builder admin on a cold start and reading the first
 * screen: "0 Available Units", "0 Active Projects", "0 Land Parcels" — on a
 * workspace holding 46 units and 2 projects. Navigating to /projects and back
 * filled every tile in, so nothing was broken server-side; the API returned all
 * of it to that same user.
 *
 * The cause was a dependency array. The effect that loads leads, tasks, units
 * and projects reads hasPermission(...) for each, and hasPermission returns
 * FALSE while `user` is still null — which it is for the first renders after
 * login, while the session hydrates. The effect was keyed on [tenantId,
 * refreshKey] with an exhaustive-deps suppression, so once it had run with every
 * gate false there was nothing left to re-trigger it: tenantId does not change a
 * second time, and refreshKey only moves when the user hits refresh. The
 * dashboard then sat on zeros for the rest of the session.
 *
 * WHY IT HID
 *
 * It is a race, so it reproduces on a cold load and not on a warm one — and a
 * reload always looked fine, because by then the session was already in storage
 * and `user` was populated on the first render. Every API suite passed
 * throughout: the server was answering correctly the whole time.
 *
 * WHY THE ASSERTION IS ABOUT FETCHES, NOT TILES
 *
 * Pinning the rendered numbers would mean fixing the stub's shape to whatever
 * the tiles currently compute, and would break on any copy or layout change.
 * "Did the page ask the server for its data once it was allowed to?" is the
 * property that was actually violated.
 */

const apiGetUnits = vi.fn(async () => []);
const apiGetProjects = vi.fn(async () => []);
const apiGetLeads = vi.fn(async () => []);

vi.mock('../../services/apiClient', () => apiClientStub({
  apiGetUnits, apiGetProjects, apiGetLeads,
}));

// Mutable, so a test can model the session hydrating between renders. `user`
// is nullable here because that is precisely the state under test: signed in
// far enough to know the tenant, not yet far enough to know who you are.
type AuthShape = Omit<typeof FULL_ACCESS_AUTH, 'user'> & { user: typeof FULL_ACCESS_AUTH.user | null };
let auth: AuthShape = { ...FULL_ACCESS_AUTH };
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => auth,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('react-hot-toast', () => {
  const t = Object.assign(
    () => {},
    { success: () => {}, error: () => {}, loading: () => {}, dismiss: () => {}, custom: () => {} },
  );
  return { default: t, toast: t, Toaster: () => null };
});

beforeEach(() => {
  auth = { ...FULL_ACCESS_AUTH };
  apiGetUnits.mockClear();
  apiGetProjects.mockClear();
  apiGetLeads.mockClear();
});
afterEach(cleanup);

describe('the dashboard loads its data once it is permitted to', () => {
  it('fetches units and projects when permission is available from the start', async () => {
    const { default: Dashboard } = await import('../Dashboard');
    renderPage(<Dashboard />);
    // The positive control. Without it, a dashboard that fetches NOTHING would
    // satisfy the regression test below by never being wrong twice.
    await waitFor(() => {
      expect(apiGetUnits).toHaveBeenCalled();
      expect(apiGetProjects).toHaveBeenCalled();
    });
  });

  it('still fetches when permission only becomes true after the first render', async () => {
    // The cold login: tenant is known, the user is not yet, so every gate reads
    // false on the first pass.
    auth = { ...FULL_ACCESS_AUTH, user: null, hasPermission: () => false };

    const { default: Dashboard } = await import('../Dashboard');
    const { rerender } = renderPage(<Dashboard />);
    expect(apiGetUnits).not.toHaveBeenCalled();   // nothing to fetch yet — correct

    // The session lands. Every gate now answers true.
    //
    // Re-rendered inside the SAME router: RTL's rerender replaces the whole
    // tree with what it is handed, so dropping renderPage's MemoryRouter here
    // strips the context the page's <Link>s need and the test fails on that
    // instead of on the thing it is measuring.
    auth = { ...FULL_ACCESS_AUTH };
    rerender(<MemoryRouter><Dashboard /></MemoryRouter>);

    // Before the fix this stayed at zero calls forever: the effect's deps were
    // [tenantId, refreshKey], neither of which changed, so it never ran again
    // and the tiles kept reporting a workspace with nothing in it.
    await waitFor(() => {
      expect(apiGetUnits).toHaveBeenCalled();
      expect(apiGetProjects).toHaveBeenCalled();
      expect(apiGetLeads).toHaveBeenCalled();
    });
  });
});
