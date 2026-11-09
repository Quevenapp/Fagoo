ALTER TABLE conversations ADD COLUMN department_id TEXT;
ALTER TABLE conversations ADD COLUMN menu_token TEXT;
ALTER TABLE conversations ADD COLUMN menu_expires_at INTEGER;
ALTER TABLE conversations ADD COLUMN menu_items TEXT NOT NULL DEFAULT '[]';
CREATE INDEX conversations_department_queue ON conversations(profile_id,department_id,state,updated);
CREATE INDEX conversations_customer_phone ON conversations(profile_id,phone);
