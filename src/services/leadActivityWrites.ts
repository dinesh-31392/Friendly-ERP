import { apiCreateLeadActivity } from './apiClient';
import type { Activity, ActivityType } from '../types';

/**
 * Lead activities and notes, written to the server.
 *
 * Both used to be localStorage tables, so a lead's timeline existed only in the
 * browser of whoever typed it — the next person to open that lead saw nothing.
 *
 * There is no separate `notes` table server-side and there does not need to be:
 * a note IS an activity of type 'note'. Keeping two stores for one concept is
 * what let them drift apart in the first place.
 */

/**
 * The SPA's ActivityType and the API's enum disagree on two names. Mapping them
 * here rather than at each call site means a mismatch is one fix, not fourteen —
 * and an unmapped value would be rejected with a 400 the user never sees the
 * cause of.
 */
const TYPE_MAP: Record<ActivityType, string> = {
  call: 'call',
  whatsapp: 'whatsapp',
  email: 'email',
  visit: 'site_visit',          // the API calls it site_visit
  note: 'note',
  status_change: 'stage_change', // and stage_change
};

/** Log an activity against a lead. Returns nothing the UI needs — callers
 *  refresh from the server rather than trusting a local echo. */
export async function logLeadActivity(input: {
  leadId: string;
  type: ActivityType;
  description: string;
}): Promise<void> {
  await apiCreateLeadActivity({
    leadId: input.leadId,
    type: TYPE_MAP[input.type] ?? 'note',
    // The API field is `notes`; the SPA calls it `description`. Trimmed to the
    // column's 2000, because a rejected write here would lose the note silently.
    notes: input.description.slice(0, 2000),
  });
}

/** A note is an activity of type 'note'. */
export async function addLeadNote(leadId: string, content: string): Promise<void> {
  await apiCreateLeadActivity({ leadId, type: 'note', notes: content.slice(0, 2000) });
}

/** Shape a server activity row for the SPA's Activity type. */
export function toActivity(r: {
  id: string; leadId: string; userId?: string; type: string; notes?: string; createdAt: string;
}): Activity {
  const reverse: Record<string, ActivityType> = {
    site_visit: 'visit', stage_change: 'status_change',
    call: 'call', whatsapp: 'whatsapp', email: 'email', note: 'note',
  };
  return {
    id: r.id,
    tenantId: '',            // RLS already scoped it; the SPA never reads this
    leadId: r.leadId,
    userId: r.userId ?? '',
    type: reverse[r.type] ?? 'note',
    description: r.notes ?? '',
    createdAt: r.createdAt,
  };
}
