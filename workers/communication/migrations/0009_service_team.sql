ALTER TABLE bots ADD COLUMN line_ids TEXT;
ALTER TABLE conversations ADD COLUMN assigned_bot_id TEXT;
ALTER TABLE conversations ADD COLUMN menu_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN menu_manual INTEGER NOT NULL DEFAULT 0;

CREATE TABLE internal_chats (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  member_a TEXT NOT NULL,
  member_b TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(profile_id,member_a,member_b)
);
CREATE TABLE internal_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES internal_chats(id),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  run_id TEXT,
  source_key TEXT UNIQUE NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX internal_messages_history ON internal_messages(chat_id,created,id);
CREATE INDEX internal_chats_members ON internal_chats(profile_id,member_a,member_b,updated);
CREATE TABLE team_connection_presence (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id),
  checked_at INTEGER NOT NULL,
  online INTEGER NOT NULL DEFAULT 0
);
