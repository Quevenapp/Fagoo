ALTER TABLE fagoo.company ADD COLUMN document text CHECK(document~'^[A-Z0-9]{12}[0-9]{2}$');
ALTER TABLE fagoo.company ADD COLUMN fiscal_version integer NOT NULL DEFAULT 1;
ALTER TABLE fagoo.received_invoice DROP CONSTRAINT received_invoice_access_key_check;
ALTER TABLE fagoo.received_invoice ADD CHECK(access_key~'^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$');
ALTER TABLE fagoo.received_invoice ADD COLUMN normalized jsonb NOT NULL DEFAULT '{}';
ALTER TABLE fagoo.received_invoice ADD COLUMN validation jsonb NOT NULL DEFAULT '{"signature_verified":false,"tax_rules_validated":false,"sefaz_checked":false}';
ALTER TABLE fagoo.received_invoice ADD COLUMN imported_by text;
