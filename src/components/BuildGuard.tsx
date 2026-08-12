import { isApiEnabled } from '../services/apiClient';

/**
 * Refuse to run a build that has no backend.
 *
 * `VITE_API_URL` is what decides whether this app talks to PostgreSQL or to
 * localStorage. Omit it and, until now, the app quietly became a browser-only
 * ERP: every tenant's data in the visitor's browser, permission checks in
 * client-side JavaScript, and a "Set up Friendly ERP" wizard that looked like a
 * legitimate first-run screen. Someone could deploy that to a public VPS and
 * onboard real customers onto it without ever seeing a warning.
 *
 * A misconfigured build must fail where it is obvious — at the first screen,
 * before a login form appears — not somewhere subtle after the data is in.
 */
export default function BuildGuard({ children }: { children: React.ReactNode }) {
  if (isApiEnabled()) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6">
      <div className="max-w-lg bg-white border border-red-200 rounded-2xl p-7 shadow-sm">
        <div className="h-11 w-11 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
          <span className="text-red-600 text-xl" aria-hidden="true">!</span>
        </div>
        <h1 className="text-xl font-bold text-zinc-900 mb-2">This build has no backend</h1>
        <p className="text-sm text-zinc-600 mb-4">
          It was compiled without <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">VITE_API_URL</code>,
          so it has no server to talk to. Running it would keep every record in
          this browser instead of the database — not something to point real
          customers at, so it stops here.
        </p>
        <p className="text-sm text-zinc-600 mb-2">Rebuild with the API enabled:</p>
        <pre className="bg-zinc-900 text-zinc-100 text-xs font-mono rounded-lg p-3 overflow-x-auto mb-4">
VITE_API_URL=/ npm run build
        </pre>
        <p className="text-xs text-zinc-500">
          On Windows put <code className="font-mono">VITE_API_URL=/</code> in
          {' '}<code className="font-mono">.env.local</code> instead — Git Bash rewrites a
          bare <code className="font-mono">/</code> into a filesystem path. Then redeploy{' '}
          <code className="font-mono">dist/</code> and restart the web container.
        </p>
      </div>
    </div>
  );
}
