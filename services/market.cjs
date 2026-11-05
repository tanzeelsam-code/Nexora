"use strict";
const { unavailable } = require("./maps.cjs");
const demoRates = {
  ride: { base: 2.5, per_km: 1.2, per_minute: 0.25, minimum: 5 },
  delivery: { base: 5, per_km: 2, per_kg: 0.05, minimum: 5 },
  commission_rate: 0.2,
};
function createMarket(env = {}) {
  const production = env.NODE_ENV === "production";
  const country = String(
    env.SERVICE_COUNTRY || (production ? "PK" : ""),
  ).toUpperCase();
  const currency = String(
    env.CURRENCY || (production ? "PKR" : "USD"),
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || (country && !/^[A-Z]{2}$/.test(country)))
    throw new Error("Invalid market currency or country");
  let rates;
  if (env.RATE_CARD_JSON) {
    try {
      rates = JSON.parse(env.RATE_CARD_JSON);
    } catch {
      throw new Error("RATE_CARD_JSON must be valid JSON");
    }
    for (const [kind, fields] of Object.entries({
      ride: ["base", "per_km", "per_minute", "minimum"],
      delivery: ["base", "per_km", "per_kg", "minimum"],
    }))
      for (const field of fields)
        if (
          typeof rates[kind]?.[field] !== "number" ||
          !Number.isFinite(rates[kind][field]) ||
          rates[kind][field] < 0 ||
          rates[kind][field] > 1000000
        )
          throw new Error(`Invalid RATE_CARD_JSON ${kind}.${field}`);
    if (
      !(rates.ride.minimum > 0 && rates.delivery.minimum > 0) ||
      !Number.isFinite(rates.commission_rate) ||
      rates.commission_rate < 0 ||
      rates.commission_rate > 1
    )
      throw new Error("Invalid rate minimum or commission");
    if (
      rates.delivery.cold_chain_multiplier != null &&
      (!Number.isFinite(rates.delivery.cold_chain_multiplier) ||
        rates.delivery.cold_chain_multiplier < 0 ||
        rates.delivery.cold_chain_multiplier > 10)
    )
      throw new Error("Invalid cold chain surcharge");
  } else if (!production) rates = demoRates;
  function requireRates() {
    if (!rates)
      throw unavailable(
        "Local fares are being configured. New bookings are not open yet.",
      );
  }
  function price(p) {
    requireRates();
    const freight = ["freight", "courier", "cold_chain"].includes(
      p.service_type,
    );
    const rate = freight ? rates.delivery : rates.ride;
    const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const km = Math.max(0.5, p.route.distance_km),
      minutes = p.route.duration_minutes;
    const base = rate.base,
      distance =
        km * rate.per_km +
        (freight ? (p.cargo_weight_kg || 0) * rate.per_kg : 0);
    const time = freight ? 0 : minutes * rate.per_minute;
    const needsCold =
      p.service_type === "cold_chain" || p.requires_refrigeration;
    if (needsCold && production && rates.delivery.cold_chain_multiplier == null)
      throw unavailable("Cold-chain fares have not been approved yet.");
    const cold = needsCold
      ? (base + distance + time) *
        (rates.delivery.cold_chain_multiplier ?? 0.35)
      : 0;
    const total = round(Math.max(rate.minimum, base + distance + time + cold));
    return {
      breakdown: {
        base_fare: round(base),
        distance_fare: round(distance),
        time_fare: round(time),
        cold_chain_surcharge: round(cold),
      },
      surge_multiplier: 1,
      surge_reason: null,
      total_fare: total,
      estimated_range: [round(total * 0.9), round(total * 1.1)],
      currency,
      source: "configured_rate_card",
    };
  }
  return {
    country,
    currency,
    timezone: country === "PK" ? "Asia/Karachi" : "UTC",
    rates,
    ready: !!rates,
    requireRates,
    price,
    commission: rates?.commission_rate ?? 0.2,
  };
}
module.exports = { createMarket };
