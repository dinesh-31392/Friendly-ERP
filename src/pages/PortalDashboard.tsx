import { useState, useMemo, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
  Building2, LogOut, Home, FileText, CreditCard, Wrench, Plus,
  Handshake, Users, IndianRupee, CheckCircle2, Clock,
} from 'lucide-react';
import { getPortalUser, portalLogout, getPortalSession } from '../services/portalService';
import { isApiEnabled, apiPortalOverview, apiPortalRaiseTicket, apiPortalSubmitLead, type ApiPortalOverview } from '../services/apiClient';
import { getSchedulesForLead, isOverdue } from '../services/paymentService';
import { getByTenant, create, update } from '../services/db';
import { formatCurrency, formatCurrencyFull } from '../utils/format';
import type {
  Booking, Unit, Tower, Invoice, Document, Ticket, Lead, Commission, Broker, Project, Installment, PaymentPlan,
} from '../types';
import toast from 'react-hot-toast';
import { BRAND } from '../config/brand';

/** The union the page renders — either the customer half or the partner half.
 *  Demo mode builds it from the local store; API mode from the server overview. */
type PortalView = {
  lead?: Lead; bookings?: Booking[]; units?: Unit[]; towers?: Tower[];
  invoices?: Invoice[]; documents?: Document[]; tickets?: Ticket[];
  projects: Project[]; schedules?: PaymentPlan[];
  broker?: Broker; commissions?: Commission[]; referredLeads?: Lead[];
};

/**
 * Adapt the server overview to the page's view model. The server already
 * restricted every list to this account, so nothing is filtered here — this is
 * shape translation only.
 *
 * `invoices` has no server-side table: the Postgres model expresses receivables
 * as payment_schedules + payments, which arrive as `schedules`. The invoice
 * card therefore renders empty in API mode rather than showing stale local rows.
 */
function mapOverview(o: ApiPortalOverview): PortalView {
  const projects = (o.projects ?? []).map(p => ({ id: p.id, name: p.name, location: p.location } as Project));
  if (o.role === 'partner') {
    return {
      broker: o.broker ? ({
        id: o.broker.id, name: o.broker.name, phone: o.broker.phone, email: o.broker.email,
        // Carried through so the summary tiles show numbers rather than the
        // word "undefined". These were absent from both the server payload and
        // this mapper, which is why the partner portal read as blank.
        commissionRate: o.broker.commissionRate ?? undefined,
        leadsReferred: o.broker.leadsReferred ?? 0,
        bookingsClosed: o.broker.bookingsClosed ?? 0,
      } as unknown as Broker) : undefined,
      commissions: (o.commissions ?? []).map(c => ({
        id: c.id, bookingId: c.bookingId ?? '', amount: c.amountEarned,
        amountPaid: c.amountPaid, status: c.status,
        // bookingValue was the crash: the statement formats it as currency and
        // the mapper never set it, so formatCurrency was handed undefined.
        leadName: c.leadName ?? '', project: c.project ?? '',
        bookingValue: c.bookingValue ?? 0, rate: c.rate ?? undefined,
      } as unknown as Commission)),
      referredLeads: (o.referredLeads ?? []).map(l => ({
        id: l.id, name: l.name, phone: l.phone, project: l.project,
        stage: l.stage, budget: l.budget, createdAt: l.createdAt,
      } as Lead)),
      projects,
    };
  }
  return {
    lead: o.lead ? ({ id: o.lead.id, name: o.lead.name, project: o.lead.project, stage: o.lead.stage } as Lead) : undefined,
    bookings: (o.bookings ?? []).map(b => ({
      id: b.id, unitId: b.unitId ?? '', bookingAmount: b.bookingAmount,
      totalConsideration: b.totalConsideration, status: b.status,
      paymentPlan: b.paymentPlan ?? '',
    } as unknown as Booking)),
    // Field names are the SPA's Unit type — `number`, `area`, `floorNumber` —
    // not the server's unitCode/areaSqft/floor. They were mapped under the
    // server's names and cast through `as unknown as Unit`, so the booking card
    // has been rendering "Unit " with nothing after it and " sqft" with no
    // figure for as long as API mode has existed. The cast is what let it
    // compile; nothing but reading the page would have caught it.
    units: (o.units ?? []).map(u => ({
      id: u.id, towerId: u.towerId ?? '', projectId: u.projectId ?? '',
      number: u.unitCode, configuration: u.configuration,
      floorNumber: u.floor, area: u.areaSqft, status: u.status,
    } as unknown as Unit)),
    towers: (o.towers ?? []).map(t => ({ id: t.id, name: t.name, projectId: t.projectId ?? '' } as Tower)),
    invoices: [],
    documents: (o.documents ?? []).map(d => ({
      id: d.id, name: d.name, type: d.type, project: d.project,
      date: d.docDate, size: d.size, status: d.status, url: d.url ?? undefined,
    } as unknown as Document)),
    tickets: (o.tickets ?? []).map(t => ({
      id: t.id, title: t.title, category: t.category, priority: t.priority,
      status: t.status, project: t.project, createdAt: t.createdAt,
    } as unknown as Ticket)),
    projects,
    // The page flatMaps plans → installments, so the server's flat schedule is
    // wrapped in one synthetic plan per booking.
    schedules: Object.entries(
      (o.schedule ?? []).reduce((acc, s) => {
        (acc[s.bookingId] ||= []).push({
          id: s.id, number: s.sequence, amount: s.amount, dueDate: s.dueDate,
          status: s.status as Installment['status'], description: s.milestoneName,
        });
        return acc;
      }, {} as Record<string, Installment[]>)
    ).map(([bookingId, installments]) => ({ id: bookingId, bookingId, installments } as unknown as PaymentPlan)),
  };
}

