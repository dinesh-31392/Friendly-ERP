import { useState, useEffect, useMemo } from 'react';
import { Loader2, Receipt, Search } from 'lucide-react';
import { isApiEnabled, apiGetPayments, type ApiPayment } from '../services/apiClient';
import { formatCurrency } from '../utils/format';

/**
 * Money received — the receipt side of the schedule.
 *
 * The demand side has always been visible: a booking's schedule shows each
 * installment and whether it is paid. What it never showed is the RECEIPT —
 * the mode and the reference number the payment actually arrived with.
 * `GET /api/payments` has served both throughout, and `referenceNo` appeared
 * nowhere in the product.
 *
 * That is the field reconciliation runs on. Matching a bank statement line to
 * an installment means matching the UTR or cheque number, and without it the
 * answer to "which of these three ₹5,00,000 receipts is this one?" is a
 * database query.
 */

const MODE_STYLE: Record<string, string> = {
  neft:     'bg-blue-50 text-blue-700',
  rtgs:     'bg-blue-50 text-blue-700',
  imps:     'bg-blue-50 text-blue-700',
  upi:      'bg-indigo-50 text-indigo-700',
  cheque:   'bg-amber-50 text-amber-700',
  cash:     'bg-zinc-100 text-zinc-600',
  card:     'bg-emerald-50 text-emerald-700',
  gateway:  'bg-emerald-50 text-emerald-700',
};

export default function ReceiptsPanel({ currency = 'INR' }: { currency?: string }) {
  const [payments, setPayments] = useState<ApiPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetPayments()
      .then(rows => { if (!cancelled) setPayments(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setPayments([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = payments.slice().sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (!q) return sorted;
    return sorted.filter(p =>
      (p.referenceNo ?? '').toLowerCase().includes(q)
      || (p.mode ?? '').toLowerCase().includes(q)
      || String(p.amount).includes(q));
  }, [payments, search]);

  const total = useMemo(
    () => shown.reduce((s, p) => s + (Number(p.amount) || 0), 0), [shown]);

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 py-14 text-center">
        <Receipt className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Receipts need the API</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-100">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-zinc-900">Receipts</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              What actually arrived, and the reference it arrived with — the field a bank
              statement is reconciled against.
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-zinc-400 uppercase">
              {search ? 'Matching' : 'Total received'}
            </p>
            <p className="text-lg font-bold text-zinc-900 tabular-nums">
              {formatCurrency(total, currency)}
            </p>
          </div>
        </div>
        <div className="relative mt-3">
          <Search className="h-4 w-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="UTR, cheque number, mode or amount…"
            className="w-full pl-9 pr-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="py-14 flex justify-center"><Loader2 className="h-6 w-6 text-zinc-300 animate-spin" /></div>
      ) : shown.length === 0 ? (
        <div className="py-14 text-center">
          <Receipt className="h-9 w-9 text-zinc-200 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">
            {payments.length === 0 ? 'Nothing received yet' : 'No receipt matches that'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/60">
              <tr>
                <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Received</th>
                <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Mode</th>
                <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Reference</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-zinc-500 uppercase">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {shown.map(p => (
                <tr key={p.id}>
                  <td className="px-5 py-2.5 text-zinc-600 whitespace-nowrap">
                    {p.date ? new Date(p.date).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-5 py-2.5">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full uppercase ${
                      MODE_STYLE[(p.mode ?? '').toLowerCase()] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {p.mode || 'unknown'}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 font-mono text-xs text-zinc-700 break-all">
                    {p.referenceNo || <span className="text-zinc-400 font-sans">no reference</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold text-zinc-900 tabular-nums whitespace-nowrap">
                    {formatCurrency(Number(p.amount) || 0, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
