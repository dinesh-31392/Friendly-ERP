// Widened to admit tenant-defined custom stages (metadata-driven pipeline).
// The literal members keep autocomplete; `(string & {})` allows custom keys.
// 'new', 'booked', 'lost' are core stages that always exist for every tenant.
export type LeadStage =
  | 'new' | 'contacted' | 'qualified' | 'visit_scheduled' | 'negotiation' | 'booked' | 'lost'
  | (string & {});
export type UnitStatus = 'available' | 'reserved' | 'blocked' | 'booked' | 'sold' | 'on_hold';
// 'tech_team' = branch-scoped platform staff who onboard builders (into a
// PENDING state) but cannot approve them — approval is super_admin only.
// 'site_engineer' = field/construction staff: runs execution & site stock but
// never sees the sales pipeline or finance.
// 'telecaller' = pre-sales: creates/qualifies leads and schedules visits but
// cannot quote or book — hands qualified leads to a sales executive.
// 'accountant' = finance staff: journals, bills, payments — no final approval.
// 'auditor' = read-only across every module plus the audit log.
// 'land_manager' = sources & works land deals up to feasibility; cannot
// qualify their own lead (maker). 'bd_manager' = business development, the
// checker who qualifies a land lead into the pipeline.
export type Role =
  | 'super_admin' | 'tech_team'
  | 'builder_admin' | 'sales_manager' | 'sales_executive' | 'site_engineer'
  | 'telecaller' | 'accountant' | 'auditor'
  | 'land_manager' | 'bd_manager' | 'hr_manager';

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
  /** Users in this workspace, counted BY THE SERVER (GET /api/tenants).
   *  The platform console cannot count them client-side: row-level security
   *  means the browser never holds another tenant's user rows. Undefined in
   *  browser-only demo mode. */
  userCount?: number;
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
  /** Project-level scoping (spec: user_project_assignments). When set on a
   *  sales executive / telecaller, their lead visibility narrows to these
   *  projects plus leads assigned directly to them. Empty/undefined = no
   *  project restriction. */
  projectIds?: string[];
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
  /** Required whenever stage = 'lost' — captured by the lost-reason prompt */
  lostReason?: string;
  /** Set when the lead was knowingly created despite matching an existing
   *  lead's phone/email — keeps the duplicate traceable instead of silent */
  duplicateOf?: string;
  /** Answers to the builder's chatbot custom questions, keyed by field key.
   *  Only populated for chatbot/microsite captures. */
  customFields?: Record<string, string>;
  /** Qualification snapshot captured at intake (chatbot). Live scoring still
   *  comes from explainLeadScore; this preserves what the bot decided. */
  qualification?: LeadQualification;
  lastContact: string;
  createdAt: string;
  /** When the customer actually got in touch. Equals createdAt for a lead
   *  captured live; for a bulk import it is the date from the file, which is
   *  what every response-time and ageing figure must be computed from. */
  enquiredAt?: string;
}

export type QualificationStatus = 'hot' | 'warm' | 'cold' | 'unqualified';

/** A point-in-time qualification result attached to a captured lead. */
export interface LeadQualification {
  status: QualificationStatus;
  score: number;        // 0–100
  reasons: string[];    // human-readable factors behind the status
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
  /** The value the booking was actually struck at — the accepted quotation's
   *  total (incl. approved discount/charges) when booked from a quote, else the
   *  unit price. The payment schedule, broker commission and KPIs all read this
   *  so they never disagree. Optional for rows created before this field. */
  value?: number;
  paymentPlan: string;
  stage: BookingStage;
  /** Set when a non-approver asks to cancel — a booking manager must confirm
   *  (spec matrix: sales exec cancels by request only). */
  cancelRequested?: boolean;
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
  /** 'demanded' = a demand letter has been raised and the amount is now due
   *  (construction-linked demands flip pending→demanded when the milestone
   *  completes); 'paid' once collected. */
  status: 'pending' | 'demanded' | 'paid' | 'overdue';
  paidDate?: string;
  /** When the demand was raised (construction milestone or manual). */
  demandedDate?: string;
  /** How this installment falls due: on a construction milestone, or on time. */
  trigger?: 'construction_milestone' | 'time';
  /** For construction-linked installments, the milestone that releases the
   *  demand (matched against the site-task/milestone title). */
  milestoneLabel?: string;
  description: string;
}

/** One line in a buyer's Statement of Account — a demand raised (debit) or a
 *  receipt collected (credit). The running balance is derived when rendered. */
