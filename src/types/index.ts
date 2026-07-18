// Widened to admit tenant-defined custom stages (metadata-driven pipeline).
// The literal members keep autocomplete; `(string & {})` allows custom keys.
// 'new', 'booked', 'lost' are core stages that always exist for every tenant.
export type LeadStage =
  | 'new' | 'contacted' | 'qualified' | 'visit_scheduled' | 'negotiation' | 'booked' | 'lost'
  | (string & {});
export type UnitStatus = 'available' | 'reserved' | 'blocked' | 'booked' | 'sold' | 'on_hold';
// 'tech_team' = branch-scoped platform staff who onboard builders (into a
// PENDING state) but cannot approve them — approval is super_admin only.
export type Role = 'super_admin' | 'tech_team' | 'builder_admin' | 'sales_manager' | 'sales_executive';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Platform-operator organizational unit (region/office). Groups the builder
 *  accounts onboarded there and the tech-team staff who manage them. Global,
 *  not tenant-scoped. */
export interface Branch {
  id: string;
  name: string;
  managerId?: string;   // a tech_team / super_admin user id
  createdAt: string;
}
export type Priority = 'hot' | 'warm' | 'cold';
export type TaskCategory = 'follow_up' | 'visit' | 'payment' | 'service' | 'other';
export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type BookingStage = 'reservation' | 'token' | 'agreement' | 'payment' | 'completed';
export type ActivityType = 'call' | 'whatsapp' | 'email' | 'visit' | 'note' | 'status_change';
export type TicketPriority = 'high' | 'medium' | 'low';
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type InvoiceStatus = 'Paid' | 'Pending' | 'Generated' | 'Overdue';
export type ProjectStatus = 'pre_launch' | 'under_construction' | 'ready_to_move' | 'completed';
export type PaymentPlanType = 'construction_linked' | 'down_payment' | 'flexi' | 'custom';

export type TenantStatus = 'trial' | 'active' | 'suspended';

/** Per-tenant overrides set by the platform super admin — the "custom
 *  control model". Anything unset falls back to the tenant's plan. */
export interface TenantOverrides {
  disabledModules?: string[];   // module keys hidden & blocked for this tenant
  maxUsers?: number;            // overrides plan team-size limit (-1 unlimited)
  maxProjects?: number;         // overrides plan project limit (-1 unlimited)
  storageLimitKb?: number;      // soft storage quota shown in monitoring
  customPriceMonthly?: number;  // negotiated price in USD, feeds MRR
}

export interface Tenant {
  id: string;
  name: string;
  company: string;
  logo: string;            // data-URL of the uploaded logo (white-label)
  brandVoice: string;
  audience: string;
  channels: string[];
  plan: string;
  status?: TenantStatus;   // undefined on legacy rows — treated as 'active'
  trialEndsAt?: string;
  country?: string;
  currency?: string;       // ISO code, e.g. 'INR', 'USD' — defaults to 'INR'
  slug?: string;           // subdomain slug, e.g. 'skyline-builders' (premium)
  primaryColor?: string;   // white-label accent color, hex
  overrides?: TenantOverrides;  // super-admin custom controls
  branchId?: string;       // owning platform branch (undefined = legacy)
  approvalStatus?: ApprovalStatus;  // undefined = legacy, treated as approved
  email: string;
  phone: string;
  address: string;
  rera?: string;
  gst?: string;
  createdAt: string;
}

/** Login account for the customer portal / channel-partner portal.
 *  Kept separate from the internal `User` table so portal users can never
 *  reach CRM screens and vice versa. */
