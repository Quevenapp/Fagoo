CREATE SCHEMA IF NOT EXISTS fagoo;

CREATE TABLE IF NOT EXISTS fagoo.company (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  tax_regime text NOT NULL DEFAULT 'unconfigured',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fagoo.warehouse (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), id uuid NOT NULL,
  name text NOT NULL, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(company_id,id)
);
CREATE TABLE fagoo.contact (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), id uuid NOT NULL,
  name text NOT NULL, kind text NOT NULL CHECK(kind IN ('customer','supplier','both')),
  document text, payment_terms text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id)
);
CREATE TABLE fagoo.product (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL, unit text NOT NULL DEFAULT 'UN', gtin text, ncm text,
  sale_price numeric(24,10) NOT NULL DEFAULT 0 CHECK(sale_price>=0),
  cost_price numeric(24,10) NOT NULL DEFAULT 0 CHECK(cost_price>=0),
  stock_min numeric(18,6) NOT NULL DEFAULT 0 CHECK(stock_min>=0),
  stock_max numeric(18,6) NOT NULL DEFAULT 0 CHECK(stock_max>=stock_min),
  lead_days integer CHECK(lead_days BETWEEN 0 AND 3650),
  pack_quantity numeric(18,6) NOT NULL DEFAULT 1 CHECK(pack_quantity>0),
  version integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,code)
);
CREATE TABLE fagoo.product_supplier (
  company_id uuid NOT NULL, product_id uuid NOT NULL, supplier_id uuid NOT NULL,
  code text, description text, unit_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK(unit_factor>0),
  price numeric(24,10) CHECK(price>=0), lead_days integer CHECK(lead_days BETWEEN 0 AND 3650),
  PRIMARY KEY(company_id,product_id,supplier_id),
  FOREIGN KEY(company_id,product_id) REFERENCES fagoo.product(company_id,id),
  FOREIGN KEY(company_id,supplier_id) REFERENCES fagoo.contact(company_id,id)
);
CREATE TABLE fagoo.stock_balance (
  company_id uuid NOT NULL, warehouse_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK(quantity>=0),
  reserved numeric(18,6) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=quantity),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY(company_id,warehouse_id,product_id),
  FOREIGN KEY(company_id,warehouse_id) REFERENCES fagoo.warehouse(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES fagoo.product(company_id,id)
);
CREATE TABLE fagoo.orders (
  company_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('sale','purchase')),
  contact_id uuid NOT NULL, warehouse_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','partial','completed','cancelled')),
  total numeric(16,2) NOT NULL CHECK(total>=0), payment_terms text,
  expected_on date, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz, completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,contact_id) REFERENCES fagoo.contact(company_id,id),
  FOREIGN KEY(company_id,warehouse_id) REFERENCES fagoo.warehouse(company_id,id)
);
CREATE TABLE fagoo.order_item (
  company_id uuid NOT NULL, order_id uuid NOT NULL, id uuid NOT NULL, position integer NOT NULL,
  product_id uuid NOT NULL, description text NOT NULL, code text NOT NULL, unit text NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK(quantity>0),
  unit_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK(unit_factor>0),
  unit_price numeric(24,10) NOT NULL CHECK(unit_price>=0),
  total numeric(16,2) NOT NULL CHECK(total>=0),
  received numeric(18,6) NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=quantity),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,order_id,position),
  FOREIGN KEY(company_id,order_id) REFERENCES fagoo.orders(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES fagoo.product(company_id,id)
);
CREATE TABLE fagoo.receipt (
  company_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), FOREIGN KEY(company_id,order_id) REFERENCES fagoo.orders(company_id,id)
);
CREATE TABLE fagoo.receipt_item (
  company_id uuid NOT NULL, receipt_id uuid NOT NULL, order_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK(quantity>0), base_quantity numeric(18,6) NOT NULL CHECK(base_quantity>0),
  PRIMARY KEY(company_id,receipt_id,order_item_id),
  FOREIGN KEY(company_id,receipt_id) REFERENCES fagoo.receipt(company_id,id),
  FOREIGN KEY(company_id,order_item_id) REFERENCES fagoo.order_item(company_id,id)
);
CREATE TABLE fagoo.stock_movement (
  company_id uuid NOT NULL, id uuid NOT NULL, warehouse_id uuid NOT NULL, product_id uuid NOT NULL,
  delta numeric(18,6) NOT NULL CHECK(delta<>0), kind text NOT NULL,
  reference_id uuid, actor_id text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,warehouse_id) REFERENCES fagoo.warehouse(company_id,id),
  FOREIGN KEY(company_id,product_id) REFERENCES fagoo.product(company_id,id)
);
CREATE TABLE fagoo.finance_posting (
  company_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('payable','receivable')), total numeric(16,2) NOT NULL CHECK(total>0),
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,order_id),
  FOREIGN KEY(company_id,order_id) REFERENCES fagoo.orders(company_id,id)
);
CREATE TABLE fagoo.finance_title (
  company_id uuid NOT NULL, id uuid NOT NULL, posting_id uuid NOT NULL, installment integer NOT NULL,
  due_on date NOT NULL, amount numeric(16,2) NOT NULL CHECK(amount>0),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
  payment_reference text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,posting_id,installment),
  FOREIGN KEY(company_id,posting_id) REFERENCES fagoo.finance_posting(company_id,id)
);
CREATE TABLE fagoo.received_invoice (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), id uuid NOT NULL,
  access_key text NOT NULL CHECK(access_key~'^[0-9]{44}$'), supplier_document text NOT NULL,
  number text NOT NULL, issued_on date NOT NULL, total numeric(16,2) NOT NULL CHECK(total>=0),
  document_state text NOT NULL CHECK(document_state IN ('summary','xml_available','cancelled')),
  xml_sha256 text CHECK(xml_sha256~'^[a-f0-9]{64}$'), object_key text,
  tax_review text NOT NULL DEFAULT 'pending' CHECK(tax_review IN ('pending','reviewed','unsupported')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id), UNIQUE(company_id,access_key)
);
CREATE TABLE fagoo.command (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), id uuid NOT NULL,
  actor_id text NOT NULL, action text NOT NULL, request_hash text NOT NULL, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id)
);
CREATE TABLE fagoo.event (
  sequence bigserial PRIMARY KEY, company_id uuid NOT NULL REFERENCES fagoo.company(id),
  type text NOT NULL, resource_id uuid, payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fagoo.event_ack (
  company_id uuid NOT NULL REFERENCES fagoo.company(id), consumer_id text NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,consumer_id)
);
CREATE TABLE fagoo.audit (
  id bigserial PRIMARY KEY, company_id uuid NOT NULL REFERENCES fagoo.company(id),
  actor_id text NOT NULL, command_id uuid NOT NULL, action text NOT NULL, resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_sales_history ON fagoo.orders(company_id,kind,status,confirmed_at,contact_id);
CREATE INDEX item_product_history ON fagoo.order_item(company_id,product_id,order_id);
CREATE INDEX event_company_sequence ON fagoo.event(company_id,sequence);
CREATE INDEX movement_product ON fagoo.stock_movement(company_id,product_id,created_at);
