import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Link2, X, Copy, Zap, Globe, RefreshCw, CheckCircle2, Bot } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  INTEGRATION_PROVIDERS, getIntegrationStates, connectIntegration,
  disconnectIntegration, syncLeadsFromProvider, getWebhookInfo,
  getWebsiteFormSnippet, getChatbotSnippet, getChatbotNextJsInstructions, ingestLead,
} from '../services/integrationService';
import type { IntegrationProviderDef } from '../services/integrationService';
import { isApiEnabled, apiSaveWhatsAppInstance } from '../services/apiClient';
import MyWhatsAppCard from './MyWhatsAppCard';

function timeAgo(iso?: string): string {
  if (!iso) return 'Never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function copyToClipboard(text: string, label: string) {
  navigator.clipboard.writeText(text)
    .then(() => toast.success(`${label} copied to clipboard`))
    .catch(() => toast.error('Could not copy — select and copy manually'));
}

export default function IntegrationsPanel() {
  const { user, tenant, hasPermission } = useAuth();
  const tenantId = tenant?.id || '';
  const canManage = hasPermission('manage_settings');
  const actor = user ? { id: user.id, name: user.name } : undefined;

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);
  const [configuring, setConfiguring] = useState<IntegrationProviderDef | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const [showChatbotSnippet, setShowChatbotSnippet] = useState(false);

  const states = useMemo(() => getIntegrationStates(tenantId), [tenantId, refreshKey]);
  // Keyed on the SLUG, not the tenant id: the public capture endpoint resolves
  // the workspace by slug, which is also what every generated snippet carries.
  const slug = tenant?.slug || '';
  const webhook = useMemo(() => getWebhookInfo(slug), [slug]);
  const connectedCount = INTEGRATION_PROVIDERS.filter(p => states[p.id]?.connected).length;

  const handleConnectSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!configuring || !canManage) return;
    const fd = new FormData(e.currentTarget);
    const config: Record<string, string> = {};
    let missing = false;
    configuring.configFields.forEach(f => {
      const v = (fd.get(f.key) as string || '').trim();
      if (!v) missing = true;
      config[f.key] = v;
    });
    if (missing) { toast.error('Please fill in all fields'); return; }
    connectIntegration(tenantId, configuring.id, config, actor);
    // WhatsApp Business: in API mode the Meta creds must live SERVER-side (the
    // token never persists in the browser), so also register the instance there,
    // flipping the tenant's WhatsApp adapter to the paid Cloud API path.
    if (configuring.id === 'whatsapp_business' && isApiEnabled()) {
      apiSaveWhatsAppInstance({
        provider: 'meta_cloud_waba', phoneNumberId: config.phoneNumberId, accessToken: config.apiToken,
      }).catch(() => toast.error('Saved locally, but the server WhatsApp config failed — retry in Settings'));
    }
    toast.success(`${configuring.name} connected`);
    setConfiguring(null);
    refresh();
  };

  const handleConnect = (provider: IntegrationProviderDef) => {
    if (!canManage) { toast.error('You do not have permission to manage integrations'); return; }
    if (provider.configFields.length === 0) {
      // Webhook-based providers (Zapier/Pabbly) connect instantly
      connectIntegration(tenantId, provider.id, {}, actor);
      toast.success(`${provider.name} connected — point it at the inbound webhook below`);
      refresh();
    } else {
      setConfiguring(provider);
    }
  };

  const handleDisconnect = (provider: IntegrationProviderDef) => {
    if (!canManage) { toast.error('You do not have permission to manage integrations'); return; }
    if (!confirm(`Disconnect ${provider.name}? Lead sync from this source will stop.`)) return;
    disconnectIntegration(tenantId, provider.id, actor);
    // Revert the WhatsApp adapter to the free click-to-chat path server-side too.
    if (provider.id === 'whatsapp_business' && isApiEnabled()) {
      apiSaveWhatsAppInstance({ provider: 'click_to_chat' }).catch(() => {});
    }
    toast.success(`${provider.name} disconnected`);
    refresh();
  };

  const handleSync = (provider: IntegrationProviderDef) => {
    if (!canManage) { toast.error('You do not have permission to manage integrations'); return; }
    const created = syncLeadsFromProvider(tenantId, provider.id, actor);
    if (created.length === 0) {
      toast('No new leads found on this sync', { icon: 'ℹ️' });
    } else {
      toast.success(`Imported ${created.length} new lead(s) from ${provider.name} — see the Leads page`);
    }
    refresh();
  };

  const handleTestWebhook = () => {
    if (!canManage) { toast.error('You do not have permission to manage integrations'); return; }
    const payload = JSON.parse(webhook.samplePayload);
    const lead = ingestLead(tenantId, payload);
    toast.success(`Test payload accepted — lead "${lead.name}" created`);
    refresh();
  };

  const renderCard = (provider: IntegrationProviderDef) => {
    const state = states[provider.id];
    const connected = !!state?.connected;
    return (
      <div
        key={provider.id}
        className={`border rounded-xl p-4 transition-colors ${connected ? 'border-emerald-200 bg-emerald-50/30 hover:border-emerald-300' : 'border-zinc-200 hover:border-indigo-200'}`}
      >
        <div className="flex items-start justify-between mb-2">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center text-xl ${connected ? 'bg-gradient-to-br from-emerald-100 to-teal-100' : 'bg-gradient-to-br from-indigo-50 to-violet-50'}`}>
            {provider.icon}
          </div>
          {connected ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Active
            </span>
          ) : (
            <button
              onClick={() => handleConnect(provider)}
              className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
            >
              Connect
            </button>
          )}
        </div>
        <p className="text-sm font-semibold text-zinc-900">{provider.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{provider.description}</p>
        {connected && (
          <>
            <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-500">
              <span>Last sync: {timeAgo(state.lastSyncAt)}</span>
              {provider.leadSource && <span className="font-medium text-emerald-700">{state.leadsImported || 0} leads imported</span>}
            </div>
            <div className="flex gap-2 mt-3">
              {provider.leadSource && !provider.webhookBased && (
                <button
                  onClick={() => handleSync(provider)}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-white border border-emerald-200 text-emerald-700 rounded-lg text-xs font-medium hover:bg-emerald-50"
                >
                  <RefreshCw className="h-3 w-3" /> Sync Leads Now
                </button>
              )}
              {provider.id === 'website_forms' && (
                <button
                  onClick={() => setShowSnippet(true)}
                  className="flex-1 px-2 py-1.5 bg-white border border-indigo-200 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50"
                >
                  Get Form Code
                </button>
              )}
              {provider.id === 'chatbot_engine' && (
                <>
                  <Link
                    to="/integrations/chatbot"
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-white border border-indigo-200 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50"
                  >
                    <Bot className="h-3 w-3" /> Chatbot Builder
                  </Link>
                  <button
                    onClick={() => setShowChatbotSnippet(true)}
                    className="flex-1 px-2 py-1.5 bg-white border border-indigo-200 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-50"
                  >
                    Embed Snippet
                  </button>
                </>
              )}
              <button
                onClick={() => handleDisconnect(provider)}
                className="px-2 py-1.5 bg-white border border-zinc-200 text-zinc-500 rounded-lg text-xs font-medium hover:bg-red-50 hover:text-red-600 hover:border-red-200"
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const leadSources = INTEGRATION_PROVIDERS.filter(p => p.category === 'lead_source' && !p.group);
  const portals = INTEGRATION_PROVIDERS.filter(p => p.group === 'Property Portals');
  const automation = INTEGRATION_PROVIDERS.filter(p => p.category === 'automation');
  const other = INTEGRATION_PROVIDERS.filter(p => p.category === 'other');

  return (
    <div className="space-y-4">
    {/* Per-rep WhatsApp session — every rep links their own number here */}
    <MyWhatsAppCard />
    <div className="bg-white rounded-2xl border border-zinc-200/60 p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-900">Integrations</h3>
          <p className="text-sm text-zinc-500 mt-0.5">
            Connect your lead sources and tools. {connectedCount} of {INTEGRATION_PROVIDERS.length} connected.
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg">
          <Link2 className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">{connectedCount} active</span>
        </div>
      </div>

      {/* Lead sources */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5" /> Lead Sources
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {leadSources.map(renderCard)}
        </div>
      </div>

      {/* Property portals */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">🏢 Property Portals</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {portals.map(renderCard)}
        </div>
      </div>

      {/* Automation */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5" /> Automation
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {automation.map(renderCard)}
        </div>

        {/* Inbound webhook — the integration point for Zapier / Pabbly / website */}
        <div className="mt-3 bg-gradient-to-br from-zinc-50 to-zinc-100 rounded-xl p-4 border border-zinc-200">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">🔗</span>
              <div>
                <p className="text-sm font-semibold text-zinc-900">Inbound Lead Webhook</p>
                <p className="text-xs text-zinc-500">Point Zapier, Pabbly, or your website form at this endpoint. New leads land in your pipeline automatically.</p>
              </div>
            </div>
            <button
              onClick={handleTestWebhook}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Send Test Payload
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <code className="flex-1 px-3 py-2 bg-white border border-zinc-200 rounded-lg text-[11px] text-zinc-700 overflow-x-auto whitespace-nowrap">
              POST {webhook.url}
            </code>
            <button
              onClick={() => copyToClipboard(webhook.url, 'Webhook URL')}
              className="p-2 bg-white border border-zinc-200 rounded-lg text-zinc-500 hover:text-indigo-600 hover:border-indigo-200"
              title="Copy webhook URL"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <details className="mt-3">
            <summary className="text-xs font-medium text-indigo-600 cursor-pointer hover:text-indigo-700">View sample JSON payload</summary>
            <div className="relative mt-2">
              <pre className="p-3 bg-zinc-900 text-zinc-100 rounded-lg text-[11px] overflow-x-auto">{webhook.samplePayload}</pre>
              <button
                onClick={() => copyToClipboard(webhook.samplePayload, 'Sample payload')}
                className="absolute top-2 right-2 p-1.5 bg-zinc-800 rounded-lg text-zinc-400 hover:text-white"
                title="Copy sample payload"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </details>
        </div>
      </div>

      {/* Other tools */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Other Tools</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {other.map(renderCard)}
        </div>
      </div>

      {/* Connect / configure modal */}
      {configuring && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConfiguring(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
                <span className="text-xl">{configuring.icon}</span> Connect {configuring.name}
              </h3>
              <button onClick={() => setConfiguring(null)} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-4">{configuring.description}</p>
            <form onSubmit={handleConnectSubmit} className="space-y-3">
              {configuring.configFields.map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">{f.label}</label>
                  <input
                    name={f.key}
                    type={f.type || 'text'}
                    placeholder={f.placeholder}
                    className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                </div>
              ))}
              <p className="text-[11px] text-zinc-400 bg-zinc-50 rounded-lg p-2.5">
                Credentials are stored locally in this demo build. In production they are sent to your backend and never kept in the browser.
              </p>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setConfiguring(null)} className="flex-1 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50">
                  Cancel
                </button>
                <button type="submit" className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700">
                  Connect
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Chatbot embed snippet modal */}
      {showChatbotSnippet && (() => {
        const snippet = getChatbotSnippet(slug, { primaryColor: tenant?.primaryColor, brandName: tenant?.name });
        const nextJs = getChatbotNextJsInstructions(slug);
        return (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowChatbotSnippet(false)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
                  <Bot className="h-5 w-5 text-indigo-500" /> Website Chatbot Snippet
                </h3>
                <button onClick={() => setShowChatbotSnippet(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs text-zinc-500 mb-3">
                Paste this on any website or landing page. Captured chats POST to your lead-capture
                endpoint and appear instantly as leads with source <strong>Chatbot</strong>, scored like any other inbound lead.
              </p>
              <pre className="p-3 bg-zinc-900 text-zinc-100 rounded-lg text-[11px] overflow-x-auto">{snippet}</pre>
              <button
                onClick={() => copyToClipboard(snippet, 'Chatbot snippet')}
                className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
              >
                <Copy className="h-4 w-4" /> Copy Snippet
              </button>

              <p className="text-xs font-semibold text-zinc-700 mt-4 mb-2">Installing on a Next.js site (e.g. your Vercel landing page):</p>
              <pre className="p-3 bg-zinc-50 border border-zinc-200 text-zinc-700 rounded-lg text-[11px] overflow-x-auto">{nextJs}</pre>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => copyToClipboard(nextJs, 'Next.js instructions')}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50"
                >
                  <Copy className="h-4 w-4" /> Copy Next.js Setup
                </button>
                <button
                  onClick={() => {
                    const lead = ingestLead(tenantId, {
                      name: 'Chat Visitor (Test)', phone: '+91 90000 55555',
                      email: 'chat.test@email.com', source: 'Chatbot',
                      budget: 9000000, configuration: '2 BHK',
                      message: 'Chatbot test: interested in 2BHK, budget 90L, visiting this weekend',
                    });
                    toast.success(`Test chat lead "${lead.name}" captured — check the Leads page`);
                    refresh();
                  }}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700"
                >
                  Send Test Chat Lead
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Website form snippet modal */}
      {showSnippet && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowSnippet(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-semibold text-zinc-900">🌐 Website Enquiry Form</h3>
              <button onClick={() => setShowSnippet(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-zinc-500 mb-3">Paste this snippet on your website. Submissions post to your inbound webhook and appear as new leads with source "Website".</p>
            <pre className="p-3 bg-zinc-900 text-zinc-100 rounded-lg text-[11px] overflow-x-auto max-h-64">{getWebsiteFormSnippet(slug)}</pre>
            <button
              onClick={() => copyToClipboard(getWebsiteFormSnippet(slug), 'Form snippet')}
              className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
            >
              <Copy className="h-4 w-4" /> Copy Snippet
            </button>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
