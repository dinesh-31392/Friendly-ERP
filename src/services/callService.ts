/**
 * Dual-mode calling.
 *
 * SIM_NATIVE — dial through the device SIM via a `tel:` deep link (field
 *              agents on mobile).
 * API_CLOUD  — ask the backend telephony service (Exotel/Knowlarity) to
 *              bridge an outbound call: it rings the agent first, then the
 *              lead, and delivers a recording + status via callback.
 *
 * The mode is a per-user preference (mirrors the `user_preferences` table in
 * docs/backend/schema.sql; persisted in localStorage in this demo build).
 */

export type CallingMode = 'SIM_NATIVE' | 'API_CLOUD';

const MODE_KEY = (userId: string) => `friendly_crm_calling_mode_${userId}`;

export function getCallingMode(userId: string): CallingMode {
  return localStorage.getItem(MODE_KEY(userId)) === 'API_CLOUD' ? 'API_CLOUD' : 'SIM_NATIVE';
}

export function setCallingMode(userId: string, mode: CallingMode): void {
  localStorage.setItem(MODE_KEY(userId), mode);
}

export interface CloudCallRequest {
  tenantId: string;
  agentPhone: string;   // the agent's registered number (rung first)
  leadPhone: string;
  leadId: string;
}

export interface CloudCallResult {
  callId: string;
  provider: string;
  status: 'initiated';
}

/**
 * Initiate a cloud call. In production this is
 *   POST /api/telephony/calls  →  Exotel Connect API
 * and the provider's status callback writes duration/recording to the lead
 * history. In this demo build the bridge is simulated.
 */
export async function initiateCloudCall(req: CloudCallRequest): Promise<CloudCallResult> {
  // Simulated provider latency. In production:
  //   await axios.post('/api/telephony/calls', req)
  void req;
  await new Promise(r => setTimeout(r, 400));
  return {
    callId: `exo_${Math.random().toString(36).slice(2, 10)}`,
    provider: 'Exotel (simulated)',
    status: 'initiated',
  };
}

export const CALL_STATUSES = [
  { id: 'connected', label: 'Connected' },
  { id: 'no_answer', label: 'No Answer' },
  { id: 'busy', label: 'Busy' },
  { id: 'wrong_number', label: 'Wrong Number' },
  { id: 'callback_requested', label: 'Callback Requested' },
] as const;

export type CallStatus = typeof CALL_STATUSES[number]['id'];
