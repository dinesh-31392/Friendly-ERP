import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Lock, Eye, EyeOff, ShieldCheck, ArrowRight, LogOut } from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * Blocking screen shown when an admin issued a temporary password
 * (user.mustChangePassword). The user cannot reach the app until they set a new
 * password of their own. This is what lets an admin grant access to any account
 * WITHOUT ever holding a standing, shareable password — the temp value works
 * exactly once.
 */
export default function ForcePasswordChange() {
  const { user, changeOwnPassword, logout } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (pw !== confirm) { toast.error('Passwords do not match'); return; }
    setLoading(true);
    const res = changeOwnPassword(pw);
    setLoading(false);
    if (!res.success) { toast.error(res.error || 'Could not set password'); return; }
    toast.success('Password updated — welcome in');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-7 shadow-sm">
          <div className="h-11 w-11 rounded-2xl bg-indigo-50 flex items-center justify-center mb-4">
            <ShieldCheck className="h-5 w-5 text-indigo-500" />
          </div>
          <h1 className="text-xl font-bold text-zinc-900">Set your password</h1>
          <p className="text-sm text-zinc-500 mt-1 mb-5">
            You signed in with a temporary password{user?.name ? `, ${user.name.split(' ')[0]}` : ''}.
            Choose your own to continue — only you will know it.
          </p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">New Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)}
                  placeholder="At least 8 characters" autoFocus
                  className="w-full pl-9 pr-10 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)}
                  placeholder="Re-enter new password"
                  className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
              </div>
            </div>
            <button
              type="submit" disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50"
            >
              {loading ? <span className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : <>Set password &amp; continue <ArrowRight className="h-4 w-4" /></>}
            </button>
          </form>
        </div>
        <button onClick={logout} className="mt-4 mx-auto flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-600">
          <LogOut className="h-3.5 w-3.5" /> Sign out instead
        </button>
      </div>
    </div>
  );
}
