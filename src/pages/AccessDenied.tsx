import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function AccessDenied() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-md text-center bg-white border border-zinc-200 rounded-3xl p-10 shadow-sm">
        <div className="h-16 w-16 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center mx-auto mb-5">
          <ShieldAlert className="h-8 w-8" />
        </div>
        <h2 className="text-2xl font-bold text-zinc-900 mb-2">Access denied</h2>
        <p className="text-sm text-zinc-500 mb-6">
          You do not have permission to access this module with your current role.
        </p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-semibold hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>
      </div>
    </div>
  );
}
