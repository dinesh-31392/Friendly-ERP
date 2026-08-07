/**
 * Unified WhatsApp outbound — the single adapter every "message this lead on
 * WhatsApp" path goes through. It resolves the tenant's active provider and
 * returns HOW the message was (or should be) delivered, so the lead/campaign UI
 * never hard-codes a channel.
 *
 * Two providers behind one interface (the adapter pattern):
 *
 *  • click_to_chat  — the DEFAULT, and free. Opens wa.me / WhatsApp with the
 *    number + a prefilled message; the agent sends from their OWN WhatsApp.
 *    One-to-one, agent-initiated, fully ToS-compliant (no automation, no session
 *    storage, no ban risk). Right for messaging the leads who are interested.
 *
 *  • meta_cloud_waba — the paid, official upgrade for automation + bulk. Active
 *    once a tenant saves Meta Cloud API credentials (Settings → server config).
 *    Dispatch runs SERVER-SIDE via /api/whatsapp/send (the token never touches
 *    the browser); if the API can't deliver we always hand back a click-to-chat
 *    link so the agent is never blocked.
 *
 * A future provider = a new server driver + a new case — no lead/campaign screen
 * changes.
 */
import type { Tenant } from '../types';
import { getIntegrationStates } from './integrationService';
import { whatsappHref } from '../utils/contact';
import { isApiEnabled, apiSendWhatsApp } from './apiClient';

export type WhatsAppProvider = 'click_to_chat' | 'meta_cloud_waba' | 'evolution';

export interface WhatsAppSend {
  provider: WhatsAppProvider;
  /** true when the message was dispatched server-side via the Meta Cloud API. */
  delivered: boolean;
  /** A wa.me link to open. Present whenever the agent must send manually (free
   *  mode, or a paid-path fallback). Absent once delivered via the API. */
  link?: string;
  messageId?: string;
  /** Set when the paid path failed and we fell back to the link. */
  error?: string;
}

/** Demo-mode provider read (localStorage integration). In API mode the server
 *  is the source of truth, so callers use whatsappSend() instead. */
export function whatsappProvider(tenantId: string): WhatsAppProvider {
  if (!tenantId) return 'click_to_chat';
  const states = getIntegrationStates(tenantId);
  return states['whatsapp_business']?.connected ? 'meta_cloud_waba' : 'click_to_chat';
}

/**
 * Send one WhatsApp message through the tenant's active provider.
 *  - API mode: the server resolves the provider. Meta Cloud API → delivered
 *    server-side; otherwise it returns a click-to-chat link. On any API error we
 *    fall back to a locally-built link so the agent can still reach the lead.
 *  - Demo mode: always a click-to-chat link (no backend to dispatch through).
 */
export async function whatsappSend(opts: { tenantId: string; phone: string; text?: string; leadId?: string }): Promise<WhatsAppSend> {
  const fallbackLink = whatsappHref(opts.phone, opts.text);
  if (!isApiEnabled()) {
    return { provider: whatsappProvider(opts.tenantId), delivered: false, link: fallbackLink };
  }
  try {
    const r = await apiSendWhatsApp(opts.phone, opts.text ?? '', opts.leadId);
    return { provider: r.provider, delivered: r.delivered, link: r.link, messageId: r.messageId };
  } catch (err) {
    // Paid path rejected (bad token, 24h window, unreachable) — never block the
    // agent: hand back the free click-to-chat link.
    return { provider: 'click_to_chat', delivered: false, link: fallbackLink, error: err instanceof Error ? err.message : 'WhatsApp API error' };
  }
}

/** Human label for the active provider — for the Settings/Integrations UI. */
export function whatsappProviderLabel(tenant?: Tenant | null): string {
  return whatsappProvider(tenant?.id || '') === 'meta_cloud_waba'
    ? 'WhatsApp Business API (Meta Cloud) — automation & bulk'
    : 'Free — Click to Chat (agent sends from their own WhatsApp)';
}
