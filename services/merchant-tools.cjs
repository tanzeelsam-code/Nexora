"use strict";
/*
 * Merchant desk phase 2.
 *
 * - Spreadsheet import: a CSV of orders becomes drafts. Each draft is booked through the normal
 *   delivery form (address on the map, quote, coverage and COD checks), so an import never books
 *   or charges anything by itself. A draft counts as booked once a delivery has its order reference.
 * - Monthly statement: deliveries requested in a calendar month (market timezone) with fees,
 *   goods payments and settlement references, totalled per currency.
 * - Return pickups: a delivery from the original recipient back to the sender, linked to the
 *   delivered original. No goods payment is collected on a return.
 */
const { z } = require("zod");
const { unavailable } = require("./maps.cjs");

const MAX_ROWS = 200;
const MAX_BYTES = 200 * 1024;

// RFC 4180 parsing: quoted fields, doubled quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  const source = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw unavailable("The file has an unclosed quotation mark. Check it and try again.", 400);
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ""));
}

const HEADER_ALIASES = {
  order_ref: ["order_ref", "order", "order_reference", "reference", "order_id", "order_no", "order_number"],
  recipient_name: ["recipient_name", "recipient", "name", "customer_name", "customer"],
  recipient_phone: ["recipient_phone", "phone", "mobile", "phone_number", "contact", "customer_phone"],
  address: ["address", "dropoff_address", "delivery_address", "recipient_address"],
  cod_amount: ["cod_amount", "cod", "goods_amount", "amount", "collect"],
  cargo_description: ["description", "cargo_description", "item", "items", "contents"],
  cargo_weight_kg: ["weight_kg", "weight", "cargo_weight_kg"],
  lat: ["lat", "latitude"],
  lng: ["lng", "lon", "long", "longitude"],
  is_fragile: ["fragile", "is_fragile"],
};

function columnMap(header) {
  const names = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = names.findIndex((name) => aliases.includes(name));
    if (index >= 0) map[key] = index;
  }
  const missing = ["order_ref", "recipient_name", "recipient_phone", "address"].filter((key) => map[key] === undefined);
  if (missing.length) throw unavailable(`The first row must name the columns. Missing: ${missing.join(", ")}.`, 400);
  return map;
}

const number = (value) => (String(value).trim() === "" ? undefined : Number(String(value).replace(/,/g, "").trim()));
const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001;

