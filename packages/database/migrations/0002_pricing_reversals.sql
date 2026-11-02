CREATE TABLE fagoo.price_rule (
  company_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL,
  product_id uuid NOT NULL, contact_id uuid, payment_terms text,
  unit_price numeric(24,10) NOT NULL CHECK(unit_price>=0),
  minimum_quantity numeric(18,6) NOT NULL DEFAULT 1 CHECK(minimum_quantity>0),
  valid_from date, valid_until date, priority integer NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 1000),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES fagoo.product(company_id,id),
  FOREIGN KEY(company_id,contact_id) REFERENCES fagoo.contact(company_id,id),
  CHECK(valid_from IS NULL OR valid_until IS NULL OR valid_from<=valid_until)
);
CREATE INDEX price_rule_product ON fagoo.price_rule(company_id,product_id,active);
ALTER TABLE fagoo.order_item ADD COLUMN price_rule_id uuid;
ALTER TABLE fagoo.order_item ADD COLUMN price_rule_version integer;
ALTER TABLE fagoo.order_item ADD FOREIGN KEY(company_id,price_rule_id) REFERENCES fagoo.price_rule(company_id,id);
ALTER TABLE fagoo.receipt ADD COLUMN reversed_at timestamptz;
ALTER TABLE fagoo.receipt ADD COLUMN reversal_reason text;
ALTER TABLE fagoo.finance_posting ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','reversed'));
ALTER TABLE fagoo.finance_posting ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE fagoo.finance_posting ADD COLUMN reversed_at timestamptz;
ALTER TABLE fagoo.finance_posting ADD COLUMN reversal_reason text;
ALTER TABLE fagoo.finance_posting DROP CONSTRAINT finance_posting_company_id_order_id_key;
CREATE UNIQUE INDEX finance_posting_one_active ON fagoo.finance_posting(company_id,order_id) WHERE status='active';
