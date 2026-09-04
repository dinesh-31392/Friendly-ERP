import { useState, useEffect, useMemo } from 'react';
import { Loader2, Plus, X, HandCoins, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isApiEnabled, apiGetAdvances, apiCreateAdvance, type ApiAdvance,
} from '../services/apiClient';
import { formatCurrencyFull } from '../utils/format';
import type { Employee } from '../types';

/**
 * Money handed to a worker before payday, recovered from it.
 *
 * WHY THIS SCREEN EXISTS
 *
 * Payroll already deducts advances — the run has an "Advance" column and net
 * pay is reduced by it. But there was no way to ISSUE one, and no way to see
 * what anybody still owed. The deduction existed and its cause did not, which
 * is the worst of both: an HR manager could watch ₹4,000 come off a payslip
 * and have nothing in the product explaining it.
 *
 * Site crews draw advances constantly, and on paper registers this is exactly
 * where cash goes missing.
 *
 * THE INSTALMENT
 *
 * "Recover per month" caps what each run takes. Zero means take it all at the
 * next payroll, which is what a small advance normally is. A large one spread
 * over four months is the reason the field exists at all — recovering ₹40,000
 * from a ₹22,000 salary in one go would pay somebody nothing.
 *
 * Recovery happens when a payroll run is PROCESSED, never when a draft is
 * built, so rebuilding a draft cannot mark money repaid that nobody paid.
 */

interface Props {
  employees: Employee[];
  currency: string;
  canManage: boolean;
}

export default function AdvancesPanel({ employees, currency, canManage }: Props) {
  const [advances, setAdvances] = useState<ApiAdvance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ employeeId: '', amount: '', perMonth: '', reason: '' });

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetAdvances()
      .then(a => { if (!cancelled) setAdvances(a); })
      .catch(() => { if (!cancelled) setAdvances([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const nameOf = useMemo(() => {
    const m = new Map(employees.map(e => [e.id, e.name]));
    return (id: string) => m.get(id) ?? 'Unknown';
  }, [employees]);

  const outstanding = advances.filter(a => a.outstanding > 0);
  const totalOwed = outstanding.reduce((s, a) => s + a.outstanding, 0);

  const create = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const amount = Number(form.amount);
    if (!form.employeeId || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Pick a person and an amount'); return;
    }
    setSaving(true);
    try {
      await apiCreateAdvance({
        employeeId: form.employeeId,
        amount,
        perMonth: Number(form.perMonth) || 0,
        reason: form.reason,
      });
      toast.success('Advance recorded');
      setShowNew(false);
      setForm({ employeeId: '', amount: '', perMonth: '', reason: '' });
      setRefreshKey(k => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record that advance');
    } finally {
      setSaving(false);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <HandCoins className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Advances need the API</p>
        <p className="text-xs text-zinc-500 mt-1">Recovery is computed on the server against payroll.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-zinc-500 max-w-xl">
          Money drawn before payday. Each payroll run recovers up to the monthly
          instalment, and only when the run is processed.
        </p>
        {canManage && (
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" /> Give an advance
          </button>
        )}
      </div>

      {outstanding.length > 0 && (
        <div className="bg-amber-50/60 border border-amber-200/60 rounded-2xl px-5 py-3 flex items-center gap-3">
          <HandCoins className="h-5 w-5 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-900">
            <strong className="tabular-nums">{formatCurrencyFull(totalOwed, currency)}</strong> outstanding
            across {outstanding.length} {outstanding.length === 1 ? 'advance' : 'advances'} — this comes off the next run.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        {loading ? (
          <div className="py-14 flex justify-center"><Loader2 className="h-6 w-6 text-zinc-300 animate-spin" /></div>
        ) : advances.length === 0 ? (
          <div className="py-14 text-center">
            <Info className="h-9 w-9 text-zinc-200 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No advances recorded</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-zinc-50/40 border-b border-zinc-100">
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Person</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Reason</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Given</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Recovered</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Per month</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {advances.map(a => (
                  <tr key={a.id} className="border-b border-zinc-50">
                    <td className="px-4 py-2.5">
                      <p className="text-sm font-medium text-zinc-900">{nameOf(a.employeeId)}</p>
                      <p className="text-[11px] text-zinc-400 tabular-nums">
                        {a.issuedOn ? new Date(a.issuedOn).toLocaleDateString() : ''}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-zinc-600">{a.reason || '—'}</td>
                    <td className="px-3 py-2.5 text-sm text-zinc-900 text-right tabular-nums">{formatCurrencyFull(a.amount, currency)}</td>
                    <td className="px-3 py-2.5 text-xs text-emerald-700 text-right tabular-nums">{a.recovered ? formatCurrencyFull(a.recovered, currency) : '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-zinc-500 text-right tabular-nums">
                      {a.perMonth ? formatCurrencyFull(a.perMonth, currency) : 'all at once'}
                    </td>
                    <td className="px-4 py-2.5 text-sm font-semibold text-right tabular-nums">
                      {a.outstanding > 0
                        ? <span className="text-amber-700">{formatCurrencyFull(a.outstanding, currency)}</span>
                        : <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">settled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4" onClick={() => setShowNew(false)}>
          <form onSubmit={create} onClick={ev => ev.stopPropagation()}
            className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3">
              <h3 className="font-semibold text-zinc-900 flex-1">Give an advance</h3>
              <button type="button" onClick={() => setShowNew(false)} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Person</label>
                <select value={form.employeeId} onChange={ev => setForm(f => ({ ...f, employeeId: ev.target.value }))}
                  className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" required>
                  <option value="">Choose…</option>
                  {employees.filter(e => e.active).map(e => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Amount ({currency})</label>
                  <input type="number" min="1" value={form.amount} onChange={ev => setForm(f => ({ ...f, amount: ev.target.value }))}
                    className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" required />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Recover per month</label>
                  <input type="number" min="0" value={form.perMonth} onChange={ev => setForm(f => ({ ...f, perMonth: ev.target.value }))}
                    className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" placeholder="0 = all at once" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Reason</label>
                <input value={form.reason} onChange={ev => setForm(f => ({ ...f, reason: ev.target.value }))}
                  className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" placeholder="Advance against salary" />
              </div>
              <p className="text-[11px] text-zinc-400">
                An advance is never recovered beyond what a month&apos;s pay can bear — the
                remainder stays outstanding rather than producing a negative payslip.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-zinc-100 flex gap-2">
              <button type="button" onClick={() => setShowNew(false)}
                className="flex-1 px-4 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-200">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Record
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
