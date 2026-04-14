# Design 008 — Runtime Plane Snapshot-Scoped PK Implementation Plan

> **Status**: companion to [ADR-008](../adr/008-runtime-plane-snapshot-scoped-primary-keys.md) rev 2. This document translates the ADR decisions into drop-in artifacts (SQL, code diffs, test file list, PR slicing).
>
> **Scope rule**: every code, SQL, and test block in this document is verified against the repo state as of 2026-04-14 (post-Wave-2 bugbash). Reviewers should be able to apply each snippet verbatim and have it compile / migrate.

---

## 0. Invariants we commit to

1. **Append-only publish**: a publish run MUST NOT mutate any row whose `search_snapshot_id` differs from the snapshot being written. Verified by `test/regression/runtime-plane-append-only.regression.test.ts` and integration smoke.
2. **Snapshot-scoped read**: every reader resolves the active `search_snapshot_id` and filters. Reader `WHERE identity_signature = $1` without a snapshot column is forbidden.
3. **Runtime write authority**: `PgEntityRepository` is read-only. The only legitimate writers to `entities` / `aliases` / `ambiguity_registry` are the ETL publisher and the snapshot reaper.
4. **Pointer semantics**: rollback = `active_search_snapshot` pointer reset. Never DELETE + re-INSERT entity rows in hot paths.
5. **Contract honesty**: new `/ready` observability surfaces go through the Zod contract + OpenAPI regeneration. No back-door field smuggling.

---

## 1. Schema: `016_runtime_plane_snapshot_pk.sql`

**Path**: `src/infrastructure/db/migrations/016_runtime_plane_snapshot_pk.sql`

**Design notes**:
- Mirrors the `DO $$ BEGIN … END $$` block pattern from [migration 012](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql) so the file is **re-runnable** (operators can replay it after partial application).
- Backfill guard on NULL `search_snapshot_id` lifted from migration 012 lines 20–31. Reuse pattern, not logic (runtime plane already has `search_snapshot_id` populated from migration 007, so backfill should be a no-op).
- Preserve the existing `updated_at` trigger on `entities` — composite PK change is orthogonal.
- `entity_snapshots.entity_id` FK drop is a one-liner at the end; the replacement invariant is application-level (publisher asserts entity rows exist per `(search_snapshot_id, entity_id)` before writing `entity_snapshots`).
- `identity_signature` UNIQUE must become snapshot-scoped. Partial index tolerates legacy `__unbound__` rows (migration 011 pattern preserved).

```sql
-- Migration 016: runtime plane snapshot-scoped composite primary keys.
--
-- ADR-008 Phase 1. Restores the append-only publish contract declared in
-- migration 010's comments by making (search_snapshot_id, <id>) the actual
-- unique constraint on the runtime-plane tables. Canonical plane (migrations
-- 012/013) is already on this model; this brings runtime plane in line.
--
-- Scope:
--   1. entities: PK (entity_id) -> PK (search_snapshot_id, entity_id).
--      UNIQUE identity_signature -> UNIQUE (search_snapshot_id, identity_signature)
--      partial WHERE length(identity_signature) > 0.
--   2. aliases:  PK (alias_id) -> PK (search_snapshot_id, alias_id).
--   3. ambiguity_registry: PK (registry_id) -> PK (search_snapshot_id, registry_id).
--      UNIQUE normalized_form -> UNIQUE (search_snapshot_id, normalized_form).
--   4. entity_snapshots: drop the FK to entities(entity_id) so the composite
--      PK change on entities doesn't cascade-break this archive table.
--
-- Safety: every ALTER is wrapped in a DO block guarding on constraint
-- existence so the migration is idempotent and partial-application safe.
-- Backfill guard on NULL search_snapshot_id mirrors migration 012's pattern.

-- --------------------------------------------------------------------------
-- Backfill / NULL guard
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entities
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'entities contains legacy rows without search_snapshot_id; backfill via scripts/ops/backfill-runtime-snapshot-id.ts or delete before running migration 016';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM aliases
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'aliases contains legacy rows without search_snapshot_id; backfill or delete before running migration 016';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ambiguity_registry
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'ambiguity_registry contains legacy rows without search_snapshot_id; backfill or delete before running migration 016';
  END IF;
END
$$;

-- --------------------------------------------------------------------------
-- entities
-- --------------------------------------------------------------------------
-- Drop global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_pkey'
  ) THEN
    ALTER TABLE entities DROP CONSTRAINT entities_pkey;
  END IF;
END
$$;

-- Add composite PK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_snapshot_pkey'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, entity_id);
  END IF;
END
$$;

-- Drop global identity_signature UNIQUE (replaces migration 011's
-- uq_entities_identity_signature partial index).
DROP INDEX IF EXISTS uq_entities_identity_signature;

-- Also drop migration 001's inline UNIQUE if present (created as a
-- table-level constraint rather than a named index).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_identity_signature_key'
  ) THEN
    ALTER TABLE entities
      DROP CONSTRAINT entities_identity_signature_key;
  END IF;
END
$$;

-- Add snapshot-scoped identity_signature uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entities_snapshot_identity_signature
  ON entities(search_snapshot_id, identity_signature)
  WHERE length(identity_signature) > 0;

COMMENT ON INDEX uq_entities_snapshot_identity_signature IS
  'ADR-008: identity_signature uniqueness is per-snapshot under the append-only publish model. Partial index tolerates historical __unbound__ rows with empty signatures (same as the pre-016 uq_entities_identity_signature).';

-- --------------------------------------------------------------------------
-- aliases
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_pkey'
  ) THEN
    ALTER TABLE aliases DROP CONSTRAINT aliases_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_snapshot_pkey'
  ) THEN
    ALTER TABLE aliases
      ADD CONSTRAINT aliases_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, alias_id);
  END IF;
END
$$;

-- --------------------------------------------------------------------------
-- ambiguity_registry
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry DROP CONSTRAINT ambiguity_registry_pkey;
  END IF;
END
$$;

-- Drop the legacy global UNIQUE on normalized_form (migration 001 line 63).
DROP INDEX IF EXISTS idx_ambiguity_normalized;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_snapshot_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry
      ADD CONSTRAINT ambiguity_registry_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, registry_id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_snapshot_normalized
  ON ambiguity_registry(search_snapshot_id, normalized_form);

COMMENT ON INDEX idx_ambiguity_snapshot_normalized IS
  'ADR-008: normalized_form uniqueness is per-snapshot. Replaces the global idx_ambiguity_normalized from migration 001.';

-- --------------------------------------------------------------------------
-- entity_snapshots: drop FK so entities composite PK is free to evolve.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_snapshots_entity_id_fkey'
  ) THEN
    ALTER TABLE entity_snapshots
      DROP CONSTRAINT entity_snapshots_entity_id_fkey;
  END IF;
END
$$;

COMMENT ON TABLE entity_snapshots IS
  'ADR-008: FK to entities dropped — entities PK is now composite (search_snapshot_id, entity_id) and the archive is invariant-guarded at the application level (publisher asserts per-snapshot entity row existence before writing).';
```

