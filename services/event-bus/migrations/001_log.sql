CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  appended_at TEXT NOT NULL
);
CREATE INDEX events_topic_offset ON events(topic, seq);

CREATE TABLE group_offsets (
  group_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  committed_offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, topic)
);
