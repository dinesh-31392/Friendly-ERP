import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  KeyRound, Plus, X, IndianRupee, CalendarClock, Receipt, Wallet,
  CheckCircle2, AlertTriangle, RefreshCw, ShieldCheck,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { apiGetUnits, apiGetTowers } from '../services/apiClient';
import {
  isLeasingAvailable, fetchLeases, createLease, patchLease,
  fetchOccupants, createOccupant, fetchLeaseInvoices, fetchMaintenanceBills,
  runBilling, generateLeaseInvoices, recordReceipt,
  fetchOwnerPayouts, generateOwnerPayouts, patchOwnerPayout,
  type Lease, type Occupant, type LeaseInvoice, type MaintenanceBill, type OwnerPayout,
} from '../services/leasingService';
import type { Unit, Tower } from '../types';
import { formatCurrency } from '../utils/format';

/**
 * Leasing — the rental side of the portfolio (server migration 036).
 *
 * Deliberately API-only. See services/leasingService.ts for why there is no
 * localStorage twin: the money rules here (idempotent generation, compounding
 * escalation, a payout that freezes on approval) live in Postgres, and a
 * browser imitation would look right while being wrong.
 */

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  active: 'bg-emerald-50 text-emerald-700',
  terminated: 'bg-red-50 text-red-700',
  expired: 'bg-amber-50 text-amber-700',
  renewed: 'bg-indigo-50 text-indigo-700',
  pending: 'bg-amber-50 text-amber-700',
  partially_paid: 'bg-blue-50 text-blue-700',
  paid: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-zinc-100 text-zinc-500',
  waived: 'bg-zinc-100 text-zinc-500',
  approved: 'bg-indigo-50 text-indigo-700',
  on_hold: 'bg-orange-50 text-orange-700',
};

