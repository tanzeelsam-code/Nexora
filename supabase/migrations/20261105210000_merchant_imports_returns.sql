-- Merchant desk phase 2: imported order drafts and return pickups. Additive.

-- Orders imported from a spreadsheet wait here until the merchant books each one through the
-- normal quote and coverage checks. A draft counts as booked once a delivery carries its
-- order reference, so there is no second status to keep in step.
CREATE TABLE IF NOT EXISTS public.merchant_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  order_ref varchar(80) NOT NULL,
  recipient_name varchar(100) NOT NULL,
  recipient_phone varchar(20) NOT NULL,
  address varchar(500) NOT NULL,
  lat double precision CHECK(lat BETWEEN -90 AND 90),
  lng double precision CHECK(lng BETWEEN -180 AND 180),
  cod_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK(cod_amount >= 0 AND cod_amount <= 1000000),
  cargo_description varchar(500) NOT NULL,
  cargo_weight_kg numeric(8,2) NOT NULL CHECK(cargo_weight_kg > 0 AND cargo_weight_kg <= 10000),
  is_fragile boolean NOT NULL DEFAULT false,
  discarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, order_ref),
  CHECK((lat IS NULL) = (lng IS NULL))
);

-- A return pickup carries the parcel from the original recipient back to the sender.
-- At most one live return per delivery; a cancelled return can be booked again.
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS return_of_delivery_id uuid REFERENCES public.deliveries(id);
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_one_return ON public.deliveries(return_of_delivery_id)
  WHERE return_of_delivery_id IS NOT NULL AND status <> 'cancelled';

-- Access remains through the application's authenticated API and its scoped server role.
DO $$
BEGIN
  ALTER TABLE public.merchant_order_drafts ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.merchant_order_drafts FROM PUBLIC;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.merchant_order_drafts FROM anon,authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='nexora_backend') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.merchant_order_drafts TO nexora_backend;
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='merchant_order_drafts' AND policyname='nexora_server') THEN
      CREATE POLICY nexora_server ON public.merchant_order_drafts TO nexora_backend USING(true) WITH CHECK(true);
    END IF;
  END IF;
END $$;
