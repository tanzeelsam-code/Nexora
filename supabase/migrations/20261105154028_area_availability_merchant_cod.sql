-- No service areas are seeded: coverage must be explicitly configured by the operator.
CREATE TABLE IF NOT EXISTS public.service_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  center_lat double precision NOT NULL CHECK(center_lat BETWEEN -90 AND 90),
  center_lng double precision NOT NULL CHECK(center_lng BETWEEN -180 AND 180),
  radius_km numeric(6,2) NOT NULL CHECK(radius_km > 0 AND radius_km <= 250),
  status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','paused')),
  services text[] NOT NULL DEFAULT ARRAY['ride','delivery'] CHECK(cardinality(services)>0 AND services <@ ARRAY['ride','delivery']),
  weekdays integer[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6] CHECK(cardinality(weekdays)>0 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]),
  opens_minute integer NOT NULL DEFAULT 0 CHECK(opens_minute BETWEEN 0 AND 1439),
  closes_minute integer NOT NULL DEFAULT 1440 CHECK(closes_minute BETWEEN 1 AND 1440 AND closes_minute > opens_minute),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.area_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locality varchar(100) NOT NULL,
  email varchar(255) NOT NULL,
  service text NOT NULL CHECK(service IN ('ride','delivery')),
  consent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(locality,email,service)
);
CREATE TABLE IF NOT EXISTS public.merchant_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id),
  business_name varchar(150) NOT NULL,
  pickup_address varchar(500),
  pickup_lat double precision CHECK(pickup_lat BETWEEN -90 AND 90),
  pickup_lng double precision CHECK(pickup_lng BETWEEN -180 AND 180),
  pickup_contact_name varchar(100),
  pickup_contact_phone varchar(20),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((pickup_address IS NULL AND pickup_lat IS NULL AND pickup_lng IS NULL AND pickup_contact_name IS NULL AND pickup_contact_phone IS NULL)
    OR (pickup_address IS NOT NULL AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL AND pickup_contact_name IS NOT NULL AND pickup_contact_phone IS NOT NULL))
);
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS merchant_order_ref varchar(80);
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS cod_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK(cod_amount >= 0 AND cod_amount <= 1000000);
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS cod_collected_at timestamptz;
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS cod_received_at timestamptz;
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS cod_settled_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_merchant_order_unique ON public.deliveries(customer_id,merchant_order_ref) WHERE merchant_order_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS deliveries_cod_pending ON public.deliveries(requested_at DESC) WHERE cod_amount > 0 AND cod_settled_at IS NULL;
CREATE TABLE IF NOT EXISTS public.cod_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES public.deliveries(id),
  kind text NOT NULL CHECK(kind IN ('collected','received','settled')),
  amount numeric(12,2) NOT NULL CHECK(amount > 0),
  currency varchar(3) NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.users(id),
  reference varchar(150),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delivery_id,kind)
);
CREATE INDEX IF NOT EXISTS cod_events_actor ON public.cod_events(actor_id);
-- Access remains through the application's authenticated API and its scoped server role.
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['service_areas','area_waitlist','merchant_profiles','cod_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',relation);
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon,authenticated',relation);
    END IF;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='nexora_backend') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO nexora_backend',relation);
      IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=relation AND policyname='nexora_server') THEN
        EXECUTE format('CREATE POLICY nexora_server ON public.%I TO nexora_backend USING(true) WITH CHECK(true)',relation);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='nexora_backend') THEN
    REVOKE UPDATE,DELETE ON public.cod_events FROM nexora_backend;
  END IF;
END $$;
