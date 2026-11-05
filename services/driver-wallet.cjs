"use strict";
/*
 * Driver cash wallet.
 *
 * Cash rides and deliveries: the driver keeps the whole fare, so the platform commission is
 * added to what the driver owes (one ledger row per job, written in the completion transaction).
 * Drivers pay by Easypaisa, JazzCash or bank transfer and submit the transaction ID; operations
 * check it against their own account statement and confirm or reject it. Operations can also
 * record cash received at an office. Administrators can post signed adjustments with a note.
 *
 * Nexora records these payments. It does not move money or call a wallet provider.
 * DRIVER_CASH_LIMIT (optional) stops drivers who owe more than the limit from going online or
 * receiving new offers until they pay.
 */
const { z } = require("zod");
const { unavailable } = require("./maps.cjs");
const { moneySchema } = require("./merchants.cjs");

const METHODS = ["easypaisa", "jazzcash", "bank_transfer", "cash_office"];
const DRIVER_METHODS = ["easypaisa", "jazzcash", "bank_transfer"];
const MAX_PENDING = 5;
const cents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (value) => Number((value / 100).toFixed(2));

const referenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _/-]{3,59}$/, "Enter the transaction ID exactly as shown on your receipt (4–60 letters or digits).");
const positiveMoney = moneySchema.refine((n) => n > 0, "Enter an amount greater than zero.");

function parseWalletConfig(env = {}) {
  let limit = null;
  if (String(env.DRIVER_CASH_LIMIT || "").trim() !== "") {
    limit = Number(env.DRIVER_CASH_LIMIT);
    if (!Number.isFinite(limit) || limit < 0 || limit > 1000000) throw new Error("DRIVER_CASH_LIMIT must be a number between 0 and 1000000");
  }
  let accounts = [];
  if (String(env.DRIVER_REMITTANCE_ACCOUNTS_JSON || "").trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(env.DRIVER_REMITTANCE_ACCOUNTS_JSON);
    } catch {
      throw new Error("DRIVER_REMITTANCE_ACCOUNTS_JSON must be valid JSON");
    }
    const result = z
      .array(
        z.object({
          method: z.enum(DRIVER_METHODS),
          title: z.string().trim().min(2).max(100),
          account: z.string().trim().min(4).max(40),
        }),
      )
      .max(5)
      .safeParse(parsed);
    if (!result.success) throw new Error("DRIVER_REMITTANCE_ACCOUNTS_JSON must be a list of {method,title,account} (method: easypaisa, jazzcash or bank_transfer)");
    accounts = result.data;
  }
  return { limit, accounts };
}