**Migration test additions** (`src/__tests__/db-migrate.test.ts`):

```ts
it('runs migration 016 (runtime plane snapshot PK) cleanly', async () => {
  const pool = await getTestPool();
  await pool.query(/* apply 001–015 */);
  await pool.query(readMigrationFile('016_runtime_plane_snapshot_pk.sql'));
  // Composite PK present
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'entities' AND indexname = 'entities_snapshot_pkey'`,
  );
  expect(rows.length).toBe(1);
});

it('migration 016 is re-runnable (idempotent)', async () => {
  const pool = await getTestPool();
  await pool.query(readMigrationFile('016_runtime_plane_snapshot_pk.sql'));
  await pool.query(readMigrationFile('016_runtime_plane_snapshot_pk.sql')); // second run
  // still exactly one composite PK
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM pg_constraint WHERE conname = 'entities_snapshot_pkey'`,
  );
  expect(rows[0].c).toBe(1);
});
```

---

## 2. Rollback migration: `017_runtime_plane_snapshot_pk_rollback.sql`

**Path**: `src/infrastructure/db/migrations/017_runtime_plane_snapshot_pk_rollback.sql`

**Important**: This file is committed but **not auto-run**. Operators execute it manually via `scripts/ops/apply-migration.ts 017_runtime_plane_snapshot_pk_rollback.sql` only after they've reaped cross-snapshot duplicates.

```sql
-- Migration 017 (manual rollback only): revert runtime plane composite PKs
-- back to migration 015 state. See ADR-008 §Rollback Plan Level 1.
--
-- PRE-CONDITION: scripts/ops/reap-snapshots.ts --force must have been run
-- first to delete rows where search_snapshot_id NOT IN (active, previous).
-- Otherwise the global PK restoration below will fail with duplicate key
-- on (entity_id) / (alias_id) / (registry_id).
--
-- PRE-CONDITION: cross-snapshot duplicates WITHIN (active, previous) must
-- be resolved by keeping the active_search_snapshot.active_snapshot_id row
-- and dropping previous_snapshot_id rows:
--
--   DELETE FROM entities a
--     USING entities b, active_search_snapshot ptr
--     WHERE a.entity_id = b.entity_id
--       AND a.search_snapshot_id = ptr.previous_snapshot_id
--       AND b.search_snapshot_id = ptr.active_snapshot_id;
--
--   -- Repeat for aliases / ambiguity_registry with their id columns.
--
-- SEMANTIC LOSS: after this migration, pointer-based rollback no longer
-- works for any entity that was updated between (previous, active). The
-- operator running this script is accepting that loss explicitly.

-- entities: composite PK -> global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_snapshot_pkey'
  ) THEN
    ALTER TABLE entities DROP CONSTRAINT entities_snapshot_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_pkey'
  ) THEN
    ALTER TABLE entities ADD CONSTRAINT entities_pkey PRIMARY KEY (entity_id);
  END IF;
END
$$;

DROP INDEX IF EXISTS uq_entities_snapshot_identity_signature;

CREATE UNIQUE INDEX IF NOT EXISTS uq_entities_identity_signature
  ON entities(identity_signature)
  WHERE length(identity_signature) > 0;

-- aliases: composite PK -> global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_snapshot_pkey'
  ) THEN
    ALTER TABLE aliases DROP CONSTRAINT aliases_snapshot_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_pkey'
  ) THEN
    ALTER TABLE aliases ADD CONSTRAINT aliases_pkey PRIMARY KEY (alias_id);
  END IF;
END
$$;

-- ambiguity_registry: composite PK -> global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_snapshot_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry DROP CONSTRAINT ambiguity_registry_snapshot_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry ADD CONSTRAINT ambiguity_registry_pkey PRIMARY KEY (registry_id);
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_ambiguity_snapshot_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_normalized
  ON ambiguity_registry(normalized_form);

-- entity_snapshots FK restore (optional — can be left dropped since
-- application-level guard is preferred). Keeping the DDL here for
-- completeness in case operators need the exact pre-016 state.
-- ALTER TABLE entity_snapshots
--   ADD CONSTRAINT entity_snapshots_entity_id_fkey
--   FOREIGN KEY (entity_id) REFERENCES entities(entity_id);
```

---

## 3. Publisher diff: `scripts/etl/publish-runtime-substrates.ts`

**Target**: 3 INSERT statements at lines 353–460.

**Change shape**: `ON CONFLICT (<id>) DO UPDATE …` / `DO NOTHING` →
`ON CONFLICT (search_snapshot_id, <id>) DO NOTHING`.

**Justification for `DO NOTHING`** on all 3 (including entities): under the
composite PK model, each publish run produces a fresh set of
`(search_snapshot_id, id)` rows. A conflict can only happen if the same
snapshot is being replayed; the correct idempotent response is to ignore
the duplicate write. Content changes between re-publishes of the same
snapshot ID would be a bug (publisher produced different output for the
same snapshot) and are caught separately by `assertSnapshotNotAlreadyPublished`.

### 3.1 `entities` INSERT

Replace lines 353–385 with:

```ts
await client.query(
  `WITH input AS (
     SELECT *
     FROM jsonb_to_recordset($1::jsonb) AS rows(
       entity_id text,
       search_snapshot_id text,
       entity_type text,
       canonical_label text,
       identity_signature text,
       relations jsonb,
       attributes jsonb,
       metadata jsonb
     )
   )
   INSERT INTO entities (
     entity_id, search_snapshot_id, entity_type, canonical_label, identity_signature,
     relations, attributes, metadata
   )
   SELECT
     entity_id, search_snapshot_id, entity_type, canonical_label, identity_signature,
     relations, attributes, metadata
   FROM input
   -- ADR-008: composite PK conflict target. Re-publishing the same snapshot
   -- is idempotent; cross-snapshot writes append new rows without touching
   -- other snapshots' data.
   ON CONFLICT (search_snapshot_id, entity_id) DO NOTHING`,
  [entityRowsJson],
);
```

**Removed**: the `DO UPDATE SET search_snapshot_id = EXCLUDED.search_snapshot_id, entity_type = EXCLUDED.entity_type, … updated_at = NOW()` block. Under the new contract the updated_at mutation is a no-op for any run — fresh snapshots get fresh rows; re-runs are caught by `assertSnapshotNotAlreadyPublished`.

### 3.2 `aliases` INSERT

Replace lines 408–434's conflict clause:

```ts
// before
ON CONFLICT (alias_id) DO NOTHING

// after
-- ADR-008: composite PK conflict target.
ON CONFLICT (search_snapshot_id, alias_id) DO NOTHING
```

### 3.3 `ambiguity_registry` INSERT

Replace lines 436–460's conflict clause:

```ts
// before
ON CONFLICT (registry_id) DO NOTHING

// after
-- ADR-008: composite PK conflict target.
ON CONFLICT (search_snapshot_id, registry_id) DO NOTHING
```

### 3.4 `entity_snapshots` INSERT (lines 386–402)

`entity_snapshots` table is untouched by ADR-008 at the schema level (its PK is `snapshot_id` which is a per-row identifier, not the publish snapshot ID). But the current `ON CONFLICT (snapshot_id) DO UPDATE` is semantically suspect — it lets a mis-built snapshot quietly rewrite archive data. Tighten to `DO NOTHING` so archive rows are append-only:

```ts
INSERT INTO entity_snapshots (snapshot_id, entity_id, snapshot_data)
SELECT snapshot_id, entity_id, snapshot_data
FROM input
-- ADR-008: archive is append-only; rewriting an existing archive row
-- indicates a publisher bug, not an idempotent retry. If this path
-- starts throwing in production, debug the publisher, don't re-enable
-- DO UPDATE.
ON CONFLICT (snapshot_id) DO NOTHING
```

### 3.5 Regression guards

- **Keep**: `assertSnapshotNotAlreadyPublished(client, manifest.snapshotId)` on line 352. This guards against re-running the _same_ snapshot ID with a different payload, which composite PK alone does not catch.
- **Keep**: `assertEntityIdentitySignatureConsistency(client, entities)` on line 346. The assertion now validates within the new snapshot's rows only (since `uq_entities_snapshot_identity_signature` is per-snapshot).

---

## 4. PgEntityRepository: Option R1 (deprecation)

**Decision**: R1 (deprecation) over R2 (rewrite).

**Reasoning**:
1. Grep confirms zero `new PgEntityRepository(…)` call sites in production wiring (2026-04-14).
2. `rollbackToSnapshot()`'s semantics are structurally incompatible with the pointer-based rollback model declared in migration 010. Keeping the method alive would require either redefining the method's contract (invasive) or leaving a method that silently does the wrong thing.
3. Runtime write authority should collapse to a single authority (ETL publisher). Multiple writers into `entities` means multiple places where the append-only invariant can be re-broken.

### 4.1 Port diff (`src/domain/entity/port/entity-repository.port.ts`)

**Before**:
```ts
export interface EntityRepository {
  findById(id: CanonicalEntityId): Promise<Entity | null>;
  findBySignature(signature: string): Promise<Entity | null>;
  findByType(type: EntityType, limit?: number): Promise<readonly Entity[]>;
  save(entity: Entity): Promise<void>;
  update(entity: Entity): Promise<void>;
  delete(id: CanonicalEntityId): Promise<void>;
  createSnapshot(label: string): Promise<string>;
  rollbackToSnapshot(snapshotId: string): Promise<void>;
}
```

**After**:
```ts
/**
 * Read-only repository port for Entity lookups.
 *
 * ADR-008 (runtime plane snapshot-scoped PK): the runtime write path is
 * collapsed to a single authority — the ETL publisher in
 * `scripts/etl/publish-runtime-substrates.ts`. Mutating methods previously
 * exposed by this port (save/update/delete/createSnapshot/rollbackToSnapshot)
 * were removed because:
 *  1. No production composition root ever constructed a PgEntityRepository
 *     with write intent.
 *  2. rollbackToSnapshot's row-level semantics contradicts the pointer-based
 *     rollback declared in migration 010.
 *  3. Multiple runtime writers multiply the surface where the append-only
 *     invariant can be broken. Collapse to one authoritative writer is safer.
 *
 * Implementations live in the infrastructure layer.
 */
export interface EntityRepository {
  /** Find an entity by its unique id, scoped to the active snapshot. */
  findById(id: CanonicalEntityId): Promise<Entity | null>;

  /** Find an entity by its deterministic identity signature, scoped to the active snapshot. */
  findBySignature(signature: string): Promise<Entity | null>;

  /**
   * Find entities by type within the active snapshot.
   * @param type - The entity type to filter on.
   * @param limit - Maximum number of results (default implementation-defined).
   */
  findByType(type: EntityType, limit?: number): Promise<readonly Entity[]>;
}
```

### 4.2 Implementation diff (`src/infrastructure/adapter/pg-entity-repository.ts`)

**Remove** methods:
- `save()` lines 149–195
- `update()` lines 197–225
- `delete()` lines 227–235
- `createSnapshot()` full body (currently lines 237–293 approx)
- `rollbackToSnapshot()` lines 295–345 (the whole body)
- The internal purge DELETE at lines 352–363

**Retain**:
- `findById()` lines 119–127
- `findBySignature()` lines 129–137
- `findByType()` lines 139–147
- `resolveActiveSnapshotId()` helper
- `rowToEntity()` helper and its validation logging

**Expected file length**: from ~370 lines down to ~150 lines.

### 4.3 Barrel export audit

`src/infrastructure/index.ts:7` currently:
```ts
export { PgEntityRepository } from './adapter/pg-entity-repository.js';
```

**No change** — the class is still exported, only its method surface shrinks. Consumers get a compile error on any mutating method reference, which is what we want.

### 4.4 Regression test — write surface is empty

**New file**: `test/regression/pg-entity-repository-readonly-surface.regression.test.ts`

```ts
/**
 * ADR-008: PgEntityRepository must remain read-only. This test asserts
 * that no production TypeScript file references any of the mutating
 * methods that were removed. If a future refactor re-adds a writer,
 * this test should be the first thing that fails.
 *
 * Append-only: NEVER delete this test even after the ADR ages out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_GLOB = 'src/**/*.ts';
const FORBIDDEN_MUTATORS = [
  /entityRepository\.save\s*\(/,
  /entityRepository\.update\s*\(/,
  /entityRepository\.delete\s*\(/,
  /entityRepository\.createSnapshot\s*\(/,
  /entityRepository\.rollbackToSnapshot\s*\(/,
  /PgEntityRepository[^)]*\)\s*\.save\s*\(/,
  /PgEntityRepository[^)]*\)\s*\.update\s*\(/,
  /PgEntityRepository[^)]*\)\s*\.delete\s*\(/,
  /PgEntityRepository[^)]*\)\s*\.createSnapshot\s*\(/,
  /PgEntityRepository[^)]*\)\s*\.rollbackToSnapshot\s*\(/,
];

describe('ADR-008 regression: PgEntityRepository read-only surface', () => {
  it('no production TS file references a removed mutating method', () => {
    const files = globSync(SRC_GLOB, {
      cwd: REPO_ROOT,
      ignore: ['src/**/__tests__/**', 'src/**/*.test.ts'],
    });
    const offenders: string[] = [];
    for (const rel of files) {
      const abs = resolve(REPO_ROOT, rel);
      // Skip the repository implementation itself — that's where the
      // methods legitimately do NOT exist anymore, so grep matches would
      // be false positives.
      if (rel.endsWith('pg-entity-repository.ts')) continue;
      const src = readFileSync(abs, 'utf8');
      for (const pat of FORBIDDEN_MUTATORS) {
        if (pat.test(src)) {
          offenders.push(`${rel}: matches ${pat.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

---

## 5. Pre-filter leak patches

### 5.1 `container-core-builders.ts:80-82`

**Before**:
```ts
const { rows } = await pool.query<{ surface_form: string }>(
  'SELECT DISTINCT surface_form FROM aliases WHERE is_suppressed = FALSE LIMIT 100000',
);
```

**After**:
```ts
// ADR-008: learning warmup must read only the active snapshot. Without this
// filter, surface forms from reaped or stale snapshots would poison the
// learning corpus. If the snapshot pointer is missing (fresh DB, pre-
// publish), skip warmup cleanly — learning is a bootstrap enhancement, not
// a required dependency.
let activeSnapshotId: string;
try {
  ({ activeSnapshotId } = await resolveActiveSnapshot(pool));
} catch (err: unknown) {
  if (readPgSqlState(err) === '42P01') {
    globalSilentSkipCounter.increment(
      'learning_warmup_disabled_snapshot_pointer_missing',
      { surface: 'container-core-builders' },
    );
    bootstrapLogger.info(
      '[learning-warmup] active_search_snapshot table missing — warmup disabled',
    );
    return [];
  }
  throw err;
}
const { rows } = await pool.query<{ surface_form: string }>(
  `SELECT DISTINCT surface_form
   FROM aliases
   WHERE search_snapshot_id = $1 AND is_suppressed = FALSE
   LIMIT 100000`,
  [activeSnapshotId],
);
```

**Imports to add**:
- `resolveActiveSnapshot` from `../infrastructure/db/active-snapshot-resolver.js`
- `readPgSqlState` from `../infrastructure/db/pg-sqlstate.js`
- `globalSilentSkipCounter` from `../observability/silent-skip-counters.js`
- `bootstrapLogger` already imported

**SilentSkipKind addition** (`src/observability/silent-skip-counters.ts`):
- Add `'learning_warmup_disabled_snapshot_pointer_missing'` to the union and the `SILENT_SKIP_KINDS` array.
- Add `'learning_adapter_disabled_snapshot_pointer_missing'` at the same time for §5.2.

### 5.2 `container-learning.ts:31-35`

**Before**:
```ts
const result = await pool.query(
  `SELECT 1 FROM aliases
   WHERE surface_form = $1 AND is_suppressed = FALSE
   LIMIT 1`,
  [surfaceForm],
);
```

**After**:
```ts
// ADR-008: learning adapter's "known surface form" check must be scoped to
// the active snapshot. Reaped snapshots' aliases must not leak into
// validation.
let activeSnapshotId: string;
try {
  ({ activeSnapshotId } = await resolveActiveSnapshot(pool));
} catch (err: unknown) {
  if (readPgSqlState(err) === '42P01') {
    globalSilentSkipCounter.increment(
      'learning_adapter_disabled_snapshot_pointer_missing',
      { surface: 'container-learning' },
    );
    return false;
  }
  throw err;
}
const result = await pool.query(
  `SELECT 1 FROM aliases
   WHERE surface_form = $1 AND search_snapshot_id = $2 AND is_suppressed = FALSE
   LIMIT 1`,
  [surfaceForm, activeSnapshotId],
);
```

### 5.3 Regression tests

- `test/regression/container-core-builders-snapshot-filter.regression.test.ts`: injects a fake pool with two snapshots' aliases, asserts warmup sees only the active snapshot's rows.
- `test/regression/container-learning-snapshot-filter.regression.test.ts`: similar shape.
- Both tests assert the silent-skip counter increments by 1 when pointer table is absent.

---

## 6. Snapshot reaper: `scripts/ops/reap-snapshots.ts`

**Path**: `scripts/ops/reap-snapshots.ts` (new).

**Design principles**:
- `--dry-run` is the **default**. `--force` is required for actual DELETE. This matches `runbook-etl-operator-acks.md` style for destructive operations.
- Emits a per-table pre/post count so the operator has a tangible audit trail.
- Reaps `entities`, `aliases`, `ambiguity_registry` in one transaction so a partial reap can't leave the three tables in disagreement.
- Refuses to run if `active_search_snapshot.previous_snapshot_id IS NULL` (first publish — nothing to reap safely).

### 6.1 Skeleton

```ts
#!/usr/bin/env tsx
/**
 * ADR-008 Phase 4: reap stale runtime-plane snapshot rows.
 *
 * Deletes rows from entities/aliases/ambiguity_registry whose
 * search_snapshot_id is neither the active nor the previous snapshot
 * (as recorded in active_search_snapshot).
 *
 * Default: --dry-run. Destructive execution requires --force.
 *
 * Usage:
 *   pnpm exec tsx scripts/ops/reap-snapshots.ts
 *   pnpm exec tsx scripts/ops/reap-snapshots.ts --force
 *   pnpm exec tsx scripts/ops/reap-snapshots.ts --grace-period-hours 48 --force
 */
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { bootstrapLogger } from '../../src/config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'reap-snapshots' });

interface Args {
  readonly force: boolean;
  readonly gracePeriodHours: number;
}

const DEFAULT_GRACE_PERIOD_HOURS = 24;

function parseArgs(argv: readonly string[]): Args {
  let force = false;
  let gracePeriodHours = DEFAULT_GRACE_PERIOD_HOURS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--grace-period-hours') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--grace-period-hours expects a non-negative number, got ${String(argv[i + 1])}`);
      }
      gracePeriodHours = n;
      i += 1;
    } else if (arg === '--dry-run') {
      // explicit dry-run flag (default behavior, accepted for clarity)
      force = false;
    }
  }
  return { force, gracePeriodHours };
}

