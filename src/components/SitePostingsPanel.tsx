import { useState, useEffect, useMemo } from 'react';
import { Loader2, Plus, X, MapPin, Globe2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isApiEnabled, apiGetPostings, apiCreatePosting, apiDeletePosting,
  apiGetProjects, type ApiPosting,
} from '../services/apiClient';
import type { Project } from '../types';

/**
 * Who covers which site.
 *
 * WHY THIS IS AN ADMIN SCREEN AND NOT AN HR ONE
 *
 * A posting decides what somebody can see. Putting it on the HR page would let
 * a site HR manager widen her own scope by posting herself to another site,
 * which is the one thing project scoping exists to prevent. So it lives with
 * the other "what may this person reach" controls, behind manage_users — the
 * same key that governs roles.
 *
 * THE RULE THIS SCREEN HAS TO TEACH
 *
 * No posting means COMPANY-WIDE, not blind. That is not what most people
 * assume from an empty list, and assuming the opposite is how an administrator
 * ends up thinking a manager is restricted when they are not. The screen says
 * it on every row that has no postings, rather than leaving a blank space to
 * be misread.
 *
 * A person holding manage_hr_all stays company-wide whatever is posted here.
 * That is deliberate — the HR head may be posted to a site for execution
 * reasons and must not be narrowed by it — and the screen has no way to know,
 * so it does not claim otherwise.
 */

interface Member { id: string; name: string; email: string; role: string; active: boolean }

interface Props {
  members: Member[];
  canManage: boolean;
}

export default function SitePostingsPanel({ members, canManage }: Props) {
  const [postings, setPostings] = useState<ApiPosting[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      apiGetPostings().catch(() => [] as ApiPosting[]),
      apiGetProjects().catch(() => [] as Project[]),
    ]).then(([p, pr]) => {
      if (cancelled) return;
      setPostings(Array.isArray(p) ? p : []);
      setProjects(Array.isArray(pr) ? pr : []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const byUser = useMemo(() => {
    const m = new Map<string, ApiPosting[]>();
    for (const p of postings) {
      const list = m.get(p.userId) ?? [];
      list.push(p);
      m.set(p.userId, list);
    }
    return m;
  }, [postings]);

  const post = async (userId: string, projectId: string) => {
    if (!projectId) return;
    setBusy(userId);
    try {
      await apiCreatePosting(userId, projectId);
      toast.success('Posted to site');
      setAdding(null);
      setRefreshKey(k => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not post them to that site');
    } finally {
      setBusy(null);
    }
  };

  const unpost = async (p: ApiPosting) => {
    setBusy(p.userId);
    try {
      await apiDeletePosting(p.userId, p.projectId);
      toast.success('Posting removed');
      setRefreshKey(k => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove that posting');
    } finally {
      setBusy(null);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="pt-5 border-t border-zinc-100">
        <h3 className="text-sm font-semibold text-zinc-900">Site Postings</h3>
        <p className="text-xs text-zinc-500 mt-1">Postings need the API — scope is enforced in the database.</p>
      </div>
    );
  }

  return (
    <div className="pt-5 border-t border-zinc-100">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <MapPin className="h-4 w-4 text-zinc-400" /> Site Postings
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-2xl">
            Which projects a person covers. An HR manager posted to a site sees that
            site&apos;s crew, attendance, leave and payroll — and no other.
          </p>
        </div>
      </div>

      <div className="bg-amber-50/50 border border-amber-200/50 rounded-xl px-4 py-2.5 my-3 flex items-start gap-2.5">
        <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-900">
          <strong>No posting means company-wide, not blind.</strong> Somebody with an
          empty list sees every project. Post them to a site to narrow them.
        </p>
      </div>

      {loading ? (
        <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 text-zinc-300 animate-spin" /></div>
      ) : (
        <div className="space-y-2">
          {members.filter(m => m.active).map(m => {
            const mine = byUser.get(m.id) ?? [];
            const unposted = projects.filter(p => !mine.some(x => x.projectId === p.id));
            return (
              <div key={m.id} className="flex items-start gap-3 p-3 rounded-xl border border-zinc-100 flex-wrap">
                <div className="min-w-[160px]">
                  <p className="text-sm font-medium text-zinc-900">{m.name}</p>
                  <p className="text-[11px] text-zinc-400 capitalize">{m.role.replace(/_/g, ' ')}</p>
                </div>
                <div className="flex-1 flex items-center gap-1.5 flex-wrap min-w-[220px]">
                  {mine.length === 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 bg-zinc-100 px-2.5 py-1 rounded-full">
                      <Globe2 className="h-3 w-3" /> Company-wide
                    </span>
                  ) : mine.map(p => (
                    <span key={p.projectId}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-700 bg-indigo-50 pl-2.5 pr-1 py-1 rounded-full">
                      {p.projectName}
                      {canManage && (
                        <button
                          onClick={() => unpost(p)} disabled={busy === m.id}
                          title={`Remove ${m.name} from ${p.projectName}`}
                          className="p-0.5 rounded-full hover:bg-indigo-100 disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {canManage && unposted.length > 0 && (
                  adding === m.id ? (
                    <select
                      autoFocus defaultValue="" disabled={busy === m.id}
                      onChange={ev => post(m.id, ev.target.value)}
                      onBlur={() => setAdding(null)}
                      className="px-2.5 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs"
                      aria-label={`Post ${m.name} to a site`}
                    >
                      <option value="">Choose a site…</option>
                      {unposted.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  ) : (
                    <button
                      onClick={() => setAdding(m.id)} disabled={busy === m.id}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500 hover:text-indigo-600 px-2 py-1 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" /> Post to site
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
