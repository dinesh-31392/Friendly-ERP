import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Building2, Brain, BarChart3, TrendingUp,
  Settings, Calendar, ChevronDown, Bell, Search, Megaphone,
  MessageSquare, FileText, CreditCard, Wrench, Shield, LogOut,
  X, AlertCircle, CheckCircle2, Clock, Menu, BookOpenCheck, Handshake, Globe, ShieldAlert,
  HardHat, Truck, Package, UserCheck, Scale, Map,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect, useMemo, useRef } from 'react';
import { getByTenant } from '../services/db';
import { isDemoMode } from '../services/apiClient';
import { trialDaysLeft, isModuleEnabled } from '../services/planService';
import { lowStockMaterials } from '../services/procurementService';
import { filingsDueSoon } from '../services/complianceService';
import InstallAppButton from '../components/InstallAppButton';
import ErrorBoundary from '../components/ErrorBoundary';
import type { Lead, Task, Ticket, Conversation, SiteTask, PurchaseOrder, Vendor, Material, Employee } from '../types';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', permission: 'view_dashboard' },
  { to: '/bd', icon: Handshake, label: 'Business Dev', permission: 'view_bd' },
  { to: '/land', icon: Map, label: 'Land Acquisition', permission: 'view_land' },
  { to: '/leads', icon: Users, label: 'Leads', permission: 'view_leads' },
  { to: '/projects', icon: Building2, label: 'Projects', permission: 'view_projects' },
  { to: '/execution', icon: HardHat, label: 'Site Execution', permission: 'view_execution' },
  { to: '/procurement', icon: Truck, label: 'Procurement', permission: 'view_procurement' },
  { to: '/hr', icon: UserCheck, label: 'HR & Workforce', permission: 'view_hr' },
  { to: '/inventory', icon: Building2, label: 'Inventory', permission: 'view_inventory' },
  { to: '/bookings', icon: BookOpenCheck, label: 'Bookings', permission: 'view_bookings' },
  { to: '/sales-performance', icon: TrendingUp, label: 'Sales Performance', permission: 'view_sales_performance' },
  { to: '/ai-studio', icon: Brain, label: 'AI Studio', permission: 'use_ai_studio' },
  { to: '/campaigns', icon: Megaphone, label: 'Campaigns', permission: 'view_campaigns' },
  { to: '/calendar', icon: Calendar, label: 'Calendar', permission: 'view_calendar' },
  { to: '/reports', icon: BarChart3, label: 'Reports', permission: 'view_reports' },
];

const secondaryNav = [
  { to: '/messages', icon: MessageSquare, label: 'Messages', permission: 'view_messages' },
  { to: '/documents', icon: FileText, label: 'Documents', permission: 'view_documents' },
  { to: '/billing', icon: CreditCard, label: 'Billing', permission: 'view_finance' },
  { to: '/accounts', icon: Scale, label: 'Accounts & Ledger', permission: 'view_accounts' },
  { to: '/service', icon: Wrench, label: 'Service', permission: 'view_service' },
  { to: '/brokers', icon: Handshake, label: 'Partners', permission: 'view_brokers' },
  { to: '/settings', icon: Settings, label: 'Settings', permission: 'manage_settings' },
];

const platformNav = [
  { to: '/platform', icon: Globe, label: 'Platform Control', permission: 'view_platform' },
];

// The demo role switcher only walks THIS workspace's role model. super_admin /
// tech_team are cross-tenant platform staff and must never be reachable from a
// builder workspace — the demo super admin is seeded inside the demo tenant, so
// listing it here let any sales executive escalate to full platform control.
// AuthContext.switchRole enforces this too; this list is just the UI half.
const roles = [
  { role: 'builder_admin' as const, label: 'Builder Admin' },
  { role: 'sales_manager' as const, label: 'Sales Manager' },
  { role: 'sales_executive' as const, label: 'Sales Executive' },
  { role: 'site_engineer' as const, label: 'Site Engineer' },
  { role: 'telecaller' as const, label: 'Telecaller' },
  { role: 'accountant' as const, label: 'Accountant' },
  { role: 'auditor' as const, label: 'Auditor' },
  { role: 'land_manager' as const, label: 'Land Manager' },
  { role: 'bd_manager' as const, label: 'BD Manager' },
];

