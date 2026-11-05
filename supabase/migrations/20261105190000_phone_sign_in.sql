-- Phone sign-in with SMS verification codes. Additive: email and password sign-in keep working.
-- Accounts created by phone verification have no email address, so email becomes optional.
-- UNIQUE still applies to every address that is present.
ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

-- One row per code sent. Only an HMAC of the code is stored; rows expire after five minutes
-- and are consumed exactly once.
CREATE TABLE IF NOT EXISTS public.phone_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone varchar(20) NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('sign_in','verify_phone','delete_account')),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  ip inet,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_verifications_phone ON public.phone_verifications(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_verifications_ip ON public.phone_verifications(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_verifications_user ON public.phone_verifications(user_id);
-- Sign-in looks a number up by its digits, whichever way it was originally typed.
CREATE INDEX IF NOT EXISTS users_phone_digits ON public.users(regexp_replace(phone,'[^0-9+]','','g'));

-- Access remains through the application's authenticated API and its scoped server role.
DO $$
BEGIN
  ALTER TABLE public.phone_verifications ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.phone_verifications FROM PUBLIC;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.phone_verifications FROM anon,authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='nexora_backend') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.phone_verifications TO nexora_backend;
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='phone_verifications' AND policyname='nexora_server') THEN
      CREATE POLICY nexora_server ON public.phone_verifications TO nexora_backend USING(true) WITH CHECK(true);
    END IF;
  END IF;
END $$;
