CREATE TABLE IF NOT EXISTS watchlists (
  watchlist_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  trigger_conditions JSONB NOT NULL DEFAULT '[]',
  callback_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_watchlists_entity ON watchlists(entity_id);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlists_expires_at ON watchlists(expires_at);

CREATE TABLE IF NOT EXISTS watchlist_delivery_logs (
  delivery_log_id TEXT PRIMARY KEY,
  watchlist_id TEXT NOT NULL REFERENCES watchlists(watchlist_id) ON DELETE CASCADE,
  attempt INT NOT NULL,
  status_code INT,
  error_message TEXT,
  delivered_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchlist_delivery_logs_watchlist
  ON watchlist_delivery_logs(watchlist_id, delivered_at DESC);
