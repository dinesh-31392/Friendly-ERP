import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * "We could not load this" — which is not the same as "there is nothing here".
 *
 * WHY THIS EXISTS
 *
 * Panels in this app fetch on mount and, on failure, fall back to an empty
 * array. The component then renders its empty state, and the empty state is
 * frequently a CLAIM:
 *
 *   Site Postings   every member shown as "Company-wide" — an administrator
 *                   reads that as "nobody is restricted" and is wrong.
 *   Advances        "No advances recorded" — somebody pays a full salary to a
 *                   worker who has drawn against it.
 *   Permissions     "No roles to show" on the screen used to decide whether a
 *                   role is safe to hand a new colleague.
 *
 * None of those are alarming on screen. All of them are a network failure
 * dressed up as a fact, which is the same defect as a withheld payroll
 * totalling to zero: the reader cannot tell a real answer from a missing one,
 * so they act on the wrong one.
 *
 * The rule this encodes: a component may only render an empty state once it
 * has actually LOADED and found nothing. Until then it says so.
 */
export default function LoadFailed({
  what,
  onRetry,
}: {
  /** What could not be loaded, as a person would say it: "the site postings". */
  what: string;
  onRetry?: () => void;
}) {
  return (
    <div className="py-10 px-6 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500/70 mx-auto mb-2" />
      <p className="text-sm font-medium text-zinc-700">Could not load {what}</p>
      <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">
        This is a loading problem, not an empty list — nothing here has been
        changed or lost.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 text-zinc-700 rounded-lg text-xs font-semibold hover:bg-zinc-200"
        >
          <RefreshCw className="h-3 w-3" /> Try again
        </button>
      )}
    </div>
  );
}
