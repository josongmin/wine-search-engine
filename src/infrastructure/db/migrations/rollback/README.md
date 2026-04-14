# Manual rollback migrations

Files in this directory are **NOT** run by `runMigrations()` — the auto-migrator's `readdirSync` only scans the parent `migrations/` directory top-level. These rollback scripts exist to let operators undo a forward migration manually, under explicit deploy-window control, after satisfying any pre-conditions documented in the file header.

## Current files

- `017_runtime_plane_snapshot_pk_rollback.sql` — reverts migration 016 (composite PK on `entities`/`aliases`/`ambiguity_registry`) back to migration 015 state. Requires `scripts/ops/reap-snapshots.ts --force` to have run first and manual cross-snapshot-duplicate cleanup. See file header for the exact pre-conditions and semantic-loss warnings.

## How to run

```
psql "$DATABASE_URL" \
  -f src/infrastructure/db/migrations/rollback/017_runtime_plane_snapshot_pk_rollback.sql
```

## How to **not** run

Never add this path to `runMigrations()`. Never copy a rollback file into the top-level `migrations/` directory. Never reference these files from CI. They are operator-only escape hatches.
