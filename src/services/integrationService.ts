import { v4 as uuid } from 'uuid';
import { getByTenant, getByField, create, update, remove, logAudit } from './db';
import type { Lead, Project, User, LeadQualification } from '../types';

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
    id: 'whatsapp_business', name: 'WhatsApp Business API', category: 'lead_source', icon: '💬',
    description: 'Official Meta Cloud API — enables automated & bulk WhatsApp (drip sequences, templates) + enquiry capture. Optional: without it, agents already chat interested leads 1-to-1 from their own WhatsApp for free (Click to Chat).',
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

/**
 * The origin this ERP is actually served from.
 *
 * Every snippet below used to carry a hardcoded `api.friendlyerp.app` or
 * `cdn.friendlyerp.app`. Nothing in this system serves either host, so every
 * integration a builder copied out of the product pointed at a domain that
 * answers nothing — the website form posted into the void, and the chatbot
 * script 404'd silently. Deriving the origin means the snippet is correct for
 * whatever domain the workspace is actually running on.
 */
function deploymentOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * The public lead-capture endpoint, as it really exists.
 *
 * What this replaced was fiction in three ways: the host did not exist, the
 * path (`/v1/webhooks/leads/:tenantId`) is not a route anywhere in the API, and
 * the `?key=` secret was generated in the browser, stored in localStorage, and
 * never sent to or checked by anything. Publishing a URL with a credential in
 * it that nothing validates is worse than publishing one without — it tells the
 * reader the endpoint is authenticated when it is not.
 *
 * The real endpoint is POST /api/public/leads. It is deliberately public: it
 * identifies the workspace by `slug` in the body, and is protected by a
 * per-IP rate limit and a honeypot field rather than by a shared secret, since
 * anything embedded in a public web page is not a secret.
 */
