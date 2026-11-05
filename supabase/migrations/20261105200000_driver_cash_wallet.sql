-- Driver cash wallet. On cash rides and deliveries the driver keeps the whole fare, so the
-- platform commission becomes a balance the driver owes. Drivers pay it by Easypaisa, JazzCash,
-- bank transfer or at an office; operations confirm each payment against their own statement.
-- Nexora records these payments; it does not move money. The ledger starts empty: commission on
-- cash jobs completed before this migration stays with the operator's existing manual records.

CREATE TABLE IF NOT EXISTS public.driver_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  method text NOT NULL CHECK(method IN ('easypaisa','jazzcash','bank_transfer','cash_office')),
  reference varchar(60) NOT NULL CHECK(length(trim(reference)) >= 4),
  amount numeric(12,2) NOT NULL CHECK(amount > 0 AND amount <= 1000000),
  currency varchar(3) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
  submitted_by uuid NOT NULL REFERENCES public.users(id),
  reviewed_by uuid REFERENCES public.users(id),
  reviewed_at timestamptz,
  review_note varchar(300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status = 'pending') = (reviewed_at IS NULL))
);
-- One transaction reference can back only one live payment claim.
CREATE UNIQUE INDEX IF NOT EXISTS driver_remittances_reference ON public.driver_remittances(method, lower(reference)) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS driver_remittances_driver ON public.driver_remittances(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS driver_remittances_pending ON public.driver_remittances(created_at) WHERE status = 'pending';

-- Append-only. Positive amounts increase what the driver owes; negative amounts reduce it.
CREATE TABLE IF NOT EXISTS public.driver_cash_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  kind text NOT NULL CHECK(kind IN ('commission','remittance','adjustment')),
  amount numeric(12,2) NOT NULL CHECK(amount <> 0 AND abs(amount) <= 1000000),
  currency varchar(3) NOT NULL,
  trip_id uuid REFERENCES public.trips(id),
  delivery_id uuid REFERENCES public.deliveries(id),
  remittance_id uuid REFERENCES public.driver_remittances(id),
  note varchar(300),
  actor_id uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(
    (kind = 'commission' AND amount > 0 AND (trip_id IS NOT NULL) <> (delivery_id IS NOT NULL) AND remittance_id IS NULL)
    OR (kind = 'remittance' AND amount < 0 AND remittance_id IS NOT NULL AND trip_id IS NULL AND delivery_id IS NULL)
    OR (kind = 'adjustment' AND note IS NOT NULL AND actor_id IS NOT NULL AND trip_id IS NULL AND delivery_id IS NULL AND remittance_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_cash_ledger_trip ON public.driver_cash_ledger(trip_id) WHERE kind = 'commission';
CREATE UNIQUE INDEX IF NOT EXISTS driver_cash_ledger_delivery ON public.driver_cash_ledger(delivery_id) WHERE kind = 'commission';
CREATE UNIQUE INDEX IF NOT EXISTS driver_cash_ledger_remittance ON public.driver_cash_ledger(remittance_id) WHERE remittance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS driver_cash_ledger_driver ON public.driver_cash_ledger(driver_id, currency);
CREATE INDEX IF NOT EXISTS driver_cash_ledger_actor ON public.driver_cash_ledger(actor_id);

-- Access remains through the application's authenticated API and its scoped server role.
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['driver_remittances','driver_cash_ledger'] LOOP
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
    REVOKE UPDATE,DELETE ON public.driver_cash_ledger FROM nexora_backend;
    REVOKE DELETE ON public.driver_remittances FROM nexora_backend;
  END IF;
END $$;
