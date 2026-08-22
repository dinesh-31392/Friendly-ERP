import type pg from 'pg';

/**
 * Emitting a notification.
 *
 * Deliberately takes the CALLER'S transaction client rather than opening its
 * own. A notification about a booking that then failed to commit is a lie, and
 * the only way to make the two agree is to write them in the same transaction.
 * That also means a broken notification rolls back the business write it
 * describes — which is why `emit` swallows nothing and callers are expected to
 * pass well-formed input.
 *
 * The tenant comes from the session, never from an argument: this runs inside
 * withTenantContext, app_current_tenant() is already set, and accepting a
 * tenant id here would be a second way to address a row that RLS would then
 * faithfully enforce for the wrong workspace.
 */
export interface NotifyInput {
  /** Who is being told. Must be a user in the current tenant. */
  userId: string;
  /** Matches the keys in Settings, e.g. 'new_lead_assigned'. */
  kind: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Write one notification, if the recipient wants that kind.
 *
 * Returns whether a row was written, so a caller can tell "suppressed by
 * preference" from "sent" without a second query. Most callers ignore it.
 */
export async function emit(db: pg.PoolClient, n: NotifyInput): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO notifications (tenant_id, user_id, kind, title, body, entity_type, entity_id)
     SELECT app_current_tenant(), $1, $2, $3, $4, $5, $6
      WHERE wants_notification($1, $2)
     RETURNING id`,
    [n.userId, n.kind, n.title, n.body ?? '', n.entityType ?? null, n.entityId ?? null],
  );
  return rows.length > 0;
}

/**
 * Tell everyone holding a permission — "the accountants", "whoever can approve
 * a payout" — without the caller needing to know who that is today.
 *
 * Resolves through the same role/permission tables authorisation uses, so a
 * team change is reflected the next time something is emitted rather than
 * requiring a subscriber list to be maintained alongside the roles.
 *
 * Skips the actor: being notified of your own action is noise, and it is the
 * single most common complaint about systems like this.
 */
export async function emitToPermission(
  db: pg.PoolClient,
  permission: string,
  n: Omit<NotifyInput, 'userId'> & { exceptUserId?: string },
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO notifications (tenant_id, user_id, kind, title, body, entity_type, entity_id)
     SELECT app_current_tenant(), u.id, $1, $2, $3, $4, $5
       FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id
      WHERE u.active
        AND rp.permission_key = $6
        AND ($7::uuid IS NULL OR u.id <> $7::uuid)
        AND wants_notification(u.id, $1)
     RETURNING id`,
    [n.kind, n.title, n.body ?? '', n.entityType ?? null, n.entityId ?? null,
     permission, n.exceptUserId ?? null],
  );
  return rows.length;
}