export function getWebhookInfo(slug: string): { url: string; samplePayload: string } {
  const url = `${deploymentOrigin()}/api/public/leads`;
  // Mirrors the route's schema exactly. The previous sample carried `source`
  // and `message`, which are not fields it accepts — they would have been
  // silently stripped rather than rejected, so anyone copying this to build an
  // integration would have watched those two values vanish with no error to
  // explain it.
  //
  // No `projectId`: it must be a project UUID from this workspace, and there is
  // no plausible placeholder for one. An earlier draft of this sample used a
  // readable slug, which is exactly the mistake a builder would then copy.
  const samplePayload = JSON.stringify({
    slug,
    name: 'Rohan Verma',
    email: 'rohan.v@email.com',
    phone: '+91 98220 11223',
    budget: 15000000,
    configuration: '3 BHK',
    timeline: '3-6 months',
  }, null, 2);
  return { url, samplePayload };
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
  /** Answers to the builder's chatbot custom questions, keyed by field key. */
  customFields?: Record<string, string>;
  /** Qualification computed at intake (chatbot). When present it also sets the
   *  lead's opening stage/priority. */
  qualification?: LeadQualification;
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

  // A qualification result (from the chatbot) sets the opening stage/priority:
  // a lead that already cleared the bar enters as 'qualified', and the priority
  // tracks the Hot/Warm/Cold status. Without it we keep the previous defaults.
  const q = payload.qualification;
  const openingStage: Lead['stage'] = q
    ? (q.status !== 'unqualified' && q.score >= 55 ? 'qualified' : 'new')
    : 'new';
  const openingPriority: Lead['priority'] = q
    ? (q.status === 'hot' ? 'hot' : q.status === 'warm' ? 'warm' : 'cold')
    : 'warm';

  const lead = create<Lead>('leads', {
    id: '', tenantId,
    name: payload.name,
    email: payload.email || '',
    phone: payload.phone,
    source: payload.source,
    project,
    budget: payload.budget || 0,
    configuration: payload.configuration || '2 BHK',
    stage: openingStage, priority: openingPriority,
    assignedTo: assignee?.id || '',
    ...(payload.customFields && Object.keys(payload.customFields).length ? { customFields: payload.customFields } : {}),
    ...(q ? { qualification: q } : {}),
    lastContact: now, createdAt: now,
  });

  create('activities', {
    id: '', tenantId, leadId: lead.id, userId: assignee?.id || '',
    type: 'note',
    description: `Lead captured via ${payload.source}${payload.message ? ` — "${payload.message}"` : ''}${q ? ` · qualified ${q.status.toUpperCase()} (${q.score}/100)` : ''} · auto-routed to ${assignee?.name || 'unassigned'} (capacity-based)`,
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
export function getChatbotSnippet(slug: string, opts: { primaryColor?: string; brandName?: string } = {}): string {
  const color = opts.primaryColor || '#6366f1';
  const label = opts.brandName ? `Chat with ${opts.brandName}` : 'Chat with us';
  return `<!-- Friendly ERP Chatbot -->
<script>
(function () {
  var ORIGIN = ${JSON.stringify(deploymentOrigin())};
  var SRC = ORIGIN + "/chat/${slug}";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", ${JSON.stringify(label)});
  btn.textContent = "💬";
  btn.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:2147483000;width:56px;height:56px;" +
    "border:0;border-radius:50%;cursor:pointer;font-size:24px;color:#fff;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.25);background:${color}";

  var frame = document.createElement("iframe");
  frame.title = ${JSON.stringify(label)};
  frame.style.cssText =
    "position:fixed;bottom:88px;right:20px;z-index:2147483000;width:380px;height:560px;" +
    "max-width:calc(100vw - 40px);max-height:calc(100vh - 120px);display:none;" +
    "border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);background:#fff";

  btn.addEventListener("click", function () {
    var opening = frame.style.display === "none";
    // Loaded on first open, not on page load — an embedded widget must not cost
    // the host page a request until somebody actually wants it.
    if (opening && !frame.src) frame.src = SRC;
    frame.style.display = opening ? "block" : "none";
    btn.textContent = opening ? "✕" : "💬";
  });

  document.body.appendChild(frame);
  document.body.appendChild(btn);
})();
</script>`;
}

/** Next.js installation instructions for the chatbot snippet. */
export function getChatbotNextJsInstructions(slug: string): string {
  return `// app/layout.tsx  (Next.js App Router)
//
// The widget is an iframe, not a hosted script, so there is nothing to load
// from a CDN and no config object to keep in sync. Render it in a client
// component so the open/close state lives in the browser.

'use client';
import { useState } from 'react';

export function FriendlyERPChat() {
  const [open, setOpen] = useState(false);
  const src = '${deploymentOrigin()}/chat/${slug}';
  return (
    <>
      {open && (
        <iframe
          src={src}
          title="Chat with us"
          style={{ position: 'fixed', bottom: 88, right: 20, zIndex: 2147483000,
                   width: 380, height: 560, border: 0, borderRadius: 16,
                   boxShadow: '0 12px 40px rgba(0,0,0,.28)', background: '#fff' }}
        />
      )}
      <button
        type="button"
        aria-label="Chat with us"
        onClick={() => setOpen(o => !o)}
        style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 2147483000,
                 width: 56, height: 56, border: 0, borderRadius: '50%', cursor: 'pointer',
                 fontSize: 24, color: '#fff', background: '#6366f1',
                 boxShadow: '0 4px 14px rgba(0,0,0,.25)' }}
      >
        {open ? '✕' : '💬'}
      </button>
    </>
  );
}

// Then render <FriendlyERPChat /> inside <body>, after {children}.`;
}

/** HTML snippet builders can paste on their website; posts to the inbound webhook. */
export function getWebsiteFormSnippet(slug: string): string {
  const { url } = getWebhookInfo(slug);
  // A plain `<form action=... method=POST>` cannot work against this endpoint:
  // a native submit sends url-encoded fields, and the route accepts JSON with
  // additionalProperties:false. It would also navigate the visitor away from
  // the builder's page. So the snippet submits with fetch and stays put.
  return `<!-- Friendly ERP — website enquiry form -->
<form id="friendly-erp-enquiry">
  <input name="name" placeholder="Your name" required />
  <input name="phone" placeholder="Phone number" required />
  <input name="email" type="email" placeholder="Email" />
  <!-- Honeypot: real visitors never see or fill this; bots do, and the server
       accepts their submission with a 200 and quietly drops it. -->
  <input name="hp" tabindex="-1" autocomplete="off" aria-hidden="true"
         style="position:absolute;left:-9999px;width:1px;height:1px" />
  <button type="submit">Request a callback</button>
  <p id="friendly-erp-enquiry-msg" role="status"></p>
</form>

<script>
document.getElementById("friendly-erp-enquiry").addEventListener("submit", async function (e) {
  e.preventDefault();
  var form = e.target;
  var msg = document.getElementById("friendly-erp-enquiry-msg");
  var data = Object.fromEntries(new FormData(form).entries());
  var button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    var res = await fetch(${JSON.stringify(url)}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: ${JSON.stringify(slug)},
        name: data.name,
        phone: data.phone,
        email: data.email || undefined,
        hp: data.hp || undefined
      })
    });
    if (!res.ok) throw new Error("Request failed");
    form.reset();
    msg.textContent = "Thanks — we'll call you shortly.";
  } catch (err) {
    // Never leave the visitor staring at a form that silently did nothing.
    msg.textContent = "Sorry, something went wrong. Please try again.";
    button.disabled = false;
  }
});
</script>`;
}
