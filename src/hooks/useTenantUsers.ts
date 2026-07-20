import { useEffect, useMemo, useState } from 'react';
import type { User } from '../types';
import { getByTenant } from '../services/db';
import { isApiEnabled, apiGetUsers } from '../services/apiClient';

/**
 * The workspace's user directory — from the API when a backend is configured,
 * from the local demo store otherwise.
 *
 * Every page previously did `getByTenant<User>('users', tenantId)` directly.
 * In API mode that store is empty, so `assignedTo` ids resolved to nothing and
 * the UI showed "Unassigned" against every record while assignee pickers came
 * up blank. Centralising the lookup here means a page cannot reintroduce that
 * by forgetting the API branch.
 *
 * Mirrors the leads pattern: on any API failure it falls back to the local
 * store rather than returning nothing, so a backend blip degrades the directory
 * instead of blanking the screen.
 *
 * @param refreshKey pass a page's refresh counter to force a re-fetch.
 */
export function useTenantUsers(tenantId: string, refreshKey?: unknown): User[] {
  const [apiUsers, setApiUsers] = useState<User[] | null>(null);

  useEffect(() => {
    if (!isApiEnabled()) { setApiUsers(null); return; }
    let cancelled = false;
    apiGetUsers()
      .then(rows => { if (!cancelled) setApiUsers(rows); })
      .catch(() => { if (!cancelled) setApiUsers(null); });
    return () => { cancelled = true; };
  }, [tenantId, refreshKey]);

  return useMemo(
    () => apiUsers ?? getByTenant<User>('users', tenantId),
    // refreshKey is a dependency on purpose: in demo mode it is the only thing
    // that tells us the underlying localStorage table changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiUsers, tenantId, refreshKey],
  );
}
