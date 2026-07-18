import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Building2, Mail, Lock, User, Phone, ArrowRight, Eye, EyeOff, Shield, Globe, Home, KeyRound, CheckCircle2, X, Clock, AlertCircle } from 'lucide-react';
import { COUNTRIES } from '../utils/format';
import InstallAppButton from '../components/InstallAppButton';
import toast from 'react-hot-toast';

type LoginTab = 'platform' | 'builder' | 'portal';

export default function Login() {
  const { login, register, resetPassword, needsSetup, setupPlatformAdmin } = useAuth();
  // First-run setup fields (fresh deployment, zero accounts)
  const [suName, setSuName] = useState('');
  const [suEmail, setSuEmail] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [suConfirm, setSuConfirm] = useState('');
  const [tab, setTab] = useState<LoginTab>('builder');
  const [isRegistering, setIsRegistering] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Banner shown after a self-serve signup that is now awaiting approval
  const [pendingNotice, setPendingNotice] = useState(false);
  // Persistent inline error (in addition to the toast) — accessible via role="alert"
  const [loginError, setLoginError] = useState('');

  // Login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

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
    const result = await login(email, password);
    setLoading(false);
    if (!result.success) {
      setLoginError(result.error || 'Login failed. Please try again.');
      toast.error(result.error || 'Login failed');
    } else {
      toast.success('Welcome back!');
    }
  };

  const switchTab = (t: LoginTab) => {
    setTab(t); setIsRegistering(false); setLoginError(''); setShowPassword(false);
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

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suName || !suEmail || !suPassword) { toast.error('Please fill all fields'); return; }
    if (!emailValid(suEmail)) { toast.error('Please enter a valid email address'); return; }
    if (suPassword.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (suPassword !== suConfirm) { toast.error('Passwords do not match'); return; }
    setLoading(true);
    const result = await setupPlatformAdmin(suName, suEmail, suPassword);
    setLoading(false);
    if (!result.success) { toast.error(result.error || 'Setup failed'); return; }
    toast.success('Platform administrator created — sign in to continue');
    setTab('platform');
    setEmail(suEmail);
    setPassword('');
    setSuName(''); setSuEmail(''); setSuPassword(''); setSuConfirm('');
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
              <p className="text-lg font-bold text-white tracking-tight">Friendly CRM</p>
              <p className="text-sm text-indigo-200">Real Estate Operating System</p>
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
            <p className="text-lg font-bold text-zinc-900">Friendly CRM</p>
          </div>

          <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 sm:p-8 shadow-sm">
            {needsSetup ? (
              /* ── First run: no accounts exist yet ──────────────────────────
                 This build ships with NO seed data and NO default credentials,
                 so there is nothing to sign in with until the operator creates
                 the first platform administrator here. createPlatformAdmin is
                 guarded by needsSetup(), so this can only ever run once. */
              <div>
                <div className="h-11 w-11 rounded-2xl bg-indigo-50 flex items-center justify-center mb-4">
                  <Shield className="h-5 w-5 text-indigo-500" />
                </div>
                <h2 className="text-xl font-bold text-zinc-900">Set up Friendly CRM</h2>
                <p className="text-sm text-zinc-500 mt-1 mb-5">
                  This is a fresh installation. Create your platform administrator account — you'll use it to onboard builders and run the platform.
                </p>
                <form onSubmit={handleSetup} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Your Name</label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input value={suName} onChange={e => setSuName(e.target.value)} placeholder="Jane Doe" autoFocus
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input type="email" value={suEmail} onChange={e => setSuEmail(e.target.value)} placeholder="admin@yourcompany.com"
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input type={showPassword ? 'text' : 'password'} value={suPassword} onChange={e => setSuPassword(e.target.value)} placeholder="At least 8 characters"
                        className="w-full pl-9 pr-10 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400" />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Confirm Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                      <input type={showPassword ? 'text' : 'password'} value={suConfirm} onChange={e => setSuConfirm(e.target.value)} placeholder="Re-enter password"
                        className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400" />
                    </div>
                  </div>
                  <button type="submit" disabled={loading}
                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
                    {loading ? <span className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      : <>Create Administrator <ArrowRight className="h-4 w-4" /></>}
                  </button>
                </form>
                <p className="text-[11px] text-zinc-400 mt-4 text-center">
                  This runs once. No demo accounts or sample data are installed.
                </p>
              </div>
            ) : (
            <>
            {/* Login-type tabs */}
            <div className="flex items-center gap-1 bg-zinc-100 rounded-xl p-1 mb-6">
              {([
                { id: 'platform' as const, label: 'Platform', icon: Globe },
                { id: 'builder' as const, label: 'Builder', icon: Building2 },
                { id: 'portal' as const, label: 'Portal', icon: Home },
              ]).map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => switchTab(t.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${tab === t.id ? 'bg-white text-indigo-700 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                >
                  <t.icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              ))}
            </div>

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
                    ? 'For Super Admin & Branch Team.'
                    : 'For Builder Admin, Sales Manager & Sales Executive.'}
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
          </div>

          {/* Always offered here: the login page is where people discover the
              app is installable at all, so it must not hide itself in browsers
              that never fire a native install prompt. */}
          <div className="flex justify-center mt-5">
            <InstallAppButton alwaysShow />
          </div>

          <p className="text-center text-xs text-zinc-400 mt-6">
            By continuing, you agree to Friendly CRM's Terms of Service and Privacy Policy.
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
