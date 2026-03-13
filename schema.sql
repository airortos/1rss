CREATE TABLE IF NOT EXISTS feeds (
  url_key TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  rss_xml TEXT NOT NULL,
  item_count INTEGER,
  updated_at TEXT NOT NULL
);