const Pill = ({ value }: { value: string }) => (
  <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLES[value] || 'bg-zinc-100 text-zinc-600'}`}>
    {value.replace(/_/g, ' ')}
  </span>
);

type Tab = 'leases' | 'invoices' | 'cam' | 'payouts';

export default function Leasing() {
  const { tenant, hasPermission } = useAuth();
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_leasing');
  const canViewPayouts = hasPermission('view_owner_payouts');
  const canManagePayouts = hasPermission('manage_owner_payouts');
  // The checker's right. Separate from manage_* on purpose — the person who
  // prepares an owner statement must not be the one who releases the money.
  const canApprovePayouts = hasPermission('approve_owner_payouts');

  const [tab, setTab] = useState<Tab>('leases');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [leases, setLeases] = useState<Lease[]>([]);
  const [occupants, setOccupants] = useState<Occupant[]>([]);
  const [invoices, setInvoices] = useState<LeaseInvoice[]>([]);
  const [camBills, setCamBills] = useState<MaintenanceBill[]>([]);
  const [payouts, setPayouts] = useState<OwnerPayout[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [towers, setTowers] = useState<Tower[]>([]);

  const [showLeaseForm, setShowLeaseForm] = useState(false);
  const [showOccupantForm, setShowOccupantForm] = useState(false);

  const available = isLeasingAvailable();

  const load = useCallback(async () => {
    if (!available) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [l, o, i, c, u, t] = await Promise.all([
        fetchLeases(), fetchOccupants(), fetchLeaseInvoices(), fetchMaintenanceBills(),
        apiGetUnits(), apiGetTowers(),
      ]);
      setLeases(l); setOccupants(o); setInvoices(i); setCamBills(c); setUnits(u); setTowers(t);
      // Payouts are a separate permission: a letting executive may hold
      // manage_leasing and legitimately get a 403 here. That is not an error
      // worth showing them, so it is fetched apart and failure is silent.
      if (canViewPayouts) {
        try { setPayouts(await fetchOwnerPayouts()); } catch { /* not permitted */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load leasing data');
    } finally {
      setLoading(false);
    }
  }, [available, canViewPayouts]);

  useEffect(() => { void load(); }, [load]);

  const unitLabel = useCallback((unitId: string) => {
    const u = units.find(x => x.id === unitId);
    if (!u) return '—';
    const tw = towers.find(t => t.id === u.towerId);
    return `${tw ? `${tw.name} · ` : ''}${u.number}`;
  }, [units, towers]);

  const occupantName = useCallback(
    (id: string) => occupants.find(o => o.id === id)?.name || '—',
    [occupants],
  );
  const leaseCode = useCallback(
    (id: string) => leases.find(l => l.id === id)?.leaseCode || '—',
    [leases],
  );

  // ── Headline numbers ───────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const active = leases.filter(l => l.status === 'active');
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 90);
    const expiring = active.filter(l => new Date(l.endDate) <= horizon);
    const outstanding = invoices
      .filter(i => i.status === 'pending' || i.status === 'partially_paid')
      .reduce((s, i) => s + (i.totalAmount - i.amountPaid), 0);
    const monthlyRent = active.reduce((s, l) => s + l.rentAmount, 0);
    const duePayouts = payouts
      .filter(p => p.status !== 'paid')
      .reduce((s, p) => s + p.netPayable, 0);
    return { active: active.length, expiring: expiring.length, outstanding, monthlyRent, duePayouts };
  }, [leases, invoices, payouts]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const doRunBilling = async () => {
    setBusy(true);
    try {
      const r = await runBilling();
      // The server returns only what it NEWLY raised, so "0" is a true and
      // useful answer — it means this month is already billed, not that
      // something failed.
      toast.success(
        r.rentInvoicesCreated || r.maintenanceBillsCreated
          ? `Raised ${r.rentInvoicesCreated} rent invoice(s) and ${r.maintenanceBillsCreated} CAM bill(s)`
          : 'Already up to date — nothing new to bill',
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Billing run failed');
    } finally { setBusy(false); }
  };

  const doGenerateForLease = async (lease: Lease) => {
    setBusy(true);
    try {
      const r = await generateLeaseInvoices(lease.id);
      toast.success(r.created ? `Raised ${r.created} invoice(s) for ${lease.leaseCode}` : 'Already up to date');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate invoices');
    } finally { setBusy(false); }
  };

  const doActivate = async (lease: Lease) => {
    setBusy(true);
    try {
      await patchLease(lease.id, { status: 'active' });
      toast.success(`${lease.leaseCode} is now active`);
      await load();
    } catch (e) {
      // The 409 here is the letting lock — one active lease per unit.
      toast.error(e instanceof Error ? e.message : 'Could not activate the lease');
    } finally { setBusy(false); }
  };

  const doTerminate = async (lease: Lease) => {
    const reason = window.prompt(`Why is ${lease.leaseCode} being terminated?`);
    if (!reason) return;   // the server requires a reason; so do we
    setBusy(true);
    try {
      await patchLease(lease.id, { status: 'terminated', terminationReason: reason });
      toast.success(`${lease.leaseCode} terminated`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not terminate the lease');
    } finally { setBusy(false); }
  };

  const doRecordReceipt = async (inv: LeaseInvoice) => {
    const outstanding = inv.totalAmount - inv.amountPaid;
    const raw = window.prompt(`Amount received (outstanding ${formatCurrency(outstanding, currency)})`, String(outstanding));
    if (!raw) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) { toast.error('Enter a positive amount'); return; }
    setBusy(true);
    try {
      await recordReceipt({ leaseInvoiceId: inv.id, amount });
      toast.success(`Receipt of ${formatCurrency(amount, currency)} recorded`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the receipt');
    } finally { setBusy(false); }
  };

  const doGeneratePayouts = async () => {
    setBusy(true);
    try {
      const r = await generateOwnerPayouts({});
      toast.success(r.generated ? `${r.generated} owner statement(s) prepared` : 'No new collections to pay out');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare payouts');
    } finally { setBusy(false); }
  };

  const doPayoutStatus = async (p: OwnerPayout, status: OwnerPayout['status']) => {
    setBusy(true);
    try {
      await patchOwnerPayout(p.id, { status });
      toast.success(status === 'approved' ? 'Payout approved' : `Payout marked ${status}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the payout');
    } finally { setBusy(false); }
  };

  // ── Backend-required notice ────────────────────────────────────────────────
  if (!available) {
    return (
      <div className="p-6">
        <PageHeader />
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 p-8 text-center max-w-2xl">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />
          <h2 className="mt-3 text-lg font-semibold text-zinc-900">Leasing needs the server backend</h2>
          <p className="mt-2 text-sm text-zinc-600">
            Rent generation, CAM billing and owner payouts are enforced in PostgreSQL — invoices
            are raised idempotently, escalation compounds in SQL, and an approved payout is frozen
            by a database constraint. Running them in the browser demo store would show the same
            screens while getting the arithmetic wrong, so this module stays server-only.
          </p>
          <p className="mt-3 text-xs text-zinc-500">
            Connect an API in Settings → Integrations (or build with <code>VITE_API_URL</code>) to enable it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {canManage && (
            <>
              <button
                onClick={() => setShowOccupantForm(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                <Plus className="w-4 h-4" /> Occupant
              </button>
              <button
                onClick={() => void doRunBilling()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-900 text-white text-sm hover:bg-zinc-800 disabled:opacity-50"
              >
                <CalendarClock className="w-4 h-4" /> Run monthly billing
              </button>
              <button
                onClick={() => setShowLeaseForm(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700"
              >
                <Plus className="w-4 h-4" /> New lease
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Headline numbers */}
      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={KeyRound} label="Active leases" value={String(stats.active)} hint={`${stats.expiring} expiring in 90 days`} />
        <Stat icon={IndianRupee} label="Monthly rent roll" value={formatCurrency(stats.monthlyRent, currency)} />
        <Stat icon={Receipt} label="Rent outstanding" value={formatCurrency(stats.outstanding, currency)} tone={stats.outstanding > 0 ? 'warn' : undefined} />
        {canViewPayouts && <Stat icon={Wallet} label="Owed to owners" value={formatCurrency(stats.duePayouts, currency)} />}
      </div>

      {/* Tabs */}
      <div className="mt-6 border-b border-zinc-200 flex gap-1 overflow-x-auto">
        {([
          ['leases', 'Leases', leases.length],
          ['invoices', 'Rent invoices', invoices.length],
          ['cam', 'CAM bills', camBills.length],
          ...(canViewPayouts ? [['payouts', 'Owner payouts', payouts.length] as const] : []),
        ] as [Tab, string, number][]).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
              tab === key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {label} <span className="text-xs text-zinc-400">({count})</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="mt-8 text-sm text-zinc-500">Loading…</div>
      ) : (
        <div className="mt-4">
          {tab === 'leases' && (
            <Table
              head={['Lease', 'Unit', 'Occupant', 'Term', 'Rent', 'Status', '']}
              empty="No leases yet. Create one to start billing rent."
              rows={leases.map(l => [
                <span className="font-medium text-zinc-900">{l.leaseCode}</span>,
                unitLabel(l.unitId),
                occupantName(l.occupantId),
                <span className="whitespace-nowrap">{l.startDate} → {l.endDate}</span>,
                <span className="whitespace-nowrap">
                  {formatCurrency(l.rentAmount, currency)}
                  {l.escalationPercent > 0 && (
                    <span className="ml-1 text-xs text-zinc-400">+{l.escalationPercent}%/{l.escalationMonths}mo</span>
                  )}
                </span>,
                <Pill value={l.status} />,
                canManage ? (
                  <div className="flex justify-end gap-2">
                    {l.status === 'draft' && (
                      <RowBtn onClick={() => void doActivate(l)} disabled={busy}>Activate</RowBtn>
                    )}
                    {l.status === 'active' && (
                      <>
                        <RowBtn onClick={() => void doGenerateForLease(l)} disabled={busy}>Generate</RowBtn>
                        <RowBtn onClick={() => void doTerminate(l)} disabled={busy} tone="danger">Terminate</RowBtn>
                      </>
                    )}
                  </div>
                ) : null,
              ])}
            />
          )}

          {tab === 'invoices' && (
            <Table
              head={['Lease', 'Period', 'Due', 'Rent', 'CAM', 'Total', 'Paid', 'Status', '']}
              empty="No rent invoices yet. Run the monthly billing to raise them."
              rows={invoices.map(i => [
                leaseCode(i.leaseId),
                <span className="whitespace-nowrap">{i.periodStart} → {i.periodEnd}</span>,
                i.dueDate,
                formatCurrency(i.rentAmount, currency),
                formatCurrency(i.camAmount, currency),
                <span className="font-medium">{formatCurrency(i.totalAmount, currency)}</span>,
                formatCurrency(i.amountPaid, currency),
                <Pill value={i.status} />,
                canManage && i.status !== 'paid' && i.status !== 'cancelled' ? (
                  <div className="flex justify-end">
                    <RowBtn onClick={() => void doRecordReceipt(i)} disabled={busy}>Receipt</RowBtn>
                  </div>
                ) : null,
              ])}
            />
          )}

          {tab === 'cam' && (
            <Table
              head={['Unit', 'Lease', 'Billed to', 'Period', 'Rate/sqft', 'Amount', 'Status']}
              empty="No maintenance bills. Owner-billed CAM is raised by the monthly run; occupant CAM rides on the rent invoice."
              rows={camBills.map(b => [
                unitLabel(b.unitId),
                b.leaseId ? leaseCode(b.leaseId) : '—',
                <span className="capitalize">{b.billTo}</span>,
                <span className="whitespace-nowrap">{b.periodStart} → {b.periodEnd}</span>,
                formatCurrency(b.ratePerSqft, currency),
                <span className="font-medium">{formatCurrency(b.amount, currency)}</span>,
                <Pill value={b.status} />,
              ])}
            />
          )}

          {tab === 'payouts' && canViewPayouts && (
            <>
              <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-zinc-500 max-w-2xl">
                  Statements are computed from rent actually <strong>collected</strong>, never from rent
                  invoiced. A pending statement follows the money; once approved it is frozen.
                </p>
                {canManagePayouts && (
                  <button
                    onClick={() => void doGeneratePayouts()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    <Wallet className="w-4 h-4" /> Prepare statements
                  </button>
                )}
              </div>
              <Table
                head={['Lease', 'Period', 'Collected', 'Mgmt fee', 'Deductions', 'Net payable', 'Status', '']}
                empty="No owner statements yet."
                rows={payouts.map(p => [
                  leaseCode(p.leaseId),
                  <span className="whitespace-nowrap">{p.periodStart} → {p.periodEnd}</span>,
                  formatCurrency(p.grossCollected, currency),
                  <span className="whitespace-nowrap">
                    {formatCurrency(p.managementFeeAmount, currency)}
                    <span className="ml-1 text-xs text-zinc-400">{p.managementFeePercent}%</span>
                  </span>,
                  formatCurrency(p.otherDeductions, currency),
                  <span className="font-medium text-zinc-900">{formatCurrency(p.netPayable, currency)}</span>,
                  <Pill value={p.status} />,
                  <div className="flex justify-end gap-2">
                    {p.status === 'pending' && canApprovePayouts && (
                      <RowBtn onClick={() => void doPayoutStatus(p, 'approved')} disabled={busy}>Approve</RowBtn>
                    )}
                    {p.status === 'approved' && canApprovePayouts && (
                      <RowBtn onClick={() => void doPayoutStatus(p, 'paid')} disabled={busy}>Mark paid</RowBtn>
                    )}
                    {p.status === 'pending' && !canApprovePayouts && (
                      <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
                        <ShieldCheck className="w-3.5 h-3.5" /> needs approval
                      </span>
                    )}
                  </div>,
                ])}
              />
            </>
          )}
        </div>
      )}

      {showOccupantForm && (
        <OccupantForm
          onClose={() => setShowOccupantForm(false)}
          onSaved={async () => { setShowOccupantForm(false); await load(); }}
        />
      )}
      {showLeaseForm && (
        <LeaseForm
          units={units}
          towers={towers}
          occupants={occupants}
          onClose={() => setShowLeaseForm(false)}
          onSaved={async () => { setShowLeaseForm(false); await load(); }}
        />
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-zinc-900 flex items-center gap-2">
        <KeyRound className="w-6 h-6 text-indigo-600" /> Leasing
      </h1>
      <p className="text-sm text-zinc-500 mt-1">
        Leases, rent invoicing, CAM charges and owner payouts for the rental portfolio.
      </p>
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint, tone }: {
  icon: React.ElementType; label: string; value: string; hint?: string; tone?: 'warn';
}) {
  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4">
      <div className="flex items-center gap-2 text-zinc-500 text-xs font-medium uppercase tracking-wide">
        <Icon className="w-4 h-4" /> {label}
      </div>
      <div className={`mt-2 text-xl font-semibold ${tone === 'warn' ? 'text-amber-600' : 'text-zinc-900'}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-400">{hint}</div>}
    </div>
  );
}

function RowBtn({ children, onClick, disabled, tone }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 rounded-md text-xs font-medium border disabled:opacity-40 ${
        tone === 'danger'
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
      }`}
    >
      {children}
    </button>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) {
    return (
      <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center text-sm text-zinc-500">
        {empty}
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-200">
            {head.map((h, i) => <th key={i} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-zinc-50/60">
              {r.map((cell, j) => <td key={j} className="px-4 py-3 text-zinc-700 align-middle">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl w-full max-w-2xl mt-10 shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200">
          <h2 className="font-semibold text-zinc-900">{title}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100"><X className="w-5 h-5 text-zinc-500" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const field = 'w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30';
const labelCls = 'block text-xs font-medium text-zinc-600 mb-1';

function OccupantForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      await createOccupant({ name: name.trim(), phone: phone.trim(), email: email.trim() || undefined });
      toast.success('Occupant added');
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the occupant');
    } finally { setSaving(false); }
  };

  return (
    <Modal title="New occupant" onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div><label className={labelCls}>Name *</label><input className={field} value={name} onChange={e => setName(e.target.value)} /></div>
        <div><label className={labelCls}>Phone</label><input className={field} value={phone} onChange={e => setPhone(e.target.value)} /></div>
        <div><label className={labelCls}>Email</label><input className={field} value={email} onChange={e => setEmail(e.target.value)} /></div>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        An <em>occupant</em> is the renter. Buyers stay in Customers — the word “tenant” is reserved
        for the subscribing company, which is what every isolation rule keys on.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-zinc-200 text-sm">Cancel</button>
        <button onClick={() => void submit()} disabled={saving} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Add occupant'}
        </button>
      </div>
    </Modal>
  );
}

function LeaseForm({ units, towers, occupants, onClose, onSaved }: {
  units: Unit[]; towers: Tower[]; occupants: Occupant[];
  onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [unitId, setUnitId] = useState('');
  const [occupantId, setOccupantId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rentAmount, setRentAmount] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [escalationPercent, setEscalationPercent] = useState('0');
  const [escalationMonths, setEscalationMonths] = useState('12');
  const [camRatePerSqft, setCamRatePerSqft] = useState('0');
  const [camBilledTo, setCamBilledTo] = useState<'occupant' | 'owner'>('occupant');
  const [managementFeePercent, setManagementFeePercent] = useState('0');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!unitId || !occupantId || !startDate || !endDate || !rentAmount) {
      toast.error('Unit, occupant, both dates and rent are required'); return;
    }
    setSaving(true);
    try {
      await createLease({
        unitId, occupantId, startDate, endDate,
        rentAmount: Number(rentAmount),
        depositAmount: Number(depositAmount) || 0,
        escalationPercent: Number(escalationPercent) || 0,
        escalationMonths: Number(escalationMonths) || 12,
        camRatePerSqft: Number(camRatePerSqft) || 0,
        camBilledTo,
        managementFeePercent: Number(managementFeePercent) || 0,
      });
      toast.success('Lease created as a draft — activate it to start billing');
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the lease');
    } finally { setSaving(false); }
  };

  const unitName = (u: Unit) => {
    const tw = towers.find(t => t.id === u.towerId);
    return `${tw ? `${tw.name} · ` : ''}${u.number}${u.area ? ` (${u.area} sqft)` : ''}`;
  };

  return (
    <Modal title="New lease" onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Unit *</label>
          <select className={field} value={unitId} onChange={e => setUnitId(e.target.value)}>
            <option value="">Select a unit…</option>
            {units.map(u => <option key={u.id} value={u.id}>{unitName(u)}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Occupant *</label>
          <select className={field} value={occupantId} onChange={e => setOccupantId(e.target.value)}>
            <option value="">Select an occupant…</option>
            {occupants.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          {!occupants.length && <p className="mt-1 text-xs text-amber-600">Add an occupant first.</p>}
        </div>
        <div><label className={labelCls}>Start date *</label><input type="date" className={field} value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
        <div><label className={labelCls}>End date *</label><input type="date" className={field} value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
        <div><label className={labelCls}>Monthly rent *</label><input type="number" min="0" className={field} value={rentAmount} onChange={e => setRentAmount(e.target.value)} /></div>
        <div><label className={labelCls}>Security deposit</label><input type="number" min="0" className={field} value={depositAmount} onChange={e => setDepositAmount(e.target.value)} /></div>
        <div>
          <label className={labelCls}>Escalation %</label>
          <input type="number" min="0" max="100" className={field} value={escalationPercent} onChange={e => setEscalationPercent(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>…every N months</label>
          <input type="number" min="1" className={field} value={escalationMonths} onChange={e => setEscalationMonths(e.target.value)} />
        </div>
        <div><label className={labelCls}>CAM rate / sqft / month</label><input type="number" min="0" className={field} value={camRatePerSqft} onChange={e => setCamRatePerSqft(e.target.value)} /></div>
        <div>
          <label className={labelCls}>CAM billed to</label>
          <select className={field} value={camBilledTo} onChange={e => setCamBilledTo(e.target.value as 'occupant' | 'owner')}>
            <option value="occupant">Occupant (added to the rent invoice)</option>
            <option value="owner">Owner (separate maintenance bill)</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Management fee %</label>
          <input type="number" min="0" max="100" className={field} value={managementFeePercent} onChange={e => setManagementFeePercent(e.target.value)} />
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-500 flex items-start gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
        Escalation compounds: 10% every 3 months turns ₹40,000 into ₹44,000, then ₹48,400.
        The lease is created as a <strong>draft</strong>; only an active lease bills, and only one
        lease can be active per unit.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-zinc-200 text-sm">Cancel</button>
        <button onClick={() => void submit()} disabled={saving} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Create lease'}
        </button>
      </div>
    </Modal>
  );
}
