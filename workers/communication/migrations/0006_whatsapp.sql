-- Additive: existing messages, contacts and delivery journals are preserved.
ALTER TABLE conversations ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN bot_policy TEXT NOT NULL DEFAULT 'mentions';
ALTER TABLE messages ADD COLUMN content TEXT NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN status_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX message_provider_id ON messages(profile_id,external_id);
CREATE TABLE whatsapp_groups(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),subject TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',participants TEXT NOT NULL DEFAULT '[]',own_admin INTEGER NOT NULL DEFAULT 0,announcement INTEGER NOT NULL DEFAULT 0,invite_link TEXT,updated INTEGER NOT NULL);
CREATE TABLE channel_events(event_key TEXT PRIMARY KEY,connection_id TEXT NOT NULL,chat TEXT NOT NULL,external_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE INDEX channel_events_target ON channel_events(connection_id,external_id,applied);
CREATE TABLE media_uploads(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,actor TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,object_key TEXT NOT NULL,upload_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploading',created INTEGER NOT NULL);
CREATE TABLE media_parts(upload_id TEXT NOT NULL REFERENCES media_uploads(id),part INTEGER NOT NULL,digest TEXT NOT NULL,size INTEGER NOT NULL,etag TEXT,PRIMARY KEY(upload_id,part));
CREATE TABLE calls(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,connection_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),external_id TEXT,direction TEXT NOT NULL,actor TEXT,status TEXT NOT NULL,remote_session TEXT,local_session TEXT,error TEXT,started INTEGER,ended INTEGER,duration INTEGER,provider_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(connection_id,external_id));
CREATE INDEX calls_profile ON calls(profile_id,created,id);
CREATE TABLE call_permissions(connection_id TEXT NOT NULL,recipient TEXT NOT NULL,payload TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(connection_id,recipient));
CREATE TABLE call_events(event_key TEXT PRIMARY KEY,connection_id TEXT NOT NULL,external_id TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE group_operations(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,connection_id TEXT NOT NULL,conversation_id TEXT,actor TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
