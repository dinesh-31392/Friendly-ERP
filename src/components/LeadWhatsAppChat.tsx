import { X, MessageCircle } from 'lucide-react';
import WhatsAppThread from './WhatsAppThread';
import type { Lead } from '../types';

/**
 * Slide-over WhatsApp conversation for one lead, opened from the Leads page.
 * The conversation itself lives in WhatsAppThread — shared with the Messages
 * inbox — so this component is only the drawer chrome.
 */
export default function LeadWhatsAppChat({ lead, tenantId, onClose }: {
  lead: Lead; tenantId: string; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label={`WhatsApp chat with ${lead.name}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-[#efeae2] flex flex-col shadow-2xl">
        <div className="bg-emerald-700 text-white px-4 py-3 flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center font-semibold">
            {lead.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{lead.name}</p>
            <p className="text-[11px] text-emerald-100 truncate">{lead.phone}{lead.project ? ` · ${lead.project}` : ''}</p>
          </div>
          <MessageCircle className="h-4 w-4 text-emerald-200" />
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg" aria-label="Close chat">
            <X className="h-4 w-4" />
          </button>
        </div>

        <WhatsAppThread leadId={lead.id} phone={lead.phone} tenantId={tenantId} />
      </div>
    </div>
  );
}