export interface PortalUser {
  id: string;
  tenantId: string;
  role: 'customer' | 'partner';
  email: string;
  password: string;
  name: string;
  leadId?: string;     // for customers — links to their Lead record
  brokerId?: string;   // for partners — links to their Broker record
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  avatar: string;
  phone: string;
  active: boolean;
  branchId?: string;   // for tech_team staff — the branch they operate in
  // Set when an admin issues a temporary password: the user must choose a new
  // one before they can use the app. Lets an admin grant access WITHOUT ever
  // seeing or storing a shareable standing password.
  mustChangePassword?: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  location: string;
  type: string;
  status: ProjectStatus;
  reraNumber?: string;
  totalUnits: number;
  availableUnits: number;
  priceRange: [number, number];
  launchDate?: string;
  completionDate?: string;
  description?: string;
  amenities?: string[];
  micrositePublished?: boolean;   // public landing page live at /site/<slug>/<id>
  createdAt: string;
}

export interface Tower {
  id: string;
  projectId: string;
  tenantId: string;
  name: string;
  floors: number;
  unitsPerFloor: number;
}

export interface Unit {
  id: string;
  towerId: string;
  tenantId: string;
  floorNumber: number;
  number: string;
  type: string;
  configuration: string;
  area: number;
  price: number;
  status: UnitStatus;
  bookedBy?: string;
}

export interface Lead {
  id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  email: string;
  phone: string;
  source: string;
  project: string;
  budget: number;
  configuration: string;
  stage: LeadStage;
  priority: Priority;
  assignedTo: string;
  brokerId?: string;   // identity-safe channel-partner attribution
  lastContact: string;
  createdAt: string;
}

export interface Note {
  id: string;
  tenantId: string;
  leadId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface Activity {
  id: string;
  tenantId: string;
  leadId: string;
  userId: string;
  type: ActivityType;
  description: string;
  createdAt: string;
}

export interface Task {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  description: string;
  dueDate: string;
  priority: Priority;
  status: TaskStatus;
  category: TaskCategory;
}

export interface Booking {
  id: string;
  tenantId: string;
  projectId?: string;
  leadId: string;
  unitId: string;
  amount: number;
  paymentPlan: string;
  stage: BookingStage;
  createdAt: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  leadId: string;
  leadName: string;
  project: string;
  type: string;
  amount: number;
  date: string;
  dueDate: string;
  status: InvoiceStatus;
}

export interface Ticket {
  id: string;
  tenantId: string;
  title: string;
  leadId?: string;     // identity-safe link; `customer` name is display only
  customer: string;
  project: string;
  category: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: string;
  createdAt: string;
}

export interface Broker {
  id: string;
  tenantId: string;
  name: string;
  firm: string;
  phone: string;
  email: string;
  reraId: string;
  commissionRate: number;
  leadsReferred: number;
  bookingsClosed: number;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface Commission {
  id: string;
  tenantId: string;
  brokerId: string;
  brokerName: string;
  leadName: string;
  project: string;
  bookingValue: number;
  rate: number;
  amount: number;
  status: 'pending' | 'approved' | 'paid';
  createdAt: string;
}

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  status: 'draft' | 'scheduled' | 'sent' | 'completed';
  audience: string;
  channel: string;
  content: string;
  scheduledAt?: string;
  sentAt?: string;
  createdAt: string;
}

export interface Template {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  channel: string;
  content: string;
  createdAt: string;
}

export interface Agreement {
  id: string;
  tenantId: string;
  leadId: string;
  customerName: string;
  project: string;
  unitNumber: string;
  type: string;
  value: number;
  status: 'draft' | 'sent' | 'signed' | 'expired';
  createdAt: string;
  signedAt?: string;
}

export interface AuditLog {
  id: string;
  tenantId: string;
  userId: string;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  leadId: string;
  leadName: string;
  lastMsg: string;
  time: string;
  unread: number;
  channel: string;
}

export interface ChatMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  senderId: string;
  content: string;
  timestamp: string;
}

export interface Document {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  project: string;
  date: string;
  size: string;
  status: string;
  url: string;
}

export interface Reminder {
  id: string;
  tenantId: string;
  leadId: string;
  userId: string;
  title: string;
  dueDate: string;
  completed: boolean;
}

export interface PaymentPlan {
  id: string;
  tenantId: string;
  bookingId: string;
  leadId: string;
  type: PaymentPlanType;
  installments: Installment[];
  createdAt: string;
}

