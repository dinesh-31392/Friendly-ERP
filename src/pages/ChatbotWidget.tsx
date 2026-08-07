import { useMemo, useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Bot, Send, CheckCircle2, Building2, ShieldCheck, IndianRupee } from 'lucide-react';
import { getByTenant } from '../services/db';
import { findTenantBySlug } from '../services/portalService';
import { ingestLead } from '../services/integrationService';
import { getConfigurations } from '../services/metaService';
import { getChatbotConfig, computeQualification, defaultChatbotConfig, type CustomField, type ChatbotConfig } from '../services/chatbotService';
import { isApiEnabled, apiGetPublicChatbot, apiCreatePublicLead } from '../services/apiClient';
import { formatCurrency } from '../utils/format';
import type { Project } from '../types';

type Msg = { from: 'bot' | 'user'; text: string };
type WProject = { id: string; name: string; location: string; priceRange: [number, number] };

/** Normalized data the conversation renders from — identical shape in demo and
 *  API mode, so the flow code below never branches on the backend. */
interface WData {
  mode: 'demo' | 'api';
  slug: string;
  tenantId?: string;          // demo only (ingestLead target)
  tenantName: string;
  currency: string;
  config: ChatbotConfig;
  projects: WProject[];
  configOptions: string[];    // configuration chips (demo: tenant meta; API: defaults)
  disabled: boolean;
  notFound: boolean;
}

/**
 * Public, no-auth lead-capture chatbot at /chat/<tenantSlug>. A builder embeds
 * this on their own site. Demo mode reads localStorage; API mode fetches the
 * builder's config + projects from the public server endpoint and posts the
 * lead back — landing in that builder's Leads section, auto-qualified.
 */
export default function ChatbotWidget() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<WData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isApiEnabled()) {
          const res = await apiGetPublicChatbot(slug);
          if (cancelled) return;
          const cfg: ChatbotConfig = { ...defaultChatbotConfig(), ...res.config, customFields: (res.config.customFields as CustomField[]) || [] };
          setData({
            mode: 'api', slug,
            tenantName: res.tenant.name, currency: res.tenant.currency,
            config: cfg,
            projects: res.projects.map(p => ({ id: p.id, name: p.name, location: p.location, priceRange: [p.priceMin, p.priceMax] as [number, number] })),
            configOptions: [],
            disabled: !cfg.enabled, notFound: false,
          });
        } else {
          const tenant = findTenantBySlug(slug);
          if (!tenant || tenant.status === 'suspended' || (tenant.approvalStatus ?? 'approved') !== 'approved') {
            if (!cancelled) setData({ mode: 'demo', slug, tenantName: '', currency: 'INR', config: defaultChatbotConfig(), projects: [], configOptions: [], disabled: false, notFound: true });
          } else {
            const cfg = getChatbotConfig(tenant.id);
            let projects = getByTenant<Project>('projects', tenant.id);
            if (cfg.projectMode === 'selected' && cfg.projectIds.length) projects = projects.filter(p => cfg.projectIds.includes(p.id));
            if (!cancelled) setData({
              mode: 'demo', slug, tenantId: tenant.id,
              tenantName: tenant.name, currency: tenant.currency || 'INR',
              config: cfg,
              projects: projects.map(p => ({ id: p.id, name: p.name, location: p.location, priceRange: p.priceRange })),
              configOptions: getConfigurations(tenant.id),
              disabled: !cfg.enabled, notFound: false,
            });
          }
        }
      } catch {
        if (!cancelled) setData({ mode: isApiEnabled() ? 'api' : 'demo', slug, tenantName: '', currency: 'INR', config: defaultChatbotConfig(), projects: [], configOptions: [], disabled: false, notFound: true });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <span className="h-8 w-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </div>
    );
  }
  if (!data || data.notFound) return <Gate title="Assistant unavailable" body="This link is invalid or the workspace is not active." />;
  if (data.disabled) return <Gate title={data.tenantName} body="The enquiry assistant is currently turned off." />;

  return <Conversation data={data} />;
}

function Gate({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6 text-center">
      <div>
        <Bot className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
        <h1 className="text-lg font-semibold text-zinc-700">{title}</h1>
        <p className="text-sm text-zinc-500 mt-1">{body}</p>
      </div>
    </div>
  );
}