function registerDriverWallet({ app, query, transaction, validate, authenticate, requireDatabase, requireRole, requireDriver, auditLog, market, env }) {
  const { limit, accounts } = parseWalletConfig(env);
  const currency = market.currency;
  const driverOnly = [authenticate, requireDatabase, requireDriver];
  const staff = [authenticate, requireDatabase, requireRole("admin", "ops")];
  const admin = [authenticate, requireDatabase, requireRole("admin")];
  const uuid = z.string().uuid();

  async function balanceCents(driverId, run = query) {
    const {
      rows: [row],
    } = await run("SELECT COALESCE(SUM(amount),0) AS balance FROM driver_cash_ledger WHERE driver_id=$1 AND currency=$2", [driverId, currency]);
    return cents(row.balance);
  }

  // Called inside the ride/delivery completion transaction. Replays are ignored by the unique index.
  async function recordCommission(client, { driverId, tripId = null, deliveryId = null, amount, currency: jobCurrency }) {
    if (!(cents(amount) > 0)) return;
    const target = tripId ? "(trip_id) WHERE kind='commission'" : "(delivery_id) WHERE kind='commission'";
    await client.query(
      `INSERT INTO driver_cash_ledger(driver_id,kind,amount,currency,trip_id,delivery_id)
       VALUES($1,'commission',$2,$3,$4,$5) ON CONFLICT ${target} DO NOTHING`,
      [driverId, fromCents(cents(amount)), jobCurrency || currency, tripId, deliveryId],
    );
  }

  async function overLimit(driverId) {
    if (limit === null) return null;
    const owed = await balanceCents(driverId);
    return owed > cents(limit) ? owed : null;
  }

  // Used by dispatch: drivers over the limit receive no new offers.
  const dispatchCondition = (driverColumn, limitParam, currencyParam) =>
    `(${limitParam}::numeric IS NULL OR COALESCE((SELECT SUM(l.amount) FROM driver_cash_ledger l WHERE l.driver_id=${driverColumn} AND l.currency=${currencyParam}),0) <= ${limitParam}::numeric)`;

  function limitMessage(owedCents) {
    const format = (value) => new Intl.NumberFormat("en-PK", { style: "currency", currency }).format(value);
    return `You owe ${format(fromCents(owedCents))} in commission, above the ${format(limit)} limit. Pay your balance and wait for confirmation to go online.`;
  }

  app.get("/api/v1/driver/wallet", { preHandler: driverOnly }, async (req) => {
    const id = req.driver.id;
    const [summary, goods, remittances, entries] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(amount),0) AS balance,
           COALESCE(SUM(amount) FILTER (WHERE kind='commission'),0) AS commission,
           COALESCE(-SUM(amount) FILTER (WHERE kind='remittance'),0) AS paid,
           COALESCE(SUM(amount) FILTER (WHERE kind='adjustment'),0) AS adjustments
         FROM driver_cash_ledger WHERE driver_id=$1 AND currency=$2`,
        [id, currency],
      ),
      query(
        `SELECT COALESCE(SUM(cod_amount),0) AS amount, COUNT(*)::int AS deliveries FROM deliveries
         WHERE driver_id=$1 AND currency=$2 AND cod_collected_at IS NOT NULL AND cod_received_at IS NULL`,
        [id, currency],
      ),
      query(
        `SELECT id,method,reference,amount,currency,status,review_note,created_at,reviewed_at
         FROM driver_remittances WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      query(
        `SELECT l.kind,l.amount,l.currency,l.note,l.created_at,t.trip_number,d.delivery_number,r.method,r.reference
         FROM driver_cash_ledger l LEFT JOIN trips t ON t.id=l.trip_id LEFT JOIN deliveries d ON d.id=l.delivery_id
         LEFT JOIN driver_remittances r ON r.id=l.remittance_id
         WHERE l.driver_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 50`,
        [id],
      ),
    ]);
    const s = summary.rows[0];
    const balance = cents(s.balance);
    const pending = remittances.rows.filter((r) => r.status === "pending").reduce((sum, r) => sum + cents(r.amount), 0);
    return {
      currency,
      balance: fromCents(balance),
      commission: Number(s.commission),
      paid: Number(s.paid),
      adjustments: Number(s.adjustments),
      pending_confirmation: fromCents(pending),
      limit,
      over_limit: limit !== null && balance > cents(limit),
      goods_cash: { amount: Number(goods.rows[0].amount), deliveries: goods.rows[0].deliveries },
      payment_accounts: accounts,
      remittances: remittances.rows,
      entries: entries.rows,
    };
  });

  app.post(
    "/api/v1/driver/wallet/remittances",
    { preHandler: driverOnly, config: { rateLimit: { max: 10, timeWindow: 3600000 } } },
    async (req, reply) => {
      const body = validate(z.object({ method: z.enum(DRIVER_METHODS), reference: referenceSchema, amount: positiveMoney }), req.body);
      const saved = await transaction(async (client) => {
        // Serialize claims per driver so the outstanding-balance check cannot be raced.
        await client.query("SELECT id FROM drivers WHERE id=$1 FOR UPDATE", [req.driver.id]);
        const owed = await balanceCents(req.driver.id, client.query.bind(client));
        const {
          rows: [pending],
        } = await client.query(
          "SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS amount FROM driver_remittances WHERE driver_id=$1 AND status='pending' AND currency=$2",
          [req.driver.id, currency],
        );
        if (pending.count >= MAX_PENDING) return { status: 409, error: "You have several payments waiting for confirmation. Please wait for operations to review them." };
        if (cents(body.amount) > owed - cents(pending.amount))
          return { status: 409, error: "This is more than your outstanding balance after payments waiting for confirmation." };
        try {
          const {
            rows: [row],
          } = await client.query(
            `INSERT INTO driver_remittances(driver_id,method,reference,amount,currency,submitted_by)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING id,method,reference,amount,currency,status,created_at`,
            [req.driver.id, body.method, body.reference, body.amount, currency, req.user.id],
          );
          return { row };
        } catch (err) {
          if (err.code === "23505") return { status: 409, error: "This transaction ID has already been submitted." };
          throw err;
        }
      });
      if (saved.error) return reply.code(saved.status).send({ error: saved.error });
      return reply.code(201).send({
        remittance: saved.row,
        message: "Payment submitted. Operations will confirm it against their account statement before it reduces your balance.",
      });
    },
  );

  app.get("/api/v1/admin/driver-wallets", { preHandler: staff }, async (req) => {
    const { page } = validate(z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }), req.query);
    const [drivers, pending] = await Promise.all([
      query(
        `SELECT d.id,d.driver_number,u.first_name,u.last_name,u.phone,
           COALESCE(b.balance,0) AS balance,
           COALESCE(p.pending,0)::int AS pending_count
         FROM drivers d JOIN users u ON u.id=d.user_id
         LEFT JOIN (SELECT driver_id,SUM(amount) AS balance FROM driver_cash_ledger WHERE currency=$1 GROUP BY driver_id) b ON b.driver_id=d.id
         LEFT JOIN (SELECT driver_id,COUNT(*) AS pending FROM driver_remittances WHERE status='pending' GROUP BY driver_id) p ON p.driver_id=d.id
         WHERE COALESCE(b.balance,0) <> 0 OR COALESCE(p.pending,0) > 0
         ORDER BY COALESCE(b.balance,0) DESC,d.id LIMIT 26 OFFSET $2`,
        [currency, (page - 1) * 25],
      ),
      query(
        `SELECT r.id,r.driver_id,r.method,r.reference,r.amount,r.currency,r.created_at,d.driver_number,u.first_name,u.last_name
         FROM driver_remittances r JOIN drivers d ON d.id=r.driver_id JOIN users u ON u.id=d.user_id
         WHERE r.status='pending' ORDER BY r.created_at LIMIT 100`,
      ),
    ]);
    return {
      currency,
      limit,
      can_adjust: req.user.role === "admin",
      drivers: drivers.rows.slice(0, 25),
      has_more: drivers.rows.length > 25,
      page,
      pending: pending.rows,
    };
  });

  app.post("/api/v1/admin/driver-wallets/remittances/:id/:action", { preHandler: staff }, async (req) => {
    const id = validate(uuid, req.params.id);
    const action = validate(z.enum(["confirm", "reject"]), req.params.action);
    const body = validate(
      action === "confirm"
        ? z.object({ amount: positiveMoney, confirm: z.literal(true) })
        : z.object({ note: z.string().trim().min(3).max(300) }),
      req.body,
    );
    const result = await transaction(async (client) => {
      const {
        rows: [r],
      } = await client.query("SELECT * FROM driver_remittances WHERE id=$1 FOR UPDATE", [id]);
      if (!r) throw unavailable("Payment not found.", 404);
      const done = action === "confirm" ? "confirmed" : "rejected";
      if (r.status === done) return { remittance: r, replayed: true };
      if (r.status !== "pending") throw unavailable(`This payment was already ${r.status}. Refresh the list.`, 409);
      if (action === "confirm" && cents(body.amount) !== cents(r.amount))
        throw unavailable("Confirm the exact amount shown on the driver's payment.", 400);
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE driver_remittances SET status=$2,reviewed_by=$3,reviewed_at=NOW(),review_note=$4 WHERE id=$1 RETURNING *`,
        [id, done, req.user.id, action === "reject" ? body.note : null],
      );
      if (action === "confirm")
        await client.query(
          `INSERT INTO driver_cash_ledger(driver_id,kind,amount,currency,remittance_id,actor_id) VALUES($1,'remittance',$2,$3,$4,$5)`,
          [r.driver_id, -Number(r.amount), r.currency, r.id, req.user.id],
        );
      return { remittance: updated };
    });
    if (!result.replayed) await auditLog(req, `driver_wallet.remittance_${action}`, "driver_remittance", id);
    return {
      ...result,
      message: action === "confirm" ? "Payment confirmed and the driver's balance reduced. No money was moved by Nexora." : "Payment rejected. The driver can see your note.",
    };
  });

  app.post("/api/v1/admin/driver-wallets/:driverId/remittances", { preHandler: staff }, async (req, reply) => {
    const driverId = validate(uuid, req.params.driverId);
    const body = validate(z.object({ method: z.enum(METHODS), reference: referenceSchema, amount: positiveMoney, confirm: z.literal(true) }), req.body);
    const saved = await transaction(async (client) => {
      const {
        rows: [driver],
      } = await client.query("SELECT id,user_id FROM drivers WHERE id=$1 FOR UPDATE", [driverId]);
      if (!driver) throw unavailable("Driver not found.", 404);
      try {
        const {
          rows: [row],
        } = await client.query(
          `INSERT INTO driver_remittances(driver_id,method,reference,amount,currency,status,submitted_by,reviewed_by,reviewed_at)
           VALUES($1,$2,$3,$4,$5,'confirmed',$6,$6,NOW()) RETURNING *`,
          [driverId, body.method, body.reference, body.amount, currency, req.user.id],
        );
        await client.query(
          `INSERT INTO driver_cash_ledger(driver_id,kind,amount,currency,remittance_id,actor_id) VALUES($1,'remittance',$2,$3,$4,$5)`,
          [driverId, -body.amount, currency, row.id, req.user.id],
        );
        return { row };
      } catch (err) {
        if (err.code === "23505") return { duplicate: true };
        throw err;
      }
    });
    if (saved.duplicate) return reply.code(409).send({ error: "This transaction reference has already been recorded." });
    await auditLog(req, "driver_wallet.remittance_record", "driver_remittance", saved.row.id);
    return reply.code(201).send({ remittance: saved.row, message: "Payment recorded and the driver's balance reduced. No money was moved by Nexora." });
  });

  app.post("/api/v1/admin/driver-wallets/:driverId/adjustments", { preHandler: admin }, async (req, reply) => {
    const driverId = validate(uuid, req.params.driverId);
    const body = validate(
      z.object({
        amount: z
          .number()
          .min(-1000000)
          .max(1000000)
          .refine((n) => n !== 0 && Math.abs(n * 100 - Math.round(n * 100)) < 0.000001, "Use a non-zero amount with at most two decimal places."),
        note: z.string().trim().min(5).max(300),
        confirm: z.literal(true),
      }),
      req.body,
    );
    const {
      rows: [driver],
    } = await query("SELECT id FROM drivers WHERE id=$1", [driverId]);
    if (!driver) throw unavailable("Driver not found.", 404);
    const {
      rows: [entry],
    } = await query(
      `INSERT INTO driver_cash_ledger(driver_id,kind,amount,currency,note,actor_id) VALUES($1,'adjustment',$2,$3,$4,$5)
       RETURNING id,kind,amount,currency,note,created_at`,
      [driverId, body.amount, currency, body.note, req.user.id],
    );
    await auditLog(req, "driver_wallet.adjustment", "driver", driverId);
    return reply.code(201).send({ entry, message: "Adjustment recorded." });
  });

  return { recordCommission, overLimit, dispatchCondition, limit, currency, limitMessage };
}

module.exports = { registerDriverWallet, parseWalletConfig };