function validateRow(raw) {
  const errors = [];
  const text = (key, min, max, label) => {
    const value = String(raw[key] ?? "").trim();
    if (value.length < min || value.length > max) errors.push(`${label} must be ${min}–${max} characters.`);
    // Control characters are never valid in these fields.
    if (/[\u0000-\u001f\u007f]/.test(value)) errors.push(`${label} contains unsupported characters.`);
    return value;
  };
  const row = {
    order_ref: text("order_ref", 1, 80, "Order reference"),
    recipient_name: text("recipient_name", 1, 100, "Recipient name"),
    recipient_phone: text("recipient_phone", 8, 20, "Recipient phone"),
    address: text("address", 3, 500, "Address"),
    cargo_description: String(raw.cargo_description ?? "").trim() || "Parcel",
  };
  if (row.recipient_phone.length >= 8 && row.recipient_phone.length <= 20 && !/^\+?[0-9][0-9 -]{6,19}$/.test(row.recipient_phone)) errors.push("Recipient phone must contain digits only (spaces, dashes and a leading + are fine).");
  if (row.cargo_description.length > 500) errors.push("Description must be at most 500 characters.");
  const cod = number(raw.cod_amount ?? "") ?? 0;
  if (!Number.isFinite(cod) || cod < 0 || cod > 1000000 || !twoDecimals(cod)) errors.push("COD amount must be between 0 and 1,000,000 with at most two decimals.");
  row.cod_amount = cod;
  const weight = number(raw.cargo_weight_kg ?? "") ?? 1;
  if (!Number.isFinite(weight) || weight <= 0 || weight > 10000) errors.push("Weight must be more than 0 and at most 10,000 kg.");
  row.cargo_weight_kg = weight;
  const lat = number(raw.lat ?? ""),
    lng = number(raw.lng ?? "");
  if ((lat === undefined) !== (lng === undefined)) errors.push("Give both latitude and longitude, or neither.");
  else if (lat !== undefined && !(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) errors.push("Latitude or longitude is out of range.");
  row.lat = lat ?? null;
  row.lng = lng ?? null;
  row.is_fragile = /^(yes|y|true|1)$/i.test(String(raw.is_fragile ?? "").trim());
  return { row, errors };
}

function registerMerchantTools({ app, query, transaction, validate, authenticate, requireDatabase, requireRole, market }) {
  const customer = [authenticate, requireDatabase, requireRole("customer")];
  const uuid = z.string().uuid();

  async function requireProfile(userId) {
    const { rowCount } = await query("SELECT 1 FROM merchant_profiles WHERE user_id=$1", [userId]);
    if (!rowCount) throw unavailable("Create your business profile in the merchant desk first.", 409);
  }

  // Booking a return: the original must be this customer's delivered parcel, and no goods cash is collected.
  async function assertReturn(userId, body, run = query) {
    if (!body.return_of_delivery_id) return;
    const {
      rows: [original],
    } = await run("SELECT customer_id,status FROM deliveries WHERE id=$1", [body.return_of_delivery_id]);
    if (!original || original.customer_id !== userId) throw unavailable("The original delivery was not found.", 404);
    if (original.status !== "delivered") throw unavailable("Returns can be booked only for delivered parcels.", 409);
    if (Number(body.cod_amount) > 0) throw unavailable("A return pickup cannot collect a goods payment.", 400);
  }

  app.post(
    "/api/v1/merchant/imports",
    { preHandler: customer, bodyLimit: MAX_BYTES * 2, config: { rateLimit: { max: 20, timeWindow: 3600000 } } },
    async (req) => {
      const { csv } = validate(z.object({ csv: z.string().min(1).max(MAX_BYTES, "The file is larger than 200 KB. Split it into smaller files.") }), req.body);
      await requireProfile(req.user.id);
      const table = parseCsv(csv);
      if (table.length < 2) throw unavailable("Add a header row and at least one order.", 400);
      if (table.length - 1 > MAX_ROWS) throw unavailable(`Import at most ${MAX_ROWS} orders at a time.`, 400);
      const map = columnMap(table[0]);
      const seen = new Set();
      const results = [];
      const valid = [];
      table.slice(1).forEach((cells, index) => {
        const raw = Object.fromEntries(Object.entries(map).map(([key, i]) => [key, cells[i] ?? ""]));
        const { row, errors } = validateRow(raw);
        const key = row.order_ref.toLowerCase();
        if (row.order_ref && seen.has(key)) errors.push("This order reference appears more than once in the file.");
        seen.add(key);
        const result = { line: index + 2, order_ref: row.order_ref, status: errors.length ? "error" : "imported", errors };
        results.push(result);
        if (!errors.length) valid.push({ row, result });
      });
      await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
        const refs = valid.map((v) => v.row.order_ref);
        const { rows: booked } = await client.query(
          "SELECT merchant_order_ref FROM deliveries WHERE customer_id=$1 AND merchant_order_ref = ANY($2::text[])",
          [req.user.id, refs],
        );
        const bookedRefs = new Set(booked.map((b) => b.merchant_order_ref));
        for (const { row, result } of valid) {
          if (bookedRefs.has(row.order_ref)) {
            result.status = "duplicate";
            result.errors = ["A delivery already uses this order reference."];
            continue;
          }
          // A discarded draft with the same reference is replaced; a live one is left alone.
          const { rowCount } = await client.query(
            `INSERT INTO merchant_order_drafts(user_id,order_ref,recipient_name,recipient_phone,address,lat,lng,cod_amount,cargo_description,cargo_weight_kg,is_fragile)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT(user_id,order_ref) DO UPDATE SET recipient_name=EXCLUDED.recipient_name,recipient_phone=EXCLUDED.recipient_phone,
               address=EXCLUDED.address,lat=EXCLUDED.lat,lng=EXCLUDED.lng,cod_amount=EXCLUDED.cod_amount,cargo_description=EXCLUDED.cargo_description,
               cargo_weight_kg=EXCLUDED.cargo_weight_kg,is_fragile=EXCLUDED.is_fragile,discarded_at=NULL,created_at=NOW()
             WHERE merchant_order_drafts.discarded_at IS NOT NULL`,
            [req.user.id, row.order_ref, row.recipient_name, row.recipient_phone, row.address, row.lat, row.lng, row.cod_amount, row.cargo_description, row.cargo_weight_kg, row.is_fragile],
          );
          if (!rowCount) {
            result.status = "duplicate";
            result.errors = ["This order is already waiting to be booked."];
          }
        }
      });
      const count = (status) => results.filter((r) => r.status === status).length;
      return {
        imported: count("imported"),
        duplicates: count("duplicate"),
        errors: count("error"),
        rows: results,
        message: "Imported orders are drafts. Book each one to confirm the address on the map and check its fare.",
      };
    },
  );

  const draftColumns = `o.id,o.order_ref,o.recipient_name,o.recipient_phone,o.address,o.lat,o.lng,o.cod_amount,o.cargo_description,
    o.cargo_weight_kg,o.is_fragile,o.created_at,d.id AS delivery_id,d.delivery_number,d.status AS delivery_status`;
  const draftJoin = "LEFT JOIN deliveries d ON d.customer_id=o.user_id AND d.merchant_order_ref=o.order_ref";

  app.get("/api/v1/merchant/drafts", { preHandler: customer }, async (req) => {
    const { show } = validate(z.object({ show: z.enum(["open", "all"]).default("open") }), req.query);
    const { rows } = await query(
      `SELECT ${draftColumns} FROM merchant_order_drafts o ${draftJoin}
       WHERE o.user_id=$1 AND o.discarded_at IS NULL ${show === "open" ? "AND d.id IS NULL" : ""}
       ORDER BY o.created_at,o.order_ref LIMIT 500`,
      [req.user.id],
    );
    return { drafts: rows, currency: market.currency };
  });

  app.get("/api/v1/merchant/drafts/:id", { preHandler: customer }, async (req) => {
    const id = validate(uuid, req.params.id);
    const {
      rows: [draft],
    } = await query(`SELECT ${draftColumns} FROM merchant_order_drafts o ${draftJoin} WHERE o.id=$1 AND o.user_id=$2 AND o.discarded_at IS NULL`, [id, req.user.id]);
    if (!draft) throw unavailable("This imported order was not found.", 404);
    return { draft };
  });

  app.post("/api/v1/merchant/drafts/:id/discard", { preHandler: customer }, async (req) => {
    const id = validate(uuid, req.params.id);
    const { rowCount } = await query("UPDATE merchant_order_drafts SET discarded_at=NOW() WHERE id=$1 AND user_id=$2 AND discarded_at IS NULL", [id, req.user.id]);
    if (!rowCount) throw unavailable("This imported order was not found.", 404);
    return { discarded: true };
  });

  app.get("/api/v1/merchant/statement", { preHandler: customer }, async (req) => {
    const { month } = validate(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month as YYYY-MM.") }), req.query);
    const [year, m] = month.split("-").map(Number);
    const start = `${month}-01`;
    const end = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, "0")}-01`;
    const { rows } = await query(
      `SELECT d.delivery_number,d.merchant_order_ref,d.status,d.requested_at,d.delivered_at,d.dropoff_address,d.dropoff_contact_name,
         d.total_fare,d.currency,d.cod_amount,d.cod_collected_at,d.cod_received_at,d.cod_settled_at,d.return_of_delivery_id,
         (SELECT reference FROM cod_events e WHERE e.delivery_id=d.id AND e.kind='settled') AS settlement_reference
       FROM deliveries d
       WHERE d.customer_id=$1 AND d.requested_at >= ($2::date::timestamp AT TIME ZONE $4) AND d.requested_at < ($3::date::timestamp AT TIME ZONE $4)
       ORDER BY d.requested_at,d.id LIMIT 5000`,
      [req.user.id, start, end, market.timezone],
    );
    const totals = {};
    for (const d of rows) {
      const t = (totals[d.currency] ||= {
        currency: d.currency,
        deliveries: 0,
        delivered: 0,
        cancelled: 0,
        returns: 0,
        delivery_fees: 0,
        cod_collected: 0,
        cod_settled: 0,
        cod_outstanding: 0,
      });
      const cents = (v) => Math.round(Number(v || 0) * 100);
      t.deliveries++;
      if (d.status === "delivered") {
        t.delivered++;
        t.delivery_fees += cents(d.total_fare);
      }
      if (d.status === "cancelled") t.cancelled++;
      if (d.return_of_delivery_id) t.returns++;
      if (d.cod_collected_at) t.cod_collected += cents(d.cod_amount);
      if (d.cod_settled_at) t.cod_settled += cents(d.cod_amount);
      else if (d.cod_collected_at) t.cod_outstanding += cents(d.cod_amount);
    }
    for (const t of Object.values(totals))
      for (const key of ["delivery_fees", "cod_collected", "cod_settled", "cod_outstanding"]) t[key] = t[key] / 100;
    return { month, timezone: market.timezone, totals: Object.values(totals), deliveries: rows, truncated: rows.length === 5000 };
  });

  return { assertReturn };
}

module.exports = { registerMerchantTools, parseCsv, validateRow, columnMap };
