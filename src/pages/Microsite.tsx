import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Building2, MapPin, CheckCircle2, Home, IndianRupee, Send, ShieldCheck } from 'lucide-react';
import { getById, getByTenant } from '../services/db';
import { findTenantBySlug } from '../services/portalService';
import { ingestLead } from '../services/integrationService';
import { formatCurrency } from '../utils/format';
import type { Project, Tenant, Unit, Tower } from '../types';
import toast from 'react-hot-toast';

/**
 * Public project microsite — the LeadRat-style hosted landing page. No auth:
 * a buyer arrives via a shared link (/site/<tenantSlug>/<projectId>), sees a
 * white-labeled project page, and submits an enquiry that lands in the CRM as
 * a scored, auto-routed lead with source "Microsite".
 */
export default function Microsite() {
  const { slug = '', projectId = '' } = useParams();
  const [submitted, setSubmitted] = useState(false);

  const data = useMemo(() => {
    const tenant = findTenantBySlug(slug) as Tenant | undefined;
    if (!tenant) return null;
    // A cut-off workspace (suspended or not approved) must not serve a live
    // public page or ingest leads — mirror the login/portal lifecycle gate.
    if (tenant.status === 'suspended') return null;
    if ((tenant.approvalStatus ?? 'approved') !== 'approved') return null;
    const project = getById<Project>('projects', projectId);
    if (!project || project.tenantId !== tenant.id || !project.micrositePublished) return null;
    const towers = getByTenant<Tower>('towers', tenant.id).filter(t => t.projectId === project.id);
    const towerIds = new Set(towers.map(t => t.id));
    const units = getByTenant<Unit>('units', tenant.id).filter(u => towerIds.has(u.towerId));
    const configs = [...new Set(units.map(u => u.configuration))];
    const available = units.filter(u => u.status === 'available').length;
    return { tenant, project, configs, available, currency: tenant.currency || 'INR' };
  }, [slug, projectId]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6 text-center">
        <div>
          <Building2 className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-zinc-700">Microsite unavailable</h1>
          <p className="text-sm text-zinc-500 mt-1">This project page is not published or the link is invalid.</p>
        </div>
      </div>
    );
  }

  const { tenant, project, configs, available, currency } = data;
  const brand = tenant.primaryColor || '#6366f1';

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    // Honeypot: bots fill hidden fields; real users leave it empty
    if ((fd.get('company_website') as string || '').trim()) { setSubmitted(true); return; }
    // Per-browser cooldown to blunt naive submission loops (real rate limiting
    // is enforced server-side on the /api lead-capture endpoint)
    const COOLDOWN_MS = 15000;
    const last = Number(localStorage.getItem('friendly_crm_microsite_last') || 0);
    if (Date.now() - last < COOLDOWN_MS) { toast.error('Please wait a moment before submitting again.'); return; }
    const name = (fd.get('name') as string || '').trim();
    const phone = (fd.get('phone') as string || '').trim();
    if (!name || !phone) { toast.error('Name and phone are required'); return; }
    if (phone.replace(/\D/g, '').length < 7) { toast.error('Enter a valid phone number'); return; }
    localStorage.setItem('friendly_crm_microsite_last', String(Date.now()));
    ingestLead(tenant.id, {
      name, phone,
      email: (fd.get('email') as string) || '',
      source: 'Microsite',
      project: project.name,
      configuration: (fd.get('configuration') as string) || undefined,
      budget: Number(fd.get('budget')) || 0,
      message: `Microsite enquiry for ${project.name}${fd.get('message') ? ` — ${fd.get('message')}` : ''}`,
    });
    setSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Hero */}
      <header className="text-white" style={{ background: `linear-gradient(135deg, ${brand}, #1e1b4b)` }}>
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-3">
          {tenant.logo
            ? <img src={tenant.logo} alt={tenant.name} className="h-9 w-9 rounded-xl object-cover" />
            : <div className="h-9 w-9 rounded-xl bg-white/20 flex items-center justify-center"><Building2 className="h-5 w-5" /></div>}
          <span className="font-bold">{tenant.name}</span>
        </div>
        <div className="max-w-4xl mx-auto px-6 pb-12 pt-6">
          <span className="inline-block text-[11px] font-semibold bg-white/15 px-3 py-1 rounded-full mb-3 capitalize">
            {project.status.replace('_', ' ')}
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold leading-tight">{project.name}</h1>
          <p className="flex items-center gap-1.5 text-white/80 mt-2"><MapPin className="h-4 w-4" /> {project.location}</p>
          {project.priceRange?.[0] > 0 && (
            <p className="text-2xl font-bold mt-4">
              {formatCurrency(project.priceRange[0], currency)}
              {project.priceRange[1] > project.priceRange[0] && <span className="text-white/70"> – {formatCurrency(project.priceRange[1], currency)}</span>}
            </p>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 grid grid-cols-1 lg:grid-cols-5 gap-8">
        {/* Details */}
        <div className="lg:col-span-3 space-y-6">
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Configurations', configs.length ? configs.join(', ') : project.type, Home],
              ['Units Available', String(available || project.availableUnits || 0), Building2],
              ['RERA', project.reraNumber || 'Applied', ShieldCheck],
            ].map(([label, value, Icon]) => (
              <div key={label as string} className="bg-zinc-50 rounded-xl p-4">
                <Icon className="h-4 w-4 mb-1.5" style={{ color: brand }} />
                <p className="text-sm font-bold text-zinc-900">{value as string}</p>
                <p className="text-[11px] text-zinc-500">{label as string}</p>
              </div>
            ))}
          </div>

          {project.description && (
            <div>
              <h2 className="text-lg font-semibold text-zinc-900 mb-2">About {project.name}</h2>
              <p className="text-sm text-zinc-600 leading-relaxed">{project.description}</p>
            </div>
          )}

          {project.amenities && project.amenities.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-zinc-900 mb-2">Amenities</h2>
              <div className="grid grid-cols-2 gap-2">
                {project.amenities.map(a => (
                  <span key={a} className="flex items-center gap-2 text-sm text-zinc-700">
                    <CheckCircle2 className="h-4 w-4" style={{ color: brand }} /> {a}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Enquiry form */}
        <div className="lg:col-span-2">
          <div className="bg-white border border-zinc-200 rounded-2xl shadow-lg p-5 sticky top-6">
            {submitted ? (
              <div className="text-center py-8">
                <CheckCircle2 className="h-12 w-12 mx-auto mb-3" style={{ color: brand }} />
                <h3 className="text-lg font-semibold text-zinc-900">Thank you!</h3>
                <p className="text-sm text-zinc-500 mt-1">Our team will reach out to you shortly about {project.name}.</p>
              </div>
            ) : (
              <>
                <h3 className="font-semibold text-zinc-900">Request a callback</h3>
                <p className="text-xs text-zinc-500 mb-4">Get pricing, floor plans & a site visit slot.</p>
                <form onSubmit={handleSubmit} className="space-y-2.5">
                  {/* Honeypot — hidden from humans, catches bots */}
                  <input name="company_website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
                  <input name="name" placeholder="Your name *" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2" style={{ '--tw-ring-color': brand } as React.CSSProperties} />
                  <input name="phone" placeholder="Phone number *" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <input name="email" type="email" placeholder="Email" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  <select name="configuration" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none text-zinc-600">
                    <option value="">Preferred configuration</option>
                    {(configs.length ? configs : ['1 BHK', '2 BHK', '3 BHK']).map(c => <option key={c}>{c}</option>)}
                  </select>
                  <div className="relative">
                    <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
                    <input name="budget" type="number" placeholder="Budget" className="w-full pl-8 pr-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none" />
                  </div>
                  <textarea name="message" rows={2} placeholder="Anything specific you're looking for?" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none resize-none" />
                  <button type="submit" className="w-full flex items-center justify-center gap-2 py-2.5 text-white rounded-xl text-sm font-semibold hover:opacity-90" style={{ background: brand }}>
                    <Send className="h-4 w-4" /> Submit Enquiry
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-zinc-100 py-6 text-center text-[11px] text-zinc-400">
        {tenant.name} · Powered by Friendly ERP{tenant.rera ? ` · RERA ${tenant.rera}` : ''}
      </footer>
    </div>
  );
}