export interface CustomerLedgerEntry {
  id: string;
  tenantId: string;
  leadId: string;
  bookingId: string;
  date: string;
  type: 'demand' | 'receipt';
  description: string;
  debit: number;    // amount demanded (0 for receipts)
  credit: number;   // amount received (0 for demands)
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

// ─────────────────────────────────────────────────────────────────────────────
// ERP: Project Execution (site tasks, progress log, RFIs, change orders,
// inspections). Distinct from `Task`, which is a personal CRM to-do — these are
// construction-side records scoped to a project/site.
// ─────────────────────────────────────────────────────────────────────────────

export type SiteTaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'done';

export interface SiteTask {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  description?: string;
  /** Milestones drive the project timeline & the "next milestone" dashboards */
  isMilestone: boolean;
  startDate?: string;
  dueDate: string;
  completedAt?: string;
  status: SiteTaskStatus;
  progress: number;          // 0–100
  assignedTo?: string;       // userId
  /** Other SiteTask ids that must finish first — a task with unfinished
   *  dependencies cannot be started (enforced in executionService). */
  dependsOn: string[];
  createdAt: string;
}

/** Daily/weekly site progress entry with photos (stored as compressed
 *  data-URLs in demo mode; object storage in server mode). */
export interface ProgressUpdate {
  id: string;
  tenantId: string;
  projectId: string;
  userId: string;
  date: string;
  summary: string;
  workforce?: number;        // headcount on site that day
  photos: string[];
  createdAt: string;
}

export type RfiStatus = 'open' | 'answered' | 'closed';

export interface Rfi {
  id: string;
  tenantId: string;
  projectId: string;
  number: number;            // sequential per project → "RFI-004"
  subject: string;
  question: string;
  raisedBy: string;          // userId
  assignedTo?: string;
  status: RfiStatus;
  answer?: string;
  answeredAt?: string;
  dueDate?: string;
  createdAt: string;
}

export type ChangeOrderStatus = 'pending_approval' | 'approved' | 'rejected';

export interface ChangeOrder {
  id: string;
  tenantId: string;
  projectId: string;
  number: number;            // sequential per project → "CO-002"
  title: string;
  reason: string;
  costImpact: number;        // signed; + increases contract value
  timeImpactDays: number;    // signed; + extends the schedule
  status: ChangeOrderStatus;
  requestedBy: string;       // userId
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export type InspectionType = 'quality' | 'safety';
export type InspectionStatus = 'scheduled' | 'passed' | 'failed';
export type InspectionItemResult = 'pending' | 'pass' | 'fail' | 'na';

export interface InspectionItem {
  id: string;
  label: string;
  result: InspectionItemResult;
  remark?: string;
}

export interface Inspection {
  id: string;
  tenantId: string;
  projectId: string;
  type: InspectionType;
  title: string;
  date: string;
  inspectorId: string;       // userId
  status: InspectionStatus;
  items: InspectionItem[];
  notes?: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERP: Procurement & Materials (vendors, POs, site stock, plant & machinery)
// ─────────────────────────────────────────────────────────────────────────────

export interface Vendor {
  id: string;
  tenantId: string;
  name: string;
  category: string;          // 'Cement & RMC', 'Steel', 'Electrical', …
  contactPerson?: string;
  phone: string;
  email?: string;
  gst?: string;
  address?: string;
  rating?: number;           // 1–5, set from received-order experience
  status: 'active' | 'inactive';
  createdAt: string;
}

export type PoStatus = 'pending_approval' | 'approved' | 'partially_received' | 'received' | 'cancelled';

export interface PurchaseOrderLine {
  id: string;
  materialId?: string;       // links receipts into site stock
  description: string;
  unit: string;              // 'bag', 'MT', 'nos', …
  qty: number;
  rate: number;
  receivedQty: number;
}

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  number: number;            // sequential per tenant → "PO-0007"
  vendorId: string;
  projectId?: string;        // deliver-to site
  status: PoStatus;
  lines: PurchaseOrderLine[];
  expectedDate?: string;
  notes?: string;
  createdBy: string;         // userId
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
}

export interface Material {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  unit: string;
  /** Aggregate on-hand quantity at/below this level raises a reorder alert */
  reorderLevel: number;
  createdAt: string;
}

export type StockTxnType = 'inward' | 'outward';

/** Material movement at a site. Inward = GRN against a PO or direct purchase;
 *  outward = issued for consumption. On-hand stock is derived, never stored. */
export interface StockTransaction {
  id: string;
  tenantId: string;
  materialId: string;
  projectId?: string;        // site; undefined = central store
  type: StockTxnType;
  qty: number;
  rate?: number;             // inward cost per unit
  vendorId?: string;
  poId?: string;
  reference?: string;        // challan / bill no.
  notes?: string;
  createdBy: string;         // userId
  date: string;
  createdAt: string;
}

export type MachineStatus = 'on_site' | 'idle' | 'maintenance';

export interface Machine {
  id: string;
  tenantId: string;
  name: string;
  category: string;          // 'Excavator', 'Tower Crane', …
  registrationNo?: string;
  ownership: 'owned' | 'rented';
  projectId?: string;        // current deployment site
  status: MachineStatus;
  nextServiceDate?: string;
  notes?: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERP: Finance — accounts payable & project budgets. The receivable side
// (Invoice / PaymentPlan / Installment) already exists above.
// ─────────────────────────────────────────────────────────────────────────────

export type VendorBillStatus = 'pending' | 'approved' | 'paid';

export interface VendorBill {
  id: string;
  tenantId: string;
  vendorId: string;
  poId?: string;
  projectId?: string;
  billNumber: string;        // the vendor's own invoice number
  category: string;          // cost head — matches ProjectBudget.category
  amount: number;
  billDate: string;
  dueDate: string;
  status: VendorBillStatus;
  paidAt?: string;
  notes?: string;
  createdAt: string;
}

/** One budget line per cost head per project. Actuals are derived from vendor
 *  bills (approved + paid) in the same category — never stored. */
export interface ProjectBudget {
  id: string;
  tenantId: string;
  projectId: string;
  category: string;
  budgeted: number;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERP: HR & Workforce (employees, attendance, leave, payroll) and statutory
// compliance filings. An Employee is an HR record, distinct from `User` (a
// login) — most site crew never sign in; link via userId when they do.
// ─────────────────────────────────────────────────────────────────────────────

export type EmployeeType = 'staff' | 'contract_worker';

export interface Employee {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  email?: string;
  designation: string;       // 'Site Supervisor', 'Accountant', 'Mason'…
  department: string;
  type: EmployeeType;
  projectId?: string;        // default site for field staff / crew
  monthlySalary?: number;    // staff
  dailyWage?: number;        // contract workers — payroll = wage × days present
  joinDate: string;
  active: boolean;
  userId?: string;           // optional link to a login account
  createdAt: string;
}

/** One row per employee per day. Check-in/out are timestamps; lat/lng is the
 *  geo stamp captured on site (method 'geo') or absent for manual marking. */
export interface AttendanceRecord {
  id: string;
  tenantId: string;
  employeeId: string;
  date: string;              // YYYY-MM-DD
  checkIn: string;
  checkOut?: string;
  projectId?: string;
  lat?: number;
  lng?: number;
  method: 'geo' | 'manual';
  createdAt: string;
}

export type LeaveType = 'casual' | 'sick' | 'earned' | 'unpaid';
export type LeaveStatus = 'pending' | 'approved' | 'rejected';

export interface LeaveRequest {
  id: string;
  tenantId: string;
  employeeId: string;
  type: LeaveType;
  from: string;
  to: string;
  days: number;
  reason?: string;
  status: LeaveStatus;
  decidedBy?: string;        // userId
  decidedAt?: string;
  createdAt: string;
}

export interface PayrollItem {
  employeeId: string;
  name: string;
  designation: string;
  empType: EmployeeType;
  /** 'Monthly salary' or '18 days × ₹800' — how gross was arrived at */
  basis: string;
  daysPresent?: number;
  gross: number;
}

export interface PayrollRun {
  id: string;
  tenantId: string;
  month: string;             // YYYY-MM
  status: 'draft' | 'processed';
  items: PayrollItem[];
  processedBy?: string;
  processedAt?: string;
  createdAt: string;
}

export type FilingFrequency = 'one_time' | 'monthly' | 'quarterly' | 'annual';

/** A statutory/compliance deadline (GST return, RERA QPR, TDS, PF/ESI…).
 *  Marking a recurring filing as filed auto-creates the next occurrence.
 *  When a tax amount is known, a filed item can be marked paid — remitting
 *  it posts against the statutory-liability ledger account. */
export interface ComplianceItem {
  id: string;
  tenantId: string;
  title: string;
  authority: string;         // 'GST', 'RERA', 'Income Tax', 'EPFO/ESIC', …
  dueDate: string;
  frequency: FilingFrequency;
  projectId?: string;        // RERA filings are per-project
  amount?: number;           // tax/fee due this period (tax_postings.amount)
  notes?: string;
  status: 'pending' | 'filed' | 'paid';
  filedAt?: string;
  filedBy?: string;
  paidAt?: string;
  createdAt: string;
}

/** A signed-in device/browser. Written at login, checked on every session
 *  restore — revoking a row signs that device out (spec §4: admins can see
 *  and revoke active sessions per user). */
export interface DeviceSession {
  id: string;
  tenantId: string;
  userId: string;
  token: string;
  device: string;            // short human label parsed from the user agent
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERP: Accounts & ledger (double-entry), contractor RA billing, AP payments,
// quotations and configurable approval thresholds — per the finance/CRM
// addendum specs.
// ─────────────────────────────────────────────────────────────────────────────

export type AccountType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

export interface Account {
  id: string;
  tenantId: string;
  code: string;              // '1000', '5200' — sortable, groupable
  name: string;
  type: AccountType;
  /** Seeded system accounts back auto-posting and cannot be deleted */
  isSystem: boolean;
  active: boolean;
  createdAt: string;
}

export interface JournalLine {
  id: string;
  accountId: string;
  debit: number;             // exactly one of debit/credit is non-zero
  credit: number;
  note?: string;
}

export type JournalSource = 'manual' | 'vendor_bill' | 'ra_bill' | 'customer_payment' | 'ap_payment' | 'revenue_recognition';

/** A balanced double-entry posting. System entries are generated by bill /
 *  payment flows; manual entries come from the Journal screen. Every entry
 *  must satisfy Σdebit = Σcredit — enforced before it is stored. */
export interface JournalEntry {
  id: string;
  tenantId: string;
  date: string;              // YYYY-MM-DD
  narration: string;
  reference?: string;
  sourceType: JournalSource;
  sourceId?: string;         // originating bill / payment / RA id
  projectId?: string;        // cost-center dimension (projects are the cost centers)
  status: 'draft' | 'posted';
  lines: JournalLine[];
  createdBy: string;
  postedBy?: string;
  postedAt?: string;
  createdAt: string;
}

export type PaymentMode = 'bank_transfer' | 'cheque' | 'upi' | 'cash' | 'card';

/** Money going OUT (accounts payable) — against a vendor bill or an RA bill. */
export interface PaymentMade {
  id: string;
  tenantId: string;
  vendorId: string;
  vendorBillId?: string;
  raBillId?: string;         // exactly one of the two references is set
  amount: number;
  date: string;
  mode: PaymentMode;
  reference?: string;        // cheque no. / UTR
  paidBy: string;            // userId
  createdAt: string;
}

export interface RaDeduction { label: string; amount: number }

export type RaBillStatus = 'submitted' | 'site_approved' | 'approved' | 'paid';

/**
 * Contractor running-account bill. Two-stage approval by design: the site
 * (progress verification) signs off first, finance approves payment second —
 * separate permissions, never collapsed into one. Billing above the logged
 * site progress requires an explicit override reason.
 */
export interface RaBill {
  id: string;
  tenantId: string;
  vendorId: string;          // contractor (vendor master)
  projectId: string;
  raNumber: number;          // sequential per (contractor, project) → "RA-3"
  progressPct: number;       // claimed work progress this bill covers, cumulative
  siteProgressPct: number | null;  // Execution's logged % at submission (null = no tasks logged)
  overrideReason?: string;   // required when progressPct exceeds siteProgressPct
  grossAmount: number;
  retentionAmount: number;   // withheld pending defect-liability period
  deductions: RaDeduction[]; // TDS, advance recovery…
  netPayable: number;        // gross − retention − Σdeductions
  status: RaBillStatus;
  signedOffBy?: string;      // site/PMC verification
  signedOffAt?: string;
  approvedBy?: string;       // finance approval
  approvedAt?: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
}

export type QuotationStatus = 'draft' | 'pending_approval' | 'sent' | 'accepted' | 'rejected' | 'expired';

export interface QuotationCharge { label: string; amount: number }

/** A priced offer for a unit. Discounts above the tenant's configured
 *  threshold park the quote in pending_approval until a discount approver
 *  releases it. An accepted quotation converts into a booking. */
export interface Quotation {
  id: string;
  tenantId: string;
  leadId: string;
  unitId: string;
  baseAmount: number;        // unit price at quoting time
  charges: QuotationCharge[];
  discountAmount: number;
  discountApprovedBy?: string;
  totalAmount: number;       // base + Σcharges − discount
  validUntil: string;
  status: QuotationStatus;
  createdBy: string;
  createdAt: string;
}

export type ApprovalAction = 'discount' | 'vendor_bill' | 'ra_bill';

/** Editable approval thresholds (spec: expose the matrix as config, don't
 *  hardcode). Amounts at/above the threshold require the corresponding
 *  approve_* permission; below it, the maker can proceed alone. */
export interface ApprovalRule {
  id: string;
  tenantId: string;
  actionType: ApprovalAction;
  thresholdAmount: number;   // 0 = always requires approval
  updatedAt: string;
}

// ── Banking & reconciliation ─────────────────────────────────────────────────

export interface BankAccount {
  id: string;
  tenantId: string;
  name: string;              // 'HDFC Current A/c'
  bankName?: string;
  accountNumber?: string;    // masked/short form is fine — display only
  openingBalance: number;
  createdAt: string;
}

/** One bank-statement line. `debit` = money OUT of the bank account,
 *  `credit` = money IN (bank-statement convention). */
export interface BankTransaction {
  id: string;
  tenantId: string;
  bankAccountId: string;
  date: string;              // YYYY-MM-DD
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  reconciled: boolean;
  matchedJournalEntryId?: string;
  createdAt: string;
}

// ── Loans ────────────────────────────────────────────────────────────────────

export type LoanType = 'term_loan' | 'overdraft' | 'mortgage' | 'inter_company';

export interface LoanInstallment {
  number: number;
  dueDate: string;
  principal: number;
  interest: number;
  tds: number;               // TDS deducted from the interest portion
  status: 'pending' | 'paid';
  paidAt?: string;
  serverId?: string;         // loan_repayment_schedule row id (API mode only)
}

/** Borrowing with an annuity (EMI) repayment schedule generated at creation.
 *  Disbursement and each repayment post to the ledger. */
export interface Loan {
  id: string;
  tenantId: string;
  projectId?: string;
  lenderName: string;
  loanType: LoanType;
  principal: number;
  interestRatePct: number;   // annual
  tenureMonths: number;
  tdsPct: number;            // on interest; 0 = no TDS
  startDate: string;
  schedule: LoanInstallment[];
  status: 'active' | 'closed';
  createdAt: string;
}

export const LOAN_TYPES: { id: LoanType; label: string }[] = [
  { id: 'term_loan', label: 'Term Loan' },
  { id: 'overdraft', label: 'Overdraft' },
  { id: 'mortgage', label: 'Mortgage' },
  { id: 'inter_company', label: 'Inter-company' },
];

export const ACCOUNT_TYPES: { id: AccountType; label: string }[] = [
  { id: 'asset', label: 'Assets' },
  { id: 'liability', label: 'Liabilities' },
  { id: 'equity', label: 'Equity' },
  { id: 'income', label: 'Income' },
  { id: 'expense', label: 'Expenses' },
];

export const PAYMENT_MODES: { id: PaymentMode; label: string }[] = [
  { id: 'bank_transfer', label: 'Bank Transfer' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'upi', label: 'UPI' },
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
];

export const LOST_REASONS = ['Price', 'Location', 'Competitor', 'Timeline', 'Financing', 'Other'];

// ─────────────────────────────────────────────────────────────────────────────
// ERP: Land Management (deal sourcing → feasibility → convert-to-project).
// The front of the acquisition funnel, ahead of the sales pipeline.
// ─────────────────────────────────────────────────────────────────────────────

export type LandLeadStatus =
  | 'lead_reference' | 'property_details' | 'feasibility_working'
  | 'qualified' | 'converted_to_project' | 'rejected';
export type LandReferenceSource = 'broker' | 'direct' | 'auction' | 'government';
export type OwnershipType = 'freehold' | 'leasehold' | 'government_allotted';
export type LitigationStatus = 'none' | 'pending' | 'resolved';
export type LandDocType = 'title_deed' | '7_12_extract' | 'survey_map' | 'noc' | 'encumbrance_certificate';
export type DocVerificationStatus = 'pending' | 'verified' | 'rejected';

/** A land parcel under evaluation. Property details are 1:1 so they ride
 *  inline; feasibility history and documents are separate collections. */
export interface LandLead {
  id: string;
  tenantId: string;
  referenceSource: LandReferenceSource;
  ownerName: string;
  ownerContact: string;
  location: string;
  city: string;
  state: string;
  pincode: string;
  surveyNumber: string;
  areaAcres: number;
  askingPrice: number;
  status: LandLeadStatus;
  rejectionReason?: string;
  assignedTo?: string;          // land manager userId
  // ── Property details (1:1) ──
  ownershipType?: OwnershipType;
  zoning?: string;              // 'Residential R1', 'Commercial', 'Mixed'
  fsiPermissible?: number;
  fsiConsumed?: number;
  roadWidthFt?: number;
  isEncumbered: boolean;
  encumbranceNotes?: string;
  litigationStatus: LitigationStatus;
  // ── Provenance / linkage ──
  duplicateOf?: string;         // flagged possible duplicate (same survey no.)
  projectId?: string;           // set once converted
  latestScore?: number;         // cached from the most recent feasibility run
  createdBy?: string;
  createdAt: string;
}

/** One feasibility computation. Kept as history — a parcel is re-scored as
 *  numbers firm up, and prior runs must remain auditable. */
export interface FeasibilityRecord {
  id: string;
  tenantId: string;
  landLeadId: string;
  costPerSqft: number;
  saleableArea: number;
  estimatedRevenue: number;
  marginPercent: number;
  score: number;                // 0–100
  cappedByRisk: boolean;        // true when litigation/encumbrance capped it
  computedBy: string;
  computedAt: string;
}

/** Title deeds and survey docs are versioned, never overwritten — full
 *  history is retained for dispute resolution years later. */
export interface LandDocument {
  id: string;
  tenantId: string;
  landLeadId: string;
  docType: LandDocType;
  version: number;
  fileName: string;
  verificationStatus: DocVerificationStatus;
  verifiedBy?: string;
  verifiedAt?: string;
  uploadedBy: string;
  createdAt: string;
}

export const LAND_STATUSES: { id: LandLeadStatus; label: string; color: string }[] = [
  { id: 'lead_reference', label: 'Lead Reference', color: 'bg-zinc-400' },
  { id: 'property_details', label: 'Property Details', color: 'bg-blue-500' },
  { id: 'feasibility_working', label: 'Feasibility', color: 'bg-amber-500' },
  { id: 'qualified', label: 'Qualified', color: 'bg-indigo-500' },
  { id: 'converted_to_project', label: 'Converted', color: 'bg-emerald-500' },
  { id: 'rejected', label: 'Rejected', color: 'bg-red-400' },
];

export const LAND_DOC_TYPES: { id: LandDocType; label: string }[] = [
  { id: 'title_deed', label: 'Title Deed' },
  { id: '7_12_extract', label: '7/12 Extract' },
  { id: 'survey_map', label: 'Survey Map' },
  { id: 'noc', label: 'NOC' },
  { id: 'encumbrance_certificate', label: 'Encumbrance Certificate' },
];

export interface FeasibilityFactor { label: string; points: number; detail: string }

/**
 * Explainable land-feasibility score (0–100). Same responsible-AI principle as
 * the lead scorer: a number that decides whether the company commits capital to
 * a parcel must be transparent and auditable, never a black box.
 *
 * Weights (documented so the model is defensible if questioned):
 *   • FSI utilisation headroom   — 25 pts. Unused FSI (permissible − consumed)
 *     is buildable upside; a parcel with FSI already fully consumed scores 0
 *     here, a virgin parcel scores full.
 *   • Estimated margin           — 35 pts. The single biggest driver; 30%+
 *     margin earns the full weight, scaled down linearly below that.
 *   • Road-width adequacy        — 15 pts. Below a 30 ft access threshold is a
 *     real constructability/approval penalty.
 *   • Ownership clarity          — 10 pts. Freehold clean; leasehold/govt
 *     allotted carry residual risk.
 *   • Legal cleanliness          — 15 pts. No encumbrance/litigation = full.
 *
 * HARD CAP: any *unresolved* litigation (status = 'pending') caps the total at
 * 20 regardless of everything else — a fat margin must never mask a live legal
 * risk. An encumbrance without litigation applies a −20 penalty instead.
 */
export function explainLandFeasibility(input: {
  fsiPermissible?: number; fsiConsumed?: number; marginPercent: number;
  roadWidthFt?: number; ownershipType?: OwnershipType;
  isEncumbered: boolean; litigationStatus: LitigationStatus;
}): { score: number; cappedByRisk: boolean; factors: FeasibilityFactor[]; verdict: string } {
  const factors: FeasibilityFactor[] = [];

  const perm = input.fsiPermissible ?? 0;
  const cons = input.fsiConsumed ?? 0;
  const headroom = perm > 0 ? Math.max(0, Math.min(1, (perm - cons) / perm)) : 0;
  const fsiPts = Math.round(headroom * 25);
  factors.push({ label: 'FSI headroom', points: fsiPts, detail: perm > 0 ? `${Math.round(headroom * 100)}% of permissible FSI still buildable` : 'FSI not captured yet' });

  const marginPts = Math.round(Math.max(0, Math.min(1, input.marginPercent / 30)) * 35);
  factors.push({ label: 'Estimated margin', points: marginPts, detail: `${input.marginPercent.toFixed(1)}% projected margin` });

  const road = input.roadWidthFt ?? 0;
  const roadPts = road >= 40 ? 15 : road >= 30 ? 10 : road > 0 ? 4 : 0;
  factors.push({ label: 'Access / road width', points: roadPts, detail: road > 0 ? `${road} ft frontage${road < 30 ? ' — below the 30 ft threshold' : ''}` : 'road width not captured' });

  const ownPts = input.ownershipType === 'freehold' ? 10 : input.ownershipType ? 5 : 0;
  factors.push({ label: 'Ownership clarity', points: ownPts, detail: input.ownershipType ? input.ownershipType.replace('_', ' ') : 'ownership not captured' });

  const legalClean = !input.isEncumbered && input.litigationStatus === 'none';
  const legalPts = legalClean ? 15 : input.litigationStatus === 'resolved' ? 8 : 0;
  factors.push({ label: 'Legal cleanliness', points: legalPts, detail: legalClean ? 'no encumbrance or litigation' : input.litigationStatus === 'pending' ? 'LIVE litigation' : input.isEncumbered ? 'encumbered' : 'litigation resolved' });

  let score = factors.reduce((s, f) => s + f.points, 0);
  let cappedByRisk = false;
  if (input.litigationStatus === 'pending') { score = Math.min(score, 20); cappedByRisk = true; }
  else if (input.isEncumbered) { score = Math.max(0, score - 20); cappedByRisk = true; }
  score = Math.max(0, Math.min(100, score));

  let verdict = 'Weak parcel — margin, access or FSI headroom too thin.';
  if (cappedByRisk && input.litigationStatus === 'pending') verdict = 'Blocked on legal — resolve the live litigation before qualifying.';
  else if (score >= 70) verdict = 'Strong parcel — clear to qualify for the acquisition pipeline.';
  else if (score >= 45) verdict = 'Workable — qualify only if the margin assumptions hold.';
  return { score, cappedByRisk, factors, verdict };
}

// ─────────────────────────────────────────────────────────────────────────────
// ERP: Business Development (deal sourcing → hand-off into Land Acquisition).
// Distinct from Land's technical feasibility — this is the opportunity/JV
// pipeline that PRECEDES it. A hand-off cross-links a BD deal to a land parcel.
// ─────────────────────────────────────────────────────────────────────────────

export type BdOpportunityType = 'land_acquisition' | 'jv' | 'redevelopment_society';
export type BdSource = 'broker' | 'direct_approach' | 'referral' | 'rfp';
export type BdStage =
  | 'identified' | 'initial_discussion' | 'terms_negotiation'
  | 'handed_to_land' | 'closed_lost';
export type JvStructure = 'revenue_share' | 'area_share' | 'outright_purchase';

export interface BdLead {
  id: string;
  tenantId: string;
  opportunityType: BdOpportunityType;
  source: BdSource;
  counterpartyName: string;
  counterpartyContact: string;
  city: string;
  stage: BdStage;
  estimatedDealValue: number;
  closedLostReason?: string;
  ownedBy?: string;             // bd_manager userId
  // ── JV terms (1:1, inline; only meaningful for opportunityType 'jv') ──
  jvStructure?: JvStructure;
  revenueSharePercent?: number;
  areaSharePercent?: number;
  jvNotes?: string;
  // ── Linkage ──
  landLeadId?: string;          // set on hand-off — the created Land parcel
  createdBy?: string;
  createdAt: string;
}

/** A saved market-analysis snapshot, queryable by area over time so a BD
 *  manager can see how their own pricing benchmarks evolved before an offer. */
export interface MarketReport {
  id: string;
  tenantId: string;
  areaName: string;
  reportType: 'pricing_benchmark' | 'competitor_launch' | 'demand_supply';
  findings: string;
  dataSources?: string;
  createdBy: string;
  createdAt: string;
}

export const BD_STAGES: { id: BdStage; label: string; color: string }[] = [
  { id: 'identified', label: 'Identified', color: 'bg-zinc-400' },
  { id: 'initial_discussion', label: 'Initial Discussion', color: 'bg-blue-500' },
  { id: 'terms_negotiation', label: 'Terms Negotiation', color: 'bg-amber-500' },
  { id: 'handed_to_land', label: 'Handed to Land', color: 'bg-emerald-500' },
  { id: 'closed_lost', label: 'Closed Lost', color: 'bg-red-400' },
];

export const BD_OPPORTUNITY_TYPES: { id: BdOpportunityType; label: string }[] = [
  { id: 'land_acquisition', label: 'Land Acquisition' },
  { id: 'jv', label: 'Joint Venture' },
  { id: 'redevelopment_society', label: 'Redevelopment / Society' },
];

export const MARKET_REPORT_TYPES: { id: MarketReport['reportType']; label: string }[] = [
  { id: 'pricing_benchmark', label: 'Pricing Benchmark' },
  { id: 'competitor_launch', label: 'Competitor Launch' },
  { id: 'demand_supply', label: 'Demand / Supply' },
];

export const DEPARTMENTS = ['Engineering', 'Sales', 'Accounts', 'Procurement', 'Admin & HR', 'Labour', 'Other'];

export const LEAVE_TYPES: { id: LeaveType; label: string }[] = [
  { id: 'casual', label: 'Casual' },
  { id: 'sick', label: 'Sick' },
  { id: 'earned', label: 'Earned' },
  { id: 'unpaid', label: 'Unpaid' },
];

export const FILING_AUTHORITIES = ['GST', 'RERA', 'Income Tax / TDS', 'EPFO / ESIC', 'Labour Dept', 'Municipal', 'Other'];

export const SITE_TASK_STATUSES: { id: SiteTaskStatus; label: string; color: string }[] = [
  { id: 'not_started', label: 'Not Started', color: 'bg-zinc-400' },
  { id: 'in_progress', label: 'In Progress', color: 'bg-blue-500' },
  { id: 'blocked', label: 'Blocked', color: 'bg-red-500' },
  { id: 'done', label: 'Done', color: 'bg-emerald-500' },
];

export const PO_STATUSES: { id: PoStatus; label: string }[] = [
  { id: 'pending_approval', label: 'Pending Approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'partially_received', label: 'Partially Received' },
  { id: 'received', label: 'Received' },
  { id: 'cancelled', label: 'Cancelled' },
];

export const VENDOR_CATEGORIES = [
  'Cement & RMC', 'Steel', 'Aggregates & Sand', 'Electrical', 'Plumbing & Sanitary',
  'Paint & Finishes', 'Tiles & Flooring', 'Doors & Windows', 'Labour Contractor',
  'Equipment Rental', 'Other',
];

export const MATERIAL_UNITS = ['bag', 'MT', 'kg', 'cum', 'sqft', 'nos', 'ltr', 'roll', 'box'];

/** Cost heads shared by vendor bills and project budgets so budget-vs-actual
 *  lines up without any mapping table. */
export const BUDGET_CATEGORIES = [
  'Civil & Structure', 'Materials', 'Electrical', 'Plumbing', 'Finishes',
  'Labour', 'Equipment', 'Consultants & Fees', 'Marketing', 'Other',
];

export const MACHINE_CATEGORIES = [
  'Excavator', 'Backhoe Loader', 'Tower Crane', 'Mobile Crane', 'Concrete Pump',
  'Transit Mixer', 'Batching Plant', 'Compactor', 'Generator', 'Hoist', 'Other',
];

/** Default inspection checklists — sensible starting points a site team can
 *  edit per inspection. Friendly-ERP principle: defaults over configuration. */
export const INSPECTION_TEMPLATES: Record<InspectionType, { title: string; items: string[] }[]> = {
  quality: [
    {
      title: 'Concrete Pour — Pre-pour Checklist',
      items: [
        'Shuttering aligned, plumb and rigid', 'Reinforcement as per bar-bending schedule',
        'Cover blocks in place', 'Embedments & sleeves positioned', 'Surface clean and watered',
      ],
    },
    {
      title: 'Brickwork / Blockwork Quality',
      items: [
        'Mortar mix proportion verified', 'Courses level and joints staggered',
        'Wall plumb within tolerance', 'Curing arrangement in place',
      ],
    },
    {
      title: 'Waterproofing Check',
      items: [
        'Surface preparation complete', 'Membrane/coating applied per spec',
        'Upturns & corners treated', 'Ponding test passed',
      ],
    },
  ],
  safety: [
    {
      title: 'Weekly Site Safety Walk',
      items: [
        'PPE worn by all workers', 'Scaffolding tagged and inspected',
        'Edge protection & barricades in place', 'Electrical panels covered, cables routed safely',
        'First-aid box stocked & accessible', 'Housekeeping — access routes clear',
      ],
    },
    {
      title: 'Height Work Permit Check',
      items: [
        'Work-at-height permit issued', 'Full-body harnesses anchored',
        'Lifelines certified', 'Area below cordoned off',
      ],
    },
  ],
};

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
}, pipeline?: { id: string }[]): { score: number; factors: ScoreFactor[]; nextBestAction: string } {
  // A lead is a row from the API, not a value this module constructed, and a
  // row may predate a column or arrive from a partial payload. The score runs
  // inline while the list renders, so one absent `stage` took the whole Leads
  // page down behind an error boundary rather than degrading one row.
  const stage: LeadStage = lead.stage ?? 'new';
  const source: string = lead.source ?? 'Unknown';
  const factors: ScoreFactor[] = [];
  const stageScores: Record<string, number> = {
    new: 5, contacted: 12, qualified: 20, visit_scheduled: 28, negotiation: 36, booked: 40, lost: 0,
  };
  /**
   * A stage this map has never heard of is scored by its POSITION in the
   * tenant's own pipeline, not by a flat guess.
   *
   * The map is keyed on the DEFAULT pipeline, and stages are tenant data — the
   * product's own provisioning code creates a pipeline using `site_visit`,
   * which is not `visit_scheduled`. Every such lead fell through to the old
   * flat fallback of 18 and therefore scored BELOW a merely `qualified` lead at
   * 20: a lead that had already been to site ranked worse than one that had
   * not. The score decides who a salesperson calls next, so the funnel was
   * inverted at exactly the step that matters most.
   *
   * Position is scaled across the non-terminal stages, so the default pipeline
   * reproduces its own tuned numbers and a custom one lands sensibly between
   * them. `booked` and `lost` are core keys and never reach here.
   */
  const positional = (): number => {
    const ids = (pipeline ?? []).map(s => s.id).filter(id => id !== 'booked' && id !== 'lost');
    const i = ids.indexOf(stage);
    if (i < 0 || ids.length < 2) return 18;          // genuinely unknown — old behaviour
    return Math.round(5 + (i / (ids.length - 1)) * 31);   // 5 … 36, matching the named map
  };
  const stagePts = stageScores[stage] ?? positional();
  factors.push({ label: 'Pipeline stage', points: stagePts, detail: `At "${stage.replace('_', ' ')}" — ${stagePts >= 28 ? 'deep in the funnel' : stagePts >= 12 ? 'progressing' : 'early stage'}` });

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
  const srcPts = strongSources.includes(source) ? 5 : 2;
  factors.push({ label: 'Lead source', points: srcPts, detail: `${source}${strongSources.includes(source) ? ' — high-intent channel' : ''}` });

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));

  // Human-actionable recommendation derived from the weakest lever
  let nextBestAction = 'Keep nurturing on the current plan.';
  if (stage !== 'booked' && stage !== 'lost') {
    if (daysSince > 7) nextBestAction = 'Reach out now — engagement has gone cold and recency is your biggest score drag.';
    else if (stagePts < 20) nextBestAction = 'Qualify budget & timeline to move this out of the early funnel.';
    // Matched on the stage KEY containing "visit" rather than one exact
    // spelling: the default pipeline calls it visit_scheduled and the
    // provisioned one calls it site_visit, so the exact check never fired for a
    // real workspace and told reps to "book a site visit" for leads that had
    // already been to site.
    else if (/visit/.test(stage)) nextBestAction = 'Confirm the site visit and prep a personalized unit shortlist.';
    else if (stage === 'negotiation') nextBestAction = 'Send the payment plan and push for a booking token.';
    else nextBestAction = 'Book a site visit while interest is warm.';
  }
  return { score, factors, nextBestAction };
}