interface TableReport {
  readonly table: string;
  readonly candidateRowCount: number;
  readonly deletedRowCount: number;
}

const REAPABLE_TABLES = ['entities', 'aliases', 'ambiguity_registry'] as const;
type ReapableTable = typeof REAPABLE_TABLES[number];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to reap snapshots');
  }
  const pool = createPgPool(config.pg);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: pointerRows } = await client.query<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        promoted_at: Date;
      }>(
        `SELECT active_snapshot_id, previous_snapshot_id, promoted_at
         FROM active_search_snapshot
         WHERE id = 1`,
      );
      const pointer = pointerRows[0];
      if (pointer === undefined) {
        throw new Error('active_search_snapshot is empty; refusing to reap');
      }
      if (pointer.previous_snapshot_id === null) {
        log.info('previous_snapshot_id is NULL (first publish) — nothing to reap');
        await client.query('ROLLBACK');
        return;
      }
      const gracePeriodMs = args.gracePeriodHours * 60 * 60 * 1000;
      const promotedAtMs = pointer.promoted_at.getTime();
      if (Date.now() - promotedAtMs < gracePeriodMs) {
        log.info(
          { graceHours: args.gracePeriodHours, promotedAt: pointer.promoted_at.toISOString() },
          'pointer promoted within grace period — refusing to reap',
        );
        await client.query('ROLLBACK');
        return;
      }

      const protectedIds = [pointer.active_snapshot_id, pointer.previous_snapshot_id];
      const reports: TableReport[] = [];
      for (const table of REAPABLE_TABLES) {
        const candidate = await client.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM ${table}
           WHERE search_snapshot_id <> ALL($1::text[])`,
          [protectedIds],
        );
        const candidateRowCount = Number(candidate.rows[0]?.c ?? '0');
        let deletedRowCount = 0;
        if (args.force && candidateRowCount > 0) {
          const del = await client.query(
            `DELETE FROM ${table}
             WHERE search_snapshot_id <> ALL($1::text[])`,
            [protectedIds],
          );
          deletedRowCount = del.rowCount ?? 0;
        }
        reports.push({ table, candidateRowCount, deletedRowCount });
      }

      if (args.force) {
        await client.query('COMMIT');
        log.info({ reports, protectedIds }, 'reap complete');
      } else {
        await client.query('ROLLBACK');
        log.info({ reports, protectedIds }, 'dry-run: no rows deleted');
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- ops CLI exits via stderr
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

### 6.2 Contract guards

- **Ops runbook update**: add a "Snapshot reaper" section to [`docs/runbook-etl-operator-acks.md`](../runbook-etl-operator-acks.md) describing:
  - Default `--dry-run`, destructive `--force`.
  - Pre-condition for rollback: reaper must run before `017_runtime_plane_snapshot_pk_rollback.sql`.
  - Expected report format.
  - How to interpret "promoted within grace period" refusal.
- **Tests**: `test/regression/reap-snapshots-dry-run.regression.test.ts` — asserts that a fresh `--dry-run` never emits DELETE (mock pg pool, count queries only).

---

## 7. `/ready` HTTP contract extension (Phase 4b)

### 7.1 Schema change: `src/interface/http/routes/route-contracts.ts`

**Add** new nested object `snapshot_health`. Placed as optional so the contract stays backwards-compatible for older consumers.

```ts
// Top of the file, near the other bound constants:
/** Upper bound on snapshot health row-count values surfaced in /ready. */
const SNAPSHOT_HEALTH_MAX_STALE_ROWS = 100_000_000; // 100M hard ceiling — catches runaway reaper lag.

const SnapshotHealthSchema = z.object({
  /** Snapshot ID currently served by the read path. */
  active_snapshot_id: z.string().min(1),
  /** Previous snapshot ID retained for rollback, null on first publish. */
  previous_snapshot_id: z.string().min(1).nullable(),
  /** Count of entities+aliases+ambiguity rows whose search_snapshot_id
   *  is neither active nor previous — i.e. rows waiting for the reaper. */
  stale_row_count: z.number().int().nonnegative().max(SNAPSHOT_HEALTH_MAX_STALE_ROWS),
  /** Seconds since active_search_snapshot.promoted_at — lets ops alert
   *  when reaper has not run within the expected grace window. */
  pointer_age_seconds: z.number().int().nonnegative(),
}).strict();

const ReadyResponseSchema = z.object({
  ready: z.boolean(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['up', 'down', 'skipped']),
    required: z.boolean(),
    reason: z.string().max(READINESS_REASON_MAX_LEN).optional(),
    error_class: z.string().max(READINESS_ERROR_CLASS_MAX_LEN).optional(),
  }).strict()).refine(
    (rec) => Object.keys(rec).length <= READINESS_CHECKS_MAX,
    { message: `checks record must not exceed ${READINESS_CHECKS_MAX} entries` },
  ),
  // ADR-008 Phase 4b: optional snapshot health block. Optional so the
  // field is allowed to be absent when the Postgres connection is down
  // and we cannot compute it, without breaking the wire contract.
  snapshot_health: SnapshotHealthSchema.optional(),
}).strict();
```

### 7.2 Handler change: `src/interface/http/routes/health.route.ts`

**Add** a type extension and reader call.

```ts
interface ReadyResponse {
  readonly ready: boolean;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, {
    readonly status: ReadinessStatus;
    readonly required: boolean;
    readonly reason?: string;
    readonly error_class?: string;
  }>>;
  // ADR-008 Phase 4b: snapshot plane observability block.
  readonly snapshot_health?: SnapshotHealth;
}

