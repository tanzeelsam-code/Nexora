"use strict";
/*
 * Outbound SMS for verification codes.
 *
 *   SMS_PROVIDER=twilio   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID
 *   SMS_PROVIDER=webhook  SMS_WEBHOOK_URL (HTTPS) and SMS_WEBHOOK_TOKEN: POSTs {to,message} with a bearer token,
 *                         so a local Pakistani SMS gateway can be connected through a small adapter.
 *   SMS_PROVIDER=log      Development only: writes the message to the server log.
 *
 * With no provider configured, phone sign-in is reported as unavailable and nothing is sent.
 */
const { unavailable } = require("./maps.cjs");

function maskPhone(phone) {
  const value = String(phone || "");
  return value.length > 6 ? value.slice(0, 4) + "•••" + value.slice(-4) : "•••";
}

function createSms(env = {}, { fetch = globalThis.fetch, logger, isProduction = false } = {}) {
  const provider = String(env.SMS_PROVIDER || "").trim().toLowerCase();
  const disabled = {
    enabled: false,
    provider: null,
    async send() {
      throw unavailable("Phone sign-in is not available yet. Use your email and password.");
    },
  };
  if (!provider) return disabled;

  let deliver;
  if (provider === "twilio") {
    const sid = String(env.TWILIO_ACCOUNT_SID || "");
    const token = String(env.TWILIO_AUTH_TOKEN || "");
    const from = String(env.TWILIO_FROM || "");
    const service = String(env.TWILIO_MESSAGING_SERVICE_SID || "");
    if (!/^AC[0-9a-f]{32}$/i.test(sid) || token.length < 16 || !(from || /^MG[0-9a-f]{32}$/i.test(service)))
      throw new Error("SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID");
    deliver = async (to, message) => {
      const form = new URLSearchParams({ To: to, Body: message, ...(service ? { MessagingServiceSid: service } : { From: from }) });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Twilio returned ${res.status}`);
      const data = await res.json().catch(() => ({}));
      return { id: data.sid || null };
    };
  } else if (provider === "webhook") {
    let url;
    try {
      url = new URL(String(env.SMS_WEBHOOK_URL || ""));
    } catch {
      url = null;
    }
    const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const token = String(env.SMS_WEBHOOK_TOKEN || "");
    if (!url || !(url.protocol === "https:" || (!isProduction && local && url.protocol === "http:")) || token.length < 16)
      throw new Error("SMS_PROVIDER=webhook needs an HTTPS SMS_WEBHOOK_URL and an SMS_WEBHOOK_TOKEN of at least 16 characters");
    deliver = async (to, message) => {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ to, message, purpose: "verification_code" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`SMS webhook returned ${res.status}`);
      const data = await res.json().catch(() => ({}));
      return { id: data.id || null };
    };
  } else if (provider === "log") {
    if (isProduction) throw new Error("SMS_PROVIDER=log is for development only");
    deliver = async (to, message) => {
      logger?.warn({ to: maskPhone(to) }, `Development SMS (not sent): ${message}`);
      return { id: null };
    };
  } else {
    throw new Error(`Unknown SMS_PROVIDER "${provider}" (use twilio, webhook or log)`);
  }

  return {
    enabled: true,
    provider,
    async send(to, message) {
      try {
        return await deliver(to, message);
      } catch (err) {
        logger?.error({ msg: err.message, to: maskPhone(to), provider }, "SMS delivery failed");
        throw unavailable("We couldn't send the text message. Please try again shortly.");
      }
    },
  };
}

module.exports = { createSms, maskPhone };
