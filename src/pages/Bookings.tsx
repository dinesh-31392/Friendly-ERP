import { useState, useMemo, useEffect } from 'react';
import {
  BookOpenCheck, Plus, X, IndianRupee, CheckCircle2, Clock, FileText, Trash2, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove, logAudit } from '../services/db';
import type { Booking, BookingStage, Lead, Unit, Invoice, Tower, Quotation, QuotationCharge } from '../types';
import { BOOKING_STAGES } from '../types';
import { formatCurrency, formatCurrencyFull } from '../utils/format';
import { generatePaymentSchedule, getScheduleForBooking, setInstallmentStatus, isOverdue } from '../services/paymentService';
import { needsApproval } from '../services/approvalService';
import { postCustomerPayment } from '../services/accountsService';
import toast from 'react-hot-toast';

const stageColors: Record<BookingStage, string> = {
  reservation: 'bg-zinc-100 text-zinc-600',
  token: 'bg-amber-50 text-amber-700',
  agreement: 'bg-indigo-50 text-indigo-700',
  payment: 'bg-blue-50 text-blue-700',
  completed: 'bg-emerald-50 text-emerald-700',
};

export default function Bookings() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const currency = tenant?.currency || 'INR';
  const canManage = hasPermission('manage_bookings');
  // Creation is a separate, broader permission — sales executives hold
  // 'create_bookings' but not 'manage_bookings'
  const canCreate = canManage || hasPermission('create_bookings');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<Booking | null>(null);
  const [preSelectedLeadId, setPreSelectedLeadId] = useState<string>('');
  const [preSelectedUnitId, setPreSelectedUnitId] = useState<string>('');
  const [view, setView] = useState<'bookings' | 'quotes'>('bookings');
  const [showAddQuote, setShowAddQuote] = useState(false);
  const canQuote = hasPermission('create_quotations');
  const canApproveDiscount = hasPermission('approve_discounts');
  const actor = user ? { id: user.id, name: user.name } : { id: '', name: 'System' };

  // Check if lead pre-selected from leads drawer
  useEffect(() => {
    const leadId = localStorage.getItem('friendly_crm_initiate_booking_lead');
    if (leadId) {
      setPreSelectedLeadId(leadId);
      setShowAdd(true);
      localStorage.removeItem('friendly_crm_initiate_booking_lead');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const bookings = useMemo(
    () => getByTenant<Booking>('bookings', tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );

  // Deep linking: listen to search query focus events
  useEffect(() => {
    const focusId = localStorage.getItem('friendly_crm_focus_booking');
    if (focusId) {
      const target = bookings.find(b => b.id === focusId);
      if (target) {
        setSelected(target);
      }
      localStorage.removeItem('friendly_crm_focus_booking');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const leads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const units = useMemo(() => getByTenant<Unit>('units', tenantId), [tenantId, refreshKey]);
  const towers = useMemo(() => getByTenant<Tower>('towers', tenantId), [tenantId, refreshKey]);
  const invoices = useMemo(() => getByTenant<Invoice>('invoices', tenantId), [tenantId, refreshKey]);

  const getLead = (id: string) => leads.find(l => l.id === id);
  const getUnit = (id: string) => units.find(u => u.id === id);
  const getTowerName = (unit?: Unit) => unit ? (towers.find(t => t.id === unit.towerId)?.name || '') : '';

  // Legacy bookings (created before schedules existed) get one generated when
  // their detail opens — as an effect, never as a side effect of render
  useEffect(() => {
    if (!selected) return;
    if (getScheduleForBooking(tenantId, selected.id)) return;
    const created = generatePaymentSchedule({
      tenantId, bookingId: selected.id, leadId: selected.leadId,
      planLabel: selected.paymentPlan,
      totalValue: getUnit(selected.unitId)?.price || getLead(selected.leadId)?.budget || 0,
      bookingDate: selected.createdAt,
    });
    if (created) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Collections summary
  const collected = invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + i.amount, 0);
  const outstanding = invoices.filter(i => i.status === 'Pending' || i.status === 'Overdue').reduce((s, i) => s + i.amount, 0);
  const totalBookingValue = bookings.reduce((s, b) => s + (getLead(b.leadId)?.budget || 0), 0);

  const audit = (action: string, id: string, details: string) => {
    if (!user) return;
    logAudit({ tenantId, userId: user.id, userName: user.name, action, entity: 'booking', entityId: id, details });
  };

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canCreate) { toast.error('No permission'); return; }
    const fd = new FormData(e.currentTarget);
    const leadId = fd.get('leadId') as string;
    const unitId = fd.get('unitId') as string;
    const lead = getLead(leadId);
    const unit = getUnit(unitId);
    if (!lead || !unit) { toast.error('Select a lead and a unit'); return; }
    if (unit.status === 'sold' || unit.status === 'booked') {
      toast.error(`Unit ${unit.number} is already ${unit.status} — pick another unit`);
      return;
    }

    const created = create<Booking>('bookings', {
      id: '', tenantId, leadId, unitId,
      amount: Number(fd.get('amount')) || 0,
      paymentPlan: (fd.get('paymentPlan') as string) || '30-70',
      stage: 'reservation',
      createdAt: new Date().toISOString(),
    });
    // Lock the unit and move the lead
    update<Unit>('units', unitId, { status: 'booked', bookedBy: leadId });
    update<Lead>('leads', leadId, { stage: 'booked', lastContact: new Date().toISOString() });
    
    // Create Lead Activities
    create<any>('activities', {
      id: '', tenantId, leadId, userId: user?.id || '', type: 'status_change',
      description: `Lead moved to Booked stage: Booked unit ${unit.number} at ${lead.project}`,
      createdAt: new Date().toISOString(),
    });

    // ONE basis for the whole booking. lead.budget is the buyer's self-reported
    // figure captured at intake; unit.price is what was actually booked, and the
    // two routinely differ. The schedule and the broker commission below must
    // agree, or the partner is paid on a number that contradicts the payment plan
    // recorded against the same booking.
    const bookingValue = unit.price || lead.budget;

    // Auto-generate the full installment schedule (sales → cash-flow bridge)
    generatePaymentSchedule({
      tenantId, bookingId: created.id, leadId,
      planLabel: (fd.get('paymentPlan') as string) || '30-70',
      totalValue: bookingValue,
      actor: user ? { id: user.id, name: user.name } : undefined,
    });

    // Auto-generate invoice
    const tokenAmount = Number(fd.get('amount')) || 300000;
    create<Invoice>('invoices', {
      id: '', tenantId, leadId, leadName: lead.name, project: lead.project,
      type: 'Booking Token', amount: tokenAmount,
      date: new Date().toISOString(),
      dueDate: new Date(Date.now() + 86400000 * 7).toISOString(), // 7 days due date
      status: 'Pending',
    });

    // Auto-calculate broker commission if referred by a channel partner.
    // Identity-safe attribution: the lead carries brokerId (set when a partner
    // submits through the portal), so match on it. The previous substring match
    // on lead.source paid the wrong partner when one broker's name contained
    // another's ("Meera Iyer" vs "Meera Iyer Associates"), and invented
    // commissions for a broker named e.g. "Referral Partners LLP" whenever a
    // lead's source was the plain "Referral" option. Exact-name is a fallback
    // for rows created before brokerId existed.
    {
      const brokersList = getByTenant<any>('brokers', tenantId);
      const broker = lead.brokerId
        ? brokersList.find(b => b.id === lead.brokerId)
        : brokersList.find(b => b.name === lead.source);
      if (broker) {
        // Increment broker closed count & referred count
        update<any>('brokers', broker.id, {
          bookingsClosed: (broker.bookingsClosed || 0) + 1,
        });
        const commissionAmount = Math.round((bookingValue * (broker.commissionRate || 2)) / 100);
        create<any>('commissions', {
          id: '', tenantId, brokerId: broker.id, brokerName: broker.name,
          leadName: lead.name, project: lead.project, bookingValue,
          rate: broker.commissionRate || 2, amount: commissionAmount, status: 'pending',
          createdAt: new Date().toISOString(),
        });
        toast.success(`Broker commission calculated: ${formatCurrencyFull(commissionAmount, currency)} pending approval`);
      }
    }

    audit('book', created.id, `Booked unit ${unit.number} for ${lead.name} (token ${formatCurrencyFull(tokenAmount, currency)})`);
    setShowAdd(false);
    setPreSelectedLeadId('');
    setPreSelectedUnitId('');
    refresh();
    toast.success(`Unit ${unit.number} booked for ${lead.name}`);
  };

  const handleStageAdvance = (b: Booking, next: BookingStage) => {
    if (!canManage) { toast.error('No permission'); return; }
    update<Booking>('bookings', b.id, { stage: next });
    if (next === 'completed') {
      const unit = getUnit(b.unitId);
      if (unit) update<Unit>('units', b.unitId, { status: 'sold' });
      audit('sell', b.id, `Booking completed — unit ${unit?.number || ''} marked Sold`);
    } else {
      audit('update', b.id, `Booking moved to ${BOOKING_STAGES.find(s => s.id === next)?.label}`);
    }
    setSelected(prev => prev && prev.id === b.id ? { ...prev, stage: next } : prev);
    refresh();
    toast.success(`Moved to ${BOOKING_STAGES.find(s => s.id === next)?.label}`);
  };

  const handleCancel = (b: Booking) => {
    if (!canManage) { toast.error('No permission'); return; }
    if (!confirm('Cancel this booking? The unit will be released back to Available.')) return;
    const unit = getUnit(b.unitId);
    remove('bookings', b.id);
    if (unit && unit.status !== 'sold') update<Unit>('units', b.unitId, { status: 'available', bookedBy: undefined });
    audit('delete', b.id, `Cancelled booking for ${getLead(b.leadId)?.name || 'lead'} — unit ${unit?.number || ''} released`);
    setSelected(null);
    refresh();
    toast.success('Booking cancelled, unit released');
  };

  // Spec matrix: a sales executive cancels by REQUEST only — a booking
  // manager confirms (which releases the unit) or dismisses.
  const requestCancel = (b: Booking) => {
    update<Booking>('bookings', b.id, { cancelRequested: true });
    audit('update', b.id, `Cancellation requested for ${getLead(b.leadId)?.name || 'lead'}'s booking — awaiting manager approval`);
    setSelected(prev => prev && prev.id === b.id ? { ...prev, cancelRequested: true } : prev);
    refresh();
    toast.success('Cancellation requested — a booking manager must approve it');
  };

  const dismissCancelRequest = (b: Booking) => {
    update<Booking>('bookings', b.id, { cancelRequested: false });
    audit('update', b.id, 'Cancellation request dismissed — booking stands');
    setSelected(prev => prev && prev.id === b.id ? { ...prev, cancelRequested: false } : prev);
    refresh();
    toast.success('Request dismissed — booking stands');
  };

  const bookableLeads = leads.filter(l => l.stage !== 'lost' && !bookings.some(b => b.leadId === l.id));
  const availableUnits = units.filter(u => u.status === 'available' || u.status === 'reserved');

  // ── Quotations ─────────────────────────────────────────────────────────────
  const quotations = useMemo(
    () => getByTenant<Quotation>('quotations', tenantId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const isExpired = (q: Quotation) => q.status === 'sent' && new Date(q.validUntil).getTime() < Date.now();
  const [quoteCharges, setQuoteCharges] = useState<QuotationCharge[]>([]);
  const [quoteUnitId, setQuoteUnitId] = useState('');
  const [quoteDiscount, setQuoteDiscount] = useState('');
  const quoteUnit = units.find(u => u.id === quoteUnitId);
  const quoteBase = quoteUnit?.price || 0;
  const quoteChargesTotal = quoteCharges.reduce((s, c) => s + c.amount, 0);
  const quoteDiscountNum = Number(quoteDiscount) || 0;
  const quoteTotal = quoteBase + quoteChargesTotal - quoteDiscountNum;
  const discountNeedsApproval = quoteDiscountNum > 0 && needsApproval(tenantId, 'discount', quoteDiscountNum);

  const handleAddQuote = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const leadId = fd.get('leadId') as string;
    if (!leadId || !quoteUnit) { toast.error('Pick a lead and a unit'); return; }
    if (quoteTotal <= 0) { toast.error('Quote total must be positive'); return; }
    // Discount routing: above the configured threshold the quote parks in
    // pending_approval unless the creator holds approve_discounts themselves.
    const parked = discountNeedsApproval && !canApproveDiscount;
    const created = create<Quotation>('quotations', {
      id: '', tenantId, leadId, unitId: quoteUnit.id,
      baseAmount: quoteBase,
      charges: quoteCharges.filter(c => c.label.trim() && c.amount > 0),
      discountAmount: quoteDiscountNum,
      discountApprovedBy: discountNeedsApproval && canApproveDiscount ? actor.id : undefined,
      totalAmount: quoteTotal,
      validUntil: (fd.get('validUntil') as string) || new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
      status: parked ? 'pending_approval' : 'draft',
      createdBy: actor.id, createdAt: new Date().toISOString(),
    });
    audit('create', created.id, `Quotation for ${getLead(leadId)?.name} — unit ${quoteUnit.number} at ${formatCurrency(quoteTotal, currency)}${parked ? ' (discount awaiting approval)' : ''}`);
    setShowAddQuote(false);
    setQuoteCharges([]); setQuoteUnitId(''); setQuoteDiscount('');
    refresh();
    toast.success(parked ? 'Quotation created — discount needs approval before sending' : 'Quotation created');
  };

  const approveQuoteDiscount = (q: Quotation) => {
    update<Quotation>('quotations', q.id, { status: 'draft', discountApprovedBy: actor.id });
    audit('update', q.id, `Approved ${formatCurrency(q.discountAmount, currency)} discount on quotation for ${getLead(q.leadId)?.name}`);
    refresh();
    toast.success('Discount approved — quote can be sent');
  };

  const setQuoteStatus = (q: Quotation, status: Quotation['status'], msg: string) => {
    update<Quotation>('quotations', q.id, { status });
    audit('update', q.id, `Quotation for ${getLead(q.leadId)?.name} → ${status}`);
    refresh();
    toast.success(msg);
  };

  const acceptQuote = (q: Quotation) => {
    const unit = getUnit(q.unitId);
    if (!unit || unit.status === 'booked' || unit.status === 'sold') {
      toast.error('That unit is no longer available — re-quote on another unit');
      return;
    }
    setQuoteStatus(q, 'accepted', 'Quotation accepted — complete the booking');
    setPreSelectedLeadId(q.leadId);
    setPreSelectedUnitId(q.unitId);
    setView('bookings');
    setShowAdd(true);
  };

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Bookings & Collections</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Quotation → reservation → token → agreement → payments → handover.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-xl p-1">
            <button onClick={() => setView('bookings')} className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${view === 'bookings' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>Bookings</button>
            <button onClick={() => setView('quotes')} className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${view === 'quotes' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>
              Quotations
              {quotations.some(q => q.status === 'pending_approval') && <span className="ml-1.5 text-[9px] font-bold px-1.5 rounded-full bg-amber-100 text-amber-700">!</span>}
            </button>
          </div>
          {view === 'bookings' && canCreate && (
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" /> New Booking
            </button>
          )}
          {view === 'quotes' && canQuote && (
            <button
              onClick={() => {
                if (availableUnits.length === 0) { toast.error('No available units to quote on'); return; }
                setQuoteCharges([]); setQuoteUnitId(''); setQuoteDiscount('');
                setShowAddQuote(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm"
            >
              <Plus className="h-4 w-4" /> New Quotation
            </button>
          )}
        </div>
      </div>

      {/* Collections summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Active Bookings', value: bookings.filter(b => b.stage !== 'completed').length, icon: BookOpenCheck, color: 'text-indigo-600' },
          { label: 'Booking Value', value: formatCurrency(totalBookingValue, currency), icon: IndianRupee, color: 'text-violet-600' },
          { label: 'Collected', value: formatCurrency(collected, currency), icon: CheckCircle2, color: 'text-emerald-600' },
          { label: 'Outstanding', value: formatCurrency(outstanding, currency), icon: Clock, color: 'text-amber-600' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon className={`h-5 w-5 ${s.color}`} />
              <span className="text-[11px] font-medium text-zinc-500">{s.label}</span>
            </div>
            <p className="text-xl font-bold text-zinc-900">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Quotations list */}
      {view === 'quotes' && (
        <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
          {quotations.length === 0 ? (
            <div className="py-16 text-center">
              <FileText className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-zinc-700">No quotations yet</h3>
              <p className="text-xs text-zinc-500 mt-1">Price a unit for a lead — big discounts route for approval automatically.</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {quotations.map(q => {
                const lead = getLead(q.leadId);
                const unit = getUnit(q.unitId);
                const expired = isExpired(q);
                const status = expired ? 'expired' : q.status;
                const statusCls: Record<string, string> = {
                  draft: 'bg-zinc-100 text-zinc-600', pending_approval: 'bg-amber-50 text-amber-700',
                  sent: 'bg-blue-50 text-blue-700', accepted: 'bg-emerald-50 text-emerald-700',
                  rejected: 'bg-red-50 text-red-600', expired: 'bg-zinc-100 text-zinc-400',
                };
                return (
                  <div key={q.id} className="px-5 py-3.5 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[220px]">
                      <p className="text-sm font-semibold text-zinc-900">{lead?.name || 'Lead'} · {getTowerName(unit)} / {unit?.number || '—'}</p>
                      <p className="text-[11px] text-zinc-500">
                        Base {formatCurrency(q.baseAmount, currency)}
                        {q.charges.length > 0 && ` + ${formatCurrency(q.charges.reduce((s, c) => s + c.amount, 0), currency)} charges`}
                        {q.discountAmount > 0 && <span className="text-amber-600"> − {formatCurrency(q.discountAmount, currency)} discount{q.discountApprovedBy ? ' ✓' : ''}</span>}
                        {' · valid till '}{new Date(q.validUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </p>
                    </div>
                    <p className="text-sm font-bold text-zinc-900">{formatCurrency(q.totalAmount, currency)}</p>
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${statusCls[status]}`}>{status.replace('_', ' ')}</span>
                    {q.status === 'pending_approval' && canApproveDiscount && (
                      <button onClick={() => approveQuoteDiscount(q)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100">Approve Discount</button>
                    )}
                    {q.status === 'draft' && canQuote && (
                      <button onClick={() => setQuoteStatus(q, 'sent', 'Quotation sent to the buyer')} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Send</button>
                    )}
                    {q.status === 'sent' && !expired && canQuote && (
                      <>
                        <button onClick={() => acceptQuote(q)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700">Accepted → Book</button>
                        <button onClick={() => setQuoteStatus(q, 'rejected', 'Marked rejected')} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-red-50 text-red-600 hover:bg-red-100">Rejected</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Booking list */}
      {view === 'bookings' && (
      <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        {bookings.length === 0 ? (
          <div className="py-16 text-center">
            <BookOpenCheck className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-zinc-700">No bookings yet</h3>
            <p className="text-xs text-zinc-500 mt-1">Convert a lead into a booking to start the pipeline.</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {bookings.map(b => {
              const lead = getLead(b.leadId);
              const unit = getUnit(b.unitId);
              return (
                <div key={b.id} className="px-5 py-4 hover:bg-zinc-50/30 transition-colors flex items-center gap-4 cursor-pointer" onClick={() => setSelected(b)}>
                  <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-teal-600">{(lead?.name || '?').split(' ').map(n => n[0]).join('')}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-zinc-900">{lead?.name || 'Unknown lead'}</p>
                    <div className="flex items-center gap-3 text-[11px] text-zinc-500 mt-0.5 flex-wrap">
                      <span>{lead?.project}</span>
                      <span>· {getTowerName(unit)} / Unit {unit?.number || '—'}</span>
                      <span>· Plan {b.paymentPlan}</span>
                      <span>· Token {formatCurrency(b.amount, currency)}</span>
                    </div>
                  </div>
                  {b.cancelRequested && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-600">cancel requested</span>
                  )}
                  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${stageColors[b.stage]}`}>
                    {BOOKING_STAGES.find(s => s.id === b.stage)?.label}
                  </span>
                  <ChevronRight className="h-4 w-4 text-zinc-300" />
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Booking detail modal with stage stepper */}
      {selected && (() => {
        const lead = getLead(selected.leadId);
        const unit = getUnit(selected.unitId);
        const currentIdx = BOOKING_STAGES.findIndex(s => s.id === selected.stage);
        // Read-only here — generation happens in the effect above
        const schedule = getScheduleForBooking(tenantId, selected.id);
        const paidAmount = schedule ? schedule.installments.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount, 0) : 0;
        const totalAmount = schedule ? schedule.installments.reduce((s, i) => s + i.amount, 0) : 0;
        return (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900">{lead?.name || 'Booking'}</h3>
                  <p className="text-sm text-zinc-500">{lead?.project} · {getTowerName(unit)} / Unit {unit?.number}</p>
                </div>
                <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
              </div>

              {/* Stepper */}
              <div className="flex items-center gap-1 mb-5">
                {BOOKING_STAGES.map((s, i) => (
                  <div key={s.id} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className={`h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      i < currentIdx ? 'bg-emerald-500 text-white' :
                      i === currentIdx ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' :
                      'bg-zinc-100 text-zinc-400'
                    }`}>
                      {i < currentIdx ? '✓' : i + 1}
                    </div>
                    <span className={`text-[9px] font-medium text-center leading-tight ${i <= currentIdx ? 'text-zinc-800' : 'text-zinc-400'}`}>{s.label}</span>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-3 mb-5">
                <div className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">Token</p><p className="text-sm font-semibold text-zinc-900 mt-0.5">{formatCurrency(selected.amount, currency)}</p></div>
                <div className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">Plan</p><p className="text-sm font-semibold text-zinc-900 mt-0.5">{selected.paymentPlan}</p></div>
                <div className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">Unit Value</p><p className="text-sm font-semibold text-zinc-900 mt-0.5">{formatCurrency(unit?.price || 0, currency)}</p></div>
              </div>

              {/* Payment schedule */}
              {!schedule ? (
                <p className="mb-5 text-xs text-zinc-400 bg-zinc-50 rounded-xl p-3">
                  No payment schedule yet — set a price on the booked unit (or a budget on the lead) and reopen this booking to generate one.
                </p>
              ) : (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Payment Schedule</p>
                  <span className="text-[11px] font-semibold text-emerald-600">
                    {formatCurrency(paidAmount, currency)} / {formatCurrency(totalAmount, currency)} collected
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden mb-3">
                  <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${totalAmount > 0 ? (paidAmount / totalAmount) * 100 : 0}%` }} />
                </div>
                <div className="max-h-44 overflow-y-auto divide-y divide-zinc-50 border border-zinc-100 rounded-xl">
                  {schedule.installments.map(inst => {
                    const overdue = isOverdue(inst);
                    return (
                      <div key={inst.id} className={`flex items-center gap-3 px-3 py-2.5 ${overdue ? 'bg-red-50/50' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-zinc-800">{inst.description}</p>
                          <p className={`text-[10px] ${overdue ? 'text-red-500 font-semibold' : 'text-zinc-400'}`}>
                            {overdue ? '⚠ Overdue — was due ' : 'Due '}
                            {new Date(inst.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </p>
                        </div>
                        <p className="text-xs font-semibold text-zinc-900">{formatCurrency(inst.amount, currency)}</p>
                        {inst.status === 'paid' ? (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Paid</span>
                        ) : canManage ? (
                          <button
                            onClick={() => {
                              setInstallmentStatus(schedule, inst.id, 'paid', user ? { id: user.id, name: user.name } : undefined);
                              // Cash in → ledger (cash-basis income recognition)
                              postCustomerPayment({
                                tenantId, amount: inst.amount,
                                narration: `Collection — installment #${inst.number} from ${lead?.name || 'customer'} (${lead?.project || 'booking'})`,
                                sourceId: selected.id, projectId: lead?.projectId, actor,
                              });
                              refresh();
                              toast.success(`Installment #${inst.number} marked paid`);
                            }}
                            className="text-[10px] font-semibold px-2 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                          >
                            Mark Paid
                          </button>
                        ) : (
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${overdue ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>{overdue ? 'Overdue' : 'Pending'}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              )}

              <div className="flex gap-2">
                {canManage && currentIdx < BOOKING_STAGES.length - 1 && (
                  <button
                    onClick={() => handleStageAdvance(selected, BOOKING_STAGES[currentIdx + 1].id)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
                  >
                    Advance to {BOOKING_STAGES[currentIdx + 1].label} <ChevronRight className="h-4 w-4" />
                  </button>
                )}
                {selected.stage === 'completed' && (
                  <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-emerald-50 text-emerald-700 rounded-xl text-sm font-semibold">
                    <CheckCircle2 className="h-4 w-4" /> Completed — Unit Sold
                  </div>
                )}
                <button onClick={() => toast.success('Agreement document generated')} className="px-3 py-2.5 border border-zinc-200 rounded-xl text-zinc-600 hover:bg-zinc-50" title="Generate agreement">
                  <FileText className="h-4 w-4" />
                </button>
                {canManage && selected.stage !== 'completed' && (
                  <button onClick={() => handleCancel(selected)} className="px-3 py-2.5 border border-red-200 text-red-500 rounded-xl hover:bg-red-50" title="Cancel booking">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                {!canManage && canCreate && selected.stage !== 'completed' && !selected.cancelRequested && (
                  <button onClick={() => requestCancel(selected)} className="px-3 py-2.5 border border-red-200 text-red-500 rounded-xl hover:bg-red-50 text-xs font-semibold" title="Request cancellation — a manager approves">
                    Request Cancel
                  </button>
                )}
              </div>

              {selected.cancelRequested && (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 flex-wrap">
                  <p className="text-xs font-medium text-red-700 flex-1 min-w-[180px]">Cancellation requested — a booking manager must approve.</p>
                  {canManage && (<>
                    <button onClick={() => handleCancel(selected)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-red-600 text-white hover:bg-red-700">Approve & Cancel</button>
                    <button onClick={() => dismissCancelRequest(selected)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50">Dismiss</button>
                  </>)}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* New quotation modal */}
      {showAddQuote && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddQuote(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">New Quotation</h3>
              <button onClick={() => setShowAddQuote(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddQuote} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Lead *</label>
                <select name="leadId" required className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                  <option value="">Select lead...</option>
                  {leads.filter(l => l.stage !== 'lost').map(l => (
                    <option key={l.id} value={l.id}>{l.name} — {l.project}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Unit *</label>
                <select value={quoteUnitId} onChange={e => setQuoteUnitId(e.target.value)} required className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                  <option value="">Select unit...</option>
                  {availableUnits.slice(0, 80).map(u => (
                    <option key={u.id} value={u.id}>{getTowerName(u)} / {u.number} · {u.configuration} · {formatCurrency(u.price, currency)}</option>
                  ))}
                </select>
                {quoteUnit && <p className="text-[11px] text-zinc-400 mt-1">Base price: {formatCurrencyFull(quoteBase, currency)}</p>}
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Additional Charges</label>
                <div className="space-y-2">
                  {quoteCharges.map((c, i) => (
                    <div key={i} className="flex gap-2">
                      <input value={c.label} onChange={e => setQuoteCharges(cs => cs.map((x, xi) => xi === i ? { ...x, label: e.target.value } : x))} placeholder="Floor rise / parking / club" className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm" />
                      <input value={c.amount || ''} type="number" min="0" onChange={e => setQuoteCharges(cs => cs.map((x, xi) => xi === i ? { ...x, amount: Number(e.target.value) || 0 } : x))} placeholder="Amount" className="w-32 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-right" />
                      <button type="button" onClick={() => setQuoteCharges(cs => cs.filter((_, xi) => xi !== i))} className="p-2 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 shrink-0"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setQuoteCharges(cs => [...cs, { label: '', amount: 0 }])} className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 px-1 py-1">
                    <Plus className="h-3.5 w-3.5" /> Add charge
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Discount ({currency})</label>
                  <input value={quoteDiscount} onChange={e => setQuoteDiscount(e.target.value)} type="number" min="0" placeholder="0" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
                  {discountNeedsApproval && (
                    <p className={`text-[11px] mt-1 font-medium ${canApproveDiscount ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {canApproveDiscount ? 'Above threshold — auto-approved by you' : 'Above threshold — will route for approval'}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Valid Until</label>
                  <input name="validUntil" type="date" defaultValue={new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10)} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm" />
                </div>
              </div>

              <div className="bg-zinc-50 rounded-xl p-3 text-sm flex items-center justify-between">
                <span className="text-zinc-500">Quote total</span>
                <span className={`font-bold ${quoteTotal <= 0 ? 'text-red-600' : 'text-zinc-900'}`}>{formatCurrencyFull(quoteTotal, currency)}</span>
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAddQuote(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Create Quotation</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New booking modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">New Booking</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Lead *</label>
                <select
                  name="leadId"
                  required
                  defaultValue={preSelectedLeadId}
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  <option value="">Select lead...</option>
                  {/* Show bookable leads, plus make sure the preselected one is in the list even if it is already partially booked */}
                  {Array.from(new Set([...bookableLeads, ...(preSelectedLeadId ? [leads.find(l => l.id === preSelectedLeadId)].filter(Boolean) as Lead[] : [])])).map(l => (
                    <option key={l.id} value={l.id}>{l.name} — {l.project} ({formatCurrency(l.budget, currency)})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Unit * <span className="normal-case font-normal text-zinc-400">(only available/reserved units listed)</span></label>
                <select name="unitId" required defaultValue={preSelectedUnitId} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                  <option value="">Select unit...</option>
                  {availableUnits.slice(0, 80).map(u => (
                    <option key={u.id} value={u.id}>{getTowerName(u)} / {u.number} · {u.configuration} · {formatCurrency(u.price, currency)} ({u.status})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Token Amount (₹)</label>
                  <input name="amount" type="number" defaultValue={300000} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Payment Plan</label>
                  <select name="paymentPlan" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>30-70</option><option>20-80</option><option>40-60</option><option>Flexi</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Create Booking</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