export interface Installment {
  id: string;
  number: number;
  amount: number;
  dueDate: string;
  status: 'pending' | 'paid' | 'overdue';
  paidDate?: string;
  description: string;
}

export interface SiteVisit {
  id: string;
  tenantId: string;
  leadId: string;
  projectId?: string;
  scheduledDate: string;
  scheduledTime: string;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  feedback?: string;
  rating?: number;
  assignedTo: string;
  createdAt: string;
}

export const LEAD_STAGES: { id: LeadStage; label: string; color: string }[] = [
  { id: 'new', label: 'New', color: 'bg-blue-500' },
  { id: 'contacted', label: 'Contacted', color: 'bg-purple-500' },
  { id: 'qualified', label: 'Qualified', color: 'bg-indigo-500' },
  { id: 'visit_scheduled', label: 'Visit Scheduled', color: 'bg-amber-500' },
  { id: 'negotiation', label: 'Negotiation', color: 'bg-orange-500' },
  { id: 'booked', label: 'Booked', color: 'bg-emerald-500' },
  { id: 'lost', label: 'Lost', color: 'bg-red-400' },
];

export const UNIT_STATUSES: { id: UnitStatus; label: string }[] = [
  { id: 'available', label: 'Available' },
  { id: 'reserved', label: 'Reserved' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'booked', label: 'Booked' },
  { id: 'sold', label: 'Sold' },
  { id: 'on_hold', label: 'On Hold' },
];

export const PROJECT_STATUSES: { id: ProjectStatus; label: string; color: string }[] = [
  { id: 'pre_launch', label: 'Pre-Launch', color: 'bg-purple-500' },
  { id: 'under_construction', label: 'Under Construction', color: 'bg-amber-500' },
  { id: 'ready_to_move', label: 'Ready to Move', color: 'bg-emerald-500' },
  { id: 'completed', label: 'Completed', color: 'bg-blue-500' },
];

// NOTE: the single source of truth for role permissions lives in
// services/authService.ts (hasPermission). A duplicate ROLE_PERMISSIONS
// constant used to live here but had drifted out of sync and was unused,
// so it was removed.

export const BOOKING_STAGES: { id: BookingStage; label: string }[] = [
  { id: 'reservation', label: 'Reservation' },
  { id: 'token', label: 'Token Paid' },
  { id: 'agreement', label: 'Agreement' },
  { id: 'payment', label: 'Payment' },
  { id: 'completed', label: 'Completed' },
];

export const DOCUMENT_TYPES = ['Agreement', 'Quotation', 'Payment Plan', 'Legal', 'Template', 'Brochure', 'Floor Plan', 'Other'];

export function computeLeadScore(lead: {
  stage: LeadStage;
  priority: Priority;
  budget: number;
  lastContact: string;
  source: string;
}): number {
  let score = 0;
  const stageScores: Record<string, number> = {
    new: 5, contacted: 12, qualified: 20, visit_scheduled: 28,
    negotiation: 36, booked: 40, lost: 0,
  };
  // Tenant-defined custom stages sit mid-pipeline — score them like an
  // engaged mid-funnel lead rather than zero
  score += stageScores[lead.stage] ?? 18;
  const priorityScores: Record<Priority, number> = { hot: 25, warm: 15, cold: 5 };
  score += priorityScores[lead.priority] ?? 0;
  if (lead.budget >= 30000000) score += 20;
  else if (lead.budget >= 15000000) score += 14;
  else if (lead.budget >= 8000000) score += 9;
  else score += 4;
  const daysSince = (Date.now() - new Date(lead.lastContact).getTime()) / 86400000;
  if (daysSince <= 2) score += 15;
  else if (daysSince <= 7) score += 10;
  else if (daysSince <= 14) score += 5;
  const strongSources = ['Referral', 'Walk-in', 'Website'];
  if (strongSources.includes(lead.source)) score += 5;
  else score += 2;
  return Math.min(100, score);
}

