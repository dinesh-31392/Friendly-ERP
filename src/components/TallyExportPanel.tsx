import { useState } from 'react';
import { Download, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { isApiEnabled, apiTallyPreflight, apiTallyExport } from '../services/apiClient';
import type { ApiTallyPreflight } from '../services/apiClient';
import toast from 'react-hot-toast';

/**
 * Tally export.
 *
 * The preflight is the point of the screen. An accounts team runs the export on
 * the last day of the month under time pressure; finding out then that four
 * vouchers do not balance is worse than being able to check on the 28th.
 *
 * Only POSTED entries are exported — a draft is something somebody typed and
 * nobody approved.
 */

/** The month just gone, which is what an export is almost always for. */
function lastMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last) };
}

export default function TallyExportPanel() {
  const initial = lastMonth();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [pre, setPre] = useState<ApiTallyPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const check = async () => {
    setChecking(true);
    setPre(null);
    try {
      setPre(await apiTallyPreflight(from, to));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not check the period');
    } finally {
      setChecking(false);
    }
  };

  const download = async () => {
    setDownloading(true);
    try {
      const { url, filename } = await apiTallyExport(from, to);
      const a = window.document.createElement('a');
      a.href = url; a.download = filename;
      window.document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success('Export downloaded');
    } catch (e) {
      // The export refuses to produce a file that would half-import, and the
      // message names the offending vouchers.
      toast.error(e instanceof Error ? e.message : 'Could not export');
    } finally {
      setDownloading(false);
    }
  };

  if (!isApiEnabled()) return null;

  return (
    <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-100">
        <h3 className="font-semibold text-zinc-900">Export to Tally</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          Posted entries for a period, as a Tally import file. Check first — Tally rejects
          unbalanced vouchers one at a time, so the rest of the month lands looking like success.
        </p>
      </div>

      <div className="px-5 py-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-zinc-500 uppercase mb-1">To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
        </div>
        <button onClick={check} disabled={checking}
          className="flex items-center gap-2 px-4 py-2 border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-60">
          {checking && <Loader2 className="h-4 w-4 animate-spin" />}Check the period
        </button>
        <button onClick={download} disabled={downloading || (pre != null && !pre.ready)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60">
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download
        </button>
      </div>

      {pre && (
        <div className="px-5 pb-4">
          <div className={`rounded-xl border p-3 ${pre.ready ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
            <p className="text-sm font-medium flex items-center gap-1.5 mb-1">
              {pre.ready
                ? <><CheckCircle2 className="h-4 w-4 text-emerald-600" /><span className="text-emerald-800">Ready to export</span></>
                : <><AlertTriangle className="h-4 w-4 text-amber-600" /><span className="text-amber-800">Not ready</span></>}
            </p>
            <p className="text-xs text-zinc-600">
              {pre.vouchers} posted voucher(s) across {pre.ledgers} ledger(s).
            </p>

            {pre.unbalanced.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-amber-800">These do not balance:</p>
                {pre.unbalanced.slice(0, 8).map(u => (
                  <p key={u.voucherNumber} className="text-[11px] text-zinc-600 tabular-nums">
                    {u.voucherNumber} — out by {u.difference}
                  </p>
                ))}
              </div>
            )}

            {pre.suspense.length > 0 && (
              <div className="mt-2">
                {/* A ledger landing in Suspense is a mapping the accounts team
                    should see before the file reaches their CA, not after. */}
                <p className="text-xs font-medium text-amber-800">
                  These have no Tally group and would land in Suspense A/c:
                </p>
                {pre.suspense.map(s => (
                  <p key={s.name} className="text-[11px] text-zinc-600">{s.name} ({s.accountType})</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
