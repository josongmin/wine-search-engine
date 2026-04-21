-- Migration 020: resilient publish lease for search snapshot cutover.
--
-- The old publisher used a session-bound advisory lock held on one long-lived
-- PG connection while Vespa bulk indexing ran. Local Docker / TCP churn could
-- kill that connection mid-publish, forcing a fail-closed rollback even when
-- no competing publisher existed. This table provides a lease-based lock with
-- fencing semantics so the publisher can renew ownership using short-lived pool
-- queries instead of a fragile pinned session.

CREATE TABLE IF NOT EXISTS search_snapshot_publish_lock (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  owner_id TEXT,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ
);

INSERT INTO search_snapshot_publish_lock (
  id,
  owner_id,
  fencing_token,
  lease_expires_at,
  acquired_at,
  heartbeat_at
)
VALUES (
  1,
  NULL,
  0,
  NULL,
  NULL,
  NULL
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE search_snapshot_publish_lock IS
  'Singleton publish lease with fencing token for search snapshot cutover. Replaces fragile session-bound advisory locks during long Vespa bulk indexing.';

COMMENT ON COLUMN search_snapshot_publish_lock.fencing_token IS
  'Monotonic fencing token incremented on every successful lease acquisition by a new owner.';
