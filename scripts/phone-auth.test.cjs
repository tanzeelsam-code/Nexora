"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, phoneVariants } = require("../services/phone-auth.cjs");
const { createSms } = require("../services/sms.cjs");

test("phone numbers normalize to E.164 and Pakistan accepts mobile numbers only", () => {
  for (const input of ["0300 1234567", "03001234567", "+92 300 1234567", "923001234567", "00923001234567", "300-123-4567"])
    assert.equal(normalizePhone(input, "PK"), "+923001234567", input);
  for (const input of ["042 35761234", "+15550001111", "0300123456", "", "abc"])
    assert.equal(normalizePhone(input, "PK"), null, input);
  assert.equal(normalizePhone("+44 7700 900123", ""), "+447700900123");
  assert.equal(normalizePhone("07700900123", ""), null);
  assert.deepEqual(new Set(phoneVariants("+923001234567")), new Set(["+923001234567", "923001234567", "00923001234567", "03001234567", "3001234567"]));
});

test("SMS providers fail closed and refuse unsafe configuration", () => {
  assert.equal(createSms({}).enabled, false);
  assert.throws(() => createSms({ SMS_PROVIDER: "log" }, { isProduction: true }), /development only/);
  assert.throws(() => createSms({ SMS_PROVIDER: "webhook", SMS_WEBHOOK_URL: "http://sms.example.com/x", SMS_WEBHOOK_TOKEN: "x".repeat(20) }), /HTTPS/);
  assert.throws(() => createSms({ SMS_PROVIDER: "webhook", SMS_WEBHOOK_URL: "https://sms.example.com/x", SMS_WEBHOOK_TOKEN: "short" }), /16 characters/);
  assert.throws(() => createSms({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "nope" }), /TWILIO/);
  assert.throws(() => createSms({ SMS_PROVIDER: "carrier-pigeon" }), /Unknown SMS_PROVIDER/);
  assert.equal(createSms({ SMS_PROVIDER: "webhook", SMS_WEBHOOK_URL: "https://sms.example.com/x", SMS_WEBHOOK_TOKEN: "x".repeat(20) }).enabled, true);
});

test("Twilio requests use basic auth and form encoding", async () => {
  const sent = [];
  const sms = createSms(
    { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32), TWILIO_AUTH_TOKEN: "t".repeat(32), TWILIO_FROM: "+15005550006" },
    { fetch: async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }); } },
  );
  assert.deepEqual(await sms.send("+923001234567", "123456 is your code"), { id: "SM1" });
  assert.match(sent[0].url, /Accounts\/ACa{32}\/Messages\.json$/);
  assert.match(sent[0].init.headers.Authorization, /^Basic /);
  assert.equal(new URLSearchParams(sent[0].init.body).get("To"), "+923001234567");
});

