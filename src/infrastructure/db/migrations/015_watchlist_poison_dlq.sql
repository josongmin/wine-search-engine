-- Migration 012: watchlist_poison_dlq (Wave 3 / H12 fail-loud)
--
-- Durable dead-letter queue for watchlist events that exhausted the
-- retry budget inside RedisWatchlistSubscriber. Prior behavior was
-- InMemoryWatchlistPoisonStore only — events were lost on process
-- restart. This table records every poisoned event so ops can
-- investigate repeated handler failures.
--
-- Write path: RedisWatchlistSubscriber.handleEvent() → PgWatchlistPoisonStore.push()
-- Read path: operator tooling / support runbooks

CREATE TABLE IF NOT EXISTS watchlist_poison_dlq (
  id               BIGSERIAL   PRIMARY KEY,
  entity_id        TEXT        NOT NULL,
  raw_payload      TEXT        NOT NULL,
  attempts         INTEGER     NOT NULL,
  last_error       TEXT        NOT NULL,
  first_seen_at    TIMESTAMPTZ NOT NULL,
  poisoned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(entity_id) > 0),
  CHECK (attempts >= 1)
);

COMMENT ON TABLE watchlist_poison_dlq IS
  'Wave 3 / H12: append-only DLQ for watchlist events that exhausted retry. Read by operator tooling; never consumed by runtime read path.';

CREATE INDEX IF NOT EXISTS idx_watchlist_poison_dlq_entity
  ON watchlist_poison_dlq(entity_id);

CREATE INDEX IF NOT EXISTS idx_watchlist_poison_dlq_poisoned_at
  ON watchlist_poison_dlq(poisoned_at DESC);
