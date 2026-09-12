import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

/**
 * Mount a page the way the app does, with the network stubbed.
 *
 * WHAT THESE TESTS ARE FOR
 *
 * Not assertions about content — a page's copy changes weekly and a test that
 * pins it is a chore, not a safety net. These catch the one failure the pure
 * logic suites structurally cannot: a component that THROWS while rendering.
 *
 * Both of the worst client bugs found so far were exactly that. The partner
 * portal called `formatCurrency` on a field the payload never contained, threw
 * on `undefined.toLocaleString()`, and showed an error boundary behind a
 * successful login. Nothing in CI looked at a rendered component, so nothing
 * caught it.
 *
 * WHY THE STUB RETURNS EMPTY, NOT FIXTURES
 *
 * Empty is the harsher input. Every one of these pages will be opened on a
 * brand-new workspace with no leads, no bookings and no ledger, and "renders
 * fine once there is data" is not the property worth testing — `[]`, `null`
 * and absent optional fields are where components actually break.
 */

/** Sensible empty value for any api* function, by the shape of its name. */
export function emptyApiResult(name: string): unknown {
  if (/^apiGet|^apiList|^apiSearch/.test(name)) {
    // A getter whose name is plural returns a list; singular returns null.
    return /s$|List$|Entries$|Funnel$|Position$|Summary$/.test(name) ? [] : null;
  }
  return null;
}

/**
 * A row carrying only an id — every other field absent.
 *
 * This models the failure the empty case cannot. The partner portal did not
 * crash on an empty list; it crashed on a list WITH a row whose optional field
 * the payload happened to omit, which the page then formatted as currency. An
 * empty workspace never calls that code at all, so a test that only renders
 * empty lists reports success on exactly the bug that shipped — verified by
 * reintroducing it and watching the empty-case tests stay green.
 *
 * The id is real because keys and lookups need one; nothing else is, because
 * anything the component assumes beyond that is the assumption worth breaking.
 */
export function holedApiResult(name: string, i = 0): unknown {
  const empty = emptyApiResult(name);
  if (!Array.isArray(empty)) return empty;
  return [{ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }];
}

/**
 * A module stub covering the whole apiClient surface.
 *
 * Built as a Proxy rather than an enumerated list of mocks: apiClient has
 * hundreds of exports and grows every week, and a hand-maintained stub would
 * be out of date by the next feature — failing tests for a reason that has
 * nothing to do with the code under test.
 */
export function apiClientStub(
  overrides: Record<string, unknown> = {},
  mode: 'empty' | 'holed' = 'empty',
) {
  let n = 0;
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop in overrides) return overrides[prop];
      // Vitest and the module system probe these; they must not become fns.
      if (prop === '__esModule' || prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'isApiEnabled') return () => true;
      if (prop === 'getStoredApiSession') return () => null;
      if (prop === 'isMfaChallenge') return () => false;
      // Named type guards and constants fall through to a permissive function.
      return async (..._args: unknown[]) =>
        mode === 'holed' ? holedApiResult(prop, n++) : emptyApiResult(prop);
    },
    has() { return true; },
  });
}

/** Router + whatever providers a page needs, with no real network behind it. */
export function renderPage(ui: ReactElement, { route = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>,
  );
}

/** A workspace user who can see everything — so a page is exercised, not
 *  short-circuited into an Access-denied branch that renders three words. */
export const FULL_ACCESS_AUTH = {
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    name: 'Test Owner', email: 'owner@test.local', role: 'builder_admin',
    active: true, avatar: '', phone: '', password: '', createdAt: new Date().toISOString(),
  },
  tenant: {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Test Builders', company: 'Test Builders', currency: 'INR', country: 'India',
    plan: 'growth', status: 'active', logo: '', brandVoice: '', audience: '', channels: [],
    email: 'ops@test.local', phone: '', address: '', createdAt: new Date().toISOString(),
  },
  users: [],
  isAuthenticated: true,
  isLoading: false,
  hasPermission: () => true,
  login: async () => ({ success: true }),
  verifyLoginCode: async () => ({ success: true }),
  register: async () => ({ success: true }),
  resetPassword: () => ({ success: true }),
  changeOwnPassword: () => ({ success: true }),
  logout: () => {},
  logoutEverywhere: () => {},
  refreshSession: () => {},
};