export default function DashboardLayout() {
  const { user, tenant, switchRole, hasPermission, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  // Demo-mode notice: shown when no backend is configured (data lives only in
  // this browser). Dismiss is per-session, so it re-appears on a fresh load —
  // it's a security label, not a nag.
  const [demoNoticeDismissed, setDemoNoticeDismissed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const roleMenuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  const tenantId = tenant?.id || '';
  const userId = user?.id || '';
  const isExecutive = user?.role === 'sales_executive';

  const allLeads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, location.pathname]);
  const allTasks = useMemo(() => getByTenant<Task>('tasks', tenantId), [tenantId, location.pathname]);
  const allTickets = useMemo(() => getByTenant<Ticket>('tickets', tenantId), [tenantId, location.pathname]);
  const allConversations = useMemo(() => getByTenant<Conversation>('conversations', tenantId), [tenantId, location.pathname]);

  const leads = isExecutive ? allLeads.filter(l => l.assignedTo === userId) : allLeads;
  const tasks = isExecutive ? allTasks.filter(t => t.userId === userId) : allTasks;
  const visibleLeadIds = new Set(leads.map(l => l.id));
  const conversations = isExecutive ? allConversations.filter(c => visibleLeadIds.has(c.leadId)) : allConversations;
  const tickets = isExecutive ? [] : allTickets;

  // Module toggle helper — a super-admin-disabled module contributes nothing
  // to nav, search, or notifications (and its routes are hard-blocked too).
  const moduleOn = (key: string) => key === '' || isModuleEnabled(tenant, key);

  // ERP modules — gated on permission AND module so nothing leaks to roles
  // (or tenants) that can't reach the pages
  const canExec = hasPermission('view_execution') && moduleOn('execution');
  const canProc = hasPermission('view_procurement') && moduleOn('procurement');
  const overdueSiteTasks = useMemo(
    () => canExec
      ? getByTenant<SiteTask>('siteTasks', tenantId).filter(t => t.status !== 'done' && new Date(t.dueDate).getTime() < Date.now())
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, location.pathname, canExec]
  );
  const lowStock = useMemo(
    () => canProc ? lowStockMaterials(tenantId) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, location.pathname, canProc]
  );
  const pendingPoApprovals = useMemo(
    () => canProc && hasPermission('approve_purchase_orders')
      ? getByTenant<PurchaseOrder>('purchaseOrders', tenantId).filter(p => p.status === 'pending_approval')
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, location.pathname, canProc]
  );
  const canHr = hasPermission('view_hr') && moduleOn('hr');
  const dueFilings = useMemo(
    () => hasPermission('view_finance') && moduleOn('billing') ? filingsDueSoon(tenantId) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, location.pathname, tenant]
  );

  // Counts only from ENABLED modules (a disabled module must not leak counts)
  const unreadMessages = moduleOn('messages') ? conversations.reduce((s, c) => s + c.unread, 0) : 0;
  const openTickets = moduleOn('service') ? tickets.filter(t => t.status === 'open').length : 0;
  const pendingTasks = moduleOn('calendar') ? tasks.filter(t => t.status === 'pending' && t.priority === 'hot').length : 0;
  const newLeads = moduleOn('leads') ? leads.filter(l => l.stage === 'new').length : 0;
  const totalNotifications = unreadMessages + openTickets + pendingTasks + newLeads
    + overdueSiteTasks.length + lowStock.length + pendingPoApprovals.length + dueFilings.length;

  // Build notifications list — each entry gated by its module being enabled
  const notifications = useMemo(() => {
    const items: Array<{ id: string; type: string; title: string; time: string; link: string; icon: React.ElementType; color: string }> = [];
    if (moduleOn('leads')) leads.filter(l => l.stage === 'new').slice(0, 3).forEach(l => {
      items.push({ id: `l-${l.id}`, type: 'lead', title: `New lead: ${l.name} (${l.project})`, time: new Date(l.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), link: '/leads', icon: Users, color: 'text-blue-500' });
    });
    if (moduleOn('calendar')) tasks.filter(t => t.status === 'pending' && t.priority === 'hot').slice(0, 3).forEach(t => {
      items.push({ id: `t-${t.id}`, type: 'task', title: t.title, time: new Date(t.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), link: '/calendar', icon: Clock, color: 'text-amber-500' });
    });
    if (moduleOn('service')) tickets.filter(t => t.status === 'open').slice(0, 3).forEach(t => {
      items.push({ id: `tk-${t.id}`, type: 'ticket', title: `Open ticket: ${t.title}`, time: new Date(t.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), link: '/service', icon: AlertCircle, color: 'text-red-500' });
    });
    if (moduleOn('messages') && unreadMessages > 0) {
      items.push({ id: 'msg-all', type: 'msg', title: `${unreadMessages} unread messages`, time: 'now', link: '/messages', icon: MessageSquare, color: 'text-indigo-500' });
    }
    // ERP: construction & supply alerts
    overdueSiteTasks.slice(0, 3).forEach(t => {
      items.push({ id: `st-${t.id}`, type: 'site_task', title: `Overdue on site: ${t.title}`, time: new Date(t.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), link: `/execution?project=${t.projectId}`, icon: HardHat, color: 'text-red-500' });
    });
    lowStock.slice(0, 3).forEach(({ material, onHand }) => {
      items.push({ id: `ls-${material.id}`, type: 'stock', title: `Reorder ${material.name} — ${onHand} ${material.unit} left`, time: 'now', link: '/procurement', icon: Package, color: 'text-red-500' });
    });
    if (pendingPoApprovals.length > 0) {
      items.push({ id: 'po-approvals', type: 'po', title: `${pendingPoApprovals.length} purchase order${pendingPoApprovals.length === 1 ? '' : 's'} awaiting approval`, time: 'now', link: '/procurement', icon: Truck, color: 'text-amber-500' });
    }
    dueFilings.slice(0, 3).forEach(f => {
      items.push({ id: `cf-${f.id}`, type: 'filing', title: `Filing due: ${f.title} (${f.authority})`, time: new Date(f.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), link: '/billing', icon: Shield, color: 'text-red-500' });
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, tasks, tickets, unreadMessages, tenant, overdueSiteTasks, lowStock, pendingPoApprovals, dueFilings]);

  // Global search results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const results: Array<{ id: string; type: string; label: string; link: string; icon: React.ElementType }> = [];
    if (moduleOn('leads')) leads.filter(l => l.name.toLowerCase().includes(q) || l.phone.includes(q) || l.email.toLowerCase().includes(q)).slice(0, 5).forEach(l => {
      results.push({ id: l.id, type: 'Lead', label: `${l.name} — ${l.project}`, link: '/leads', icon: Users });
    });
    if (moduleOn('calendar')) tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 3).forEach(t => {
      results.push({ id: t.id, type: 'Task', label: t.title, link: '/calendar', icon: Clock });
    });
    if (moduleOn('service')) tickets.filter(t => t.title.toLowerCase().includes(q) || t.customer.toLowerCase().includes(q)).slice(0, 3).forEach(t => {
      results.push({ id: t.id, type: 'Ticket', label: `${t.title} (${t.customer})`, link: '/service', icon: Wrench });
    });
    if (hasPermission('view_brokers') && moduleOn('brokers')) {
      getByTenant<{ id: string; tenantId: string; name: string; firm: string }>('brokers', tenantId)
        .filter(b => b.name.toLowerCase().includes(q) || b.firm.toLowerCase().includes(q))
        .slice(0, 3)
        .forEach(b => {
          results.push({ id: b.id, type: 'Partner', label: `${b.name} — ${b.firm}`, link: '/brokers', icon: Handshake });
        });
    }
    if (hasPermission('view_bookings') && moduleOn('bookings')) {
      const bookingLeads = leads.filter(l => l.stage === 'booked' && l.name.toLowerCase().includes(q)).slice(0, 3);
      bookingLeads.forEach(l => {
        results.push({ id: l.id, type: 'Booking', label: `${l.name} — ${l.project}`, link: '/bookings', icon: BookOpenCheck });
      });
    }
    if (canExec) {
      getByTenant<SiteTask>('siteTasks', tenantId)
        .filter(t => t.title.toLowerCase().includes(q)).slice(0, 3)
        .forEach(t => {
          results.push({ id: t.id, type: 'Site Task', label: t.title, link: `/execution?project=${t.projectId}`, icon: HardHat });
        });
    }
    if (canProc) {
      getByTenant<Vendor>('vendors', tenantId)
        .filter(v => v.name.toLowerCase().includes(q)).slice(0, 3)
        .forEach(v => {
          results.push({ id: v.id, type: 'Vendor', label: `${v.name} — ${v.category}`, link: '/procurement', icon: Truck });
        });
      getByTenant<Material>('materials', tenantId)
        .filter(m => m.name.toLowerCase().includes(q)).slice(0, 3)
        .forEach(m => {
          results.push({ id: m.id, type: 'Material', label: m.name, link: '/procurement', icon: Package });
        });
    }
    if (canHr) {
      getByTenant<Employee>('employees', tenantId)
        .filter(e => e.name.toLowerCase().includes(q) || e.designation.toLowerCase().includes(q)).slice(0, 3)
        .forEach(e => {
          results.push({ id: e.id, type: 'Employee', label: `${e.name} — ${e.designation}`, link: '/hr', icon: UserCheck });
        });
    }
    return results;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, leads, tasks, tickets, tenantId, canExec, canProc, canHr]);

  // Keyboard shortcut for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setNotifOpen(false);
        setRoleMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Click outside handler
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (roleMenuRef.current && !roleMenuRef.current.contains(e.target as Node)) setRoleMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  const getPageTitle = () => {
    const all = [...navItems, ...secondaryNav, ...platformNav];
    const found = all.find(n => n.to === location.pathname);
    return found ? found.label : 'Dashboard';
  };

  // Module toggles: the super admin can disable modules per tenant; a
  // disabled module disappears for every role in that workspace (nav route
  // key is the path minus the leading slash — moduleOn is defined above).
  const navModuleOn = (to: string) => to === '/' || moduleOn(to.replace('/', ''));
  const allowedNav = navItems.filter(n => hasPermission(n.permission) && navModuleOn(n.to));
  const allowedSecondary = secondaryNav.filter(n => hasPermission(n.permission) && (n.to === '/settings' || navModuleOn(n.to)));
  const allowedPlatform = platformNav.filter(n => hasPermission(n.permission));

  // SaaS banners: trial countdown + super-admin support (impersonation) mode
  const daysLeft = trialDaysLeft(tenant);
  const inSupportMode = !!localStorage.getItem('friendly_crm_auth_admin_backup') && user?.role !== 'super_admin';
  const returnToAdmin = () => {
    const backup = localStorage.getItem('friendly_crm_auth_admin_backup');
    if (!backup) return;
    localStorage.setItem('friendly_crm_auth', backup);
    localStorage.removeItem('friendly_crm_auth_admin_backup');
    window.location.reload();
  };

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50">
      {/* Sidebar */}
      <aside className={`${sidebarCollapsed ? 'w-18' : 'w-64'} ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} fixed lg:relative inset-y-0 left-0 z-40 flex flex-col bg-white border-r border-zinc-200 transition-all duration-200 shrink-0`}>
        {/* Logo — white-labeled with the tenant's uploaded logo / brand color */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-100">
          {tenant?.logo ? (
            <img src={tenant.logo} alt={tenant.name} className="h-9 w-9 rounded-xl object-cover shrink-0" />
          ) : (
            <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: tenant?.primaryColor || 'linear-gradient(135deg, #6366f1, #7c3aed)' }}>
              <Building2 className="h-5 w-5 text-white" />
            </div>
          )}
          {!sidebarCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-zinc-900 leading-tight truncate">{tenant?.name || 'Friendly ERP'}</p>
              <p className="text-[11px] text-zinc-500">Friendly ERP</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          <p className={`text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2 ${sidebarCollapsed ? 'text-center' : 'px-3'}`}>
            {sidebarCollapsed ? '' : 'Main'}
          </p>
          {allowedNav.map(item => {
            const badge = item.to === '/leads' && newLeads > 0 ? newLeads : null;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg transition-all text-sm font-medium group relative
                  ${sidebarCollapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'}
                  ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}`
                }
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {!sidebarCollapsed && <span>{item.label}</span>}
                {badge && !sidebarCollapsed && (
                  <span className="ml-auto bg-indigo-100 text-indigo-600 text-[11px] font-semibold px-2 py-0.5 rounded-full">{badge}</span>
                )}
                {badge && sidebarCollapsed && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 w-4 bg-indigo-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{badge}</span>
                )}
              </NavLink>
            );
          })}

          {allowedSecondary.length > 0 && (
            <>
              <p className={`text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2 mt-6 ${sidebarCollapsed ? 'text-center' : 'px-3'}`}>
                {sidebarCollapsed ? '' : 'Workspace'}
              </p>
              {allowedSecondary.map(item => {
                const badge = item.to === '/messages' && unreadMessages > 0 ? unreadMessages : item.to === '/service' && openTickets > 0 ? openTickets : null;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-lg transition-all text-sm font-medium relative
                      ${sidebarCollapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'}
                      ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}`
                    }
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    {!sidebarCollapsed && <span>{item.label}</span>}
                    {badge && !sidebarCollapsed && (
                      <span className="ml-auto bg-red-100 text-red-600 text-[11px] font-semibold px-2 py-0.5 rounded-full">{badge}</span>
                    )}
                    {badge && sidebarCollapsed && (
                      <span className="absolute -top-0.5 -right-0.5 h-4 w-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{badge}</span>
                    )}
                  </NavLink>
                );
              })}
            </>
          )}

          {allowedPlatform.length > 0 && (
            <>
              <p className={`text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2 mt-6 ${sidebarCollapsed ? 'text-center' : 'px-3'}`}>
                {sidebarCollapsed ? '' : 'Platform'}
              </p>
              {allowedPlatform.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg transition-all text-sm font-medium
                    ${sidebarCollapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'}
                    ${isActive ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}`
                  }
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* User */}
        <div ref={roleMenuRef} className="border-t border-zinc-100 p-3 relative">
          <button
            onClick={() => setRoleMenuOpen(!roleMenuOpen)}
            className={`flex items-center gap-3 w-full rounded-lg p-2 hover:bg-zinc-100 transition-colors ${sidebarCollapsed ? 'justify-center' : ''}`}
          >
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {user?.name?.split(' ').map(n => n[0]).join('') || 'U'}
            </div>
            {!sidebarCollapsed && (
              <>
                <div className="flex-1 text-left min-w-0">
                  <p className="text-sm font-medium text-zinc-900 truncate">{user?.name || 'User'}</p>
                  <p className="text-[11px] text-zinc-500 capitalize">{user?.role?.replace('_', ' ') || 'guest'}</p>
                </div>
                <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform ${roleMenuOpen ? 'rotate-180' : ''}`} />
              </>
            )}
          </button>
          {roleMenuOpen && (
            <div className={`absolute bottom-full mb-2 bg-white border border-zinc-200 rounded-xl shadow-xl p-1.5 min-w-[200px] z-50 ${sidebarCollapsed ? 'left-16' : 'left-3 right-3'}`}>
              {/* Role switching is a localStorage demo tool — hidden in API mode where identity comes from the JWT */}
              {isDemoMode() && (<>
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider px-3 py-1.5">Try Role (Demo)</p>
              {roles.map(r => (
                <button
                  key={r.role}
                  onClick={() => { switchRole(r.role); setRoleMenuOpen(false); }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${user?.role === r.role ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-zinc-700 hover:bg-zinc-100'}`}
                >
                  {r.label}
                </button>
              ))}
              <div className="h-px bg-zinc-100 my-1.5" />
              </>)}
              <button
                onClick={() => { logout(); navigate('/login'); }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-30 lg:hidden" onClick={() => setMobileSidebarOpen(false)} />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Demo-mode notice — honest labelling that this build is not the
            server-backed, multi-tenant-secure deployment. */}
        {isDemoMode() && !demoNoticeDismissed && (
          <div className="bg-amber-50 text-amber-800 border-b border-amber-200 px-4 py-2 text-xs flex items-center justify-between gap-3 shrink-0">
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span><strong>Demo mode</strong> — data is stored in this browser only and is not multi-tenant secure. Connect the backend for a production deployment.</span>
            </span>
            <button
              onClick={() => setDemoNoticeDismissed(true)}
              aria-label="Dismiss"
              className="px-2 py-1 rounded-lg hover:bg-amber-100 font-semibold transition-colors shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Support (impersonation) mode banner */}
        {inSupportMode && (
          <div className="bg-zinc-900 text-white px-4 py-2 text-xs flex items-center justify-between gap-3 shrink-0">
            <span className="flex items-center gap-2">
              <Shield className="h-3.5 w-3.5 text-indigo-300" />
              Support mode — viewing <strong>{tenant?.name}</strong> as {user?.name}
            </span>
            <button
              onClick={returnToAdmin}
              className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded-lg font-semibold transition-colors"
            >
              Return to Platform Admin
            </button>
          </div>
        )}

        {/* Trial banner */}
        {daysLeft !== null && (
          <div className={`px-4 py-2 text-xs flex items-center justify-between gap-3 shrink-0 ${daysLeft > 0 ? 'bg-amber-50 text-amber-800 border-b border-amber-200' : 'bg-red-50 text-red-700 border-b border-red-200'}`}>
            <span className="font-medium">
              {daysLeft > 0
                ? `✨ Free trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining on the ${tenant?.plan} plan`
                : '⚠️ Your free trial has expired. Upgrade to keep managing your leads and inventory.'}
            </span>
            {hasPermission('manage_settings') && (
              <button
                onClick={() => navigate('/settings')}
                className={`px-3 py-1 rounded-lg font-semibold transition-colors ${daysLeft > 0 ? 'bg-amber-600 text-white hover:bg-amber-700' : 'bg-red-600 text-white hover:bg-red-700'}`}
              >
                Upgrade Plan
              </button>
            )}
          </div>
        )}

        {/* Top bar */}
        <header className="h-14 bg-white border-b border-zinc-200 flex items-center gap-4 px-4 lg:px-6 shrink-0">
          <button
            onClick={() => {
              if (window.innerWidth < 1024) setMobileSidebarOpen(true);
              else setSidebarCollapsed(!sidebarCollapsed);
            }}
            className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold text-zinc-900 hidden sm:block">{getPageTitle()}</h1>

          <div className="flex-1" />

          <button
            onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
            className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-zinc-100 rounded-lg text-sm text-zinc-500 min-w-[220px] hover:bg-zinc-200/60 transition-colors"
          >
            <Search className="h-4 w-4" />
            <span>Quick search...</span>
            <kbd className="ml-auto text-[10px] bg-zinc-200 px-1.5 py-0.5 rounded text-zinc-500 font-mono">⌘K</kbd>
          </button>

          <button
            onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
            className="md:hidden p-2 rounded-lg hover:bg-zinc-100 text-zinc-500 transition-colors"
          >
            <Search className="h-5 w-5" />
          </button>

          {/* Renders only when installing is genuinely possible (and never once
              the app is already running standalone). */}
          <InstallAppButton compact />

          <div ref={notifRef} className="relative">
            <button
              onClick={() => setNotifOpen(!notifOpen)}
              className="relative p-2 rounded-lg hover:bg-zinc-100 text-zinc-500 transition-colors"
            >
              <Bell className="h-5 w-5" />
              {totalNotifications > 0 && (
                <span className="absolute top-1 right-1 h-4 w-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {totalNotifications > 9 ? '9+' : totalNotifications}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute top-full right-0 mt-2 bg-white border border-zinc-200 rounded-2xl shadow-xl w-80 z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
                  <p className="text-sm font-semibold text-zinc-900">Notifications</p>
                  {totalNotifications > 0 && (
                    <span className="text-[10px] font-medium bg-red-50 text-red-600 px-2 py-0.5 rounded-full">{totalNotifications} new</span>
                  )}
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="py-10 text-center">
                      <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-2" />
                      <p className="text-sm text-zinc-500">You're all caught up!</p>
                    </div>
                  ) : (
                    notifications.map(n => (
                      <button
                        key={n.id}
                        onClick={() => { navigate(n.link); setNotifOpen(false); }}
                        className="w-full flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors border-b border-zinc-50 last:border-0 text-left"
                      >
                        <div className="h-8 w-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
                          <n.icon className={`h-4 w-4 ${n.color}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-800 truncate">{n.title}</p>
                          <p className="text-[11px] text-zinc-400 mt-0.5">{n.time}</p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="hidden lg:flex items-center gap-1.5">
            <Shield className="h-4 w-4 text-zinc-400" />
            <span className="text-[11px] font-medium text-zinc-400 uppercase">{user?.role?.replace('_', ' ') || 'GUEST'}</span>
          </div>
        </header>

        {/* Content — wrapped so a single page's crash shows a friendly fallback
            instead of tearing down the whole shell to a blank screen. Keying by
            pathname remounts the boundary on navigation, so moving to another
            page clears a prior error. */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <ErrorBoundary key={location.pathname} area="page">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* Global Search Modal */}
      {searchOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-start justify-center pt-20 px-4" onClick={() => setSearchOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100">
              <Search className="h-4 w-4 text-zinc-400" />
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search leads, tasks, tickets..."
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-zinc-400"
              />
              <button onClick={() => setSearchOpen(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {searchQuery.trim() === '' ? (
                <div className="py-10 text-center text-sm text-zinc-400">
                  Start typing to search across your workspace...
                </div>
              ) : searchResults.length === 0 ? (
                <div className="py-10 text-center text-sm text-zinc-400">
                  No results for "<span className="font-medium text-zinc-600">{searchQuery}</span>"
                </div>
              ) : (
                searchResults.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      localStorage.setItem(`friendly_crm_focus_${r.type.toLowerCase()}`, r.id);
                      navigate(r.link);
                      setSearchOpen(false);
                      setSearchQuery('');
                      // Dispatch custom event to let current route know we updated focus targets
                      window.dispatchEvent(new Event('friendly_crm_search_focus'));
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors border-b border-zinc-50 last:border-0 text-left"
                  >
                    <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                      <r.icon className="h-4 w-4 text-indigo-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-800 truncate">{r.label}</p>
                      <p className="text-[10px] font-medium text-zinc-400 uppercase mt-0.5">{r.type}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="px-4 py-2 border-t border-zinc-100 bg-zinc-50 text-[11px] text-zinc-500 flex justify-between">
              <span>Press <kbd className="bg-white px-1.5 py-0.5 rounded border border-zinc-200 font-mono">ESC</kbd> to close</span>
              <span>{searchResults.length} results</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
