-- Applied explicitly after the pinned database and service initialization.
-- The trusted schema owner manages the original policies on real service tables.
-- Application roles never inherit these owner memberships.
GRANT supabase_storage_admin TO postgres WITH INHERIT TRUE;
GRANT supabase_auth_admin TO postgres WITH INHERIT TRUE;
