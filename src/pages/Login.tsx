import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Building2, Mail, Lock, User, Phone, ArrowRight, Eye, EyeOff, Shield, Globe, Home, KeyRound, CheckCircle2, X, Clock, AlertCircle, Hash } from 'lucide-react';
import { COUNTRIES } from '../utils/format';
import { getRecentAccounts, forgetRecentAccount, type RecentAccount } from '../services/authService';
import InstallAppButton from '../components/InstallAppButton';
import toast from 'react-hot-toast';

type LoginTab = 'platform' | 'builder' | 'portal';

/**
 * The sign-in role picker.
 *
 * This chooses a DESTINATION, not an identity. The server derives the real role
 * from the database on every request, so a selection here cannot grant anything
 * — and must not withhold anything either: someone who picks "Sales Manager"
 * but is actually an accountant still signs in, because their password was
 * right and the server is what decides. Gating on this would refuse correct
 * credentials while adding no security at all, since anyone can pick any entry.
 *
 * What it genuinely decides is which of the three auth paths to use and which
 * fields to show. That was previously exposed as Platform / Builder / Portal —
 * accurate, but named after how the system is built rather than after what the
 * person signing in calls themselves.
 */
interface RoleOption {
  id: string;
  label: string;
  realm: LoginTab;
  hint: string;
}

const ROLE_GROUPS: { group: string; options: RoleOption[] }[] = [
  {
    group: 'Platform team',
    options: [
      { id: 'super_admin', label: 'Super Admin', realm: 'platform', hint: 'Full control of every workspace on the platform.' },
      { id: 'tech_team', label: 'Branch Team', realm: 'platform', hint: 'Onboard and support builders in your branch.' },
    ],
  },
  {
    group: 'Your workspace',
    options: [
      { id: 'builder_admin', label: 'Builder Admin', realm: 'builder', hint: 'Own the whole workspace — sales, finance, sites and people.' },
      { id: 'sales_manager', label: 'Sales Manager', realm: 'builder', hint: 'Run the pipeline, approve discounts, close bookings.' },
      { id: 'sales_executive', label: 'Sales Executive', realm: 'builder', hint: 'Work your leads, book site visits, raise quotations.' },
      { id: 'accountant', label: 'Accountant', realm: 'builder', hint: 'Post to the ledger, raise demands, reconcile collections.' },
      { id: 'site_engineer', label: 'Site Engineer', realm: 'builder', hint: 'Log progress, raise RFIs, issue stock, sign off RA bills.' },
      { id: 'auditor', label: 'Auditor', realm: 'builder', hint: 'Read every module. Change nothing.' },
    ],
  },
  {
    group: 'Customers & partners',
    options: [
      { id: 'customer', label: 'Customer', realm: 'portal', hint: 'Track your booking, payments and documents.' },
      { id: 'partner', label: 'Channel Partner', realm: 'portal', hint: 'Track your referrals and commission statements.' },
    ],
  },
];

const ALL_ROLE_OPTIONS = ROLE_GROUPS.flatMap(g => g.options);

