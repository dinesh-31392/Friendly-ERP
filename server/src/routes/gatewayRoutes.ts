import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  razorpayConfig, razorpayFromKeys, RAZORPAY_SERVICE, createOrder,
  verifyWebhookSignature, verifyCheckoutSignature, readPaymentEvent,
  type RazorpayConfig,
} from '../razorpay.js';
import {
  getTenantKeys, putTenantKey, tenantKeyNames, clearTenantKeys, kmsConfigured,
} from '../tenantKeys.js';
import { env } from '../env.js';

/**
 * This workspace's own Razorpay account, or the platform's.
 *
 * Called with an RLS-bound client, so tenant_keys is already scoped to the
 * caller's workspace by the database — there is no tenant id to pass and
 * therefore none to get wrong.
 */
async function workspaceRazorpay(db: import('pg').PoolClient): Promise<RazorpayConfig | null> {
  const own = razorpayFromKeys(await getTenantKeys(db, RAZORPAY_SERVICE));
  return own ?? razorpayConfig();
}

/**
 * The same, for a tenant named explicitly — the webhook path, where there is
 * no session and the workspace has been resolved from the order.
 *
 * The platform pool BYPASSes RLS, so this is one of the few places a tenant id
 * is passed by hand. It comes from gateway_orders.tenant_id, which the caller
 * read from the database rather than from anything in the request.
 */
