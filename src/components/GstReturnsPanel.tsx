import { useState, useEffect } from 'react';
import { Loader2, FileJson, AlertTriangle, CheckCircle2, Send, X } from 'lucide-react';
import {
  isApiEnabled, apiGetGstReturns, apiPreviewGstReturn, apiPrepareGstReturn,
  apiFileGstReturn, apiGstReturnJson, apiSetInvoiceTax,
} from '../services/apiClient';
import { GST_STATES, GST_RATES, DEFAULT_SAC } from '../utils/gstStates';
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

/** One untaxed invoice, exactly as the preview reports it — derived from the
 *  payload type rather than restated, so the two cannot drift. */
type Untaxed = NonNullable<ApiGstPreview['untaxed']>[number];

/**
 * Record the tax on one invoice.
 *
 * The panel used to list untaxed invoices and tell the reader to "record their
 * tax and prepare again" — with nothing anywhere in the product that could do
 * it. The server route and its client binding both existed; no screen called
 * them. This is that screen.
 *
 * Nothing here computes the split. Rate, place of supply and the workspace's
 * own state decide CGST+SGST versus IGST, and that decision is the server's —
 * doing it twice is how the two copies drift apart.
 */
function TaxForm({ invoice, currency, onClose, onSaved }: {
  invoice: Untaxed; currency: string; onClose: () => void; onSaved: () => void;
}) {
  // The invoice total is the honest starting point for the taxable value, but
  // it is a starting point: a total that already includes tax is not the base.
  const [taxableValue, setTaxableValue] = useState(String(invoice.amount ?? 0));
  const [gstRate, setGstRate] = useState(5);
  const [placeOfSupply, setPlaceOfSupply] = useState('27');
  const [customerGstin, setCustomerGstin] = useState('');
  const [hsnSac, setHsnSac] = useState(DEFAULT_SAC);
  const [postCompletion, setPostCompletion] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiSetInvoiceTax(invoice.id, {
        taxableValue: Number(taxableValue) || 0,
        gstRate, placeOfSupply,
        // Sent only when filled. An empty GSTIN is a B2C supply, not a bad one,
        // and the server refuses a GSTIN whose check digit does not match.
        ...(customerGstin.trim() ? { customerGstin: customerGstin.trim().toUpperCase() } : {}),
        ...(hsnSac.trim() ? { hsnSac: hsnSac.trim() } : {}),
        postCompletion,
      });
      toast.success('Tax recorded');
      onSaved();
      onClose();
    } catch (err) {
      // Two failures the server states precisely and the user can act on: an
      // invalid GSTIN check digit, and a workspace with no GSTIN of its own.
      toast.error(err instanceof Error ? err.message : 'Could not record the tax');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <form onSubmit={submit} onClick={e => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">Record tax</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              {invoice.invoiceNo ?? invoice.id.slice(0, 8)}
              {invoice.leadName ? ` · ${invoice.leadName}` : ''}
              {' · '}{formatCurrency(invoice.amount ?? 0, currency)} invoiced
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <label className="block">
          <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Taxable value</span>
          <input type="number" min={0} step="0.01" value={taxableValue} required
            onChange={e => setTaxableValue(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm tabular-nums" />
          <span className="block text-[10px] text-zinc-400 mt-0.5">
            The base the rate applies to — not the tax-inclusive total.
          </span>
        </label>

        <label className="block">
          <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Rate</span>
          <select value={gstRate} onChange={e => setGstRate(Number(e.target.value))}
            disabled={postCompletion}
            className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm disabled:opacity-50">
            {GST_RATES.map(r => <option key={r.rate} value={r.rate}>{r.label}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Place of supply</span>
          <select value={placeOfSupply} onChange={e => setPlaceOfSupply(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm">
            {GST_STATES.map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
          </select>
          <span className="block text-[10px] text-zinc-400 mt-0.5">
            Where the property is, not where the buyer lives. This is what splits
            CGST+SGST from IGST.
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">
              Buyer GSTIN <span className="normal-case font-normal text-zinc-400">(optional)</span>
            </span>
            <input value={customerGstin} maxLength={15} placeholder="B2C if blank"
              onChange={e => setCustomerGstin(e.target.value.toUpperCase())}
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm font-mono uppercase" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">HSN / SAC</span>
            <input value={hsnSac} maxLength={8} onChange={e => setHsnSac(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm font-mono" />
          </label>
        </div>

        <label className="flex items-start gap-2.5 p-3 bg-zinc-50 rounded-xl cursor-pointer">
          <input type="checkbox" checked={postCompletion} className="mt-0.5"
            onChange={e => setPostCompletion(e.target.checked)} />
          <span className="text-xs text-zinc-600">
            <span className="font-medium text-zinc-800">Sold after completion</span> — outside the levy.
            A finished unit is immovable property, not a supply of service, so no GST
            arises and the rate is forced to zero.
          </span>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}Record tax
          </button>
        </div>
      </form>
    </div>
  );
}

export default function GstReturnsPanel({ currency = 'INR' }: { currency?: string }) {
  const [taxing, setTaxing] = useState<Untaxed | null>(null);
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
                  <button key={u.id} type="button" onClick={() => setTaxing(u)}
                    className="w-full flex items-baseline justify-between gap-3 text-[12px] text-left px-2 -mx-2 py-1 rounded-lg hover:bg-zinc-50">
                    <span className="text-zinc-600">
                      {u.invoiceNo ?? u.id.slice(0, 8)} · {u.leadName}
                    </span>
                    <span className="flex items-baseline gap-3">
                      <span className="tabular-nums text-zinc-500">{formatCurrency(u.amount, currency)}</span>
                      <span className="text-[11px] font-semibold text-indigo-600">Record tax</span>
                    </span>
                  </button>
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

      {taxing && (
        <TaxForm
          invoice={taxing}
          currency={currency}
          onClose={() => setTaxing(null)}
          // Bumping the key re-runs the preview, so the invoice just taxed
          // leaves the untaxed list and lands in the totals above it.
          onSaved={() => setRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
