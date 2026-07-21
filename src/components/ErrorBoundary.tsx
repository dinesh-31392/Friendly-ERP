import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, LayoutDashboard } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional label so the fallback can say which area failed. */
  area?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in its subtree and shows a friendly, fully
 * responsive fallback instead of unmounting the whole app to a blank screen.
 *
 * Why this matters here: the CRM had NO error boundary, so a single throwing
 * component (e.g. a badge that looked up an unknown status) tore down the entire
 * React tree — sidebar included — leaving a white page on phone, tablet and
 * desktop alike. The worst possible "responsive" outcome. Wrapped around the
 * routed page content (keyed by pathname so navigating away clears the error)
 * the shell survives and the user can recover.
 *
 * Class component because React exposes error boundaries only through
 * getDerivedStateFromError / componentDidCatch — there is no hook equivalent.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for debugging; a real deployment would forward this to an
    // error-reporting service here.
    console.error('[ErrorBoundary] caught:', error, info.componentStack);
  }

  private handleReload = () => window.location.reload();
  private handleHome = () => { window.location.href = '/'; };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-[60vh] w-full flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center bg-white border border-zinc-200 rounded-2xl shadow-sm p-6 sm:p-8">
          <div className="mx-auto h-12 w-12 rounded-2xl bg-amber-50 flex items-center justify-center mb-4">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold text-zinc-900">Something went wrong</h2>
          <p className="text-sm text-zinc-500 mt-1.5 leading-relaxed">
            {this.props.area ? `The ${this.props.area} ran into an unexpected error.` : 'This page ran into an unexpected error.'}{' '}
            Your data is safe — try reloading, or head back to the dashboard.
          </p>

          {import.meta.env.DEV && this.state.error && (
            <pre className="mt-4 text-left text-[11px] leading-relaxed text-red-600 bg-red-50 border border-red-100 rounded-lg p-3 overflow-x-auto max-h-40">
              {this.state.error.message}
            </pre>
          )}

          <div className="mt-6 flex flex-col sm:flex-row gap-2 sm:justify-center">
            <button
              onClick={this.handleReload}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4" /> Reload page
            </button>
            <button
              onClick={this.handleHome}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-100 text-zinc-700 text-sm font-semibold hover:bg-zinc-200 transition-colors"
            >
              <LayoutDashboard className="h-4 w-4" /> Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
