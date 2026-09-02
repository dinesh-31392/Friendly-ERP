import { useState, useMemo, useEffect } from 'react';
import {
  Globe, Building2, Users, IndianRupee, Activity, Plus, X,
  ScrollText, Settings2, LifeBuoy, CheckCircle2, Power,
  KeyRound, Copy, LogIn, Search, RefreshCw, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getAll, create, update, remove, removeByTenant, logAudit, getByTenant } from '../services/db';
import { apiGetTenants, apiCreateTenant, apiUpdateTenant, apiGetAuditLogs, isApiEnabled, apiGetTenantUsage, apiImpersonateTenant, apiGetBranches, apiCreateBranch, type TenantUsage } from '../services/apiClient';
import { PLANS, platformMrrUsd, tenantMrrUsd, CONTROLLABLE_MODULES } from '../services/planService';
import { getBranches, getLegacyBranch, branchName, visibleTenantsForUser } from '../services/branchService';
import { uniqueSlug } from '../services/portalService';
import { setTemporaryPassword, generateToken } from '../services/authService';
import type { TenantOverrides, Branch } from '../types';
import type { Tenant, User as UserType, Lead, AuditLog } from '../types';
import { todayISO } from '../utils/format';
import toast from 'react-hot-toast';
import { BRAND, portalHost } from '../config/brand';

const tabs = [
  { id: 'overview', label: 'Platform Overview', icon: Activity },
  { id: 'builders', label: 'Builder Management', icon: Building2 },
  { id: 'billing', label: 'Subscriptions', icon: IndianRupee },
  { id: 'settings', label: 'Global Settings', icon: Settings2 },
  { id: 'audit', label: 'Audit Logs', icon: ScrollText },
  { id: 'support', label: 'Support', icon: LifeBuoy },
];


