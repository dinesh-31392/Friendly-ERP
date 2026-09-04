import { useState, useEffect, useMemo } from 'react';
import { Loader2, Calculator, CheckCircle2, AlertTriangle, Wallet, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  apiPreparePayroll, apiProcessPayrollRun, apiGetPayrollRuns,
  type ApiPayrollPreview, type ApiPayrollRun,
} from '../services/apiClient';
import { formatCurrency, formatCurrencyFull } from '../utils/format';

/**
 * A month's payroll for ONE site, computed on the server.
 *
 * WHY THE SERVER COMPUTES IT
 *
 * The SPA's own `buildPayrollItemsFrom` could reach gross — days present ×
 * daily wage, or a monthly salary — and no further. Everything between gross
 * and net needs data this browser is not allowed to hold: outstanding
 * advances, the employee's PF election, the statutory ceilings in force for
 * the month being paid. A client cannot compute a deduction from figures it
 * cannot read, so it asks.
 *
 * PREVIEW, THEN SAVE, THEN PROCESS — three steps, deliberately
 *
 *   Preview   costs nothing and changes nothing. Opening March to look at it
 *             must not be an act with consequences.
 *   Save      writes the draft. Still reversible; rebuild it as often as you
 *             like.
 *   Process   is the one that counts. It closes the month and marks advances
 *             recovered, which is why it asks first.
 */

interface Props {
  month: string;
  projectId: string | null;
  projectName: string;
  currency: string;
  canManage: boolean;
  onProcessed?: () => void;
}

