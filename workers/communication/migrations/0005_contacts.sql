CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL,
  source TEXT NOT NULL,
  import_fingerprint TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(id,profile_id),
  UNIQUE(profile_id,namespace,import_fingerprint)
);
CREATE INDEX contacts_recent ON contacts(profile_id,created DESC,id DESC);
CREATE UNIQUE INDEX conversations_id_profile ON conversations(id,profile_id);
CREATE TABLE conversation_contacts (
  conversation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY(conversation_id,profile_id) REFERENCES conversations(id,profile_id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id,profile_id) REFERENCES contacts(id,profile_id) ON DELETE CASCADE
);
CREATE INDEX conversation_contacts_contact ON conversation_contacts(profile_id,contact_id);