export default function SuperAdmin() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const isTech = user?.role === 'tech_team';
  const [activeTab, setActiveTab] = useState('overview');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);
  const [showAddBuilder, setShowAddBuilder] = useState(false);
  /** Holds the one-time password after provisioning, until it is dismissed. */
  const [newWorkspace, setNewWorkspace] = useState<{ company: string; email: string; tempPassword: string } | null>(null);
  const [manageTenant, setManageTenant] = useState<Tenant | null>(null);
  const [showAddBranch, setShowAddBranch] = useState(false);
  const [impersonateUserId, setImpersonateUserId] = useState('');
  // Credentials & Access tab
  const [credSearch, setCredSearch] = useState('');
  const [credRole, setCredRole] = useState<string>('all');
  const [pwUser, setPwUser] = useState<UserType | null>(null);
  const [pwValue, setPwValue] = useState('');

  // The platform console runs on the server: tenants and the audit trail are
  // cross-tenant, which is exactly what localStorage could never represent —
  // this page showed only what the current browser happened to have done.
  const [allTenants, setAllTenants] = useState<Tenant[]>([]);
  const [allAuditRows, setAllAuditRows] = useState<AuditLog[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiGetTenants()
      .then(rows => { if (!cancelled) setAllTenants(rows); })
      .catch(err => toast.error(err instanceof Error ? err.message : 'Could not load workspaces'));
    // A tech_team account may not hold view_audit_log; an empty panel is the
    // right outcome there, not an error.
    apiGetAuditLogs(300)
      .then(rows => { if (!cancelled) setAllAuditRows(rows); })
      .catch(() => { if (!cancelled) setAllAuditRows([]); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  // Is the console reading a real backend? Decides whether cross-tenant figures
  // come from the server or from the browser's demo store.
  const apiMode = isApiEnabled();
  /**
   * Usage for the workspace whose Manage panel is open.
   *
   * Fetched, not computed: counting another tenant's rows in the browser is
   * impossible under row-level security, which is why this panel reported an
   * empty workspace for every busy one. Null until it arrives (or in demo mode),
   * and the panel falls back to the local store then.
   */
  const [serverUsage, setServerUsage] = useState<TenantUsage | null>(null);
  useEffect(() => {
    if (!apiMode || !manageTenant) { setServerUsage(null); return; }
    let cancelled = false;
    setServerUsage(null);
    apiGetTenantUsage(manageTenant.id)
      .then(u => { if (!cancelled) setServerUsage(u); })
      .catch(() => { if (!cancelled) setServerUsage(null); });
    return () => { cancelled = true; };
  }, [apiMode, manageTenant, refreshKey]);
  const allUsers = useMemo(() => getAll<UserType>('users'), [refreshKey]);
  const allLeads = useMemo(() => getAll<Lead>('leads'), [refreshKey]);
  /**
   * Branches live on the PLATFORM pool, not a tenant's schema, and they were
   * read and written through the localStorage store while tenant assignment
   * already went to the server via apiUpdateTenant. So a branch created here
   * existed in one administrator's browser, and the workspace assigned to it
   * carried a branchId the server had never seen.
   */
  const [apiBranches, setApiBranches] = useState<Branch[] | null>(null);
  useEffect(() => {
    if (!isApiEnabled()) { setApiBranches(null); return; }
    let cancelled = false;
    apiGetBranches()
      .then(rows => {
        if (cancelled) return;
        setApiBranches(rows.map(b => ({
          id: b.id, name: b.name, managerId: b.managerId ?? undefined, createdAt: b.createdAt,
        }) as Branch));
      })
      // Platform staff only: a non-platform admin gets a 403 here and simply
      // has no branch list, which is correct rather than an error to show.
      .catch(() => { if (!cancelled) setApiBranches([]); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  const branches = useMemo(() => apiBranches ?? getBranches(), [apiBranches, refreshKey]);
  // The Gatekeeper: tech_team only ever sees its own branch's builders
  const tenants = useMemo(() => visibleTenantsForUser(user, allTenants), [user, allTenants]);
  const pendingTenants = useMemo(() => tenants.filter(t => t.approvalStatus === 'pending'), [tenants]);
  const visibleTenantIds = useMemo(() => new Set(tenants.map(t => t.id)), [tenants]);
  // Audit: super admin sees everything (incl. platform-scoped entries);
  // tech_team sees only their own branch's builders — never platform-wide
  // governance actions or other branches.
  const allAudit = useMemo(
    () => allAuditRows
      .filter(a => isSuperAdmin || visibleTenantIds.has(a.tenantId))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [allAuditRows, isSuperAdmin, visibleTenantIds]
  );

  // Active users across visible tenants, excluding platform staff accounts.
  // In API mode the local store holds no other tenant's users (RLS), so the
  // only real figure is the server's per-tenant count — which counts every
  // provisioned user, hence the honest relabelling of the card below.
  const activeUsers = apiMode
    ? tenants.reduce((sum, t) => sum + (t.userCount ?? 0), 0)
    : allUsers.filter(u => u.active && u.role !== 'super_admin' && u.role !== 'tech_team' && visibleTenantIds.has(u.tenantId)).length;
  const mrrUsd = platformMrrUsd(tenants);
  const trialTenants = tenants.filter(t => t.status === 'trial').length;

  const platformAudit = (action: string, entityId: string, details: string) => {
    if (!user) return;
    logAudit({ tenantId: 'platform', userId: user.id, userName: user.name, action, entity: 'tenant', entityId, details });
  };

  const handleAddBuilder = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const company = fd.get('company') as string;
    const adminName = fd.get('adminName') as string;
    const adminEmail = fd.get('adminEmail') as string;
    const password = fd.get('password') as string;
    if (!company || !adminName || !adminEmail || !password) { toast.error('All fields are required'); return; }
    if (allUsers.some(u => u.email.toLowerCase() === adminEmail.toLowerCase())) {
      toast.error('Admin email already exists'); return;
    }
    // A branch is mandatory before persistence. Tech team is locked to its own
    // branch; super admin picks one.
    const branchId = isTech ? user?.branchId : (fd.get('branchId') as string);
    if (!branchId) { toast.error('Select a branch for this builder'); return; }

    // Tech-team onboarding lands in PENDING for super-admin approval; a super
    // admin onboarding directly is auto-approved and billable immediately.
    const approvalStatus = isSuperAdmin ? 'approved' as const : 'pending' as const;

    // ONE server call provisions the workspace, its nine roles with grants, the
    // lead pipeline and the administrator, in a single transaction. A
    // half-provisioned tenant signs in and then refuses every write, so this
    // either lands whole or not at all.
    //
    // uniqueSlug, not slugify: two builders with the same company name would
    // otherwise share a subdomain and hijack each other's portal/microsite. The
    // server also rejects a duplicate with a 409, so this is belt and braces.
    let created: Awaited<ReturnType<typeof apiCreateTenant>>;
    try {
      created = await apiCreateTenant({
        name: company, company, slug: uniqueSlug(company),
        email: adminEmail,
        adminName, adminEmail: adminEmail.toLowerCase(),
        plan: ((fd.get('plan') as string) || 'trial').toLowerCase(),
        country: 'India', currency: 'INR',
        phone: (fd.get('phone') as string) || undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the workspace');
      return;
    }

    // The branch is a platform grouping the provisioning route does not own.
    if (branchId) {
      await apiUpdateTenant(created.tenant.id, { branchId }).catch(() => {
        toast.error('Workspace created, but the branch could not be assigned');
      });
    }

    platformAudit('create', created.tenant.id,
      `Onboarded builder "${company}" in ${branchName(branchId)} branch`);
    setShowAddBuilder(false);
    refresh();
    // The temporary password is readable exactly once — it is stored as an
    // argon2id hash and cannot be recovered. Show it until dismissed rather
    // than in a toast that disappears while the operator is looking away.
    setNewWorkspace({ company, email: adminEmail.toLowerCase(), tempPassword: created.tempPassword });
    toast.success(approvalStatus === 'pending'
      ? `"${company}" submitted for approval — a super admin must activate it`
      : `Builder "${company}" onboarded — workspace ready`);
  };

  // ── Approval workflow (super admin only) ────────────────────────────────────
  const handleApproval = (t: Tenant, decision: 'approved' | 'rejected') => {
    if (!isSuperAdmin) { toast.error('Only a super admin can approve or reject builders'); return; }
    update<Tenant>('tenants', t.id, { approvalStatus: decision });
    platformAudit(decision === 'approved' ? 'approve' : 'reject', t.id, `${decision === 'approved' ? 'Approved' : 'Rejected'} builder "${t.name}" (${branchName(t.branchId)})`);
    refresh();
    toast.success(decision === 'approved' ? `"${t.name}" approved — they can now sign in` : `"${t.name}" rejected`);
  };

  const handleAddBranch = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string || '').trim();
    if (!name) { toast.error('Branch name is required'); return; }
    const managerId = (fd.get('managerId') as string) || undefined;
    let createdId: string;
    try {
      createdId = isApiEnabled()
        ? (await apiCreateBranch({ name, ...(managerId ? { managerId } : {}) })).id
        : create<Branch>('branches', { id: '', name, managerId, createdAt: new Date().toISOString() }).id;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create that branch');
      return;
    }
    platformAudit('create', createdId, `Created branch "${name}"`);
    setShowAddBranch(false);
    refresh();
    toast.success(`Branch "${name}" created`);
  };

  const handleToggleTenantUsers = async (t: Tenant, activate: boolean) => {
    const tenantUsers = getByTenant<UserType>('users', t.id);
    // Never let an admin suspend the workspace they are signed into. The old
    // guard looked for a super_admin row in the LOCAL store, which is empty in
    // API mode — so it never fired, and suspending your own workspace was one
    // click away. Own-tenant is the check that holds in both modes.
    if (!activate && (t.id === user?.tenantId || tenantUsers.some(u => u.role === 'super_admin'))) {
      toast.error(`"${t.name}" hosts the platform admin account and cannot be suspended`);
      return;
    }

    // API mode: this is a governance action on the SERVER. It previously wrote
    // only to localStorage, so the console showed "Builder suspended" while the
    // workspace kept running, and the next refresh — which loads tenants from
    // the API — silently reverted the row.
    if (apiMode) {
      try {
        await apiUpdateTenant(t.id, { status: activate ? 'active' : 'suspended' });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the workspace');
        return;
      }
    } else {
      tenantUsers.forEach(u => {
        if (u.role !== 'super_admin') update<UserType>('users', u.id, { active: activate });
      });
      update<Tenant>('tenants', t.id, { status: activate ? 'active' : 'suspended' });
    }

    platformAudit(activate ? 'activate' : 'deactivate', t.id, `${activate ? 'Activated' : 'Suspended'} builder "${t.name}" (${tenantUsers.length} users)`);
    refresh();
    toast.success(`Builder ${activate ? 'activated' : 'suspended'}`);
  };

  // ── Tenant command-center actions ──────────────────────────────────────────

  /** Deep usage stats for the Manage modal — the "tenant health" view. */
  const tenantUsage = (t: Tenant) => {
    const TABLES = ['users', 'projects', 'towers', 'units', 'leads', 'notes', 'activities',
      'tasks', 'bookings', 'invoices', 'tickets', 'campaigns', 'documents', 'conversations',
      'chatMessages', 'auditLogs', 'brokers', 'commissions', 'integrations', 'portalUsers', 'paymentPlans'] as const;
    let totalRows = 0, bytes = 0;
    const per: Record<string, number> = {};
    TABLES.forEach(table => {
      const rows = getAll<{ tenantId: string }>(table).filter(r => r.tenantId === t.id);
      per[table] = rows.length;
      totalRows += rows.length;
      bytes += JSON.stringify(rows).length;
    });
    const tenantLeads = allLeads.filter(l => l.tenantId === t.id);
    return {
      per, totalRows,
      storageKb: Math.round(bytes / 1024),
      users: allUsers.filter(u => u.tenantId === t.id && u.role !== 'super_admin'),
      leads: tenantLeads.length,
      booked: tenantLeads.filter(l => l.stage === 'booked').length,
      revenue: tenantLeads.filter(l => l.stage === 'booked').reduce((s, l) => s + l.budget, 0),
      lastActivity: getAll<AuditLog>('auditLogs').filter(a => a.tenantId === t.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.createdAt,
    };
  };

  const handleExtendTrial = (t: Tenant, days: number) => {
    const base = t.trialEndsAt && new Date(t.trialEndsAt).getTime() > Date.now()
      ? new Date(t.trialEndsAt).getTime() : Date.now();
    const next = new Date(base + days * 86400000).toISOString();
    update<Tenant>('tenants', t.id, { status: 'trial', trialEndsAt: next });
    platformAudit('update', t.id, `Extended trial for "${t.name}" by ${days} days (until ${next.slice(0, 10)})`);
    refresh();
    setManageTenant(prev => prev ? { ...prev, status: 'trial', trialEndsAt: next } : prev);
    toast.success(`Trial extended ${days} days`);
  };

  const handleExportTenant = (t: Tenant) => {
    if (!isSuperAdmin) { toast.error('Full data export is restricted to super admins'); return; }
    const TABLES = ['users', 'projects', 'towers', 'units', 'leads', 'notes', 'activities',
      'reminders', 'tasks', 'bookings', 'invoices', 'tickets', 'campaigns', 'documents',
      'conversations', 'chatMessages', 'auditLogs', 'templates', 'agreements', 'brokers',
      'commissions', 'integrations', 'portalUsers', 'paymentPlans'] as const;
    const data: Record<string, unknown> = { tenant: t, exportedAt: new Date().toISOString() };
    TABLES.forEach(table => {
      const rows = getAll<{ tenantId: string; password?: string }>(table).filter(r => r.tenantId === t.id);
      data[table] = table === 'users' || table === 'portalUsers'
        ? rows.map(r => ({ ...r, password: '***redacted***' }))
        : rows;
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `tenant-${t.slug || t.id}-${todayISO()}.json`; a.click();
    URL.revokeObjectURL(url);
    platformAudit('export', t.id, `Exported full data snapshot for "${t.name}"`);
    toast.success(`"${t.name}" data exported`);
  };

  /** Persist a partial override change for a tenant (custom control model). */
  const handleSaveOverrides = (t: Tenant, patch: Partial<TenantOverrides>) => {
    const overrides: TenantOverrides = { ...(t.overrides || {}), ...patch };
    // Drop empty/cleared values so unset always means "plan default"
    (Object.keys(overrides) as (keyof TenantOverrides)[]).forEach(k => {
      const v = overrides[k];
      if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v))) {
        delete overrides[k];
      }
    });
    update<Tenant>('tenants', t.id, { overrides });
    platformAudit('update', t.id, `Updated custom controls for "${t.name}": ${Object.keys(patch).join(', ')}`);
    refresh();
    setManageTenant(prev => prev && prev.id === t.id ? { ...prev, overrides } : prev);
  };

  /** Support access: log into a builder's workspace as a chosen user (any
   *  role), keeping a return path. Available to super admin and (scoped)
   *  branch tech team. Defaults to the builder admin when no user is chosen. */
  const handleImpersonate = async (t: Tenant, targetUserId?: string) => {
    if (!visibleTenantIds.has(t.id)) { toast.error('Out of your branch scope'); return; }
    // API mode: only the server can mint a session for somebody else's
    // workspace. The old path wrote a fake local session, which a real backend
    // ignores — the feature was dead in production.
    if (apiMode) {
      if ((t.approvalStatus ?? 'approved') !== 'approved' || t.status === 'suspended') {
        toast.error(`"${t.name}" is not active — activate it before opening the workspace`);
        return;
      }
      try {
        const { user: opened, expiresInMinutes } = await apiImpersonateTenant(t.id, targetUserId);
        toast.success(`Opening ${t.name} as ${opened.name} — ${expiresInMinutes} min support session`);
        setTimeout(() => { window.location.href = '/'; }, 700);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not open a support session');
      }
      return;
    }
    // A closed workspace rejects its own users on reload: getCurrentUser()
    // clears the session for pending/rejected/suspended tenants, which would
    // take the admin's backed-up session down with it and strand them at
    // /login with no way back. Self-serve signups now land 'pending', so this
    // is reachable straight from the approvals queue — approve first, then look.
    if ((t.approvalStatus ?? 'approved') !== 'approved' || t.status === 'suspended') {
      const why = t.status === 'suspended' ? 'suspended'
        : t.approvalStatus === 'rejected' ? 'rejected' : 'awaiting approval';
      toast.error(`"${t.name}" is ${why} — activate it before opening the workspace`);
      return;
    }
    const target = (targetUserId
      ? allUsers.find(u => u.id === targetUserId && u.tenantId === t.id && u.active && u.role !== 'super_admin' && u.role !== 'tech_team')
      : undefined)
      || allUsers.find(u => u.tenantId === t.id && u.active && u.role === 'builder_admin')
      || allUsers.find(u => u.tenantId === t.id && u.active && u.role !== 'super_admin' && u.role !== 'tech_team');
    if (!target) { toast.error(`No active workspace user to access for "${t.name}"`); return; }
    const current = localStorage.getItem('friendly_crm_auth');
    if (current) localStorage.setItem('friendly_crm_auth_admin_backup', current);
    localStorage.setItem('friendly_crm_auth', JSON.stringify({
      // Crypto-strong token, consistent with login/portal sessions — the old
      // Math.random() value was predictable and low-entropy.
      userId: target.id, tenantId: t.id,
      token: generateToken(), expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }));
    platformAudit('impersonate', t.id, `Accessed "${t.name}" workspace as ${target.name} (support mode)`);
    toast.success(`Opening ${t.name} as ${target.name}…`);
    setTimeout(() => window.location.reload(), 700);
  };

  const handleResetAdminPassword = (t: Tenant) => {
    if (!isSuperAdmin) { toast.error('Password resets are restricted to super admins'); return; }
    const admin = getByTenant<UserType>('users', t.id).find(u => u.role === 'builder_admin' && u.active);
    if (!admin) { toast.error('No active builder admin found for this workspace'); return; }
    if (!confirm(`Reset the password for ${admin.name} (${admin.email})?`)) return;
    const temp = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    update<UserType>('users', admin.id, { password: temp });
    platformAudit('update', t.id, `Reset builder admin password for ${admin.email}`);
    navigator.clipboard?.writeText(temp).catch(() => {});
    toast.success(`Temporary password for ${admin.email}: ${temp} (copied to clipboard)`, { duration: 12000 });
    refresh();
  };

  /* ── Credentials & Access ──────────────────────────────────────────────────
   * One directory of every account on the platform. Grant access to anyone —
   * "Login as" (no password) or "Issue temp password" — without ever seeing or
   * storing a standing, shareable password.
   *
   * The old "reveal / copy the stored password" affordance was removed: a
   * reversible-credential console is indefensible, and against the production
   * argon2id backend it was impossible anyway (hashes are one-way). The secure
   * pattern that works in BOTH stores is: issue a one-time temporary password,
   * which forces the user to set their own on next sign-in. Every action here is
   * written to the platform audit log.
   */
  const genPassword = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(10)))
      .map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

  const tenantOf = (u: UserType) => allTenants.find(t => t.id === u.tenantId);

  const credUsers = useMemo(() => {
    const q = credSearch.trim().toLowerCase();
    return allUsers
      .filter(u => credRole === 'all' || u.role === credRole)
      .filter(u => {
        if (!q) return true;
        const tName = allTenants.find(t => t.id === u.tenantId)?.name || '';
        return u.name.toLowerCase().includes(q)
          || u.email.toLowerCase().includes(q)
          || tName.toLowerCase().includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allUsers, allTenants, credSearch, credRole]);

  const openPwModal = (u: UserType) => { setPwUser(u); setPwValue(genPassword()); };

  const handleSavePassword = () => {
    if (!pwUser) return;
    if (!isSuperAdmin) { toast.error('Only a super admin can issue passwords'); return; }
    if (pwValue.length < 8) { toast.error('Temporary password must be at least 8 characters'); return; }
    // Issue a TEMPORARY password: the user must set their own on next login, so
    // this value is useful exactly once and no standing password is shared.
    setTemporaryPassword(pwUser.id, pwValue);
    // Copy only the temp password (not "email / password" standing creds).
    navigator.clipboard?.writeText(pwValue).catch(() => {});
    toast.success(`Temporary password set for ${pwUser.email} — copied. They must reset it on next login.`, { duration: 9000 });
    setPwUser(null);
    refresh();
  };

  const handleDeleteTenant = (t: Tenant) => {
    const tenantUsers = getByTenant<UserType>('users', t.id);
    if (tenantUsers.some(u => u.role === 'super_admin')) {
      toast.error(`"${t.name}" hosts the platform admin account and cannot be deleted`);
      return;
    }
    if (!confirm(`⚠️ PERMANENTLY delete "${t.company}" and ALL its data (users, leads, projects, bookings, invoices...)? This cannot be undone.`)) return;
    if (!confirm(`Final confirmation: type OK to erase workspace "${t.name}".`)) return;
    const tables = [
      'users', 'projects', 'towers', 'units', 'leads', 'notes', 'activities', 'reminders',
      'tasks', 'bookings', 'invoices', 'tickets', 'campaigns', 'documents', 'conversations',
      'chatMessages', 'auditLogs', 'templates', 'agreements', 'brokers', 'commissions',
      'integrations', 'portalUsers', 'paymentPlans',
    ] as const;
    let removed = 0;
    tables.forEach(table => { removed += removeByTenant(table, t.id); });
    remove('tenants', t.id);
    platformAudit('delete', t.id, `Deleted builder "${t.name}" and ${removed} related records`);
    refresh();
    toast.success(`Workspace "${t.name}" and all its data deleted`);
  };

  /**
   * Per-tenant figures for the console.
   *
   * These MUST come from the server in API mode. The browser store cannot hold
   * another tenant's users or leads — row-level security makes that impossible —
   * so deriving them locally returned zero for every workspace. Two consequences,
   * both live before this: the overview badged EVERY builder "Suspended" while
   * they were all active, and the Suspend/Activate button read the inverted
   * state, offering "Activate" on a running workspace.
   *
   * `status` on the tenant row is the authoritative state (the Builder
   * Management tab already rendered it correctly); `userCount` is the server's
   * own count. Cross-tenant lead totals have no endpoint, so in API mode that
   * figure is reported as unavailable rather than as a confident zero.
   */
  const tenantStats = (t: Tenant) => {
    const localUsers = allUsers.filter(u => u.tenantId === t.id);
    const localLeads = allLeads.filter(l => l.tenantId === t.id);
    return {
      users: t.userCount ?? localUsers.length,
      leads: apiMode ? null : localLeads.length,
      active: (t.status ?? 'active') !== 'suspended',
    };
  };

  // Role-aware tabs: tech_team gets a trimmed branch console; super admin
  // gets the approvals queue and branch management.
  const visibleTabs = isTech
    ? tabs.filter(t => ['overview', 'builders', 'billing', 'audit'].includes(t.id))
    : [
        tabs[0],
        { id: 'approvals', label: `Pending Approvals${pendingTenants.length ? ` (${pendingTenants.length})` : ''}`, icon: CheckCircle2 },
        ...tabs.slice(1, 2),
        // Credential command center — takeover-grade, super admin only
        { id: 'credentials', label: 'Credentials & Access', icon: KeyRound },
        ...tabs.slice(2, 4),
        { id: 'branches', label: 'Branches', icon: Globe },
        ...tabs.slice(4),
      ];

  return (
    <div className="flex gap-6 max-w-[1300px] flex-col lg:flex-row">
      {/* Sidebar */}
      <div className="w-full lg:w-60 shrink-0">
        <div className="bg-gradient-to-br from-zinc-900 to-zinc-800 rounded-2xl p-4 mb-4 text-white">
          <div className="flex items-center gap-2 mb-1">
            <Globe className="h-4 w-4 text-indigo-300" />
            <p className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Platform Control</p>
          </div>
          <p className="text-lg font-bold">{isTech ? 'Branch Console' : 'Super Admin'}</p>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            {isTech ? `${branchName(user?.branchId)} · builder onboarding` : 'Cross-tenant administration'}
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-2">
          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mb-0.5 ${
                activeTab === tab.id ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <tab.icon className="h-4 w-4" /> {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-5">
        {activeTab === 'overview' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Total Builders', value: tenants.length, icon: Building2, color: 'text-indigo-600' },
                // The server counts every provisioned user, not only the active
                // ones, so the label follows the number rather than overstating it.
                { label: apiMode ? 'Users' : 'Active Users', value: activeUsers, icon: Users, color: 'text-violet-600' },
                { label: 'MRR (USD)', value: `$${mrrUsd.toLocaleString()}`, icon: IndianRupee, color: 'text-emerald-600' },
                { label: 'Trials Running', value: trialTenants, icon: Activity, color: 'text-amber-600' },
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
            <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
              <h3 className="font-semibold text-zinc-900 mb-4">Tenant Activity</h3>
              <div className="space-y-3">
                {tenants.map(t => {
                  const st = tenantStats(t);
                  return (
                    <div key={t.id} className="flex items-center gap-4 p-3 rounded-xl hover:bg-zinc-50 border border-zinc-100">
                      <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-xs font-bold">
                        {t.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-zinc-900">{t.name}</p>
                        {/* the STORED slug — recomputing from the name here showed
                            a subdomain the tenant does not actually own */}
                        <p className="text-[11px] text-zinc-500">{portalHost(t.slug)} · {t.plan} plan</p>
                      </div>
                      <div className="text-right hidden sm:block">
                        <p className="text-sm font-semibold text-zinc-900">
                          {st.leads === null ? '—' : `${st.leads} leads`}
                        </p>
                        <p className="text-[11px] text-zinc-500">{st.users} users</p>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${st.active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                        {st.active ? 'Active' : 'Suspended'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {activeTab === 'builders' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">{isTech ? 'My Branch Builders' : 'Builder Management'}</h3>
                <p className="text-sm text-zinc-500 mt-0.5">
                  {isTech ? `Builders you onboard go to a super admin for approval before going live.` : 'Onboard, activate, suspend, or delete builder workspaces.'}
                </p>
              </div>
              <button onClick={() => setShowAddBuilder(true)} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">
                <Plus className="h-4 w-4" /> Onboard Builder
              </button>
            </div>
            <div className="space-y-2">
              {tenants.length === 0 && (
                <p className="text-sm text-zinc-400 text-center py-8">No builders in your branch yet — onboard your first.</p>
              )}
              {tenants.map(t => {
                const st = tenantStats(t);
                const approval = t.approvalStatus ?? 'approved';
                return (
                  <div key={t.id} className="flex items-center gap-4 p-3.5 rounded-xl border border-zinc-100 hover:bg-zinc-50 flex-wrap">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {t.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-900">{t.company}</p>
                      <p className="text-[11px] text-zinc-500 truncate">
                        <span className="font-mono text-indigo-500">{portalHost(t.slug)}</span> · 🏢 {branchName(t.branchId)} · since {new Date(t.createdAt).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                      </p>
                    </div>
                    <span className="text-xs font-medium bg-zinc-100 text-zinc-600 px-3 py-1 rounded-full">{t.plan}</span>
                    {approval !== 'approved' && (
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${approval === 'pending' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-500'}`}>{approval}</span>
                    )}
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${
                      t.status === 'suspended' ? 'bg-red-50 text-red-500' : t.status === 'trial' ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'
                    }`}>{t.status || 'active'}</span>

                    {/* Super-admin-only inline approval for pending builders */}
                    {isSuperAdmin && approval === 'pending' && (
                      <>
                        <button onClick={() => handleApproval(t, 'approved')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Approve</button>
                        <button onClick={() => handleApproval(t, 'rejected')} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-100 text-zinc-500 hover:bg-red-50 hover:text-red-600">Reject</button>
                      </>
                    )}

                    {/* Manage (account access) — both super admin and branch team,
                        on approved builders. The modal itself gates governance. */}
                    {approval === 'approved' && (
                      <button onClick={() => setManageTenant(t)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                        <Settings2 className="h-3.5 w-3.5" /> {isTech ? 'Account' : 'Manage'}
                      </button>
                    )}
                    {/* Governance actions — super admin only */}
                    {isSuperAdmin && (
                      <>
                        <button onClick={() => handleToggleTenantUsers(t, !st.active)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${st.active ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>
                          <Power className="h-3.5 w-3.5" /> {st.active ? 'Suspend' : 'Activate'}
                        </button>
                        <button onClick={() => handleDeleteTenant(t)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-100 text-zinc-500 hover:bg-red-600 hover:text-white transition-colors" title="Permanently delete workspace and all data">
                          <X className="h-3.5 w-3.5" /> Delete
                        </button>
                      </>
                    )}
                    {isTech && approval === 'pending' && (
                      <span className="text-[11px] text-amber-600 font-medium">Awaiting super-admin approval</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pending Approvals queue — super admin only */}
        {activeTab === 'approvals' && isSuperAdmin && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-amber-500" /> Pending Approvals</h3>
              <p className="text-sm text-zinc-500 mt-0.5">Builders onboarded by branch teams, waiting for you to authorize them to go live.</p>
            </div>
            {pendingTenants.length === 0 ? (
              <p className="text-sm text-zinc-400 text-center py-10">✓ All caught up — no builders pending approval.</p>
            ) : (
              <div className="space-y-2">
                {pendingTenants.map(t => (
                  <div key={t.id} className="flex items-center gap-4 p-3.5 rounded-xl border border-amber-200 bg-amber-50/30 flex-wrap">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0">{t.name.slice(0, 2).toUpperCase()}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-900">{t.company}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{t.email} · 🏢 {branchName(t.branchId)} · {t.plan} plan · submitted {new Date(t.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</p>
                    </div>
                    <button onClick={() => handleApproval(t, 'approved')} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Approve & Activate</button>
                    <button onClick={() => handleApproval(t, 'rejected')} className="px-4 py-2 rounded-lg text-xs font-semibold bg-white border border-zinc-200 text-zinc-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200">Reject</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Credentials & Access — every account on the platform. Super admin only. */}
        {activeTab === 'credentials' && isSuperAdmin && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-5">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-indigo-500" /> Credentials & Access
                </h3>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Every account across every workspace — sign in as anyone, set a password, and share it.
                </p>
              </div>
              <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                {credUsers.length} account{credUsers.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="mt-3 mb-4 flex items-start gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
              <ShieldCheck className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-indigo-800 leading-relaxed">
                Grant access without ever seeing a standing password. <span className="font-semibold">Login as</span> opens a workspace with no password;
                <span className="font-semibold"> Issue temp password</span> sets a one-time password and forces the user to choose their own on next sign-in.
                Existing passwords are never shown or copied — the same secure model works against the argon2id backend. Every action is audit-logged.
              </p>
            </div>

            <div className="flex gap-2 mb-3 flex-wrap">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  value={credSearch} onChange={e => setCredSearch(e.target.value)}
                  placeholder="Search by name, email, or workspace..."
                  className="w-full pl-9 pr-4 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
              </div>
              <select
                value={credRole} onChange={e => setCredRole(e.target.value)}
                aria-label="Filter by role"
                className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="all">All roles</option>
                <option value="super_admin">Super Admin</option>
                <option value="tech_team">Branch Team</option>
                <option value="builder_admin">Builder Admin</option>
                <option value="sales_manager">Sales Manager</option>
                <option value="sales_executive">Sales Executive</option>
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-zinc-400 uppercase tracking-wider border-b border-zinc-100">
                    <th className="py-2 pr-3 font-medium">User</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 pr-3 font-medium">Workspace</th>
                    <th className="py-2 pr-3 font-medium">Access</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {credUsers.map(u => {
                    const t = tenantOf(u);
                    const isPlatformStaff = u.role === 'super_admin' || u.role === 'tech_team';
                    return (
                      <tr key={u.id} className="border-b border-zinc-50 hover:bg-zinc-50/60">
                        <td className="py-2.5 pr-3">
                          <p className="font-medium text-zinc-900 flex items-center gap-1.5">
                            {u.name}
                            {!u.active && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-400">INACTIVE</span>}
                          </p>
                          <p className="text-[11px] text-zinc-400">{u.email}</p>
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${isPlatformStaff ? 'bg-indigo-50 text-indigo-700' : 'bg-zinc-100 text-zinc-600'}`}>
                            {u.role.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-zinc-600">{t?.name || '—'}</td>
                        <td className="py-2.5 pr-3">
                          {u.mustChangePassword ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                              <KeyRound className="h-3 w-3" /> Temp — reset pending
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                              <ShieldCheck className="h-3 w-3" /> Password set
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => openPwModal(u)}
                              title="Issue a one-time temporary password; the user must reset it on next login"
                              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                            >
                              <KeyRound className="h-3 w-3" /> Issue temp password
                            </button>
                            {!isPlatformStaff && t && (
                              <button
                                onClick={() => handleImpersonate(t, u.id)}
                                title="Sign in as this user — no password needed"
                                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
                              >
                                <LogIn className="h-3 w-3" /> Login as
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {credUsers.length === 0 && (
                <p className="text-sm text-zinc-400 text-center py-10">No accounts match your search.</p>
              )}
            </div>
          </div>
        )}

        {/* Branch management — super admin only */}
        {activeTab === 'branches' && isSuperAdmin && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Branches</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Regional offices of your platform. Each branch's team onboards and manages its own builders.</p>
              </div>
              <button onClick={() => setShowAddBranch(true)} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">
                <Plus className="h-4 w-4" /> New Branch
              </button>
            </div>
            <div className="space-y-2">
              {branches.map(b => {
                const count = allTenants.filter(t => (t.branchId ?? getLegacyBranch()?.id) === b.id).length;
                const manager = allUsers.find(u => u.id === b.managerId);
                return (
                  <div key={b.id} className="flex items-center gap-4 p-3.5 rounded-xl border border-zinc-100">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center text-white"><Globe className="h-5 w-5" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-900">{b.name}</p>
                      <p className="text-[11px] text-zinc-500">Manager: {manager?.name || 'Unassigned'}</p>
                    </div>
                    <span className="text-xs font-medium bg-zinc-100 text-zinc-600 px-3 py-1 rounded-full">{count} builder{count === 1 ? '' : 's'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'billing' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-zinc-900">{isTech ? 'Branch Revenue' : 'Subscriptions & Billing'}</h3>
              <p className="text-sm text-zinc-500 mt-0.5">
                {isTech ? `Plan & revenue for builders in ${branchName(user?.branchId)}. Plan changes are handled by a super admin.` : 'Plan distribution and monthly recurring revenue.'}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Builder</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Plan</th>
                    <th className="text-right py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">MRR</th>
                    {!isTech && <th className="text-left py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Change Plan</th>}
                  </tr>
                </thead>
                <tbody>
                  {tenants.map(t => (
                    <tr key={t.id} className="border-b border-zinc-50">
                      <td className="py-3 px-4 text-sm font-medium text-zinc-900">{t.name}</td>
                      <td className="py-3 px-4"><span className="text-xs font-medium bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full">{t.plan}</span></td>
                      <td className="py-3 px-4 text-sm font-semibold text-zinc-900 text-right">
                        {(t.status ?? 'active') === 'active'
                          ? <>
                              ${tenantMrrUsd(t)}/mo
                              {typeof t.overrides?.customPriceMonthly === 'number' && (
                                <span className="ml-1.5 text-[9px] font-bold bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full align-middle">CUSTOM</span>
                              )}
                            </>
                          : <span className="text-zinc-400 capitalize">{t.status} — $0</span>}
                      </td>
                      {!isTech && (
                      <td className="py-3 px-4">
                        <select
                          value={t.plan}
                          onChange={e => {
                            // An admin plan change is a conversion: trial ends, tenant becomes billable
                            update<Tenant>('tenants', t.id, {
                              plan: e.target.value,
                              ...(t.status === 'trial' ? { status: 'active' as const, trialEndsAt: undefined } : {}),
                            });
                            platformAudit('update', t.id, `Plan changed to ${e.target.value} for "${t.name}"`);
                            refresh();
                            toast.success('Plan updated');
                          }}
                          className="text-xs px-2 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none"
                        >
                          <option>Starter</option><option>Growth</option><option>Enterprise</option>
                        </select>
                      </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center justify-between">
              <p className="text-sm font-semibold text-emerald-800">{isTech ? `${branchName(user?.branchId)} Recurring Revenue` : 'Total Monthly Recurring Revenue (billable tenants)'}</p>
              <p className="text-xl font-bold text-emerald-700">${mrrUsd.toLocaleString()}/mo</p>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-5">
            <div>
              <h3 className="text-lg font-semibold text-zinc-900">Global Settings</h3>
              <p className="text-sm text-zinc-500 mt-0.5">Platform-wide defaults applied to all tenants.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1.5">SMTP Host</label>
                <input defaultValue={`smtp.${BRAND.portalDomain}`} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1.5">SMS Gateway</label>
                <select className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none">
                  <option>MSG91</option><option>Twilio</option><option>Gupshup</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1.5">Currency</label>
                <select className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none">
                  <option>INR (₹)</option><option>USD ($)</option><option>AED (د.إ)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1.5">Date Format</label>
                <select className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none">
                  <option>DD MMM YYYY</option><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option>
                </select>
              </div>
            </div>
            <div className="pt-4 border-t border-zinc-100 flex justify-end">
              <button onClick={() => toast.success('Global settings saved')} className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Save Settings</button>
            </div>
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-zinc-900">Platform Audit Logs</h3>
              <p className="text-sm text-zinc-500 mt-0.5">{isTech ? `Actions on your branch's builders` : 'All sensitive actions across every tenant'} ({allAudit.length} entries).</p>
            </div>
            {allAudit.length === 0 ? (
              <div className="py-12 text-center">
                <ScrollText className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No audit entries yet.</p>
              </div>
            ) : (
              <div className="space-y-1 max-h-[480px] overflow-y-auto">
                {allAudit.map(log => (
                  <div key={log.id} className="flex items-start gap-3 py-3 border-b border-zinc-50 last:border-0">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold uppercase ${
                      log.action === 'delete' || log.action === 'deactivate' ? 'bg-red-50 text-red-600' :
                      log.action === 'merge' ? 'bg-amber-50 text-amber-600' :
                      log.action === 'send' || log.action === 'pay' || log.action === 'activate' ? 'bg-emerald-50 text-emerald-600' :
                      'bg-indigo-50 text-indigo-600'
                    }`}>{log.action.slice(0, 3)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-800">{log.details}</p>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        {log.userName} · {log.entity} · {new Date(log.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <span className="text-[10px] font-semibold text-zinc-400 uppercase shrink-0">{log.action}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'support' && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Tenant Support & Diagnosticians</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Safe platform debugging. Switch tenant view below to inspect, verify data healthy state, or manage records under strict Super Admin control.</p>
              </div>
              <div className="space-y-2">
                {tenants.map(t => {
                  const st = tenantStats(t);
                  return (
                    <div key={t.id} className="flex items-center gap-4 p-3.5 rounded-xl border border-zinc-100 flex-wrap hover:bg-zinc-50/50">
                      <CheckCircle2 className={`h-5 w-5 shrink-0 ${st.active ? 'text-emerald-500' : 'text-red-400'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-zinc-900">{t.name}</p>
                        <p className="text-[11px] text-zinc-500">{st.users} users · {st.leads} leads · RERA compliant · data healthy</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const tenantLeads = allLeads.filter(l => l.tenantId === t.id);
                            const tenantInvoices = getAll<any>('invoices').filter(i => i.tenantId === t.id);
                            const tenantBookings = getAll<any>('bookings').filter(b => b.tenantId === t.id);
                            toast.success(`Diagnostic Log [${t.name}]:\n- Active Leads: ${tenantLeads.length}\n- Open Invoices: ${tenantInvoices.length}\n- Booking Count: ${tenantBookings.length}`);
                          }}
                          className="px-3 py-1.5 bg-zinc-100 text-zinc-700 rounded-lg text-xs font-semibold hover:bg-zinc-200"
                        >
                          Verify Database
                        </button>
                        <button
                          onClick={() => handleImpersonate(t)}
                          className="px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100"
                        >
                          Impersonate User
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Diagnostic Leads Table */}
            <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
              <div>
                <h4 className="text-base font-bold text-zinc-900">Platform-Wide Records Monitor</h4>
                <p className="text-xs text-zinc-500">Cross-tenant lead directory allowing instant debugging and reassignments.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-zinc-50/50 border-b border-zinc-100">
                      <th className="text-left py-2 px-3 text-xs font-semibold text-zinc-500 uppercase">Tenant</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-zinc-500 uppercase">Name</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-zinc-500 uppercase">Project</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-zinc-500 uppercase">Stage</th>
                      <th className="text-right py-2 px-3 text-xs font-semibold text-zinc-500 uppercase">Budget</th>
                      <th className="text-center py-2 px-3 text-xs font-semibold text-zinc-500 uppercase">Platform Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allLeads.slice(0, 15).map(lead => {
                      const leadTenant = tenants.find(t => t.id === lead.tenantId);
                      return (
                        <tr key={lead.id} className="border-b border-zinc-50">
                          <td className="py-2.5 px-3 text-xs font-semibold text-indigo-600">{leadTenant?.name || 'Unknown'}</td>
                          <td className="py-2.5 px-3 text-sm font-medium text-zinc-900">{lead.name}</td>
                          <td className="py-2.5 px-3 text-xs text-zinc-500">{lead.project}</td>
                          <td className="py-2.5 px-3 text-xs capitalize text-zinc-600">{lead.stage.replace('_', ' ')}</td>
                          <td className="py-2.5 px-3 text-sm font-bold text-zinc-900 text-right">₹ {(lead.budget / 100000).toFixed(1)}L</td>
                          <td className="py-2.5 px-3 text-center">
                            <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">Secure</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Onboard builder modal */}
      {/* The temporary password, shown ONCE. It is stored as an argon2id hash
          and cannot be recovered, so a toast that fades while the operator is
          looking elsewhere would lose it permanently. Dismissed deliberately. */}
      {newWorkspace && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-zinc-900 mb-1">{newWorkspace.company} is ready</h3>
            <p className="text-sm text-zinc-500 mb-4">
              Send these to the administrator. They will be asked to change the password on first sign-in.
            </p>
            <dl className="space-y-2 mb-4">
              <div className="bg-zinc-50 rounded-xl px-3 py-2">
                <dt className="text-[11px] uppercase tracking-wider text-zinc-400">Email</dt>
                <dd className="font-mono text-sm text-zinc-800 break-all">{newWorkspace.email}</dd>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                <dt className="text-[11px] uppercase tracking-wider text-amber-700">Temporary password — shown once</dt>
                <dd className="font-mono text-sm text-zinc-900 break-all">{newWorkspace.tempPassword}</dd>
              </div>
            </dl>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(`${newWorkspace.email}  /  ${newWorkspace.tempPassword}`);
                  toast.success('Copied');
                }}
                className="flex-1 py-2.5 rounded-xl border border-zinc-200 text-sm font-medium hover:bg-zinc-50"
              >
                Copy
              </button>
              <button
                onClick={() => setNewWorkspace(null)}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
              >
                I've saved it
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddBuilder && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddBuilder(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Onboard New Builder</h3>
              <button onClick={() => setShowAddBuilder(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddBuilder} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Company Name *</label>
                <input name="company" required placeholder="Acme Builders Pvt Ltd" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                <p className="text-[10px] text-zinc-400 mt-1">Workspace: <span className="font-mono text-indigo-500">company-name.{BRAND.portalDomain}</span></p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Admin Name *</label>
                  <input name="adminName" required placeholder="Owner name" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Phone</label>
                  <input name="phone" placeholder="+91..." className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Admin Email *</label>
                <input name="adminEmail" type="email" required placeholder="admin@company.com" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Password *</label>
                  <input name="password" type="password" required minLength={6} placeholder="Min 6 chars" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Plan</label>
                  <select name="plan" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none">
                    <option>Starter</option><option>Growth</option><option>Enterprise</option>
                  </select>
                </div>
              </div>
              {/* Branch assignment — mandatory. Tech team is locked to its own. */}
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Branch *</label>
                {isTech ? (
                  <input disabled value={branchName(user?.branchId)} className="w-full px-3 py-2.5 bg-zinc-100 border border-zinc-200 rounded-xl text-sm text-zinc-500" />
                ) : (
                  <select name="branchId" required defaultValue={getLegacyBranch()?.id} className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                )}
                {isTech && <p className="text-[11px] text-amber-600 mt-1">This builder will be submitted for super-admin approval before going live.</p>}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAddBuilder(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">{isTech ? 'Submit for Approval' : 'Onboard Builder'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New branch modal (super admin) */}
      {showAddBranch && isSuperAdmin && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddBranch(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">New Branch</h3>
              <button onClick={() => setShowAddBranch(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddBranch} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Branch Name *</label>
                <input name="name" required placeholder="e.g. West Zone – Mumbai" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Branch Manager (optional)</label>
                <select name="managerId" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none">
                  <option value="">Unassigned</option>
                  {allUsers.filter(u => u.role === 'tech_team' || u.role === 'super_admin').map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowAddBranch(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">Create Branch</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tenant command center */}
      {manageTenant && (() => {
        const t = tenants.find(x => x.id === manageTenant.id) || manageTenant;
        const local = tenantUsage(t);
        const usage = local;
        // Server figures win when we have them; the local store is only the
        // browser-demo fallback. See serverUsage's effect above for why.
        const srv = serverUsage;
        const teamLabel = srv
          ? `${srv.users}/${srv.userTotal} active`
          : `${local.users.filter(u => u.active).length}/${local.users.length} active`;
        const leadsCount = srv ? srv.leads : local.leads;
        const bookedCount = srv ? srv.booked : local.booked;
        const revenueVal = srv ? srv.revenue : local.revenue;
        const portalAccounts = srv ? (srv.per.portal_users ?? 0) : (local.per.portalUsers || 0);
        const totalRecords = srv ? srv.totalRows : local.totalRows;
        // storageKb is deliberately not computed server-side (see the route):
        // an em dash beats a fabricated number on a governance screen.
        const storageKb = srv ? srv.storageKb : local.storageKb;
        const lastActivity = srv ? srv.lastActivity : local.lastActivity;
        return (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setManageTenant(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900">{t.company}</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    <span className="font-mono text-indigo-500">{portalHost(t.slug)}</span> · {t.plan} plan ·{' '}
                    <span className="capitalize">{t.status || 'active'}</span>
                    {t.status === 'trial' && t.trialEndsAt && ` (ends ${new Date(t.trialEndsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`}
                  </p>
                </div>
                <button onClick={() => setManageTenant(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
              </div>

              {/* Usage & health */}
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[
                  ['Team', teamLabel],
                  ['Leads', `${leadsCount} (${bookedCount} booked)`],
                  ['Revenue', `₹${(revenueVal / 10000000).toFixed(1)} Cr`],
                  ['Portal Accounts', String(portalAccounts)],
                  ['Total Records', String(totalRecords)],
                  ['Storage', storageKb === null ? '—' : `${storageKb} KB`],
                ].map(([label, value]) => (
                  <div key={label} className="bg-zinc-50 rounded-xl p-3">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
                    <p className="text-sm font-bold text-zinc-900 mt-0.5">{value}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-zinc-400 mb-4">
                Last activity: {lastActivity ? new Date(lastActivity).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}
              </p>

              {/* Trial management — governance, super admin only */}
              {isSuperAdmin && t.status !== 'suspended' && (
                <div className="border border-amber-200 bg-amber-50/40 rounded-xl p-3.5 mb-3 flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <p className="text-xs font-semibold text-zinc-800">Trial Management</p>
                    <p className="text-[11px] text-zinc-500">
                      {t.status === 'trial'
                        ? `Trial ends ${t.trialEndsAt ? new Date(t.trialEndsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}`
                        : 'Billable tenant — extending grants a goodwill trial period'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => handleExtendTrial(t, 7)} className="px-3 py-1.5 bg-white border border-amber-300 text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-50">+7 days</button>
                    <button onClick={() => handleExtendTrial(t, 14)} className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-semibold hover:bg-amber-600">+14 days</button>
                  </div>
                </div>
              )}

              {/* ── Custom Control Model — governance, super admin only ── */}
              {isSuperAdmin && (
              <div className="border border-indigo-200 bg-indigo-50/30 rounded-xl p-4 mb-3 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-indigo-800 uppercase tracking-wider">Custom Controls</p>
                  <span className="text-[10px] text-zinc-400">Unset = plan defaults</span>
                </div>

                {/* Module toggles */}
                <div>
                  <p className="text-[11px] font-semibold text-zinc-600 mb-2">Modules enabled for this workspace</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {CONTROLLABLE_MODULES.map(m => {
                      const disabled = (t.overrides?.disabledModules || []).includes(m.key);
                      return (
                        <label key={m.key} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer border ${disabled ? 'bg-zinc-100 border-zinc-200 text-zinc-400' : 'bg-white border-emerald-200 text-zinc-700'}`}>
                          <input
                            type="checkbox"
                            checked={!disabled}
                            onChange={() => {
                              const cur = t.overrides?.disabledModules || [];
                              const next = disabled ? cur.filter(k => k !== m.key) : [...cur, m.key];
                              handleSaveOverrides(t, { disabledModules: next });
                              toast.success(`${m.label} ${disabled ? 'enabled' : 'disabled'} for ${t.name}`);
                            }}
                            className="h-3.5 w-3.5 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          {m.label}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Limits & billing overrides */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {([
                    ['maxUsers', 'Max Users', t.overrides?.maxUsers, PLANS.find(p => p.name === t.plan)?.limits.users],
                    ['maxProjects', 'Max Projects', t.overrides?.maxProjects, PLANS.find(p => p.name === t.plan)?.limits.projects],
                    ['storageLimitKb', 'Storage (KB)', t.overrides?.storageLimitKb, '—'],
                    ['customPriceMonthly', 'Custom $/mo', t.overrides?.customPriceMonthly, tenantMrrUsd({ ...t, overrides: { ...t.overrides, customPriceMonthly: undefined } })],
                  ] as [keyof TenantOverrides, string, number | undefined, unknown][]).map(([key, label, value, planDefault]) => (
                    <div key={key}>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{label}</p>
                      <input
                        type="number"
                        defaultValue={value ?? ''}
                        placeholder={`${planDefault === -1 ? '∞' : planDefault}`}
                        onBlur={e => {
                          const v = e.target.value.trim();
                          handleSaveOverrides(t, { [key]: v === '' ? undefined : Number(v) } as Partial<TenantOverrides>);
                          if (v !== '') toast.success(`${label} override saved`);
                        }}
                        className="w-full px-2 py-1.5 bg-white border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                    </div>
                  ))}
                </div>
                {typeof t.overrides?.storageLimitKb === 'number' && storageKb === null && (
                  <p className="text-[11px] text-zinc-400">
                    Storage limit set to {t.overrides.storageLimitKb} KB — actual usage is not measured
                    server-side, so no bar is shown rather than a made-up one.
                  </p>
                )}
                {typeof t.overrides?.storageLimitKb === 'number' && storageKb !== null && (
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="text-zinc-500">Storage usage</span>
                      <span className={storageKb > t.overrides.storageLimitKb ? 'text-red-600 font-bold' : 'text-zinc-600 font-medium'}>
                        {storageKb} / {t.overrides.storageLimitKb} KB
                        {storageKb > t.overrides.storageLimitKb && ' — OVER LIMIT'}
                      </span>
                    </div>
                    <div className="h-1.5 bg-zinc-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${usage.storageKb > t.overrides.storageLimitKb ? 'bg-red-500' : 'bg-indigo-500'}`}
                        style={{ width: `${Math.min(100, (usage.storageKb / t.overrides.storageLimitKb) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              )}

              {/* Support login — super admin can enter as ANY role in this
                  workspace; branch team enters as the builder admin. */}
              {isSuperAdmin ? (
                <div className="mb-2 p-3 bg-zinc-900 rounded-xl">
                  <p className="text-[11px] font-semibold text-zinc-300 mb-2">🔐 Access this workspace as any role</p>
                  <div className="flex gap-2">
                    <select
                      value={impersonateUserId}
                      onChange={e => setImpersonateUserId(e.target.value)}
                      className="flex-1 px-2 py-2 bg-white/10 border border-white/20 text-white rounded-lg text-xs focus:outline-none"
                    >
                      <option value="" className="text-zinc-900">Builder Admin (default)</option>
                      {usage.users.filter(u => u.active && u.role !== 'tech_team').map(u => (
                        <option key={u.id} value={u.id} className="text-zinc-900">{u.name} — {u.role.replace('_', ' ')}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleImpersonate(t, impersonateUserId || undefined)}
                      className="px-3 py-2 bg-white text-zinc-900 rounded-lg text-xs font-bold hover:bg-zinc-100"
                    >
                      Enter →
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => handleImpersonate(t)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 mb-2 bg-zinc-900 text-white rounded-xl text-xs font-semibold hover:bg-zinc-800"
                >
                  🔐 Access Workspace (support login)
                </button>
              )}
              {/* Full-data export + credential reset are takeover-grade — super admin only */}
              {isSuperAdmin && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleExportTenant(t)}
                    className="px-3 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-xs font-semibold hover:bg-zinc-50"
                  >
                    📦 Export All Data (JSON)
                  </button>
                  <button
                    onClick={() => handleResetAdminPassword(t)}
                    className="px-3 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-xs font-semibold hover:bg-zinc-50"
                  >
                    🔑 Reset Admin Password
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Set & share password — works against the demo store AND (via the reset
          endpoint) a real hashed backend, unlike reveal. */}
      {pwUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4"
          onClick={() => setPwUser(null)}
          role="dialog" aria-modal="true" aria-label="Set password"
        >
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-zinc-200 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h3 className="text-base font-bold text-zinc-900 flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-indigo-500" /> Issue temporary password
              </h3>
              <button onClick={() => setPwUser(null)} aria-label="Close" className="text-zinc-400 hover:text-zinc-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-4">
              For <span className="font-semibold text-zinc-700">{pwUser.name}</span> ({pwUser.email}) ·{' '}
              <span className="capitalize">{pwUser.role.replace(/_/g, ' ')}</span>
            </p>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Temporary password</label>
            <div className="flex gap-2">
              <input
                value={pwValue} onChange={e => setPwValue(e.target.value)} autoFocus
                className="flex-1 px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
              />
              <button
                type="button" onClick={() => setPwValue(genPassword())}
                aria-label="Generate a new password" title="Generate"
                className="px-3 py-2.5 bg-zinc-100 rounded-xl text-zinc-600 hover:bg-zinc-200"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={handleSavePassword}
              className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm"
            >
              <Copy className="h-4 w-4" /> Set temporary password &amp; copy
            </button>
            <p className="text-[11px] text-zinc-400 mt-3 text-center">
              Copies the temporary password to share once. {pwUser.name.split(' ')[0]} must set their own password on next sign-in. Audit-logged.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
