const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMarket } = require("../services/market.cjs");
test("production Pakistan fares require an explicitly approved rate card", () => {
  const market = createMarket({ NODE_ENV: "production" });
  assert.equal(market.currency, "PKR");
  assert.equal(market.country, "PK");
  assert.equal(market.ready, false);
  assert.throws(() => market.requireRates(), /configured/);
});
test("configured fare calculation applies currency, minimum, weight and commission without conversion", () => {
  const rates = {
    ride: { base: 100, per_km: 50, per_minute: 5, minimum: 200 },
    delivery: { base: 150, per_km: 60, per_kg: 10, minimum: 250 },
    commission_rate: 0.15,
  };
  const market = createMarket({
    NODE_ENV: "production",
    RATE_CARD_JSON: JSON.stringify(rates),
  });
  assert.equal(
    market.price({ route: { distance_km: 4, duration_minutes: 10 } })
      .total_fare,
    350,
  );
  assert.equal(
    market.price({
      service_type: "freight",
      cargo_weight_kg: 2,
      route: { distance_km: 4, duration_minutes: 10 },
    }).total_fare,
    410,
  );
  assert.equal(market.commission, 0.15);
  assert.equal(market.currency, "PKR");
  assert.throws(() =>
    createMarket({
      RATE_CARD_JSON: JSON.stringify({ ...rates, commission_rate: 2 }),
    }),
  );
  assert.throws(() =>
    createMarket({
      RATE_CARD_JSON: JSON.stringify({
        ...rates,
        ride: { ...rates.ride, per_km: -1 },
      }),
    }),
  );
});
