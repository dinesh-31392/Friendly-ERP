import { useState, useMemo } from 'react';
import {
  Megaphone, Plus, X, Send, Clock, CheckCircle2, FileText, Trash2, Calendar, Copy,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update, remove, logAudit } from '../services/db';
import { localeFor } from '../utils/format';
import type { Campaign, Template } from '../types';
import toast from 'react-hot-toast';

const statusColors: Record<Campaign['status'], string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  scheduled: 'bg-amber-50 text-amber-700',
  sent: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-blue-50 text-blue-700',
};

export default function Campaigns() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const appLocale = localeFor(tenant?.currency);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  const [tab, setTab] = useState<'campaigns' | 'templates'>('campaigns');
  const [showAdd, setShowAdd] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [selected, setSelected] = useState<Campaign | null>(null);

  const campaigns = useMemo(
    () => getByTenant<Campaign>('campaigns', tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tenantId, refreshKey]
  );
  const templates = useMemo(() => getByTenant<Template>('templates', tenantId), [tenantId, refreshKey]);
  const channels = tenant?.channels || ['WhatsApp', 'Email', 'SMS'];

  const audit = (action: string, id: string, details: string) => {
    if (!user) return;
    logAudit({ tenantId, userId: user.id, userName: user.name, action, entity: 'campaign', entityId: id, details });
  };

  const stats = {
    total: campaigns.length,
    scheduled: campaigns.filter(c => c.status === 'scheduled').length,
    sent: campaigns.filter(c => c.status === 'sent' || c.status === 'completed').length,
    drafts: campaigns.filter(c => c.status === 'draft').length,
  };

  const canManage = hasPermission('manage_campaigns');

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canManage) { toast.error('You do not have permission to manage campaigns'); return; }
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const content = fd.get('content') as string;
    if (!name || !content) { toast.error('Name and content are required'); return; }
    const scheduledAt = fd.get('scheduledAt') as string;
    const created = create<Campaign>('campaigns', {
      id: '', tenantId, name,
      type: (fd.get('type') as string) || 'Broadcast',
      status: scheduledAt ? 'scheduled' : 'draft',
      audience: (fd.get('audience') as string) || 'All leads',
      channel: (fd.get('channel') as string) || channels[0],
      content,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      createdAt: new Date().toISOString(),
    });
    audit('create', created.id, `Created campaign "${name}"`);
    setShowAdd(false);
    refresh();
    toast.success('Campaign created');
  };

  const handleSend = (c: Campaign) => {
    if (!canManage) { toast.error('You do not have permission to send campaigns'); return; }
    if (!confirm(`Send campaign "${c.name}" to ${c.audience} via ${c.channel}?`)) return;
    update<Campaign>('campaigns', c.id, { status: 'sent', sentAt: new Date().toISOString() });
    audit('send', c.id, `Sent campaign "${c.name}" via ${c.channel}`);
    setSelected(null);
    refresh();
    toast.success('Campaign sent');
  };

  const handleDelete = (c: Campaign) => {
    if (!canManage) { toast.error('You do not have permission to delete campaigns'); return; }
    if (!confirm(`Delete campaign "${c.name}"?`)) return;
    remove('campaigns', c.id);
    audit('delete', c.id, `Deleted campaign "${c.name}"`);
    setSelected(null);
    refresh();
    toast.success('Campaign deleted');
  };

  const handleAddTemplate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canManage) { toast.error('You do not have permission to manage templates'); return; }
    const fd = new FormData(e.currentTarget);
    const name = fd.get('name') as string;
    const content = fd.get('content') as string;
    if (!name || !content) { toast.error('Name and content required'); return; }
    create<Template>('templates', {
      id: '', tenantId, name,
      category: (fd.get('category') as string) || 'General',
      channel: (fd.get('channel') as string) || channels[0],
      content, createdAt: new Date().toISOString(),
    });
    setShowTemplate(false);
    refresh();
    toast.success('Template saved');
  };

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Marketing Campaigns</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Create, schedule, and track brand-aware campaigns.</p>
        </div>
        {canManage && (
        <div className="flex items-center gap-2">
          {tab === 'campaigns' ? (
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" /> New Campaign
            </button>
          ) : (
            <button onClick={() => setShowTemplate(true)} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" /> New Template
            </button>
          )}
        </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl p-1 inline-flex">
        {([['campaigns', 'Campaigns'], ['templates', 'Templates']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >{label}</button>
        ))}
      </div>

      {tab === 'campaigns' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Total Campaigns', value: stats.total, icon: Megaphone, color: 'text-indigo-600' },
              { label: 'Scheduled', value: stats.scheduled, icon: Clock, color: 'text-amber-600' },
              { label: 'Sent', value: stats.sent, icon: CheckCircle2, color: 'text-emerald-600' },
              { label: 'Drafts', value: stats.drafts, icon: FileText, color: 'text-zinc-500' },
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

          <div className="bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
            {campaigns.length === 0 ? (
              <div className="py-16 text-center">
                <Megaphone className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
                <h3 className="text-sm font-semibold text-zinc-700">No campaigns yet</h3>
                <p className="text-xs text-zinc-500 mt-1">Create one here or save a draft from AI Studio.</p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-50">
                {campaigns.map(c => (
                  <div key={c.id} className="px-5 py-4 hover:bg-zinc-50/30 transition-colors flex items-center gap-4 cursor-pointer" onClick={() => setSelected(c)}>
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 flex items-center justify-center shrink-0">
                      <Megaphone className="h-5 w-5 text-indigo-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-900">{c.name}</p>
                      <div className="flex items-center gap-3 text-[11px] text-zinc-500 mt-0.5 flex-wrap">
                        <span>{c.type}</span>
                        <span>· {c.channel}</span>
                        <span>· {c.audience}</span>
                        {c.scheduledAt && <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {new Date(c.scheduledAt).toLocaleDateString(appLocale, { day: 'numeric', month: 'short' })}</span>}
                      </div>
                    </div>
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${statusColors[c.status]}`}>{c.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-white rounded-2xl border border-zinc-200/60 p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="text-sm font-semibold text-zinc-900">{t.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] font-medium bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">{t.category}</span>
                    <span className="text-[10px] font-medium bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full">{t.channel}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => { navigator.clipboard.writeText(t.content); toast.success('Copied'); }} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 hover:text-indigo-600"><Copy className="h-4 w-4" /></button>
                  <button onClick={() => { remove('templates', t.id); refresh(); toast.success('Template deleted'); }} className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <p className="text-xs text-zinc-600 leading-relaxed bg-zinc-50 rounded-lg p-3">{t.content}</p>
            </div>
          ))}
          {templates.length === 0 && (
            <div className="col-span-2 py-16 text-center bg-white rounded-2xl border border-zinc-200/60">
              <FileText className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-zinc-700">No templates yet</h3>
            </div>
          )}
        </div>
      )}

      {/* Campaign detail modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-zinc-900">{selected.name}</h3>
                <span className={`inline-block mt-1 text-[11px] font-semibold px-2.5 py-1 rounded-full capitalize ${statusColors[selected.status]}`}>{selected.status}</span>
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">Channel</p><p className="text-sm font-semibold text-zinc-900 mt-0.5">{selected.channel}</p></div>
              <div className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">Type</p><p className="text-sm font-semibold text-zinc-900 mt-0.5">{selected.type}</p></div>
              <div className="bg-zinc-50 rounded-xl p-3"><p className="text-[10px] text-zinc-500 uppercase">Audience</p><p className="text-sm font-semibold text-zinc-900 mt-0.5">{selected.audience}</p></div>
            </div>
            <div className="bg-zinc-50 rounded-xl p-4 mb-4">
              <p className="text-xs text-zinc-700 whitespace-pre-wrap leading-relaxed">{selected.content}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { navigator.clipboard.writeText(selected.content); toast.success('Copied'); }} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">
                <Copy className="h-4 w-4" /> Copy
              </button>
              {selected.status !== 'sent' && selected.status !== 'completed' && (
                <button onClick={() => handleSend(selected)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
                  <Send className="h-4 w-4" /> Send Now
                </button>
              )}
              <button onClick={() => handleDelete(selected)} className="px-3 py-2.5 border border-red-200 text-red-500 rounded-xl hover:bg-red-50">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New campaign modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">New Campaign</h3>
              <button onClick={() => setShowAdd(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Campaign Name *</label>
                <input name="name" required placeholder="e.g., Diwali Launch Offer" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Channel</label>
                  <select name="channel" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {channels.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Type</label>
                  <select name="type" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>Broadcast</option><option>Launch Campaign</option><option>Event Invite</option><option>Follow-up</option><option>Offer</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Audience</label>
                  <select name="audience" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>All leads</option><option>Hot leads</option><option>Qualified leads</option><option>Channel partners</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Schedule (optional)</label>
                  <input name="scheduledAt" type="datetime-local" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Message Content *</label>
                <textarea name="content" required rows={5} placeholder="Write your campaign message..." className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
                {templates.length > 0 && (
                  <p className="text-[11px] text-zinc-400 mt-1">Tip: Save reusable content in the Templates tab.</p>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Create Campaign</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New template modal */}
      {showTemplate && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowTemplate(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-zinc-900">New Template</h3>
              <button onClick={() => setShowTemplate(false)} className="p-1.5 rounded-lg hover:bg-zinc-100"><X className="h-4 w-4 text-zinc-500" /></button>
            </div>
            <form onSubmit={handleAddTemplate} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Template Name *</label>
                <input name="name" required placeholder="e.g., Site Visit Reminder" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Category</label>
                  <select name="category" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    <option>Follow-up</option><option>Campaign</option><option>Finance</option><option>Service</option><option>General</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Channel</label>
                  <select name="channel" className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20">
                    {channels.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Content *</label>
                <textarea name="content" required rows={4} placeholder="Use {name}, {project}, {amount} as placeholders..." className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowTemplate(false)} className="flex-1 px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 shadow-sm">Save Template</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
