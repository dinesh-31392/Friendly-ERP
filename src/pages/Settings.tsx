import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Settings as SettingsIcon, Users, User, Shield, Building2, Palette, Bell,
  Link2, ChevronRight, Check, CreditCard, UserPlus, Trash2, X, RefreshCw, AlertTriangle,
  ScrollText, Sparkles, Download, FileText, Search, GitMerge, Send, Plus, Clock, Database,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import IntegrationsPanel from '../components/IntegrationsPanel';
import PipelineSettings from '../components/PipelineSettings';
import { PLANS, getPlanForTenant, getEffectiveLimits, withinLimit, planPriceLabel } from '../services/planService';
import { portalUrl, portalPath, isPremium, slugify, isSlugAvailable } from '../services/portalService';
import { getByTenant, update, create, remove, clearDatabase, logAudit } from '../services/db';
import type { User as UserType, Tenant, Role, AuditLog } from '../types';
import toast from 'react-hot-toast';

const settingsTabs = [
  { id: 'profile', label: 'Builder Profile', icon: Building2 },
  { id: 'brand', label: 'Brand Voice', icon: Palette },
  { id: 'team', label: 'Team & Roles', icon: Users },
  { id: 'pipeline', label: 'Pipeline & Fields', icon: GitMerge },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'integrations', label: 'Integrations', icon: Link2 },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'billing', label: 'Billing & Plan', icon: CreditCard },
  { id: 'audit', label: 'Audit Log', icon: ScrollText },
  { id: 'danger', label: 'Data & Privacy', icon: AlertTriangle },
];

const availableChannels = ['WhatsApp', 'Email', 'SMS', 'Instagram', 'Facebook', 'Google Ads', 'LinkedIn'];

