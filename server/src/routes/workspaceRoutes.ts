import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { isValidGstin, stateOfGstin } from '../gst.js';
import { checkPan, normalisePan, panFromGstin } from '../pan.js';

/**
 * The workspace editing ITSELF.
 *
 * Distinct from tenantRoutes, which is the platform administering other
 * people's workspaces — plan, status, branch, suspension. Those are ours; this
 * is theirs, scoped by RLS to `app_current_tenant()` and gated on
 * manage_settings, so a builder admin can never reach another workspace's row
 * however the id is supplied. There is no :id in the path for the same reason.
 *
 * WHY THIS EXISTS
 *
 * Settings → Builder Profile wrote `update('tenants', …)` straight to
 * localStorage behind a 500ms timeout that made it look like a save. In API
 * mode the whole screen was theatre: company name, contact details, RERA
 * number and address all reverted at the next session refresh.
 *
 * The GSTIN was worse than reverting. The profile form wrote `tenants.gst` —
 * the original free-text field — while GST returns and e-invoicing read
 * `tenants.gstin`, which nothing wrote at all. So "this workspace has no GSTIN,
 * set it before preparing" was advice the product could not take: every return
 * was unfileable and no invoice could ever be registered.
 */

/** Two-digit GST state codes. 25 and 28 are retired but still accepted on
 *  historical rows; the picker offers only current ones. */
