"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { areaStatus, contains } = require("../services/areas.cjs");
const { moneySchema } = require("../services/merchants.cjs");
test("coverage respects boundary, launch state, market readiness and Karachi opening hours", () => {
  const area = {
    center_lat: 35.85,
    center_lng: 71.78,
    radius_km: 10,
    status: "active",
    weekdays: [4],
    opens_minute: 9 * 60,
    closes_minute: 17 * 60,
  };
  assert.equal(contains(area, 35.86, 71.79), true);
  assert.equal(contains(area, 34, 71), false);
  assert.equal(
    areaStatus(area, true, "Asia/Karachi", new Date("2026-11-05T04:00:00Z")),
    "open",
  );
  assert.equal(
    areaStatus(area, true, "Asia/Karachi", new Date("2026-11-05T12:00:00Z")),
    "closed",
  );
  assert.equal(
    areaStatus(area, true, "Asia/Karachi", new Date("2026-11-06T04:00:00Z")),
    "closed",
  );
  assert.equal(areaStatus(area, false, "Asia/Karachi"), "setup_pending");
  assert.equal(
    areaStatus({ ...area, status: "planned" }, true, "Asia/Karachi"),
    "not_launched",
  );
  assert.equal(
    areaStatus({ ...area, status: "paused" }, true, "Asia/Karachi"),
    "paused",
  );
  for (const value of [-1, 0.001, 1000001, Infinity])
    assert.equal(moneySchema.safeParse(value).success, false);
  for (const value of [0, 0.01, 1500.55])
    assert.equal(moneySchema.safeParse(value).success, true);
});

