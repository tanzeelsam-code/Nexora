"use strict";
const { z } = require("zod");
const { unavailable } = require("./maps.cjs");
const moneySchema = z
  .number()
  .min(0)
  .max(1000000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    "Use at most two decimal places.",
  );
const pickupSchema = z.object({
  pickup_address: z.string().trim().min(3).max(500),
  pickup_lat: z.number().min(-90).max(90),
  pickup_lng: z.number().min(-180).max(180),
  pickup_contact_name: z.string().trim().min(1).max(100),
  pickup_contact_phone: z.string().trim().min(8).max(20),
});
const columns = `d.id,d.delivery_number,d.merchant_order_ref,d.status,d.pickup_address,d.dropoff_address,
  d.dropoff_contact_name,d.total_fare,d.currency,d.cod_amount,d.cod_collected_at,d.cod_received_at,d.cod_settled_at,d.requested_at,d.tracking_url`;
function registerMerchants({
  app,
  query,
  transaction,
  validate,
  authenticate,
  requireDatabase,
  requireRole,
  market,
}) {
  const customer = [authenticate, requireDatabase, requireRole("customer")];
  const staff = [authenticate, requireDatabase, requireRole("admin", "ops")];
  const profile = async (userId, run = query) =>
    (await run("SELECT * FROM merchant_profiles WHERE user_id=$1", [userId]))
      .rows[0];
  async function requireMerchant(userId, body, run = query) {
    if (
      (body.cod_amount > 0 || body.merchant_order_ref) &&
      !(await profile(userId, run))
    )
      throw unavailable(
        "Create your business profile in the merchant desk before booking a business delivery.",
        409,
      );
    if (body.cod_amount > 0 && !body.merchant_order_ref)
      throw unavailable("Enter an order reference for a COD delivery.", 400);
  }
  app.get(
    "/api/v1/merchant/profile",
    { preHandler: customer },
    async (req) => ({
      profile: (await profile(req.user.id)) || null,
      currency: market.currency,
    }),
  );
  app.post(
    "/api/v1/merchant/profile",
    { preHandler: customer },
    async (req) => {
      const body = validate(
        z.object({
          business_name: z.string().trim().min(2).max(150),
          pickup: pickupSchema.nullable().optional(),
        }),
        req.body,
      );
      return transaction(async (client) => {
        const {
          rows: [user],
        } = await client.query(
          "SELECT is_active FROM users WHERE id=$1 FOR UPDATE",
          [req.user.id],
        );
        if (!user?.is_active)
          throw unavailable("This account is no longer active.", 401);
        const current = await profile(req.user.id, client.query.bind(client));
        const p = body.pickup === undefined ? current : body.pickup;
        const {
          rows: [saved],
        } = await client.query(
          `INSERT INTO merchant_profiles(user_id,business_name,pickup_address,pickup_lat,pickup_lng,pickup_contact_name,pickup_contact_phone)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET business_name=EXCLUDED.business_name,
        pickup_address=EXCLUDED.pickup_address,pickup_lat=EXCLUDED.pickup_lat,pickup_lng=EXCLUDED.pickup_lng,
        pickup_contact_name=EXCLUDED.pickup_contact_name,pickup_contact_phone=EXCLUDED.pickup_contact_phone,updated_at=NOW() RETURNING *`,
          [
            req.user.id,
            body.business_name,
            p?.pickup_address || null,
            p?.pickup_lat ?? null,
            p?.pickup_lng ?? null,
            p?.pickup_contact_name || null,
            p?.pickup_contact_phone || null,
          ],
        );
        return { profile: saved, currency: market.currency };
      });
    },
  );
  async function balances(userId) {
    return (
      await query(
        `SELECT currency,
      COALESCE(SUM(cod_amount) FILTER(WHERE status IN ('pending','pickup_scheduled','picked_up','in_transit','out_for_delivery')),0) AS expected,
      COALESCE(SUM(cod_amount) FILTER(WHERE cod_collected_at IS NOT NULL AND cod_received_at IS NULL),0) AS with_drivers,
      COALESCE(SUM(cod_amount) FILTER(WHERE cod_received_at IS NOT NULL AND cod_settled_at IS NULL),0) AS awaiting_settlement,
      COALESCE(SUM(cod_amount) FILTER(WHERE cod_settled_at IS NOT NULL),0) AS settled
      FROM deliveries WHERE customer_id=$1 AND cod_amount>0 GROUP BY currency ORDER BY currency`,
        [userId],
      )
    ).rows;
  }
  app.get("/api/v1/merchant/desk", { preHandler: customer }, async (req) => {
    const filter = validate(
      z.object({
        q: z.string().trim().max(100).default(""),
        status: z
          .enum([
            "all",
            "active",
            "with_drivers",
            "awaiting_settlement",
            "settled",
          ])
          .default("all"),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      }),
      req.query,
    );
    const where = [
      "d.customer_id=$1",
      "(d.merchant_order_ref IS NOT NULL OR d.cod_amount>0)",
    ];
    const params = [req.user.id];
    if (filter.q) {
      params.push(filter.q.replace(/[\\%_]/g, "\\$&"));
      where.push(
        `(d.merchant_order_ref ILIKE '%' || $${params.length} || '%' OR d.delivery_number ILIKE '%' || $${params.length} || '%')`,
      );
    }
    const conditions = {
      active:
        "d.status IN ('pending','pickup_scheduled','picked_up','in_transit','out_for_delivery')",
      with_drivers:
        "d.cod_collected_at IS NOT NULL AND d.cod_received_at IS NULL",
      awaiting_settlement:
        "d.cod_received_at IS NOT NULL AND d.cod_settled_at IS NULL",
      settled: "d.cod_settled_at IS NOT NULL",
    };
    if (conditions[filter.status]) where.push(conditions[filter.status]);
    params.push((filter.page - 1) * 25);
    const deliveries = (
      await query(
        `SELECT ${columns} FROM deliveries d WHERE ${where.join(" AND ")} ORDER BY d.requested_at DESC,d.id DESC LIMIT 26 OFFSET $${params.length}`,
        params,
      )
    ).rows;
    return {
      profile: (await profile(req.user.id)) || null,
      balances: await balances(req.user.id),
      deliveries: deliveries.slice(0, 25),
      has_more: deliveries.length > 25,
      page: filter.page,
      currency: market.currency,
    };
  });
  app.get(
    "/api/v1/merchant/deliveries/:id/events",
    { preHandler: customer },
    async (req) => {
      const id = validate(z.string().uuid(), req.params.id);
      const { rowCount } = await query(
        "SELECT id FROM deliveries WHERE id=$1 AND customer_id=$2",
        [id, req.user.id],
      );
      if (!rowCount) throw unavailable("Delivery not found.", 404);
      return {
        events: (
          await query(
            "SELECT kind,amount,currency,reference,created_at FROM cod_events WHERE delivery_id=$1 ORDER BY created_at,id",
            [id],
          )
        ).rows,
      };
    },
  );
  app.get("/api/v1/admin/cod", { preHandler: staff }, async (req) => {
    const { page } = validate(
      z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }),
      req.query,
    );
    const rows = (
      await query(
        `SELECT ${columns},m.business_name,u.email,dr.first_name AS driver_name
      FROM deliveries d LEFT JOIN merchant_profiles m ON m.user_id=d.customer_id JOIN users u ON u.id=d.customer_id
      LEFT JOIN drivers driver ON driver.id=d.driver_id LEFT JOIN users dr ON dr.id=driver.user_id
      WHERE d.cod_collected_at IS NOT NULL AND d.cod_settled_at IS NULL
      ORDER BY d.cod_collected_at,d.id LIMIT 26 OFFSET $1`,
        [(page - 1) * 25],
      )
    ).rows;
    return { deliveries: rows.slice(0, 25), has_more: rows.length > 25, page };
  });
  app.post(
    "/api/v1/admin/cod/:id/:action",
    { preHandler: staff },
    async (req) => {
      const id = validate(z.string().uuid(), req.params.id),
        action = validate(z.enum(["received", "settled"]), req.params.action);
      const body = validate(
        z.object({
          reference: z.string().trim().min(3).max(150),
          amount: moneySchema,
          confirm: z.literal(true),
        }),
        req.body,
      );
      return transaction(async (client) => {
        const {
          rows: [d],
        } = await client.query(
          "SELECT * FROM deliveries WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (!d || Number(d.cod_amount) <= 0)
          throw unavailable("COD delivery not found.", 404);
        if (
          Math.round(body.amount * 100) !==
          Math.round(Number(d.cod_amount) * 100)
        )
          throw unavailable(
            "Confirm the exact goods amount. Delivery fees are separate.",
            400,
          );
        const {
          rows: [existing],
        } = await client.query(
          "SELECT kind,amount,currency,reference,created_at FROM cod_events WHERE delivery_id=$1 AND kind=$2",
          [id, action],
        );
        if (existing) {
          if (existing.reference !== body.reference)
            throw unavailable(
              "This step was already recorded with a different reference. Refresh the desk.",
              409,
            );
          return { event: existing, replayed: true };
        }
        if (
          d.status !== "delivered" ||
          !d.cod_collected_at ||
          (action === "settled" && !d.cod_received_at)
        )
          throw unavailable(
            "Record collection and receipt of the goods payment before merchant settlement.",
            409,
          );
        const timestamp =
          action === "received" ? "cod_received_at" : "cod_settled_at";
        await client.query(
          `UPDATE deliveries SET ${timestamp}=NOW() WHERE id=$1`,
          [id],
        );
        const {
          rows: [event],
        } = await client.query(
          `INSERT INTO cod_events(delivery_id,kind,amount,currency,actor_id,reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING kind,amount,currency,reference,created_at`,
          [id, action, d.cod_amount, d.currency, req.user.id, body.reference],
        );
        return {
          event,
          message: "Recorded. No money was transferred by Nexora.",
        };
      });
    },
  );
  return { requireMerchant };
}
module.exports = { registerMerchants, moneySchema };
