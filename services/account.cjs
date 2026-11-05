"use strict";
const { z } = require("zod");
const crypto = require("node:crypto");
const { unavailable } = require("./maps.cjs");

async function removeLocations(client, userId, driverId) {
  const filter =
    "(trip_id IN (SELECT id FROM trips WHERE customer_id=$1) OR driver_id=$2)";
  const {
    rows: [range],
  } = await client.query(
    `SELECT MIN(time) AS first,MAX(time) AS last FROM driver_locations WHERE ${filter}`,
    [userId, driverId],
  );
  if (!range.first) return;
  // Legacy Timescale installations cannot delete compressed rows. Decompress only
  // affected time partitions; the hosted Postgres schema uses ordinary tables.
  const { rowCount: timescale } = await client.query(
    "SELECT 1 FROM pg_extension WHERE extname='timescaledb'",
  );
  if (timescale)
    await client.query(
      `SELECT decompress_chunk(format('%I.%I',chunk_schema,chunk_name)::regclass,true)
    FROM timescaledb_information.chunks WHERE hypertable_name='driver_locations' AND is_compressed
    AND range_start <= $2 AND range_end > $1`,
      [range.first, range.last],
    );
  await client.query(
    `DELETE FROM driver_locations WHERE time >= $3 AND time <= $4 AND ${filter}`,
    [userId, driverId, range.first, range.last],
  );
}

