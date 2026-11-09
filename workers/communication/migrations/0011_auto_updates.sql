-- Cross-request lease shared by manual commands and scheduled update work.
CREATE TABLE system_update_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires INTEGER NOT NULL
);
