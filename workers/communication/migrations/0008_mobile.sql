-- Additive: mobile sessions, push devices, push cursors/log and ticket alerts.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'cookie';
ALTER TABLE sessions ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN last_used INTEGER;
CREATE TABLE devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'fcm',token TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',app_version TEXT NOT NULL DEFAULT '',profiles TEXT NOT NULL DEFAULT '[]',origin TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,last_error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE INDEX devices_user ON devices(user_id);
CREATE TABLE push_cursors(profile_id TEXT PRIMARY KEY,last_event_id INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE push_log(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,kind TEXT NOT NULL,resource_id TEXT,dedupe TEXT UNIQUE,status TEXT NOT NULL,error TEXT,created INTEGER NOT NULL);
CREATE INDEX push_log_profile ON push_log(profile_id,created);
CREATE TABLE ticket_alerts(ticket_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(ticket_id,kind));
-- Existing installations start at the end of the event history: nothing that
-- happened before the update becomes a notification.
INSERT INTO push_cursors(profile_id,last_event_id,updated) SELECT profile_id,max(id),0 FROM events GROUP BY profile_id;
-- Tickets already overdue at update time are marked as alerted.
INSERT OR IGNORE INTO ticket_alerts(ticket_id,kind,created) SELECT id,'due_soon',0 FROM tickets WHERE status!='closed' AND first_response_at IS NULL AND response_due_at IS NOT NULL AND response_due_at<=CAST(strftime('%s','now') AS INTEGER)*1000;
INSERT OR IGNORE INTO ticket_alerts(ticket_id,kind,created) SELECT id,'overdue',0 FROM tickets WHERE status!='closed' AND first_response_at IS NULL AND response_due_at IS NOT NULL AND response_due_at<=CAST(strftime('%s','now') AS INTEGER)*1000;
