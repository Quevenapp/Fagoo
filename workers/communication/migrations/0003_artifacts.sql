-- Native Hermes artifact downloads are one-shot. Record intent before fetching.
CREATE TABLE artifact_imports (
  connection_id TEXT NOT NULL,
  remote_profile TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  media_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'downloading',
  created INTEGER NOT NULL,
  PRIMARY KEY(connection_id,remote_profile,artifact_id)
);