test(
  "phone sign-in: codes, sign-up, verified sign-in, linking and deletion",
  { skip: process.env.NEXORA_TEST_DATABASE !== "isolated", timeout: 120000 },
  async (t) => {
    const { Pool } = require("pg"),
      Redis = require("ioredis"),
      { randomInt, randomUUID } = require("node:crypto"),
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
    for (const file of ["20261024093153_release_recovery_cash_billing.sql", "20261019085513_booking_payments_notifications.sql", "20261105154028_area_availability_merchant_cod.sql", "20261105190000_phone_sign_in.sql"])
      await db.query(fs.readFileSync("supabase/migrations/" + file, "utf8"));
    // Every injected request comes from the loopback address; start each run with a clean per-address budget.
    await db.query("DELETE FROM phone_verifications WHERE ip='127.0.0.1'");

    const inbox = [];
    let failNext = false;
    const backend = createBackend({
      edge: true,
      db,
      redis,
      rateLimit: async () => {},
      io: { on() {}, to() { return { emit() {} }; } },
      fetch: async (url, init) => {
        if (String(url) !== "https://sms.test/send") throw new Error("Unexpected request " + url);
        assert.equal(init.headers.Authorization, "Bearer phone-test-webhook-token");
        if (failNext) {
          failNext = false;
          return new Response("{}", { status: 500 });
        }
        inbox.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "msg-" + inbox.length }), { status: 200 });
      },
      env: {
        NODE_ENV: "development",
        LOG_LEVEL: "silent",
        JWT_SECRET: "phone-tests-secret-at-least-32-characters",
        CURRENCY: "PKR",
        SERVICE_COUNTRY: "PK",
        SMS_PROVIDER: "webhook",
        SMS_WEBHOOK_URL: "https://sms.test/send",
        SMS_WEBHOOK_TOKEN: "phone-test-webhook-token",
      },
    });
    await backend.initialize();
    t.after(async () => {
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
    const mobile = () => "03" + String(randomInt(1e9)).padStart(9, "0");
    const e164 = (local) => "+92" + local.slice(1);
    const lastCode = (phone) => {
      const message = [...inbox].reverse().find((m) => m.to === phone);
      return message && message.message.match(/^(\d{6}) /)[1];
    };
    // The one-minute resend wait is enforced by time; tests move earlier codes into the past.
    const age = (phone) => db.query("UPDATE phone_verifications SET created_at=created_at-INTERVAL '2 minutes' WHERE phone=$1", [phone]);

    assert.equal((await call("GET", "/config")).body.phone_sign_in, true);

    const local = mobile(),
      phone = e164(local);
    let newUser;
    await t.test("a new number signs up with a code and a name", async () => {
      assert.equal((await call("POST", "/auth/phone/start", { phone: "042 35761234" })).status, 400);
      const sent = await call("POST", "/auth/phone/start", { phone: local.replace(/^(\d{4})/, "$1 ") });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body.sent, true);
      assert.equal(JSON.stringify(sent.body).includes(lastCode(phone)), false, "the response never contains the code");
      const again = await call("POST", "/auth/phone/start", { phone: local });
      assert.equal(again.status, 429);
      assert.ok(again.body.retry_after_sec > 0);

      const code = lastCode(phone);
      const wrong = await call("POST", "/auth/phone/verify", { phone: local, code: code === "000000" ? "111111" : "000000" });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.attempts_left, 4);
      const verified = await call("POST", "/auth/phone/verify", { phone: local, code });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.needs_profile, true);
      assert.equal(verified.body.token, undefined);
      assert.equal((await call("POST", "/auth/phone/verify", { phone: local, code })).status, 400, "a code works once");
      // The sign-up token is not an access token.
      assert.equal((await call("GET", "/trips", undefined, verified.body.signup_token)).status, 401);

      const signupToken = verified.body.signup_token;
      assert.equal((await call("POST", "/auth/phone/complete", { signup_token: signupToken, first_name: "Ayesha" })).status, 400, "terms must be accepted");
      const created = await call("POST", "/auth/phone/complete", { signup_token: signupToken, first_name: "Ayesha", accept_terms: true });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.user.role, "customer");
      assert.equal(created.body.user.email, null);
      assert.equal(created.body.user.phone, phone);
      assert.equal((await call("GET", "/trips", undefined, created.body.token)).status, 200);
      assert.equal((await call("POST", "/auth/phone/complete", { signup_token: signupToken, first_name: "Again", accept_terms: true })).status, 409);
      newUser = created.body.user;
    });

    await t.test("the same number signs in to the same account", async () => {
      await age(phone);
      assert.equal((await call("POST", "/auth/phone/start", { phone: "+92 " + local.slice(1) })).status, 200);
      const r = await call("POST", "/auth/phone/verify", { phone: local, code: lastCode(phone) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.user.id, newUser.id);
      assert.ok(r.body.token && r.body.refresh_token);
    });

    await t.test("five wrong guesses burn the code", async () => {
      await age(phone);
      await call("POST", "/auth/phone/start", { phone: local });
      const code = lastCode(phone),
        wrong = code === "999999" ? "888888" : "999999";
      for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/auth/phone/verify", { phone: local, code: wrong })).status, 400);
      const r = await call("POST", "/auth/phone/verify", { phone: local, code });
      assert.equal(r.status, 400);
      assert.equal(r.body.attempts_left, 0);
    });

    await t.test("a failed text message leaves no usable code", async () => {
      const other = mobile();
      failNext = true;
      assert.equal((await call("POST", "/auth/phone/start", { phone: other })).status, 503);
      const { rows } = await db.query("SELECT consumed_at FROM phone_verifications WHERE phone=$1", [e164(other)]);
      assert.equal(rows.length, 1);
      assert.ok(rows[0].consumed_at);
    });

    await t.test("hourly limit per number", async () => {
      const busy = mobile();
      for (let i = 0; i < 5; i++) {
        assert.equal((await call("POST", "/auth/phone/start", { phone: busy })).status, 200);
        await age(e164(busy));
      }
      await db.query("UPDATE phone_verifications SET created_at=NOW()-INTERVAL '30 minutes' WHERE phone=$1", [e164(busy)]);
      assert.equal((await call("POST", "/auth/phone/start", { phone: busy })).status, 429);
    });

    await t.test("an email account must verify its number before phone sign-in", async () => {
      const legacyLocal = mobile(),
        legacyPhone = e164(legacyLocal),
        email = `phone-legacy-${randomUUID()}@nexora.test`;
      const registered = await call("POST", "/auth/register", { email, phone: legacyLocal, first_name: "Legacy", last_name: "User", password: "Legacy-pass-123" });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      await call("POST", "/auth/phone/start", { phone: legacyLocal });
      const refused = await call("POST", "/auth/phone/verify", { phone: legacyLocal, code: lastCode(legacyPhone) });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "phone_not_verified");
      assert.equal(refused.body.token, undefined);

      const token = registered.body.token;
      await age(legacyPhone);
      assert.equal((await call("POST", "/account/phone/code", { purpose: "verify_phone" }, token)).status, 200);
      const linked = await call("POST", "/account/phone/verify", { code: lastCode(legacyPhone) }, token);
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(linked.body.phone, legacyPhone);
      assert.equal((await call("POST", "/account/phone/code", { purpose: "verify_phone" }, token)).status, 409, "already verified");

      await age(legacyPhone);
      await call("POST", "/auth/phone/start", { phone: legacyPhone });
      const signedIn = await call("POST", "/auth/phone/verify", { phone: legacyPhone, code: lastCode(legacyPhone) });
      assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
      assert.equal(signedIn.body.user.id, registered.body.user.id);
      // Email sign-in keeps working.
      assert.equal((await call("POST", "/auth/login", { email, password: "Legacy-pass-123" })).status, 200);
    });

    await t.test("staff accounts cannot sign in by phone", async () => {
      const staffLocal = mobile(),
        staffPhone = e164(staffLocal);
      await db.query(
        `INSERT INTO users(email,phone,phone_verified,first_name,last_name,password_hash,salt,role)
         VALUES($1,$2,TRUE,'Ops','Person','x','', 'ops')`,
        [`phone-ops-${randomUUID()}@nexora.test`, staffPhone],
      );
      await call("POST", "/auth/phone/start", { phone: staffLocal });
      const r = await call("POST", "/auth/phone/verify", { phone: staffLocal, code: lastCode(staffPhone) });
      assert.equal(r.status, 403);
      assert.equal(r.body.token, undefined);
    });

    await t.test("a phone-only account deletes itself with a text message code", async () => {
      await age(phone);
      await call("POST", "/auth/phone/start", { phone: local });
      const session = (await call("POST", "/auth/phone/verify", { phone: local, code: lastCode(phone) })).body;
      assert.ok(session.token);
      await age(phone);
      assert.equal((await call("POST", "/account/phone/code", { purpose: "delete_account" }, session.token)).status, 200);
      const code = lastCode(phone);
      assert.equal((await call("POST", "/account/delete", { phone_code: code === "123456" ? "654321" : "123456", confirm: "DELETE" }, session.token)).status, 403);
      assert.equal((await call("POST", "/account/delete", { password: "x", phone_code: code, confirm: "DELETE" }, session.token)).status, 400, "one confirmation method only");
      const deleted = await call("POST", "/account/delete", { phone_code: code, confirm: "DELETE" }, session.token);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal((await db.query("SELECT 1 FROM phone_verifications WHERE phone=$1", [phone])).rowCount, 0, "codes for the number are purged");
      assert.equal((await call("GET", "/trips", undefined, session.token)).status, 401);
      await call("POST", "/auth/phone/start", { phone: local });
      const fresh = await call("POST", "/auth/phone/verify", { phone: local, code: lastCode(phone) });
      assert.equal(fresh.body.needs_profile, true, "the deleted account no longer owns the number");
    });
  },
);
