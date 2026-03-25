-- MIGRATION 3: Allow admin-created users without auth account
-- and reuse existing public.users UUID when the same email signs up in auth.

BEGIN;

-- 1) Admin-created users must be allowed without a matching auth.users row.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_user_id_fkey;

-- 2) Keep email matching deterministic for signup linking.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx
  ON public.users (lower(email));

-- 3) Before inserting into auth.users, if a public.users row already exists for the
--    same email, force auth.users.id to reuse that existing UUID.
CREATE OR REPLACE FUNCTION public.reuse_public_user_uuid_on_auth_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  normalized_email text;
  existing_user_id uuid;
BEGIN
  normalized_email := lower(trim(coalesce(NEW.email, '')));
  IF normalized_email = '' THEN
    RETURN NEW;
  END IF;

  SELECT u.user_id
    INTO existing_user_id
  FROM public.users u
  WHERE lower(u.email) = normalized_email
  LIMIT 1;

  IF existing_user_id IS NOT NULL THEN
    NEW.id := existing_user_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reuse_public_user_uuid_on_auth_signup ON auth.users;
CREATE TRIGGER trg_reuse_public_user_uuid_on_auth_signup
BEFORE INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.reuse_public_user_uuid_on_auth_signup();

-- 4) Ensure a public.users row exists/updated after auth signup.
CREATE OR REPLACE FUNCTION public.sync_public_user_after_auth_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  normalized_email text;
  display_name text;
BEGIN
  normalized_email := lower(trim(coalesce(NEW.email, '')));
  display_name := trim(coalesce(NEW.raw_user_meta_data->>'name', ''));

  IF display_name = '' THEN
    display_name := split_part(normalized_email, '@', 1);
  END IF;

  IF normalized_email = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.users (user_id, email, name)
  VALUES (NEW.id, normalized_email, display_name)
  ON CONFLICT (user_id) DO UPDATE
  SET
    email = EXCLUDED.email,
    name = COALESCE(NULLIF(public.users.name, ''), EXCLUDED.name),
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_public_user_after_auth_signup ON auth.users;
CREATE TRIGGER trg_sync_public_user_after_auth_signup
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.sync_public_user_after_auth_signup();

COMMIT;