export function leadScoreBand(score: number): { label: string; color: string } {
  if (score >= 70) return { label: 'Hot', color: 'bg-red-100 text-red-700' };
  if (score >= 45) return { label: 'Warm', color: 'bg-amber-100 text-amber-700' };
  return { label: 'Cold', color: 'bg-zinc-100 text-zinc-500' };
}

export interface ScoreFactor { label: string; points: number; detail: string }

/**
 * Explainable lead score — the same math as computeLeadScore, but returns
 * WHY. Responsible-AI principle: a score that drives who a salesperson calls
 * first must be transparent and auditable, never a black box.
 */
export function explainLeadScore(lead: {
  stage: LeadStage; priority: Priority; budget: number; lastContact: string; source: string;
}): { score: number; factors: ScoreFactor[]; nextBestAction: string } {
  const factors: ScoreFactor[] = [];
  const stageScores: Record<string, number> = {
    new: 5, contacted: 12, qualified: 20, visit_scheduled: 28, negotiation: 36, booked: 40, lost: 0,
  };
  const stagePts = stageScores[lead.stage] ?? 18;
  factors.push({ label: 'Pipeline stage', points: stagePts, detail: `At "${lead.stage.replace('_', ' ')}" — ${stagePts >= 28 ? 'deep in the funnel' : stagePts >= 12 ? 'progressing' : 'early stage'}` });

  const priorityScores: Record<Priority, number> = { hot: 25, warm: 15, cold: 5 };
  const prioPts = priorityScores[lead.priority] ?? 0;
  factors.push({ label: 'Priority', points: prioPts, detail: `Marked ${lead.priority}` });

  let budgetPts: number, budgetDetail: string;
  if (lead.budget >= 30000000) { budgetPts = 20; budgetDetail = 'Premium budget (₹3 Cr+)'; }
  else if (lead.budget >= 15000000) { budgetPts = 14; budgetDetail = 'Strong budget (₹1.5 Cr+)'; }
  else if (lead.budget >= 8000000) { budgetPts = 9; budgetDetail = 'Mid budget (₹80 L+)'; }
  else { budgetPts = 4; budgetDetail = 'Entry budget'; }
  factors.push({ label: 'Budget', points: budgetPts, detail: budgetDetail });

  const daysSince = (Date.now() - new Date(lead.lastContact).getTime()) / 86400000;
  let recencyPts = 0, recencyDetail = 'Gone quiet — no contact in 2+ weeks';
  if (daysSince <= 2) { recencyPts = 15; recencyDetail = 'Contacted in the last 48h — hot'; }
  else if (daysSince <= 7) { recencyPts = 10; recencyDetail = 'Contacted this week'; }
  else if (daysSince <= 14) { recencyPts = 5; recencyDetail = 'Contacted in the last fortnight'; }
  factors.push({ label: 'Engagement recency', points: recencyPts, detail: recencyDetail });

  const strongSources = ['Referral', 'Walk-in', 'Website'];
  const srcPts = strongSources.includes(lead.source) ? 5 : 2;
  factors.push({ label: 'Lead source', points: srcPts, detail: `${lead.source}${strongSources.includes(lead.source) ? ' — high-intent channel' : ''}` });

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));

  // Human-actionable recommendation derived from the weakest lever
  let nextBestAction = 'Keep nurturing on the current plan.';
  if (lead.stage !== 'booked' && lead.stage !== 'lost') {
    if (daysSince > 7) nextBestAction = 'Reach out now — engagement has gone cold and recency is your biggest score drag.';
    else if (stagePts < 20) nextBestAction = 'Qualify budget & timeline to move this out of the early funnel.';
    else if (lead.stage === 'visit_scheduled') nextBestAction = 'Confirm the site visit and prep a personalized unit shortlist.';
    else if (lead.stage === 'negotiation') nextBestAction = 'Send the payment plan and push for a booking token.';
    else nextBestAction = 'Book a site visit while interest is warm.';
  }
  return { score, factors, nextBestAction };
}