export default function Login() {
  const { login, verifyLoginCode, register, resetPassword } = useAuth();
  const [tab, setTab] = useState<LoginTab>('builder');
  // Defaults to Sales Executive: the role that signs in most often, by a wide margin.
  const [roleId, setRoleId] = useState('sales_executive');
  const [isRegistering, setIsRegistering] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Banner shown after a self-serve signup that is now awaiting approval
  const [pendingNotice, setPendingNotice] = useState(false);
  // Persistent inline error (in addition to the toast) — accessible via role="alert"
  const [loginError, setLoginError] = useState('');

  // Second factor: set once the password is accepted but a code is required.
  const [mfa, setMfa] = useState<{ challengeId: string; sentTo: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // Login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Optional workspace code (tenant slug) — spec §4 company-code entry
  const [workspaceCode, setWorkspaceCode] = useState('');

  // Account chooser (spec §4): accounts previously signed in on this device.
  const [recentAccounts, setRecentAccounts] = useState<RecentAccount[]>(getRecentAccounts());
  const [accountPicked, setAccountPicked] = useState(false);
  const [useAnother, setUseAnother] = useState(false);

  const isPlatformAccount = (a: RecentAccount) => a.role === 'super_admin' || a.role === 'tech_team';
  const tabAccounts = recentAccounts.filter(a => tab === 'platform' ? isPlatformAccount(a) : !isPlatformAccount(a));

  const pickAccount = (a: RecentAccount) => {
    setEmail(a.email);
    setWorkspaceCode(a.workspaceCode || '');
    setAccountPicked(true);
    setLoginError('');
  };

  const forgetAccount = (a: RecentAccount) => {
    forgetRecentAccount(a.userId);
    setRecentAccounts(getRecentAccounts());
  };

  const startFresh = () => {
    setUseAnother(true);
    setEmail(''); setPassword(''); setWorkspaceCode('');
    setLoginError('');
  };

  const backToChooser = () => {
    setUseAnother(false); setAccountPicked(false);
    setEmail(''); setPassword(''); setWorkspaceCode('');
    setLoginError('');
  };

  // Register fields
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regCompany, setRegCompany] = useState('');
  const [regCountry, setRegCountry] = useState('India');

  // Forgot-password modal
  const [showForgot, setShowForgot] = useState(false);
  const [fpEmail, setFpEmail] = useState('');
  const [fpNew, setFpNew] = useState('');
  const [fpConfirm, setFpConfirm] = useState('');
  const [fpShow, setFpShow] = useState(false);
  const [fpLoading, setFpLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    if (!email || !password) {
      setLoginError('Please enter your email and password.');
      toast.error('Please enter email and password');
      return;
    }
    setLoading(true);
    const result = await login(email, password, tab === 'builder' ? workspaceCode : undefined);
    setLoading(false);
    // Not a failure: the password was right and a code is on its way.
    if (result.mfa) { setMfa(result.mfa); setMfaCode(''); return; }
    if (!result.success) {
      setLoginError(result.error || 'Login failed. Please try again.');
      toast.error(result.error || 'Login failed');
    } else {
      toast.success('Welcome back!');
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfa || mfaCode.length !== 6) { setLoginError('Enter the 6-digit code from your email.'); return; }
    setLoginError('');
    setLoading(true);
    const result = await verifyLoginCode(mfa.challengeId, mfaCode);
    setLoading(false);
    if (!result.success) {
      setLoginError(result.error || 'That code is not valid.');
      setMfaCode('');
      return;
    }
    toast.success('Welcome back!');
  };

  /** Back to the password form. The challenge is abandoned, not reused. */
  const cancelMfa = () => { setMfa(null); setMfaCode(''); setPassword(''); setLoginError(''); };

  const switchTab = (t: LoginTab) => {
    setTab(t); setIsRegistering(false); setLoginError(''); setShowPassword(false);
    setAccountPicked(false); setUseAnother(false);
  };

  const selectedRole = ALL_ROLE_OPTIONS.find(r => r.id === roleId) ?? ALL_ROLE_OPTIONS[2];

  const pickRole = (id: string) => {
    const next = ALL_ROLE_OPTIONS.find(r => r.id === id);
    if (!next) return;
    setRoleId(id);
    // Only reset the form when the REALM changes. Switching between two roles
    // that sign in the same way — Sales Manager to Accountant, say — should not
    // wipe an email somebody has already typed.
    if (next.realm !== tab) switchTab(next.realm);
  };

  const toggleRegister = () => {
    setIsRegistering(v => !v); setLoginError(''); setPendingNotice(false); setShowPassword(false);
  };

  const emailValid = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regName || !regEmail || !regPassword || !regCompany) {
      toast.error('Please fill all required fields');
      return;
    }
    if (!emailValid(regEmail)) {
      toast.error('Please enter a valid email address');
      return;
    }
    if (regPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    const currency = COUNTRIES.find(c => c.name === regCountry)?.currency || 'USD';
    const result = await register(regName, regEmail, regPassword, regPhone, regCompany, regCountry, currency);
    setLoading(false);
    if (!result.success) {
      toast.error(result.error || 'Registration failed');
    } else if (result.pending) {
      // Approval-gated signup: account created but cannot sign in until a super
      // admin activates it. Drop back to the sign-in view with a clear notice.
      toast.success('Account created — pending admin approval');
      setEmail(regEmail);
      setPassword('');
      setPendingNotice(true);
      setIsRegistering(false);
      setRegName(''); setRegPassword(''); setRegPhone(''); setRegCompany('');
    } else {
      toast.success('Workspace created — your 14-day free trial has started!');
    }
  };

  const openForgot = () => {
    setFpEmail(!isRegistering ? email : regEmail);
    setFpNew(''); setFpConfirm(''); setFpShow(false);
    setShowForgot(true);
  };

  const handleForgot = (e: React.FormEvent) => {
    e.preventDefault();
    if (!fpEmail || !fpNew || !fpConfirm) { toast.error('Please fill in all fields'); return; }
    if (!emailValid(fpEmail)) { toast.error('Please enter a valid email address'); return; }
    if (fpNew.length < 6) { toast.error('New password must be at least 6 characters'); return; }
    if (fpNew !== fpConfirm) { toast.error('Passwords do not match'); return; }
    setFpLoading(true);
    const result = resetPassword(fpEmail, fpNew);
    setFpLoading(false);
    if (!result.success) { toast.error(result.error || 'Could not reset password'); return; }
    toast.success('Password updated — you can now sign in');
    setEmail(fpEmail);
    setPassword('');
    setShowForgot(false);
    setFpEmail(''); setFpNew(''); setFpConfirm('');
  };

  return (
    <div className="min-h-screen flex bg-zinc-50">
      {/* Left: Brand Panel */}
      <div className="hidden lg:flex lg:w-[520px] bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 relative overflow-hidden flex-col justify-between p-10">
        {/* Background pattern */}
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-0 left-0 w-96 h-96 bg-white rounded-full -translate-x-1/2 -translate-y-1/2" />
          <div className="absolute bottom-0 right-0 w-[30rem] h-[30rem] bg-white rounded-full translate-x-1/3 translate-y-1/3" />
          <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-white rounded-full -translate-x-1/2 -translate-y-1/2" />
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-12">
            <div className="h-11 w-11 rounded-2xl bg-white/20 backdrop-blur flex items-center justify-center">
              <Building2 className="h-6 w-6 text-white" />
            </div>
            <div>
              <p className="text-lg font-bold text-white tracking-tight">Friendly ERP</p>
              <p className="text-sm text-indigo-200">Real Estate & Construction ERP</p>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <h1 className="text-3xl font-bold text-white leading-tight mb-3">
                {isRegistering ? 'Start your journey' : 'Welcome back'}
              </h1>
              <p className="text-indigo-200 text-base leading-relaxed">
                {isRegistering
                  ? 'Create your builder account and start managing leads, inventory, and sales in one place.'
                  : 'Sign in to your workspace to manage leads, inventory, and close more deals.'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Lead Management', desc: 'Kanban boards & follow-ups' },
                { label: 'Inventory Matrix', desc: 'Visual stacking plans' },
                { label: 'AI Studio', desc: 'Brand-aware content gen' },
                { label: 'Analytics', desc: 'Real-time dashboards' },
              ].map(f => (
                <div key={f.label} className="bg-white/10 backdrop-blur rounded-xl p-3">
                  <p className="text-sm font-semibold text-white">{f.label}</p>
                  <p className="text-xs text-indigo-200 mt-0.5">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 text-indigo-200/70 text-xs">
            <Shield className="h-4 w-4" />
            <span>End-to-end encrypted · SOC 2 compliant · GDPR ready</span>
          </div>
        </div>
      </div>

      {/* Right: Form */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-10 justify-center">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <Building2 className="h-5 w-5 text-white" />
            </div>
            <p className="text-lg font-bold text-zinc-900">Friendly ERP</p>
          </div>

          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 sm:p-8 shadow-sm">
            <>
            {/* ── Second factor ──────────────────────────────────────────
                Shown once the password is accepted for an account that needs a
                code. It REPLACES the sign-in form rather than sitting beside it:
                leaving the password fields on screen invites a re-submit, which
                issues a second code and invalidates the one already sent. */}
            {mfa ? (
              <div>
                <div className="h-11 w-11 rounded-2xl bg-indigo-50 flex items-center justify-center mb-4">
                  <Shield className="h-5 w-5 text-indigo-500" />
                </div>
                <h2 className="text-xl font-bold text-zinc-900">Check your email</h2>
                <p className="text-sm text-zinc-500 mt-1 mb-5">
                  We sent a 6-digit code to <span className="font-medium text-zinc-700">{mfa.sentTo}</span>.
                  It expires in 10 minutes.
                </p>
                <form onSubmit={handleVerifyCode} className="space-y-4">
                  <div>
                    <label htmlFor="mfa-code" className="block text-sm font-medium text-zinc-700 mb-1.5">Sign-in code</label>
                    <input
                      id="mfa-code"
                      value={mfaCode}
                      onChange={e => setMfaCode(e.target.value.replace(/D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      placeholder="000000"
                      className="w-full px-4 py-3 rounded-xl border border-zinc-200 text-center text-2xl font-mono tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  {loginError && (
                    <p role="alert" className="text-sm text-red-600 flex items-center gap-1.5">
                      <AlertCircle className="h-4 w-4 shrink-0" /> {loginError}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={loading || mfaCode.length !== 6}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50"
                  >
                    {loading ? <span className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <>Verify and sign in <ArrowRight className="h-4 w-4" /></>}
                  </button>
                  <button type="button" onClick={cancelMfa} className="w-full text-xs font-medium text-zinc-500 hover:text-zinc-700">
                    Use a different account
                  </button>
                </form>
                <p className="text-[11px] text-zinc-400 mt-5 text-center">
                  Didn't get it? Check spam, then sign in again to send a new code — that cancels this one.
                </p>
              </div>
            ) : (
            <>
            {/* Who is signing in. Chooses the destination, never the identity —
                see ROLE_GROUPS. Sits above every other field because it decides
                which of them appear. */}
            {!isRegistering && (
              <div className="mb-6">
                <label htmlFor="role-select" className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                  I'm signing in as
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md bg-indigo-50">
                    {selectedRole.realm === 'platform'
                      ? <Globe className="h-3.5 w-3.5 text-indigo-600" />
                      : selectedRole.realm === 'portal'
                        ? <Home className="h-3.5 w-3.5 text-indigo-600" />
                        : <Building2 className="h-3.5 w-3.5 text-indigo-600" />}
                  </span>
                  <select
                    id="role-select"
                    value={roleId}
                    onChange={e => pickRole(e.target.value)}
                    className="w-full appearance-none pl-12 pr-10 py-3 bg-white border border-zinc-200 rounded-xl text-sm font-semibold text-zinc-800 shadow-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 hover:border-zinc-300 transition-all"
                  >
                    {ROLE_GROUPS.map(g => (
                      <optgroup key={g.group} label={g.group}>
                        {g.options.map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400"
                    viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M6 8l4 4 4-4" />
                  </svg>
                </div>
                <p className="text-[11px] text-zinc-400 mt-1.5 leading-relaxed">{selectedRole.hint}</p>
              </div>
            )}

            {tab === 'portal' ? (
              /* Customer / Channel Partner — separate auth system */
              <div className="text-center py-6">
                <div className="h-12 w-12 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
                  <Home className="h-6 w-6 text-indigo-500" />
                </div>
                <h2 className="text-lg font-bold text-zinc-900">Customer & Partner Portal</h2>
                <p className="text-sm text-zinc-500 mt-1 mb-5">
                  Home buyers and channel partners sign in to their own portal to track bookings, payments, documents, and commissions.
                </p>
                <Link to="/portal" className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
                  Open the Portal <ArrowRight className="h-4 w-4" />
                </Link>
                <p className="text-[11px] text-zinc-400 mt-3">Access is provided by your builder — contact your sales advisor for credentials.</p>
              </div>
            ) : (
            <>
            <div className="mb-6">
              <h2 className="text-xl font-bold text-zinc-900">
                {isRegistering ? 'Create your workspace' : 'Sign in'}
              </h2>
              <p className="text-sm text-zinc-500 mt-1">
                {isRegistering
                  ? 'Set up your builder workspace in minutes — approved by our team before going live.'
                  : tab === 'platform'
                    ? 'Platform team — no workspace code needed.'
                    : 'Use your workspace code if your company gave you one.'}
              </p>
            </div>

            {!isRegistering && pendingNotice && (
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3">
                <Clock className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-amber-800">Account created — pending approval</p>
                  <p className="text-[11px] text-amber-700 mt-0.5">Your workspace is awaiting super-admin activation. You'll be able to sign in here as soon as it's approved.</p>
                </div>
              </div>
            )}

            {isRegistering && (
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
                <Shield className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-indigo-700">New workspaces are reviewed by our team before activation. You'll get access to sign in once a super admin approves your account.</p>
              </div>
            )}

            {!isRegistering && tabAccounts.length > 0 && !accountPicked && !useAnother ? (
              /* ── Account chooser: accounts that previously signed in on this
                 device. Picking one prefills email + workspace; the password is
                 always asked for — this is a convenience, not an auth bypass. */
              <div>
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Choose an account</p>
                <div className="space-y-2 mb-4">
                  {tabAccounts.map(a => (
                    <div key={a.userId} className="group flex items-center gap-3 w-full rounded-xl border border-zinc-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors">
                      <button type="button" onClick={() => pickAccount(a)} className="flex items-center gap-3 flex-1 min-w-0 p-3 text-left">
                        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                          {a.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-zinc-900 truncate">{a.name}</p>
                          <p className="text-[11px] text-zinc-500 truncate">{a.email} · {a.tenantName}</p>
                        </div>
                        <ArrowRight className="h-4 w-4 text-zinc-300 group-hover:text-indigo-500 shrink-0" />
                      </button>
                      <button
                        type="button"
                        onClick={() => forgetAccount(a)}
                        aria-label={`Remove ${a.email} from this device`}
                        className="p-2 mr-1 rounded-lg text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={startFresh}
                  className="w-full flex items-center justify-center gap-2 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
                >
                  <User className="h-4 w-4" /> Use another account
                </button>
              </div>
            ) : (
            <>
            <form onSubmit={isRegistering ? handleRegister : handleLogin} className="space-y-4">
              {isRegistering && (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Full Name</label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input
                        value={regName} onChange={e => setRegName(e.target.value)}
                        placeholder="John Doe"
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Company Name</label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input
                        value={regCompany} onChange={e => setRegCompany(e.target.value)}
                        placeholder="Your Realty Pvt Ltd"
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Phone</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input
                        value={regPhone} onChange={e => setRegPhone(e.target.value)}
                        placeholder="+91 98765 43210"
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Country</label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <select
                        value={regCountry} onChange={e => setRegCountry(e.target.value)}
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                      >
                        {COUNTRIES.map(c => <option key={c.name} value={c.name}>{c.name} ({c.currency})</option>)}
                      </select>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">Sets your workspace currency. 14-day free trial, no card required.</p>
                  </div>
                </>
              )}

              {/* Workspace code (spec §4 company-code entry) — optional in the
                  demo store where emails are unique; REQUIRED by the API when
                  one email exists in several workspaces. */}
              {!isRegistering && tab === 'builder' && (
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                    Workspace Code <span className="normal-case font-normal text-zinc-400">(optional)</span>
                  </label>
                  <div className="relative">
                    <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                    <input
                      value={workspaceCode}
                      onChange={e => setWorkspaceCode(e.target.value)}
                      placeholder="skyline-constructions"
                      autoCapitalize="none" autoCorrect="off" spellCheck={false}
                      className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400 mt-1">Your company's code — in Settings → Branding, or in your invite.</p>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    type="email"
                    value={isRegistering ? regEmail : email}
                    onChange={e => isRegistering ? setRegEmail(e.target.value) : setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={isRegistering ? regPassword : password}
                    onChange={e => isRegistering ? setRegPassword(e.target.value) : setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-10 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all"
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {!isRegistering && (
                <div className="flex justify-end">
                  <button type="button" onClick={openForgot} className="text-xs font-medium text-indigo-600 hover:text-indigo-700">Forgot password?</button>
                </div>
              )}

              {!isRegistering && loginError && (
                <div role="alert" aria-live="assertive" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
                  <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-600">{loginError}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    {isRegistering ? 'Create Account' : 'Sign In'}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>

            {!isRegistering && tabAccounts.length > 0 && (
              <button
                type="button"
                onClick={backToChooser}
                className="w-full mt-3 text-xs font-medium text-indigo-600 hover:text-indigo-700 text-center"
              >
                ← Choose a saved account
              </button>
            )}
            </>
            )}

            {/* Self-signup is a builder action only */}
            {tab === 'builder' && (
              <div className="mt-6 pt-5 border-t border-zinc-100 text-center">
                <p className="text-sm text-zinc-500">
                  {isRegistering ? 'Already have an account?' : "Don't have an account?"}{' '}
                  <button
                    onClick={toggleRegister}
                    className="font-semibold text-indigo-600 hover:text-indigo-700 transition-colors"
                  >
                    {isRegistering ? 'Sign in' : 'Create one'}
                  </button>
                </p>
              </div>
            )}
            </>
            )}
            </>
            )}
            </>
          </div>


          {/* Always offered here: the login page is where people discover the
              app is installable at all, so it must not hide itself in browsers
              that never fire a native install prompt. */}
          <div className="flex justify-center mt-5">
            <InstallAppButton alwaysShow />
          </div>

          <p className="text-center text-xs text-zinc-400 mt-6">
            By continuing, you agree to Friendly ERP's Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>

      {/* Forgot-password modal */}
      {showForgot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4"
          onClick={() => setShowForgot(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Reset password"
        >
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-zinc-200 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-indigo-50 flex items-center justify-center">
                  <KeyRound className="h-4 w-4 text-indigo-500" />
                </div>
                <h3 className="text-base font-bold text-zinc-900 leading-9">Reset password</h3>
              </div>
              <button type="button" onClick={() => setShowForgot(false)} aria-label="Close" className="text-zinc-400 hover:text-zinc-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-4">Enter your account email and choose a new password. It takes effect immediately.</p>
            <form onSubmit={handleForgot} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Account Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    type="email" value={fpEmail} onChange={e => setFpEmail(e.target.value)}
                    placeholder="you@company.com" autoFocus
                    className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">New Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    type={fpShow ? 'text' : 'password'} value={fpNew} onChange={e => setFpNew(e.target.value)}
                    placeholder="At least 6 characters"
                    className="w-full pl-9 pr-10 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                  <button type="button" onClick={() => setFpShow(!fpShow)} aria-label={fpShow ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                    {fpShow ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <input
                    type={fpShow ? 'text' : 'password'} value={fpConfirm} onChange={e => setFpConfirm(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                </div>
              </div>
              <button
                type="submit" disabled={fpLoading}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {fpLoading ? <span className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <><CheckCircle2 className="h-4 w-4" /> Update Password</>}
              </button>
            </form>
            <p className="text-[11px] text-zinc-400 mt-3 text-center">Demo environment — reset is instant. Production sends a secure email link.</p>
          </div>
        </div>
      )}
    </div>
  );
}
