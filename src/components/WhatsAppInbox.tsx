import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, MessageCircle, ArrowLeft, ExternalLink, RefreshCw, PenSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { isApiEnabled, apiWhatsappConversations, type WhatsAppConversation } from '../services/apiClient';
import { inboxStamp } from '../services/whatsappThread';
import WhatsAppThread from './WhatsAppThread';
import NewChatPicker from './NewChatPicker';

/**
 * WhatsApp inbox — every conversation across all leads in one place, the way
 * a rep actually works a day: list on the left (newest first, customers who
 * replied badged), the live thread on the right.
 *
 * The list comes from GET /api/whatsapp/conversations, which the server scopes
 * by RLS + lead ownership (an executive sees only their own leads). It refreshes
 * every 10s so new inbound conversations surface on their own; the open thread
 * polls at 5s independently.
 */
export default function WhatsAppInbox({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const [convs, setConvs] = useState<WhatsAppConversation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setConvs(await apiWhatsappConversations());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load conversations');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = convs ?? [];
    if (!q) return rows;
    return rows.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.phone.replace(/\D/g, '').includes(q.replace(/\D/g, '')) ||
      c.lastMessage.toLowerCase().includes(q));
  }, [convs, search]);

  // A conversation started from the picker has no history yet, so it isn't in
  // `convs` — it lives here until its first message lands.
  const [draftConv, setDraftConv] = useState<WhatsAppConversation | null>(null);
  const [picking, setPicking] = useState(false);

  // Keep a selection alive across refreshes; default to the newest thread.
  // A freshly-started chat isn't in `convs` yet, so it must NOT be reset here.
  useEffect(() => {
    if (!convs?.length) return;
    if (draftConv && draftConv.leadId === selectedId) return;
    if (!selectedId || !convs.some(c => c.leadId === selectedId)) setSelectedId(convs[0].leadId);
  }, [convs, selectedId, draftConv]);

  // Once the first message lands the conversation is real — drop the draft so
  // the list row becomes the source of truth.
  useEffect(() => {
    if (draftConv && convs?.some(c => c.leadId === draftConv.leadId)) setDraftConv(null);
  }, [convs, draftConv]);

  const selected = (draftConv && draftConv.leadId === selectedId)
    ? draftConv
    : filtered.find(c => c.leadId === selectedId) ?? convs?.find(c => c.leadId === selectedId) ?? null;
  const awaiting = (convs ?? []).filter(c => c.awaitingReply).length;

  const startChat = (lead: { id: string; name: string; phone: string; project?: string; stage?: string }) => {
    setDraftConv({
      leadId: lead.id, name: lead.name, phone: lead.phone,
      project: lead.project ?? '', stage: lead.stage ?? '',
      lastMessage: '', lastAt: new Date().toISOString(),
      lastFromCustomer: false, awaitingReply: false, messageCount: 0,
    });
    setSelectedId(lead.id);
    setPicking(false);
  };

  if (!isApiEnabled()) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200/60 p-10 text-center">
        <MessageCircle className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
        <h3 className="text-base font-semibold text-zinc-700">WhatsApp inbox needs the server</h3>
        <p className="text-sm text-zinc-500 mt-1 max-w-sm mx-auto">
          Conversations are stored on your workspace's server. Sign in to the live workspace to see them here.
        </p>
      </div>
    );
  }

  if (convs === null && !error) {
    return <div className="bg-white rounded-2xl border border-zinc-200/60 p-10 text-center text-sm text-zinc-500">Loading conversations…</div>;
  }

  // Nothing yet AND nothing being drafted — offer the picker right here rather
  // than sending the user off to the Leads page to start their first chat.
  if (convs?.length === 0 && !draftConv) {
    return (
      <>
        <div className="bg-white rounded-2xl border border-zinc-200/60 p-10 text-center">
          <MessageCircle className="h-10 w-10 text-emerald-200 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-zinc-700">No WhatsApp conversations yet</h3>
          <p className="text-sm text-zinc-500 mt-1 max-w-md mx-auto">
            Start one with any lead — every message you send and receive will appear here.
          </p>
          <div className="flex items-center justify-center gap-2 mt-4">
            <button onClick={() => setPicking(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700">
              <PenSquare className="h-3.5 w-3.5" /> Start a chat
            </button>
            <button onClick={() => navigate('/leads')}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-zinc-200 text-zinc-600 rounded-xl text-sm font-semibold hover:bg-zinc-50">
              Go to Leads <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {picking && <NewChatPicker onPick={startChat} onClose={() => setPicking(false)} />}
      </>
    );
  }

  return (
    <div className="flex h-[calc(100vh-190px)] min-h-[420px] rounded-2xl border border-zinc-200/60 overflow-hidden bg-white">
      {/* conversation list */}
      <div className={`w-full lg:w-80 shrink-0 border-r border-zinc-200/60 flex flex-col ${selected ? 'hidden lg:flex' : 'flex'}`}>
        <div className="p-3 border-b border-zinc-100 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-zinc-800">
              Chats <span className="text-zinc-400 font-normal">({convs?.length ?? 0})</span>
            </p>
            <div className="flex items-center gap-2">
              {awaiting > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
                  {awaiting} awaiting reply
                </span>
              )}
              <button onClick={() => setPicking(true)} className="p-1 text-emerald-600 hover:text-emerald-700" aria-label="Start a new chat" title="Start a new chat">
                <PenSquare className="h-3.5 w-3.5" />
              </button>
              <button onClick={load} className="p-1 text-zinc-400 hover:text-zinc-600" aria-label="Refresh">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search name, number or message"
              className="w-full pl-9 pr-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="text-center text-sm text-zinc-400 py-8">No chats match “{search}”.</p>
          )}
          {filtered.map(c => (
            <button
              key={c.leadId}
              onClick={() => setSelectedId(c.leadId)}
              className={`w-full text-left px-3 py-3 border-b border-zinc-50 hover:bg-zinc-50 transition-colors ${
                c.leadId === selectedId ? 'bg-emerald-50/60' : ''
              }`}
            >
              <div className="flex items-start gap-2.5">
                <div className="h-9 w-9 shrink-0 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-sm font-semibold">
                  {c.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-semibold text-zinc-800 truncate flex-1">{c.name}</p>
                    <span className="text-[10px] text-zinc-400 shrink-0">{inboxStamp(c.lastAt)}</span>
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${c.awaitingReply ? 'text-zinc-800 font-medium' : 'text-zinc-500'}`}>
                    {!c.lastFromCustomer && <span className="text-zinc-400">You: </span>}
                    {c.lastMessage}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    {c.awaitingReply && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                    <span className="text-[10px] text-zinc-400">{c.messageCount} message{c.messageCount === 1 ? '' : 's'}</span>
                    {c.project && <span className="text-[10px] text-zinc-400 truncate">· {c.project}</span>}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* thread */}
      <div className={`flex-1 flex flex-col min-w-0 ${selected ? 'flex' : 'hidden lg:flex'}`}>
        {selected ? (
          <>
            <div className="bg-emerald-700 text-white px-4 py-3 flex items-center gap-3 shrink-0">
              <button onClick={() => setSelectedId(null)} className="lg:hidden p-1 hover:bg-white/10 rounded-lg" aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center font-semibold">
                {selected.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{selected.name}</p>
                <p className="text-[11px] text-emerald-100 truncate">
                  {selected.phone}{selected.project ? ` · ${selected.project}` : ''}
                </p>
              </div>
              <button
                onClick={() => navigate(`/leads?lead=${selected.leadId}`)}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-[11px] font-semibold"
                title="Open this lead"
              >
                Lead <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            <WhatsAppThread
              leadId={selected.leadId}
              phone={selected.phone}
              tenantId={tenantId}
              onActivity={load}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center bg-[#efeae2] text-center px-6">
            <MessageCircle className="h-10 w-10 text-emerald-600/40 mb-3" />
            <p className="text-sm text-zinc-600">Pick a conversation to read and reply.</p>
          </div>
        )}
      </div>

      {picking && <NewChatPicker onPick={startChat} onClose={() => setPicking(false)} />}

      {error && (
        <p className="absolute bottom-2 left-2 text-[11px] text-red-500 bg-white px-2 py-1 rounded-lg shadow">{error}</p>
      )}
    </div>
  );
}
