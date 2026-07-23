import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Bot, Settings2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getIntegrationStates } from '../services/integrationService';

/**
 * Internal route that surfaces the connected Chatbot Engine's own admin
 * portal inside the CRM (iframe). Many portals send X-Frame-Options /
 * frame-ancestors and refuse to embed — the "Open in New Tab" path always
 * works, and we detect the block with a load timeout.
 */
export default function ChatbotPortal() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id || '';
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [likelyBlocked, setLikelyBlocked] = useState(false);

  // If the frame hasn't loaded within 8s, assume the portal refuses embedding
  useEffect(() => {
    if (frameLoaded) return;
    const t = setTimeout(() => setLikelyBlocked(true), 8000);
    return () => clearTimeout(t);
  }, [frameLoaded]);

  const portalUrl = useMemo(() => {
    const state = getIntegrationStates(tenantId)['chatbot_engine'];
    const raw = state?.connected ? (state.config.portalUrl || '') : '';
    // Only ever render http(s). The portal URL is tenant-configurable, so a
    // `javascript:` (or `data:`) value would otherwise execute in the CRM's
    // own origin the moment the link is clicked or the iframe loads — a
    // stored-XSS sink. Anything that isn't a valid http(s) URL is dropped.
    if (!raw) return '';
    try {
      const u = new URL(raw);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
    } catch { return ''; }
  }, [tenantId]);

  return (
    <div className="h-full flex flex-col space-y-4 max-w-[1200px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/settings" className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h2 className="text-2xl font-bold text-zinc-900 flex items-center gap-2">
              <Bot className="h-6 w-6 text-indigo-500" /> Chatbot Engine
            </h2>
            <p className="text-sm text-zinc-500 mt-0.5">Manage your AI chatbot flows, training data, and conversations.</p>
          </div>
        </div>
        {portalUrl && (
          <a
            href={portalUrl}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
          >
            <ExternalLink className="h-4 w-4" /> Open Portal in New Tab
          </a>
        )}
      </div>

      {!portalUrl ? (
        <div className="flex-1 bg-white rounded-2xl border border-zinc-200/60 flex flex-col items-center justify-center py-20 text-center px-6">
          <Bot className="h-12 w-12 text-zinc-300 mb-3" />
          <h3 className="text-lg font-semibold text-zinc-700">Chatbot Engine not connected</h3>
          <p className="text-sm text-zinc-500 mt-1 max-w-md">
            Connect the Chatbot Engine in Settings → Integrations with your portal URL and API key, then manage it from here.
          </p>
          <Link
            to="/settings"
            className="mt-5 flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
          >
            <Settings2 className="h-4 w-4" /> Go to Integrations
          </Link>
        </div>
      ) : (
        <div className="flex-1 bg-white rounded-2xl border border-zinc-200/60 overflow-hidden relative min-h-[560px]">
          {!frameLoaded && (
            <div className="absolute inset-0 z-10 bg-white flex flex-col items-center justify-center gap-3 text-center px-6">
              {likelyBlocked ? (
                <>
                  <Bot className="h-10 w-10 text-zinc-300" />
                  <p className="text-sm font-medium text-zinc-700">This portal refuses to be embedded</p>
                  <p className="text-xs text-zinc-400 max-w-sm">
                    It sends X-Frame-Options / frame-ancestors headers. Use "Open Portal in New Tab" above — it always works.
                  </p>
                  <a
                    href={portalUrl} target="_blank" rel="noopener noreferrer"
                    className="mt-2 flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700"
                  >
                    <ExternalLink className="h-4 w-4" /> Open Portal in New Tab
                  </a>
                </>
              ) : (
                <>
                  <span className="h-8 w-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
                  <p className="text-sm text-zinc-500">Loading chatbot portal…</p>
                </>
              )}
            </div>
          )}
          <iframe
            src={portalUrl}
            title="Chatbot Engine Portal"
            className="w-full h-full min-h-[560px]"
            onLoad={() => setFrameLoaded(true)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      )}
    </div>
  );
}
