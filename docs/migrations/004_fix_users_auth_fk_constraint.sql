-- MIGRATION 4: Remove strict FK from public.users.user_id -> auth.users.id
-- This enables admin/import-created users before an auth account exists.

BEGIN;

-- Older environments may use either constraint name.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_auth_user_id_fk,
  DROP CONSTRAINT IF EXISTS users_user_id_fkey;

COMMIT;
