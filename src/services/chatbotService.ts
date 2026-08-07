/**
 * Native lead-capture chatbot — per-tenant configuration and the qualification
 * engine that scores a visitor's answers before the lead lands in the CRM.
 *
 * Config is stored per tenant in localStorage (demo mode). In API mode this is
 * where a `chatbot_configs` table read would slot in; the shape stays the same.
 *
 * The chatbot reuses project details already in the backend (price range,
 * configurations) and the builder-defined custom questions to (a) capture the
 * fields the builder needs and (b) compute a Hot/Warm/Cold/Unqualified status.
 */
import type { Project, LeadQualification, QualificationStatus } from '../types';

export type CustomFieldType = 'text' | 'number' | 'select' | 'phone' | 'email' | 'date';

export interface CustomField {
  key: string;
  label: string;
  type: CustomFieldType;
  options?: string[];      // for 'select'
  required: boolean;
  /** When true, the answer feeds the qualification score (e.g. financing). */
  qualifying?: boolean;
}

export interface ChatbotConfig {
  enabled: boolean;
  greeting: string;
  accentColor: string;
  /** 'all' offers every published project; 'selected' restricts to projectIds. */
  projectMode: 'all' | 'selected';
  projectIds: string[];
  timelineOptions: string[];
  customFields: CustomField[];
  /** Score thresholds (0–100). */
  hotMin: number;
  warmMin: number;
  /** Score at/above which the lead enters the pipeline already 'qualified'. */
  qualifyMin: number;
}

const KEY = (tenantId: string) => `friendly_crm_chatbot_${tenantId}`;

export const DEFAULT_TIMELINES = ['Immediately', '1–3 months', '3–6 months', 'Just exploring'];

export const DEFAULT_CUSTOM_FIELDS: CustomField[] = [
  { key: 'financing', label: 'How are you planning to purchase?', type: 'select', options: ['Home loan', 'Cash / self-funded', 'Not decided yet'], required: true, qualifying: true },
  { key: 'purpose', label: 'Is this for end-use or investment?', type: 'select', options: ['End use (I will live here)', 'Investment'], required: false, qualifying: false },
];

export function defaultChatbotConfig(): ChatbotConfig {
  return {
    enabled: true,
    greeting: "Hi! 👋 I can help you find the right home. A few quick questions and our team will reach out.",
    accentColor: '#6366f1',
    projectMode: 'all',
    projectIds: [],
    timelineOptions: [...DEFAULT_TIMELINES],
    customFields: DEFAULT_CUSTOM_FIELDS.map(f => ({ ...f })),
    hotMin: 70,
    warmMin: 45,
    qualifyMin: 55,
  };
}

export function getChatbotConfig(tenantId: string): ChatbotConfig {
  if (!tenantId) return defaultChatbotConfig();
  try {
    const raw = localStorage.getItem(KEY(tenantId));
    if (!raw) return defaultChatbotConfig();
    // Merge over defaults so older saved configs gain any new fields safely.
    return { ...defaultChatbotConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultChatbotConfig();
  }
}

export function saveChatbotConfig(tenantId: string, cfg: ChatbotConfig): void {
  if (!tenantId) return;
  localStorage.setItem(KEY(tenantId), JSON.stringify(cfg));
}

/** Slugify a question label into a stable field key: "Move-in Date" → "move_in_date". */
export function fieldKeyFromLabel(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `field_${Date.now()}`;
}

export interface QualifyInput {
  budget: number;
  configuration?: string;
  timeline?: string;
  project?: Project | null;
  /** Answers to qualifying custom fields, keyed by field key. */
  customAnswers?: Record<string, string>;
  config: ChatbotConfig;
}

/**
 * Score a prospective lead 0–100 from budget-vs-project fit, purchase timeline,
 * financing readiness and contactability, then map to a status via the
 * builder's thresholds. A budget far below the project's floor is a hard
 * disqualifier regardless of the other signals.
 */
export function computeQualification(input: QualifyInput): LeadQualification {
  const { budget, timeline, project, customAnswers = {}, config } = input;
  const reasons: string[] = [];
  let score = 0;

  // ── Budget fit (0–40) ───────────────────────────────────────────────────
  let hardDisqualify = false;
  if (project && project.priceRange && project.priceRange[0] > 0) {
    const [min, max] = project.priceRange;
    if (budget >= min) {
      score += budget >= max ? 40 : 34;
      reasons.push(`Budget fits ${project.name} (${budget >= max ? 'at or above top of range' : 'within range'})`);
    } else if (budget >= min * 0.75) {
      score += 20;
      reasons.push('Budget slightly below the project range — negotiable');
    } else if (budget >= min * 0.5) {
      score += 8;
      reasons.push('Budget well below the project range');
    } else {
      hardDisqualify = true;
      reasons.push(`Budget is under half of ${project.name}'s entry price`);
    }
  } else {
    // No project context — absolute bands (mirrors explainLeadScore tiers).
    if (budget >= 30000000) { score += 40; reasons.push('Premium budget (₹3 Cr+)'); }
    else if (budget >= 15000000) { score += 30; reasons.push('Strong budget (₹1.5 Cr+)'); }
    else if (budget >= 8000000) { score += 18; reasons.push('Mid budget (₹80 L+)'); }
    else if (budget > 0) { score += 8; reasons.push('Entry budget'); }
    else { reasons.push('No budget shared'); }
  }

  // ── Purchase timeline (0–35) ────────────────────────────────────────────
  const t = (timeline || '').toLowerCase();
  if (t.includes('immediat')) { score += 35; reasons.push('Ready to buy immediately'); }
  else if (t.includes('1') || t.includes('3 month')) { score += 24; reasons.push('Buying within 1–3 months'); }
  else if (t.includes('6')) { score += 12; reasons.push('Buying within 3–6 months'); }
  else if (t.includes('explor')) { score += 4; reasons.push('Still exploring'); }

  // ── Financing readiness (0–15) — from a qualifying custom field ─────────
  const financing = (customAnswers['financing'] || '').toLowerCase();
  if (financing) {
    if (financing.includes('cash') || financing.includes('self')) { score += 15; reasons.push('Cash / self-funded'); }
    else if (financing.includes('loan')) { score += 10; reasons.push('Home loan route'); }
    else { score += 3; reasons.push('Financing undecided'); }
  }

  // ── Engagement channel (0–10) — a completed chatbot flow is high-intent ──
  score += 10;
  reasons.push('Completed the guided enquiry');

  score = Math.max(0, Math.min(100, score));

  let status: QualificationStatus;
  if (hardDisqualify) status = 'unqualified';
  else if (score >= config.hotMin) status = 'hot';
  else if (score >= config.warmMin) status = 'warm';
  else status = 'cold';

  return { status, score, reasons };
}

const STATUS_STYLES: Record<QualificationStatus, { label: string; color: string }> = {
  hot: { label: 'Hot lead', color: 'bg-red-100 text-red-700' },
  warm: { label: 'Warm lead', color: 'bg-amber-100 text-amber-700' },
  cold: { label: 'Cold lead', color: 'bg-sky-100 text-sky-700' },
  unqualified: { label: 'Unqualified', color: 'bg-zinc-100 text-zinc-500' },
};

export function qualificationBadge(status: QualificationStatus): { label: string; color: string } {
  return STATUS_STYLES[status] ?? STATUS_STYLES.cold;
}
