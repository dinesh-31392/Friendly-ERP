import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, Send, Paperclip, Phone, MoreHorizontal, MessageSquare } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import WhatsAppInbox from '../components/WhatsAppInbox';
import { isApiEnabled } from '../services/apiClient';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, update } from '../services/db';
import { localeFor } from '../utils/format';
import { telHref, whatsappHref } from '../utils/contact';
import type { Conversation, ChatMessage, Lead } from '../types';
import toast from 'react-hot-toast';

const channelIcons: Record<string, string> = { whatsapp: '💬', email: '📧', sms: '📱' };

export default function Messages() {
  const { user, tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const appLocale = localeFor(tenant?.currency);
  const userId = user?.id || '';
  const isExecutive = user?.role === 'sales_executive';
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);
  // Deep link from a lead's Synced Actions: /messages?lead=<id> preselects
  // that conversation in the inbox.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkLeadId = searchParams.get('lead') ?? undefined;
  const clearDeepLink = () => setSearchParams(prev => {
    const next = new URLSearchParams(prev); next.delete('lead'); return next;
  }, { replace: true });

  const leads = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId, refreshKey]);
  const visibleLeadIds = useMemo(
    () => isExecutive ? new Set(leads.filter(l => l.assignedTo === userId).map(l => l.id)) : null,
    [isExecutive, leads, userId]
  );

  const conversations = useMemo(() => {
    const rows = getByTenant<Conversation>('conversations', tenantId)
      .filter(c => !visibleLeadIds || visibleLeadIds.has(c.leadId))
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return rows;
  }, [tenantId, refreshKey, visibleLeadIds]);

  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedConvId && conversations.length > 0) {
      const first = conversations[0];
      setSelectedConvId(first.id);
      // Auto-selecting opens the thread, so clear its unread badge too
      if (first.unread > 0) {
        update<Conversation>('conversations', first.id, { unread: 0 });
        refresh();
      }
    }
    if (selectedConvId && !conversations.some(c => c.id === selectedConvId)) {
      setSelectedConvId(conversations[0]?.id || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, selectedConvId]);

  // Tracks the live selection so delayed callbacks don't act on a stale value
  const selectedConvIdRef = useRef(selectedConvId);
  selectedConvIdRef.current = selectedConvId;

  // Pending simulated-reply timers — cleared on unmount so nothing writes to
  // storage (or re-renders) after navigation/logout
  const replyTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => () => {
    replyTimers.current.forEach(clearTimeout);
    replyTimers.current.clear();
  }, []);

  const selectedConv = conversations.find(c => c.id === selectedConvId);

  const convMessages = useMemo(() => {
    if (!selectedConvId) return [];
    return getByTenant<ChatMessage>('chatMessages', tenantId)
      .filter(m => m.conversationId === selectedConvId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [selectedConvId, tenantId, refreshKey]);

  const filteredConvs = conversations.filter(c =>
    c.leadName.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [convMessages.length]);

  const handleSelectConv = (convId: string) => {
    setSelectedConvId(convId);
    const conv = conversations.find(c => c.id === convId);
    if (conv && conv.unread > 0) {
      update<Conversation>('conversations', convId, { unread: 0 });
      refresh();
    }
  };

  const handleSendMessage = () => {
    if (!messageInput.trim() || !selectedConv || !user) return;

    const content = messageInput.trim();
    create<ChatMessage>('chatMessages', {
      id: '', tenantId, conversationId: selectedConv.id,
      senderId: user.id, content,
      timestamp: new Date().toISOString(),
    });

    update<Conversation>('conversations', selectedConv.id, {
      lastMsg: content,
      time: new Date().toISOString(),
    });

    // Sync 3: Log WhatsApp/Email activity to respective Lead dynamically
    if (selectedConv.leadId) {
      create<any>('activities', {
        id: '', tenantId, leadId: selectedConv.leadId, userId: user.id,
        type: selectedConv.channel === 'email' ? 'email' : 'whatsapp',
        description: `Sent message: "${content}"`,
        createdAt: new Date().toISOString(),
      });
    }

    setMessageInput('');
    refresh();
    toast.success('Message sent');

    const timer = setTimeout(() => {
      replyTimers.current.delete(timer);
      // Never write for a session that ended while the reply was pending
      if (!localStorage.getItem('friendly_crm_auth')) return;
      const replies = [
        'Thanks for the info!', 'Great, will get back to you.',
        'Can you share more details?', 'Sounds good, thanks!',
        'When can we meet?', 'What are the payment options?',
      ];
      const reply = replies[Math.floor(Math.random() * replies.length)];
      create<ChatMessage>('chatMessages', {
        id: '', tenantId, conversationId: selectedConv.id,
        senderId: selectedConv.leadId, content: reply,
        timestamp: new Date().toISOString(),
      });
      update<Conversation>('conversations', selectedConv.id, {
        lastMsg: reply, time: new Date().toISOString(),
        // Don't mark unread if the user is still viewing this thread
        unread: selectedConvIdRef.current === selectedConv.id ? 0 : 1,
      });

      // Sync 3 reply: log the inbound message as a system activity — it came
      // from the lead, not from a staff member
      if (selectedConv.leadId) {
        create<any>('activities', {
          id: '', tenantId, leadId: selectedConv.leadId, userId: '',
          type: selectedConv.channel === 'email' ? 'email' : 'whatsapp',
          description: `Received reply: "${reply}"`,
          createdAt: new Date().toISOString(),
        });
      }
      refresh();
    }, 2500);
    replyTimers.current.add(timer);
  };

  // In the live workspace Messages IS the WhatsApp inbox. The simulated in-app
  // thread below is demo-only scaffolding — it has no server tables and fakes
  // customer replies, so offering it beside real conversations was misleading.
  if (isApiEnabled()) {
    return (
      <div className="space-y-4 max-w-[1200px]">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-bold text-zinc-900">Messages</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Every WhatsApp conversation with your leads, in one inbox.</p>
          </div>
        </div>
        <WhatsAppInbox tenantId={tenantId} deepLinkLeadId={deepLinkLeadId} onDeepLinkConsumed={clearDeepLink} />
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="space-y-4">
          <div className="flex flex-col items-center justify-center py-20 text-center">
          <MessageSquare className="h-12 w-12 text-zinc-300 mb-4" />
          <h3 className="text-lg font-semibold text-zinc-700 mb-1">No Conversations Yet</h3>
          <p className="text-sm text-zinc-500 max-w-sm">Your customer conversations will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-[1200px]">
    <div className="flex gap-0 h-[calc(100vh-170px)] flex-col lg:flex-row">
      <div className="w-full lg:w-80 shrink-0 bg-white rounded-t-2xl lg:rounded-l-2xl lg:rounded-tr-none border border-zinc-200/60 lg:border-r-0 overflow-hidden flex flex-col">
        <div className="p-4 border-b border-zinc-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="w-full pl-9 pr-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto max-h-72 lg:max-h-none">
          {filteredConvs.map(conv => (
            <button
              key={conv.id}
              onClick={() => handleSelectConv(conv.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 border-b border-zinc-50 text-left hover:bg-zinc-50 transition-colors ${selectedConvId === conv.id ? 'bg-indigo-50/50' : ''}`}
            >
              <div className="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-teal-600">{conv.leadName.split(' ').map(n => n[0]).join('')}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-zinc-900 truncate">{conv.leadName}</p>
                  <span className="text-[10px] text-zinc-400 shrink-0 ml-2">
                    {new Date(conv.time).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 truncate">{channelIcons[conv.channel]} {conv.lastMsg}</p>
              </div>
              {conv.unread > 0 && (
                <span className="h-5 w-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">{conv.unread}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {selectedConv ? (
        <div className="flex-1 bg-white rounded-b-2xl lg:rounded-r-2xl lg:rounded-bl-none border border-zinc-200/60 overflow-hidden flex flex-col min-h-[480px]">
          <div className="px-4 py-3 border-b border-zinc-100 flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center">
              <span className="text-xs font-bold text-teal-600">{selectedConv.leadName.split(' ').map(n => n[0]).join('')}</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-900">{selectedConv.leadName}</p>
              <p className="text-[11px] text-zinc-500">Via {selectedConv.channel} · Active now</p>
            </div>
            <div className="flex-1" />
            <button
              onClick={() => {
                const lead = leads.find(l => l.id === selectedConv.leadId);
                if (!lead?.phone) { toast.error('No phone number on file for this contact'); return; }
                toast.success(`Opening dialer for ${lead.phone}...`);
                window.location.href = telHref(lead.phone);
              }}
              title="Call via device dialer"
              className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"
            ><Phone className="h-4 w-4" /></button>
            <button
              onClick={() => {
                const lead = leads.find(l => l.id === selectedConv.leadId);
                if (!lead?.phone) { toast.error('No phone number on file for this contact'); return; }
                window.open(whatsappHref(lead.phone), '_blank', 'noopener');
              }}
              title="Open in WhatsApp"
              className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"
            ><MessageSquare className="h-4 w-4" /></button>
            <button className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"><MoreHorizontal className="h-4 w-4" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="text-center">
              <span className="text-[11px] font-medium text-zinc-400 bg-zinc-100 px-3 py-1 rounded-full">Conversation</span>
            </div>
            {convMessages.map(msg => {
              const isMe = msg.senderId === user?.id;
              return (
                <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] lg:max-w-[60%] rounded-2xl px-4 py-2.5 ${isMe ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-zinc-100 rounded-bl-md'}`}>
                    <p className={`text-sm ${isMe ? 'text-white' : 'text-zinc-700'}`}>{msg.content}</p>
                    <p className={`text-[10px] mt-1 text-right ${isMe ? 'text-indigo-200' : 'text-zinc-400'}`}>
                      {new Date(msg.timestamp).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              );
            })}
            {convMessages.length === 0 && (
              <div className="text-center py-8 text-sm text-zinc-400">No messages yet. Start the conversation!</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-4 py-3 border-t border-zinc-100">
            <div className="flex items-center gap-2 bg-zinc-50 rounded-xl border border-zinc-200 p-1.5">
              <button className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"><Paperclip className="h-4 w-4" /></button>
              <input
                value={messageInput}
                onChange={e => setMessageInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                placeholder="Type a message..."
                className="flex-1 px-2 py-2 bg-transparent text-sm focus:outline-none placeholder:text-zinc-400"
              />
              <button
                onClick={handleSendMessage}
                disabled={!messageInput.trim()}
                className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 bg-white rounded-b-2xl lg:rounded-r-2xl lg:rounded-bl-none border border-zinc-200/60 flex items-center justify-center min-h-[480px]">
          <p className="text-sm text-zinc-400">Select a conversation to start</p>
        </div>
      )}
    </div>
    </div>
  );
}
