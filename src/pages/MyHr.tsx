import { useState, useEffect, useMemo } from 'react';
import { UserCheck, CalendarDays, Wallet, Loader2, Info } from 'lucide-react';
import { isApiEnabled, apiGetMyHr, type ApiMyHr } from '../services/apiClient';
import { formatCurrency } from '../utils/format';
import { useAuth } from '../context/AuthContext';

/**
 * A person's own attendance, leave and payslips.
 *
 * WHY THIS PAGE EXISTS
 *
 * Every HR screen was behind view_hr, which three of the ten roles hold. So a
 * sales executive, a telecaller, an accountant, a land manager and a BD
 * manager could not see their own attendance, their own leave balance or their
 * own payslip. Their data was in the product and closed to them.
 *
 * It is deliberately NOT the HR page with a filter. The HR page is a desk that
 * manages other people; this is one record, read-only, and the server scopes it
 * by the session rather than by an id in the URL — so there is nothing here to
 * tamper with.
 */

const STATUS_STYLE: Record<string, string> = {
  approved: 'bg-emerald-50 text-emerald-700',
  pending:  'bg-amber-50 text-amber-700',
  rejected: 'bg-red-50 text-red-600',
};

export default function MyHr() {
  const { tenant } = useAuth();
  const currency = tenant?.currency || 'INR';
  const [data, setData] = useState<ApiMyHr | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isApiEnabled()) { setLoading(false); return; }
    let cancelled = false;
    apiGetMyHr()
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const thisMonth = useMemo(() => {
    const m = new Date().toISOString().slice(0, 7);
    return (data?.attendance ?? []).filter(a => (a.date ?? '').startsWith(m)).length;
  }, [data]);

  if (!isApiEnabled()) {
    return (
      <div className="max-w-[900px] bg-white rounded-2xl border border-zinc-200/60 py-16 text-center">
        <UserCheck className="h-9 w-9 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-zinc-700">Your HR record needs the API</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-[900px] bg-white rounded-2xl border border-zinc-200/60 py-16 flex justify-center">
        <Loader2 className="h-6 w-6 text-zinc-300 animate-spin" />
      </div>
    );
  }

  const emp = data?.employee;

  return (
    <div className="space-y-6 max-w-[900px]">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">My Attendance &amp; Pay</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          Your own record. Nobody else&apos;s figures appear here, and nobody else sees yours.
        </p>
      </div>

      {!emp ? (
        // A real state, not an error: plenty of accounts are not employees.
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 flex items-start gap-3">
          <Info className="h-5 w-5 text-zinc-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-zinc-800">No employee record is linked to your account</p>
            <p className="text-xs text-zinc-500 mt-1">
              {data?.note ?? 'Ask HR to link your employee record to this login, and your attendance and payslips will appear here.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="text-lg font-semibold text-zinc-900">{emp.name}</p>
                <p className="text-sm text-zinc-500">
                  {[emp.designation, emp.department].filter(Boolean).join(' · ') || 'No designation recorded'}
                </p>
                {emp.joinDate && (
                  <p className="text-[11px] text-zinc-400 mt-1">
                    Joined {new Date(emp.joinDate).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold text-zinc-500 uppercase">
                  {emp.type === 'contract_worker' ? 'Daily wage' : 'Monthly salary'}
                </p>
                <p className="text-xl font-bold text-zinc-900 tabular-nums">
                  {emp.type === 'contract_worker'
                    ? (emp.dailyWage ? formatCurrency(emp.dailyWage, currency) : '—')
                    : (emp.monthlySalary ? formatCurrency(emp.monthlySalary, currency) : '—')}
                </p>
                <p className="text-[11px] text-zinc-400 mt-0.5 tabular-nums">
                  {thisMonth} day{thisMonth === 1 ? '' : 's'} recorded this month
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
              <div className="px-5 py-4 border-b border-zinc-100">
                <h2 className="font-semibold text-zinc-900 flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-zinc-400" /> Attendance
                </h2>
              </div>
              {(data?.attendance ?? []).length === 0 ? (
                <div className="py-12 text-center text-sm text-zinc-400">Nothing recorded yet</div>
              ) : (
                <div className="divide-y divide-zinc-50 max-h-80 overflow-y-auto">
                  {(data?.attendance ?? []).map(a => (
                    <div key={a.id} className="px-5 py-2.5 flex items-center justify-between gap-3">
                      <span className="text-sm text-zinc-700 tabular-nums">
                        {a.date ? new Date(a.date).toLocaleDateString() : '—'}
                      </span>
                      <span className="text-[11px] text-zinc-500 tabular-nums">
                        {a.checkIn || '—'}{a.checkOut ? ` → ${a.checkOut}` : ''}
                      </span>
                      <span className="text-[10px] text-zinc-400 uppercase">{a.method}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
              <div className="px-5 py-4 border-b border-zinc-100">
                <h2 className="font-semibold text-zinc-900 flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-zinc-400" /> Payslips
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  A month appears once payroll is processed — a draft is still being worked on.
                </p>
              </div>
              {(data?.payslips ?? []).length === 0 ? (
                <div className="py-12 text-center text-sm text-zinc-400">No processed payslips yet</div>
              ) : (
                <div className="divide-y divide-zinc-50 max-h-80 overflow-y-auto">
                  {(data?.payslips ?? []).map(p => (
                    <div key={p.month} className="px-5 py-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{p.month}</p>
                        {p.basis && <p className="text-[11px] text-zinc-400">{p.basis}</p>}
                      </div>
                      <span className="text-sm font-semibold text-zinc-900 tabular-nums">
                        {p.gross !== undefined ? formatCurrency(p.gross, currency) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100">
              <h2 className="font-semibold text-zinc-900">Leave</h2>
            </div>
            {(data?.leave ?? []).length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-400">No leave requested</div>
            ) : (
              <div className="divide-y divide-zinc-50">
                {(data?.leave ?? []).map(l => (
                  <div key={l.id} className="px-5 py-3 flex items-center gap-4 flex-wrap">
                    <div className="flex-1 min-w-[160px]">
                      <p className="text-sm font-medium text-zinc-900 capitalize">
                        {l.type} · {l.days} day{l.days === 1 ? '' : 's'}
                      </p>
                      <p className="text-[11px] text-zinc-400 tabular-nums">{l.from} → {l.to}</p>
                      {l.reason && <p className="text-xs text-zinc-500 mt-0.5">{l.reason}</p>}
                    </div>
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${
                      STATUS_STYLE[l.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {l.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