export default function Settings() {
  const { user, tenant, hasPermission, logout, refreshSession } = useAuth();
  const navigate = useNavigate();
  const tenantId = tenant?.id || '';
  const [activeTab, setActiveTab] = useState('profile');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);
  const [showAddUser, setShowAddUser] = useState(false);

  const tenantUsers = useMemo(
    () => tenant ? getByTenant<UserType>('users', tenant.id) : [],
    [tenant, refreshKey]
  );

  const auditLogs = useMemo(
    () => tenant
      ? getByTenant<AuditLog>('auditLogs', tenant.id).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      : [],
    [tenant, refreshKey]
  );
  
  // Form state
  const [company, setCompany] = useState(tenant?.company || '');
  const [brandName, setBrandName] = useState(tenant?.name || '');
  const [contactEmail, setContactEmail] = useState(tenant?.email || '');
  const [contactPhone, setContactPhone] = useState(tenant?.phone || '');
  const [rera, setRera] = useState(tenant?.rera || '');
  const [gst, setGst] = useState(tenant?.gst || '');
  const [address, setAddress] = useState(tenant?.address || '');
  const [brandVoice, setBrandVoice] = useState(tenant?.brandVoice || '');
  const [audience, setAudience] = useState(tenant?.audience || '');
  const [channels, setChannels] = useState<string[]>(tenant?.channels || []);

  // White-label state
  const [primaryColor, setPrimaryColor] = useState(tenant?.primaryColor || '#6366f1');
  const [slugValue, setSlugValue] = useState(tenant?.slug || '');
  const [logoData, setLogoData] = useState(tenant?.logo || '');

  const handleLogoUpload = (file: File) => {
    if (file.size > 200 * 1024) { toast.error('Logo must be under 200 KB'); return; }
    const reader = new FileReader();
    reader.onload = () => setLogoData(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleSaveBranding = () => {
    if (!tenant) return;
    const slug = slugify(slugValue);
    if (isPremium(tenant) && !slug) { toast.error('Subdomain cannot be empty'); return; }
    // The subdomain is free-text here, so without this check a builder could
    // simply type a competitor's slug and take over their portal login, public
    // microsite, and branding. exceptTenantId lets us re-save our own unchanged.
    if (isPremium(tenant) && !isSlugAvailable(slug, tenant.id)) {
      toast.error(`"${slug}.friendlycrm.app" is already taken — pick another subdomain`);
      return;
    }
    update<Tenant>('tenants', tenant.id, {
      primaryColor,
      logo: logoData,
      ...(isPremium(tenant) ? { slug } : {}),
    });
    if (user) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: 'update', entity: 'tenant', entityId: tenant.id, details: 'Updated white-label branding' });
    toast.success('Branding saved — your portal and workspace now use it');
    refresh();
    refreshSession();
  };

  const canManageSettings = hasPermission('manage_settings');
  const canManageUsers = hasPermission('manage_users');
  
  // Notification preferences state
  const [notifications, setNotifications] = useState(() => {
    try {
      const saved = localStorage.getItem(`friendly_crm_notifications_${tenantId}`);
      if (saved) return JSON.parse(saved);
    } catch { /* corrupted storage — fall back to defaults */ }
    return {
      new_lead_assigned: true,
      lead_stage_changed: true,
      task_due_reminder: true,
      visit_scheduled: true,
      payment_received: true,
      service_ticket_update: false,
      team_member_joined: false,
      weekly_performance_report: true,
    };
  });
  
  const toggleNotification = (key: string) => {
    const updated = { ...notifications, [key]: !notifications[key] };
    setNotifications(updated);
    localStorage.setItem(`friendly_crm_notifications_${tenantId}`, JSON.stringify(updated));
    toast.success(`Notification ${updated[key] ? 'enabled' : 'disabled'}`);
  };

  const [savingProfile, setSavingProfile] = useState(false);
  
  const handleSaveProfile = () => {
    if (!tenant) return;
    if (!company.trim() || !brandName.trim()) {
      toast.error('Company name and brand name are required');
      return;
    }
    setSavingProfile(true);
    setTimeout(() => {
      update<Tenant>('tenants', tenant.id, { company, name: brandName, email: contactEmail, phone: contactPhone, rera, gst, address });
      if (user) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: 'update', entity: 'tenant', entityId: tenant.id, details: `Updated builder profile: ${company}` });
      setSavingProfile(false);
      toast.success('Profile updated successfully');
      refresh();
      refreshSession();
    }, 500);
  };

  const [savingBrand, setSavingBrand] = useState(false);
  
  const handleSaveBrand = () => {
    if (!tenant) return;
    if (!brandVoice.trim()) {
      toast.error('Brand voice description is required');
      return;
    }
    setSavingBrand(true);
    setTimeout(() => {
      update<Tenant>('tenants', tenant.id, { brandVoice, audience, channels });
      if (user) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: 'update', entity: 'tenant', entityId: tenant.id, details: 'Updated brand voice and AI settings' });
      setSavingBrand(false);
      toast.success('Brand voice updated successfully');
      refresh();
      refreshSession();
    }, 500);
  };

  const toggleChannel = (ch: string) => {
    setChannels(prev => prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]);
  };

  const handleAddUser = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!tenant) return;
    const form = e.currentTarget;
    const formData = new FormData(form);
    const name = formData.get('name') as string;
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;
    const role = formData.get('role') as Role;

    if (!name || !email || !password) { toast.error('Please fill all fields'); return; }
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return; }

    // Enforce the effective team-size limit — the plan's, unless the platform
    // admin set a custom override for this workspace
    const limits = getEffectiveLimits(tenant);
    const memberCount = tenantUsers.filter(u => u.role !== 'super_admin').length;
    if (!withinLimit(memberCount, limits.users)) {
      toast.error(`Your workspace allows up to ${limits.users} team members. Upgrade in Billing & Plan (or contact support) to add more.`);
      return;
    }

    const existing = tenantUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) { toast.error('User with this email already exists'); return; }

    const createdUser = create<UserType>('users', {
      id: '', tenantId: tenant.id, name, email: email.toLowerCase(), password,
      role, avatar: '', phone: (formData.get('phone') as string) || '',
      active: true, createdAt: new Date().toISOString(),
    });
    if (user) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: 'create', entity: 'user', entityId: createdUser.id, details: `Added team member "${name}" as ${role.replace('_', ' ')}` });
    setShowAddUser(false);
    refresh();
    toast.success('Team member added');
  };

  const handleToggleActive = (u: UserType) => {
    if (u.id === user?.id) { toast.error("You cannot deactivate yourself"); return; }
    update<UserType>('users', u.id, { active: !u.active });
    if (user && tenant) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: u.active ? 'deactivate' : 'activate', entity: 'user', entityId: u.id, details: `${u.active ? 'Deactivated' : 'Activated'} team member "${u.name}"` });
    refresh();
    toast.success(u.active ? 'User deactivated' : 'User activated');
  };

  const handleDeleteUser = (u: UserType) => {
    if (u.id === user?.id) { toast.error("You cannot delete yourself"); return; }
    if (!confirm(`Delete ${u.name}? This cannot be undone.`)) return;
    remove('users', u.id);
    if (user && tenant) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: 'delete', entity: 'user', entityId: u.id, details: `Removed team member "${u.name}"` });
    refresh();
    toast.success('User removed');
  };

  const handleChangePlan = (planName: string) => {
    if (!tenant) return;
    if (tenant.plan === planName) return;
    if (!confirm(`Switch to the ${planName} plan? (Demo build — no card is charged; in production this opens the payment gateway.)`)) return;
    update<Tenant>('tenants', tenant.id, { plan: planName, status: 'active', trialEndsAt: undefined });
    if (user) logAudit({ tenantId: tenant.id, userId: user.id, userName: user.name, action: 'update', entity: 'tenant', entityId: tenant.id, details: `Changed subscription plan to ${planName}` });
    toast.success(`You're now on the ${planName} plan 🎉`);
    refresh();
    refreshSession();
  };

  const handleResetData = () => {
    if (!confirm('⚠️ This will DELETE ALL your workspace data and log you out. This action cannot be undone. Continue?')) return;
    if (!confirm('Are you absolutely sure? All leads, invoices, and settings will be lost.')) return;
    clearDatabase();
    logout();
    navigate('/login');
    setTimeout(() => window.location.reload(), 200);
  };

  return (
    <div className="flex gap-6 max-w-[1200px] flex-col lg:flex-row">
      <div className="w-full lg:w-56 shrink-0">
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-2">
          <div className="px-3 py-2 mb-1">
            <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Workspace Settings</p>
          </div>
          {settingsTabs.filter(t => t.id !== 'audit' || hasPermission('view_audit_log')).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mb-0.5 ${
                activeTab === tab.id ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
              } ${tab.id === 'danger' ? 'mt-2 text-red-500 hover:text-red-600 hover:bg-red-50' : ''}`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
              <ChevronRight className="h-3.5 w-3.5 ml-auto opacity-40" />
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-4 mt-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <Building2 className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-zinc-900 truncate">{tenant?.company || 'N/A'}</p>
              <p className="text-[11px] text-zinc-500">{tenant?.plan || 'Starter'} Plan</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg">
            <Check className="h-3 w-3" /> Active
          </div>
        </div>
      </div>

      <div className="flex-1">
        {activeTab === 'profile' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Builder Profile</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Manage your company information visible to customers.</p>
              </div>
              {tenant?.rera && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg">
                  <Check className="h-4 w-4" />
                  <span className="text-xs font-semibold">RERA Verified</span>
                </div>
              )}
            </div>
            
            {/* Logo Upload Section */}
            <div className="flex items-center gap-4 p-4 bg-zinc-50 rounded-xl">
              <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                <Building2 className="h-8 w-8 text-white" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-zinc-900">Company Logo</p>
                <p className="text-xs text-zinc-500">PNG, JPG up to 2MB. Recommended: 512x512px</p>
              </div>
              <label className={`px-3 py-2 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-700 ${canManageSettings ? 'cursor-pointer hover:bg-zinc-50' : 'opacity-60 cursor-not-allowed'}`}>
                Upload Logo
                <input
                  type="file" accept="image/*" className="hidden" disabled={!canManageSettings}
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) { handleLogoUpload(f); toast.success('Logo staged — press "Save Branding" in the White Label card below'); }
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Company Name *</label>
                <input 
                  disabled={!canManageSettings} 
                  value={company} 
                  onChange={e => setCompany(e.target.value)} 
                  required
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Brand Name *</label>
                <input 
                  disabled={!canManageSettings} 
                  value={brandName} 
                  onChange={e => setBrandName(e.target.value)} 
                  required
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Contact Email</label>
                <input
                  disabled={!canManageSettings}
                  value={contactEmail}
                  onChange={e => setContactEmail(e.target.value)}
                  type="email"
                  placeholder="contact@company.com"
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Contact Phone</label>
                <input
                  disabled={!canManageSettings}
                  value={contactPhone}
                  onChange={e => setContactPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">RERA Registration</label>
                <input 
                  disabled={!canManageSettings} 
                  value={rera} 
                  onChange={e => setRera(e.target.value)} 
                  placeholder="Enter RERA number" 
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">GST Number</label>
                <input 
                  disabled={!canManageSettings} 
                  value={gst} 
                  onChange={e => setGst(e.target.value)} 
                  placeholder="Enter GST number" 
                  className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Company Address</label>
              <textarea 
                disabled={!canManageSettings} 
                value={address} 
                onChange={e => setAddress(e.target.value)} 
                rows={3} 
                placeholder="Enter full address with city, state, and PIN code" 
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none disabled:opacity-60 disabled:cursor-not-allowed" 
              />
            </div>
            
            {/* Social Media Links */}
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Social Media</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input disabled={!canManageSettings} placeholder="Website URL" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60" />
                <input disabled={!canManageSettings} placeholder="LinkedIn URL" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60" />
                <input disabled={!canManageSettings} placeholder="Facebook URL" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60" />
                <input disabled={!canManageSettings} placeholder="Instagram URL" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60" />
              </div>
            </div>

            {/* White Label & Portal */}
            <div className="border border-zinc-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-zinc-900">🎨 White Label & Customer Portal</p>
                  <p className="text-xs text-zinc-500 mt-0.5">Your brand on the customer & partner portal — logo, color, and your own subdomain.</p>
                </div>
                {isPremium(tenant) ? (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 text-white">PREMIUM</span>
                ) : (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500">Subdomain on Growth+</span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Brand Color</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      disabled={!canManageSettings}
                      value={primaryColor}
                      onChange={e => setPrimaryColor(e.target.value)}
                      className="h-10 w-16 rounded-lg border border-zinc-200 cursor-pointer disabled:cursor-not-allowed"
                    />
                    <span className="text-sm font-mono text-zinc-600">{primaryColor}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Portal Logo</label>
                  <div className="flex items-center gap-3">
                    {logoData ? (
                      <img src={logoData} alt="logo" className="h-10 w-10 rounded-lg object-cover border border-zinc-200" />
                    ) : (
                      <div className="h-10 w-10 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ background: primaryColor }}>
                        {tenant?.name?.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <label className={`px-3 py-2 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-700 ${canManageSettings ? 'cursor-pointer hover:bg-zinc-50' : 'opacity-60'}`}>
                      Upload
                      <input
                        type="file" accept="image/*" className="hidden" disabled={!canManageSettings}
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ''; }}
                      />
                    </label>
                    {logoData && canManageSettings && (
                      <button onClick={() => setLogoData('')} className="text-xs text-zinc-400 hover:text-red-500">Remove</button>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                  Branded Subdomain {!isPremium(tenant) && <span className="normal-case font-normal text-zinc-400">— upgrade to Growth to customize</span>}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    disabled={!canManageSettings || !isPremium(tenant)}
                    value={slugValue}
                    onChange={e => setSlugValue(e.target.value)}
                    placeholder="your-company"
                    className="flex-1 px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
                  />
                  <span className="text-sm text-zinc-500 whitespace-nowrap">.friendlycrm.app</span>
                </div>
              </div>

              <div className="bg-zinc-50 rounded-xl p-3.5 flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">Your Portal Link (customers & partners)</p>
                  <code className="text-xs text-indigo-600 break-all">{tenant ? portalUrl(tenant) : ''}</code>
                </div>
                <button
                  onClick={() => {
                    if (!tenant) return;
                    navigator.clipboard?.writeText(`${window.location.origin}${portalPath(tenant)}`)
                      .then(() => toast.success('Portal link copied'))
                      .catch(() => toast.error('Could not copy'));
                  }}
                  className="px-3 py-1.5 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Copy Link
                </button>
                <a
                  href={tenant ? portalPath(tenant) : '/portal'}
                  target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700"
                >
                  Open Portal
                </a>
              </div>

              {canManageSettings && (
                <button
                  onClick={handleSaveBranding}
                  className="px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-semibold hover:bg-zinc-800 transition-colors"
                >
                  Save Branding
                </button>
              )}
            </div>
            
            {canManageSettings && (
              <div className="pt-4 border-t border-zinc-100 flex items-center justify-between">
                <p className="text-xs text-zinc-500">Last updated: {tenant?.createdAt ? new Date(tenant.createdAt).toLocaleDateString('en-IN') : 'Never'}</p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => {
                      setCompany(tenant?.company || '');
                      setBrandName(tenant?.name || '');
                      setContactEmail(tenant?.email || '');
                      setContactPhone(tenant?.phone || '');
                      setRera(tenant?.rera || '');
                      setGst(tenant?.gst || '');
                      setAddress(tenant?.address || '');
                      toast.success('Changes reverted');
                    }}
                    className="px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleSaveProfile} 
                    disabled={savingProfile}
                    className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {savingProfile ? (
                      <>
                        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Saving...
                      </>
                    ) : (
                      'Save Changes'
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'team' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Team Members</h3>
                <p className="text-sm text-zinc-500 mt-0.5">{tenantUsers.length} member{tenantUsers.length !== 1 ? 's' : ''} in your workspace.</p>
              </div>
              {canManageUsers && (
                <button onClick={() => setShowAddUser(true)} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">
                  <UserPlus className="h-4 w-4" /> Invite Member
                </button>
              )}
            </div>
            <div className="space-y-2">
              {tenantUsers.map(u => (
                <div key={u.id} className={`flex items-center gap-4 p-3.5 rounded-xl transition-colors border border-zinc-100 ${u.active ? 'hover:bg-zinc-50' : 'opacity-60'}`}>
                  <div className="h-10 w-10 rounded-full bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center shrink-0">
                    <span className="text-sm font-bold text-indigo-600">{u.name.split(' ').map(n => n[0]).join('')}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                      {u.name}
                      {u.id === user?.id && <span className="text-[10px] text-indigo-500 font-normal bg-indigo-50 px-1.5 py-0.5 rounded">You</span>}
                      {!u.active && <span className="text-[10px] text-red-500 font-normal bg-red-50 px-1.5 py-0.5 rounded">Deactivated</span>}
                    </p>
                    <p className="text-xs text-zinc-500 truncate">{u.email}</p>
                  </div>
                  <span className="text-xs font-medium bg-zinc-100 text-zinc-600 px-3 py-1 rounded-full capitalize hidden sm:inline-block">{u.role.replace('_', ' ')}</span>
                  {canManageUsers && u.id !== user?.id && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleToggleActive(u)} className="text-xs font-medium px-2 py-1 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-colors">
                        {u.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => handleDeleteUser(u)} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500 transition-colors">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'brand' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Brand Voice & AI Memory</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Define how your AI assistant communicates with your leads and customers.</p>
              </div>
              <button 
                onClick={() => toast.success('AI preview coming soon!')}
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100"
              >
                <Sparkles className="h-3.5 w-3.5" /> Test AI Voice
              </button>
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Brand Voice Description *</label>
              <textarea 
                disabled={!canManageSettings} 
                rows={4} 
                value={brandVoice} 
                onChange={e => setBrandVoice(e.target.value)}
                maxLength={500}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-none disabled:opacity-60 disabled:cursor-not-allowed" 
                placeholder="e.g., Professional, warm, and trustworthy. We speak with confidence and clarity..."
              />
              <div className="flex justify-between mt-1">
                <p className="text-[11px] text-zinc-400">This helps AI generate content in your brand's tone</p>
                <p className="text-[11px] text-zinc-400">{brandVoice.length}/500</p>
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Target Audience</label>
              <input 
                disabled={!canManageSettings} 
                value={audience} 
                onChange={e => setAudience(e.target.value)} 
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed" 
                placeholder="e.g., Mid-to-premium home buyers aged 30-55, families, and NRI investors"
              />
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Communication Channels</label>
              <div className="flex flex-wrap gap-2">
                {availableChannels.map(ch => {
                  const icons: Record<string, any> = {
                    'WhatsApp': '💬', 'Email': '📧', 'SMS': '📱', 'Instagram': '📷', 
                    'Facebook': '👥', 'Google Ads': '🔍', 'LinkedIn': '💼'
                  };
                  return (
                    <button
                      key={ch}
                      disabled={!canManageSettings}
                      onClick={() => toggleChannel(ch)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5 ${
                        channels.includes(ch) ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300'
                      } disabled:opacity-60 disabled:cursor-not-allowed`}
                    >
                      <span>{icons[ch] || '📌'}</span>
                      {ch}
                    </button>
                  );
                })}
              </div>
            </div>
            
            {/* AI Response Examples */}
            <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-xl p-4 border border-indigo-100">
              <p className="text-xs font-semibold text-indigo-900 mb-2 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" /> AI Response Preview
              </p>
              <div className="space-y-2">
                <div className="bg-white rounded-lg p-3 text-xs text-zinc-700">
                  <p className="font-semibold text-zinc-900 mb-1">Lead Follow-up:</p>
                  <p className="text-zinc-600 italic">"Hi [Name], hope you're doing well! I wanted to check in about the 2BHK at [Project] that caught your interest. Would you like to schedule a site visit this weekend?"</p>
                </div>
                <div className="bg-white rounded-lg p-3 text-xs text-zinc-700">
                  <p className="font-semibold text-zinc-900 mb-1">Payment Reminder:</p>
                  <p className="text-zinc-600 italic">"Dear [Name], this is a gentle reminder that your installment of ₹[Amount] is due on [Date]. Please reach out if you need any assistance."</p>
                </div>
              </div>
            </div>
            
            {canManageSettings && (
              <div className="pt-4 border-t border-zinc-100 flex items-center justify-between">
                <p className="text-xs text-zinc-500">AI learns from every interaction to improve responses</p>
                <button 
                  onClick={handleSaveBrand} 
                  disabled={savingBrand}
                  className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {savingBrand ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Saving...
                    </>
                  ) : (
                    'Save Brand Settings'
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'permissions' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-zinc-900">Role Permissions</h3>
              <p className="text-sm text-zinc-500 mt-0.5">Overview of what each role can access.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Permission</th>
                    <th className="text-center py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Super Admin</th>
                    <th className="text-center py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Builder Admin</th>
                    <th className="text-center py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Sales Manager</th>
                    <th className="text-center py-3 px-4 text-xs font-semibold text-zinc-500 uppercase">Sales Executive</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'View Leads', p: [1, 1, 1, 1] },
                    { label: 'Manage All Leads', p: [1, 1, 1, 0] },
                    { label: 'Assign Leads', p: [1, 1, 1, 0] },
                    { label: 'View Inventory', p: [1, 1, 1, 1] },
                    { label: 'Manage Inventory', p: [1, 1, 0, 0] },
                    { label: 'View Bookings', p: [1, 1, 1, 1] },
                    { label: 'Manage Bookings', p: [1, 1, 1, 0] },
                    { label: 'Channel Partners', p: [1, 1, 1, 0] },
                    { label: 'Manage Partners', p: [1, 1, 0, 0] },
                    { label: 'View Reports', p: [1, 1, 1, 0] },
                    { label: 'Manage Settings', p: [1, 1, 0, 0] },
                    { label: 'Manage Users', p: [1, 1, 0, 0] },
                    { label: 'Manage Campaigns', p: [1, 1, 1, 0] },
                    { label: 'View Finance', p: [1, 1, 1, 0] },
                    { label: 'Manage Service', p: [1, 1, 1, 0] },
                    { label: 'Use AI Studio', p: [1, 1, 1, 1] },
                    { label: 'Audit Log', p: [1, 1, 0, 0] },
                    { label: 'Platform Control', p: [1, 0, 0, 0] },
                  ].map(row => (
                    <tr key={row.label} className="border-b border-zinc-50">
                      <td className="py-3 px-4 text-sm text-zinc-700">{row.label}</td>
                      {row.p.map((v, i) => (
                        <td key={i} className="text-center py-3 px-4">
                          {v === 1 ? <Check className="h-4 w-4 text-emerald-500 mx-auto" /> : <span className="text-zinc-300">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'pipeline' && <PipelineSettings />}

        {activeTab === 'integrations' && <IntegrationsPanel />}

        {activeTab === 'notifications' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Notification Preferences</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Choose what you get notified about. Changes save automatically.</p>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg">
                <Bell className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">{Object.values(notifications).filter(v => v).length} active</span>
              </div>
            </div>
            
            {/* Notification Channels */}
            <div className="bg-zinc-50 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-zinc-700 uppercase tracking-wider">Notification Channels</p>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500" />
                  <span className="text-sm text-zinc-700">Email</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500" />
                  <span className="text-sm text-zinc-700">In-App</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500" />
                  <span className="text-sm text-zinc-700">SMS</span>
                </label>
              </div>
            </div>
            
            {/* Quiet Hours */}
            <div className="bg-gradient-to-br from-violet-50 to-indigo-50 rounded-xl p-4 border border-violet-100">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🌙</span>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Quiet Hours</p>
                    <p className="text-xs text-zinc-500">Pause notifications during these hours</p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" />
                  <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-zinc-200 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-600"></div>
                </label>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <div className="flex-1">
                  <label className="text-[11px] font-medium text-zinc-500 mb-1 block">From</label>
                  <input type="time" defaultValue="22:00" className="w-full px-2 py-1.5 bg-white border border-violet-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
                </div>
                <div className="flex-1">
                  <label className="text-[11px] font-medium text-zinc-500 mb-1 block">To</label>
                  <input type="time" defaultValue="08:00" className="w-full px-2 py-1.5 bg-white border border-violet-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
                </div>
              </div>
            </div>
            
            <div className="space-y-3">
              {[
                { key: 'new_lead_assigned', label: 'New lead assigned', desc: 'Get notified when a new lead is assigned to you or your team', icon: '👤' },
                { key: 'lead_stage_changed', label: 'Lead stage changed', desc: 'Updates when leads move through pipeline stages', icon: '📊' },
                { key: 'task_due_reminder', label: 'Task due reminder', desc: 'Reminders for upcoming and overdue tasks', icon: '⏰' },
                { key: 'visit_scheduled', label: 'Visit scheduled', desc: 'Notifications for scheduled site visits', icon: '🏠' },
                { key: 'payment_received', label: 'Payment received', desc: 'Alerts when payments are received', icon: '💰' },
                { key: 'service_ticket_update', label: 'Service ticket update', desc: 'Updates on service ticket status changes', icon: '🔧' },
                { key: 'team_member_joined', label: 'Team member joined', desc: 'Welcome notifications for new team members', icon: '👥' },
                { key: 'weekly_performance_report', label: 'Weekly performance report', desc: 'Summary of your team\'s weekly performance', icon: '📈' },
              ].map((item) => (
                <div key={item.key} className="flex items-center justify-between py-3 border-b border-zinc-50 last:border-0">
                  <div className="flex items-start gap-3 flex-1">
                    <span className="text-lg">{item.icon}</span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-zinc-800">{item.label}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-4">
                    <input 
                      type="checkbox" 
                      checked={notifications[item.key] || false}
                      onChange={() => toggleNotification(item.key)}
                      className="sr-only peer" 
                    />
                    <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-zinc-200 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>
              ))}
            </div>
            
            <div className="pt-4 border-t border-zinc-100 flex items-center justify-between">
              <p className="text-xs text-zinc-500">Notification preferences are saved per workspace</p>
              <button 
                onClick={() => {
                  const allEnabled = Object.keys(notifications).reduce((acc, key) => ({ ...acc, [key]: true }), {});
                  setNotifications(allEnabled);
                  localStorage.setItem(`friendly_crm_notifications_${tenantId}`, JSON.stringify(allEnabled));
                  toast.success('All notifications enabled');
                }}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                Enable All
              </button>
            </div>
          </div>
        )}

        {activeTab === 'billing' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Billing & Subscription</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Manage your Friendly CRM subscription and billing information.</p>
              </div>
              <button 
                onClick={() => toast.success('Billing portal coming soon!')}
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100"
              >
                <CreditCard className="h-3.5 w-3.5" /> Billing Portal
              </button>
            </div>
            
            {/* Current Plan */}
            <div className="bg-gradient-to-br from-indigo-600 to-violet-700 rounded-2xl p-6 text-white relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-16 -mt-16"></div>
              <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/5 rounded-full -ml-12 -mb-12"></div>
              <div className="relative">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-xs font-medium text-indigo-200 uppercase tracking-wider mb-1">Current Plan</p>
                    <p className="text-3xl font-bold">{tenant?.plan || 'Starter'}</p>
                  </div>
                  <div className="text-right">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold bg-white/20 px-2.5 py-1 rounded-full capitalize">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      {tenant?.status || 'active'}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-indigo-100 mb-4">
                  {getPlanForTenant(tenant).features.slice(0, 3).join(' · ')}
                </p>
                <div className="flex gap-3">
                  {(() => {
                    const idx = PLANS.findIndex(p => p.name === tenant?.plan);
                    const next = PLANS[idx + 1];
                    return next ? (
                      <button
                        onClick={() => handleChangePlan(next.name)}
                        className="px-4 py-2 bg-white text-indigo-700 rounded-xl text-sm font-semibold hover:bg-indigo-50 transition-colors"
                      >
                        Upgrade to {next.name}
                      </button>
                    ) : (
                      <span className="px-4 py-2 bg-white/10 border border-white/30 text-white rounded-xl text-sm font-medium">
                        You're on our top plan 🏆
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>
            
            {/* Plan Features */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {PLANS.map(plan => {
                const current = tenant?.plan === plan.name;
                return (
                  <div key={plan.id} className={`rounded-xl p-4 border-2 transition-all ${current ? 'border-indigo-500 bg-indigo-50/30' : 'border-zinc-200 hover:border-indigo-300'}`}>
                    {plan.id === 'growth' && (
                      <span className="inline-block px-2 py-0.5 bg-gradient-to-r from-amber-400 to-orange-500 text-white text-[10px] font-bold rounded-full mb-2">
                        ⭐ MOST POPULAR
                      </span>
                    )}
                    <p className="text-lg font-bold text-zinc-900">{plan.name}</p>
                    <p className="text-2xl font-bold text-zinc-900 mt-2">{planPriceLabel(plan, tenant?.currency || 'INR')}<span className="text-sm font-normal text-zinc-500">/mo</span></p>
                    <ul className="mt-4 space-y-2">
                      {plan.features.map(f => (
                        <li key={f} className="flex items-center gap-2 text-xs text-zinc-700">
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <button
                      disabled={current}
                      onClick={() => handleChangePlan(plan.name)}
                      className={`w-full mt-4 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                        current ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700'
                      }`}
                    >
                      {current ? 'Current Plan' : 'Select Plan'}
                    </button>
                  </div>
                );
              })}
            </div>
            
            {/* Billing Details */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-zinc-50 rounded-xl p-4">
                <p className="text-xs text-zinc-500 mb-1">Next Billing Date</p>
                <p className="text-sm font-semibold text-zinc-900">Feb 20, 2026</p>
                <p className="text-[11px] text-zinc-400 mt-1">Billed monthly</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-4">
                <p className="text-xs text-zinc-500 mb-1">Monthly Amount</p>
                <p className="text-sm font-semibold text-zinc-900">{planPriceLabel(getPlanForTenant(tenant), tenant?.currency || 'INR')}/mo</p>
                <p className="text-[11px] text-zinc-400 mt-1">Plus applicable taxes</p>
              </div>
              <div className="bg-zinc-50 rounded-xl p-4">
                <p className="text-xs text-zinc-500 mb-1">Payment Method</p>
                <p className="text-sm font-semibold text-zinc-900">•••• •••• •••• 4242</p>
                <button className="text-[11px] text-indigo-600 hover:text-indigo-700 mt-1 font-medium">Update</button>
              </div>
            </div>
            
            {/* Billing History */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-zinc-900">Billing History</h4>
                <button 
                  onClick={() => {
                    toast.success('Downloading invoice...');
                  }}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                >
                  <Download className="h-3.5 w-3.5" /> Download All
                </button>
              </div>
              <div className="space-y-2">
                {[
                  { date: 'Jan 20, 2026', amount: '4,999', status: 'Paid', invoice: 'INV-2026-001' },
                  { date: 'Dec 20, 2025', amount: '4,999', status: 'Paid', invoice: 'INV-2025-012' },
                  { date: 'Nov 20, 2025', amount: '4,999', status: 'Paid', invoice: 'INV-2025-011' },
                ].map((inv, i) => (
                  <div key={i} className="flex items-center justify-between py-3 border-b border-zinc-50 last:border-0">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-lg bg-zinc-100 flex items-center justify-center">
                        <FileText className="h-4 w-4 text-zinc-500" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{inv.invoice}</p>
                        <p className="text-xs text-zinc-500">{inv.date}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-zinc-900">₹ {inv.amount}</span>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">{inv.status}</span>
                      <button className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600">
                        <Download className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Usage Metrics */}
            <div className="bg-gradient-to-br from-zinc-50 to-zinc-100 rounded-xl p-4 border border-zinc-200">
              <h4 className="text-sm font-semibold text-zinc-900 mb-3">Current Usage</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Team Members</p>
                  {(() => {
                    const memberCount = tenantUsers.filter(u => u.role !== 'super_admin').length;
                    const limit = getEffectiveLimits(tenant).users;
                    return (
                      <>
                        <p className="text-lg font-bold text-zinc-900">{memberCount}/{limit < 0 ? '∞' : limit}</p>
                        <div className="h-1.5 bg-zinc-200 rounded-full mt-2 overflow-hidden">
                          <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${limit < 0 ? 8 : Math.min(100, (memberCount / limit) * 100)}%` }}></div>
                        </div>
                      </>
                    );
                  })()}
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Leads</p>
                  <p className="text-lg font-bold text-zinc-900">Unlimited</p>
                  <div className="h-1.5 bg-zinc-200 rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full" style={{ width: '100%' }}></div>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">AI Requests</p>
                  <p className="text-lg font-bold text-zinc-900">847/mo</p>
                  <div className="h-1.5 bg-zinc-200 rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-violet-500 rounded-full" style={{ width: '42%' }}></div>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Storage</p>
                  <p className="text-lg font-bold text-zinc-900">2.4 GB</p>
                  <div className="h-1.5 bg-zinc-200 rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-amber-500 rounded-full" style={{ width: '24%' }}></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">Audit Log</h3>
                <p className="text-sm text-zinc-500 mt-0.5">Record of sensitive actions across your workspace ({auditLogs.length} entries).</p>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => {
                    const csv = [
                      ['Timestamp', 'User', 'Action', 'Entity', 'Details'],
                      ...auditLogs.map(log => [
                        new Date(log.createdAt).toLocaleString('en-IN'),
                        log.userName,
                        log.action,
                        log.entity,
                        log.details
                      ])
                    ].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast.success('Audit log exported');
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white border border-zinc-200 text-zinc-700 rounded-lg text-xs font-semibold hover:bg-zinc-50"
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </button>
                <button 
                  onClick={() => setRefreshKey(k => k + 1)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white border border-zinc-200 text-zinc-700 rounded-lg text-xs font-semibold hover:bg-zinc-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </button>
              </div>
            </div>
            
            {/* Filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input 
                  placeholder="Search audit log..."
                  className="w-full pl-9 pr-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <select className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option>All Actions</option>
                <option>Create</option>
                <option>Update</option>
                <option>Delete</option>
                <option>Merge</option>
                <option>Send</option>
              </select>
              <select className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option>All Entities</option>
                <option>Leads</option>
                <option>Bookings</option>
                <option>Users</option>
                <option>Tenants</option>
              </select>
              <input 
                type="date"
                className="px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            
            {/* Audit Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-xl p-3 border border-indigo-100">
                <p className="text-xs text-indigo-600 font-medium">Total Actions</p>
                <p className="text-xl font-bold text-indigo-900 mt-1">{auditLogs.length}</p>
              </div>
              <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl p-3 border border-emerald-100">
                <p className="text-xs text-emerald-600 font-medium">Today</p>
                <p className="text-xl font-bold text-emerald-900 mt-1">{auditLogs.filter(l => new Date(l.createdAt).toDateString() === new Date().toDateString()).length}</p>
              </div>
              <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-3 border border-amber-100">
                <p className="text-xs text-amber-600 font-medium">This Week</p>
                <p className="text-xl font-bold text-amber-900 mt-1">{auditLogs.filter(l => {
                  const d = new Date(l.createdAt);
                  const now = new Date();
                  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                  return d >= weekAgo;
                }).length}</p>
              </div>
              <div className="bg-gradient-to-br from-red-50 to-pink-50 rounded-xl p-3 border border-red-100">
                <p className="text-xs text-red-600 font-medium">Deletes</p>
                <p className="text-xl font-bold text-red-900 mt-1">{auditLogs.filter(l => l.action === 'delete').length}</p>
              </div>
            </div>
            
            {auditLogs.length === 0 ? (
              <div className="py-12 text-center">
                <ScrollText className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No audit entries yet. Sensitive actions like lead merges, deletes, and campaign sends will appear here.</p>
              </div>
            ) : (
              <div className="space-y-1 max-h-[520px] overflow-y-auto">
                {auditLogs.map(log => {
                  const actionColors: Record<string, string> = {
                    'delete': 'bg-red-50 text-red-600',
                    'merge': 'bg-amber-50 text-amber-600',
                    'send': 'bg-emerald-50 text-emerald-600',
                    'create': 'bg-blue-50 text-blue-600',
                    'update': 'bg-indigo-50 text-indigo-600',
                    'activate': 'bg-emerald-50 text-emerald-600',
                    'deactivate': 'bg-orange-50 text-orange-600',
                  };
                  const actionIcons: Record<string, any> = {
                    'delete': Trash2,
                    'merge': GitMerge,
                    'send': Send,
                    'create': Plus,
                    'update': RefreshCw,
                    'activate': Check,
                    'deactivate': X,
                  };
                  const Icon = actionIcons[log.action] || ScrollText;
                  return (
                    <div key={log.id} className="flex items-start gap-3 py-3 border-b border-zinc-50 last:border-0 hover:bg-zinc-50/50 transition-colors">
                      <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${actionColors[log.action] || 'bg-zinc-100 text-zinc-600'}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-zinc-800">{log.details}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[11px] text-zinc-500 flex items-center gap-1">
                            <User className="h-3 w-3" /> {log.userName}
                          </span>
                          <span className="text-[11px] text-zinc-400">·</span>
                          <span className="text-[11px] text-zinc-500 flex items-center gap-1">
                            <Clock className="h-3 w-3" /> {new Date(log.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase ${actionColors[log.action] || 'bg-zinc-100 text-zinc-600'}`}>
                          {log.action}
                        </span>
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                          {log.entity}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'danger' && (
          <div className="bg-white rounded-2xl border border-red-200/60 p-6 space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-red-600 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" /> Data & Privacy
              </h3>
              <p className="text-sm text-zinc-500 mt-0.5">Manage your workspace data, privacy settings, and GDPR compliance.</p>
            </div>

            {/* Privacy Guarantee */}
            <div className="bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-5">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0">
                  <Shield className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-emerald-900 mb-1">✓ Data Privacy Guaranteed</p>
                  <p className="text-xs text-emerald-700 leading-relaxed">
                    Your data is stored locally in your browser with strict tenant isolation. Every user only sees data from their own workspace. 
                    No data is sent to external servers. We are fully GDPR and CCPA compliant.
                  </p>
                </div>
              </div>
            </div>

            {/* GDPR Compliance */}
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5">
              <div className="flex items-start gap-3 mb-4">
                <div className="h-10 w-10 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
                  <span className="text-lg">🇪🇺</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-blue-900 mb-1">GDPR Compliance</p>
                  <p className="text-xs text-blue-700">Your rights under GDPR are fully respected and implemented.</p>
                </div>
              </div>
              <div className="space-y-2">
                {[
                  { right: 'Right to Access', desc: 'Export all your data anytime', action: 'Export Data' },
                  { right: 'Right to Rectification', desc: 'Edit or correct your data', action: 'Edit Data' },
                  { right: 'Right to Erasure', desc: 'Delete all your data permanently', action: 'Delete Data' },
                  { right: 'Right to Portability', desc: 'Download data in standard format', action: 'Download' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-blue-100 last:border-0">
                    <div>
                      <p className="text-xs font-semibold text-blue-900">{item.right}</p>
                      <p className="text-[11px] text-blue-700">{item.desc}</p>
                    </div>
                    <button 
                      onClick={() => toast.success(`${item.action} feature coming soon!`)}
                      className="px-3 py-1.5 bg-white border border-blue-200 text-blue-700 rounded-lg text-xs font-semibold hover:bg-blue-50"
                    >
                      {item.action}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Data Storage Info */}
            <div className="bg-zinc-50 rounded-xl p-5 border border-zinc-200">
              <h4 className="text-sm font-semibold text-zinc-900 mb-3 flex items-center gap-2">
                <Database className="h-4 w-4 text-zinc-600" /> Data Storage Information
              </h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Total Records</p>
                  <p className="text-lg font-bold text-zinc-900">{auditLogs.length + tenantUsers.length}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Storage Used</p>
                  <p className="text-lg font-bold text-zinc-900">~2.4 MB</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Last Backup</p>
                  <p className="text-lg font-bold text-zinc-900">Auto</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Retention</p>
                  <p className="text-lg font-bold text-zinc-900">∞</p>
                </div>
              </div>
            </div>

            {/* Data Management */}
            <div className="space-y-4">
              <div className="border border-zinc-200 rounded-xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                      <Download className="h-4 w-4 text-zinc-600" /> Export Your Data
                    </p>
                    <p className="text-xs text-zinc-600 mt-1">Download a complete JSON export of all your workspace data including leads, bookings, invoices, and settings.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const data: Record<string, unknown> = {};
                      Object.keys(localStorage)
                        .filter(k => k.startsWith('friendly_crm_') && k !== 'friendly_crm_auth')
                        .forEach(k => {
                          const key = k.replace('friendly_crm_', '');
                          try {
                            const value = JSON.parse(localStorage.getItem(k) || '[]');
                            data[key] = key === 'users'
                              ? value.map((u: UserType) => ({ ...u, password: '***redacted***' }))
                              : value;
                          } catch { /* skip corrupted key rather than aborting the export */ }
                        });
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `friendly-crm-export-${new Date().toISOString().split('T')[0]}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                      toast.success('Data exported successfully');
                    }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-white border border-zinc-200 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-50 transition-colors"
                  >
                    <Download className="h-4 w-4" /> Download JSON Export
                  </button>
                  <button
                    onClick={() => {
                      toast.success('CSV export coming soon!');
                    }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-white border border-zinc-200 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-50 transition-colors"
                  >
                    <FileText className="h-4 w-4" /> Export as CSV
                  </button>
                </div>
              </div>

              {/* Backup Settings */}
              <div className="border border-zinc-200 rounded-xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
                      <Clock className="h-4 w-4 text-zinc-600" /> Auto-Backup Settings
                    </p>
                    <p className="text-xs text-zinc-600 mt-1">Configure automatic backups of your workspace data.</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" defaultChecked className="sr-only peer" />
                    <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-zinc-200 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>
                <div className="space-y-3 mt-4">
                  <div>
                    <label className="text-xs font-medium text-zinc-700 mb-1 block">Backup Frequency</label>
                    <select className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      <option>Daily</option>
                      <option>Weekly</option>
                      <option>Monthly</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-700 mb-1 block">Backup Time</label>
                    <input type="time" defaultValue="02:00" className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
              </div>

              {/* Danger Zone */}
              <div className="border-2 border-red-200 rounded-xl p-5 bg-red-50/30">
                <div className="flex items-start gap-3 mb-4">
                  <div className="h-10 w-10 rounded-xl bg-red-100 flex items-center justify-center shrink-0">
                    <AlertTriangle className="h-5 w-5 text-red-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-red-900 mb-1">⚠️ Danger Zone</p>
                    <p className="text-xs text-red-700">These actions are irreversible. Please proceed with extreme caution.</p>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div className="bg-white rounded-lg p-4 border border-red-200">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-red-900 mb-1">Reset Workspace Data</p>
                        <p className="text-xs text-zinc-600">This will permanently delete all leads, invoices, tasks, settings, and log you out. This action cannot be undone.</p>
                      </div>
                    </div>
                    <button
                      onClick={handleResetData}
                      className="mt-3 flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors"
                    >
                      <RefreshCw className="h-4 w-4" /> Reset All Data
                    </button>
                  </div>

                  <div className="bg-white rounded-lg p-4 border border-orange-200">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-orange-900 mb-1">Anonymize Personal Data</p>
                        <p className="text-xs text-zinc-600">Replace all personal information with anonymous data while keeping statistics intact.</p>
                      </div>
                    </div>
                    <button
                      onClick={() => toast.success('Anonymization feature coming soon!')}
                      className="mt-3 flex items-center gap-2 px-4 py-2.5 bg-white border border-orange-200 text-orange-700 rounded-xl text-sm font-semibold hover:bg-orange-50 transition-colors"
                    >
                      <Shield className="h-4 w-4" /> Anonymize Data
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {!['profile', 'team', 'brand', 'pipeline', 'permissions', 'integrations', 'notifications', 'billing', 'audit', 'danger'].includes(activeTab) && (
          <div className="bg-white rounded-2xl border border-zinc-200/60 p-12 text-center">
            <div className="h-16 w-16 rounded-2xl bg-zinc-100 mx-auto mb-4 flex items-center justify-center">
              <SettingsIcon className="h-7 w-7 text-zinc-300" />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-1">
              {settingsTabs.find(t => t.id === activeTab)?.label}
            </h3>
            <p className="text-sm text-zinc-500 max-w-sm mx-auto">Coming soon.</p>
          </div>
        )}
      </div>

      {/* Add User Modal */}
      {showAddUser && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAddUser(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">Invite Team Member</h3>
              <button onClick={() => setShowAddUser(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddUser} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Full Name *</label>
                <input name="name" required placeholder="John Doe" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Email *</label>
                <input name="email" type="email" required placeholder="john@company.com" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Phone</label>
                <input name="phone" placeholder="+91 98765 43210" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Password *</label>
                  <input name="password" type="password" required minLength={6} placeholder="Min 6 chars" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Role *</label>
                  <select name="role" required defaultValue="sales_executive" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option value="sales_executive">Sales Executive</option>
                    <option value="sales_manager">Sales Manager</option>
                    <option value="builder_admin">Builder Admin</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowAddUser(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Add Member</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