function Conversation({ data }: { data: WData }) {
  const { config, projects, currency, tenantName } = data;
  const accent = config.accentColor || '#6366f1';

  const steps = useMemo(() => {
    const s: string[] = [];
    if (projects.length > 1) s.push('project');
    s.push('configuration', 'budget', 'timeline');
    config.customFields.forEach(f => s.push(`custom:${f.key}`));
    s.push('contact', 'done');
    return s;
  }, [projects.length, config.customFields]);

  const [stepIdx, setStepIdx] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([{ from: 'bot', text: config.greeting }]);
  const [answers, setAnswers] = useState<{ projectId?: string; configuration?: string; budget?: number; timeline?: string; custom: Record<string, string> }>({ custom: {} });
  const [contact, setContact] = useState({ name: '', phone: '', email: '', consent: false, honey: '' });
  const [result, setResult] = useState<{ status: string; project: string } | null>(null);
  const [textInput, setTextInput] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const step = steps[stepIdx];
  const selectedProject = projects.find(p => p.id === answers.projectId) ?? (projects.length ? projects[0] : undefined);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const say = (from: Msg['from'], text: string) => setMessages(m => [...m, { from, text }]);
  const advance = () => setStepIdx(i => Math.min(i + 1, steps.length - 1));

  const questionFor = (st: string): string => {
    if (st === 'project') return 'Which project are you interested in?';
    if (st === 'configuration') return 'What configuration are you looking for?';
    if (st === 'budget') return selectedProject?.priceRange?.[0]
      ? `What's your budget? (${selectedProject.name} ranges ${formatCurrency(selectedProject.priceRange[0], currency)}–${formatCurrency(selectedProject.priceRange[1], currency)})`
      : "What's your budget range?";
    if (st === 'timeline') return 'When are you planning to buy?';
    if (st.startsWith('custom:')) return config.customFields.find(cf => `custom:${cf.key}` === st)?.label || 'A quick question';
    if (st === 'contact') return 'Great — how can our team reach you?';
    return '';
  };

  const prevStepRef = useRef<string>('');
  useEffect(() => {
    if (step && step !== 'done' && step !== prevStepRef.current) {
      prevStepRef.current = step;
      const q = questionFor(step);
      if (q) say('bot', q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const pickProject = (p: WProject) => { say('user', p.name); setAnswers(a => ({ ...a, projectId: p.id })); advance(); };
  const pickConfiguration = (c: string) => { say('user', c); setAnswers(a => ({ ...a, configuration: c })); advance(); };
  const pickTimeline = (t: string) => { say('user', t); setAnswers(a => ({ ...a, timeline: t })); advance(); };
  const submitBudget = () => {
    const n = Number(textInput.replace(/[^0-9]/g, ''));
    if (!n) { setError('Please enter a number.'); return; }
    setError(''); say('user', formatCurrency(n, currency)); setAnswers(a => ({ ...a, budget: n })); setTextInput(''); advance();
  };
  const submitCustom = (f: CustomField, value: string) => {
    if (f.required && !value.trim()) { setError('This field is required.'); return; }
    setError(''); if (value) say('user', value);
    setAnswers(a => ({ ...a, custom: { ...a.custom, [f.key]: value } })); setTextInput(''); advance();
  };

  const submitAll = async () => {
    setError('');
    if (contact.honey) return;
    if (!contact.name.trim()) { setError('Please enter your name.'); return; }
    if (contact.phone.replace(/\D/g, '').length < 8) { setError('Please enter a valid phone number.'); return; }
    if (!contact.consent) { setError('Please tick the consent box so we can contact you.'); return; }

    const project = selectedProject || null;
    const q = computeQualification({
      budget: answers.budget || 0, configuration: answers.configuration, timeline: answers.timeline,
      project: project ? ({ priceRange: project.priceRange, name: project.name } as Project) : null,
      customAnswers: answers.custom, config,
    });

    setSubmitting(true);
    try {
      if (data.mode === 'api') {
        await apiCreatePublicLead({
          slug: data.slug, name: contact.name.trim(), phone: contact.phone.trim(), email: contact.email.trim() || undefined,
          projectId: project?.id, budget: answers.budget || 0, configuration: answers.configuration, timeline: answers.timeline,
          customFields: answers.custom, qualification: q,
        });
      } else {
        ingestLead(data.tenantId!, {
          name: contact.name.trim(), phone: contact.phone.trim(), email: contact.email.trim(),
          source: 'Chatbot', project: project?.name, budget: answers.budget || 0, configuration: answers.configuration,
          customFields: answers.custom, qualification: q, message: `Timeline: ${answers.timeline || 'n/a'}`,
        });
      }
      setResult({ status: q.status, project: project?.name || 'your enquiry' });
      setStepIdx(steps.indexOf('done'));
    } catch {
      setError('Something went wrong sending your enquiry. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputArea = () => {
    if (result) return null;
    if (step === 'project') {
      return (
        <div className="grid gap-2">
          {projects.map(p => (
            <button key={p.id} onClick={() => pickProject(p)} className="text-left p-3 rounded-xl border border-zinc-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors">
              <div className="flex items-center gap-2 font-semibold text-zinc-800"><Building2 className="h-4 w-4 text-indigo-500" />{p.name}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{p.location} · {formatCurrency(p.priceRange[0], currency)}–{formatCurrency(p.priceRange[1], currency)}</div>
            </button>
          ))}
        </div>
      );
    }
    if (step === 'configuration') {
      const opts = data.configOptions.length ? data.configOptions : ['1 BHK', '2 BHK', '3 BHK', '4 BHK', 'Villa'];
      return <ChipRow options={opts} onPick={pickConfiguration} accent={accent} />;
    }
    if (step === 'budget') {
      return (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input autoFocus value={textInput} onChange={e => setTextInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitBudget()} inputMode="numeric" placeholder="e.g. 9000000"
              className="w-full pl-9 pr-3 py-2.5 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          </div>
          <SendBtn onClick={submitBudget} accent={accent} />
        </div>
      );
    }
    if (step === 'timeline') return <ChipRow options={config.timelineOptions} onPick={pickTimeline} accent={accent} />;
    if (step.startsWith('custom:')) {
      const f = config.customFields.find(cf => `custom:${cf.key}` === step);
      if (!f) return null;
      if (f.type === 'select' && f.options?.length) {
        return (
          <div>
            <ChipRow options={f.options} onPick={v => submitCustom(f, v)} accent={accent} />
            {!f.required && <button onClick={() => submitCustom(f, '')} className="mt-2 text-xs text-zinc-400 hover:text-zinc-600">Skip</button>}
          </div>
        );
      }
      return (
        <div className="flex gap-2">
          <input autoFocus value={textInput} onChange={e => setTextInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitCustom(f, textInput)}
            type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'} placeholder={f.label}
            className="flex-1 px-3 py-2.5 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <SendBtn onClick={() => submitCustom(f, textInput)} accent={accent} />
        </div>
      );
    }
    if (step === 'contact') {
      return (
        <div className="space-y-2">
          <input tabIndex={-1} autoComplete="off" value={contact.honey} onChange={e => setContact(c => ({ ...c, honey: e.target.value }))} className="hidden" aria-hidden="true" />
          <input autoFocus placeholder="Your name" value={contact.name} onChange={e => setContact(c => ({ ...c, name: e.target.value }))} className="w-full px-3 py-2.5 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <input placeholder="Phone number" value={contact.phone} inputMode="tel" onChange={e => setContact(c => ({ ...c, phone: e.target.value }))} className="w-full px-3 py-2.5 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <input placeholder="Email (optional)" value={contact.email} type="email" onChange={e => setContact(c => ({ ...c, email: e.target.value }))} className="w-full px-3 py-2.5 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <label className="flex items-start gap-2 text-xs text-zinc-500 py-1">
            <input type="checkbox" checked={contact.consent} onChange={e => setContact(c => ({ ...c, consent: e.target.checked }))} className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-indigo-600" />
            <span>I agree to be contacted by {tenantName} about this enquiry.</span>
          </label>
          <button onClick={submitAll} disabled={submitting} style={{ backgroundColor: accent }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60">
            {submitting ? 'Sending…' : 'Submit enquiry'}
          </button>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-0 sm:p-6">
      <div className="w-full sm:max-w-md bg-white sm:rounded-2xl sm:border border-zinc-200 shadow-sm flex flex-col h-screen sm:h-[640px] overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100" style={{ backgroundColor: accent }}>
          <div className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center"><Bot className="h-5 w-5 text-white" /></div>
          <div className="text-white">
            <p className="font-semibold leading-tight">{tenantName}</p>
            <p className="text-[11px] opacity-90">Enquiry assistant</p>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm ${m.from === 'user' ? 'text-white rounded-br-sm' : 'bg-zinc-100 text-zinc-800 rounded-bl-sm'}`} style={m.from === 'user' ? { backgroundColor: accent } : undefined}>
                {m.text}
              </div>
            </div>
          ))}
          {result && (
            <div className="mt-3 p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
              <p className="font-semibold text-emerald-800">
                {result.status === 'hot' || result.status === 'warm' ? `You're a strong fit for ${result.project}! 🎉` : 'Thank you for your enquiry!'}
              </p>
              <p className="text-sm text-emerald-700 mt-1">
                {result.status === 'hot' || result.status === 'warm' ? `Our ${tenantName} team will call you very shortly.` : `Our team will be in touch about ${result.project}.`}
              </p>
            </div>
          )}
        </div>

        {!result && (
          <div className="px-4 py-3 border-t border-zinc-100">
            {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
            {inputArea()}
            <p className="mt-2 flex items-center justify-center gap-1 text-[10px] text-zinc-400"><ShieldCheck className="h-3 w-3" /> Secured by Friendly ERP</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ChipRow({ options, onPick, accent }: { options: string[]; onPick: (v: string) => void; accent: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(o => (
        <button key={o} onClick={() => onPick(o)} className="px-3 py-2 rounded-full border text-sm font-medium transition-colors hover:text-white"
          style={{ borderColor: accent, color: accent }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = accent; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}>
          {o}
        </button>
      ))}
    </div>
  );
}

function SendBtn({ onClick, accent }: { onClick: () => void; accent: string }) {
  return (
    <button onClick={onClick} style={{ backgroundColor: accent }} className="px-3 rounded-xl text-white hover:opacity-90 transition-opacity flex items-center justify-center">
      <Send className="h-4 w-4" />
    </button>
  );
}
