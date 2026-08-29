import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderPage, apiClientStub, FULL_ACCESS_AUTH } from '../../test/renderPage';

/**
 * Panels that live inside a tab, rendered directly.
 *
 * The page suites mount a page and stop. A panel behind a tab is never reached
 * by that — Billing mounts on Receivables, Accounts on Ledger, Settings on
 * Profile — so six features shipped with a UI no test had ever rendered.
 *
 * These are components rather than routes, so they are mounted on their own.
 * Same two stubs as the page suites: an empty workspace, and rows carrying
 * nothing but an id.
 */

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

const PANELS: [string, () => Promise<{ default: React.ComponentType }>][] = [
  ['PrivacyPanel',        () => import('../../components/PrivacyPanel')],
  ['GstReturnsPanel',     () => import('../../components/GstReturnsPanel')],
  ['TallyExportPanel',    () => import('../../components/TallyExportPanel')],
  ['ChannelIntegrations', () => import('../../components/ChannelIntegrations')],
];

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  await new Promise(r => setTimeout(r, 0));
  errorSpy.mockRestore();
});

const thrown = () => errorSpy.mock.calls
  .map(c => c.map(String).join(' '))
  .filter(s => /Cannot read propert|is not a function|is not iterable|undefined is not/.test(s));

describe('every tabbed panel mounts on an empty workspace', () => {
  for (const [name, load] of PANELS) {
    it(`${name} renders without throwing`, async () => {
      vi.doMock('../../services/apiClient', () => apiClientStub());
      const { default: Panel } = await load();
      expect(() => renderPage(<Panel />)).not.toThrow();
      await new Promise(r => setTimeout(r, 0));
      expect(thrown(), `${name} threw during render:\n${thrown()[0] ?? ''}`).toHaveLength(0);
      vi.doUnmock('../../services/apiClient');
      vi.resetModules();
    });
  }
});

describe('every tabbed panel survives a holed payload', () => {
  for (const [name, load] of PANELS) {
    it(`${name} survives a holed payload`, async () => {
      // The shape that actually shipped: a response present but missing the
      // fields the component reads straight through.
      vi.doMock('../../services/apiClient', () => apiClientStub({}, 'holed'));
      const { default: Panel } = await load();
      expect(() => renderPage(<Panel />)).not.toThrow();
      await new Promise(r => setTimeout(r, 0));
      expect(thrown(), `${name} threw on a holed payload:\n${thrown()[0] ?? ''}`).toHaveLength(0);
      vi.doUnmock('../../services/apiClient');
      vi.resetModules();
    });
  }
});
