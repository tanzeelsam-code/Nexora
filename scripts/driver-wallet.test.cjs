"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseWalletConfig } = require("../services/driver-wallet.cjs");

test("wallet configuration is validated at startup", () => {
  assert.deepEqual(parseWalletConfig({}), { limit: null, accounts: [] });
  assert.equal(parseWalletConfig({ DRIVER_CASH_LIMIT: "2500" }).limit, 2500);
  assert.throws(() => parseWalletConfig({ DRIVER_CASH_LIMIT: "-1" }), /DRIVER_CASH_LIMIT/);
  assert.throws(() => parseWalletConfig({ DRIVER_CASH_LIMIT: "lots" }), /DRIVER_CASH_LIMIT/);
  assert.throws(() => parseWalletConfig({ DRIVER_REMITTANCE_ACCOUNTS_JSON: "{" }), /valid JSON/);
  assert.throws(() => parseWalletConfig({ DRIVER_REMITTANCE_ACCOUNTS_JSON: '[{"method":"paypal","title":"X","account":"1234"}]' }), /method/);
  assert.equal(
    parseWalletConfig({ DRIVER_REMITTANCE_ACCOUNTS_JSON: '[{"method":"easypaisa","title":"Nexora Logistics","account":"03451234567"}]' }).accounts[0].method,
    "easypaisa",
  );
});

