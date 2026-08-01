import { getAll, create } from './db';
import {
  ensureCoa, postEntry, accountByCode, expenseAccountFor, COA,
  buildLoanSchedule, postLoanDisbursed,
} from './accountsService';
import { generatePaymentSchedule } from './paymentService';
import type {
  Tenant, User, Role, Project, Tower, Unit, Lead, Activity, Task, Booking,
  Invoice, Broker, Commission, LandLead, FeasibilityRecord, LandDocument,
  BdLead, MarketReport, Vendor, Material, StockTransaction, PurchaseOrder,
  Machine, VendorBill, ProjectBudget, Employee, AttendanceRecord, LeaveRequest,
  PayrollRun, ComplianceItem, SiteTask, Rfi, Inspection, Quotation, BankAccount,
  Loan,
} from '../types';

/**
 * In-app demo workspace seeder. Provisions ONE builder tenant + a user per role
 * and rich, cross-linked content across every module so a first-time visitor
 * lands on a populated ERP instead of blank pages.
 *
 * SAFETY: this is a demo/localStorage-only convenience, never a shipped
 * credential backdoor. The Login page only offers it in demo mode
 * (isDemoMode()); it is never wired to the real API backend, and it is
 * idempotent — clicking twice reuses the existing demo tenant rather than
 * duplicating data.
 */

export const DEMO_PASSWORD = 'Demo-2026';
export const DEMO_WORKSPACE_CODE = 'skyline-constructions';

export interface DemoAccount { role: Role; email: string; label: string; tab: 'platform' | 'builder' }

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { role: 'super_admin', email: 'operator@skyline.test', label: 'Super Admin', tab: 'platform' },
  { role: 'builder_admin', email: 'builderadmin@skyline.test', label: 'Builder Admin', tab: 'builder' },
  { role: 'sales_manager', email: 'salesmanager@skyline.test', label: 'Sales Manager', tab: 'builder' },
  { role: 'sales_executive', email: 'salesexecutive@skyline.test', label: 'Sales Executive', tab: 'builder' },
  { role: 'telecaller', email: 'telecaller@skyline.test', label: 'Telecaller', tab: 'builder' },
  { role: 'accountant', email: 'accountant@skyline.test', label: 'Accountant', tab: 'builder' },
  { role: 'auditor', email: 'auditor@skyline.test', label: 'Auditor', tab: 'builder' },
  { role: 'site_engineer', email: 'siteengineer@skyline.test', label: 'Site Engineer', tab: 'builder' },
  { role: 'land_manager', email: 'landmanager@skyline.test', label: 'Land Manager', tab: 'builder' },
  { role: 'bd_manager', email: 'bdmanager@skyline.test', label: 'BD Manager', tab: 'builder' },
];