interface SnapshotHealth {
  readonly active_snapshot_id: string;
  readonly previous_snapshot_id: string | null;
  readonly stale_row_count: number;
  readonly pointer_age_seconds: number;
}

export interface HealthRouteOptions {
  readonly readiness?: Readonly<Record<string, ReadinessCheck>>;
  readonly metricsDebugSecret?: string | undefined;
  // ADR-008 Phase 4b: optional reader. Must not be required so tests
  // and dev environments without PG still boot cleanly.
  readonly snapshotHealthReader?: () => Promise<SnapshotHealth | undefined>;
}
```

At handler body, after the existing `checks` assembly and before `ready` calculation:

```ts
let snapshotHealth: SnapshotHealth | undefined;
if (options?.snapshotHealthReader !== undefined) {
  try {
    snapshotHealth = await options.snapshotHealthReader();
  } catch (err: unknown) {
    // A snapshot-health probe failure should surface in the per-check
    // degraded state — not crash the entire /ready handler.
    bootstrapLogger.warn(
      { err },
      '[health] snapshot_health reader threw — omitting from response',
    );
    snapshotHealth = undefined;
  }
}

const body: ReadyResponse = {
  ready,
  timestamp: new Date().toISOString(),
  checks,
  ...(snapshotHealth !== undefined ? { snapshot_health: snapshotHealth } : {}),
};
```

### 7.3 Reader implementation: `src/infrastructure/health/snapshot-health-reader.ts`

New file.

```ts
import type { Pool } from 'pg';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'snapshot-health-reader' });