function registerAccount({
  app,
  query,
  transaction,
  bcrypt,
  validate,
  authenticate,
  requireDatabase,
  onDeleted,
}) {
  app.post(
    "/api/v1/account/delete",
    {
      preHandler: [authenticate, requireDatabase],
      config: { rateLimit: { max: 5, timeWindow: 900000 } },
    },
    async (req) => {
      const body = validate(
        z.object({
          password: z.string().min(1).max(72),
          confirm: z.literal("DELETE"),
        }),
        req.body,
      );
      if (!["customer", "driver"].includes(req.user.role))
        throw unavailable(
          "Workspace accounts must be removed by the business owner. Contact support.",
          403,
        );
      const {
        rows: [candidate],
      } = await query(
        "SELECT id,password_hash FROM users WHERE id=$1 AND is_active",
        [req.user.id],
      );
      if (
        !candidate ||
        !(await bcrypt.compare(body.password, candidate.password_hash))
      )
        throw unavailable(
          "Confirm your current password to delete this account.",
          403,
        );
      // Bcrypt happens before acquiring locks. The account row serializes deletion and new bookings.
      const replacement = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        12,
      );
      await transaction(async (client) => {
        const {
          rows: [user],
        } = await client.query(
          "SELECT id,password_hash,is_active FROM users WHERE id=$1 FOR UPDATE",
          [req.user.id],
        );
        if (!user?.is_active || user.password_hash !== candidate.password_hash)
          throw unavailable("Your account changed. Sign in again.", 409);
        const {
          rows: [driver],
        } = await client.query(
          "SELECT id,status FROM drivers WHERE user_id=$1 FOR UPDATE",
          [user.id],
        );
        const {
          rows: [active],
        } = await client.query(
          `SELECT
        EXISTS(SELECT 1 FROM trips WHERE (customer_id=$1 OR driver_id=$2) AND status IN ('requested','searching','accepted','driver_en_route','arrived','in_progress'))
        OR EXISTS(SELECT 1 FROM deliveries WHERE (customer_id=$1 OR driver_id=$2) AND status IN ('pending','pickup_scheduled','picked_up','in_transit','out_for_delivery')) AS present`,
          [user.id, driver?.id || null],
        );
        if (active.present || driver?.status === "on_trip")
          throw unavailable(
            "Finish or cancel your active jobs before deletion. Email support if you need help completing your deletion request.",
            409,
          );
        const {
          rows: [financial],
        } = await client.query(
          `SELECT
        EXISTS(SELECT 1 FROM trips WHERE customer_id=$1 AND payment_method='card' AND payment_status IN ('pending','authorized','disputed'))
        OR EXISTS(SELECT 1 FROM driver_settlements WHERE driver_id=$2 AND transferred_at IS NULL)
        OR EXISTS(SELECT 1 FROM deliveries WHERE (customer_id=$1 OR driver_id=$2) AND cod_collected_at IS NOT NULL AND cod_settled_at IS NULL) AS pending`,
          [user.id, driver?.id || null],
        );
        if (financial.pending)
          throw unavailable(
            "A payment or settlement still needs resolution. Contact support to complete your deletion request.",
            409,
          );
        await client.query("DELETE FROM push_subscriptions WHERE user_id=$1", [
          user.id,
        ]);
        await client.query("DELETE FROM merchant_profiles WHERE user_id=$1",[user.id]);
        await client.query("DELETE FROM area_waitlist WHERE email=(SELECT lower(email) FROM users WHERE id=$1)",[user.id]);
        await client.query("DELETE FROM notifications WHERE user_id=$1", [
          user.id,
        ]);
        await removeLocations(client, user.id, driver?.id || null);
        await client.query(
          `UPDATE trips SET pickup_address='Address removed',dropoff_address='Address removed',
        pickup_lat=0,pickup_lng=0,dropoff_lat=0,dropoff_lng=0,pickup_place_id=NULL,dropoff_place_id=NULL,
        stops=NULL,route_geometry=NULL,ai_route_polyline=NULL,actual_route_polyline=NULL,ai_alternative_routes=NULL,
        pickup_otp=NULL,customer_review=NULL,cancellation_reason=NULL WHERE customer_id=$1`,
          [user.id],
        );
        await client.query(
          `UPDATE deliveries SET pickup_address='Address removed',dropoff_address='Address removed',
        pickup_lat=0,pickup_lng=0,dropoff_lat=0,dropoff_lng=0,current_lat=NULL,current_lng=NULL,
        pickup_contact_name=NULL,pickup_contact_phone=NULL,dropoff_contact_name=NULL,dropoff_contact_phone=NULL,
        pickup_notes=NULL,dropoff_notes=NULL,pickup_otp=NULL,dropoff_otp=NULL,pickup_signature_url=NULL,
        pickup_photo_url=NULL,dropoff_signature_url=NULL,dropoff_photo_url=NULL,dropoff_recipient_name=NULL,
        cargo_description='Removed',tracking_url=NULL,customer_review=NULL,request_fingerprint=NULL,merchant_order_ref=NULL
        WHERE customer_id=$1`,
          [user.id],
        );
        await client.query(
          `UPDATE payments SET card_last4=NULL,card_brand=NULL,card_exp_month=NULL,card_exp_year=NULL,
        ip_address=NULL,device_fingerprint=NULL,gateway_response=NULL WHERE customer_id=$1`,
          [user.id],
        );
        if (driver) {
          await client.query(
            "DELETE FROM driver_documents WHERE driver_id=$1",
            [driver.id],
          );
          await client.query(
            `UPDATE vehicles SET is_active=FALSE,plate_number='Removed',vin=NULL,photos=NULL,
          insurance_policy=NULL,iot_device_id=NULL,dashcam_device_id=NULL WHERE driver_id=$1`,
            [driver.id],
          );
          await client.query(
            `UPDATE drivers SET status='offline',is_online=FALSE,onboarding_completed=FALSE,
          current_location=NULL,current_heading=NULL,current_speed_kmh=NULL,location_updated_at=NULL,
          bank_account_number=NULL,bank_routing_number=NULL,background_check_ref=NULL,preferred_areas=NULL,work_schedule=NULL
          WHERE id=$1`,
            [driver.id],
          );
        }
        await client.query(
          `UPDATE audit_logs SET ip_address=NULL,user_agent=NULL,old_values=NULL,new_values=NULL WHERE actor_id=$1`,
          [user.id],
        );
        await client.query(
          `UPDATE safety_incidents SET description='Personal details removed',resolution_note=NULL,
        incident_lat=NULL,incident_lng=NULL,incident_address=NULL WHERE customer_id=$1 AND type LIKE 'support_%'`,
          [user.id],
        );
        await client.query(
          "DELETE FROM background_jobs WHERE kind='push' AND payload->>'user_id'=$1",
          [user.id],
        );
        const {
          rows: [privateSchema],
        } = await client.query(
          "SELECT to_regclass('nexora_private.events') AS events,to_regclass('nexora_private.runtime_kv') AS kv",
        );
        if (privateSchema.events)
          await client.query(
            `DELETE FROM nexora_private.events WHERE audience=ANY($1::text[])
        OR payload->>'customer_id'=$2 OR payload->>'user_id'=$2 OR payload->>'driver_id'=$3`,
            [
              [`user:${user.id}`, `driver:${driver?.id || ""}`],
              user.id,
              driver?.id || null,
            ],
          );
        if (privateSchema.kv)
          await client.query(
            "DELETE FROM nexora_private.runtime_kv WHERE key LIKE $1",
            [`idem:${user.id}:%`],
          );
        await client.query(
          `UPDATE users SET is_active=FALSE,deleted_at=NOW(),auth_version=auth_version+1,
        email=$2,phone=$3,first_name='Deleted',last_name='account',display_name=NULL,external_id=NULL,
        password_hash=$4,salt='',recovery_code_hash=NULL,mfa_secret=NULL,avatar_url=NULL,date_of_birth=NULL,gender=NULL,
        default_home_lat=NULL,default_home_lng=NULL,default_work_lat=NULL,default_work_lng=NULL,
        referral_code=NULL,referred_by=NULL,last_login_ip=NULL,notifications_enabled='{}'::jsonb
        WHERE id=$1`,
          [
            user.id,
            `deleted-${user.id}@account.invalid`,
            crypto.randomBytes(10).toString("hex"),
            replacement,
          ],
        );
      });
      await onDeleted(req.user.id);
      return {
        deleted: true,
        message:
          "Your account and profile have been removed. Sessions are revoked. Limited transaction and security records are retained as described in the privacy notice.",
      };
    },
  );
}
module.exports = { registerAccount };
