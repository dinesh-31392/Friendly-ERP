import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, waitFor } from '@testing-library/react';
import { renderPage, apiClientStub, FULL_ACCESS_AUTH } from '../../test/renderPage';

/**
 * The Add Lead form must offer the workspace's real projects.
 *
 * THE BUG THIS PINS
 *
 * `tenantProjects` was read from the local store — getByTenant('projects', …) —
 * and nothing in API mode has ever written a projects collection there. A check
 * of a live workspace's browser storage found landLeads, bdLeads, accounts and
 * journalEntries, and no projects key at all. So the list was permanently empty,
 * not intermittently: every user, every workspace, every load.
 *
 * The Project select falls back to a single "General Enquiry" option when the
 * list is empty, and the submit handler falls back to the same string. So every
 * lead created through the UI was filed under "General Enquiry" — in a product
 * where the entire pipeline, and every per-project report, keys off that field.
 * Confirmed end to end: a lead created through the form landed in Postgres with
 * project = 'General Enquiry' while the workspace had two real projects; after
 * the fix the same journey wrote 'Acme Riverfront'.
 *
 * A second dependant made it worse than cosmetic. The executive lead filter
 * matches a rep's assigned projects by NAME against this list, so with the list
 * empty a rep scoped to a site saw only the leads assigned to them personally,
 * never the rest of their site's.
 *
 * WHY A UNIT TEST AND NOT AN API SUITE
 *
 * /api/projects was answering correctly the whole time — it returned both
 * projects to this very user. Nothing at the HTTP layer was wrong, so no
 * server-side suite could have seen it. The defect lived entirely in which
 * source the component read.
 */

const PROJECTS = [
  { id: 'p1', name: 'Acme Riverfront' },
  { id: 'p2', name: 'Acme Skyline' },
];

vi.mock('../../services/apiClient', () => apiClientStub({
  apiGetProjects: async () => PROJECTS,
  apiGetLeads: async () => [],
}));

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

afterEach(cleanup);

describe('the Add Lead form knows the workspace’s projects', () => {
  it('offers every project the server returns, not the General Enquiry fallback', async () => {
    const { default: Leads } = await import('../Leads');
    const { container } = renderPage(<Leads />);

    // Open the modal the way the page does.
    const addButton = await waitFor(() => {
      const b = [...container.querySelectorAll('button')]
        .find(el => el.textContent?.trim() === 'Add Lead');
      if (!b) throw new Error('Add Lead button never rendered');
      return b as HTMLButtonElement;
    });
    addButton.click();

    const options = await waitFor(() => {
      const select = container.querySelector('select[name="project"]') as HTMLSelectElement | null;
      if (!select) throw new Error('the Add Lead modal did not open');
      const opts = [...select.options].map(o => o.text);
      // Before the fix this was exactly ['General Enquiry'] — the empty-list
      // fallback — no matter what the server held.
      if (opts.length < 2) throw new Error(`still on the fallback: ${JSON.stringify(opts)}`);
      return opts;
    });

    expect(options).toContain('Acme Riverfront');
    expect(options).toContain('Acme Skyline');
    expect(options).not.toContain('General Enquiry');
  });
});