export default function PortalDashboard() {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [showLeadForm, setShowLeadForm] = useState(false);

  const session = useMemo(() => getPortalUser(), [refreshKey]);

  // All hooks must run before any early return
  const tenantId = session?.tenant.id || '';
  const role = session?.portalUser.role;
  const leadId = session?.portalUser.leadId;
  const brokerId = session?.portalUser.brokerId;

  // API mode: the server assembles the caller's own slice (and nothing else) —
  // every query there is pinned to this account's lead_id / broker_id, so the
  // ownership filtering below is not the security boundary, the server is.
  const [apiData, setApiData] = useState<PortalView | null>(null);
  const [apiLoading, setApiLoading] = useState(isApiEnabled());
  useEffect(() => {
    if (!isApiEnabled()) return;
    const token = getPortalSession()?.token;
    if (!token) { setApiLoading(false); return; }
    let cancelled = false;
    apiPortalOverview(token)
      .then(o => { if (!cancelled) setApiData(mapOverview(o)); })
      .catch(() => {
        if (cancelled) return;
        // A 401 here means the account was deactivated or the token expired —
        // drop the local session rather than showing a stale shell.
        portalLogout();
        toast.error('Your session has ended — please sign in again');
        navigate('/portal');
      })
      .finally(() => { if (!cancelled) setApiLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, navigate]);

  const data = useMemo(() => {
    if (!session) return null;
    if (isApiEnabled()) return apiData;
    if (role === 'customer') {
      const lead = getByTenant<Lead>('leads', tenantId).find(l => l.id === leadId);
      const bookings = getByTenant<Booking>('bookings', tenantId).filter(b => b.leadId === leadId);
      const units = getByTenant<Unit>('units', tenantId);
      const towers = getByTenant<Tower>('towers', tenantId);
      const invoices = getByTenant<Invoice>('invoices', tenantId).filter(i => i.leadId === leadId);
      // Show the customer's own documents, plus project-level documents —
      // never another customer's personal papers (agreements, quotes, plans).
      // Personal docs follow the "<Type> - <Full Name>" convention; match on
      // an EXACT name segment, not substring (a customer named "Ana" must
      // not see "Ana Maria"'s papers).
      const PERSONAL_DOC_TYPES = ['Agreement', 'Quotation', 'Payment Plan'];
      const ownName = (lead?.name || '').trim().toLowerCase();
      const nameSegmentMatch = (docName: string) =>
        !!ownName && docName.toLowerCase().split(' - ').some(seg => seg.trim() === ownName);
      const documents = getByTenant<Document>('documents', tenantId)
        .filter(d => lead && (
          nameSegmentMatch(d.name) ||
          (d.project === lead.project && !PERSONAL_DOC_TYPES.includes(d.type))
        ));
      // Tickets: identity-safe link via leadId; name match only for legacy
      // rows that predate the leadId column
      const tickets = getByTenant<Ticket>('tickets', tenantId)
        .filter(t => lead && (t.leadId ? t.leadId === lead.id : t.customer === lead.name));
      const projects = getByTenant<Project>('projects', tenantId);
      const schedules = leadId ? getSchedulesForLead(tenantId, leadId) : [];
      return { lead, bookings, units, towers, invoices, documents, tickets, projects, schedules };
    }
    // partner — referred leads matched by brokerId (identity-safe); source
    // name only for legacy rows created before brokerId existed
    const broker = getByTenant<Broker>('brokers', tenantId).find(b => b.id === brokerId);
    const commissions = getByTenant<Commission>('commissions', tenantId).filter(c => c.brokerId === brokerId);
    const referredLeads = getByTenant<Lead>('leads', tenantId)
      .filter(l => l.brokerId ? l.brokerId === brokerId : (broker && l.source === broker.name));
    const projects = getByTenant<Project>('projects', tenantId);
    return { broker, commissions, referredLeads, projects };
  }, [session, role, tenantId, leadId, brokerId, refreshKey, apiData]);

  if (!session) {
    // Not signed in (or session expired) — bounce to the portal login
    return <Navigate to="/portal" replace />;
  }
  if (!data) {
    // In API mode the first paint happens before the overview lands.
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <p className="text-sm text-zinc-500">{apiLoading ? 'Loading your portal…' : 'Nothing to show yet.'}</p>
      </div>
    );
  }

  const { tenant, portalUser } = session;
  const brandColor = tenant.primaryColor || '#6366f1';
  const currency = tenant.currency || 'INR';

  const handleLogout = () => {
    portalLogout();
    navigate('/portal');
  };

  const handleRaiseTicket = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = fd.get('title') as string;
    if (!title || !data.lead) { toast.error('Describe the issue'); return; }
    const category = (fd.get('category') as string) || 'Request';
    try {
      if (isApiEnabled()) {
        const token = getPortalSession()?.token;
        if (!token) throw new Error('Your session has ended — please sign in again');
        // The server takes lead/customer/project from the account, not the body.
        await apiPortalRaiseTicket(token, { title, category });
      } else {
        create<Ticket>('tickets', {
          id: '', tenantId, title,
          leadId: data.lead.id,
          customer: data.lead.name, project: data.lead.project,
          category, priority: 'medium', status: 'open', assignedTo: '',
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit your request');
      return;
    }
    setShowTicketForm(false);
    refresh();
    toast.success('Request submitted — our team will get back to you');
  };

  const handleSubmitLead = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const phone = fd.get('phone') as string;
    if (!name || !phone || !data.broker) { toast.error('Name and phone are required'); return; }
    const project = (fd.get('project') as string) || data.projects[0]?.name || 'General Enquiry';
    try {
      if (isApiEnabled()) {
        const token = getPortalSession()?.token;
        if (!token) throw new Error('Your session has ended — please sign in again');
        // Attribution is pinned to the caller's own broker record server-side —
        // a partner cannot credit the referral to anyone else.
        await apiPortalSubmitLead(token, {
          name, phone, email: (fd.get('email') as string) || undefined,
          project, budget: Number(fd.get('budget')) || 0,
        });
      } else {
        create<Lead>('leads', {
          id: '', tenantId, name, phone,
          email: (fd.get('email') as string) || '',
          source: data.broker.name,     // display attribution
          brokerId: data.broker.id,     // identity-safe attribution
          project,
          budget: Number(fd.get('budget')) || 0,
          configuration: '2 BHK', stage: 'new', priority: 'warm',
          assignedTo: '', lastContact: new Date().toISOString(), createdAt: new Date().toISOString(),
        });
        // Keep the aggregate stat in sync so it isn't double-counted in the UI.
        // In API mode the count is derived from referredLeads, so there is
        // nothing to bump.
        update<Broker>('brokers', data.broker.id, { leadsReferred: (data.broker.leadsReferred || 0) + 1 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit the lead');
      return;
    }
    setShowLeadForm(false);
    refresh();
    toast.success('Lead submitted — thank you! Commission applies on booking.');
  };

  const invoiceColors: Record<string, string> = {
    Paid: 'bg-emerald-50 text-emerald-700', Pending: 'bg-amber-50 text-amber-700',
    Generated: 'bg-blue-50 text-blue-700', Overdue: 'bg-red-50 text-red-600',
  };
  const commissionColors: Record<string, string> = {
    paid: 'bg-emerald-50 text-emerald-700', approved: 'bg-blue-50 text-blue-700', pending: 'bg-amber-50 text-amber-700',
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Branded header */}
      <header className="bg-white border-b border-zinc-200 px-4 lg:px-8 py-3 flex items-center gap-3 sticky top-0 z-10">
        {tenant.logo ? (
          <img src={tenant.logo} alt={tenant.name} className="h-9 w-9 rounded-xl object-cover" />
        ) : (
          <div className="h-9 w-9 rounded-xl flex items-center justify-center" style={{ background: brandColor }}>
            <Building2 className="h-5 w-5 text-white" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-zinc-900 truncate">{tenant.name}</p>
          <p className="text-[11px] text-zinc-500">
            {role === 'customer' ? 'Customer Portal' : 'Channel Partner Portal'}
          </p>
        </div>
        <div className="text-right hidden sm:block">
          <p className="text-sm font-medium text-zinc-800">{portalUser.name}</p>
          <p className="text-[11px] text-zinc-400 capitalize">{role}</p>
        </div>
        <button onClick={handleLogout} className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500" title="Sign out">
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      <main className="max-w-4xl mx-auto p-4 lg:p-8 space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Hello, {portalUser.name.split(' ')[0]} 👋</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {role === 'customer'
              ? 'Track your booking, payments, and documents — all in one place.'
              : 'Track your referrals, commissions, and submit new leads.'}
          </p>
        </div>

        {/* ── CUSTOMER PORTAL ── */}
        {role === 'customer' && (
          <>
            {/* Bookings */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <h3 className="font-semibold text-zinc-900 mb-3 flex items-center gap-2">
                <Home className="h-4 w-4" style={{ color: brandColor }} /> My Booking
              </h3>
              {data.bookings!.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">No bookings yet — your reserved units will appear here.</p>
              ) : data.bookings!.map(b => {
                const unit = data.units!.find(u => u.id === b.unitId);
                const tower = unit && data.towers!.find(t => t.id === unit.towerId);
                return (
                  <div key={b.id} className="flex items-center gap-4 p-4 rounded-xl border border-zinc-100 bg-zinc-50/50">
                    <div className="h-12 w-12 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: brandColor }}>
                      {unit?.number || '—'}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-zinc-900">
                        {data.lead?.project} · {tower?.name || ''} · Unit {unit?.number}
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {unit?.configuration} · {unit?.area} sqft · Payment plan {b.paymentPlan}
                      </p>
                    </div>
                    <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 capitalize">{b.stage}</span>
                  </div>
                );
              })}
            </section>

            {/* Payments */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <h3 className="font-semibold text-zinc-900 mb-3 flex items-center gap-2">
                <CreditCard className="h-4 w-4" style={{ color: brandColor }} /> Payments & Invoices
              </h3>
              {/* Installment schedule */}
              {data.schedules!.length > 0 && (
                <div className="mb-4">
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Your Payment Schedule</p>
                  <div className="divide-y divide-zinc-50 border border-zinc-100 rounded-xl">
                    {data.schedules!.flatMap(s => s.installments).map(inst => {
                      const overdue = isOverdue(inst);
                      return (
                        <div key={inst.id} className={`flex items-center gap-3 px-3 py-2.5 ${overdue ? 'bg-red-50/50' : ''}`}>
                          <div className="flex-1">
                            <p className="text-xs font-medium text-zinc-800">{inst.description}</p>
                            <p className={`text-[10px] ${overdue ? 'text-red-500 font-semibold' : 'text-zinc-400'}`}>
                              Due {new Date(inst.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </p>
                          </div>
                          <p className="text-xs font-semibold text-zinc-900">{formatCurrencyFull(inst.amount, currency)}</p>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            inst.status === 'paid' ? 'bg-emerald-50 text-emerald-700' : overdue ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
                          }`}>{inst.status === 'paid' ? 'Paid' : overdue ? 'Overdue' : 'Upcoming'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {data.invoices!.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">No invoices yet.</p>
              ) : (
                <div className="divide-y divide-zinc-50">
                  {data.invoices!.map(inv => (
                    <div key={inv.id} className="flex items-center gap-3 py-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-800">{inv.type}</p>
                        <p className="text-[11px] text-zinc-400">Due {new Date(inv.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                      </div>
                      <p className="text-sm font-semibold text-zinc-900">{formatCurrencyFull(inv.amount, currency)}</p>
                      <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${invoiceColors[inv.status] || 'bg-zinc-100 text-zinc-500'}`}>{inv.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Documents */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <h3 className="font-semibold text-zinc-900 mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4" style={{ color: brandColor }} /> My Documents
              </h3>
              {data.documents!.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">Documents shared by your builder will appear here.</p>
              ) : (
                <div className="divide-y divide-zinc-50">
                  {data.documents!.map(doc => (
                    <div key={doc.id} className="flex items-center gap-3 py-3">
                      <FileText className="h-4 w-4 text-zinc-300" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-800">{doc.name}</p>
                        <p className="text-[11px] text-zinc-400">{doc.type} · {doc.size}</p>
                      </div>
                      <button onClick={() => toast.success(`Downloading ${doc.name}…`)} className="text-xs font-medium" style={{ color: brandColor }}>Download</button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Service requests */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
                  <Wrench className="h-4 w-4" style={{ color: brandColor }} /> Service Requests
                </h3>
                <button
                  onClick={() => setShowTicketForm(!showTicketForm)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-white rounded-lg text-xs font-semibold hover:opacity-90"
                  style={{ background: brandColor }}
                >
                  <Plus className="h-3.5 w-3.5" /> New Request
                </button>
              </div>
              {showTicketForm && (
                <form onSubmit={handleRaiseTicket} className="mb-4 p-4 bg-zinc-50 rounded-xl space-y-3">
                  <input name="title" placeholder="Describe the issue (e.g. tap leaking in master bathroom)" className="w-full px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <div className="flex gap-2">
                    <select name="category" className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none">
                      <option>Defect</option><option>Request</option><option>Maintenance</option>
                    </select>
                    <button type="submit" className="px-4 py-2 text-white rounded-xl text-sm font-semibold hover:opacity-90" style={{ background: brandColor }}>Submit</button>
                  </div>
                </form>
              )}
              {data.tickets!.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">No open requests.</p>
              ) : (
                <div className="divide-y divide-zinc-50">
                  {data.tickets!.map(t => (
                    <div key={t.id} className="flex items-center gap-3 py-3">
                      {t.status === 'resolved' || t.status === 'closed'
                        ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        : <Clock className="h-4 w-4 text-amber-500" />}
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-800">{t.title}</p>
                        <p className="text-[11px] text-zinc-400">{t.category} · {new Date(t.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</p>
                      </div>
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 capitalize">{t.status.replace('_', ' ')}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* ── PARTNER PORTAL ── */}
        {role === 'partner' && data.broker && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Leads Referred', value: data.broker.leadsReferred || data.referredLeads!.length, icon: Users },
                { label: 'Bookings Closed', value: data.broker.bookingsClosed, icon: CheckCircle2 },
                { label: 'Commission Rate', value: `${data.broker.commissionRate}%`, icon: Handshake },
                { label: 'Total Earned', value: formatCurrency(data.commissions!.filter(c => c.status === 'paid').reduce((s, c) => s + c.amount, 0), currency), icon: IndianRupee },
              ].map((s, i) => (
                <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
                  <s.icon className="h-4 w-4 mb-2" style={{ color: brandColor }} />
                  <p className="text-lg font-bold text-zinc-900">{s.value}</p>
                  <p className="text-[11px] text-zinc-500">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Submit a lead */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-zinc-900 flex items-center gap-2">
                  <Users className="h-4 w-4" style={{ color: brandColor }} /> Submit a Lead
                </h3>
                <button
                  onClick={() => setShowLeadForm(!showLeadForm)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-white rounded-lg text-xs font-semibold hover:opacity-90"
                  style={{ background: brandColor }}
                >
                  <Plus className="h-3.5 w-3.5" /> New Lead
                </button>
              </div>
              {showLeadForm ? (
                <form onSubmit={handleSubmitLead} className="p-4 bg-zinc-50 rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input name="name" placeholder="Buyer name *" className="px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <input name="phone" placeholder="Phone *" className="px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <input name="email" type="email" placeholder="Email" className="px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <select name="project" className="px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none">
                    {data.projects.map(p => <option key={p.id}>{p.name}</option>)}
                  </select>
                  <input name="budget" type="number" placeholder="Budget" className="px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <button type="submit" className="px-4 py-2.5 text-white rounded-xl text-sm font-semibold hover:opacity-90" style={{ background: brandColor }}>
                    Submit Lead
                  </button>
                </form>
              ) : (
                <p className="text-sm text-zinc-400">Refer a buyer — leads you submit are credited to you and commission applies when they book.</p>
              )}
            </section>

            {/* Referred leads */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <h3 className="font-semibold text-zinc-900 mb-3">My Referred Leads</h3>
              {data.referredLeads!.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">Leads you refer will be tracked here.</p>
              ) : (
                <div className="divide-y divide-zinc-50">
                  {data.referredLeads!.map(l => (
                    <div key={l.id} className="flex items-center gap-3 py-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-800">{l.name}</p>
                        <p className="text-[11px] text-zinc-400">{l.project} · {formatCurrency(l.budget, currency)}</p>
                      </div>
                      <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 capitalize">{l.stage.replace('_', ' ')}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Commissions */}
            <section className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <h3 className="font-semibold text-zinc-900 mb-3">My Commissions</h3>
              {data.commissions!.length === 0 ? (
                <p className="text-sm text-zinc-400 py-4 text-center">Commissions appear here when your referrals book.</p>
              ) : (
                <div className="divide-y divide-zinc-50">
                  {data.commissions!.map(c => (
                    <div key={c.id} className="flex items-center gap-3 py-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-800">{c.leadName} · {c.project}</p>
                        <p className="text-[11px] text-zinc-400">Booking value {formatCurrency(c.bookingValue, currency)} · {c.rate}%</p>
                      </div>
                      <p className="text-sm font-semibold text-zinc-900">{formatCurrencyFull(c.amount, currency)}</p>
                      <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${commissionColors[c.status]}`}>{c.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <p className="text-center text-[11px] text-zinc-400 pb-6">
          Powered by {BRAND.name}{tenant.slug ? ` · ${tenant.slug}.${BRAND.portalDomain}` : ''}
        </p>
      </main>
    </div>
  );
}