export default function PayrollRunPanel({ month, projectId, projectName, currency, canManage, onProcessed }: Props) {
  const [preview, setPreview] = useState<ApiPayrollPreview | null>(null);
  const [existing, setExisting] = useState<ApiPayrollRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // The stored run for this month and site, if there is one. It is what makes
  // the difference between "prepare" and "you already did".
  useEffect(() => {
    let cancelled = false;
    apiGetPayrollRuns()
      .then(runs => {
        if (cancelled) return;
        setExisting(runs.find(r => r.month === month && (r.projectId ?? null) === projectId) ?? null);
      })
      .catch(() => { if (!cancelled) setExisting(null); });
    return () => { cancelled = true; };
  }, [month, projectId, refreshKey]);

  const run = async (save: boolean) => {
    setLoading(true);
    try {
      const p = await apiPreparePayroll({ month, projectId, save });
      setPreview(p);
      if (save) {
        toast.success('Draft saved');
        setRefreshKey(k => k + 1);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare payroll');
    } finally {
      setLoading(false);
    }
  };

  const process = async () => {
    if (!existing) return;
    setBusy(true);
    try {
      await apiProcessPayrollRun(existing.id);
      toast.success('Payroll processed — advances recovered');
      setRefreshKey(k => k + 1);
      onProcessed?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not process the run');
    } finally {
      setBusy(false);
    }
  };

  const items = preview?.items ?? [];
  const totals = preview?.totals;

  // Deductions are worth breaking out: "₹4,200 withheld" is a number somebody
  // will be asked about, and the answer is four separate statutes.
  const deductionBreakdown = useMemo(() => items.reduce((t, i) => ({
    pf: t.pf + i.pfEmployee,
    esi: t.esi + i.esiEmployee,
    pt: t.pt + i.professionalTax,
    advances: t.advances + i.advanceRecovery,
  }), { pf: 0, esi: 0, pt: 0, advances: 0 }), [items]);

  const processed = existing?.status === 'processed';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-zinc-900">{projectName} · {month}</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Built from attendance, overtime, approved unpaid leave and outstanding advances.
            </p>
          </div>
          <div className="flex-1" />
          {canManage && !processed && (
            <>
              <button
                onClick={() => run(false)} disabled={loading}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-zinc-100 text-zinc-700 rounded-xl text-xs font-semibold hover:bg-zinc-200 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
                Preview
              </button>
              <button
                onClick={() => run(true)} disabled={loading}
                className="px-3.5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50"
              >
                Save draft
              </button>
            </>
          )}
          {canManage && existing?.status === 'draft' && (
            <button
              onClick={process} disabled={busy}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white rounded-xl text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Process
            </button>
          )}
          {processed && (
            <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">
              processed
            </span>
          )}
        </div>

        {!preview ? (
          <div className="py-14 text-center px-6">
            <Wallet className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-600">
              {existing
                ? `A ${existing.status} run exists for ${month}${
                    existing.itemCount ? ` covering ${existing.itemCount} people` : ''}.`
                : `No run for ${month} yet.`}
            </p>
            <p className="text-xs text-zinc-400 mt-1">
              Preview costs nothing and changes nothing.
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-14 text-center px-6">
            <Info className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-600">Nobody active on this site for {month}.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-50/40 border-b border-zinc-100">
                    <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Person</th>
                    <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Basis</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Gross</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">PF</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">ESI</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">PT</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Advance</th>
                    <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(i => (
                    <tr key={i.employeeId} className="border-b border-zinc-50">
                      <td className="px-4 py-2.5">
                        <p className="text-sm font-medium text-zinc-900">{i.name}</p>
                        <p className="text-[11px] text-zinc-400">
                          {i.designation || (i.empType === 'contract_worker' ? 'Contract' : 'Staff')}
                        </p>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600">{i.basis}</td>
                      <td className="px-3 py-2.5 text-sm text-zinc-900 text-right tabular-nums">{formatCurrencyFull(i.gross, currency)}</td>
                      <td className="px-3 py-2.5 text-xs text-zinc-500 text-right tabular-nums">{i.pfEmployee || '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-zinc-500 text-right tabular-nums">{i.esiEmployee || '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-zinc-500 text-right tabular-nums">{i.professionalTax || '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-amber-600 text-right tabular-nums">{i.advanceRecovery || '—'}</td>
                      <td className="px-4 py-2.5 text-sm font-semibold text-zinc-900 text-right tabular-nums">{formatCurrencyFull(i.net, currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-zinc-50/60">
                    <td className="px-4 py-3 text-sm font-bold text-zinc-900" colSpan={2}>
                      {totals?.headcount} {totals?.headcount === 1 ? 'person' : 'people'}
                      <span className="ml-2 text-[11px] font-normal text-zinc-500">
                        {preview.workingDays} working days
                      </span>
                    </td>
                    <td className="px-3 py-3 text-sm font-bold text-zinc-900 text-right tabular-nums">{formatCurrencyFull(totals?.gross ?? 0, currency)}</td>
                    <td className="px-3 py-3 text-xs text-zinc-600 text-right tabular-nums">{deductionBreakdown.pf || '—'}</td>
                    <td className="px-3 py-3 text-xs text-zinc-600 text-right tabular-nums">{deductionBreakdown.esi || '—'}</td>
                    <td className="px-3 py-3 text-xs text-zinc-600 text-right tabular-nums">{deductionBreakdown.pt || '—'}</td>
                    <td className="px-3 py-3 text-xs text-amber-700 text-right tabular-nums">{deductionBreakdown.advances || '—'}</td>
                    <td className="px-4 py-3 text-sm font-bold text-zinc-900 text-right tabular-nums">{formatCurrencyFull(totals?.net ?? 0, currency)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="px-5 py-3 border-t border-zinc-100 flex items-center gap-4 flex-wrap text-[11px]">
              {/* The employer's own liability never appears on a payslip and is
                  real money. A payroll screen that only shows net understates
                  what the month costs by the whole employer PF and ESI. */}
              <span className="text-zinc-500">
                Cost to company{' '}
                <strong className="text-zinc-800 tabular-nums">{formatCurrency(totals?.employerCost ?? 0, currency)}</strong>
                <span className="text-zinc-400"> — gross plus employer PF and ESI</span>
              </span>
              <div className="flex-1" />
              {!preview.saved && (
                <span className="text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Preview only — not saved
                </span>
              )}
            </div>

            <p className="px-5 py-2.5 bg-zinc-50/60 border-t border-zinc-100 text-[11px] text-zinc-500">
              Income-tax withholding (s.192) is not computed here — it needs each person&apos;s
              declared investments and year-to-date position. Processing the run is what marks
              advances recovered.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
