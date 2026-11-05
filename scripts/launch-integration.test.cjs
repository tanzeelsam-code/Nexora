"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const Redis = require("ioredis");
const { createBackend } = require("../backend_api.js");
test(
  "launch: support ownership, operator review, PIN limits and irreversible account removal",
  { skip: process.env.NEXORA_TEST_DATABASE !== "isolated", timeout: 120000 },
  async (t) => {
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
        LOG_LEVEL: process.env.TEST_LOG_LEVEL || "silent",
        JWT_SECRET: "launch-isolated-test-secret-at-least-32-characters",
      },
    });
    await backend.initialize();
    t.after(async () => {
      await backend.app.close();
      await redis.quit();
      await db.end();
    });
    async function call(method, path, body, token) {
      const r = await backend.app.inject({
        method,
        url: "/api/v1" + path,
        payload: body,
        headers: token ? { authorization: "Bearer " + token } : {},
      });
      return { status: r.statusCode, body: r.json() };
    }
    const suffix = crypto.randomBytes(7).toString("hex"),
      password = "Launch-test-password-123";
    const credentials = (tag) => ({
      email: `${tag}-${suffix}@nexora.test`,
      password,
      phone: "+1555" + crypto.randomInt(1e9).toString().padStart(9, "0"),
      first_name: "Launch",
      last_name: tag,
    });
    async function register(tag) {
      const c = credentials(tag),
        r = await call("POST", "/auth/register", c);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { ...r.body, credentials: c };
    }
    const owner = await register("owner"),
      other = await register("other"),
      admin = await register("admin");
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [
      admin.user.id,
    ]);
    const staff = (await call("POST", "/auth/login", admin.credentials)).body
      .token;
    const driverCredentials = credentials("driver");
    let r = await call("POST", "/drivers/register", {
      ...driverCredentials,
      mode: "both",
      vehicle: {
        plate_number: suffix,
        make: "Test",
        model: "Car",
        year: 2025,
        color: "White",
        vehicle_type: "sedan",
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const driver = r.body;
    assert.equal(
      (
        await call(
          "POST",
          `/admin/drivers/${driver.driver.id}/approve`,
          {},
          staff,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "POST",
          `/admin/drivers/${driver.driver.id}/approve`,
          {
            reviewed_identity: true,
            reviewed_license: true,
            reviewed_vehicle: true,
          },
          staff,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("POST", "/driver/mobile-session", {}, owner.token)).status,
      403,
    );
    assert.equal(
      (await call("POST", "/driver/mobile-session", {}, driver.token)).status,
      403,
    );
    await db.query(
      "UPDATE drivers SET is_online=TRUE,status='available' WHERE id=$1",
      [driver.driver.id],
    );
    const mobile = await call(
      "POST",
      "/driver/mobile-session",
      {},
      driver.token,
    );
    assert.equal(mobile.status, 200);
    assert.notEqual(mobile.body.refresh_token, driver.refresh_token);
    assert.equal(
      (
        await call("POST", "/auth/refresh", {
          refresh_token: mobile.body.refresh_token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("POST", "/auth/refresh", {
          refresh_token: driver.refresh_token,
        })
      ).status,
      200,
    );
    r = await call("GET", "/admin/drivers", undefined, staff);
    assert.ok(
      r.body.drivers.find((d) => d.id === driver.driver.id).vehicles.length,
    );
    assert.equal(r.body.can_suspend, true);
    assert.equal(
      (await call("GET", "/admin/support", undefined, owner.token)).status,
      403,
    );
    assert.equal(
      (
        await call("POST", "/support/tickets", {
          category: "booking",
          message: "Please review this test request.",
        })
      ).status,
      401,
    );
    const supportRequest = {
      request_id: crypto.randomUUID(),
      category: "payment",
      message: "Please check my cash receipt. <script>unsafe</script>",
    };
    r = await call("POST", "/support/tickets", supportRequest, owner.token);
    assert.equal(r.status, 200);
    const ticket = r.body.ticket;
    assert.equal(
      (await call("POST", "/support/tickets", supportRequest, owner.token)).body
        .ticket.id,
      ticket.id,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/support/tickets",
          {
            ...supportRequest,
            message: "Changed after sending the original request",
          },
          owner.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (await call("GET", "/support/tickets", undefined, other.token)).body
        .tickets.length,
      0,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/admin/support/" + ticket.id,
          {
            status: "resolved",
            reply: "Receipt checked in the isolated test.",
          },
          owner.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/admin/support/" + ticket.id,
          {
            status: "resolved",
            reply: "Receipt checked in the isolated test.",
          },
          staff,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("GET", "/support/tickets", undefined, owner.token)).body
        .tickets[0].status,
      "resolved",
    );
    const ride = {
      pickup_lat: 40.75,
      pickup_lng: -73.98,
      pickup_address: "Private home",
      dropoff_lat: 40.76,
      dropoff_lng: -73.99,
      dropoff_address: "Private office",
      payment_method: "cash",
    };
    r = await call("POST", "/trips", ride, owner.token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const trip = r.body.trip;
    assert.equal(
      (
        await call(
          "POST",
          "/support/tickets",
          {
            category: "booking",
            message: "Cannot read another person trip",
            trip_id: trip.id,
          },
          other.token,
        )
      ).status,
      404,
    );
    const remove = (actor) =>
      call(
        "POST",
        "/account/delete",
        { password, confirm: "DELETE" },
        actor.token,
      );
    assert.equal((await remove(owner)).status, 409);
    await db.query(
      "UPDATE trips SET driver_id=$1,status='arrived' WHERE id=$2",
      [driver.driver.id, trip.id],
    );
    await db.query(
      "UPDATE drivers SET status='on_trip',is_online=TRUE WHERE id=$1",
      [driver.driver.id],
    );
    assert.equal((await remove(driver)).status, 409);
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await call(
            "POST",
            `/driver/trips/${trip.id}/start`,
            { otp: "bad" },
            driver.token,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await call(
          "POST",
          `/driver/trips/${trip.id}/start`,
          { otp: trip.pickup_otp },
          driver.token,
        )
      ).status,
      429,
    );
    await redis.del("handoff:trip:" + trip.id);
    assert.equal(
      (
        await call(
          "POST",
          `/driver/trips/${trip.id}/start`,
          { otp: trip.pickup_otp },
          driver.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "POST",
          `/driver/trips/${trip.id}/complete`,
          { cash_collected: true },
          driver.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/account/delete",
          { password: "wrong", confirm: "DELETE" },
          owner.token,
        )
      ).status,
      403,
    );
    r = await remove(owner);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, true);
    assert.equal(
      (await call("GET", "/trips", undefined, owner.token)).status,
      401,
    );
    assert.equal(
      (
        await call("POST", "/auth/refresh", {
          refresh_token: owner.refresh_token,
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("POST", "/auth/login", owner.credentials)).status,
      401,
    );
    const gone = (
      await db.query(
        "SELECT email,phone,first_name,is_active,deleted_at FROM users WHERE id=$1",
        [owner.user.id],
      )
    ).rows[0];
    assert.equal(gone.is_active, false);
    assert.ok(gone.deleted_at);
    assert.notEqual(gone.email, owner.credentials.email);
    assert.notEqual(gone.phone, owner.credentials.phone);
    const redacted = (
      await db.query(
        "SELECT pickup_address,pickup_lat,pickup_otp,total_fare FROM trips WHERE id=$1",
        [trip.id],
      )
    ).rows[0];
    assert.equal(redacted.pickup_address, "Address removed");
    assert.equal(Number(redacted.pickup_lat), 0);
    assert.equal(redacted.pickup_otp, null);
    assert.ok(Number(redacted.total_fare) > 0);
    r = await remove(driver);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const vehicle = (
      await db.query(
        "SELECT plate_number,is_active FROM vehicles WHERE driver_id=$1",
        [driver.driver.id],
      )
    ).rows[0];
    assert.equal(vehicle.plate_number, "Removed");
    assert.equal(vehicle.is_active, false);
    assert.equal(
      (await call("GET", "/admin/drivers", undefined, staff)).body.drivers.some(
        (d) => d.id === driver.driver.id,
      ),
      false,
    );
  },
);
