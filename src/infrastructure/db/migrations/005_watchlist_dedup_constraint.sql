-- BUG-18: Prevent duplicate watchlist subscriptions for the same (user, entity, callback).
-- A user subscribing twice to the same entity+callback URL should be idempotent.
--
-- STEP 1: Remove existing duplicates before creating the UNIQUE INDEX.
-- Without this CTE, CREATE UNIQUE INDEX fails with:
--   ERROR: could not create unique index "idx_watchlists_user_entity_callback"
--   DETAIL: Key (user_id, entity_id, callback_url)=(...) is duplicated.
-- We keep the most recently created row (ORDER BY created_at DESC) per group.
--
-- Rollback: DROP INDEX IF EXISTS idx_watchlists_user_entity_callback;
WITH ranked AS (
  SELECT
    watchlist_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, entity_id, callback_url
      ORDER BY created_at DESC NULLS LAST
    ) AS rn
  FROM watchlists
)
DELETE FROM watchlists
WHERE watchlist_id IN (
  SELECT watchlist_id FROM ranked WHERE rn > 1
);

-- STEP 2: Create the UNIQUE INDEX now that duplicates are gone.
-- ON CONFLICT behaviour in pg-watchlist-store.ts#save() depends on this constraint
-- so concurrent inserts converge to a single row (idempotency guarantee).
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_entity_callback
  ON watchlists (user_id, entity_id, callback_url);
