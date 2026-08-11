import { useSearchParams } from 'react-router-dom';
import WhatsAppInbox from '../components/WhatsAppInbox';
import { useAuth } from '../context/AuthContext';

/**
 * Messages IS the WhatsApp inbox.
 *
 * This page used to carry a second, simulated in-app thread alongside it —
 * conversations and chatMessages held in localStorage, with faked customer
 * replies. It had no server tables behind it, so in the live workspace it was
 * permanently empty while sitting next to real conversations, which read as a
 * broken feature rather than an absent one. It went out with demo mode.
 */
export default function Messages() {
  const { tenant } = useAuth();
  const tenantId = tenant?.id || '';

  // Deep link from a lead's Synced Actions: /messages?lead=<id> preselects that
  // conversation in the inbox.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkLeadId = searchParams.get('lead') ?? undefined;
  const clearDeepLink = () => setSearchParams(prev => {
    const next = new URLSearchParams(prev); next.delete('lead'); return next;
  }, { replace: true });

  return (
    <div className="space-y-4 max-w-[1200px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">WhatsApp</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Every WhatsApp conversation with your leads, in one inbox.</p>
        </div>
      </div>
      <WhatsAppInbox tenantId={tenantId} deepLinkLeadId={deepLinkLeadId} onDeepLinkConsumed={clearDeepLink} />
    </div>
  );
}
