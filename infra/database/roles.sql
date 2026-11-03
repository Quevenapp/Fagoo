-- Official runtime roles already exist in the pinned database image.
-- Credentials are provided at first volume initialization, never in source control.
\getenv fagoo_db_password POSTGRES_PASSWORD
ALTER ROLE authenticator WITH PASSWORD :'fagoo_db_password';
ALTER ROLE supabase_auth_admin WITH PASSWORD :'fagoo_db_password';
ALTER ROLE supabase_storage_admin WITH PASSWORD :'fagoo_db_password';
