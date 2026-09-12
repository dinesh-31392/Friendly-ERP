---
name: add-permission
description: Add, grant, or enforce a permission key in Friendly ERP. Use whenever a role needs a new capability, an existing key must start being checked by a route, or a role's grants change — the key must land in five separate files plus a backfill migration, and missing one fails silently.
---

# Adding or changing a permission

The failure this prevents is silent. Grants are written by five independent code
paths; four of them only shape workspaces created *after* they change, and the
fifth only touches workspaces that already exist. Edit some but not all and the
product works on your machine and is broken for somebody else — an accountant
who cannot approve a vendor bill, a parcel nobody can qualify.

## 1. Decide what kind of change this is

**A new key** needs the catalog entry, the grants, and a route that checks it.

**Granting an existing key to another role** needs the four grant maps *and* a
migration, because existing workspaces carry their grants as rows.

**Starting to enforce a key that was never checked** is the dangerous one. Read
`server/migrations/067_land_bd_approval_keys.sql` first — it exists because
switching a gate on can strand a workspace where nobody holds the key.

## 2. Edit all five

| Where | What it governs |
| --- | --- |
| `server/migrations/NNN_*.sql` | workspaces that **already exist** |
| `server/scripts/seed.ts` | the catalog + a fresh install |
| `server/src/routes/tenantRoutes.ts` | self-serve signup |
| `server/scripts/seed-demo-workspace.mjs` | the demo workspace |
| `src/services/authService.ts` | the SPA's demo map |

Two of these are CRLF files. A shell edit with `\n` line endings reports success
and changes nothing — use the Edit tool, then verify **inside the role's own
array**, not with a file-wide grep:

```bash
node -e "const s=require('fs').readFileSync('server/scripts/seed.ts','utf8');
const m=s.match(/accountant:\s*\[([\s\S]*?)\]/);
console.log(m && m[1].includes('your_key') ? 'OK' : 'MISSING')"
```

A file-wide grep matches the catalog list and tells you nothing.

## 3. Write the migration so nothing strands

Grant the key to whoever holds the capability today, **only where the workspace
has no holder at all** — that preserves a separation of duties somebody
configured deliberately, while guaranteeing no workspace dead-ends:

```sql
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'new_key'
  FROM roles r
 WHERE EXISTS (SELECT 1 FROM role_permissions rp
                WHERE rp.role_id = r.id AND rp.permission_key = 'existing_key')
   AND NOT EXISTS (SELECT 1 FROM roles peer
                     JOIN role_permissions prp ON prp.role_id = peer.id
                    WHERE peer.tenant_id = r.tenant_id
                      AND prp.permission_key = 'new_key')
ON CONFLICT DO NOTHING;
```

End with a `DO $$` block that RAISEs if any workspace is left unable to complete
the workflow. Assert against the rows, not the statement.

## 4. Enforce it in the route

For an **approval** transition the approval key **replaces** the maker key; it is
not ANDed with it. The checker deliberately does not hold the maker key, so
requiring both locks out the only role that should act:

```ts
const STAGE_KEY: Record<string, string> = { qualified: 'approve_x' };
const needed = STAGE_KEY[req.body.status] ?? 'manage_x';
if (!await gate(db, needed)) return reply.code(403).send({ error: `Missing permission: ${needed}` });
```

## 5. Prove it

Apply to **both** databases (`friendly_crm` and `erp_test`), then write the
assertions:

- the role that should act **can** — the positive control, or a suite of
  refusals passes on a product broken for everyone
- the role that should not **is refused**, and the row did not change anyway
- **no workspace is stranded** — scope this to workspaces that can actually
  reach the gated action, or throwaway test fixtures will trip it

Falsify before trusting: revert the enforcement, watch the right assertions go
red, restore. See `server/scripts/verify-approval-gates.mjs`.