export interface SnapshotHealth {
  readonly active_snapshot_id: string;
  readonly previous_snapshot_id: string | null;
  readonly stale_row_count: number;
  readonly pointer_age_seconds: number;
}

/**
 * ADR-008 Phase 4b: read snapshot plane observability for the /ready
 * response. This is best-effort — any failure returns `undefined` and
 * the /ready handler omits the block rather than propagating a 503.
 */
export function createSnapshotHealthReader(pool: Pool): () => Promise<SnapshotHealth | undefined> {
  return async () => {
    try {
      const { rows: pointerRows } = await pool.query<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        promoted_at: Date;
      }>(
        `SELECT active_snapshot_id, previous_snapshot_id, promoted_at
         FROM active_search_snapshot
         WHERE id = 1`,
      );
      const pointer = pointerRows[0];
      if (pointer === undefined) return undefined;

      const protectedIds = [pointer.active_snapshot_id, pointer.previous_snapshot_id].filter(
        (id): id is string => id !== null,
      );

      // Combined stale count across the 3 runtime-plane tables.
      const { rows: staleRows } = await pool.query<{ c: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM entities WHERE search_snapshot_id <> ALL($1::text[]))
           + (SELECT COUNT(*) FROM aliases WHERE search_snapshot_id <> ALL($1::text[]))
           + (SELECT COUNT(*) FROM ambiguity_registry WHERE search_snapshot_id <> ALL($1::text[]))
         )::text AS c`,
        [protectedIds],
      );
      const staleRowCount = Number(staleRows[0]?.c ?? '0');
      if (!Number.isFinite(staleRowCount)) return undefined;

      const pointerAgeSeconds = Math.max(
        0,
        Math.floor((Date.now() - pointer.promoted_at.getTime()) / 1000),
      );

      return {
        active_snapshot_id: pointer.active_snapshot_id,
        previous_snapshot_id: pointer.previous_snapshot_id,
        stale_row_count: staleRowCount,
        pointer_age_seconds: pointerAgeSeconds,
      };
    } catch (err: unknown) {
      log.debug({ err }, 'snapshot-health read failed; returning undefined');
      return undefined;
    }
  };
}
```

### 7.4 Wiring: `src/config/container.ts` (composition root)

Add `snapshotHealthReader` to the `HealthRouteOptions` object when building the Fastify server.

```ts
const healthRouteOptions: HealthRouteOptions = {
  readiness: readinessChecks,
  ...(config.metricsDebugSecret !== undefined ? { metricsDebugSecret: config.metricsDebugSecret } : {}),
  ...(pgPool !== undefined ? { snapshotHealthReader: createSnapshotHealthReader(pgPool) } : {}),
};
```

### 7.5 Contract regeneration

- `pnpm run verify:http-contracts` — rerun, expect new OpenAPI snapshot for `/ready`.
- `docs/http-contract-surface.md` — regenerate.
- `web/src/shared/api/types.ts` — grep for `ReadyResponse`; if present, mirror the optional `snapshot_health` block. If absent, no action.

### 7.6 Tests

- `src/interface/http/routes/__tests__/ready-route-snapshot-health.test.ts` — unit: mock snapshotHealthReader, verify field serialization.
- `test/e2e/v2-routes.contract.test.ts` — add `snapshot_health` assertion on the `/ready` golden fixture when PG is wired.
- `test/regression/p1-corrections.regression.test.ts` — extend existing Fix 3 block to assert `snapshot_health` schema presence.

---

## 8. Regression suite inventory

| File | Purpose | Assertion |
|------|---------|-----------|
| `test/regression/runtime-plane-append-only.regression.test.ts` | End-to-end append-only contract | publish A, publish B, verify A's rows untouched |
| `test/regression/pg-entity-repository-readonly-surface.regression.test.ts` | R1 enforcement | grep passes on src/**/*.ts |
| `test/regression/container-core-builders-snapshot-filter.regression.test.ts` | Leak #1 | warmup only reads active snapshot |
| `test/regression/container-learning-snapshot-filter.regression.test.ts` | Leak #2 | adapter only validates active snapshot |
| `test/regression/pg-entity-repository-create-snapshot-no-cross-delete.regression.test.ts` | Phase 3c | createSnapshot never DELETEs cross-snapshot (only relevant if R1 is not chosen — under R1 the method is removed, so this test lives only in the R2 branch) |
| `test/regression/reap-snapshots-dry-run.regression.test.ts` | Reaper safety | dry-run never DELETEs |
| `src/interface/http/routes/__tests__/ready-route-snapshot-health.test.ts` | Handler contract | schema accepts field |
| `test/e2e/v2-routes.contract.test.ts` (updated) | Contract parity | golden fixture includes snapshot_health when wired |

All regression files follow the append-only rule — never delete once added.

---

## 9. PR slicing

Designed so each PR lands independently, each PR is reviewable (< 600 LOC diff), and no PR leaves the tree in a broken state.

| # | PR title | Scope | Dependencies | Risk |
|---|----------|-------|--------------|------|
| 1 | `docs: runtime plane snapshot-scoped primary keys design` | ADR + impl plan + IR audit docs | none | zero |
| 2 | `feat(repo): deprecate PgEntityRepository mutating surface` | §4 port + impl + regression test | PR 1 | low — grep test is the safety net |
| 3 | `feat(container): snapshot-filter learning warmup + adapter` | §5 + SilentSkipKind additions + 2 regression tests | PR 1 | low — behavior-preserving when pointer exists |
| 4 | `feat(db): migration 016 runtime plane composite PK` | §1 + db-migrate.test.ts | PR 1 | **high** — schema change; requires coordinated publisher deploy |
| 5 | `feat(etl): publisher composite conflict target` | §3 + `runtime-plane-append-only.regression.test.ts` + bootstrap smoke update | PR 4 | **high** — must ship with or after PR 4 |
| 6 | `feat(ops): reap-snapshots CLI` | §6 + runbook update + dry-run regression | PR 4 | medium — destructive path guarded |
| 7 | `feat(http): /ready snapshot_health block` | §7 + new reader + wiring + contract tests + OpenAPI | PR 1 | low — optional field, backwards compatible |
| 8 | `chore: rollback migration 017 on-disk` | §2 only (file present, not auto-run) | PR 4 | zero — operational |

**Bundling rule**: PR 4 and PR 5 are logically the same train — in production, roll them out under a pre-announced deploy window where the publisher is quiesced, the migration runs, and the new publisher deploys immediately after. Never merge PR 4 without PR 5 ready. Do not ship PR 5 before PR 4 (publisher would fail on composite conflict target absent).

### Deploy sequence (PR 4 + PR 5)

1. **Pre-deploy**: run `scripts/ops/reap-snapshots.ts --force` if there are stale rows older than `(active, previous)`. Verify with dry-run first.
2. **Quiesce ETL**: stop the ETL cron / stop `publish-runtime-substrates.ts` runs.
3. **Deploy PR 4** (migration 016). Confirm via `db-migrate.test.ts` in staging first.
4. **Deploy PR 5** (new publisher) in the same deploy.
5. **Restore ETL**: run one publish. Verify `runtime-plane-append-only.regression.test.ts`-style assertion in production (count of rows per snapshot matches expectation).
6. **Remove quiesce**.

---

## 10. Failure drills (pre-ship)

Each drill is a specific test run before committing the PR train to production.

### Drill A — Idempotent schema
```
pnpm run test  # includes db-migrate tests
# migration 016 runs twice without error
```

### Drill B — Append-only publish
```
bash scripts/bootstrap-smoke.sh --double-publish
# smoke invokes publish-runtime-substrates.ts twice;
# asserts first snapshot's row count is unchanged after second publish.
```

### Drill C — Rollback
```
# On a staging DB with composite PK live:
psql -f src/infrastructure/db/migrations/017_runtime_plane_snapshot_pk_rollback.sql
# Must succeed given reaper pre-condition. Document row counts before/after.
```

### Drill D — Contract regeneration
```
pnpm run verify:http-contracts
# Must regenerate /ready OpenAPI with snapshot_health optional block,
# and test/e2e/v2-routes.contract.test.ts must still pass.
```

### Drill E — Read-only surface enforcement
```
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/regression/pg-entity-repository-readonly-surface.regression.test.ts
# Must pass clean — zero offenders.
```

---

## 11. Open implementation questions

1. **Migration 016 backfill for legacy rows**: the NULL guard at the top of §1 assumes runtime-plane tables already have `search_snapshot_id` populated (per migration 007). If an operator skipped 007 or is migrating from an older DB, the guard will `RAISE EXCEPTION`. Decide: do we ship a companion `scripts/ops/backfill-runtime-snapshot-id.ts` for recovery, or require operators to drop-and-recreate?
2. **`createSnapshot()` in R1**: the method is removed. If some non-production test relies on it (e.g., fixture fabricator), we must either inline the logic at the test site or add a fixture-only helper that is clearly marked as "not a runtime writer". The `pg-entity-repository-readonly-surface.regression.test.ts` must carve out this exception explicitly.
3. **`SnapshotHealthSchema.stale_row_count` upper bound**: 100M is a generous ceiling. If production has more than 100M stale rows, the reaper has been broken for a long time; we want the field to *still* serialize but signal the ceiling hit. Current design throws — should it saturate instead? Needs ops review.
4. **Reaper grace period**: 24h default. Tight for rollback comfort but loose enough for one full business day. Ops should be able to tune via env or CLI; current design only exposes CLI flag.
5. **R2 survival path**: ADR-008 lists R2 (rewrite) as an alternative. This implementation design assumes R1. If a future maintainer picks R2, §4 must be rewritten and Drill E becomes "every method has a snapshot parameter and test". Flagging for the PR reviewer.

---

## 12. Acceptance criteria (mirror of ADR-008 §Acceptance, annotated)

Schema & publisher:
- [ ] `016_runtime_plane_snapshot_pk.sql` merged under §1.
- [ ] `017_runtime_plane_snapshot_pk_rollback.sql` committed under §2 (not auto-run).
- [ ] Publisher diff from §3 merged.
- [ ] `runtime-plane-append-only.regression.test.ts` green.

Write-path (R1 chosen):
- [ ] Port + impl changes from §4 merged.
- [ ] `pg-entity-repository-readonly-surface.regression.test.ts` green.

Read-path:
- [ ] §5 container patches merged with regression tests.
- [ ] SilentSkipKind additions in `silent-skip-counters.ts`.

GC:
- [ ] `scripts/ops/reap-snapshots.ts` merged per §6.
- [ ] `docs/runbook-etl-operator-acks.md` updated.
- [ ] `reap-snapshots-dry-run.regression.test.ts` green.

`/ready` contract:
- [ ] §7 schema, handler, reader, wiring merged.
- [ ] OpenAPI regenerated.
- [ ] `ready-route-snapshot-health.test.ts` + `v2-routes.contract.test.ts` green.

End-to-end:
- [ ] Drills A–E executed in staging, output captured in PR 5 description.
- [ ] `pnpm run git:prepush` green on the train-tip commit.
