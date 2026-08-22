/**
 * Notification preference writes.
 *
 * A dispatcher like every other module's, but a short one, because there is no
 * browser-only fallback worth having: a preference that only this browser knows
 * about is exactly the bug migration 040 exists to fix. Outside API mode the
 * call is a no-op rather than a localStorage write, so the old behaviour cannot
 * quietly come back.
 */
import { isApiEnabled, apiSetNotificationPref } from './apiClient';

export async function setPref(kind: string, enabled: boolean): Promise<void> {
  if (!isApiEnabled()) return;
  await apiSetNotificationPref(kind, enabled);
}
