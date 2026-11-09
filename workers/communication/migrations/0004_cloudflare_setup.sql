CREATE TABLE cloudflare_jobs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  actor TEXT NOT NULL,
  admin_hostname TEXT NOT NULL UNIQUE,
  api_hostname TEXT NOT NULL UNIQUE,
  spec TEXT NOT NULL,
  resources TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  step INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX cloudflare_jobs_pending ON cloudflare_jobs(status,created);
