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
export type Role =
  | 'super_admin' | 'tech_team'
  | 'builder_admin' | 'sales_manager' | 'sales_executive' | 'site_engineer'
  | 'telecaller' | 'accountant' | 'auditor';

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
 *  Marking a recurring filing as filed auto-creates the next occurrence. */
export interface ComplianceItem {
  id: string;
  tenantId: string;
  title: string;
  authority: string;         // 'GST', 'RERA', 'Income Tax', 'EPFO/ESIC', …
  dueDate: string;
  frequency: FilingFrequency;
  projectId?: string;        // RERA filings are per-project
  notes?: string;
  status: 'pending' | 'filed';
  filedAt?: string;
  filedBy?: string;
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

export type JournalSource = 'manual' | 'vendor_bill' | 'ra_bill' | 'customer_payment' | 'ap_payment';

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
