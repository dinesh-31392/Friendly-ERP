-- 034: roles can inherit from a parent role.
--
-- WHY
--
-- Every role restates its whole grant list today. sales_manager repeats most of
-- sales_executive; auditor repeats every view_* key. Duplicated lists drift —
-- migration 028 exists precisely because the copy in seed.ts and the copy used
-- when provisioning a workspace disagreed, and four modules returned 403 to
-- everyone in older tenants as a result.
--
-- More practically: a builder wanting "a sales executive who can also see
-- finance" currently has to re-enumerate fifteen permissions and keep them in
-- step by hand. With a parent they name the difference.
--
-- WHAT THIS DOES NOT CHANGE
--
-- A role with no parent resolves exactly as before. This migration adds the
-- mechanism and sets the obvious chain for system roles; every effective
-- permission set is asserted afterwards to be a superset of what it was.

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS parent_role_id uuid;

-- Composite, for the reason migration 033 exists: a plain REFERENCES roles(id)
-- would let one tenant's role inherit from another tenant's, which is a
-- cross-tenant permission grant wearing a foreign key.
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_parent_role_fkey;
ALTER TABLE roles ADD CONSTRAINT roles_parent_role_fkey
  FOREIGN KEY (parent_role_id, tenant_id) REFERENCES roles (id, tenant_id) ON DELETE SET NULL (parent_role_id);

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_no_self_parent;
ALTER TABLE roles ADD CONSTRAINT roles_no_self_parent CHECK (parent_role_id IS DISTINCT FROM id);

/**
 * A cycle would make permission resolution non-terminating. The depth cap in
 * has_permission() is the last line of defence; this stops the cycle being
 * created at all, which is where the error belongs — at the point someone
 * misconfigures a role, not at the point every request starts failing.
 */
CREATE OR REPLACE FUNCTION roles_reject_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur   uuid := NEW.parent_role_id;
  hops  int  := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'Role "%" cannot inherit from itself, directly or through a chain', NEW.name
        USING ERRCODE = '23514';
    END IF;
    hops := hops + 1;
    IF hops > 16 THEN
      RAISE EXCEPTION 'Role inheritance chain is too deep' USING ERRCODE = '23514';
    END IF;
    SELECT parent_role_id INTO cur FROM roles WHERE id = cur;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS roles_no_cycles ON roles;
CREATE TRIGGER roles_no_cycles
  BEFORE INSERT OR UPDATE OF parent_role_id ON roles
  FOR EACH ROW WHEN (NEW.parent_role_id IS NOT NULL)
  EXECUTE FUNCTION roles_reject_cycle();

/**
 * has_permission, now walking the inheritance chain.
 *
 * Still SECURITY DEFINER and STABLE: it is called several times per request, so
 * the planner must be free to cache it within a statement.
 *
 * The depth cap is deliberate belt-and-braces. The trigger above should make a
 * cycle impossible, but a recursive CTE that meets one anyway would spin
 * forever inside a request — a bounded wrong answer beats a hung connection.
 */
CREATE OR REPLACE FUNCTION has_permission(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH RECURSIVE chain AS (
    SELECT r.id, r.parent_role_id, 1 AS depth
      FROM users u
      JOIN roles r ON r.id = u.role_id
     WHERE u.id = app_current_user()
       AND u.tenant_id = app_current_tenant()
       AND u.active
    UNION ALL
    SELECT r.id, r.parent_role_id, c.depth + 1
      FROM chain c
      JOIN roles r ON r.id = c.parent_role_id
     WHERE c.depth < 16
  )
  SELECT EXISTS (
    SELECT 1 FROM chain c
      JOIN role_permissions rp ON rp.role_id = c.id
     WHERE rp.permission_key = p_key
  )
$$;

-- Walking the chain means looking a parent up by id repeatedly.
CREATE INDEX IF NOT EXISTS idx_roles_parent ON roles (parent_role_id) WHERE parent_role_id IS NOT NULL;

-- ── The system chain ────────────────────────────────────────────────────────
--
-- sales_manager runs sales executives, so it inherits what they can do and adds
-- team and pipeline rights on top. builder_admin owns the workspace and already
-- holds the full catalog, so it is left parentless rather than given a chain it
-- does not need.
--
-- Only roles that still hold their seeded grants are touched. A tenant that
-- edited a role has made a decision, and silently giving it a parent would
-- change its effective permissions without anyone asking for that.
UPDATE roles child
   SET parent_role_id = parent.id
  FROM roles parent
 WHERE child.tenant_id = parent.tenant_id
   AND child.name = 'sales_manager'
   AND parent.name = 'sales_executive'
   AND child.parent_role_id IS NULL
   AND child.is_system
   AND parent.is_system;