const STATE_CODE = '^[0-9]{2}$';

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/workspace — the workspace's own profile, tax details included.
   */
  app.get('/api/workspace', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(
        `SELECT has_permission('manage_settings') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });

      const { rows: [t] } = await db.query(
        `SELECT id, name, company, slug, email, phone, address, rera, gst,
                gstin, state_code, city, pincode, pan, einvoicing_enabled,
                primary_color, logo_url, brand_voice, audience, channels,
                currency, country, plan, status
           FROM tenants WHERE id = app_current_tenant()`);
      if (!t) return reply.code(404).send({ error: 'Workspace not found' });

      return {
        workspace: {
          id: t.id, name: t.name, company: t.company, slug: t.slug,
          email: t.email ?? '', phone: t.phone ?? '', address: t.address ?? '',
          rera: t.rera ?? '',
          // `gst` is the original free-text field and is still shown, because
          // existing workspaces have their number in it and nowhere else.
          gst: t.gst ?? '',
          gstin: t.gstin ?? '',
          stateCode: t.state_code ?? '',
          city: t.city ?? '',
          pincode: t.pincode ?? '',
          pan: t.pan ?? '',
          einvoicingEnabled: !!t.einvoicing_enabled,
          primaryColor: t.primary_color ?? '',
          logoUrl: t.logo_url ?? '',
          brandVoice: t.brand_voice ?? '',
          audience: t.audience ?? '',
          channels: Array.isArray(t.channels) ? t.channels : [],
          currency: t.currency, country: t.country, plan: t.plan, status: t.status,
        },
      };
    }),
  );

  /**
   * PATCH /api/workspace — update it.
   *
   * Only the fields a workspace owns. Plan, status and branch are the
   * platform's and are deliberately absent from the schema: a builder admin
   * raising their own plan by PATCHing this route is exactly the hole that
   * omission closes, and the suite asserts both are rejected.
   *
   * The subdomain IS here, because a white-label workspace owns its own portal
   * address — but it is globally unique, so a clash comes back as a 409 from
   * the constraint rather than a pre-check, which under RLS could never see
   * the row it would need to find.
   */
  app.patch<{
    Body: {
      company?: string; name?: string; email?: string; phone?: string;
      address?: string; rera?: string;
      gstin?: string; stateCode?: string; city?: string; pincode?: string; pan?: string;
      einvoicingEnabled?: boolean;
      primaryColor?: string; logoUrl?: string; slug?: string;
      brandVoice?: string; audience?: string; channels?: string[];
    };
  }>(
    '/api/workspace',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', minProperties: 1, additionalProperties: false,
          properties: {
            company: { type: 'string', minLength: 1, maxLength: 200 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            email: { type: 'string', maxLength: 254 },
            phone: { type: 'string', maxLength: 32 },
            address: { type: 'string', maxLength: 500 },
            rera: { type: 'string', maxLength: 80 },
            gstin: { type: 'string', maxLength: 15 },
            pan: { type: 'string', maxLength: 10 },
            stateCode: { type: 'string', pattern: STATE_CODE },
            city: { type: 'string', maxLength: 120 },
            // Empty clears it; otherwise a real Indian pincode.
            pincode: { type: 'string', pattern: '^$|^[1-9][0-9]{5}$' },
            einvoicingEnabled: { type: 'boolean' },
            // Branding. The logo is a data URI written by the client, capped
            // well under the 2MB the upload control advertises.
            primaryColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            logoUrl: { type: 'string', maxLength: 3_000_000 },
            slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' },
            brandVoice: { type: 'string', maxLength: 2000 },
            audience: { type: 'string', maxLength: 500 },
            channels: {
              type: 'array', maxItems: 20,
              items: { type: 'string', maxLength: 40 },
            },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(
          `SELECT has_permission('manage_settings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_settings' });

        const b = req.body;
        const gstin = b.gstin === undefined ? undefined : b.gstin.trim().toUpperCase();

        if (gstin) {
          // The same check the tax routes apply. Refusing here means a bad
          // number never reaches a return or an IRN — where the rejection
          // arrives weeks later, naming an invoice nobody remembers.
          if (!isValidGstin(gstin)) {
            return reply.code(400).send({
              error: 'That GSTIN is not valid — the check digit does not match.',
            });
          }
          // The state code is the GSTIN's first two digits by definition. If a
          // different one was sent, the two disagree about which state this
          // workspace is in, and that decides CGST+SGST versus IGST on every
          // invoice it raises.
          const implied = stateOfGstin(gstin);
          if (b.stateCode && b.stateCode !== implied) {
            return reply.code(400).send({
              error: `That GSTIN belongs to state ${implied}, but the state code says ${b.stateCode}.`,
            });
          }
        }

        if (b.pan !== undefined) {
          // Checked against the GSTIN this request sets, or failing that the
          // one already stored: a GSTIN embeds its holder's PAN at characters
          // 3 to 12, so the two cannot disagree without one of them being
          // wrong — and both are filed.
          let against = gstin;
          if (!against) {
            const { rows: [cur] } = await db.query(
              `SELECT gstin FROM tenants WHERE id = app_current_tenant()`);
            against = (cur?.gstin as string) || undefined;
          }
          const panOk = checkPan(b.pan, against);
          if (!panOk.ok) return reply.code(400).send({ error: panOk.reason });
        }

        // Setting a GSTIN with no PAN alongside it fills the PAN in, since the
        // GSTIN already contains it. Saves a builder typing the same ten
        // characters twice and guarantees the two agree.
        const derivedPan = (gstin && b.pan === undefined) ? panFromGstin(gstin) : undefined;

        const sets: string[] = [];
        const vals: unknown[] = [];
        const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

        if (b.company !== undefined) put('company', b.company);
        if (b.name !== undefined) put('name', b.name);
        if (b.email !== undefined) put('email', b.email);
        if (b.phone !== undefined) put('phone', b.phone);
        if (b.address !== undefined) put('address', b.address);
        if (b.rera !== undefined) put('rera', b.rera);
        if (b.city !== undefined) put('city', b.city);
        if (b.pan !== undefined) put('pan', normalisePan(b.pan));
        else if (derivedPan) put('pan', derivedPan);
        if (b.primaryColor !== undefined) put('primary_color', b.primaryColor);
        if (b.logoUrl !== undefined) put('logo_url', b.logoUrl);
        if (b.slug !== undefined) put('slug', b.slug);
        if (b.brandVoice !== undefined) put('brand_voice', b.brandVoice);
        if (b.audience !== undefined) put('audience', b.audience);
        if (b.channels !== undefined) put('channels', JSON.stringify(b.channels));
        if (b.pincode !== undefined) put('pincode', b.pincode);
        if (b.einvoicingEnabled !== undefined) put('einvoicing_enabled', b.einvoicingEnabled);
        if (gstin !== undefined) {
          put('gstin', gstin);
          // Kept in step so the legacy field does not drift into disagreeing
          // with the one the tax modules actually read.
          put('gst', gstin);
          put('state_code', b.stateCode || stateOfGstin(gstin));
        } else if (b.stateCode !== undefined) {
          put('state_code', b.stateCode);
        }

        if (!sets.length) return reply.code(400).send({ error: 'Nothing to update.' });

        let rows;
        try {
          ({ rows } = await db.query(
          `UPDATE tenants SET ${sets.join(', ')}, updated_at = now()
            WHERE id = app_current_tenant()
            RETURNING id, name, company, slug, email, phone, address, rera, gst,
                      gstin, state_code, city, pincode, einvoicing_enabled,
                      currency, country, plan, status`,
          vals));
        } catch (e) {
          // The subdomain is the workspace's public identity — the portal login
          // and the microsite both resolve by it, so taking someone else's
          // would hand you their customers' sign-in page. The uniqueness is
          // enforced by the constraint rather than a SELECT, because tenants
          // is under RLS: a pre-check could never see the row it must find.
          if ((e as { code?: string }).code === '23505') {
            return reply.code(409).send({
              error: 'That subdomain is already taken — pick another.',
            });
          }
          throw e;
        }
        if (!rows[0]) return reply.code(404).send({ error: 'Workspace not found' });

        const t = rows[0];
        return {
          workspace: {
            id: t.id, name: t.name, company: t.company, slug: t.slug,
            email: t.email ?? '', phone: t.phone ?? '', address: t.address ?? '',
            rera: t.rera ?? '', gst: t.gst ?? '', gstin: t.gstin ?? '',
            stateCode: t.state_code ?? '', city: t.city ?? '', pincode: t.pincode ?? '',
            einvoicingEnabled: !!t.einvoicing_enabled,
            currency: t.currency, country: t.country, plan: t.plan, status: t.status,
          },
        };
      }),
  );
}
