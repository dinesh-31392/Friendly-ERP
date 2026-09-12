import { useState, useEffect } from 'react';
import { Loader2, FileJson, ShieldCheck, Ban, AlertTriangle, X, Copy } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isApiEnabled, apiGetEinvoices, apiRegisterEinvoice, apiCancelEinvoice, apiEinvoiceJson,
  apiEligibleForEinvoice, apiPrepareEinvoice,
  type ApiEinvoice, type ApiEinvoiceCandidate,
} from '../services/apiClient';
import { formatCurrency } from '../utils/format';

/**
 * E-invoicing — the IRN register.
 *
 * Nothing here talks to the Invoice Registration Portal. Registering needs
 * credentials from a GST Suvidha Provider, and a system holding those holds the
 * ability to issue tax invoices in the builder's name — so the division is the
 * same as GST returns: prepare here, upload through the tool that holds the
 * credentials, record what came back.
 *
 * The derived IRN is shown before registration on purpose. It is what the
 * portal's answer gets checked against, and a mismatch means the response
 * belongs to a different document — caught here rather than at the buyer's
 * input credit claim months later.
 */

const STATUS_STYLE: Record<string, string> = {
  prepared:   'bg-amber-50 text-amber-700',
  registered: 'bg-emerald-50 text-emerald-700',
  cancelled:  'bg-zinc-100 text-zinc-500',
  rejected:   'bg-red-50 text-red-700',
};

/** 64 hex characters is unreadable in a table; the ends are what people compare. */
const shortIrn = (irn: string) => `${irn.slice(0, 10)}…${irn.slice(-8)}`;

function RegisterForm({ einvoice, onClose, onDone }: {
  einvoice: ApiEinvoice; onClose: () => void; onDone: () => void;
}) {
  const [ackNo, setAckNo] = useState('');
  const [ackDate, setAckDate] = useState('');
  const [signedQr, setSignedQr] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // The IRN is not asked for. It is the one this system derived, and the
      // server refuses anything else — typing it again would only introduce a
      // transcription error into the one field that must match exactly.
      await apiRegisterEinvoice(einvoice.id, {
        irn: einvoice.irn ?? '',
        ackNo: ackNo.trim(),
        ackDate: new Date(ackDate).toISOString(),
        ...(signedQr.trim() ? { signedQr: signedQr.trim() } : {}),
      });
      toast.success('Registration recorded');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the registration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4"
      onClick={onClose} role="dialog" aria-modal="true" aria-label="Record IRP registration">
      <form onSubmit={submit} onClick={e => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">Record the registration</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              {einvoice.docNo} · {einvoice.financialYear} · {einvoice.buyerGstin}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
          <p className="text-[11px] font-semibold text-zinc-500 uppercase mb-1">IRN this system derived</p>
          <p className="text-[11px] text-zinc-900 font-mono break-all">{einvoice.irn}</p>
          <p className="text-[10px] text-zinc-500 mt-1">
            The portal returns the same value. It is checked on save — a mismatch means
            the response belongs to a different document, and is refused.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Ack. number</span>
            <input required value={ackNo} onChange={e => setAckNo(e.target.value)}
              className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm font-mono" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">Ack. date &amp; time</span>
            <input type="datetime-local" required value={ackDate} onChange={e => setAckDate(e.target.value)}
              className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
            <span className="block text-[10px] text-zinc-400 mt-0.5">
              The 24-hour cancellation window runs from this moment.
            </span>
          </label>
        </div>

        <label className="block">
          <span className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">
            Signed QR <span className="normal-case font-normal text-zinc-400">(optional)</span>
          </span>
          <textarea rows={3} value={signedQr} onChange={e => setSignedQr(e.target.value)}
            className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-xs font-mono resize-none" />
          <span className="block text-[10px] text-zinc-400 mt-0.5">
            The signed JWT from the portal. It is what prints on the invoice.
          </span>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-50">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}Record
          </button>
        </div>
      </form>
    </div>
  );
}

