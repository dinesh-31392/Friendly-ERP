import { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Mail, Lock, ArrowRight, Home, Handshake } from 'lucide-react';
import { portalLogin, portalLoginApi, findTenantBySlug } from '../services/portalService';
import { isApiEnabled } from '../services/apiClient';
import toast from 'react-hot-toast';

export default function PortalLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const builderSlug = params.get('builder') || '';

  // White-label: brand the portal with the builder's identity when the
  // visitor arrives via the builder's subdomain / branded link
  const tenant = useMemo(() => (builderSlug ? findTenantBySlug(builderSlug) : undefined), [builderSlug]);
  const brandColor = tenant?.primaryColor || '#6366f1';
  const brandName = tenant?.name || 'Friendly ERP';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('Enter your email and password'); return; }
    setLoading(true);
    const result = isApiEnabled()
      ? await portalLoginApi(email, password, builderSlug || undefined)
      : portalLogin(email, password, builderSlug || undefined);
    setLoading(false);
    if ('error' in result) {
      toast.error(result.error);
      return;
    }
    toast.success(`Welcome, ${result.portalUser.name.split(' ')[0]}!`);
    navigate('/portal/home');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm">
        {/* Builder branding */}
        <div className="flex flex-col items-center mb-8">
          {tenant?.logo ? (
            <img src={tenant.logo} alt={brandName} className="h-14 w-14 rounded-2xl object-cover mb-3" />
          ) : (
            <div className="h-14 w-14 rounded-2xl flex items-center justify-center mb-3" style={{ background: brandColor }}>
              <Building2 className="h-7 w-7 text-white" />
            </div>
          )}
          <h1 className="text-xl font-bold text-zinc-900">{brandName}</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {tenant ? 'Customer & Partner Portal' : 'Portal Sign In'}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200/60 p-7 shadow-sm">
          <div className="flex gap-2 mb-5">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-zinc-50 rounded-xl text-xs text-zinc-600">
              <Home className="h-3.5 w-3.5" style={{ color: brandColor }} /> Home buyers
            </div>
            <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-zinc-50 rounded-xl text-xs text-zinc-600">
              <Handshake className="h-3.5 w-3.5" style={{ color: brandColor }} /> Channel partners
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                />
              </div>
            </div>
            <button
              type="submit" disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-white rounded-xl text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: brandColor }}
            >
              {loading ? 'Signing in…' : <>Sign In <ArrowRight className="h-4 w-4" /></>}
            </button>
          </form>

          <p className="text-[11px] text-zinc-400 text-center mt-5">
            Access is provided by your builder. Contact your sales advisor if you don't have credentials yet.
          </p>
        </div>

        {tenant && (
          <p className="text-center text-[11px] text-zinc-400 mt-5">
            Powered by Friendly ERP · {tenant.slug}.friendlyerp.app
          </p>
        )}
      </div>
    </div>
  );
}