const now = () => new Date().toISOString();
const rel = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const relDate = (days: number) => rel(days).slice(0, 10);
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthKey = (offset = 0) => {
  const d = new Date(); d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Seed (or reuse) the demo workspace. Returns the builder-admin login. */
export function seedDemoWorkspace(): { builderAdmin: User; tenant: Tenant } {
  const existing = getAll<Tenant>('tenants').find(t => t.slug === DEMO_WORKSPACE_CODE);
  if (existing) {
    const admin = getAll<User>('users').find(u => u.tenantId === existing.id && u.role === 'builder_admin');
    if (admin) return { builderAdmin: admin, tenant: existing };
  }

  // ── Tenants + users ────────────────────────────────────────────────────────
  const platform = create<Tenant>('tenants', {
    id: '', name: 'Platform', company: 'Platform', logo: '', brandVoice: '', audience: '', channels: [],
    plan: 'Enterprise', status: 'active', approvalStatus: 'approved', slug: 'platform',
    country: 'India', currency: 'INR', email: 'operator@skyline.test', phone: '', address: '', createdAt: now(),
  });
  const tenant = create<Tenant>('tenants', {
    id: '', name: 'Skyline Constructions', company: 'Skyline Constructions Pvt Ltd', logo: '',
    brandVoice: 'Warm, trustworthy, premium.', audience: 'Home buyers', channels: ['WhatsApp', 'Email'],
    plan: 'Enterprise', status: 'active', approvalStatus: 'approved', slug: DEMO_WORKSPACE_CODE,
    country: 'India', currency: 'INR', rera: 'A51900001234', gst: '27ABCDE1234F1Z5',
    email: 'admin@skyline.test', phone: '+91 20 4000 0000', address: 'Baner, Pune 411045', createdAt: now(),
  });
  const T = tenant.id;

  const mkUser = (role: Role, name: string, email: string, tid: string) => create<User>('users', {
    id: '', tenantId: tid, name, email, password: DEMO_PASSWORD, role,
    avatar: '', phone: '', active: true, createdAt: now(),
  });
  mkUser('super_admin', 'Platform Operator', 'operator@skyline.test', platform.id);
  const admin = mkUser('builder_admin', 'Asha Mehta', 'builderadmin@skyline.test', T);
  const salesMgr = mkUser('sales_manager', 'Ravi Kulkarni', 'salesmanager@skyline.test', T);
  const salesExec = mkUser('sales_executive', 'Priya Nair', 'salesexecutive@skyline.test', T);
  mkUser('telecaller', 'Sana Shaikh', 'telecaller@skyline.test', T);
  mkUser('accountant', 'Deepak Rao', 'accountant@skyline.test', T);
  mkUser('auditor', 'Meera Iyer', 'auditor@skyline.test', T);
  const siteEng = mkUser('site_engineer', 'Vikram Singh', 'siteengineer@skyline.test', T);
  mkUser('land_manager', 'Rohan Desai', 'landmanager@skyline.test', T);
  mkUser('bd_manager', 'Neha Kapoor', 'bdmanager@skyline.test', T);
  const actor = { id: admin.id, name: admin.name };

  // ── Brokers ────────────────────────────────────────────────────────────────
  const broker = create<Broker>('brokers', {
    id: '', tenantId: T, name: 'Sunil Agarwal', firm: 'Prime Realty Associates', phone: '+91 98200 11111',
    email: 'sunil@primerealty.in', reraId: 'A51900005678', commissionRate: 2, leadsReferred: 6,
    bookingsClosed: 2, status: 'active', createdAt: now(),
  });
  create<Broker>('brokers', {
    id: '', tenantId: T, name: 'Kavita Joshi', firm: 'Urban Nest Advisors', phone: '+91 98200 22222',
    email: 'kavita@urbannest.in', reraId: 'A51900009012', commissionRate: 1.5, leadsReferred: 3,
    bookingsClosed: 1, status: 'active', createdAt: now(),
  });

  // ── Projects, towers, units ──────────────────────────────────────────────────
  const proj1 = create<Project>('projects', {
    id: '', tenantId: T, name: 'Emerald Heights', location: 'Baner, Pune', type: 'Residential',
    status: 'under_construction', reraNumber: 'P52100012345', totalUnits: 24, availableUnits: 18,
    priceRange: [7500000, 14500000], launchDate: rel(-180), completionDate: rel(420),
    description: 'Premium 2 & 3 BHK residences in Baner with clubhouse and rooftop deck.',
    amenities: ['Clubhouse', 'Gym', 'Rooftop Deck', 'Kids Play Area'], micrositePublished: true, createdAt: rel(-200),
  });
  create<Project>('projects', {
    id: '', tenantId: T, name: 'Marina Bay Residences', location: 'Kharadi, Pune', type: 'Residential',
    status: 'pre_launch', reraNumber: '', totalUnits: 40, availableUnits: 40,
    priceRange: [9000000, 21000000], launchDate: rel(45), completionDate: rel(760),
    description: 'Waterfront luxury towers launching next quarter.', amenities: ['Infinity Pool', 'Concierge'],
    createdAt: rel(-30),
  });

  const units: Unit[] = [];
  const mkUnitsFor = (project: Project, towerName: string, floors: number, priceBase: number, bookedFloors: number[]) => {
    const tower = create<Tower>('towers', { id: '', projectId: project.id, tenantId: T, name: towerName, floors, unitsPerFloor: 2 });
    for (let f = 1; f <= floors; f++) {
      for (let n = 1; n <= 2; n++) {
        const config = n === 1 ? '2 BHK' : '3 BHK';
        const area = n === 1 ? 1050 : 1420;
        const status: Unit['status'] = bookedFloors.includes(f) && n === 1 ? 'booked' : (f <= 2 ? 'available' : 'available');
        units.push(create<Unit>('units', {
          id: '', towerId: tower.id, tenantId: T, floorNumber: f, number: `${towerName}-${f}0${n}`,
          type: 'Apartment', configuration: config, area, price: priceBase + f * 200000 + (n === 2 ? 3500000 : 0),
          status,
        }));
      }
    }
    return tower;
  };
  mkUnitsFor(proj1, 'A', 6, 7500000, [4, 5]);
  mkUnitsFor(proj1, 'B', 6, 7800000, [3]);

  // ── Leads across the pipeline ────────────────────────────────────────────────
  const leadSeeds: Array<Partial<Lead> & { name: string; stage: Lead['stage'] }> = [
    { name: 'Rohan Verma', stage: 'booked', budget: 11000000, source: 'Website', priority: 'hot', brokerId: broker.id, configuration: '2 BHK' },
    { name: 'Anita Deshpande', stage: 'booked', budget: 13500000, source: 'Referral', priority: 'hot', configuration: '3 BHK' },
    { name: 'Karan Malhotra', stage: 'negotiation', budget: 12000000, source: 'Walk-in', priority: 'hot', configuration: '3 BHK' },
    { name: 'Sneha Pillai', stage: 'visit_scheduled', budget: 9500000, source: '99acres', priority: 'warm', configuration: '2 BHK' },
    { name: 'Amit Shah', stage: 'qualified', budget: 10500000, source: 'MagicBricks', priority: 'warm', brokerId: broker.id, configuration: '2 BHK' },
    { name: 'Divya Reddy', stage: 'contacted', budget: 8800000, source: 'Instagram', priority: 'warm', configuration: '2 BHK' },
    { name: 'Manish Gupta', stage: 'new', budget: 15000000, source: 'Website', priority: 'hot', configuration: '3 BHK' },
    { name: 'Pooja Kulkarni', stage: 'new', budget: 9200000, source: 'Referral', priority: 'cold', configuration: '2 BHK' },
    { name: 'Sameer Khan', stage: 'lost', budget: 8000000, source: 'Google Ads', priority: 'cold', lostReason: 'Price', configuration: '2 BHK' },
    { name: 'Ritu Agarwal', stage: 'contacted', budget: 17500000, source: 'Walk-in', priority: 'warm', configuration: '3 BHK' },
  ];
  const leads = leadSeeds.map((s, i) => create<Lead>('leads', {
    id: '', tenantId: T, projectId: proj1.id, name: s.name,
    email: `${s.name.split(' ')[0].toLowerCase()}@example.in`, phone: `+91 90000 1${String(1000 + i).slice(-4)}`,
    source: s.source || 'Website', project: proj1.name, budget: s.budget || 9000000,
    configuration: s.configuration || '2 BHK', stage: s.stage, priority: s.priority || 'warm',
    assignedTo: i % 2 === 0 ? salesExec.id : salesMgr.id, brokerId: s.brokerId, lostReason: s.lostReason,
    lastContact: rel(-(i % 7)), createdAt: rel(-(30 - i)),
  }));

  // Activities + tasks (dashboard feed + urgent tasks)
  const actTypes: Activity['type'][] = ['call', 'whatsapp', 'visit', 'note', 'status_change'];
  leads.slice(0, 6).forEach((l, i) => create<Activity>('activities', {
    id: '', tenantId: T, leadId: l.id, userId: l.assignedTo, type: actTypes[i % actTypes.length],
    description: `Followed up with ${l.name}`, createdAt: rel(-(i * 0.3)),
  }));
  ['Call Karan re: final pricing', 'Send Sneha the cost sheet', 'Site visit — Amit Shah', 'Collect token from Rohan'].forEach((title, i) =>
    create<Task>('tasks', {
      id: '', tenantId: T, userId: i % 2 === 0 ? salesExec.id : salesMgr.id, title,
      description: '', dueDate: rel(i - 1), priority: i < 2 ? 'hot' : 'warm',
      status: 'pending', category: i === 2 ? 'visit' : 'follow_up',
    })
  );

  // ── Bookings → schedules → invoices → commissions ────────────────────────────
  const bookableUnits = units.filter(u => u.status === 'booked');
  const bookedLeads = leads.filter(l => l.stage === 'booked');
  bookedLeads.forEach((lead, i) => {
    const unit = bookableUnits[i];
    if (!unit) return;
    const booking = create<Booking>('bookings', {
      id: '', tenantId: T, projectId: proj1.id, leadId: lead.id, unitId: unit.id,
      amount: 300000, paymentPlan: '30-70', stage: i === 0 ? 'payment' : 'agreement', createdAt: rel(-(20 - i * 5)),
    });
    generatePaymentSchedule({ tenantId: T, bookingId: booking.id, leadId: lead.id, planLabel: '30-70', totalValue: unit.price, bookingDate: booking.createdAt, actor });
    // token invoice (paid) + first installment (pending)
    create<Invoice>('invoices', {
      id: '', tenantId: T, leadId: lead.id, leadName: lead.name, project: proj1.name, type: 'Booking Token',
      amount: 300000, date: rel(-(18 - i * 5)), dueDate: rel(-(11 - i * 5)), status: 'Paid',
    });
    create<Invoice>('invoices', {
      id: '', tenantId: T, leadId: lead.id, leadName: lead.name, project: proj1.name, type: '1st Installment',
      amount: Math.round(unit.price * 0.1), date: rel(-(10 - i * 5)), dueDate: rel(i === 0 ? -3 : 12), status: i === 0 ? 'Overdue' : 'Pending',
    });
    if (lead.brokerId) {
      create<Commission>('commissions', {
        id: '', tenantId: T, brokerId: lead.brokerId, brokerName: broker.name, leadName: lead.name,
        project: proj1.name, bookingValue: unit.price, rate: 2, amount: Math.round(unit.price * 0.02),
        status: 'pending', createdAt: booking.createdAt,
      });
    }
  });

  // ── Land Acquisition parcels ─────────────────────────────────────────────────
  const mkParcel = (o: Partial<LandLead> & { surveyNumber: string; status: LandLead['status'] }) => create<LandLead>('landLeads', {
    id: '', tenantId: T, referenceSource: 'broker', ownerName: o.ownerName || 'Owner', ownerContact: '+91 98111 00000',
    location: o.location || '', city: o.city || 'Pune', state: 'Maharashtra', pincode: '411045',
    surveyNumber: o.surveyNumber, areaAcres: o.areaAcres ?? 2, askingPrice: o.askingPrice ?? 100000000,
    status: o.status, assignedTo: admin.id, ownershipType: o.ownershipType || 'freehold', zoning: 'Residential R1',
    fsiPermissible: o.fsiPermissible ?? 1.1, fsiConsumed: o.fsiConsumed ?? 0, roadWidthFt: o.roadWidthFt ?? 40,
    isEncumbered: o.isEncumbered ?? false, litigationStatus: o.litigationStatus || 'none', latestScore: o.latestScore,
    projectId: o.projectId, createdBy: admin.id, createdAt: rel(-(o.status === 'converted_to_project' ? 210 : 20)),
  });
  const p1 = mkParcel({ surveyNumber: '127/2B', ownerName: 'Ramesh Patil', city: 'Pune', areaAcres: 2.5, askingPrice: 120000000, status: 'converted_to_project', latestScore: 88, projectId: proj1.id });
  const pQual = mkParcel({ surveyNumber: '204/1', ownerName: 'Lata Sawant', city: 'Pune', areaAcres: 3.1, askingPrice: 150000000, status: 'qualified', latestScore: 74, roadWidthFt: 50 });
  const pFeas = mkParcel({ surveyNumber: '88/3A', ownerName: 'Girish Rao', city: 'Nashik', areaAcres: 1.8, askingPrice: 70000000, status: 'feasibility_working', latestScore: 61 });
  mkParcel({ surveyNumber: '55/2', ownerName: 'Disputed Estate', city: 'Mumbai', areaAcres: 1.2, askingPrice: 90000000, status: 'feasibility_working', latestScore: 20, litigationStatus: 'pending', roadWidthFt: 22 });
  [p1, pQual, pFeas].forEach(p => create<FeasibilityRecord>('feasibilityRecords', {
    id: '', tenantId: T, landLeadId: p.id, costPerSqft: 9500, saleableArea: Math.round(p.areaAcres * 30000),
    estimatedRevenue: Math.round(p.areaAcres * 30000 * 9500), marginPercent: 28, score: p.latestScore || 60,
    cappedByRisk: false, computedBy: admin.id, computedAt: rel(-5),
  }));
  create<LandDocument>('landDocuments', { id: '', tenantId: T, landLeadId: pQual.id, docType: 'title_deed', version: 1, fileName: 'title-deed-204-1.pdf', verificationStatus: 'verified', verifiedBy: admin.id, verifiedAt: rel(-3), uploadedBy: admin.id, createdAt: rel(-6) });
  create<LandDocument>('landDocuments', { id: '', tenantId: T, landLeadId: pQual.id, docType: '7_12_extract', version: 1, fileName: '7-12-204-1.pdf', verificationStatus: 'pending', uploadedBy: admin.id, createdAt: rel(-4) });

  // ── Business Development deals + market reports ──────────────────────────────
  create<BdLead>('bdLeads', { id: '', tenantId: T, opportunityType: 'jv', source: 'direct_approach', counterpartyName: 'Sunrise CHS', counterpartyContact: '+91 98111 22222', city: 'Mumbai', stage: 'terms_negotiation', estimatedDealValue: 250000000, ownedBy: admin.id, jvStructure: 'revenue_share', revenueSharePercent: 40, jvNotes: 'Society redevelopment, 40:60 revenue split', createdBy: admin.id, createdAt: rel(-25) });
  create<BdLead>('bdLeads', { id: '', tenantId: T, opportunityType: 'land_acquisition', source: 'broker', counterpartyName: 'Green Acres Owner', counterpartyContact: '', city: 'Pune', stage: 'initial_discussion', estimatedDealValue: 90000000, ownedBy: admin.id, createdBy: admin.id, createdAt: rel(-12) });
  create<BdLead>('bdLeads', { id: '', tenantId: T, opportunityType: 'land_acquisition', source: 'referral', counterpartyName: 'Hillview Trust', counterpartyContact: '', city: 'Lonavala', stage: 'identified', estimatedDealValue: 60000000, ownedBy: admin.id, createdBy: admin.id, createdAt: rel(-6) });
  create<MarketReport>('marketReports', { id: '', tenantId: T, areaName: 'Baner, Pune', reportType: 'pricing_benchmark', findings: 'Avg ₹9,200/sqft, up 6% YoY. Three competitor launches this quarter.', dataSources: '99acres, on-ground survey', createdBy: admin.id, createdAt: rel(-8) });

  // ── Procurement: vendors, materials, stock, POs, machines ────────────────────
  const v1 = create<Vendor>('vendors', { id: '', tenantId: T, name: 'Shree Cement Distributors', category: 'Cement & RMC', contactPerson: 'Ramesh Kumar', phone: '+91 98700 12345', email: 'sales@shreecement.in', gst: '27AABCS1234M1Z2', rating: 4, status: 'active', createdAt: rel(-90) });
  const v2 = create<Vendor>('vendors', { id: '', tenantId: T, name: 'BuildRight Contractors', category: 'Labour Contractor', phone: '+91 90000 55555', rating: 4, status: 'active', createdAt: rel(-80) });
  create<Vendor>('vendors', { id: '', tenantId: T, name: 'SteelLine Traders', category: 'Steel', phone: '+91 98111 33333', rating: 3, status: 'active', createdAt: rel(-70) });
  const cement = create<Material>('materials', { id: '', tenantId: T, name: 'OPC 53 Grade Cement', category: 'Cement & RMC', unit: 'bag', reorderLevel: 200, createdAt: rel(-90) });
  const steel = create<Material>('materials', { id: '', tenantId: T, name: 'TMT Steel 12mm', category: 'Steel', unit: 'MT', reorderLevel: 5, createdAt: rel(-90) });
  create<Material>('materials', { id: '', tenantId: T, name: 'River Sand', category: 'Aggregates & Sand', unit: 'cum', reorderLevel: 50, createdAt: rel(-90) });
  const lowMat = create<Material>('materials', { id: '', tenantId: T, name: 'Wall Putty', category: 'Paint & Finishes', unit: 'bag', reorderLevel: 100, createdAt: rel(-60) });
  create<StockTransaction>('stockTxns', { id: '', tenantId: T, materialId: cement.id, projectId: proj1.id, type: 'inward', qty: 500, rate: 380, vendorId: v1.id, reference: 'GRN-001', createdBy: siteEng.id, date: relDate(-15), createdAt: rel(-15) });
  create<StockTransaction>('stockTxns', { id: '', tenantId: T, materialId: cement.id, projectId: proj1.id, type: 'outward', qty: 180, reference: 'Slab 4', createdBy: siteEng.id, date: relDate(-5), createdAt: rel(-5) });
  create<StockTransaction>('stockTxns', { id: '', tenantId: T, materialId: steel.id, projectId: proj1.id, type: 'inward', qty: 12, rate: 62000, vendorId: v1.id, reference: 'GRN-002', createdBy: siteEng.id, date: relDate(-12), createdAt: rel(-12) });
  create<StockTransaction>('stockTxns', { id: '', tenantId: T, materialId: lowMat.id, projectId: proj1.id, type: 'inward', qty: 60, rate: 450, reference: 'GRN-003', createdBy: siteEng.id, date: relDate(-20), createdAt: rel(-20) });
  create<PurchaseOrder>('purchaseOrders', { id: '', tenantId: T, number: 1, vendorId: v1.id, projectId: proj1.id, status: 'partially_received', lines: [{ id: cryptoId(), materialId: cement.id, description: 'OPC 53 Cement', unit: 'bag', qty: 300, rate: 380, receivedQty: 150 }], expectedDate: relDate(5), createdBy: siteEng.id, approvedBy: admin.id, approvedAt: rel(-8), createdAt: rel(-10) });
  create<PurchaseOrder>('purchaseOrders', { id: '', tenantId: T, number: 2, vendorId: v1.id, projectId: proj1.id, status: 'pending_approval', lines: [{ id: cryptoId(), materialId: steel.id, description: 'TMT Steel 12mm', unit: 'MT', qty: 10, rate: 62000, receivedQty: 0 }], expectedDate: relDate(10), createdBy: siteEng.id, createdAt: rel(-2) });
  create<Machine>('machines', { id: '', tenantId: T, name: 'JCB 3DX #1', category: 'Backhoe Loader', registrationNo: 'MH-12-AB-1234', ownership: 'owned', projectId: proj1.id, status: 'on_site', nextServiceDate: relDate(4), createdAt: rel(-120) });
  create<Machine>('machines', { id: '', tenantId: T, name: 'Tower Crane TC-1', category: 'Tower Crane', ownership: 'rented', projectId: proj1.id, status: 'on_site', nextServiceDate: relDate(40), createdAt: rel(-100) });

  // ── Vendor bills + project budgets ───────────────────────────────────────────
  create<VendorBill>('vendorBills', { id: '', tenantId: T, vendorId: v1.id, projectId: proj1.id, billNumber: 'SCD/2026/091', category: 'Materials', amount: 250000, billDate: relDate(-9), dueDate: relDate(-2), status: 'approved', createdAt: rel(-9) });
  create<VendorBill>('vendorBills', { id: '', tenantId: T, vendorId: v2.id, projectId: proj1.id, billNumber: 'BR/2026/044', category: 'Labour', amount: 480000, billDate: relDate(-20), dueDate: relDate(-13), status: 'paid', paidAt: rel(-11), createdAt: rel(-20) });
  ['Civil & Structure', 'Materials', 'Labour', 'Finishes'].forEach((cat, i) =>
    create<ProjectBudget>('projectBudgets', { id: '', tenantId: T, projectId: proj1.id, category: cat, budgeted: [50000000, 30000000, 20000000, 15000000][i], createdAt: rel(-180) })
  );

  // ── HR: employees, attendance, leave, payroll ────────────────────────────────
  const emps = [
    create<Employee>('employees', { id: '', tenantId: T, name: 'Suresh Patil', phone: '+91 90000 90001', designation: 'Site Supervisor', department: 'Engineering', type: 'staff', projectId: proj1.id, monthlySalary: 45000, joinDate: relDate(-400), active: true, createdAt: rel(-400) }),
    create<Employee>('employees', { id: '', tenantId: T, name: 'Meena Iyer', phone: '+91 90000 90002', designation: 'Accountant', department: 'Accounts', type: 'staff', monthlySalary: 55000, joinDate: relDate(-500), active: true, createdAt: rel(-500) }),
    create<Employee>('employees', { id: '', tenantId: T, name: 'Ramu Yadav', phone: '+91 90000 90003', designation: 'Mason', department: 'Labour', type: 'contract_worker', projectId: proj1.id, dailyWage: 800, joinDate: relDate(-120), active: true, createdAt: rel(-120) }),
    create<Employee>('employees', { id: '', tenantId: T, name: 'Lakshmi Bai', phone: '+91 90000 90004', designation: 'Helper', department: 'Labour', type: 'contract_worker', projectId: proj1.id, dailyWage: 600, joinDate: relDate(-100), active: true, createdAt: rel(-100) }),
    create<Employee>('employees', { id: '', tenantId: T, name: 'Farhan Ali', phone: '+91 90000 90005', designation: 'Sales Coordinator', department: 'Sales', type: 'staff', monthlySalary: 38000, joinDate: relDate(-250), active: true, createdAt: rel(-250) }),
  ];
  emps.slice(0, 3).forEach(e => create<AttendanceRecord>('attendance', { id: '', tenantId: T, employeeId: e.id, date: todayKey(), checkIn: rel(0), projectId: e.projectId, method: e.projectId ? 'geo' : 'manual', lat: e.projectId ? 18.559 : undefined, lng: e.projectId ? 73.78 : undefined, createdAt: now() }));
  create<LeaveRequest>('leaveRequests', { id: '', tenantId: T, employeeId: emps[0].id, type: 'sick', from: relDate(3), to: relDate(4), days: 2, reason: 'Fever', status: 'pending', createdAt: rel(-1) });
  create<PayrollRun>('payrollRuns', {
    id: '', tenantId: T, month: monthKey(-1), status: 'processed',
    items: emps.filter(e => e.type === 'staff').map(e => ({ employeeId: e.id, name: e.name, designation: e.designation, empType: 'staff' as const, basis: 'Monthly salary', gross: e.monthlySalary || 0 })),
    processedBy: admin.id, processedAt: rel(-2), createdAt: rel(-3),
  });

  // ── Compliance filings ───────────────────────────────────────────────────────
  create<ComplianceItem>('complianceItems', { id: '', tenantId: T, title: 'GSTR-3B', authority: 'GST', dueDate: relDate(-3), frequency: 'monthly', amount: 320000, status: 'pending', createdAt: rel(-20) });
  create<ComplianceItem>('complianceItems', { id: '', tenantId: T, title: 'RERA Quarterly Update', authority: 'RERA', dueDate: relDate(10), frequency: 'quarterly', projectId: proj1.id, status: 'pending', createdAt: rel(-15) });
  create<ComplianceItem>('complianceItems', { id: '', tenantId: T, title: 'TDS Payment', authority: 'Income Tax / TDS', dueDate: relDate(-30), frequency: 'monthly', amount: 85000, status: 'filed', filedAt: rel(-28), filedBy: admin.id, createdAt: rel(-40) });

  // ── Site Execution: milestones, RFI, inspection ──────────────────────────────
  const m1 = create<SiteTask>('siteTasks', { id: '', tenantId: T, projectId: proj1.id, title: 'Foundation complete — Tower A', isMilestone: true, dueDate: relDate(-20), completedAt: rel(-22), status: 'done', progress: 100, assignedTo: siteEng.id, dependsOn: [], createdAt: rel(-120) });
  create<SiteTask>('siteTasks', { id: '', tenantId: T, projectId: proj1.id, title: 'Plinth beam casting', isMilestone: true, dueDate: relDate(-2), status: 'in_progress', progress: 60, assignedTo: siteEng.id, dependsOn: [m1.id], createdAt: rel(-40) });
  create<SiteTask>('siteTasks', { id: '', tenantId: T, projectId: proj1.id, title: 'Slab casting — 4th floor', isMilestone: false, dueDate: relDate(8), status: 'not_started', progress: 0, assignedTo: siteEng.id, dependsOn: [], createdAt: rel(-10) });
  create<Rfi>('rfis', { id: '', tenantId: T, projectId: proj1.id, number: 1, subject: 'Rebar spacing S-204 vs S-208', question: 'Column C-14 shows 150mm on S-204 but 200mm on S-208 — which governs?', raisedBy: siteEng.id, assignedTo: admin.id, status: 'open', dueDate: relDate(3), createdAt: rel(-3) });
  create<Inspection>('inspections', {
    id: '', tenantId: T, projectId: proj1.id, type: 'safety', title: 'Weekly Site Safety Walk', date: relDate(-1), inspectorId: siteEng.id, status: 'failed',
    items: [
      { id: cryptoId(), label: 'PPE worn by all workers', result: 'pass' },
      { id: cryptoId(), label: 'Scaffolding tagged and inspected', result: 'fail', remark: 'Two tags missing on east face' },
      { id: cryptoId(), label: 'Edge protection in place', result: 'pass' },
    ], createdAt: rel(-1),
  });

  // ── Quotations ───────────────────────────────────────────────────────────────
  const negLead = leads.find(l => l.stage === 'negotiation')!;
  const availUnit = units.find(u => u.status === 'available' && u.configuration === '3 BHK')!;
  create<Quotation>('quotations', { id: '', tenantId: T, leadId: negLead.id, unitId: availUnit.id, baseAmount: availUnit.price, charges: [{ label: 'Covered parking', amount: 350000 }], discountAmount: 150000, totalAmount: availUnit.price + 350000 - 150000, validUntil: relDate(12), status: 'pending_approval', createdBy: salesExec.id, createdAt: rel(-2) });

  // ── Accounts: ledger, bank, loan ─────────────────────────────────────────────
  ensureCoa(T);
  const cash = accountByCode(T, COA.CASH)!;
  const equity = accountByCode(T, COA.EQUITY)!;
  const sales = accountByCode(T, COA.SALES)!;
  const ap = accountByCode(T, COA.AP)!;
  const matExp = expenseAccountFor(T, 'Materials');
  postEntry({ tenantId: T, narration: 'Opening capital injection', lines: [{ accountId: cash.id, debit: 50000000 }, { accountId: equity.id, credit: 50000000 }], sourceType: 'manual', date: relDate(-200), actor });
  postEntry({ tenantId: T, narration: 'Collection — booking token from Rohan Verma', lines: [{ accountId: cash.id, debit: 300000 }, { accountId: sales.id, credit: 300000 }], sourceType: 'customer_payment', projectId: proj1.id, date: relDate(-18), actor });
  if (matExp) postEntry({ tenantId: T, narration: 'Vendor bill BR/2026/044 approved (Labour)', lines: [{ accountId: matExp.id, debit: 480000 }, { accountId: ap.id, credit: 480000 }], sourceType: 'vendor_bill', projectId: proj1.id, date: relDate(-20), actor });
  create<BankAccount>('bankAccounts', { id: '', tenantId: T, name: 'HDFC Current A/c', bankName: 'HDFC Bank', accountNumber: '…4821', openingBalance: 5000000, createdAt: rel(-200) });
  const loan = create<Loan>('loans', {
    id: '', tenantId: T, projectId: proj1.id, lenderName: 'HDFC Bank', loanType: 'term_loan',
    principal: 30000000, interestRatePct: 11.5, tenureMonths: 36, tdsPct: 10, startDate: relDate(-60),
    schedule: buildLoanSchedule(30000000, 11.5, 36, 10, relDate(-60)), status: 'active', createdAt: rel(-60),
  });
  postLoanDisbursed(loan, actor);

  return { builderAdmin: admin, tenant };
}

function cryptoId(): string {
  return (crypto as Crypto).randomUUID();
}
