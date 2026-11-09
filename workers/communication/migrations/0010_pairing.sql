CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL CHECK(client IN ('vinki','fagoo')),
  instance_name TEXT NOT NULL,
  device_hash TEXT NOT NULL UNIQUE,
  user_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','consumed','denied','revoked')),
  expires INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  profile_id TEXT REFERENCES profiles(id),
  app_id TEXT REFERENCES applications(id),
  key_id TEXT REFERENCES api_keys(id),
  credential TEXT,
  grants TEXT NOT NULL DEFAULT '{}',
  approved_by TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX pairing_expiration ON pairing_requests(status,expires);
