import { useState, useEffect, useCallback } from 'react';
import { Download, Trash2, ShieldCheck, Database, AlertTriangle, Users, Lock } from 'lucide-react';
import {
  isApiEnabled, apiWhatsappStorageSummary, apiWhatsappExport, apiWhatsappDeleteChats,
  apiWhatsappConversations, apiSaveWhatsAppInstance,
  type WhatsAppStorageSummary, type WhatsAppConversation,
} from '../services/apiClient';
import toast from 'react-hot-toast';

/**
 * Settings → Data Storage. What WhatsApp history this account holds, how to
 * take it away as a file, and how to erase it.
 *
 * Everything here is scoped exactly like the inbox: while the workspace is
 * 'private' (the default), a rep only ever sees, exports or deletes the
 * conversations their OWN linked number carried. Export can therefore never
 * become a way around chat privacy.
 */

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function WhatsAppStoragePanel() {
  const [summary, setSummary] = useState<WhatsAppStorageSummary | null>(null);
  const [convs, setConvs] = useState<WhatsAppConversation[]>([]);
  const [busy, setBusy] = useState(false);
  const [scopeLead, setScopeLead] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [deleteMode, setDeleteMode] = useState<'conversation' | 'older'>('conversation');
  const [olderDays, setOlderDays] = useState('365');
  const [retention, setRetention] = useState('');

  const load = useCallback(async () => {
    if (!isApiEnabled()) return;
    try {
      const s = await apiWhatsappStorageSummary();
      setSummary(s);
      setRetention(s.retentionDays ? String(s.retentionDays) : '');
      setConvs(await apiWhatsappConversations().catch(() => []));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load storage usage');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const download = async (format: 'csv' | 'json') => {
    setBusy(true);
    try {
      const { blob, filename } = await apiWhatsappExport({
        format,
        leadId: scopeLead || undefined,
        from: from || undefined,
        to: to || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally { setBusy(false); }
  };

  const erase = async () => {
    if (confirmText !== 'DELETE') { toast.error('Type DELETE to confirm'); return; }
    if (deleteMode === 'conversation' && !scopeLead) { toast.error('Pick a conversation first'); return; }
    setBusy(true);
    try {
      const res = await apiWhatsappDeleteChats(
        deleteMode === 'conversation' ? { leadId: scopeLead } : { olderThanDays: Number(olderDays) || 0 });
      toast.success(`Deleted ${res.deleted} message${res.deleted === 1 ? '' : 's'}`);
      setConfirmText('');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally { setBusy(false); }
  };

  const saveSettings = async (patch: { chatVisibility?: 'private' | 'team'; retentionDays?: number | null }) => {
    setBusy(true);
    try {
      await apiSaveWhatsAppInstance({ provider: 'evolution', ...patch });
      toast.success('Saved');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally { setBusy(false); }
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-8 text-center">
        <Database className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
        <h3 className="text-base font-semibold text-zinc-700">Data storage needs the live workspace</h3>
        <p className="text-sm text-zinc-500 mt-1 max-w-md mx-auto">
          Chat history lives on your workspace's server. Sign in to the live workspace to review, export or erase it.
        </p>
      </div>
    );
  }

  const inputCls = 'px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20';

  return (
    <div className="space-y-4">
      {/* usage */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
        <div className="flex items-center gap-2 mb-4">
          <Database className="h-4 w-4 text-emerald-600" />
          <h3 className="text-base font-semibold text-zinc-900">WhatsApp data you hold</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Conversations', value: summary?.conversations ?? '—' },
            { label: 'Messages', value: summary?.messages ?? '—' },
            { label: 'Stored text', value: summary ? fmtBytes(summary.bytes) : '—' },
            { label: 'Oldest message', value: fmtDate(summary?.oldest) },
          ].map(s => (
            <div key={s.label} className="bg-zinc-50 rounded-xl p-3">
              <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">{s.label}</p>
              <p className="text-lg font-bold text-zinc-900 mt-0.5">{s.value}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-3 flex items-center gap-1.5">
          {summary?.visibility === 'team'
            ? <><Users className="h-3.5 w-3.5" /> Workspace chats are shared — these totals cover the whole team.</>
            : <><Lock className="h-3.5 w-3.5" /> Chats are private — these totals cover only conversations from your own WhatsApp.</>}
        </p>
      </div>

      {/* export */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
        <div className="flex items-center gap-2 mb-1">
          <Download className="h-4 w-4 text-indigo-600" />
          <h3 className="text-base font-semibold text-zinc-900">Download your chats</h3>
        </div>
        <p className="text-sm text-zinc-500 mb-4">
          One row per message, with date, lead, phone, direction and text. Keep a copy before you erase anything.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Conversation</label>
            <select value={scopeLead} onChange={e => setScopeLead(e.target.value)} className={inputCls}>
              <option value="">All conversations</option>
              {convs.map(c => <option key={c.leadId} value={c.leadId}>{c.name} ({c.messageCount})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className={inputCls} />
          </div>
          <button onClick={() => download('csv')} disabled={busy}
            className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
            Download CSV
          </button>
          <button onClick={() => download('json')} disabled={busy}
            className="px-4 py-2 bg-white border border-zinc-200 text-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">
            JSON
          </button>
        </div>
      </div>

      {/* privacy + retention */}
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-6">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <h3 className="text-base font-semibold text-zinc-900">Privacy &amp; retention</h3>
        </div>
        <p className="text-sm text-zinc-500 mb-4">
          Each rep links their own phone, so conversations are personal by default.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium text-zinc-800">Who can read a conversation</p>
              <p className="text-xs text-zinc-500">
                Private: only the rep whose number carried it. Shared: anyone on the team who can see the lead.
              </p>
            </div>
            <div className="flex gap-2">
              {(['private', 'team'] as const).map(v => (
                <button
                  key={v}
                  disabled={busy || !summary?.canManage}
                  onClick={() => saveSettings({ chatVisibility: v })}
                  className={`px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 ${
                    summary?.visibility === v ? 'bg-emerald-600 text-white' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                  }`}
                >
                  {v === 'private' ? 'Private' : 'Shared with team'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap border-t border-zinc-100 pt-3">
            <div>
              <p className="text-sm font-medium text-zinc-800">Auto-delete old messages</p>
              <p className="text-xs text-zinc-500">Leave blank to keep chats forever. Applied as your inbox loads.</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number" min={0} max={3650} value={retention} placeholder="days"
                onChange={e => setRetention(e.target.value)}
                className={`${inputCls} w-28`} disabled={!summary?.canManage}
              />
              <button
                disabled={busy || !summary?.canManage}
                onClick={() => saveSettings({ retentionDays: retention.trim() === '' ? null : Number(retention) })}
                className="px-3 py-2 bg-zinc-800 text-white rounded-xl text-sm font-semibold hover:bg-zinc-900 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
        {!summary?.canManage && (
          <p className="text-xs text-zinc-400 mt-3">Only a workspace admin can change these.</p>
        )}
      </div>

      {/* delete */}
      <div className="bg-white rounded-2xl border border-red-200 p-6">
        <div className="flex items-center gap-2 mb-1">
          <Trash2 className="h-4 w-4 text-red-600" />
          <h3 className="text-base font-semibold text-red-700">Erase chat history</h3>
        </div>
        <p className="text-sm text-zinc-600 mb-1">
          This permanently removes messages from the ERP. There is no undo and no backup — download first.
        </p>
        <p className="text-xs text-zinc-500 mb-4 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          It does not delete anything from WhatsApp itself, and it never touches notes, calls or site visits.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">What to erase</label>
            <select value={deleteMode} onChange={e => setDeleteMode(e.target.value as 'conversation' | 'older')} className={inputCls}>
              <option value="conversation">One conversation (selected above)</option>
              <option value="older">Everything older than…</option>
            </select>
          </div>
          {deleteMode === 'older' && (
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Days</label>
              <input type="number" min={0} max={3650} value={olderDays}
                onChange={e => setOlderDays(e.target.value)} className={`${inputCls} w-28`} />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase mb-1">Type DELETE</label>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)}
              autoComplete="off" placeholder="DELETE" className={`${inputCls} w-32`} />
          </div>
          <button onClick={erase} disabled={busy || confirmText !== 'DELETE'}
            className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-40">
            Erase permanently
          </button>
        </div>
      </div>
    </div>
  );
}
