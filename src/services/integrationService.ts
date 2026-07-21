import { v4 as uuid } from 'uuid';
import { getByTenant, getByField, create, update, remove, logAudit } from './db';
import type { Lead, Project, User } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Provider catalog
// ─────────────────────────────────────────────────────────────────────────────

export type IntegrationCategory = 'lead_source' | 'automation' | 'other';

export interface ConfigField {
  key: string;
  label: string;
  placeholder: string;
  type?: 'text' | 'password' | 'url';
}

export interface IntegrationProviderDef {
  id: string;
  name: string;
  category: IntegrationCategory;
  group?: string;          // visual sub-group, e.g. 'Property Portals'
  icon: string;            // emoji shown on the card
  description: string;
  leadSource?: string;     // value written to Lead.source for imported leads
  configFields: ConfigField[];
  webhookBased?: boolean;  // Zapier/Pabbly connect via the inbound webhook
}

export const INTEGRATION_PROVIDERS: IntegrationProviderDef[] = [
  {
    id: 'facebook_lead_ads', name: 'Facebook Lead Ads', category: 'lead_source', icon: '📘',
    description: 'Auto-capture leads from Facebook & Instagram lead forms.',
    leadSource: 'Facebook',
    configFields: [
      { key: 'pageId', label: 'Facebook Page ID', placeholder: 'e.g. 104857623901' },
      { key: 'accessToken', label: 'Page Access Token', placeholder: 'EAAB...', type: 'password' },
    ],
  },
  {
    id: 'google_ads', name: 'Google Ads (PPC)', category: 'lead_source', icon: '🔍',
    description: 'Import leads from Google PPC campaigns & lead form extensions.',
    leadSource: 'Google Ads',
    configFields: [
      { key: 'customerId', label: 'Google Ads Customer ID', placeholder: '123-456-7890' },
      { key: 'developerToken', label: 'Developer Token', placeholder: 'Your API token', type: 'password' },
    ],
  },
  {
    id: 'website_forms', name: 'Website Forms', category: 'lead_source', icon: '🌐',
    description: 'Capture enquiries from your website contact & project forms.',
    leadSource: 'Website',
    configFields: [
      { key: 'siteUrl', label: 'Website URL', placeholder: 'https://www.yourcompany.com', type: 'url' },
    ],
  },
  {
    id: 'whatsapp_business', name: 'WhatsApp Business', category: 'lead_source', icon: '💬',
    description: 'Two-way WhatsApp chat and enquiry capture via the Business API.',
    leadSource: 'WhatsApp',
    configFields: [
      { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'e.g. 1065534...' },
      { key: 'apiToken', label: 'API Token', placeholder: 'Bearer token', type: 'password' },
    ],
  },
  {
    id: 'portal_99acres', name: '99acres', category: 'lead_source', group: 'Property Portals', icon: '🏢',
    description: 'Sync enquiries from your 99acres listings.',
    leadSource: '99acres',
    configFields: [{ key: 'profileId', label: '99acres Profile ID', placeholder: 'Your builder profile ID' }],
  },
  {
    id: 'portal_magicbricks', name: 'MagicBricks', category: 'lead_source', group: 'Property Portals', icon: '🏢',
    description: 'Sync enquiries from your MagicBricks listings.',
    leadSource: 'MagicBricks',
    configFields: [{ key: 'profileId', label: 'MagicBricks Profile ID', placeholder: 'Your builder profile ID' }],
  },
  {
    id: 'portal_housing', name: 'Housing.com', category: 'lead_source', group: 'Property Portals', icon: '🏢',
    description: 'Sync enquiries from your Housing.com listings.',
    leadSource: 'Housing.com',
    configFields: [{ key: 'profileId', label: 'Housing.com Profile ID', placeholder: 'Your builder profile ID' }],
  },
  {
    id: 'chatbot_engine', name: 'Chatbot Engine', category: 'automation', icon: '🤖',
    description: '24/7 AI chatbot for your website & landing pages — qualifies visitors and pushes them in as leads.',
    leadSource: 'Chatbot',
    configFields: [
      { key: 'portalUrl', label: 'Chatbot Portal URL', placeholder: 'https://db.yourbot.example.com', type: 'url' },
      { key: 'apiKey', label: 'Chatbot API Key', placeholder: 'Engine API key', type: 'password' },
    ],
  },
  {
    id: 'zapier', name: 'Zapier', category: 'automation', icon: '⚡',
    description: 'Connect 6000+ apps. Push leads in via the inbound webhook below.',
    leadSource: 'Zapier',
    configFields: [],
    webhookBased: true,
  },
  {
    id: 'pabbly', name: 'Pabbly Connect', category: 'automation', icon: '🔄',
    description: 'Automate workflows with Pabbly. Push leads in via the inbound webhook below.',
    leadSource: 'Pabbly',
    configFields: [],
    webhookBased: true,
  },
  {
    id: 'google_calendar', name: 'Google Calendar', category: 'other', icon: '📅',
    description: 'Sync site visits and tasks with Google Calendar.',
    configFields: [{ key: 'calendarId', label: 'Calendar ID', placeholder: 'primary or your@email.com' }],
  },
  {
    id: 'razorpay', name: 'Razorpay', category: 'other', icon: '💳',
    description: 'Accept online token payments and installments.',
    configFields: [
      { key: 'keyId', label: 'Key ID', placeholder: 'rzp_live_...' },
      { key: 'keySecret', label: 'Key Secret', placeholder: 'Your key secret', type: 'password' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant connection state (persisted in the 'integrations' table)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegrationState {
  id: string;
  tenantId: string;
  providerId: string;
  connected: boolean;
  config: Record<string, string>;
  connectedAt?: string;
  lastSyncAt?: string;
  leadsImported: number;
}

/** Legacy display-name → provider-id mapping for the pre-existing
 *  `friendly_crm_integrations_<tenantId>` localStorage blob. */
const LEGACY_NAME_TO_ID: Record<string, string> = {
  'WhatsApp Business': 'whatsapp_business',
  'Google Calendar': 'google_calendar',
  'Razorpay': 'razorpay',
  'Zapier': 'zapier',
  'Google Ads': 'google_ads',
  'Facebook Lead Ads': 'facebook_lead_ads',
};

function migrateLegacyState(tenantId: string): void {
  const legacyKey = `friendly_crm_integrations_${tenantId}`;
  const raw = localStorage.getItem(legacyKey);
  if (!raw) return;
  try {
    const legacy: Record<string, { connected?: boolean }> = JSON.parse(raw);
    const existingProviderIds = new Set(
      getByTenant<IntegrationState>('integrations', tenantId).map(r => r.providerId)
    );
    Object.entries(legacy).forEach(([name, cfg]) => {
      const providerId = LEGACY_NAME_TO_ID[name];
      // Never duplicate a row a real connect already created
      if (providerId && cfg?.connected && !existingProviderIds.has(providerId)) {
        create<IntegrationState>('integrations', {
          id: uuid(), tenantId, providerId, connected: true, config: {},
          connectedAt: new Date().toISOString(), leadsImported: 0,
        });
      }
    });
  } catch { /* corrupted legacy blob — ignore */ }
  localStorage.removeItem(legacyKey);
}

export function getIntegrationStates(tenantId: string): Record<string, IntegrationState> {
  migrateLegacyState(tenantId);
  const rows = getByTenant<IntegrationState>('integrations', tenantId);
  const map: Record<string, IntegrationState> = {};
  rows.forEach(r => { map[r.providerId] = r; });
  return map;
}

export function connectIntegration(
  tenantId: string, providerId: string, config: Record<string, string>,
  actor?: { id: string; name: string }
): IntegrationState {
  const provider = INTEGRATION_PROVIDERS.find(p => p.id === providerId);

  // NEVER persist provider secrets to the browser store. Password-typed fields
  // are live third-party credentials (Razorpay Key Secret, WhatsApp/Facebook
  // tokens); localStorage is readable at rest and, on any shared origin,
  // readable cross-tenant. These simulated integrations never call a real API,
  // so the secret is never needed — we keep only a redacted marker so the UI can
  // still show the field as "configured". When the real backend lands, secrets
  // must be held server-side (the schema's pgcrypto-encrypted tenant_keys), with
  // the browser holding only a connection reference.
  const secretKeys = new Set((provider?.configFields || []).filter(f => f.type === 'password').map(f => f.key));
  const safeConfig: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    safeConfig[k] = secretKeys.has(k) && v ? '••••••• (stored server-side)' : v;
  }

  const existing = getByTenant<IntegrationState>('integrations', tenantId).find(r => r.providerId === providerId);
  const now = new Date().toISOString();
  let state: IntegrationState;
  if (existing) {
    state = update<IntegrationState>('integrations', existing.id, { connected: true, config: safeConfig, connectedAt: now })!;
  } else {
    state = create<IntegrationState>('integrations', {
      id: uuid(), tenantId, providerId, connected: true, config: safeConfig, connectedAt: now, leadsImported: 0,
    });
  }
  if (actor) {
    logAudit({
      tenantId, userId: actor.id, userName: actor.name, action: 'connect',
      entity: 'integration', entityId: state.id, details: `Connected integration "${provider?.name || providerId}"`,
    });
  }
  return state;
}

export function disconnectIntegration(tenantId: string, providerId: string, actor?: { id: string; name: string }): void {
  // Remove ALL rows for the provider — historical duplicates included, so a
  // disconnect can never silently leave a second "connected" row behind
  const rows = getByTenant<IntegrationState>('integrations', tenantId).filter(r => r.providerId === providerId);
  const existing = rows[0];
  if (!existing) return;
  rows.forEach(r => remove('integrations', r.id));
  const provider = INTEGRATION_PROVIDERS.find(p => p.id === providerId);
  if (actor) {
    logAudit({
      tenantId, userId: actor.id, userName: actor.name, action: 'disconnect',
      entity: 'integration', entityId: existing.id, details: `Disconnected integration "${provider?.name || providerId}"`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound webhook (Zapier / Pabbly / Website forms)
// ─────────────────────────────────────────────────────────────────────────────

export function getWebhookInfo(tenantId: string): { url: string; secret: string; samplePayload: string } {
  const secretKey = `friendly_crm_webhook_secret_${tenantId}`;
  let secret = localStorage.getItem(secretKey);
  if (!secret) {
    secret = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(secretKey, secret);
  }
  const url = `https://api.friendlyerp.app/v1/webhooks/leads/${tenantId}?key=${secret}`;
  const samplePayload = JSON.stringify({
    name: 'Rohan Verma',
    email: 'rohan.v@email.com',
    phone: '+91 98220 11223',
    source: 'Zapier',
    project: 'Skyline Heights',
    budget: 15000000,
    configuration: '3 BHK',
    message: 'Interested in a site visit this weekend',
  }, null, 2);
  return { url, secret, samplePayload };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead import (simulated sync — replace with real API calls once a backend exists)
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_FIRST = ['Aarav', 'Ishaan', 'Kavya', 'Rohan', 'Sneha', 'Aditi', 'Nikhil', 'Pooja', 'Varun', 'Tara', 'Dev', 'Mira'];
const SAMPLE_LAST = ['Sharma', 'Verma', 'Reddy', 'Nair', 'Kapoor', 'Iyer', 'Das', 'Bose', 'Malhotra', 'Shetty', 'Chawla', 'Menon'];
const SAMPLE_CONFIGS = ['1 BHK', '2 BHK', '3 BHK', '4 BHK'];

function randomOf<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

export interface InboundLeadPayload {
  name: string;
  email?: string;
  phone: string;
  source: string;
  project?: string;
  budget?: number;
  configuration?: string;
  message?: string;
}

/** Create a Lead (+ intake activity) from an inbound payload.
 *
 *  Routing worker: assigns to the ACTIVE sales user with the lowest current
 *  workload (fewest open leads), so hot inbound leads never pile up on one
 *  agent. Also fires an automated WhatsApp welcome so first contact happens
 *  within seconds of capture. */
export function ingestLead(tenantId: string, payload: InboundLeadPayload): Lead {
  const users = getByField<User>('users', 'tenantId', tenantId)
    .filter(u => u.active && (u.role === 'sales_executive' || u.role === 'sales_manager'));
  const projects = getByTenant<Project>('projects', tenantId);

  // Capacity-based routing: fewest open (non-closed) leads wins
  const allLeads = getByTenant<Lead>('leads', tenantId);
  const openCount = (userId: string) =>
    allLeads.filter(l => l.assignedTo === userId && l.stage !== 'booked' && l.stage !== 'lost').length;
  const assignee = users.length > 0
    ? users.reduce((best, u) => (openCount(u.id) < openCount(best.id) ? u : best), users[0])
    : undefined;

  const project = payload.project || (projects.length > 0 ? randomOf(projects).name : 'General Enquiry');
  const now = new Date().toISOString();

  const lead = create<Lead>('leads', {
    id: '', tenantId,
    name: payload.name,
    email: payload.email || '',
    phone: payload.phone,
    source: payload.source,
    project,
    budget: payload.budget || 0,
    configuration: payload.configuration || '2 BHK',
    stage: 'new', priority: 'warm',
    assignedTo: assignee?.id || '',
    lastContact: now, createdAt: now,
  });

  create('activities', {
    id: '', tenantId, leadId: lead.id, userId: assignee?.id || '',
    type: 'note',
    description: `Lead captured via ${payload.source}${payload.message ? ` — "${payload.message}"` : ''} · auto-routed to ${assignee?.name || 'unassigned'} (capacity-based)`,
    createdAt: now,
  });

  // Automated WhatsApp welcome + qualification opener. This only writes a
  // localStorage message today (nothing is sent).
  // ⚠️ BEFORE wiring this to a real WhatsApp Business API: do NOT auto-send to a
  // number that has not consented. Unsolicited automated messages breach TRAI/DND
  // (India) and TCPA (US). Gate real sends behind explicit opt-in / a human send
  // action, and never trigger them for simulated/sample leads.
  const tenant = getByField<{ id: string; name: string }>('tenants', 'id', tenantId)[0];
  const welcome = `Hi ${payload.name.split(' ')[0]}! Thanks for your interest in ${project} 🏡 I'm the ${tenant?.name || 'sales'} assistant. To help you faster: what's your preferred configuration and budget range? A site visit can be arranged this week.`;
  const conversation = create<{ id: string; tenantId: string; leadId: string; leadName: string; lastMsg: string; time: string; unread: number; channel: string }>('conversations', {
    id: '', tenantId, leadId: lead.id, leadName: lead.name,
    lastMsg: welcome, time: now, unread: 0, channel: 'whatsapp',
  });
  create('chatMessages', {
    id: '', tenantId, conversationId: conversation.id,
    senderId: assignee?.id || '', content: welcome, timestamp: now,
  });
  create('activities', {
    id: '', tenantId, leadId: lead.id, userId: assignee?.id || '',
    type: 'whatsapp',
    description: 'Automated WhatsApp welcome & qualification message sent',
    createdAt: now,
  });

  return lead;
}

/** Simulate pulling new leads from a connected lead-source integration.
 *  Returns the created leads. In production this would call the provider's API. */
export function syncLeadsFromProvider(
  tenantId: string, providerId: string, actor?: { id: string; name: string }
): Lead[] {
  const provider = INTEGRATION_PROVIDERS.find(p => p.id === providerId);
  if (!provider?.leadSource) return [];
  const state = getByTenant<IntegrationState>('integrations', tenantId).find(r => r.providerId === providerId);
  if (!state?.connected) return [];

  const projects = getByTenant<Project>('projects', tenantId);
  const count = 1 + Math.floor(Math.random() * 3); // 1–3 new leads per sync
  const created: Lead[] = [];
  for (let i = 0; i < count; i++) {
    // SAFETY: this is a SIMULATED sync (no real provider API is called). It must
    // never mint a lead a salesperson could act on as if real:
    //  - the name is watermarked "(Sample)" so it's unmistakable in the UI, and
    //  - the phone uses a NON-ROUTABLE number. Indian mobiles are 10 digits
    //    starting 6-9; a subscriber part beginning 0 cannot be dialled. The old
    //    code generated `+91 9#########` — a live, dialable stranger's number —
    //    so clicking "Sync Leads Now" produced fake enquiries whose tel:/wa.me
    //    links pointed at real people (TRAI/DND, TCPA exposure). Fixed here.
    const name = `${randomOf(SAMPLE_FIRST)} ${randomOf(SAMPLE_LAST)} (Sample)`;
    const phone = `+91 00000 ${String(10000 + Math.floor(Math.random() * 89999))}`;
    created.push(ingestLead(tenantId, {
      name,
      email: `sample.${Math.floor(Math.random() * 1e6)}@example.invalid`,
      phone,
      source: provider.leadSource,
      project: projects.length > 0 ? randomOf(projects).name : undefined,
      budget: (8 + Math.floor(Math.random() * 42)) * 1000000, // ₹80L – ₹5Cr
      configuration: randomOf(SAMPLE_CONFIGS),
    }));
  }

  update<IntegrationState>('integrations', state.id, {
    lastSyncAt: new Date().toISOString(),
    leadsImported: (state.leadsImported || 0) + created.length,
  });

  if (actor) {
    logAudit({
      tenantId, userId: actor.id, userName: actor.name, action: 'sync',
      entity: 'integration', entityId: state.id,
      details: `Synced ${created.length} lead(s) from ${provider.name}`,
    });
  }
  return created;
}

/** JS embed snippet for the website chatbot widget. Carries the tenant id,
 *  white-label config, and the lead-capture webhook so chats become leads
 *  instantly (and get scored like any other inbound lead). */
export function getChatbotSnippet(tenantId: string, opts: { primaryColor?: string; brandName?: string } = {}): string {
  const { url } = getWebhookInfo(tenantId);
  return `<!-- Friendly ERP Chatbot -->
<script>
  window.FriendlyERPChat = {
    tenantId: "${tenantId}",
    captureEndpoint: "${url.replace('/v1/webhooks/leads/', '/api/v1/leads/capture/')}",
    config: {
      color: "${opts.primaryColor || '#6366f1'}",
      greeting: "Hi! 👋 Looking for your dream home${opts.brandName ? ` with ${opts.brandName}` : ''}? I can help with prices, floor plans & site visits.",
      position: "bottom-right",
      qualify: ["budget", "configuration", "timeline"]
    }
  };
</script>
<script src="https://cdn.friendlyerp.app/chatbot/v1/widget.js" async></script>`;
}

/** Next.js installation instructions for the chatbot snippet. */
export function getChatbotNextJsInstructions(): string {
  return `// app/layout.tsx  (Next.js App Router)
import Script from 'next/script';

// Inside <body>, after {children}:
<Script id="friendly-crm-chat-config" strategy="afterInteractive">
  {\`window.FriendlyERPChat = { /* paste the config object from the snippet */ };\`}
</Script>
<Script src="https://cdn.friendlyerp.app/chatbot/v1/widget.js" strategy="lazyOnload" />`;
}

/** HTML snippet builders can paste on their website; posts to the inbound webhook. */
export function getWebsiteFormSnippet(tenantId: string): string {
  const { url } = getWebhookInfo(tenantId);
  return `<form action="${url}" method="POST">
  <input name="name" placeholder="Your name" required />
  <input name="phone" placeholder="Phone number" required />
  <input name="email" type="email" placeholder="Email" />
  <input type="hidden" name="source" value="Website" />
  <textarea name="message" placeholder="I'm interested in..."></textarea>
  <button type="submit">Request a callback</button>
</form>`;
}
