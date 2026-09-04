import { useState, useEffect } from 'react';
import {
  ShieldCheck, Loader2, AlertTriangle, Trash2, Eye, CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import {
  isApiEnabled, apiGetRetentionPolicies, apiSetRetentionDays, apiRetentionSweep,
  apiGetErasureRequests, apiGetErasureRequest, apiCreateErasureRequest,
  apiPreviewErasure, apiVerifyErasure, apiExecuteErasure, apiRefuseErasure,
} from '../services/apiClient';
import type {
  ApiRetentionPolicy, ApiErasureRequest, ApiErasurePreview,
} from '../services/apiClient';
import toast from 'react-hot-toast';

/**
 * Retention and erasure, under the DPDP Act.
 *
 * The screen makes one distinction visible, because it is the one people get
 * wrong: erasure is not "delete everything", and it is not "refuse because we
 * keep financial records". It is per record — erase, redact, or retain with a
 * stated reason — and the preview shows exactly which before anything is done.
 */

const ACTION_STYLE: Record<string, string> = {
  erased: 'bg-red-50 text-red-600',
  redacted: 'bg-amber-50 text-amber-700',
  retained: 'bg-emerald-50 text-emerald-700',
};

const STATUS_STYLE: Record<string, string> = {
  received: 'bg-zinc-100 text-zinc-600',
  verified: 'bg-blue-50 text-blue-700',
  completed: 'bg-emerald-50 text-emerald-700',
  refused: 'bg-red-50 text-red-600',
};

export default function PrivacyPanel() {
  const [policies, setPolicies] = useState<ApiRetentionPolicy[]>([]);
  const [requests, setRequests] = useState<ApiErasureRequest[]>([]);
  const [expired, setExpired] = useState<Array<{ entity: string; retainDays: number; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const [open, setOpen] = useState<ApiErasureRequest | null>(null);
  const [preview, setPreview] = useState<ApiErasurePreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      apiGetRetentionPolicies().catch(() => [] as ApiRetentionPolicy[]),
      apiGetErasureRequests().catch(() => [] as ApiErasureRequest[]),
      apiRetentionSweep().catch(() => []),
    ]).then(([p, r, e]) => {
      if (cancelled) return;
      // A response that is present but not an array is the shape a partial
      // payload actually has, and `.map` on it blanks the whole tab.
      setPolicies(Array.isArray(p) ? p : []);
      setRequests(Array.isArray(r) ? r : []);
      setExpired(Array.isArray(e) ? e : []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const saveDays = async (p: ApiRetentionPolicy, raw: string) => {
    const next = raw.trim() === '' ? null : Number(raw);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return;
    if (next === p.retainDays) return;
    try {
      await apiSetRetentionDays(p.id, next);
      toast.success(`${p.entity} retention updated`);
      refresh();
    } catch (e) {
      // A statutory floor cannot be lowered. The server says which obligation
      // set it, and that is the useful half of the message.
      toast.error(e instanceof Error ? e.message : 'Could not update the policy');
      refresh();
    }
  };

  const create = async () => {
    if (!email.trim() && !phone.trim()) {
      toast.error('An email or a phone number is needed to identify the subject');
      return;
    }
    setCreating(true);
    try {
      await apiCreateErasureRequest({
        subjectEmail: email.trim() || undefined,
        subjectPhone: phone.trim() || undefined,
        subjectName: name.trim() || undefined,
      });
      setEmail(''); setPhone(''); setName('');
      toast.success('Request logged');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not log the request');
    } finally {
      setCreating(false);
    }
  };

  const openRequest = async (id: string) => {
    setPreview(null);
    try {
      const [full, prev] = await Promise.all([
        apiGetErasureRequest(id),
        // Available before verification on purpose: the reply to the subject is
        // written from this, and it has to be answerable before anything is done.
        apiPreviewErasure(id).catch(() => null),
      ]);
      setOpen(full);
      setPreview(prev);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the request');
    }
  };

  const act = async (fn: () => Promise<ApiErasureRequest>, done: string) => {
    setBusy(true);
    try {
      const updated = await fn();
      setOpen(updated);
      toast.success(done);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <AlertTriangle className="h-9 w-9 text-amber-400 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Retention and erasure need the API</p>
        <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">
          The decision is made per record against live data, so there is no local-only version.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 flex justify-center">
        <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Retention ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-indigo-500" /> How long things are kept
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            A period marked statutory can be extended but never shortened — the floor is set by law,
            not by this workspace. Leave a field blank to keep indefinitely.
          </p>
        </div>
        <div className="divide-y divide-zinc-50">
          {policies.map(p => (
            <div key={p.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <p className="text-sm font-medium text-zinc-900 capitalize">
                  {(p.entity ?? 'unknown').replace(/_/g, ' ')}
                  {p.statutory && (
                    <span className="ml-2 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                      statutory
                    </span>
                  )}
                </p>
                {p.legalBasis
                  ? <p className="text-[11px] text-zinc-400 mt-0.5">{p.legalBasis}</p>
                  : <p className="text-[11px] text-zinc-400 mt-0.5">
                      Held for business convenience — no statutory basis, so it is erasable on request.
                    </p>}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0} defaultValue={p.retainDays ?? ''}
                  onBlur={e => saveDays(p, e.target.value)}
                  placeholder="forever"
                  className="w-28 px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-right tabular-nums"
                />
                <span className="text-xs text-zinc-400">days</span>
              </div>
            </div>
          ))}
        </div>
        {expired.length > 0 && (
          <div className="px-5 py-3 border-t border-zinc-100 bg-amber-50/40">
            <p className="text-xs font-medium text-amber-800">Past their retention period</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              {expired.map(e => `${e.count} ${(e.entity ?? 'unknown').replace(/_/g, ' ')}`).join(' · ')}.
              {' '}Statutory records are never offered here.
            </p>
          </div>
        )}
      </div>

      {/* ── Erasure requests ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900">Erasure requests</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Log a request from a Data Principal, see exactly what would be removed and what must be
            kept, then carry it out. Nothing is destroyed before the identity is verified.
          </p>
        </div>

        <div className="px-5 py-3 border-b border-zinc-100 flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="them@example.com"
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" />
          </div>
          <div className="w-40">
            <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Phone</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91…"
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" />
          </div>
          <div className="w-40">
            <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Optional"
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" />
          </div>
          <button onClick={create} disabled={creating}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}Log request
          </button>
        </div>

        {requests.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-400">No erasure requests</div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {requests.map(r => (
              <div key={r.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <button onClick={() => openRequest(r.id)}
                    className="text-sm font-medium text-zinc-900 hover:text-indigo-600 hover:underline text-left">
                    {r.subjectName || r.subjectEmail || r.subjectPhone}
                  </button>
                  <p className="text-[11px] text-zinc-400">
                    received {String(r.receivedOn).slice(0, 10)}
                    {r.completedAt && ` · completed ${String(r.completedAt).slice(0, 10)}`}
                  </p>
                </div>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${STATUS_STYLE[r.status] ?? ''}`}>
                  {r.status}
                </span>
                <button onClick={() => openRequest(r.id)}
                  className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50">
                  <Eye className="h-3 w-3" /> Review
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Review drawer ─────────────────────────────────────────────────── */}
      {open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-end" onClick={() => setOpen(null)}>
          <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">
                  {open.subjectName || open.subjectEmail || open.subjectPhone}
                </h3>
                <p className="text-sm text-zinc-500">
                  {[open.subjectEmail, open.subjectPhone].filter(Boolean).join(' · ')}
                </p>
              </div>
              <button onClick={() => setOpen(null)} className="p-1.5 rounded-lg hover:bg-zinc-100">
                <XCircle className="h-4 w-4 text-zinc-500" />
              </button>
            </div>
            <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize mb-4 ${STATUS_STYLE[open.status] ?? ''}`}>
              {open.status}
            </span>

            {/* Before: the plan. After: what was actually done. */}
            {open.status === 'completed' ? (
              <>
                <p className="text-[11px] font-semibold text-zinc-500 uppercase mb-2">What was done</p>
                <div className="space-y-2">
                  {(open.actions ?? []).map(a => (
                    <div key={a.id} className="rounded-xl border border-zinc-200 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-zinc-900 capitalize">
                          {(a.entity ?? 'unknown').replace(/_/g, ' ')}
                          <span className="text-zinc-400"> · {a.recordCount} record(s)</span>
                        </span>
                        <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${ACTION_STYLE[a.action] ?? ''}`}>
                          {a.action}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-1">{a.detail}</p>
                      {a.legalBasis && <p className="text-[11px] text-emerald-700 mt-1">{a.legalBasis}</p>}
                    </div>
                  ))}
                </div>
              </>
            ) : preview ? (
              <>
                <p className="text-[11px] font-semibold text-zinc-500 uppercase mb-1">What would happen</p>
                <p className="text-xs text-zinc-500 mb-3">
                  {preview.matched} record(s) matched · {preview.erasedCount} erased ·
                  {' '}{preview.redactedCount} redacted · {preview.retainedCount} retained.
                  {' '}This is what to tell the subject.
                </p>
                <div className="space-y-2">
                  {(preview.steps ?? []).map((s, i) => (
                    <div key={i} className="rounded-xl border border-zinc-200 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-zinc-900 capitalize">
                          {(s.entity ?? 'unknown').replace(/_/g, ' ')}
                          <span className="text-zinc-400"> · {s.recordCount} record(s)</span>
                        </span>
                        <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${ACTION_STYLE[s.action] ?? ''}`}>
                          {s.action}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-1">{s.detail}</p>
                      {s.legalBasis && <p className="text-[11px] text-emerald-700 mt-1">{s.legalBasis}</p>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-400 py-6 text-center">No preview available.</p>
            )}

            {open.refusedReason && (
              <p className="text-xs text-red-600 mt-4">Refused: {open.refusedReason}</p>
            )}

            <div className="flex flex-wrap gap-2 mt-6">
              {open.status === 'received' && (
                <button
                  onClick={() => {
                    // An erasure request is otherwise a perfect way to delete a
                    // rival's pipeline, so how the identity was checked is
                    // recorded rather than assumed.
                    const note = prompt('How was the requester\'s identity verified?')?.trim();
                    if (!note) return;
                    act(() => apiVerifyErasure(open.id, note), 'Identity verified');
                  }}
                  disabled={busy}
                  className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60">
                  <CheckCircle2 className="h-4 w-4" /> Verify identity
                </button>
              )}
              {open.status === 'verified' && (
                <button
                  onClick={() => {
                    if (!confirm('Carry this out? Erasures cannot be undone.')) return;
                    act(() => apiExecuteErasure(open.id), 'Erasure completed');
                  }}
                  disabled={busy}
                  className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-60">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Carry out the erasure
                </button>
              )}
              {open.status !== 'completed' && open.status !== 'refused' && (
                <button
                  onClick={() => {
                    // The Act requires a refusal to be communicated with a reason.
                    const reason = prompt('Why is this being refused?')?.trim();
                    if (!reason) return;
                    act(() => apiRefuseErasure(open.id, reason), 'Refusal recorded');
                  }}
                  disabled={busy}
                  className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50">
                  Refuse
                </button>
              )}
              {open.status === 'completed' && (
                <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Completed {String(open.completedAt).slice(0, 10)} — this record is the evidence of what was done.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
