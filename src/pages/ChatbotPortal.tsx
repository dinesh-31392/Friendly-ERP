import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bot, Plus, Trash2, ExternalLink, Copy, Save, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant } from '../services/db';
import {
  getChatbotConfig, saveChatbotConfig, fieldKeyFromLabel, defaultChatbotConfig,
  type ChatbotConfig, type CustomField, type CustomFieldType,
} from '../services/chatbotService';
import { isApiEnabled, apiGetChatbotConfig, apiSaveChatbotConfig } from '../services/apiClient';
import type { Project } from '../types';
import toast from 'react-hot-toast';

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'select', 'phone', 'email', 'date'];

/**
 * Native Chatbot Builder — configure the lead-capture chatbot a builder embeds
 * on their own website. Everything here is tenant-scoped: greeting, which
 * projects to offer, the custom questions to ask, and the qualification
 * thresholds that decide Hot/Warm/Cold. Leads land in the CRM as source
 * "Chatbot" with a qualification status.
 */
export default function ChatbotPortal() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const slug = tenant?.slug || '';
  const [cfg, setCfg] = useState<ChatbotConfig>(() => getChatbotConfig(tenantId));
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId]);

  // In API mode the server is the source of truth — hydrate from it on mount
  // (falls back silently to the localStorage config already loaded above).
  useEffect(() => {
    if (!isApiEnabled()) return;
    let cancelled = false;
    apiGetChatbotConfig()
      .then(remote => { if (!cancelled && remote) setCfg({ ...defaultChatbotConfig(), ...remote, customFields: (remote.customFields as CustomField[]) || [] }); })
      .catch(() => { /* keep local config */ });
    return () => { cancelled = true; };
  }, []);

  const publicUrl = `${window.location.origin}/chat/${slug}`;
  const embedSnippet = `<iframe src="${publicUrl}" style="border:0;width:100%;max-width:420px;height:640px" title="${tenant?.name || 'Enquiry'} assistant"></iframe>`;

  const set = <K extends keyof ChatbotConfig>(k: K, v: ChatbotConfig[K]) => setCfg(c => ({ ...c, [k]: v }));

  const save = () => {
    // Ensure every custom field has a stable, unique key derived from its label.
    const seen = new Set<string>();
    const fields = cfg.customFields.map(f => {
      let key = f.key || fieldKeyFromLabel(f.label);
      while (seen.has(key)) key += '_1';
      seen.add(key);
      return { ...f, key, label: f.label.trim() || 'Question' };
    });
    const next = { ...cfg, customFields: fields };
    saveChatbotConfig(tenantId, next);   // local cache / demo path
    setCfg(next);
    if (isApiEnabled()) {
      apiSaveChatbotConfig(next)
        .then(() => toast.success('Chatbot settings saved to server'))
        .catch(() => toast.error('Saved locally, but the server save failed'));
    } else {
      toast.success('Chatbot settings saved');
    }
  };

  const addField = () => set('customFields', [...cfg.customFields, {
    key: `field_${cfg.customFields.length + 1}`, label: '', type: 'text', required: false, qualifying: false,
  }]);
  const updateField = (i: number, patch: Partial<CustomField>) =>
    set('customFields', cfg.customFields.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  const removeField = (i: number) => set('customFields', cfg.customFields.filter((_, idx) => idx !== i));

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(() => toast.success(`${label} copied`)).catch(() => toast.error('Copy failed'));
  };

  return (
    <div className="space-y-5 max-w-[1000px] pb-10">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/settings" className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"><ArrowLeft className="h-4 w-4" /></Link>
          <div>
            <h2 className="text-2xl font-bold text-zinc-900 flex items-center gap-2"><Bot className="h-6 w-6 text-indigo-500" /> Chatbot Builder</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Configure the enquiry assistant you embed on your website. Leads flow into the Leads module, auto-qualified.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">
            <ExternalLink className="h-4 w-4" /> Preview
          </a>
          <button onClick={save} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
            <Save className="h-4 w-4" /> Save
          </button>
        </div>
      </div>

      {/* General */}
      <section className="bg-white rounded-2xl border border-zinc-200/60 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-zinc-900">Assistant</h3>
            <p className="text-xs text-zinc-500">Turn the chatbot on and set how it greets visitors.</p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-sm text-zinc-600">{cfg.enabled ? 'Enabled' : 'Disabled'}</span>
            <input type="checkbox" checked={cfg.enabled} onChange={e => set('enabled', e.target.checked)} className="h-5 w-9 rounded-full appearance-none bg-zinc-200 checked:bg-indigo-600 relative transition-colors cursor-pointer after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform checked:after:translate-x-4" />
          </label>
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">Greeting message</label>
          <textarea value={cfg.greeting} onChange={e => set('greeting', e.target.value)} rows={2}
            className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-zinc-500">Accent colour</label>
          <input type="color" value={cfg.accentColor} onChange={e => set('accentColor', e.target.value)} className="h-8 w-12 rounded border border-zinc-200 cursor-pointer" />
          <span className="text-xs text-zinc-400">{cfg.accentColor}</span>
        </div>
      </section>

      {/* Projects */}
      <section className="bg-white rounded-2xl border border-zinc-200/60 p-5 space-y-3">
        <div>
          <h3 className="font-semibold text-zinc-900">Projects offered</h3>
          <p className="text-xs text-zinc-500">The bot uses each project's price range & configurations (already in your backend) to qualify buyers.</p>
        </div>
        <div className="flex gap-2">
          {(['all', 'selected'] as const).map(m => (
            <button key={m} onClick={() => set('projectMode', m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${cfg.projectMode === m ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
              {m === 'all' ? 'All projects' : 'Selected projects'}
            </button>
          ))}
        </div>
        {cfg.projectMode === 'selected' && (
          <div className="grid sm:grid-cols-2 gap-2 pt-1">
            {projects.length === 0 && <p className="text-xs text-zinc-400">No projects yet.</p>}
            {projects.map(p => {
              const checked = cfg.projectIds.includes(p.id);
              return (
                <label key={p.id} className="flex items-center gap-2 p-2 rounded-lg border border-zinc-200 text-sm cursor-pointer hover:bg-zinc-50">
                  <input type="checkbox" checked={checked}
                    onChange={e => set('projectIds', e.target.checked ? [...cfg.projectIds, p.id] : cfg.projectIds.filter(id => id !== p.id))}
                    className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
                  <span className="text-zinc-700">{p.name}</span>
                </label>
              );
            })}
          </div>
        )}
      </section>

      {/* Custom fields */}
      <section className="bg-white rounded-2xl border border-zinc-200/60 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-zinc-900">Custom questions</h3>
            <p className="text-xs text-zinc-500">The extra fields you require from customers. Mark a question "qualifying" to feed the lead score.</p>
          </div>
          <button onClick={addField} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-100">
            <Plus className="h-3.5 w-3.5" /> Add question
          </button>
        </div>
        <div className="space-y-2">
          {cfg.customFields.length === 0 && <p className="text-xs text-zinc-400">No custom questions — the bot still asks project, budget and timeline.</p>}
          {cfg.customFields.map((f, i) => (
            <div key={i} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center p-2 rounded-xl border border-zinc-100 bg-zinc-50/40">
              <input value={f.label} onChange={e => updateField(i, { label: e.target.value })} placeholder="Question label"
                className="md:col-span-4 px-2.5 py-2 border border-zinc-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <select value={f.type} onChange={e => updateField(i, { type: e.target.value as CustomFieldType })}
                className="md:col-span-2 px-2 py-2 border border-zinc-200 rounded-lg text-sm bg-white capitalize">
                {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input value={f.options?.join(', ') || ''} onChange={e => updateField(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                placeholder={f.type === 'select' ? 'Option A, Option B' : '—'} disabled={f.type !== 'select'}
                className="md:col-span-3 px-2.5 py-2 border border-zinc-200 rounded-lg text-sm bg-white disabled:bg-zinc-100 disabled:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
              <label className="md:col-span-1 flex items-center gap-1 text-[11px] text-zinc-500"><input type="checkbox" checked={f.required} onChange={e => updateField(i, { required: e.target.checked })} className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600" /> Req</label>
              <label className="md:col-span-1 flex items-center gap-1 text-[11px] text-zinc-500" title="Feeds the qualification score"><input type="checkbox" checked={!!f.qualifying} onChange={e => updateField(i, { qualifying: e.target.checked })} className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600" /> Qual</label>
              <button onClick={() => removeField(i)} className="md:col-span-1 justify-self-end p-1.5 text-zinc-400 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </section>

      {/* Qualification thresholds */}
      <section className="bg-white rounded-2xl border border-zinc-200/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-500" />
          <div>
            <h3 className="font-semibold text-zinc-900">Qualification thresholds</h3>
            <p className="text-xs text-zinc-500">Score 0–100 from budget fit, timeline & financing. Set where Hot / Warm begin and when a lead enters the pipeline already qualified.</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {([['hotMin', 'Hot from'], ['warmMin', 'Warm from'], ['qualifyMin', 'Qualified from']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs font-medium text-zinc-500 mb-1">{label} (score)</label>
              <input type="number" min={0} max={100} value={cfg[k]} onChange={e => set(k, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
            </div>
          ))}
        </div>
      </section>

      {/* Embed */}
      <section className="bg-white rounded-2xl border border-zinc-200/60 p-5 space-y-3">
        <div>
          <h3 className="font-semibold text-zinc-900">Embed on your website</h3>
          <p className="text-xs text-zinc-500">Paste this snippet into your site, or share the direct link. Remember to Save your settings first.</p>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-zinc-600 truncate">{publicUrl}</code>
          <button onClick={() => copy(publicUrl, 'Link')} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-50"><Copy className="h-3.5 w-3.5" /> Copy link</button>
        </div>
        <div className="flex items-start gap-2">
          <code className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-zinc-600 break-all">{embedSnippet}</code>
          <button onClick={() => copy(embedSnippet, 'Embed code')} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-50 shrink-0"><Copy className="h-3.5 w-3.5" /> Copy code</button>
        </div>
      </section>
    </div>
  );
}
