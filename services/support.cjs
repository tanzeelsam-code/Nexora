"use strict";
const { z } = require("zod");
const { randomUUID, createHash } = require("node:crypto");
const { unavailable } = require("./maps.cjs");
function registerSupport({
  app,
  query,
  validate,
  authenticate,
  requireDatabase,
  requireRole,
  auditLog,
}) {
  const customer = [
    authenticate,
    requireDatabase,
    requireRole("customer", "driver"),
  ];
  const staff = [authenticate, requireDatabase, requireRole("admin", "ops")];
  app.post(
    "/api/v1/support/tickets",
    {
      preHandler: customer,
      config: { rateLimit: { max: 5, timeWindow: 3600000 } },
    },
    async (req) => {
      const body = validate(
        z.object({
          request_id: z.string().uuid().optional(),
          category: z.enum(["booking", "payment", "safety", "account"]),
          message: z.string().trim().min(10).max(2000),
          trip_id: z.string().uuid().optional(),
          delivery_id: z.string().uuid().optional(),
        }),
        req.body,
      );
      const {
        rows: [driver],
      } = await query("SELECT id FROM drivers WHERE user_id=$1", [req.user.id]);
      for (const [table, id] of [
        ["trips", body.trip_id],
        ["deliveries", body.delivery_id],
      ])
        if (id) {
          const { rowCount } = await query(
            `SELECT id FROM ${table} WHERE id=$1 AND (customer_id=$2 OR driver_id=$3)`,
            [id, req.user.id, driver?.id || null],
          );
          if (!rowCount)
            throw unavailable(
              "This journey was not found in your account.",
              404,
            );
        }
      // Stable per-account reference allows an interrupted submission to be retried safely.
      const ref =
        "SUP-" +
        createHash("sha256")
          .update(req.user.id + ":" + (body.request_id || randomUUID()))
          .digest("hex")
          .slice(0, 24);
      const {
        rows: [ticket],
      } = await query(
        `INSERT INTO safety_incidents(incident_ref,customer_id,driver_id,trip_id,delivery_id,type,severity,description)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(incident_ref) DO UPDATE SET incident_ref=EXCLUDED.incident_ref
      WHERE safety_incidents.description=EXCLUDED.description AND safety_incidents.type=EXCLUDED.type
        AND safety_incidents.trip_id IS NOT DISTINCT FROM EXCLUDED.trip_id
        AND safety_incidents.delivery_id IS NOT DISTINCT FROM EXCLUDED.delivery_id
      RETURNING id,incident_ref,status,created_at`,
        [
          ref,
          req.user.id,
          driver?.id || null,
          body.trip_id || null,
          body.delivery_id || null,
          "support_" + body.category,
          body.category === "safety" ? "high" : "low",
          body.message,
        ],
      );
      if (!ticket)
        throw unavailable(
          "This request has already been submitted with different details. Refresh your requests before starting a new one.",
          409,
        );
      return {
        ticket,
        message:
          "Request received. Track the reply here. This is not an emergency response service.",
      };
    },
  );
  app.get("/api/v1/support/tickets", { preHandler: customer }, async (req) => ({
    tickets: (
      await query(
        `SELECT id,incident_ref,type,status,description,resolution_note,created_at,resolved_at
    FROM safety_incidents WHERE customer_id=$1 AND type LIKE 'support_%' ORDER BY created_at DESC LIMIT 50`,
        [req.user.id],
      )
    ).rows,
  }));
  app.get("/api/v1/admin/support", { preHandler: staff }, async () => ({
    tickets: (
      await query(`SELECT s.id,s.incident_ref,s.type,s.severity,s.status,s.description,s.resolution_note,s.created_at,
    s.trip_id,s.delivery_id,u.email,u.first_name,u.last_name FROM safety_incidents s LEFT JOIN users u ON u.id=s.customer_id
    WHERE s.type LIKE 'support_%' ORDER BY CASE WHEN s.status='resolved' THEN 1 ELSE 0 END, s.created_at DESC LIMIT 200`)
    ).rows,
  }));
  app.post("/api/v1/admin/support/:id", { preHandler: staff }, async (req) => {
    const id = validate(z.string().uuid(), req.params.id);
    const body = validate(
      z.object({
        status: z.enum(["open", "investigating", "resolved"]),
        reply: z.string().trim().min(5).max(2000),
      }),
      req.body,
    );
    const {
      rows: [ticket],
    } = await query(
      `UPDATE safety_incidents SET status=$2::varchar,resolution_note=$3,resolved_by=$4,
      resolved_at=CASE WHEN $2::varchar='resolved' THEN NOW() ELSE NULL END WHERE id=$1 AND type LIKE 'support_%' RETURNING id,status`,
      [id, body.status, body.reply, req.user.id],
    );
    if (!ticket) throw unavailable("Support request not found.", 404);
    await auditLog(req, "support.update", "support", id);
    return { ticket };
  });
}
module.exports = { registerSupport };
