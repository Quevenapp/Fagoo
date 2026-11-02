CREATE TABLE IF NOT EXISTS fagoo.webhook_subscription (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES fagoo.company(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), url text NOT NULL,
 event_types text[] NOT NULL, secret_ciphertext text NOT NULL,
 start_sequence bigint NOT NULL CHECK(start_sequence>=0), active boolean NOT NULL DEFAULT true,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_scanned_at timestamptz
);
CREATE TABLE IF NOT EXISTS fagoo.webhook_delivery (
 id uuid PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES fagoo.webhook_subscription(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES fagoo.company(id) ON DELETE CASCADE,
 event_sequence bigint NOT NULL REFERENCES fagoo.event(sequence) ON DELETE CASCADE, body jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','delivered','dead','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, last_status integer, last_error text,
 delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(subscription_id,event_sequence)
);
CREATE INDEX IF NOT EXISTS webhook_subscription_company ON fagoo.webhook_subscription(company_id,created_at);
CREATE INDEX IF NOT EXISTS webhook_pending ON fagoo.webhook_delivery(state,available_at,lease_until);
