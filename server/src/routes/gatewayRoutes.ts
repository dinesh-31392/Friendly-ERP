import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  razorpayConfig, createOrder, verifyWebhookSignature, verifyCheckoutSignature,
  readPaymentEvent,
} from '../razorpay.js';

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
   * Registered as the JSON parser for the whole instance because Fastify has
   * no per-route parser; the buffer is small and dropped with the request.
   */
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
      const cfg = razorpayConfig();
      if (!cfg) {
        return reply.code(503).send({
          error: 'Online payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
        });
      }

      const found = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return { forbidden: true } as const;
        const { rows: [m] } = await db.query(
          `SELECT s.id, s.milestone_name, s.booking_id,
                  milestone_outstanding(s.id) AS outstanding,
                  l.name AS customer_name, l.email AS customer_email
             FROM payment_schedules s
             JOIN bookings b   ON b.id = s.booking_id
             LEFT JOIN leads l ON l.id = b.lead_id
            WHERE s.id = $1`, [req.body.paymentScheduleId]);
        return m ?? null;
      });

      if (found && 'forbidden' in found) {
        return reply.code(403).send({ error: 'Missing permission: manage_finance' });
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
      const cfg = razorpayConfig();
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
    const cfg = razorpayConfig();
    if (!cfg) return reply.code(503).send({ error: 'Not configured' });

    const raw = (req as RawRequest).rawBody;
    const signature = String(req.headers['x-razorpay-signature'] ?? '');
    const verified = !!raw && verifyWebhookSignature(raw, signature, cfg.webhookSecret);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = readPaymentEvent(body);
    // Razorpay's own delivery id, which is present even when the envelope has
    // no `id`. Without an idempotency key there is nothing to deduplicate on,
    // so a payload carrying neither is refused rather than applied blindly.
    const eventId = parsed.eventId || String(req.headers['x-razorpay-event-id'] ?? '');

    if (!verified) {
      // Logged, not silently dropped: a run of these is somebody probing.
      req.log.warn({ eventId, hasSignature: !!signature }, 'razorpay webhook signature rejected');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
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
      const { rows: [event] } = await client.query(
        `INSERT INTO gateway_events
           (tenant_id, provider, event_id, event_type, order_ref, payment_ref, amount,
            signature_verified, payload)
         VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, true, $7)
         ON CONFLICT (provider, event_id) DO NOTHING
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
        configured: !!razorpayConfig(),
      };
    }),
  );
}
