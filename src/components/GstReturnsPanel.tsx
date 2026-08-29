import { useState, useEffect } from 'react';
import { Loader2, FileJson, AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import {
  isApiEnabled, apiGetGstReturns, apiPreviewGstReturn, apiPrepareGstReturn,
  apiFileGstReturn, apiGstReturnJson,
} from '../services/apiClient';
import type { ApiGstReturn, ApiGstPreview, GstForm } from '../services/apiClient';
import { formatCurrency } from '../utils/format';
import toast from 'react-hot-toast';

/**
 * GST returns.
 *
 * Nothing here computes tax — the split, the check digit and the three outward
 * tables are all server-side. This is the accountant's view of them: what the
 * month looks like, which invoices are still untaxed, and the file to hand to
 * the offline tool.
 *
 * Prepared, never filed from here. Filing needs a signature or an EVC against
 * the signatory's own credentials.
 */

/** MMYYYY, which is what GSTN uses and what the API expects. */
function currentPeriod(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);   // the month you actually file for
  return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
}

const label = (p: string) => {
  // Called with a server-supplied period as well as local state, and a row
  // missing one would otherwise take the whole tab down.
  if (!p || p.length < 6) return p || 'unknown period';
  const mm = Number(p.slice(0, 2));
  const names = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[mm] ?? p.slice(0, 2)} ${p.slice(2)}`;
};

export default function GstReturnsPanel({ currency = 'INR' }: { currency?: string }) {
  const [form, setForm] = useState<GstForm>('GSTR1');
  const [period, setPeriod] = useState(currentPeriod());
  const [preview, setPreview] = useState<ApiGstPreview | null>(null);
  const [returns, setReturns] = useState<ApiGstReturn[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!isApiEnabled()) return;
    let cancelled = false;
    apiGetGstReturns()
      .then(r => { if (!cancelled) setReturns(Array.isArray(r) ? r : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    if (!isApiEnabled() || !/^\d{6}$/.test(period)) return;
    let cancelled = false;
    setLoading(true);
    apiPreviewGstReturn(form, period)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(e => { if (!cancelled) toast.error(e instanceof Error ? e.message : 'Could not preview'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [form, period, refreshKey]);

  const prepare = async () => {
    setBusy(true);
    try {
      const r = await apiPrepareGstReturn(form, period);
      toast.success(`${form} for ${label(period)} prepared`);
      setRefreshKey(k => k + 1);
      return r;
    } catch (e) {
      // A filed return refuses to be overwritten, and says to amend instead.
      toast.error(e instanceof Error ? e.message : 'Could not prepare the return');
    } finally {
      setBusy(false);
    }
  };

  const download = async (id: string) => {
    try {
      const { url, filename } = await apiGstReturnJson(id);
      const a = window.document.createElement('a');
      a.href = url; a.download = filename;
      window.document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not download');
    }
  };

  const markFiled = async (r: ApiGstReturn) => {
    // The ARN is what anyone checking later will ask for; the schema requires it.
    const arn = prompt('Acknowledgement reference number (ARN) from GSTN:')?.trim();
    if (!arn) return;
    try {
      await apiFileGstReturn(r.id, arn);
      toast.success('Recorded as filed');
      setRefreshKey(k => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record it');
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <AlertTriangle className="h-9 w-9 text-amber-400 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">GST returns need the API</p>
      </div>
    );
  }

  const totals = (preview?.payload as { totals?: Record<string, number> } | undefined)?.totals;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Return</label>
          <select value={form} onChange={e => setForm(e.target.value as GstForm)}
            className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm">
            <option value="GSTR1">GSTR-1 — outward supplies</option>
            <option value="GSTR3B">GSTR-3B — summary</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Period</label>
          <input value={period} onChange={e => setPeriod(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="MMYYYY"
            className="w-32 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm tabular-nums" />
          <p className="text-[10px] text-zinc-400 mt-0.5">{/^\d{6}$/.test(period) ? label(period) : 'MMYYYY'}</p>
        </div>
        <button onClick={prepare} disabled={busy || !preview}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Prepare
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-zinc-200/60 py-12 flex justify-center">
          <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
        </div>
      ) : preview && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-semibold text-zinc-900">{form} · {label(period)}</h3>
              <p className="text-xs text-zinc-500 mt-0.5">{preview.from} to {preview.to}</p>
            </div>
            {preview.ready
              ? <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" /> ready
                </span>
              : <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">
                  needs attention
                </span>}
          </div>

          {!preview.gstinConfigured && (
            <div className="px-5 py-3 bg-amber-50/50 border-b border-zinc-100">
              <p className="text-xs text-amber-800">
                This workspace has no GSTIN. The return has no <code>gstin</code> field and GSTN will
                reject the upload — set it before preparing.
              </p>
            </div>
          )}

          {totals && (
            <div className="px-5 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-zinc-100">
              {([['Taxable value', totals.taxableValue], ['CGST', totals.cgst],
                 ['SGST', totals.sgst], ['IGST', totals.igst]] as const).map(([k, v]) => (
                <div key={k}>
                  <p className="text-[11px] text-zinc-400 uppercase">{k}</p>
                  <p className="text-sm font-semibold text-zinc-900 tabular-nums">
                    {formatCurrency(Number(v ?? 0), currency)}
                  </p>
                </div>
              ))}
            </div>
          )}

          {(preview.untaxed ?? []).length > 0 && (
            <div className="px-5 py-3 border-b border-zinc-100">
              <p className="text-xs font-medium text-amber-800 mb-1">
                {(preview.untaxed ?? []).length} invoice(s) with no tax recorded
              </p>
              {/* Not folded into the exempt table on purpose: reporting an
                  untouched invoice as exempt claims an exemption nobody claimed. */}
              <p className="text-[11px] text-zinc-500 mb-2">
                These are excluded from every table. Record their tax and prepare again.
              </p>
              <div className="space-y-1">
                {(preview.untaxed ?? []).slice(0, 8).map(u => (
                  <div key={u.id} className="flex items-baseline justify-between text-[12px]">
                    <span className="text-zinc-600">
                      {u.invoiceNo ?? u.id.slice(0, 8)} · {u.leadName}
                    </span>
                    <span className="tabular-nums text-zinc-500">{formatCurrency(u.amount, currency)}</span>
                  </div>
                ))}
                {(preview.untaxed ?? []).length > 8 && (
                  <p className="text-[11px] text-zinc-400">…and {(preview.untaxed ?? []).length - 8} more</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900">Prepared returns</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            A prepared return is frozen — an invoice corrected later does not change what was filed.
          </p>
        </div>
        {returns.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-400">Nothing prepared yet</div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {returns.map(r => (
              <div key={r.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[160px]">
                  <p className="text-sm font-medium text-zinc-900">{r.form} · {label(r.period)}</p>
                  <p className="text-[11px] text-zinc-400 tabular-nums">
                    {r.invoiceCount} invoice(s) · {formatCurrency(r.taxableValue, currency)} taxable
                    {r.arn && ` · ARN ${r.arn}`}
                  </p>
                </div>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${
                  r.status === 'filed' ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-600'}`}>
                  {r.status}
                </span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => download(r.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50">
                    <FileJson className="h-3 w-3" /> JSON
                  </button>
                  {r.status === 'prepared' && (
                    <button onClick={() => markFiled(r)}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg text-[11px] font-semibold hover:bg-emerald-700">
                      <Send className="h-3 w-3" /> Mark filed
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
