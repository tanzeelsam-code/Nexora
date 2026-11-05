"use strict";
/*
 * Phone sign-in with one-time SMS codes.
 *
 * - Codes are 6 digits, valid for 5 minutes, and allow 5 attempts. Only an HMAC of the code
 *   (keyed with the server secret and bound to the row id) is stored.
 * - Sending is limited per number (one per minute, five per hour) and per client address.
 * - A verified number signs in to its customer or driver account. A number with no account
 *   receives a short-lived, single-use sign-up token; the account is created only after the
 *   person gives their name. Staff accounts never sign in by phone.
 * - Existing email accounts sign in by phone only after verifying that number while signed in,
 *   so a mistyped number on an old registration cannot open someone else's account.
 */
const crypto = require("node:crypto");
const net = require("node:net");
const { z } = require("zod");
const { unavailable } = require("./maps.cjs");
const { maskPhone } = require("./sms.cjs");

const CODE_TTL_SEC = 300;
const RESEND_AFTER_SEC = 60;
const MAX_ATTEMPTS = 5;
const MAX_PER_PHONE_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 20;
const SIGNUP_TOKEN_TTL = "15m";
const fifteenMinutes = 15 * 60 * 1000;

// Returns an E.164 number or null. In Pakistan only mobile numbers (03xx) can receive codes.
function normalizePhone(input, country = "") {
  let value = String(input || "").trim().replace(/[\s().-]/g, "");
  if (value.startsWith("00")) value = "+" + value.slice(2);
  if (country === "PK") {
    const match = value.match(/^(?:\+?92|0)?(3\d{9})$/);
    return match ? "+92" + match[1] : null;
  }
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

// Earlier registrations stored numbers as typed; these are the spellings of one number.
function phoneVariants(e164) {
  const digits = e164.slice(1);
  const variants = new Set([e164, digits, "00" + digits]);
  if (e164.startsWith("+92")) {
    variants.add("0" + e164.slice(3));
    variants.add(e164.slice(3));
  }
  return [...variants];
}

function phoneHint(country) {
  return country === "PK"
    ? "Enter a Pakistani mobile number, for example 0300 1234567."
    : "Enter your mobile number in international format, for example +44 7700 900123.";
}

function registerPhoneAuth({
  app,
  query,
  transaction,
  validate,
  authenticate,
  requireDatabase,
  issueAuthTokens,
  bcrypt,
  sms,
  kv,
  secret,
  country = "",
  clearUserCache = async () => {},
}) {
  const digest = (id, code) => crypto.createHmac("sha256", secret).update(`${id}:${code}`).digest();
  const codeSchema = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.");
  const limited = (max) => ({ preHandler: requireDatabase, config: { rateLimit: { max, timeWindow: fifteenMinutes } } });
  const signedIn = [authenticate, requireDatabase];

  function phoneOrFail(input) {
    const phone = normalizePhone(input, country);
    if (!phone) throw unavailable(phoneHint(country), 400);
    return phone;
  }

  function requireSms() {
    if (!sms.enabled) throw unavailable("Phone sign-in is not available yet. Use your email and password.");
  }

  async function issueCode(reply, { phone, purpose, userId = null, ip }) {
    requireSms();
    const address = net.isIP(String(ip || "")) ? String(ip) : null;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const id = crypto.randomUUID();
    const refusal = await transaction(async (client) => {
      // Serialize sends for one number so concurrent requests cannot exceed the limits.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["phone-code:" + phone]);
      const {
        rows: [recent],
      } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE phone=$1)::int AS phone_hour,
          COUNT(*) FILTER (WHERE ip=$2::inet)::int AS ip_hour,
          EXTRACT(EPOCH FROM NOW() - MAX(created_at) FILTER (WHERE phone=$1 AND purpose=$3))::float AS since_last
        FROM phone_verifications WHERE (phone=$1 OR ip=$2::inet) AND created_at > NOW() - INTERVAL '1 hour'`,
        [phone, address, purpose],
      );
      if (recent.since_last !== null && recent.since_last < RESEND_AFTER_SEC)
        return { status: 429, error: "Please wait a moment before requesting another code.", retry_after_sec: Math.ceil(RESEND_AFTER_SEC - recent.since_last) };
      if (recent.phone_hour >= MAX_PER_PHONE_PER_HOUR || recent.ip_hour >= MAX_PER_IP_PER_HOUR)
        return { status: 429, error: "Too many codes were requested. Please try again in an hour.", retry_after_sec: 3600 };
      // Only the newest code for a number and purpose can be used.
      await client.query(
        "UPDATE phone_verifications SET consumed_at=NOW() WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL",
        [phone, purpose],
      );
      await client.query(
        `INSERT INTO phone_verifications(id,phone,purpose,user_id,code_hash,ip,expires_at)
         VALUES($1,$2,$3,$4,$5,$6::inet,NOW() + ($7 * INTERVAL '1 second'))`,
        [id, phone, purpose, userId, digest(id, code).toString("hex"), address, CODE_TTL_SEC],
      );
      return null;
    });
    if (refusal) {
      const { status, ...body } = refusal;
      reply.header("Retry-After", String(body.retry_after_sec));
      return reply.code(status).send(body);
    }
    const text =
      purpose === "delete_account"
        ? `${code} is your Nexora code to confirm deleting your account. It expires in 5 minutes. Never share it.`
        : `${code} is your Nexora verification code. It expires in 5 minutes. Never share it with anyone, including Nexora staff.`;
    try {
      await sms.send(phone, text);
    } catch (err) {
      await query("UPDATE phone_verifications SET consumed_at=NOW() WHERE id=$1", [id]);
      throw err;
    }
    return { sent: true, phone: maskPhone(phone), expires_in_sec: CODE_TTL_SEC, resend_after_sec: RESEND_AFTER_SEC };
  }

  // Consumes the newest live code exactly once. A wrong guess is committed so attempts accumulate.
  async function consume({ phone, purpose, code, userId = null }) {
    return transaction(async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT id,code_hash,attempts,expires_at > NOW() AS live FROM phone_verifications
         WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL AND ($3::uuid IS NULL OR user_id=$3)
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [phone, purpose, userId],
      );
      if (!row || !row.live || row.attempts >= MAX_ATTEMPTS) return { ok: false, attempts_left: 0 };
      const attempts = row.attempts + 1;
      const matched = crypto.timingSafeEqual(digest(row.id, code), Buffer.from(row.code_hash, "hex"));
      await client.query(
        `UPDATE phone_verifications SET attempts=$2${matched ? ",consumed_at=NOW()" : ""} WHERE id=$1`,
        [row.id, attempts],
      );
      return matched ? { ok: true } : { ok: false, attempts_left: MAX_ATTEMPTS - attempts };
    });
  }

  function codeRefusal(reply, result) {
    return reply.code(400).send({
      error: result.attempts_left
        ? `That code is not correct. ${result.attempts_left} ${result.attempts_left === 1 ? "try" : "tries"} left.`
        : "This code has expired or was entered incorrectly too many times. Request a new code.",
      attempts_left: result.attempts_left,
    });
  }

  async function accountsForPhone(phone, run = query) {
    return (
      await run(
        `SELECT id,role,email,phone,first_name,last_name,is_active,is_banned,auth_version,phone_verified
         FROM users WHERE deleted_at IS NULL AND regexp_replace(phone,'[^0-9+]','','g') = ANY($1::text[])`,
        [phoneVariants(phone)],
      )
    ).rows;
  }

  const publicUser = (user) => ({
    id: user.id,
    email: user.email,
    phone: user.phone,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
  });

  app.post("/api/v1/auth/phone/start", limited(5), async (req, reply) => {
    const body = validate(z.object({ phone: z.string().max(30) }), req.body);
    requireSms();
    // The response is the same whether or not the number has an account.
    return issueCode(reply, { phone: phoneOrFail(body.phone), purpose: "sign_in", ip: req.ip });
  });

  app.post("/api/v1/auth/phone/verify", limited(10), async (req, reply) => {
    const body = validate(z.object({ phone: z.string().max(30), code: codeSchema }), req.body);
    requireSms();
    const phone = phoneOrFail(body.phone);
    const result = await consume({ phone, purpose: "sign_in", code: body.code });
    if (!result.ok) return codeRefusal(reply, result);

    const accounts = await accountsForPhone(phone);
    if (accounts.length > 1)
      return reply.code(409).send({ error: "More than one account uses this number. Contact support so we can fix it.", code: "phone_conflict" });
    const [user] = accounts;
    if (!user) {
      const signupToken = app.jwt.sign({ type: "phone_signup", phone, jti: crypto.randomUUID() }, { expiresIn: SIGNUP_TOKEN_TTL });
      return { needs_profile: true, signup_token: signupToken, phone };
    }
    if (!["customer", "driver"].includes(user.role))
      return reply.code(403).send({ error: "Staff accounts sign in with email and password.", code: "workspace_account" });
    if (!user.is_active) return reply.code(403).send({ error: "Account deactivated" });
    if (user.is_banned) return reply.code(403).send({ error: "Account suspended. Contact support." });
    if (!user.phone_verified)
      return reply.code(409).send({
        error: "This number belongs to an account that signs in with email. Sign in with your email and password once, then verify this number in your account to use phone sign-in.",
        code: "phone_not_verified",
      });
    await query("UPDATE users SET last_login_at=NOW(), last_login_ip=$1 WHERE id=$2", [net.isIP(String(req.ip || "")) ? req.ip : null, user.id]);
    const { token, refreshToken } = await issueAuthTokens(user);
    return { user: publicUser(user), token, refresh_token: refreshToken };
  });

  app.post("/api/v1/auth/phone/complete", limited(5), async (req, reply) => {
    const body = validate(
      z.object({
        signup_token: z.string().min(16).max(2000),
        first_name: z.string().trim().min(1).max(100),
        last_name: z.string().trim().max(100).default(""),
        accept_terms: z.literal(true),
      }),
      req.body,
    );
    let claim;
    try {
      claim = app.jwt.verify(body.signup_token);
    } catch {
      return reply.code(401).send({ error: "Your verification expired. Request a new code." });
    }
    if (claim?.type !== "phone_signup" || !claim.jti || normalizePhone(claim.phone, country) !== claim.phone)
      return reply.code(401).send({ error: "Your verification expired. Request a new code." });
    if ((await accountsForPhone(claim.phone)).length)
      return reply.code(409).send({ error: "This number already has an account. Sign in with your phone instead.", code: "phone_taken" });
    if ((await kv.set(`phone-signup-used:${claim.jti}`, "1", "EX", 1800, "NX")) !== "OK")
      return reply.code(409).send({ error: "This verification was already used. Request a new code." });
    // No password exists for a phone account; store an unusable random hash.
    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), await bcrypt.genSalt(12));
    let user;
    try {
      ({
        rows: [user],
      } = await query(
        `INSERT INTO users (email, phone, phone_verified, phone_verified_at, first_name, last_name, password_hash, salt, referral_code, signup_source)
         VALUES (NULL, $1, TRUE, NOW(), $2, $3, $4, '', $5, 'phone')
         RETURNING id, email, phone, first_name, last_name, role, auth_version`,
        [claim.phone, body.first_name, body.last_name, unusable, `NX${Date.now().toString(36).toUpperCase()}${crypto.randomInt(10, 99)}`],
      ));
    } catch (err) {
      if (err.code === "23505") return reply.code(409).send({ error: "This number already has an account. Sign in with your phone instead.", code: "phone_taken" });
      throw err;
    }
    const { token, refreshToken } = await issueAuthTokens(user);
    return reply.code(201).send({ user: publicUser(user), token, refresh_token: refreshToken });
  });

  async function currentAccount(userId) {
    const {
      rows: [user],
    } = await query("SELECT id,role,phone,phone_verified FROM users WHERE id=$1 AND is_active", [userId]);
    if (!user) throw unavailable("This account is no longer active.", 401);
    const phone = normalizePhone(user.phone, country);
    if (!phone) throw unavailable("The phone number on your account can't receive codes. Contact support to update it.", 400);
    return { ...user, e164: phone };
  }

  app.get("/api/v1/account/phone", { preHandler: signedIn }, async (req) => {
    const {
      rows: [user],
    } = await query("SELECT phone,phone_verified,email IS NULL AS phone_only FROM users WHERE id=$1", [req.user.id]);
    const phone = normalizePhone(user?.phone, country);
    return {
      phone_sign_in: sms.enabled,
      phone: phone ? maskPhone(phone) : null,
      verified: Boolean(user?.phone_verified),
      phone_only: Boolean(user?.phone_only),
      can_verify: Boolean(phone) && ["customer", "driver"].includes(req.user.role),
    };
  });

  app.post(
    "/api/v1/account/phone/code",
    { preHandler: signedIn, config: { rateLimit: { max: 5, timeWindow: fifteenMinutes } } },
    async (req, reply) => {
      const { purpose } = validate(z.object({ purpose: z.enum(["verify_phone", "delete_account"]) }), req.body);
      requireSms();
      const user = await currentAccount(req.user.id);
      if (!["customer", "driver"].includes(user.role))
        throw unavailable("Staff accounts sign in with email and password.", 403);
      if (purpose === "verify_phone") {
        if (user.phone_verified) return reply.code(409).send({ error: "Your phone number is already verified." });
        if ((await accountsForPhone(user.e164)).some((other) => other.id !== user.id))
          throw unavailable("Another account uses this number. Contact support so we can fix it.", 409);
      } else if (!user.phone_verified) {
        throw unavailable("Confirm deletion with your password instead.", 409);
      }
      return issueCode(reply, { phone: user.e164, purpose, userId: user.id, ip: req.ip });
    },
  );

  app.post(
    "/api/v1/account/phone/verify",
    { preHandler: signedIn, config: { rateLimit: { max: 10, timeWindow: fifteenMinutes } } },
    async (req, reply) => {
      const { code } = validate(z.object({ code: codeSchema }), req.body);
      const user = await currentAccount(req.user.id);
      const result = await consume({ phone: user.e164, purpose: "verify_phone", code, userId: user.id });
      if (!result.ok) return codeRefusal(reply, result);
      try {
        await query("UPDATE users SET phone=$2, phone_verified=TRUE, phone_verified_at=NOW() WHERE id=$1", [user.id, user.e164]);
      } catch (err) {
        if (err.code === "23505") throw unavailable("Another account uses this number. Contact support so we can fix it.", 409);
        throw err;
      }
      await clearUserCache(user.id);
      return { verified: true, phone: user.e164, message: "Your phone number is verified. You can now sign in with a text message code." };
    },
  );

  // Used by account deletion: phone-only accounts have no password to confirm with.
  async function confirmDeletion(userId, code) {
    const user = await currentAccount(userId);
    if (!user.phone_verified) return false;
    return (await consume({ phone: user.e164, purpose: "delete_account", code, userId })).ok;
  }

  return { enabled: sms.enabled, confirmDeletion };
}

module.exports = { registerPhoneAuth, normalizePhone, phoneVariants };
