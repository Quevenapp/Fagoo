-- Projections only: canonical authority and identities remain in Fagoo PostgreSQL.
CREATE TABLE fagoo_profiles(profile_id TEXT PRIMARY KEY REFERENCES profiles(id), unit_id TEXT NOT NULL UNIQUE);
CREATE TABLE fagoo_contact_links(profile_id TEXT NOT NULL, contact_id TEXT NOT NULL, canonical_contact_id TEXT NOT NULL, PRIMARY KEY(profile_id,contact_id), FOREIGN KEY(contact_id,profile_id) REFERENCES contacts(id,profile_id));
CREATE INDEX fagoo_contact_timeline ON fagoo_contact_links(profile_id,canonical_contact_id);
CREATE TABLE fagoo_runtime(id INTEGER PRIMARY KEY CHECK(id=1),pause_outbound INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
INSERT INTO fagoo_runtime(id,pause_outbound,updated) VALUES(1,0,0);
CREATE TABLE fagoo_queue_routes(profile_id TEXT PRIMARY KEY REFERENCES profiles(id),source_type TEXT NOT NULL CHECK(source_type IN('pool','number')),source_id TEXT NOT NULL);
CREATE TABLE fagoo_queue_notices(notice_id TEXT PRIMARY KEY,claim_id TEXT NOT NULL,unit_id TEXT NOT NULL,delivery_id TEXT UNIQUE);
CREATE TABLE fagoo_actor_aliases(profile_id TEXT NOT NULL REFERENCES profiles(id),source_actor TEXT NOT NULL,canonical_user_id TEXT NOT NULL,PRIMARY KEY(profile_id,source_actor),CHECK(source_actor NOT LIKE 'app:%' AND source_actor NOT LIKE 'bot:%'));
CREATE INDEX fagoo_alias_user ON fagoo_actor_aliases(profile_id,canonical_user_id);
CREATE TABLE fagoo_contact_jobs(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),profile_id TEXT NOT NULL,namespace TEXT NOT NULL,source_id TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,canonical_contact_id TEXT,error TEXT);
CREATE INDEX fagoo_contact_jobs_pending ON fagoo_contact_jobs(profile_id,status,next_at);
CREATE TABLE fagoo_subscription_jobs(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,phone TEXT NOT NULL,token TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT);