async function tenantRazorpayById(
  client: import('pg').PoolClient, tenantId: string,
): Promise<RazorpayConfig | null> {
  if (!env.kmsKey) return null;
  const { rows } = await client.query(
    `SELECT key_name, pgp_sym_decrypt(value_enc, $2) AS value
       FROM tenant_keys WHERE tenant_id = $1 AND service = $3`,
    [tenantId, env.kmsKey, RAZORPAY_SERVICE],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const keys: Record<string, string> = {};
  for (const r of rows) if (r.value) keys[r.key_name as string] = r.value as string;
  return razorpayFromKeys(keys);
}

/**
 * Online payments (migration 055).
 *
 * The shape of this is decided by one rule: the client never says a payment
 * succeeded. The browser asks for an order, the server computes the amount from
 * the milestone and creates it, the buyer pays, and the money is recorded only
 * when Razorpay's own signed webhook arrives.
 *
 * The webhook is PUBLIC — Razorpay has no session — and is therefore the most
 * exposed endpoint in the product. Everything about its handling is shaped by
 * that: raw-body signature verification, an idempotency key that is the
 * gateway's own event id, a database constraint that refuses to apply an
 * unverified event, and a 200 for anything already seen so retries stop.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

/** The raw bytes, stashed by the content-type parser below. */
type RawRequest = FastifyRequest & { rawBody?: Buffer };

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Keep the raw body for JSON requests.
   *
   * The webhook signature is an HMAC over the bytes Razorpay sent. Re-encoding
   * the parsed object produces a different string — key order, whitespace,
   * unicode escaping all differ — and the signature then never matches, which
   * presents as "the gateway is misconfigured" and wastes a day.
   *
   * Fastify installs its own JSON parser at boot, so this replaces it rather
   * than adding a second — `addContentTypeParser` alone throws
   * FST_ERR_CTP_ALREADY_PRESENT and takes the whole server down at startup.
   *
   * Both calls are ENCAPSULATED to this plugin, which is what we want: only the
   * routes below pay for keeping a buffer, and every other route in the app
   * keeps Fastify's own parser untouched.
   */
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as RawRequest).rawBody = body;
      if (!body || body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    });

  /**
   * POST /api/payments/gateway/order — raise an order for a milestone.
   *
   * The client sends WHICH milestone, never how much. A body carrying the
   * amount would let a buyer pay ₹1 against a ₹10 lakh instalment, and the
   * webhook would faithfully record it.
   */
  app.post<{ Body: { paymentScheduleId: string } }>(
    '/api/payments/gateway/order',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['paymentScheduleId'], additionalProperties: false,
          properties: { paymentScheduleId: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req, reply) => {
      // The workspace's own Razorpay account if it has connected one, so the
      // buyer's money reaches this builder rather than the platform operator.
      // Both come out of one tenant context — returned rather than assigned to
      // a captured variable, which TypeScript cannot narrow across the closure.
      const result = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return { forbidden: true } as const;
        const cfg = await workspaceRazorpay(db);
        const { rows: [m] } = await db.query(
          `SELECT s.id, s.milestone_name, s.booking_id,
                  milestone_outstanding(s.id) AS outstanding,
                  l.name AS customer_name, l.email AS customer_email
             FROM payment_schedules s
             JOIN bookings b   ON b.id = s.booking_id
             LEFT JOIN leads l ON l.id = b.lead_id
            WHERE s.id = $1`, [req.body.paymentScheduleId]);
        return { cfg, milestone: m ?? null };
      });

      if ('forbidden' in result) {
        return reply.code(403).send({ error: 'Missing permission: manage_finance' });
      }
      const { cfg, milestone: found } = result;
      if (!cfg) {
        return reply.code(503).send({
          error: 'Online payments are not configured. Connect your Razorpay account in '
               + 'Settings → Integrations, or set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
        });
      }
      if (!found) return reply.code(404).send({ error: 'Milestone not found' });

      // The amount is the OUTSTANDING balance, computed now. A milestone
      // already paid must not be payable again.
      const outstanding = Number(found.outstanding ?? 0);
      if (outstanding <= 0) {
        return reply.code(409).send({ error: 'That milestone is already fully paid.' });
      }

      let order;
      try {
        order = await createOrder(cfg, {
          amountRupees: outstanding,
          receipt: String(found.id),
          notes: {
            scheduleId: String(found.id),
            bookingId: String(found.booking_id),
            milestone: String(found.milestone_name ?? ''),
          },
        });
      } catch (err) {
        req.log.error({ err: String(err) }, 'razorpay order creation failed');
        return reply.code(502).send({ error: 'The payment gateway could not create the order. Try again.' });
      }

      await withTenantContext(req.ctx, async (db) => {
        await db.query(
          `INSERT INTO gateway_orders
             (tenant_id, provider, order_ref, payment_schedule_id, amount, currency, created_by)
           VALUES (app_current_tenant(), 'razorpay', $1, $2, $3, 'INR', $4)`,
          [order.id, found.id, outstanding, req.ctx.userId]);
      });

      reply.code(201);
      // The KEY ID is public by design — Razorpay's checkout script needs it in
      // the browser. The key SECRET never leaves the server.
      return {
        order: {
          orderId: order.id,
          amount: order.amount,          // paise, which is what checkout expects
          amountRupees: outstanding,
          currency: order.currency,
          keyId: cfg.keyId,
          customerName: found.customer_name ?? undefined,
          customerEmail: found.customer_email ?? undefined,
          milestone: found.milestone_name ?? undefined,
        },
      };
    },
  );

  /**
   * POST /api/payments/gateway/confirm — the checkout handler's own signature.
   *
   * Lets the page say "paid" without waiting for the webhook. It does NOT
   * record money: the webhook does that. This exists so a buyer sees a
   * confirmation immediately, and so a page that stays open can stop spinning.
   */
  app.post<{ Body: { orderId: string; paymentId: string; signature: string } }>(
    '/api/payments/gateway/confirm',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['orderId', 'paymentId', 'signature'], additionalProperties: false,
          properties: {
            orderId: { type: 'string', maxLength: 120 },
            paymentId: { type: 'string', maxLength: 120 },
            signature: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      // Verified against the account that CREATED the order — this workspace's
      // own, if it has one. Checking a workspace's checkout handler against the
      // platform's key secret would reject every genuine payment.
      const cfg = await withTenantContext(req.ctx, db => workspaceRazorpay(db));
      if (!cfg) return reply.code(503).send({ error: 'Online payments are not configured.' });
      const valid = verifyCheckoutSignature(
        req.body.orderId, req.body.paymentId, req.body.signature, cfg.keySecret);
      if (!valid) return reply.code(400).send({ error: 'That payment could not be verified.' });
      return { verified: true, note: 'The receipt is recorded when the gateway webhook arrives.' };
    },
  );

  /**
   * POST /api/webhooks/razorpay — the only thing that records money.
   *
   * Public, unauthenticated, and verified by signature. Deliberately NOT
   * tenant-scoped by a session: there is nobody signed in. The order id in the
   * payload resolves the workspace, which is why gateway_orders.order_ref is
   * globally unique.
   *
   * Returns 200 for events it has already seen. Razorpay retries until it gets
   * a 2xx, so a duplicate answered with an error becomes an infinite retry
   * loop against production.
   */
  app.post('/api/webhooks/razorpay', {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const raw = (req as RawRequest).rawBody;
    const signature = String(req.headers['x-razorpay-signature'] ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = readPaymentEvent(body);
    // Razorpay's own delivery id, which is present even when the envelope has
    // no `id`. Without an idempotency key there is nothing to deduplicate on,
    // so a payload carrying neither is refused rather than applied blindly.
    const eventId = parsed.eventId || String(req.headers['x-razorpay-event-id'] ?? '');

    if (!eventId) return reply.code(400).send({ error: 'Missing event id' });

    // The platform pool, because there is no session to derive a tenant from.
    // Everything below scopes explicitly by the order's own tenant_id.
    const client = await platformPool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [order] } = await client.query(
        `SELECT id, tenant_id, payment_schedule_id, amount, status
           FROM gateway_orders WHERE provider = 'razorpay' AND order_ref = $1`,
        [parsed.orderId]);

      /**
       * THE ORDER IS LOOKED UP BEFORE THE SIGNATURE IS CHECKED, AND THAT
       * ORDERING IS THE POINT.
       *
       * Each builder connects their own Razorpay account, so each has their own
       * webhook secret. There is no single secret this endpoint could verify
       * against: the right one is whichever workspace raised the order. So the
       * order resolves the workspace, the workspace resolves the secret, and
       * the secret verifies the payload.
       *
       * Nothing is TRUSTED before verification — the lookup is a read, and
       * every write below happens after the check. And the failure responses
       * are deliberately identical whether the order was found or not, so this
       * cannot be used to ask "does order X exist on this platform".
       */
      const cfg = order
        ? (await tenantRazorpayById(client, order.tenant_id as string)) ?? razorpayConfig()
        : razorpayConfig();

      const verified = !!raw && !!cfg && verifyWebhookSignature(raw, signature, cfg.webhookSecret);
      if (!verified) {
        await client.query('ROLLBACK');
        // Logged, not silently dropped: a run of these is somebody probing.
        req.log.warn({ eventId, hasSignature: !!signature }, 'razorpay webhook signature rejected');
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      if (!order) {
        // An event for an order this system never raised. Recorded against no
        // tenant is impossible (tenant_id is NOT NULL), so acknowledge and move
        // on rather than retry forever.
        await client.query('ROLLBACK');
        req.log.warn({ orderId: parsed.orderId, eventId }, 'razorpay webhook for an unknown order');
        return { ok: true, ignored: 'unknown order' };
      }

      // The idempotency gate. ON CONFLICT DO NOTHING means a redelivery inserts
      // no row and returns none — which is how a duplicate is detected without
      // a race between a SELECT and an INSERT.
      //
      // Keyed by TENANT as well (065). Razorpay event ids are unique within a
      // merchant account and every builder connects their own, so a global key
      // let the first workspace to see an id suppress that id for everybody:
      // another builder's payment.captured would be answered 200 as a
      // duplicate and their demand would never be marked paid.
      const { rows: [event] } = await client.query(
        `INSERT INTO gateway_events
           (tenant_id, provider, event_id, event_type, order_ref, payment_ref, amount,
            signature_verified, payload)
         VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, true, $7)
         ON CONFLICT (tenant_id, provider, event_id) DO NOTHING
         RETURNING id`,
        [order.tenant_id, eventId, parsed.eventType, parsed.orderId, parsed.paymentId,
         parsed.amountRupees, JSON.stringify(body)]);

      if (!event) {
        await client.query('ROLLBACK');
        return { ok: true, duplicate: true };
      }

      if (parsed.eventType === 'payment.captured') {
        // The amount comes from the GATEWAY's payload, not from our order — if
        // they disagree, what the buyer actually paid is what happened, and the
        // difference is worth seeing rather than papering over.
        const amount = parsed.amountRupees > 0 ? parsed.amountRupees : Number(order.amount);

        const { rows: [payment] } = await client.query(
          `INSERT INTO payments
             (tenant_id, payment_schedule_id, amount, payment_date, mode, reference_no)
           VALUES ($1, $2, $3, CURRENT_DATE, 'bank_transfer', $4)
           RETURNING id`,
          [order.tenant_id, order.payment_schedule_id, amount, parsed.paymentId]);

        await client.query(
          `UPDATE gateway_orders SET status = 'paid' WHERE id = $1`, [order.id]);
        await client.query(
          `UPDATE gateway_events SET applied_at = now(), payment_id = $1 WHERE id = $2`,
          [payment.id, event.id]);
      } else if (parsed.eventType === 'payment.failed') {
        await client.query(
          `UPDATE gateway_orders SET status = 'failed' WHERE id = $1`, [order.id]);
        await client.query(
          `UPDATE gateway_events SET applied_at = now() WHERE id = $1`, [event.id]);
      } else {
        // Recorded but not acted on. Razorpay sends a dozen event types and a
        // handler that treats an unknown one as a payment is how refunds get
        // booked as receipts.
        await client.query(
          `UPDATE gateway_events SET applied_at = now() WHERE id = $1`, [event.id]);
      }

      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      req.log.error({ err: String(err), eventId }, 'razorpay webhook failed');
      // A 500 makes Razorpay retry, which is right: the event was verified and
      // something transient stopped it landing.
      return reply.code(500).send({ error: 'Could not process the event' });
    } finally {
      client.release();
    }
  });

  /** GET /api/payments/gateway/events — what the gateway has sent us. */
  app.get('/api/payments/gateway/events', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(
        `SELECT id, provider, event_id, event_type, order_ref, payment_ref, amount,
                signature_verified, applied_at, error, received_at
           FROM gateway_events ORDER BY received_at DESC LIMIT 200`);
      return {
        events: rows.map(r => ({
          id: r.id,
          provider: r.provider,
          eventId: r.event_id,
          eventType: r.event_type,
          orderRef: r.order_ref,
          paymentRef: r.payment_ref,
          amount: Number(r.amount),
          signatureVerified: !!r.signature_verified,
          appliedAt: r.applied_at ?? null,
          error: r.error ?? '',
          receivedAt: r.received_at,
        })),
        // Deliberately NOT the secret — only whether one is present, which is
        // the question an admin actually needs answered.
        configured: !!(await workspaceRazorpay(db)),
      };
    }),
  );

  /**
   * GET /api/gateway/credentials — is this workspace's own account connected?
   *
   * Answers only that. There is no parameter that makes it return a stored
   * secret, because no code path here decrypts one: it reads key NAMES.
   *
   * `source` is what a builder actually needs to know, and it is uncomfortable
   * on purpose — 'platform' means their buyers' money is landing in the
   * operator's Razorpay account, not theirs.
   */
  app.get('/api/gateway/credentials', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_settings')) {
        return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      }
      const names = await tenantKeyNames(db, RAZORPAY_SERVICE);
      const cfg = await workspaceRazorpay(db);
      return {
        service: RAZORPAY_SERVICE,
        // Which fields are stored, never their values.
        keysPresent: names,
        connected: names.includes('key_id') && names.includes('key_secret'),
        hasWebhookSecret: names.includes('webhook_secret'),
        source: cfg?.source ?? null,
        platformFallbackAvailable: !!razorpayConfig(),
        // Without a KMS key nothing can be stored, and saying so up front is
        // better than accepting a secret and failing to encrypt it.
        canStore: kmsConfigured(),
        webhookUrl: env.publicBaseUrl ? `${env.publicBaseUrl}/api/webhooks/razorpay` : '',
      };
    }),
  );

  /**
   * PUT /api/gateway/credentials — connect this workspace's own account.
   *
   * WRITE-ONLY. A value can be replaced and never read back, by anybody,
   * through any route. Stored as pgp_sym_encrypt ciphertext under a key that
   * lives only in the API's environment, so a database dump is not a wallet.
   *
   * An empty string CLEARS that field rather than storing an empty secret —
   * "" would otherwise read back as configured and fail at the moment a buyer
   * tries to pay.
   */
  app.put<{ Body: { keyId?: string; keySecret?: string; webhookSecret?: string } }>(
    '/api/gateway/credentials',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
        keyId: { type: 'string', maxLength: 120 },
        keySecret: { type: 'string', maxLength: 200 },
        webhookSecret: { type: 'string', maxLength: 200 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        if (!kmsConfigured()) {
          return reply.code(503).send({
            error: 'This deployment cannot store payment credentials yet: KMS_KEY is not set. '
                 + 'Generate one (openssl rand -base64 48), set it on the API, and restart.',
          });
        }
        const b = req.body;
        // A key id is public; a key secret is not. Rejecting an obvious
        // swap early is cheaper than a failed payment later.
        if (b.keySecret && /^rzp_(test|live)_/i.test(b.keySecret.trim())) {
          return reply.code(400).send({
            error: 'That looks like the Key Id, not the Key Secret — the secret does not start with rzp_.',
          });
        }
        for (const [field, name] of [
          [b.keyId, 'key_id'], [b.keySecret, 'key_secret'], [b.webhookSecret, 'webhook_secret'],
        ] as const) {
          if (field === undefined) continue;
          await putTenantKey(db, RAZORPAY_SERVICE, name, field, req.ctx.userId);
        }

        const names = await tenantKeyNames(db, RAZORPAY_SERVICE);
        const cfg = await workspaceRazorpay(db);
        return {
          connected: names.includes('key_id') && names.includes('key_secret'),
          keysPresent: names,
          source: cfg?.source ?? null,
          note: names.includes('webhook_secret')
            ? undefined
            : 'No webhook secret stored — the key secret will be used to verify webhooks. '
              + 'Set a separate one in the Razorpay dashboard for safety.',
        };
      }),
  );

  /** DELETE /api/gateway/credentials — disconnect, falling back to the
   *  platform account if the deployment has one. */
  app.delete('/api/gateway/credentials', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_settings')) {
        return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      }
      const removed = await clearTenantKeys(db, RAZORPAY_SERVICE);
      const cfg = await workspaceRazorpay(db);
      return { removed, source: cfg?.source ?? null };
    }),
  );
}
