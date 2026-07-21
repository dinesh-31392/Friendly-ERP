// Build-time environment, injected by Vite. Self-contained typing (no
// vite/client reference needed) so tsc resolves it without the Vite package's
// ambient types.
interface ImportMetaEnv {
  /**
   * The backend base URL a production build points at (e.g. "" for same-origin
   * `/api`, or "https://app.example.com"). When set, the SPA runs in API mode by
   * default — the real Postgres-backed, server-authoritative deployment. When
   * unset, the app runs as the localStorage single-browser demo.
   *   VITE_API_URL=  npm run build     # same-origin /api (recommended behind nginx)
   */
  readonly VITE_API_URL?: string;
  /** Vite built-ins. DEV/PROD are booleans; MODE is the build mode name. */
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
