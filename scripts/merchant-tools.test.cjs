"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, validateRow, columnMap } = require("../services/merchant-tools.cjs");

test("CSV parsing handles quotes, embedded commas and line breaks, BOM and CRLF", () => {
  const rows = parseCsv('﻿order_ref,name,address\r\nA-1,"Khan, Ali","House 4,\nStreet 9"\r\n\r\nA-2,Sara,"Say ""hi"""\n');
  assert.deepEqual(rows, [
    ["order_ref", "name", "address"],
    ["A-1", "Khan, Ali", "House 4,\nStreet 9"],
    ["A-2", "Sara", 'Say "hi"'],
  ]);
  assert.throws(() => parseCsv('a,"b\n'), /unclosed/);
  assert.deepEqual(columnMap(["Order No", "Customer Name", "Mobile", "Delivery Address", "COD"]), {
    order_ref: 0,
    recipient_name: 1,
    recipient_phone: 2,
    address: 3,
    cod_amount: 4,
  });
  assert.throws(() => columnMap(["order", "name"]), /Missing: recipient_phone, address/);
});

test("import rows are validated field by field", () => {
  const ok = validateRow({ order_ref: "A-1", recipient_name: "Ali", recipient_phone: "0300 1234567", address: "House 4, Chitral", cod_amount: "1,500.50", is_fragile: "yes" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.row.cod_amount, 1500.5);
  assert.equal(ok.row.cargo_weight_kg, 1);
  assert.equal(ok.row.cargo_description, "Parcel");
  assert.equal(ok.row.is_fragile, true);
  const bad = validateRow({ order_ref: "", recipient_name: "Ali", recipient_phone: "call me", address: "x", cod_amount: "1.234", lat: "35.8" });
  assert.equal(bad.errors.length, 5, JSON.stringify(bad.errors));
});

test(
  "merchant desk phase 2: imports, drafts, statements and return pickups",
  { skip: process.env.NEXORA_TEST_DATABASE !== "isolated", timeout: 120000 },
  async (t) => {
    const { Pool } = require("pg"),
      Redis = require("ioredis"),
      { randomUUID, randomInt } = require("node:crypto"),
      fs = require("fs");
    const { createBackend } = require("../backend_api.js");
    const db = new Pool({
      host: "127.0.0.1",
      port: Number(process.env.TEST_DB_PORT || 55439),
      user: "nexus",
      database: "nexusdb",
      password: process.env.TEST_DB_PASSWORD || "nexora_isolated_test",
    });
    const redis = new Redis({
      host: "127.0.0.1",
      port: Number(process.env.TEST_REDIS_PORT || 56389),
      password: process.env.TEST_REDIS_PASSWORD || "nexora_isolated_test",
    });
    for (const file of [
      "20261019085513_booking_payments_notifications.sql",
      "20261024093153_release_recovery_cash_billing.sql",
      "20261024093804_durable_delivery_requests.sql",
      "20261105154028_area_availability_merchant_cod.sql",
      "20261105190000_phone_sign_in.sql",
      "20261105200000_driver_cash_wallet.sql",
      "20261105210000_merchant_imports_returns.sql",
    ])
      await db.query(fs.readFileSync("supabase/migrations/" + file, "utf8"));
    const backend = createBackend({
      edge: true,
      db,
      redis,
      rateLimit: async () => {},
      io: { on() {}, to() { return { emit() {} }; } },
      env: { NODE_ENV: "development", LOG_LEVEL: "silent", JWT_SECRET: "merchant-tools-secret-at-least-32-characters", CURRENCY: "PKR", SERVICE_COUNTRY: "PK" },
    });
    await backend.initialize();
    t.after(async () => {
      await backend.app.close();
      await redis.quit();
      await db.end();
    });
    const call = async (method, path, body, token) => {
      const r = await backend.app.inject({ method, url: "/api/v1" + path, payload: body, headers: token ? { authorization: "Bearer " + token } : {} });
      return { status: r.statusCode, body: r.json() };
    };
    const suffix = randomUUID().slice(0, 8);
    const register = async (tag) => {
      const r = await call("POST", "/auth/register", {
        email: `tools-${tag}-${suffix}@nexora.test`,
        phone: "+1555" + String(randomInt(1e9)).padStart(9, "0"),
        first_name: "Tools",
        last_name: tag,
        password: "Tools-test-password-123",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.token;
    };
    const owner = await register("owner"),
      other = await register("other");
    // Far from every other test's drivers, so nothing is dispatched.
    const base = { lat: -40 - randomInt(1000) / 100, lng: -100 - randomInt(1000) / 100 };
    const ref = (n) => `ORD-${suffix}-${n}`;
    const csv = [
      "Order No,Customer Name,Mobile,Delivery Address,COD,Weight,Latitude,Longitude,Fragile",
      `${ref(1)},"Khan, Ali",0300 1234567,"House 4, Street 9",1500,2,${base.lat + 0.01},${base.lng + 0.01},yes`,
      `${ref(2)},Sara,0301 7654321,Main Bazaar near the mosque,"1,250.50",,,,`,
      `${ref(3)},Bilal,not a phone,Somewhere,0,1,,,`,
      `${ref(2)},Sara again,0301 7654321,Main Bazaar,0,1,,,`,
      `${ref(4)},Hina,0302 1111111,"Shop 12, Saddar",0,1,,,`,
    ].join("\n");

    await t.test("imports need a business profile and report every row", async () => {
      assert.equal((await call("POST", "/merchant/imports", { csv }, owner)).status, 409);
      const profile = await call(
        "POST",
        "/merchant/profile",
        {
          business_name: "Tools shop",
          pickup: { pickup_address: "Tools shop", pickup_lat: base.lat, pickup_lng: base.lng, pickup_contact_name: "Shop", pickup_contact_phone: "+15550001111" },
        },
        owner,
      );
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      const r = await call("POST", "/merchant/imports", { csv }, owner);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.imported, 3);
      assert.equal(r.body.errors, 2);
      assert.deepEqual(r.body.rows.map((row) => row.status), ["imported", "imported", "error", "error", "imported"]);
      assert.equal(r.body.rows[2].line, 4);
      assert.match(r.body.rows[3].errors.join(" "), /more than once/);
      const again = await call("POST", "/merchant/imports", { csv }, owner);
      assert.equal(again.body.imported, 0);
      assert.equal(again.body.duplicates, 3);
      assert.equal((await call("POST", "/merchant/imports", { csv: "just,a,header\n" }, owner)).status, 400);
      assert.equal((await call("POST", "/merchant/imports", { csv: "a\n" + "x\n".repeat(201) }, owner)).status, 400);
    });

    let drafts;
    await t.test("drafts belong to their merchant and disappear once booked", async () => {
      drafts = (await call("GET", "/merchant/drafts", undefined, owner)).body.drafts;
      assert.equal(drafts.length, 3);
      const first = drafts.find((d) => d.order_ref === ref(1));
      assert.equal(Number(first.cod_amount), 1500);
      assert.equal(first.is_fragile, true);
      assert.equal(Number(drafts.find((d) => d.order_ref === ref(2)).cod_amount), 1250.5);
      assert.equal((await call("GET", "/merchant/drafts", undefined, other)).body.drafts.length, 0);
      assert.equal((await call("GET", "/merchant/drafts/" + first.id, undefined, other)).status, 404);
      const booked = await call(
        "POST",
        "/deliveries",
        {
          merchant_order_ref: first.order_ref,
          cod_amount: Number(first.cod_amount),
          pickup_lat: base.lat,
          pickup_lng: base.lng,
          pickup_address: "Tools shop",
          pickup_contact_name: "Shop",
          pickup_contact_phone: "+15550001111",
          dropoff_lat: first.lat,
          dropoff_lng: first.lng,
          dropoff_address: first.address,
          dropoff_contact_name: first.recipient_name,
          dropoff_contact_phone: first.recipient_phone,
          cargo_description: first.cargo_description,
          cargo_weight_kg: Number(first.cargo_weight_kg),
        },
        owner,
      );
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      const open = (await call("GET", "/merchant/drafts", undefined, owner)).body.drafts;
      assert.equal(open.length, 2);
      const all = (await call("GET", "/merchant/drafts?show=all", undefined, owner)).body.drafts;
      assert.equal(all.find((d) => d.order_ref === ref(1)).delivery_number, booked.body.delivery.delivery_number);
      const hina = open.find((d) => d.order_ref === ref(4));
      assert.equal((await call("POST", `/merchant/drafts/${hina.id}/discard`, {}, other)).status, 404);
      assert.equal((await call("POST", `/merchant/drafts/${hina.id}/discard`, {}, owner)).status, 200);
      assert.equal((await call("GET", "/merchant/drafts", undefined, owner)).body.drafts.length, 1);
      const revived = await call("POST", "/merchant/imports", { csv }, owner);
      assert.equal(revived.body.imported, 1, "a discarded order can be imported again");
    });

    await t.test("return pickups follow delivered parcels only", async () => {
      const { rows } = await db.query("SELECT d.id FROM deliveries d JOIN users u ON u.id=d.customer_id WHERE d.merchant_order_ref=$1", [ref(1)]);
      const original = rows[0].id;
      const returnBody = {
        return_of_delivery_id: original,
        pickup_lat: base.lat + 0.01,
        pickup_lng: base.lng + 0.01,
        pickup_address: "House 4, Street 9",
        pickup_contact_name: "Khan, Ali",
        pickup_contact_phone: "03001234567",
        dropoff_lat: base.lat,
        dropoff_lng: base.lng,
        dropoff_address: "Tools shop",
        dropoff_contact_name: "Shop",
        dropoff_contact_phone: "+15550001111",
        cargo_description: "Return: parcel",
        cargo_weight_kg: 2,
      };
      assert.equal((await call("POST", "/deliveries/estimate", returnBody, owner)).status, 409, "not delivered yet");
      await db.query("UPDATE deliveries SET status='delivered',delivered_at=NOW() WHERE id=$1", [original]);
      assert.equal((await call("POST", "/deliveries/estimate", { ...returnBody, cod_amount: 10 }, owner)).status, 400);
      assert.equal((await call("POST", "/deliveries/estimate", returnBody, other)).status, 404);
      const quote = await call("POST", "/deliveries/estimate", returnBody, owner);
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      const created = await call("POST", "/deliveries", { ...returnBody, quote_token: quote.body.quote_token }, owner);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal((await call("POST", "/deliveries", returnBody, owner)).status, 409, "one live return per delivery");
      const desk = (await call("GET", "/merchant/desk", undefined, owner)).body.deliveries;
      assert.equal(desk.find((d) => d.id === original).return_booked, true);
      assert.equal(desk.find((d) => d.id === created.body.delivery.id).return_of_delivery_id, original);
      assert.equal((await call("POST", `/deliveries/${created.body.delivery.id}/cancel`, {}, owner)).status, 200);
      assert.equal((await call("POST", "/deliveries", returnBody, owner)).status, 201, "a cancelled return can be booked again");
    });

    await t.test("monthly statement totals fees and goods payments", async () => {
      assert.equal((await call("GET", "/merchant/statement?month=2026-13", undefined, owner)).status, 400);
      const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
      const r = await call("GET", "/merchant/statement?month=" + month, undefined, owner);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.timezone, "Asia/Karachi");
      const totals = r.body.totals.find((x) => x.currency === "PKR");
      assert.equal(totals.deliveries, 3, "original and two returns, one of them cancelled");
      assert.equal(totals.delivered, 1);
      assert.equal(totals.cancelled, 1);
      assert.equal(totals.returns, 2);
      assert.equal(totals.delivery_fees, Number(r.body.deliveries.find((d) => d.merchant_order_ref === ref(1)).total_fare));
      assert.equal((await call("GET", "/merchant/statement?month=" + month, undefined, other)).body.deliveries.length, 0);
      const earlier = await call("GET", "/merchant/statement?month=2020-01", undefined, owner);
      assert.equal(earlier.body.deliveries.length, 0);
    });
  },
);