export default function EinvoicePanel({ currency = 'INR' }: { currency?: string }) {
  const [rows, setRows] = useState<ApiEinvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [registering, setRegistering] = useState<ApiEinvoice | null>(null);
  const [candidates, setCandidates] = useState<ApiEinvoiceCandidate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      apiGetEinvoices().catch(() => [] as ApiEinvoice[]),
      apiEligibleForEinvoice().catch(() => [] as ApiEinvoiceCandidate[]),
    ]).then(([r, c]) => {
      if (cancelled) return;
      setRows(Array.isArray(r) ? r : []);
      setCandidates(Array.isArray(c) ? c : []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const download = async (id: string) => {
    try {
      const { url, filename } = await apiEinvoiceJson(id);
      const a = window.document.createElement('a');
      a.href = url; a.download = filename;
      window.document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not download');
    }
  };

  const prepare = async (c: ApiEinvoiceCandidate) => {
    setBusyId(c.id);
    try {
      await apiPrepareEinvoice(c.id);
      toast.success('Prepared — upload the JSON to your GSP, then record the IRN');
      setRefreshKey(k => k + 1);
    } catch (e) {
      // 422 lists every reason at once, so the first is the one to show.
      toast.error(e instanceof Error ? e.message : 'Could not prepare that e-invoice');
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (r: ApiEinvoice) => {
    const reason = prompt('Why is this being cancelled? The portal records the reason.')?.trim();
    if (!reason) return;
    setBusyId(r.id);
    try {
      await apiCancelEinvoice(r.id, reason);
      toast.success('Cancelled');
      setRefreshKey(k => k + 1);
    } catch (e) {
      // Past 24 hours the server says so and names the credit note as the remedy.
      toast.error(e instanceof Error ? e.message : 'Could not cancel');
    } finally {
      setBusyId(null);
    }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <ShieldCheck className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">E-invoicing needs the API</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-4">
        <p className="text-sm text-zinc-600">
          An invoice in scope must be registered with the IRP <span className="font-medium">before it is issued</span> —
          without an IRN it is not a valid tax invoice and the buyer cannot claim input credit.
        </p>
        <p className="text-xs text-zinc-500 mt-1.5">
          Prepare here, upload the JSON through your GSP, then record the acknowledgement.
          Nothing in this workspace holds portal credentials. Scope is B2B, SEZ and exports —
          a sale to an individual with no GSTIN never gets an IRN, however large.
        </p>
      </div>

      {candidates.length > 0 && (
        <div className="bg-white rounded-2xl border border-amber-200/70 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-100 bg-amber-50/40">
            <h3 className="font-semibold text-zinc-900">
              {candidates.length} invoice{candidates.length === 1 ? '' : 's'} awaiting registration
            </h3>
            <p className="text-xs text-zinc-600 mt-0.5">
              Taxed, B2B, and not yet registered. Until an IRN is issued these are not valid
              tax invoices — the buyer cannot claim credit against them.
            </p>
          </div>
          <div className="divide-y divide-zinc-50">
            {candidates.map(c => (
              <div key={c.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-medium text-zinc-900">
                    {c.invoiceNo || c.id.slice(0, 8)}
                    <span className="text-zinc-400 font-normal"> · {c.customerName}</span>
                  </p>
                  <p className="text-[11px] text-zinc-400 tabular-nums">
                    {c.issueDate} · {c.customerGstin} · {formatCurrency(c.totalValue, currency)}
                  </p>
                </div>
                <button onClick={() => prepare(c)} disabled={busyId === c.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-[11px] font-semibold hover:bg-indigo-700 disabled:opacity-60">
                  {busyId === c.id && <Loader2 className="h-3 w-3 animate-spin" />}Prepare
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100">
          <h3 className="font-semibold text-zinc-900">Registered documents</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            A cancelled registration stays listed — the IRN it used is burned at the portal and can never be reissued.
          </p>
        </div>

        {loading ? (
          <div className="py-14 flex justify-center"><Loader2 className="h-6 w-6 text-zinc-300 animate-spin" /></div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center">
            <ShieldCheck className="h-9 w-9 text-zinc-200 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">Nothing prepared yet</p>
            <p className="text-xs text-zinc-400 mt-1">
              Prepare one from a taxed B2B invoice under Receivables.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {rows.map(r => (
              <div key={r.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-medium text-zinc-900">
                    {r.docNo} <span className="text-zinc-400 font-normal">· {r.docType} · {r.financialYear}</span>
                  </p>
                  <p className="text-[11px] text-zinc-400 tabular-nums">
                    {r.buyerGstin} · {formatCurrency(r.totalValue, currency)}
                    {r.ackNo && ` · ack ${r.ackNo}`}
                  </p>
                  {r.irn && (
                    <button
                      onClick={() => { navigator.clipboard?.writeText(r.irn ?? ''); toast.success('IRN copied'); }}
                      className="flex items-center gap-1 text-[11px] text-zinc-500 font-mono hover:text-indigo-600 mt-0.5"
                      title={r.irn}
                    >
                      <Copy className="h-3 w-3" /> {shortIrn(r.irn)}
                    </button>
                  )}
                  {r.cancelReason && (
                    <p className="text-[11px] text-zinc-400 mt-0.5">Cancelled — {r.cancelReason}</p>
                  )}
                </div>

                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${
                  STATUS_STYLE[r.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                  {r.status}
                </span>

                <div className="flex items-center gap-1.5">
                  <button onClick={() => download(r.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50">
                    <FileJson className="h-3 w-3" /> JSON
                  </button>
                  {r.status === 'prepared' && (
                    <button onClick={() => setRegistering(r)}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg text-[11px] font-semibold hover:bg-emerald-700">
                      <ShieldCheck className="h-3 w-3" /> Record IRN
                    </button>
                  )}
                  {(r.status === 'prepared' || r.cancellable) && (
                    <button onClick={() => cancel(r)} disabled={busyId === r.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-50">
                      <Ban className="h-3 w-3" /> Cancel
                    </button>
                  )}
                  {r.status === 'registered' && !r.cancellable && (
                    // Not a disabled button: the window is gone, and the honest
                    // next step is a credit note, not a control that will fail.
                    <span className="flex items-center gap-1 text-[11px] text-zinc-400" title="Cancellation is only accepted within 24 hours of acknowledgement">
                      <AlertTriangle className="h-3 w-3" /> window closed
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {registering && (
        <RegisterForm
          einvoice={registering}
          onClose={() => setRegistering(null)}
          onDone={() => setRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