test(
  "business: area enforcement, tenant isolation and complete COD reconciliation",
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
    // Completing a cash delivery also writes the driver wallet ledger.
    for (const file of [
      "20261105154028_area_availability_merchant_cod.sql",
      "20261105200000_driver_cash_wallet.sql",
      "20261105210000_merchant_imports_returns.sql",
    ])
      await db.query(fs.readFileSync("supabase/migrations/" + file, "utf8"));
    const backend = createBackend({
      edge: true,
      db,
      redis,
      rateLimit: async () => {},
      io: {
        on() {},
        to() {
          return { emit() {} };
        },
      },
      env: {
        NODE_ENV: "development",
        LOG_LEVEL: "silent",
        JWT_SECRET: "business-tests-secret-at-least-32-characters",
        SERVICE_AREAS_REQUIRED: "true",
        CURRENCY: "PKR",
        SERVICE_COUNTRY: "PK",
      },
    });
    await backend.initialize();
    let area, driver;
    t.after(async () => {
      if (area)
        await db.query("DELETE FROM service_areas WHERE id=$1", [area.id]);
      if (driver)
        await db.query(
          "UPDATE drivers SET is_online=false,status='offline' WHERE id=$1",
          [driver.driver.id],
        );
      await backend.app.close();
      await redis.quit();
      await db.end();
    });
    const call = async (method, path, body, token, headers = {}) => {
      const r = await backend.app.inject({
        method,
        url: "/api/v1" + path,
        payload: body,
        headers: {
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...headers,
        },
      });
      return { status: r.statusCode, body: r.json() };
    };
    const suffix = randomUUID(),
      password = "Business-test-password-123";
    const credentials = (tag) => ({
      email: `${tag}-${suffix}@nexora.test`,
      phone: "+1555" + String(randomInt(1e9)).padStart(9, "0"),
      first_name: "Business",
      last_name: tag,
      password,
    });
    async function register(tag) {
      const c = credentials(tag),
        r = await call("POST", "/auth/register", c);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { ...r.body, credentials: c };
    }
    const owner = await register("merchant"),
      other = await register("other"),
      admin = await register("admin");
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [
      admin.user.id,
    ]);
    const staff = (await call("POST", "/auth/login", admin.credentials)).body
      .token;
    const areaBody = {
      name: "Isolated test " + suffix,
      center_lat: 12.34,
      center_lng: 56.78,
      radius_km: 5,
      status: "planned",
      services: ["ride", "delivery"],
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      opens_minute: 0,
      closes_minute: 1440,
    };
    await t.test(
      "public availability and operator-only coverage changes",
      async () => {
        assert.equal(
          (await call("POST", "/admin/areas", areaBody, owner.token)).status,
          403,
        );
        const r = await call("POST", "/admin/areas", areaBody, staff);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        area = r.body.area;
        let result = await call(
          "GET",
          `/availability?area_id=${area.id}&service=delivery`,
        );
        assert.equal(result.body.status, "not_launched");
        const changed = await call(
          "POST",
          "/admin/areas/" + area.id,
          { ...areaBody, status: "active" },
          staff,
        );
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        result = await call(
          "GET",
          `/availability?area_id=${area.id}&service=delivery`,
        );
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.status, "no_drivers");
        assert.equal(
          (
            await call("POST", "/area-waitlist", {
              locality: "Test place",
              email: owner.credentials.email,
              service: "delivery",
              consent: false,
            })
          ).status,
          400,
        );
        for (let i = 0; i < 2; i++)
          assert.equal(
            (
              await call("POST", "/area-waitlist", {
                locality: "Test place",
                email: owner.credentials.email,
                service: "delivery",
                consent: true,
              })
            ).status,
            200,
          );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM area_waitlist WHERE email=$1",
              [owner.credentials.email],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    const body = {
      pickup_lat: 12.34,
      pickup_lng: 56.78,
      pickup_address: "Test shop",
      dropoff_lat: 12.35,
      dropoff_lng: 56.79,
      dropoff_address: "Test recipient",
      pickup_contact_name: "Merchant",
      pickup_contact_phone: "+15551234567",
      dropoff_contact_name: "Recipient",
      dropoff_contact_phone: "+15557654321",
      cargo_description: "Test goods",
      cargo_weight_kg: 1,
      merchant_order_ref: "ORDER-" + suffix,
      cod_amount: 1500.55,
    };
    let quote, delivery;
    await t.test(
      "merchant setup, exact money validation and outside-area rejection",
      async () => {
        assert.equal(
          (await call("POST", "/deliveries/estimate", body, owner.token))
            .status,
          409,
        );
        let r = await call(
          "POST",
          "/merchant/profile",
          {
            business_name: "Test merchant",
            pickup: {
              pickup_address: body.pickup_address,
              pickup_lat: body.pickup_lat,
              pickup_lng: body.pickup_lng,
              pickup_contact_name: body.pickup_contact_name,
              pickup_contact_phone: body.pickup_contact_phone,
            },
          },
          owner.token,
        );
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(
          (await call("GET", "/merchant/profile", undefined, other.token)).body
            .profile,
          null,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/deliveries/estimate",
              { ...body, cod_amount: 1.001 },
              owner.token,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/deliveries/estimate",
              { ...body, dropoff_lat: -60 },
              owner.token,
            )
          ).status,
          409,
        );
        assert.equal(
          (await call("POST", "/trips/estimate", { ...body, dropoff_lat: -60 }))
            .status,
          409,
        );
        r = await call("POST", "/deliveries/estimate", body, owner.token);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        quote = r.body;
        assert.equal(
          (
            await call(
              "POST",
              "/deliveries",
              { ...body, cod_amount: 2000, quote_token: quote.quote_token },
              owner.token,
            )
          ).status,
          400,
        );
        await call(
          "POST",
          "/admin/areas/" + area.id,
          { ...areaBody, status: "paused" },
          staff,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/deliveries",
              { ...body, quote_token: quote.quote_token },
              owner.token,
            )
          ).status,
          409,
        );
        await call(
          "POST",
          "/admin/areas/" + area.id,
          { ...areaBody, status: "active" },
          staff,
        );
      },
    );
    await t.test(
      "fresh driver supply, booking retry and duplicate merchant order protection",
      async () => {
        const r = await call("POST", "/drivers/register", {
          ...credentials("driver"),
          mode: "both",
          vehicle: {
            plate_number: suffix.slice(0, 15),
            make: "Test",
            model: "Car",
            year: 2025,
            color: "White",
            vehicle_type: "sedan",
          },
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        driver = r.body;
        await db.query(
          "UPDATE drivers SET onboarding_completed=true,is_online=true,status='available',current_location=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,location_updated_at=NOW()-INTERVAL '3 minutes' WHERE id=$1",
          [driver.driver.id, body.pickup_lng, body.pickup_lat],
        );
        assert.equal(
          (
            await call(
              "GET",
              `/availability?area_id=${area.id}&service=delivery`,
            )
          ).body.status,
          "no_drivers",
        );
        await db.query(
          "UPDATE drivers SET location_updated_at=NOW() WHERE id=$1",
          [driver.driver.id],
        );
        assert.equal(
          (
            await call(
              "GET",
              `/availability?area_id=${area.id}&service=delivery`,
            )
          ).body.status,
          "available",
        );
        const headers = { "idempotency-key": randomUUID() },
          payload = { ...body, quote_token: quote.quote_token };
        const first = await call(
          "POST",
          "/deliveries",
          payload,
          owner.token,
          headers,
        );
        assert.equal(first.status, 201, JSON.stringify(first.body));
        delivery = first.body.delivery;
        const replay = await call(
          "POST",
          "/deliveries",
          payload,
          owner.token,
          headers,
        );
        assert.equal(replay.status, 201, JSON.stringify(replay.body));
        assert.equal(replay.body.delivery.id, delivery.id);
        assert.equal(
          (
            await call("POST", "/deliveries", payload, owner.token, {
              "idempotency-key": randomUUID(),
            })
          ).status,
          409,
        );
        const jobs = await call(
          "GET",
          "/driver/jobs/current",
          undefined,
          driver.token,
        );
        assert.equal(
          Number(
            jobs.body.deliveries.find((d) => d.id === delivery.id).cod_amount,
          ),
          1500.55,
        );
        const desk = await call(
          "GET",
          "/merchant/desk",
          undefined,
          owner.token,
        );
        assert.equal(Number(desk.body.balances[0].expected), 1500.55);
        assert.equal(
          (await call("GET", "/merchant/desk", undefined, other.token)).body
            .deliveries.length,
          0,
        );
        assert.equal(
          (
            await call(
              "GET",
              `/merchant/deliveries/${delivery.id}/events`,
              undefined,
              other.token,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "collection is atomic, excludes delivery fees and requires exact goods amount",
      async () => {
        assert.equal(
          (
            await call(
              "POST",
              `/driver/deliveries/${delivery.id}/accept`,
              {},
              driver.token,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              "POST",
              `/driver/deliveries/${delivery.id}/pickup`,
              { otp: delivery.pickup_otp },
              driver.token,
            )
          ).status,
          200,
        );
        const pod = {
          otp: delivery.dropoff_otp,
          recipient_name: "Recipient",
          pod_signature: "data:image/png;base64,AAAA",
          cash_collected: true,
        };
        assert.equal(
          (
            await call(
              "POST",
              `/driver/deliveries/${delivery.id}/deliver`,
              pod,
              driver.token,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await call(
              "POST",
              `/driver/deliveries/${delivery.id}/deliver`,
              { ...pod, cod_collected_amount: 1 },
              driver.token,
            )
          ).status,
          400,
        );
        const results = await Promise.all(
          [1, 2].map(() =>
            call(
              "POST",
              `/driver/deliveries/${delivery.id}/deliver`,
              { ...pod, cod_collected_amount: 1500.55 },
              driver.token,
            ),
          ),
        );
        assert.ok(
          results.some((r) => r.status === 200),
          JSON.stringify(results),
        );
        const events = (
          await db.query("SELECT * FROM cod_events WHERE delivery_id=$1", [
            delivery.id,
          ])
        ).rows;
        assert.equal(events.length, 1);
        assert.equal(Number(events[0].amount), 1500.55);
        const payment = (
          await db.query("SELECT amount FROM payments WHERE delivery_id=$1", [
            delivery.id,
          ])
        ).rows;
        assert.equal(payment.length, 1);
        assert.equal(Number(payment[0].amount), Number(delivery.total_fare));
        assert.equal(
          Number(
            (await call("GET", "/merchant/desk", undefined, owner.token)).body
              .balances[0].with_drivers,
          ),
          1500.55,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/account/delete",
              { password, confirm: "DELETE" },
              owner.token,
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      "settlement requires staff, cash receipt, matching amounts and retry-safe references",
      async () => {
        const action = {
          reference: "TEST-RECEIPT",
          amount: 1500.55,
          confirm: true,
        };
        assert.equal(
          (
            await call(
              "POST",
              `/admin/cod/${delivery.id}/received`,
              action,
              owner.token,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "POST",
              `/admin/cod/${delivery.id}/settled`,
              action,
              staff,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call(
              "POST",
              `/admin/cod/${delivery.id}/received`,
              { ...action, amount: 100 },
              staff,
            )
          ).status,
          400,
        );
        const receipts = await Promise.all(
          [1, 2].map(() =>
            call("POST", `/admin/cod/${delivery.id}/received`, action, staff),
          ),
        );
        assert.ok(
          receipts.every((r) => r.status === 200),
          JSON.stringify(receipts),
        );
        assert.equal(
          (
            await call(
              "POST",
              `/admin/cod/${delivery.id}/received`,
              { ...action, reference: "DIFFERENT" },
              staff,
            )
          ).status,
          409,
        );
        assert.equal(
          Number(
            (await call("GET", "/merchant/desk", undefined, owner.token)).body
              .balances[0].awaiting_settlement,
          ),
          1500.55,
        );
        const payouts = await Promise.all(
          [1, 2].map(() =>
            call(
              "POST",
              `/admin/cod/${delivery.id}/settled`,
              { ...action, reference: "TEST-PAID" },
              staff,
            ),
          ),
        );
        assert.ok(
          payouts.every((r) => r.status === 200),
          JSON.stringify(payouts),
        );
        const desk = (
          await call(
            "GET",
            "/merchant/desk?status=settled",
            undefined,
            owner.token,
          )
        ).body;
        assert.equal(Number(desk.balances[0].settled), 1500.55);
        assert.equal(desk.deliveries.length, 1);
        assert.equal(
          (
            await call(
              "GET",
              `/merchant/deliveries/${delivery.id}/events`,
              undefined,
              owner.token,
            )
          ).body.events.length,
          3,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/account/delete",
              { password, confirm: "DELETE" },
              owner.token,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await db.query("SELECT * FROM merchant_profiles WHERE user_id=$1", [
              owner.user.id,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await db.query("SELECT * FROM area_waitlist WHERE email=$1", [
              owner.credentials.email,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await db.query("SELECT * FROM cod_events WHERE delivery_id=$1", [
              delivery.id,
            ])
          ).rowCount,
          3,
        );
      },
    );
  },
);
