import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Brain, Send, Sparkles, RefreshCw, Copy, ThumbsUp, ThumbsDown,
  FileText, Megaphone, MessageSquare, Bell, Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getByTenant, create, logAudit } from '../services/db';
import { formatCurrency, currencySymbol, localeFor } from '../utils/format';
import type { Lead, Project, Campaign } from '../types';
import toast from 'react-hot-toast';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  type?: 'text' | 'draft';
  timestamp: string;
}

const quickPrompts = [
  { icon: MessageSquare, label: 'Follow-up message', prompt: 'Generate a WhatsApp follow-up message for a lead who visited our site 3 days ago' },
  { icon: Bell, label: 'Visit reminder', prompt: "Create a site visit reminder for tomorrow's scheduled visits" },
  { icon: Megaphone, label: 'Campaign draft', prompt: 'Draft a launch campaign for our newest project' },
  { icon: FileText, label: 'Payment nudge', prompt: 'Write a polite payment reminder for a booking installment due next week' },
  { icon: Sparkles, label: 'Lead re-engagement', prompt: "Create a re-engagement message for cold leads who haven't responded in 2 weeks" },
  { icon: Zap, label: 'Broker message', prompt: 'Draft a message for channel partners about our new inventory release' },
];

export default function AIStudio() {
  const { tenant, user } = useAuth();
  const navigate = useNavigate();
  const tenantId = tenant?.id || '';
  const appLocale = localeFor(tenant?.currency);
  const userId = user?.id || '';
  const isExecutive = user?.role === 'sales_executive';

  const allLeadsData = useMemo(() => getByTenant<Lead>('leads', tenantId), [tenantId]);
  // Role-based filtering: executives only see their assigned leads
  const leads = useMemo(
    () => isExecutive ? allLeadsData.filter(l => l.assignedTo === userId) : allLeadsData,
    [allLeadsData, isExecutive, userId]
  );
  const projects = useMemo(() => getByTenant<Project>('projects', tenantId), [tenantId]);

  const currency = tenant?.currency || 'INR';
  const brandName = tenant?.name || 'Friendly CRM';
  const brandVoice = tenant?.brandVoice || 'Professional and trustworthy.';
  const channels = tenant?.channels || ['WhatsApp', 'Email'];
  const activeLeads = leads.filter(l => l.stage !== 'lost' && l.stage !== 'booked').length;

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `👋 Hello ${user?.name?.split(' ')[0] || 'there'}! I'm your AI Growth assistant, tuned to **${brandName}**'s brand voice.\n\nI can help you:\n• Generate follow-up messages for leads\n• Draft campaign copy for launches\n• Create visit reminders & payment nudges\n• Suggest next-best actions for your pipeline\n\nJust tell me what you need, or pick a template below.`,
      type: 'text',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const generateAIResponse = (userPrompt: string): string => {
    const lower = userPrompt.toLowerCase();
    const firstProject = projects[0];
    const projectName = firstProject?.name || 'our project';
    const projectLocation = firstProject?.location || 'prime location';

    if (lower.includes('follow-up') || lower.includes('followup') || lower.includes('follow up')) {
      const lead = leads.find(l => l.stage === 'visit_scheduled' || l.stage === 'contacted') || leads[0];
      const leadName = lead?.name || '[Lead Name]';
      const leadProject = lead?.project || projectName;
      const config = lead?.configuration || '2/3 BHK';
      return `Here's a follow-up draft for **${leadName}** at **${leadProject}**:\n\n---\n\nHi ${leadName.split(' ')[0]},\n\nIt was great connecting with you about your home search. At ${brandName}, we're committed to finding the perfect space for your family.\n\nI wanted to check in — would you like to visit **${leadProject}** this weekend? We have some beautiful ${config} options I think you'll love.\n\nLooking forward to hearing from you!\n\nWarm regards,\n${brandName} Team\n\n---\n\n💡 **Next best action:** Schedule a site visit within 48 hours — leads who visit within a week are 3x more likely to convert.`;
    }

    if (lower.includes('visit') && (lower.includes('reminder') || lower.includes('site'))) {
      return `Here's a site visit reminder template:\n\n---\n\nHi [Name],\n\nA friendly reminder about your site visit to **${projectName}** tomorrow at [Time].\n\nOur team will be ready to show you around. Here's what to expect:\n\n🏠 Guided tour of sample flats\n📋 Floor plan walkthrough\n💰 Payment plan discussion\n\n📍 Location: ${projectLocation}\n⏱️ Duration: ~45 minutes\n\nNeed to reschedule? Just reply to this message.\n\nSee you tomorrow!\n${brandName} Team\n\n---\n\n💡 **Tip:** Send this 24 hours before and again 2 hours before the visit for best attendance.`;
    }

    if (lower.includes('campaign') || lower.includes('launch')) {
      // Only quote a price when the project actually has one — no invented figures
      const priceMin = firstProject?.priceRange?.[0];
      const priceLine = priceMin ? `\n✨ Starting ${formatCurrency(priceMin, currency)} onwards` : '';
      const reraLine = tenant?.rera ? '\n✨ RERA Approved' : '';
      return `Here's a launch campaign draft for **${projectName}**:\n\n---\n\n🏗️ **INTRODUCING ${projectName.toUpperCase()}**\n\nWhere every sunrise feels like your own private show.\n\n✨ Premium Residences${priceLine}${reraLine}\n\n**Why ${projectName}?**\n🔹 ${projectLocation}\n🔹 Lifestyle amenities & open spaces\n🔹 Flexible payment plans\n\n📞 **Book your priority site visit:** [Number]\n\n*Limited period launch offer*\n\n---\n\n💡 **Suggested channels:** ${channels.slice(0, 3).join(' + ')}\n💡 **Best send time:** Thursday 10 AM or Saturday 11 AM`;
    }

    if (lower.includes('payment') || lower.includes('nudge') || lower.includes('installment')) {
      return `Here's a polite payment reminder draft:\n\n---\n\nHi [Name],\n\nHope you and your family are doing well! 😊\n\nThis is a gentle reminder that your next installment of **${currencySymbol(currency).trim()} [Amount]** for your ${projectName} booking is due by **[Date]**.\n\nTo make the payment:\n📱 UPI: [UPI ID]\n🏦 NEFT: [Account Details]\n💳 Online: [Payment Link]\n\nYour payment plan and receipts are always available on your customer portal. Need any help? I'm just a call away.\n\nThank you for choosing ${brandName}!\n\nBest,\n${brandName} Team\n\n---\n\n💡 **Automation tip:** Set up auto-reminders at 7 days, 3 days, and 1 day before due date for best collection rates.`;
    }

    if (lower.includes('broker') || lower.includes('channel') || lower.includes('partner')) {
      const priceMin = firstProject?.priceRange?.[0];
      const priceMax = firstProject?.priceRange?.[1];
      const priceLine = priceMin && priceMax ? `\n💰 **Price Range:** ${formatCurrency(priceMin, currency)} - ${formatCurrency(priceMax, currency)}` : '';
      return `Here's a channel partner broadcast:\n\n---\n\n📢 **New Inventory Alert — ${projectName}**\n\nDear Partners,\n\nWe've just released new units at ${projectName}. Hot-selling inventory with attractive partner incentives.\n\n🏢 **Project:** ${projectName}\n📍 **Location:** ${projectLocation}${priceLine}\n💵 **Partner Payout:** 2% on booking\n\n📋 **Inventory list & rate card attached.**\n\nLet's close some deals this month! 🚀\n\n---\n\n💡 **Pro tip:** Share unit-wise availability matrix with partners for faster conversions.`;
    }

    // Re-engagement default
    return `Here's a re-engagement message for cold leads:\n\n---\n\nHi [Name],\n\nIt's been a while since we last spoke! A lot has changed at ${projectName} — we have some exciting new inventory that might interest you.\n\nTo give you a quick update:\n✨ New 2/3 BHK units now available\n✨ Special pricing for this quarter\n✨ Flexible payment plans available\n\nWould you be open to a quick 5-minute call to explore your options? No pressure, just exploring possibilities.\n\nCheers,\n${brandName} Team\n\n---\n\n💡 **Best practice:** Send re-engagement messages between Tuesday-Thursday, 10 AM - 2 PM for highest response rates.`;
  };

  const handleSend = (promptOverride?: string) => {
    const prompt = (promptOverride || input).trim();
    if (!prompt) return;

    const userMsg: Message = {
      id: Date.now().toString(), role: 'user', content: prompt,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsGenerating(true);

    setTimeout(() => {
      const response = generateAIResponse(prompt);
      const aiMsg: Message = {
        id: (Date.now() + 1).toString(), role: 'assistant',
        content: response, type: 'draft',
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, aiMsg]);
      setIsGenerating(false);
    }, 1000);
  };

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content);
    toast.success('Copied to clipboard');
  };

  const handleSaveCampaign = (content: string) => {
    if (!tenant) return;
    const created = create<Campaign>('campaigns', {
      id: '', tenantId, name: `AI Draft ${new Date().toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' })}`,
      type: 'AI Generated', status: 'draft',
      audience: 'To be selected', channel: channels[0] || 'WhatsApp',
      content, createdAt: new Date().toISOString(),
    });
    if (user) logAudit({ tenantId, userId: user.id, userName: user.name, action: 'create', entity: 'campaign', entityId: created.id, details: 'Saved AI-generated draft as campaign' });
    toast.custom(() => (
      <div className="bg-zinc-900 text-white rounded-xl px-4 py-3 shadow-lg flex items-center gap-3 text-sm">
        <span>Saved as campaign draft</span>
        <button onClick={() => navigate('/campaigns')} className="text-indigo-300 font-semibold hover:text-indigo-200">View →</button>
      </div>
    ));
  };

  return (
    <div className="flex gap-0 h-[calc(100vh-120px)] max-w-full">
      <div className="flex-1 flex flex-col bg-white rounded-2xl border border-zinc-200/60 overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-100 flex items-center gap-3 bg-zinc-50/50">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
            <Brain className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-900">AI Growth Assistant</p>
            <p className="text-[11px] text-zinc-500">Tuned to {brandName} brand voice</p>
          </div>
          <div className="flex-1" />
          <span className="text-[10px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Online
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                msg.role === 'user' ? 'bg-indigo-600 text-white' :
                msg.type === 'draft' ? 'bg-zinc-50 border border-zinc-200' : 'bg-zinc-50 text-zinc-800'
              }`}>
                {msg.type === 'draft' ? (
                  <div>
                    <div className="whitespace-pre-wrap text-sm text-zinc-700">{msg.content}</div>
                    <div className="flex items-center gap-2 mt-3 pt-2 border-t border-zinc-200 flex-wrap">
                      <button onClick={() => handleCopy(msg.content)} className="flex items-center gap-1 px-2.5 py-1.5 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition-colors">
                        <Copy className="h-3 w-3" /> Copy
                      </button>
                      <button onClick={() => {
                        const latestUserPrompt = [...messages].reverse().find(m => m.role === 'user')?.content;
                        if (latestUserPrompt) handleSend(latestUserPrompt);
                      }} className="flex items-center gap-1 px-2.5 py-1.5 bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition-colors">
                        <RefreshCw className="h-3 w-3" /> Regenerate
                      </button>
                      <button onClick={() => handleSaveCampaign(msg.content)} className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-100 transition-colors">
                        <Send className="h-3 w-3" /> Save as Campaign
                      </button>
                      <div className="flex-1" />
                      <button onClick={() => toast.success('Thanks for the feedback!')} className="p-1.5 text-zinc-400 hover:text-emerald-600"><ThumbsUp className="h-3.5 w-3.5" /></button>
                      <button onClick={() => toast.success('Feedback noted')} className="p-1.5 text-zinc-400 hover:text-red-500"><ThumbsDown className="h-3.5 w-3.5" /></button>
                    </div>
                    <p className="mt-2 text-[10px] text-zinc-400 flex items-center gap-1">
                      <Sparkles className="h-2.5 w-2.5" /> AI-generated draft — review for accuracy before sending.
                    </p>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
                )}
                <p className={`text-[10px] mt-1.5 ${msg.role === 'user' ? 'text-indigo-200' : 'text-zinc-400'}`}>
                  {new Date(msg.timestamp).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
          {isGenerating && (
            <div className="flex justify-start">
              <div className="bg-zinc-50 rounded-2xl px-4 py-3 flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-zinc-400 animate-bounce" />
                  <span className="h-2 w-2 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-xs text-zinc-500">Generating...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="px-4 py-3 border-t border-zinc-100">
          <div className="flex items-center gap-2 bg-zinc-50 rounded-xl border border-zinc-200 p-1.5 focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-300 transition-all">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="Ask me to draft a message, create a campaign, or suggest follow-ups..."
              className="flex-1 px-2 py-2 bg-transparent text-sm focus:outline-none placeholder:text-zinc-400"
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || isGenerating}
              className="p-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="w-72 shrink-0 ml-4 space-y-4 overflow-y-auto">
        <div className="bg-white rounded-xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-indigo-500" />
            <h4 className="text-sm font-semibold text-zinc-800">Brand Voice</h4>
          </div>
          <p className="text-xs text-zinc-500 leading-relaxed">{brandVoice}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {channels.map(ch => (
              <span key={ch} className="text-[10px] font-medium bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">{ch}</span>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-4 w-4 text-amber-500" />
            <h4 className="text-sm font-semibold text-zinc-800">Quick Templates</h4>
          </div>
          <div className="space-y-1.5">
            {quickPrompts.map((qp, i) => (
              <button
                key={i}
                onClick={() => handleSend(qp.prompt)}
                disabled={isGenerating}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-zinc-50 transition-colors text-left group disabled:opacity-50"
              >
                <div className="h-7 w-7 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0 group-hover:bg-indigo-50 transition-colors">
                  <qp.icon className="h-3.5 w-3.5 text-zinc-500 group-hover:text-indigo-500 transition-colors" />
                </div>
                <span className="text-xs font-medium text-zinc-700 group-hover:text-zinc-900">{qp.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-zinc-200/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain className="h-4 w-4 text-violet-500" />
            <h4 className="text-sm font-semibold text-zinc-800">AI Context</h4>
          </div>
          <div className="space-y-2 text-xs text-zinc-600">
            <div className="flex justify-between">
              <span>Active Leads</span>
              <span className="font-semibold text-zinc-900">{activeLeads}</span>
            </div>
            <div className="flex justify-between">
              <span>Projects</span>
              <span className="font-semibold text-zinc-900">{projects.length}</span>
            </div>
            <div className="flex justify-between">
              <span>Total Leads</span>
              <span className="font-semibold text-zinc-900">{leads.length}</span>
            </div>
            <div className="flex justify-between">
              <span>Brand Voice</span>
              <span className="font-semibold text-emerald-600">Active</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
