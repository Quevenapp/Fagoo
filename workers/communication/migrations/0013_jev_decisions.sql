-- One provider decision per completed interpretation, including uncertain calls.
CREATE TABLE jev_decisions (
  run_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'decided')),
  decision TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX jev_decisions_profile ON jev_decisions(profile_id, created);
