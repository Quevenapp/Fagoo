CREATE TABLE IF NOT EXISTS fagoo.installation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fagoo.installation ADD COLUMN IF NOT EXISTS mobile_client_id text;
CREATE TABLE IF NOT EXISTS fagoo.member (
 user_id text PRIMARY KEY, company_id uuid NOT NULL REFERENCES fagoo.company(id),
 role text NOT NULL CHECK(role IN ('admin','operator')), scopes jsonb NOT NULL DEFAULT '[]',
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fagoo.integration (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES fagoo.company(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), token_hash text NOT NULL UNIQUE,
 scopes jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS fagoo.security_audit (
 id bigserial PRIMARY KEY, company_id uuid REFERENCES fagoo.company(id), actor_id text NOT NULL,
 action text NOT NULL, target text, created_at timestamptz NOT NULL DEFAULT now()
);