test(
  "driver cash wallet: commission, limit, payment claims and operator review",
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
      env: {
        NODE_ENV: "development",
        LOG_LEVEL: "silent",
        JWT_SECRET: "wallet-tests-secret-at-least-32-characters",
        CURRENCY: "PKR",
        SERVICE_COUNTRY: "PK",
        DRIVER_CASH_LIMIT: "0",
        DRIVER_REMITTANCE_ACCOUNTS_JSON: '[{"method":"easypaisa","title":"Nexora Logistics","account":"03451234567"}]',
      },
    });
    await backend.initialize();
    const suffix = randomUUID(),
      password = "Wallet-test-password-123";
    // Unique coordinates keep other test runs' drivers out of this dispatch.
    const base = { lat: 20 + randomInt(1000) / 100, lng: 60 + randomInt(1000) / 100 };
    let driver;
    t.after(async () => {
      if (driver) await db.query("UPDATE drivers SET is_online=false,status='offline' WHERE id=$1", [driver.driver.id]);
      await backend.app.close();
      await redis.quit();
      await db.end();
    });
    const call = async (method, path, body, token) => {
      const r = await backend.app.inject({
        method,
        url: "/api/v1" + path,
        payload: body,
        headers: token ? { authorization: "Bearer " + token } : {},
      });
      return { status: r.statusCode, body: r.json() };
    };
    const account = (tag) => ({
      email: `wallet-${tag}-${suffix}@nexora.test`,
      phone: "+1555" + String(randomInt(1e9)).padStart(9, "0"),
      first_name: "Wallet",
      last_name: tag,
      password,
    });
    const register = async (tag) => {
      const r = await call("POST", "/auth/register", account(tag));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body;
    };
    const customer = await register("customer"),
      adminUser = await register("admin"),
      opsUser = await register("ops");
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [adminUser.user.id]);
    await db.query("UPDATE users SET role='ops' WHERE id=$1", [opsUser.user.id]);
    const admin = adminUser.token,
      ops = opsUser.token;
    const registered = await call("POST", "/drivers/register", {
      ...account("driver"),
      mode: "both",
      vehicle: { plate_number: "W" + suffix.slice(0, 10), make: "Test", model: "Car", year: 2025, color: "White", vehicle_type: "sedan" },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    driver = registered.body;
    const placeDriver = () =>
      db.query(
        "UPDATE drivers SET onboarding_completed=true,is_online=true,status='available',current_location=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,location_updated_at=NOW() WHERE id=$1",
        [driver.driver.id, base.lng, base.lat],
      );
    const deliveryBody = () => ({
      pickup_lat: base.lat,
      pickup_lng: base.lng,
      pickup_address: "Wallet shop",
      dropoff_lat: base.lat + 0.01,
      dropoff_lng: base.lng + 0.01,
      dropoff_address: "Wallet recipient",
      pickup_contact_name: "Sender",
      pickup_contact_phone: "+15551230000",
      dropoff_contact_name: "Recipient",
      dropoff_contact_phone: "+15551239999",
      cargo_description: "Parcel",
      cargo_weight_kg: 2,
    });
    const wallet = async () => (await call("GET", "/driver/wallet", undefined, driver.token)).body;

    await t.test("a cash ride adds its commission, cleared by office cash", async () => {
      await placeDriver();
      const created = await call(
        "POST",
        "/trips",
        { pickup_lat: base.lat, pickup_lng: base.lng, pickup_address: "Wallet pickup", dropoff_lat: base.lat + 0.02, dropoff_lng: base.lng + 0.02, dropoff_address: "Wallet dropoff", payment_method: "cash" },
        customer.token,
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const trip = created.body.trip;
      let offered = false;
      for (let i = 0; i < 20 && !offered; i++) {
        offered = (await db.query("SELECT driver_id FROM trips WHERE id=$1", [trip.id])).rows[0].driver_id === driver.driver.id;
        if (!offered) await backend.sweepDispatch();
      }
      assert.ok(offered, "the ride is offered to the test driver");
      for (const [action, body] of [["accept", {}], ["arrive", {}], ["start", { otp: trip.pickup_otp }]])
        assert.equal((await call("POST", `/driver/trips/${trip.id}/${action}`, body, driver.token)).status, 200, action);
      assert.equal((await call("POST", `/driver/trips/${trip.id}/complete`, {}, driver.token)).status, 400, "cash must be confirmed");
      assert.equal((await call("POST", `/driver/trips/${trip.id}/complete`, { cash_collected: true }, driver.token)).status, 200);
      const {
        rows: [done],
      } = await db.query("SELECT platform_fee FROM trips WHERE id=$1", [trip.id]);
      const ledger = await db.query("SELECT amount FROM driver_cash_ledger WHERE trip_id=$1 AND kind='commission'", [trip.id]);
      assert.equal(ledger.rowCount, 1);
      assert.equal(Number(ledger.rows[0].amount), Number(done.platform_fee));
      assert.equal((await wallet()).balance, Number(done.platform_fee));
      const office = await call(
        "POST",
        `/admin/driver-wallets/${driver.driver.id}/remittances`,
        { method: "cash_office", reference: "RIDE-" + randomInt(1e6), amount: Number(done.platform_fee), confirm: true },
        ops,
      );
      assert.equal(office.status, 201, JSON.stringify(office.body));
      assert.equal((await wallet()).balance, 0);
    });

    let delivery;
    await t.test("a cash delivery adds its commission once", async () => {
      await placeDriver();
      const created = await call("POST", "/deliveries", deliveryBody(), customer.token);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      delivery = created.body.delivery;
      const { rows } = await db.query("SELECT driver_id FROM deliveries WHERE id=$1", [delivery.id]);
      assert.equal(rows[0].driver_id, driver.driver.id, "offered to the test driver");
      for (const [action, body] of [
        ["accept", {}],
        ["pickup", { otp: delivery.pickup_otp }],
      ])
        assert.equal((await call("POST", `/driver/deliveries/${delivery.id}/${action}`, body, driver.token)).status, 200);
      const pod = { otp: delivery.dropoff_otp, recipient_name: "Recipient", pod_signature: "data:image/png;base64,AAAA", cash_collected: true };
      const results = await Promise.all([1, 2].map(() => call("POST", `/driver/deliveries/${delivery.id}/deliver`, pod, driver.token)));
      assert.ok(results.some((r) => r.status === 200), JSON.stringify(results));
      const {
        rows: [done],
      } = await db.query("SELECT platform_fee FROM deliveries WHERE id=$1", [delivery.id]);
      const ledger = await db.query("SELECT kind,amount FROM driver_cash_ledger WHERE delivery_id=$1", [delivery.id]);
      assert.equal(ledger.rowCount, 1);
      assert.equal(Number(ledger.rows[0].amount), Number(done.platform_fee));
      const w = await wallet();
      assert.equal(w.currency, "PKR");
      assert.equal(w.balance, Number(done.platform_fee));
      assert.equal(w.over_limit, true);
      assert.equal(w.payment_accounts[0].account, "03451234567");
      assert.equal(w.entries[0].delivery_number, delivery.delivery_number);
    });

    await t.test("a driver over the limit cannot go online or receive offers", async () => {
      const online = await call("POST", "/driver/status", { status: "available" }, driver.token);
      assert.equal(online.status, 403);
      assert.equal(online.body.code, "cash_limit");
      assert.equal((await call("POST", "/driver/status", { status: "offline" }, driver.token)).status, 200, "going offline is always allowed");
      await placeDriver();
      const created = await call("POST", "/deliveries", deliveryBody(), customer.token);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const { rows } = await db.query("SELECT driver_id FROM deliveries WHERE id=$1", [created.body.delivery.id]);
      assert.equal(rows[0].driver_id, null);
      assert.equal((await call("POST", `/deliveries/${created.body.delivery.id}/cancel`, {}, customer.token)).status, 200);
    });

    let claim;
    await t.test("drivers submit payments that operations confirm", async () => {
      const owed = (await wallet()).balance;
      const reference = "EP" + randomInt(1e9);
      assert.equal((await call("POST", "/driver/wallet/remittances", { method: "easypaisa", reference, amount: owed + 1 }, driver.token)).status, 409);
      assert.equal((await call("POST", "/driver/wallet/remittances", { method: "easypaisa", reference: "<x>", amount: owed }, driver.token)).status, 400);
      assert.equal((await call("POST", "/driver/wallet/remittances", { method: "cash_office", reference, amount: owed }, driver.token)).status, 400, "drivers cannot claim office cash");
      const r = await call("POST", "/driver/wallet/remittances", { method: "easypaisa", reference, amount: owed }, driver.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      claim = r.body.remittance;
      assert.equal(claim.status, "pending");
      assert.equal((await call("POST", "/driver/wallet/remittances", { method: "easypaisa", reference, amount: 0.01 }, driver.token)).status, 409);
      const w = await wallet();
      assert.equal(w.balance, owed, "a claim alone does not reduce the balance");
      assert.equal(w.pending_confirmation, owed);

      assert.equal((await call("GET", "/admin/driver-wallets", undefined, customer.token)).status, 403);
      assert.equal((await call("GET", "/admin/driver-wallets", undefined, driver.token)).status, 403);
      const list = await call("GET", "/admin/driver-wallets", undefined, ops);
      assert.equal(list.status, 200);
      assert.ok(list.body.pending.some((p) => p.id === claim.id));
      assert.equal(list.body.can_adjust, false);

      assert.equal((await call("POST", `/admin/driver-wallets/remittances/${claim.id}/confirm`, { amount: owed + 1, confirm: true }, ops)).status, 400);
      const confirmed = await call("POST", `/admin/driver-wallets/remittances/${claim.id}/confirm`, { amount: owed, confirm: true }, ops);
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      const replay = await call("POST", `/admin/driver-wallets/remittances/${claim.id}/confirm`, { amount: owed, confirm: true }, ops);
      assert.equal(replay.body.replayed, true);
      assert.equal((await call("POST", `/admin/driver-wallets/remittances/${claim.id}/reject`, { note: "Too late" }, ops)).status, 409);
      assert.equal((await db.query("SELECT 1 FROM driver_cash_ledger WHERE remittance_id=$1", [claim.id])).rowCount, 1);
      assert.equal((await wallet()).balance, 0);
      assert.equal((await call("POST", "/driver/status", { status: "available" }, driver.token)).status, 200, "paid drivers can go online");
      await call("POST", "/driver/status", { status: "offline" }, driver.token);
    });

    await t.test("rejections, office cash and administrator adjustments", async () => {
      assert.equal((await call("POST", `/admin/driver-wallets/${driver.driver.id}/adjustments`, { amount: 50, note: "Opening balance", confirm: true }, ops)).status, 403);
      const adjusted = await call("POST", `/admin/driver-wallets/${driver.driver.id}/adjustments`, { amount: 50, note: "Opening balance", confirm: true }, admin);
      assert.equal(adjusted.status, 201, JSON.stringify(adjusted.body));
      const reference = "JC" + randomInt(1e9);
      const submitted = await call("POST", "/driver/wallet/remittances", { method: "jazzcash", reference, amount: 20 }, driver.token);
      assert.equal(submitted.status, 201);
      assert.equal((await call("POST", `/admin/driver-wallets/remittances/${submitted.body.remittance.id}/reject`, { note: "" }, ops)).status, 400);
      const rejected = await call("POST", `/admin/driver-wallets/remittances/${submitted.body.remittance.id}/reject`, { note: "No matching JazzCash receipt" }, ops);
      assert.equal(rejected.status, 200);
      const w = await wallet();
      assert.equal(w.balance, 50);
      assert.equal(w.remittances[0].review_note, "No matching JazzCash receipt");
      assert.equal((await call("POST", "/driver/wallet/remittances", { method: "jazzcash", reference, amount: 20 }, driver.token)).status, 201, "a rejected reference can be corrected and resubmitted");
      const office = await call("POST", `/admin/driver-wallets/${driver.driver.id}/remittances`, { method: "cash_office", reference: "OFFICE-" + randomInt(1e6), amount: 30, confirm: true }, ops);
      assert.equal(office.status, 201, JSON.stringify(office.body));
      assert.equal((await wallet()).balance, 20);
      const audit = await db.query("SELECT action FROM audit_logs WHERE actor_id IN ($1,$2) AND action LIKE 'driver_wallet.%'", [adminUser.user.id, opsUser.user.id]);
      assert.ok(audit.rowCount >= 4, "operator actions are audited");
    });
  },
);
