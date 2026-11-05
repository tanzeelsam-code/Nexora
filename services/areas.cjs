"use strict";
const { z } = require("zod");
const { unavailable } = require("./maps.cjs");
const serviceSchema = z.enum(["ride", "delivery"]);
const areaSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    center_lat: z.number().min(-90).max(90),
    center_lng: z.number().min(-180).max(180),
    radius_km: z.number().positive().max(250),
    status: z.enum(["planned", "active", "paused"]),
    services: z.array(serviceSchema).min(1).max(2),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    opens_minute: z.number().int().min(0).max(1439),
    closes_minute: z.number().int().min(1).max(1440),
  })
  .refine(
    (a) => a.closes_minute > a.opens_minute,
    "Closing time must follow opening time; use separate areas for overnight shifts.",
  );
function contains(area, lat, lng) {
  const rad = (n) => (n * Math.PI) / 180;
  const a =
    Math.sin(rad(lat - area.center_lat) / 2) ** 2 +
    Math.cos(rad(area.center_lat)) *
      Math.cos(rad(lat)) *
      Math.sin(rad(lng - area.center_lng) / 2) ** 2;
  return (
    6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) <=
    Number(area.radius_km)
  );
}
function areaStatus(area, ready, timezone, now = new Date()) {
  if (area.status === "planned") return "not_launched";
  if (area.status === "paused") return "paused";
  if (!ready) return "setup_pending";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.weekday,
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return area.weekdays.includes(day) &&
    minute >= area.opens_minute &&
    minute < area.closes_minute
    ? "open"
    : "closed";
}
function registerAreas({
  app,
  query,
  validate,
  authenticate,
  requireDatabase,
  requireRole,
  auditLog,
  ready,
  timezone,
  required,
}) {
  const staff = [authenticate, requireDatabase, requireRole("admin", "ops")];
  const admin = [authenticate, requireDatabase, requireRole("admin")];
  const read = async () =>
    (await query("SELECT * FROM service_areas ORDER BY name,id")).rows;
  const publicArea = (area) => ({
    ...area,
    availability: areaStatus(area, ready(), timezone),
  });
  app.get("/api/v1/areas", { preHandler: requireDatabase }, async () => ({
    areas: (await read()).map(publicArea),
    timezone,
    checked_at: new Date().toISOString(),
  }));
  app.get(
    "/api/v1/availability",
    {
      preHandler: requireDatabase,
      config: { rateLimit: { max: 60, timeWindow: 60000 } },
    },
    async (req) => {
      const body = validate(
        z.object({ area_id: z.string().uuid(), service: serviceSchema }),
        req.query,
      );
      const area = (await read()).find((a) => a.id === body.area_id);
      if (!area) throw unavailable("Area not found.", 404);
      let status = area.services.includes(body.service)
        ? areaStatus(area, ready(), timezone)
        : "not_launched";
      if (status === "open") {
        const {
          rows: [supply],
        } = await query(
          `SELECT EXISTS(SELECT 1 FROM drivers d JOIN users u ON u.id=d.user_id
        WHERE d.is_online AND d.status='available' AND d.onboarding_completed AND u.is_active AND NOT u.is_banned
        AND d.location_updated_at > NOW()-INTERVAL '2 minutes' AND d.service_types::text[] && $4::text[]
        AND ST_DWithin(d.current_location,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,$3)) AS present`,
          [
            area.center_lat,
            area.center_lng,
            Number(area.radius_km) * 1000,
            body.service === "ride"
              ? ["taxi"]
              : ["freight", "courier", "cold_chain"],
          ],
        );
        status = supply.present ? "available" : "no_drivers";
      }
      return {
        area: publicArea(area),
        service: body.service,
        status,
        timezone,
        checked_at: new Date().toISOString(),
        message:
          "Availability is a snapshot. Your exact route, vehicle requirements and driver acceptance are checked when you book.",
      };
    },
  );
  app.post(
    "/api/v1/area-waitlist",
    {
      preHandler: requireDatabase,
      config: { rateLimit: { max: 5, timeWindow: 3600000 } },
    },
    async (req) => {
      const body = validate(
        z.object({
          locality: z
            .string()
            .trim()
            .min(2)
            .max(100)
            .transform((s) => s.toLowerCase()),
          email: z
            .string()
            .trim()
            .email()
            .max(255)
            .transform((s) => s.toLowerCase()),
          service: serviceSchema,
          consent: z.literal(true),
        }),
        req.body,
      );
      await query(
        "INSERT INTO area_waitlist(locality,email,service) VALUES($1,$2,$3) ON CONFLICT(locality,email,service) DO NOTHING",
        [body.locality, body.email, body.service],
      );
      return {
        message:
          "Your interest is registered. We may email you about availability in this area. This does not reserve a booking.",
      };
    },
  );
  app.get("/api/v1/admin/areas", { preHandler: staff }, async (req) => ({
    areas: (await read()).map(publicArea),
    timezone,
    can_edit: req.user.role === "admin",
    demand: (
      await query(
        "SELECT locality,service,COUNT(*)::integer AS requests FROM area_waitlist GROUP BY locality,service ORDER BY requests DESC,locality LIMIT 100",
      )
    ).rows,
  }));
  app.post("/api/v1/admin/areas", { preHandler: admin }, async (req) => {
    const body = validate(areaSchema, req.body);
    const {
      rows: [area],
    } = await query(
      `INSERT INTO service_areas(name,center_lat,center_lng,radius_km,status,services,weekdays,opens_minute,closes_minute) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      Object.values(body),
    );
    await auditLog(req, "area.create", "service_area", area.id);
    return { area: publicArea(area) };
  });
  app.post("/api/v1/admin/areas/:id", { preHandler: admin }, async (req) => {
    const id = validate(z.string().uuid(), req.params.id),
      body = validate(areaSchema, req.body);
    const {
      rows: [area],
    } = await query(
      `UPDATE service_areas SET name=$1,center_lat=$2,center_lng=$3,radius_km=$4,status=$5,services=$6,weekdays=$7,opens_minute=$8,closes_minute=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,
      [...Object.values(body), id],
    );
    if (!area) throw unavailable("Area not found.", 404);
    await auditLog(req, "area.update", "service_area", id);
    return { area: publicArea(area) };
  });
  async function assertRoute(body, service) {
    if (!required) return;
    const matching = (await read()).filter(
      (a) =>
        a.services.includes(service) &&
        contains(a, body.pickup_lat, body.pickup_lng) &&
        contains(a, body.dropoff_lat, body.dropoff_lng),
    );
    if (!matching.length)
      throw unavailable(
        "Both stops must be inside a configured service area. Check area availability before booking.",
        409,
      );
    if (!matching.some((a) => areaStatus(a, ready(), timezone) === "open"))
      throw unavailable(
        "This service area is not open for bookings now. Check its availability and opening hours.",
        409,
      );
  }
  return {
    assertRoute,
    hasActiveArea: async () =>
      (await read()).some((a) => areaStatus(a, ready(), timezone) === "open"),
  };
}
module.exports = { registerAreas, areaStatus, contains };
