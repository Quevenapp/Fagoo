CREATE TABLE fagoo.cnab_profile (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), id uuid NOT NULL,
  name text NOT NULL, account_scope text NOT NULL, configuration jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending_homologation' CHECK(status='pending_homologation'),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,account_scope)
);
