# Design 008 — IR / Interface / Contract Audit (runtime plane snapshot PK migration)

> **Status**: companion to [ADR-008](../adr/008-runtime-plane-snapshot-scoped-primary-keys.md) rev 2 and [Design 008 impl plan](008-runtime-plane-snapshot-pk-impl.md).
>
> **Purpose**: enumerate **every** typed surface — schemas, row types, JSONB validators, domain models, ports, adapters, orchestrators, HTTP contracts, observability kinds — that migration 016 touches, classify each as **NO-OP / IMPLICIT-PASS / SHAPE-CHANGE / SEMANTIC-CHANGE / DELETE**, and lock each with a regression test. Nothing in this document is speculation — every file:line is verified against the repo at 2026-04-14.
>
> **Why this doc exists**: the P1 review feedback on ADR-008 rev 1 caught two whole write-path surfaces that the ADR had silently dropped (`PgEntityRepository` mutating methods + `/ready` contract). This audit closes out that class of miss structurally: walk every IR layer, classify, lock.

---

## Legend

| Tag | Meaning |
|-----|---------|
| **NO-OP** | Surface is snapshot-independent and never touches the composite PK. Zero change. |
| **IMPLICIT-PASS** | Surface already operates correctly because it filters by active snapshot upstream, even though nothing in its own signature mentions snapshots. Requires a lock-down regression test but zero code change. |
| **SHAPE-CHANGE** | Type, interface, or schema must add/remove fields. Compile-time enforced. |
| **SEMANTIC-CHANGE** | Behavior must change without a type-level signal. Must be enforced by regression test, not compiler. |
| **DELETE** | Surface is removed. |
| **NEW** | Surface is added by this migration. |

---

## L0 — SQL schema

### L0.1 `entities` table

| Item | Before (migration 001 + 007 + 011) | After (migration 016) | Impact |
|------|-----|-----|--------|
| PK | `PRIMARY KEY (entity_id)` | `PRIMARY KEY (search_snapshot_id, entity_id)` | SHAPE-CHANGE |
| `search_snapshot_id` column | exists, nullable | exists, implicitly NOT NULL (PK forces it) | NO-OP at column level (column already there) |
| `identity_signature` uniqueness | `UNIQUE identity_signature` / `uq_entities_identity_signature` (partial) | `uq_entities_snapshot_identity_signature` on `(search_snapshot_id, identity_signature)` (partial) | SHAPE-CHANGE |
| `updated_at` trigger | none defined | unchanged | NO-OP |

Supporting test file: `src/__tests__/db-migrate.test.ts` — add re-runnability assertion (see impl §1).

### L0.2 `aliases` table

| Item | Before | After | Impact |
|------|--------|-------|--------|
| PK | `PRIMARY KEY (alias_id)` | `PRIMARY KEY (search_snapshot_id, alias_id)` | SHAPE-CHANGE |
| `is_suppressed BOOLEAN` | unchanged | unchanged | NO-OP |
| GIN trigram indexes (`idx_aliases_surface_trgm`, `idx_aliases_normalized_trgm`) | unchanged | **IMPLICIT-PASS** — these indexes do not include `search_snapshot_id`, so queries that add `WHERE search_snapshot_id = $1` still use the trigram index for the LIKE predicate and apply the snapshot filter as a post-index filter. Verified by EXPLAIN plans for `pg-blocking-adapter.ts` variants; acceptable for recall-oriented blocker. | IMPLICIT-PASS |
| `idx_aliases_entity` on `(entity_id)` | unchanged | IMPLICIT-PASS — entity lookups always join with `search_snapshot_id` via adapter queries. | IMPLICIT-PASS |

### L0.3 `ambiguity_registry` table

| Item | Before | After | Impact |
|------|--------|-------|--------|
| PK | `PRIMARY KEY (registry_id)` | `PRIMARY KEY (search_snapshot_id, registry_id)` | SHAPE-CHANGE |
| `normalized_form` uniqueness | `idx_ambiguity_normalized UNIQUE (normalized_form)` | `idx_ambiguity_snapshot_normalized UNIQUE (search_snapshot_id, normalized_form)` | SHAPE-CHANGE |

### L0.4 `entity_snapshots` table

| Item | Before | After | Impact |
|------|--------|-------|--------|
| PK | `PRIMARY KEY (snapshot_id)` | unchanged | NO-OP |
| FK `entity_id REFERENCES entities(entity_id)` | enforced | **DROPPED** (composite entities PK cannot be referenced by single-column FK cleanly) | SHAPE-CHANGE |

---

## L1 — DB row types (TypeScript `interface` shadowing SQL columns)

### L1.1 `EntityRow` — [pg-entity-repository.ts:28-38](../../src/infrastructure/adapter/pg-entity-repository.ts#L28-L38)

```ts
interface EntityRow {
  entity_id: string;
  entity_type: string;
  canonical_label: string;
  identity_signature: string;
  relations: unknown;
  attributes: unknown;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}
```

**Before audit**: no `search_snapshot_id` field. Every `SELECT * FROM entities` returns the column, but TypeScript consumers silently drop it.

**Impact**: SHAPE-CHANGE.

**Action**:
1. Add `search_snapshot_id: string` as a required field.
2. `rowToEntity()` (lines 82–110) does NOT propagate the field to `Entity` — correct, because the domain model is snapshot-agnostic. But `_rowSnapshotId()` helper should be extracted so upcoming debug traces can surface the field without re-reading the DB.
3. Under Option R1 this type survives only in `findById` / `findBySignature` / `findByType` read paths.

**Why**: currently the row type is lying by omission. A reader selecting `*` gets the column in pg result rows, but TypeScript has no guard that the reader filters by it. Making the field explicit in the type creates a compile-time tripwire for any reader that tries to read from `entities` without binding `search_snapshot_id`.

**Lock**:
```ts
// test/regression/pg-entity-row-has-snapshot.regression.test.ts
it('EntityRow TS type declares search_snapshot_id', () => {
  type EntityRowKeys = keyof import('../../src/infrastructure/adapter/pg-entity-repository.js')
    extends never
    ? never
    : never; // placeholder — real check via module-internal export
  // Since EntityRow is not exported, assert via a structural ensure function:
  const sample = {
    entity_id: 'x',
    search_snapshot_id: 's',
    entity_type: 'wine',
    canonical_label: 'x',
    identity_signature: 'sig',
    relations: {},
    attributes: {},
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
  expect(sample.search_snapshot_id).toBe('s');
});
```

Better approach — export `EntityRow` from the module and add a `satisfies`-style test. See §11.

### L1.2 `AliasRow` — [pg-alias-repository.ts:32-44](../../src/infrastructure/adapter/pg-alias-repository.ts#L32-L44)

```ts
interface AliasRow {
  alias_id: string;
  entity_id: string;
  alias_type: string;
  alias_scope: string;
  surface_form: string;
  normalized_value: string;
  source: string;
  source_trust: number;
  confidence: number;
  is_suppressed: boolean;
  created_at: Date;
}
```

**Before audit**: same gap as L1.1. Reader binds `search_snapshot_id` in SQL but type does not declare it.

**Impact**: SHAPE-CHANGE.

**Action**: add `search_snapshot_id: string`. `rowToAlias()` does not need to propagate it to `Alias` domain model (same reasoning as entities).

### L1.3 `SnapshotRow` — [pg-entity-repository.ts:40-45](../../src/infrastructure/adapter/pg-entity-repository.ts#L40-L45)

```ts
interface SnapshotRow {
  snapshot_id: string;
  entity_id: string;
  snapshot_data: unknown;
  created_at: Date;
}
```

**Impact**: DELETE (under Option R1). `SnapshotRow` is only referenced by `rollbackToSnapshot()` which R1 removes. If R2 is chosen instead, the type needs `search_snapshot_id` added.

### L1.4 `CandidateRow` — [pg-blocking-adapter.ts:8-10](../../src/infrastructure/adapter/pg-blocking-adapter.ts#L8-L10)

```ts
interface CandidateRow {
  entity_id: string;
}
```

**Impact**: NO-OP. This type is narrow by design (blocker only emits IDs). The query already binds `search_snapshot_id` (verified lines 49-96). Nothing to change.

### L1.5 `AliasRow` (pg-alias-matcher variant)

Referenced inside [pg-alias-matcher.ts:284-382](../../src/infrastructure/adapter/pg-alias-matcher.ts#L284-L382). Let me note: **pg-alias-matcher.ts uses its own anonymous row type inline**, not a shared interface. Verify that every select statement is explicitly typed and includes `search_snapshot_id` in the binding.

**Impact**: IMPLICIT-PASS (already verified in [adr-008 §3 Reader path verification](../adr/008-runtime-plane-snapshot-scoped-primary-keys.md)).

---

## L2 — JSONB validation schemas (`jsonb-schemas.ts`)

All schemas in [src/infrastructure/adapter/jsonb-schemas.ts](../../src/infrastructure/adapter/jsonb-schemas.ts).

| Schema | Lines | Impact | Reason |
|--------|-------|--------|--------|
| `DecisionSnapshotJsonbSchema` | 60-70 | NO-OP | decision snapshot is separate from runtime plane; snapshot_id field inside payload is the decision snapshot, not the publish snapshot |
| `EvidenceItemJsonbSchema` | 97-104 | NO-OP | evidence items are resolver artifacts; unrelated |
| `EntityRowSnapshotJsonbSchema` | 152-162 | **DELETE** under R1 (only used by `rollbackToSnapshot()` + `createSnapshot()`). Under R2, must add `search_snapshot_id` field | SHAPE-CHANGE or DELETE |
| `RelationsJsonbSchema` | 175-179 | NO-OP | relation payload is entity-level, not snapshot-level |
| `EntityAttributesJsonbSchema` | 209-221 | NO-OP | same |

**Action under R1**: delete `EntityRowSnapshotJsonbSchema` and `parseEntityRowSnapshotJsonb` helper (if exported). Remove associated regression tests that depend on the type.

**Action under R2**: add `search_snapshot_id: z.string().min(1)` to `EntityRowSnapshotJsonbSchema` since the rollback path must restore the per-snapshot row.

**Test lock**:
```ts
// test/regression/pg-entity-repository-rollback-jsonb-schema-absent.regression.test.ts
it('EntityRowSnapshotJsonbSchema is absent under R1', () => {
  const module = await import('../../src/infrastructure/adapter/jsonb-schemas.js');
  expect(module.EntityRowSnapshotJsonbSchema).toBeUndefined();
});
```

---

## L3 — ETL record types & Zod validators (`search-snapshot-schema.ts`)

All definitions in [scripts/etl/search-snapshot-schema.ts](../../scripts/etl/search-snapshot-schema.ts).

| Type | Lines | Has `search_snapshot_id`? | Impact | Reason |
|------|-------|---------------------------|--------|--------|
| `EntitySnapshotRecord` | 24-32 | ❌ | NO-OP | The NDJSON record format does NOT include `search_snapshot_id` — the publisher injects it via `buildEntityRowsJson(entities, manifest.snapshotId)` at publish time. Keeping the NDJSON record format snapshot-agnostic is the correct invariant: the NDJSON is "what a snapshot contains", and the outer manifest carries the snapshot ID. |
| `AliasSnapshotRecord` | 12-22 | ❌ | NO-OP | same |
| `AmbiguityRegistrySnapshotRow` | 34-40 | ❌ | NO-OP | same |
| `SearchSnapshotManifest` + `SearchSnapshotManifestSchema` | 42-139 | ✅ (via `snapshotId`) | NO-OP | The manifest is the source of truth for the snapshot ID that gets injected. Unchanged. |
| `SearchSnapshotRuntimeState` + schema | 84-163 | ✅ (via `snapshotId`) | NO-OP | Runtime state file — consumed by readiness checks. Unchanged. |

**Action**: none, but add an **invariant test** that proves record types never accidentally pick up `search_snapshot_id` as an explicit field (keeping the plane separation clean):

```ts
// test/regression/etl-snapshot-record-purity.regression.test.ts
import type { EntitySnapshotRecord } from '../../scripts/etl/search-snapshot-schema.js';

it('EntitySnapshotRecord does not carry search_snapshot_id field', () => {
  const record: EntitySnapshotRecord = {
    entityId: 'x',
    entityType: 'wine',
    canonicalLabel: 'x',
    identitySignature: 'x',
    relations: {},
    attributes: {},
    metadata: {},
  };
  expect('search_snapshot_id' in record).toBe(false);
});
```

**Why**: if a future refactor tries to shortcut and embed `search_snapshot_id` into the NDJSON record, the publisher's "single source of truth = manifest" contract cracks. The test locks the separation.

### L3.1 `buildEntityRowsJson` / `buildAliasRowsJson` / `buildAmbiguityRowsJson`

These helpers (publisher internals) produce the `jsonb_to_recordset` input. They already inject `search_snapshot_id` from `manifest.snapshotId`.

**Impact**: IMPLICIT-PASS. No change required; verify the ETL double-publish regression test covers them.

---

## L4 — Domain models (entity / alias / ambiguity)

### L4.1 `Entity` — [src/domain/entity/model/entity.ts:32-40](../../src/domain/entity/model/entity.ts#L32-L40)

```ts
export interface Entity {
  readonly id: CanonicalEntityId;
  readonly type: EntityType;
  readonly canonicalLabel: string;
  readonly identitySignature: string;
  readonly relations: Relations;
  readonly attributes: EntityAttributes;
  readonly metadata: EntityMetadata;
}
```

**Impact**: NO-OP.

**Reasoning**: the domain model is snapshot-agnostic **by design**. A single request runs under a single active snapshot, so the `Entity` that crosses the port boundary need not carry `search_snapshot_id`. Every `findById` call is already scoped by the pool's active pointer via `resolveActiveSnapshot`.

**Anti-goal**: do NOT add `search_snapshot_id` to the `Entity` interface. That would leak infrastructure into the domain and require every consumer to reason about snapshot lifecycle. The IR separation is correct as-is.

**Lock**:
```ts
// test/regression/entity-domain-snapshot-agnostic.regression.test.ts
import type { Entity } from '../../src/domain/entity/model/entity.js';

it('Entity domain model has no search_snapshot_id field', () => {
  const e: Entity = {
    id: 'x' as CanonicalEntityId,
    type: 'wine',
    canonicalLabel: 'Opus One',
    identitySignature: 'sig',
    relations: {},
    attributes: {},
    metadata: { createdAt: new Date(), updatedAt: new Date() },
  };
  expect('search_snapshot_id' in e).toBe(false);
  expect('searchSnapshotId' in e).toBe(false);
});
```

### L4.2 `Alias` — [src/domain/alias/model/alias.ts:41-67](../../src/domain/alias/model/alias.ts#L41-L67)

Same reasoning and same lock as §L4.1. NO-OP.

### L4.3 `AmbiguityState` — [src/domain/resolver/model/ambiguity-state.ts:22-31](../../src/domain/resolver/model/ambiguity-state.ts#L22-L31)

NO-OP. Classification result, not a storage surface.

### L4.4 `EntityMetadata` — [entity.ts:21-26](../../src/domain/entity/model/entity.ts#L21-L26)

NO-OP. No snapshot field, no action.

---

## L5 — Resolver IR (candidate types feeding decision)

### L5.1 `ResolverCandidate` — [resolved-candidate.ts:67-107](../../src/domain/resolver/model/resolved-candidate.ts#L67-L107)

NO-OP. Snapshot-agnostic by design; resolver operates on a single active snapshot per request.

### L5.2 `ResolvedCandidate` — [resolved-candidate.ts:11-61](../../src/domain/resolver/model/resolved-candidate.ts#L11-L61)

NO-OP. Same as L5.1.

### L5.3 `MatchSignalSet` — [match-signal-set.ts:8-44](../../src/domain/resolver/model/match-signal-set.ts#L8-L44)

NO-OP. 12 required numeric fields; zero snapshot coupling.

### L5.4 `HybridCandidate` — [src/domain/retrieval/model/hybrid-candidate.ts](../../src/domain/retrieval/model/hybrid-candidate.ts)

NO-OP.

### L5.5 `AliasMatchInfo` — [resolved-candidate.ts:112-121](../../src/domain/resolver/model/resolved-candidate.ts#L112-L121)

NO-OP.

---

## L6 — Port interfaces

### L6.1 `EntityRepository` (runtime) — [src/domain/entity/port/entity-repository.port.ts](../../src/domain/entity/port/entity-repository.port.ts)

**Before**: 8 methods (3 read + 5 mutate).

**After (R1 — recommended)**: 3 methods (`findById`, `findBySignature`, `findByType`).

**Impact**: SHAPE-CHANGE (method list shrinks).

**Risk**:
- Consumers: grep confirms **only** `TraversalService.traverse` (read `findById`) and `PgEntityRepository` (implementation). No mutating callers in `src/` tree.
- `src/domain/ingestion/service/entity-matcher.ts` declares its own separate `EntityRepository` interface — **unrelated to this port**. Keep untouched.

**Lock**:
```ts
// test/regression/pg-entity-repository-readonly-surface.regression.test.ts
// (from impl plan §4.4, extended with the ingestion interface carve-out)
const PORT_PATH = 'src/domain/entity/port/entity-repository.port.ts';
const portSrc = readFileSync(resolve(REPO_ROOT, PORT_PATH), 'utf8');
expect(portSrc).not.toMatch(/save\s*\(/);
expect(portSrc).not.toMatch(/update\s*\(/);
expect(portSrc).not.toMatch(/delete\s*\(/);
expect(portSrc).not.toMatch(/createSnapshot\s*\(/);
expect(portSrc).not.toMatch(/rollbackToSnapshot\s*\(/);
```

### L6.2 `AliasRepository` — [src/domain/alias/port/alias-repository.port.ts](../../src/domain/alias/port/alias-repository.port.ts)

**Before**: 7 methods.
- Read: `findByValue`, `findByEntity`, `findByNormalizedValue`, `findFuzzyCandidates`
- Write: `save`, `suppress`, `bulkSave`

**Runtime consumer scan** (2026-04-14 grep):
- `container-learning.ts:66` constructs `PgAliasRepository` and passes it only to `adversarialGuardPort.isAdversarial`, which calls `findByNormalizedValue` (line 77). **No runtime writer.**
- `scripts/etl/generate-transliteration-aliases.ts:85` constructs `PgAliasRepository` and calls `save()` directly — this is the **only live writer** and it's an ETL escape hatch, not a runtime path (see §L11).

**Impact**: SHAPE-CHANGE under R1. Remove `save`, `suppress`, `bulkSave` from the port; ETL script must be rewritten to produce NDJSON.

**Alternative (less invasive)**: keep `save`/`suppress`/`bulkSave` on the port but mark as `@deprecated use publish-runtime-substrates.ts`, and have `PgAliasRepository.save/suppress/bulkSave` throw `UnsupportedOperationError` under composite PK semantics. This is **NOT recommended** — it leaves a footgun on the interface.

**Recommendation**: follow R1. Delete the write methods from the port. Rewrite `generate-transliteration-aliases.ts` to emit NDJSON that the snapshot builder consumes (see §L11 action).

**Lock**:
```ts
// test/regression/alias-repository-port-readonly-surface.regression.test.ts
const PORT_PATH = 'src/domain/alias/port/alias-repository.port.ts';
const src = readFileSync(resolve(REPO_ROOT, PORT_PATH), 'utf8');
expect(src).not.toMatch(/\bsave\s*\(/);
expect(src).not.toMatch(/\bsuppress\s*\(/);
expect(src).not.toMatch(/\bbulkSave\s*\(/);
```

### L6.3 `BlockingPort` — [src/domain/resolver/port/blocking.port.ts](../../src/domain/resolver/port/blocking.port.ts)

**Impact**: NO-OP.

The interface accepts `(query, normalizedQuery, limit?)` and returns `CanonicalEntityId[]`. No snapshot signal at the port level — adapter (`PgBlockingAdapter`) resolves the active snapshot internally. This is the correct layering.

### L6.4 `AmbiguityDictionary` — [src/domain/query/port/ambiguity-dictionary.port.ts](../../src/domain/query/port/ambiguity-dictionary.port.ts)

**Impact**: NO-OP. Same pattern as BlockingPort.

### L6.5 `EntityRepository` (ingestion) — [src/domain/ingestion/service/entity-matcher.ts:44-53](../../src/domain/ingestion/service/entity-matcher.ts#L44-L53)

**Separate interface** from L6.1 — ingestion/canonicalization, not runtime lookup. Has methods `findByExternalRef`, `findByProducerAndLabel`, `findByLabelAndRegion`, `findByAlias` — all reads.

**Impact**: NO-OP. Unrelated to runtime plane snapshot PK. Do not conflate with L6.1.

**Test lock**: carve-out in the readonly-surface regression test so it doesn't scan this file:
```ts
// exclude src/domain/ingestion/**
if (rel.startsWith('src/domain/ingestion/')) continue;
```

### L6.6 `TraversalService` consumer — [entity/service/traversal.service.ts:91](../../src/domain/entity/service/traversal.service.ts#L91)

Only calls `findById`. R1 deprecation does not break it.

**Lock**: ensure `traversal.service.ts` compiles after R1 via standard type check.

---

## L7 — Adapter implementations

### L7.1 `PgEntityRepository` — [src/infrastructure/adapter/pg-entity-repository.ts](../../src/infrastructure/adapter/pg-entity-repository.ts)

Covered in ADR-008 §5 and impl plan §4. Under R1:
- Delete: `save` (149-195), `update` (197-225), `delete` (227-235), `createSnapshot` (237-293), `rollbackToSnapshot` (295+)
- Keep: `findById` (119-127), `findBySignature` (129-137), `findByType` (139-147), `rowToEntity` helper, `resolveActiveSnapshotId` helper
- Expected LOC: ~370 → ~150

**Impact**: SHAPE-CHANGE (method removal). All 5 mutation methods DELETE.

**Lock**: `pg-entity-repository-readonly-surface.regression.test.ts` (impl plan §4.4).

### L7.2 `PgAliasRepository` — [src/infrastructure/adapter/pg-alias-repository.ts](../../src/infrastructure/adapter/pg-alias-repository.ts)

**New finding** (not in ADR rev 1 or rev 2): structural problem identical to L7.1.

- `save()` (127-154): `INSERT INTO aliases (alias_id, entity_id, alias_type, alias_scope, surface_form, normalized_value, source, confidence, is_suppressed)` — **column list omits `search_snapshot_id`**. Under composite PK + NOT NULL, this fails at runtime.
- `save()` conflict target `ON CONFLICT (alias_id)` — invalid after composite PK.
- `suppress()` (156-161): `UPDATE aliases SET is_suppressed = TRUE WHERE alias_id = $1` — touches **every snapshot row** for that alias. Cross-snapshot corruption under composite PK.
- `bulkSave()` (163-204): same issues as `save()`.

**Impact**: DELETE under R1 (recommended), or SHAPE-CHANGE + SEMANTIC-CHANGE under R2.

**Action under R1**:
1. Delete `save`, `suppress`, `bulkSave` methods.
2. Barrel export in `src/infrastructure/index.ts:8` stays — the class is still exported for its read methods.
3. `generate-transliteration-aliases.ts` (the only writer) must be rewritten to emit NDJSON artifacts that the snapshot builder picks up. See §L11.
4. Learning subsystem stays unchanged (it only calls `findByNormalizedValue`).

**Action under R2**: rewrite `save`/`bulkSave` to accept `snapshotId`, include `search_snapshot_id` in the INSERT column list, change conflict target to `(search_snapshot_id, alias_id)`. Rewrite `suppress` to require `snapshotId`. But this contradicts the "single writer authority = ETL publisher" invariant from ADR-008 §Axis 3, so R1 is strongly preferred.

**Lock**:
```ts
// test/regression/pg-alias-repository-readonly-surface.regression.test.ts
it('PgAliasRepository does not expose mutating methods', async () => {
  const source = readFileSync(
    resolve(REPO_ROOT, 'src/infrastructure/adapter/pg-alias-repository.ts'),
    'utf8',
  );
  expect(source).not.toMatch(/async save\s*\(/);
  expect(source).not.toMatch(/async suppress\s*\(/);
  expect(source).not.toMatch(/async bulkSave\s*\(/);
});

it('no production TS file calls PgAliasRepository mutating methods', () => {
  // Same AST grep pattern as pg-entity-repository-readonly-surface test
});
```

### L7.3 `PgBlockingAdapter` — [src/infrastructure/adapter/pg-blocking-adapter.ts](../../src/infrastructure/adapter/pg-blocking-adapter.ts)

**Impact**: NO-OP. Already snapshot-scoped (verified lines 49-96). Silent-skip counter instrumentation added in bugbash 2026-04-14 wave 2.

**Lock**: existing `pg-blocking-adapter.test.ts`.

### L7.4 `PgAmbiguityDictionary` — [src/infrastructure/adapter/pg-ambiguity-dictionary.ts](../../src/infrastructure/adapter/pg-ambiguity-dictionary.ts)

**Impact**: NO-OP. Both `isKnownAmbiguous` and `getAmbiguityInfo` already filter by `search_snapshot_id` (lines 15, 30).

### L7.5 `PgAliasMatcher` — [src/infrastructure/adapter/pg-alias-matcher.ts](../../src/infrastructure/adapter/pg-alias-matcher.ts)

**Impact**: NO-OP. Already snapshot-scoped in both query variants (lines 284-382).

### L7.6 Other adapters (`pg-snapshot-store`, `pg-lineage-store`, `pg-ltr-model-registry`, `pg-proposal-store`, `pg-feedback-store`, `pg-calibration-store`, `pg-threshold-store`, `pg-eval-result-store`, `pg-gold-set-store`)

**Impact**: NO-OP. None of these operate on `entities` / `aliases` / `ambiguity_registry`. Verified by grep: `FROM entities|aliases|ambiguity_registry` only hits the adapters and scripts already enumerated.

---

## L8 — Service orchestrators

### L8.1 `TraversalService` — [src/domain/entity/service/traversal.service.ts](../../src/domain/entity/service/traversal.service.ts)

**Impact**: NO-OP. Only uses `entityRepo.findById()` (read). Under R1, the method is retained.

### L8.2 `EntityMatcher` (ingestion) — [src/domain/ingestion/service/entity-matcher.ts](../../src/domain/ingestion/service/entity-matcher.ts)

**Impact**: NO-OP. Uses its own ingestion-layer `EntityRepository` interface (§L6.5), not the runtime port.

### L8.3 `AliasProposer` / `PromotionGate` (learning subsystem) — [src/config/container-learning.ts](../../src/config/container-learning.ts)

**Current wiring**:
- `container-learning.ts:63` instantiates `AliasProposer(proposalStore, aliasChecker)`.
- `aliasChecker` is built inline via `buildPgAliasChecker(pool)` at lines 28-40 — a small inline adapter that shells out to a raw SQL query (see §L10.1 below).
- `promotionGate` uses `adversarialGuardPort.isAdversarial`, which calls `aliasRepository.findByNormalizedValue()` at line 77.

**Impact**:
- `AliasProposer`: NO-OP. Writes proposals to `proposalStore`, not to runtime `aliases`. Proposal → approval → eventual ETL publish, so write path goes through the publisher.
- `PromotionGate`: NO-OP. Read-only use of alias repository.

**Lock**: existing learning tests (feedback-processor, alias-proposer) cover the absence of direct runtime writes.

---

## L9 — HTTP wire contracts

### L9.1 `ReadyResponseSchema` — [src/interface/http/routes/route-contracts.ts:112-127](../../src/interface/http/routes/route-contracts.ts#L112-L127)

**Before**: `{ ready, timestamp, checks }` with strict checks record.

**After (per impl plan §7.1)**: adds optional `snapshot_health: SnapshotHealthSchema.optional()` nested object.

**Impact**: SHAPE-CHANGE — wire contract gains an optional field. Backwards-compatible for existing consumers.

**New sub-schema** (to be added):
```ts
const SnapshotHealthSchema = z.object({
  active_snapshot_id: z.string().min(1),
  previous_snapshot_id: z.string().min(1).nullable(),
  stale_row_count: z.number().int().nonnegative().max(SNAPSHOT_HEALTH_MAX_STALE_ROWS),
  pointer_age_seconds: z.number().int().nonnegative(),
}).strict();
```

**Lock**:
- `src/interface/http/routes/__tests__/ready-route-snapshot-health.test.ts` (impl plan §7.6).
- `test/e2e/v2-routes.contract.test.ts` golden fixture.
- `pnpm run verify:http-contracts` passes (OpenAPI regenerated).

### L9.2 `SearchResponseV1` — [src/domain/response/model/search-response.ts](../../src/domain/response/model/search-response.ts)

**Impact**: NO-OP. The search response already carries `meta.decisionSnapshot.snapshot_id`, which is orthogonal to the runtime-plane snapshot ID (it's the decision snapshot per RFC-009). Unchanged.

### L9.3 `ReadyResponse` handler interface — [src/interface/http/routes/health.route.ts:101-111](../../src/interface/http/routes/health.route.ts#L101-L111)

**Impact**: SHAPE-CHANGE. Add `readonly snapshot_health?: SnapshotHealth` to the TS interface mirroring the Zod schema. Exact diff in impl plan §7.2.

### L9.4 `HealthRouteOptions` — [health.route.ts:77-87](../../src/interface/http/routes/health.route.ts#L77-L87)

**Impact**: SHAPE-CHANGE. Add `readonly snapshotHealthReader?: () => Promise<SnapshotHealth | undefined>`. Optional so tests/dev environments without PG still boot. Impl plan §7.2.

### L9.5 `ReadyRouteContract` — [route-contracts.ts:207-213](../../src/interface/http/routes/route-contracts.ts#L207-L213)

**Impact**: NO-OP at the contract declaration level — the `ReadyResponseSchema` reference is unchanged. The change bubbles up through the schema.

---

## L10 — Cross-cutting observability & helpers

### L10.1 `buildPgAliasChecker` (inline adapter in container-learning.ts)

[container-learning.ts:28-40](../../src/config/container-learning.ts#L28-L40):

```ts
function buildPgAliasChecker(pool: Pool): ExistingAliasChecker {
  return {
    async aliasExists(surfaceForm: string): Promise<boolean> {
      const result = await pool.query(
        `SELECT 1 FROM aliases
         WHERE surface_form = $1 AND is_suppressed = FALSE
         LIMIT 1`,
        [surfaceForm],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}
```

**New finding** (not in ADR-008 rev 1/rev 2 nor impl plan §5): this inline adapter has the **same pre-filter leak** as the two fixed in impl plan §5. It must be patched in the same PR as §5.

**Impact**: SEMANTIC-CHANGE. Query must bind `search_snapshot_id`.

**Patch**:
```ts
function buildPgAliasChecker(pool: Pool): ExistingAliasChecker {
  return {
    async aliasExists(surfaceForm: string): Promise<boolean> {
      try {
        const { activeSnapshotId } = await resolveActiveSnapshot(pool);
        const result = await pool.query(
          `SELECT 1 FROM aliases
           WHERE surface_form = $1
             AND search_snapshot_id = $2
             AND is_suppressed = FALSE
           LIMIT 1`,
          [surfaceForm, activeSnapshotId],
        );
        return (result.rowCount ?? 0) > 0;
      } catch (err: unknown) {
        if (readPgSqlState(err) === '42P01') {
          globalSilentSkipCounter.increment(
            'alias_checker_disabled_snapshot_pointer_missing',
            { surface: 'container-learning.buildPgAliasChecker' },
          );
          return false;
        }
        throw err;
      }
    },
  };
}
```

**SilentSkipKind addition**: `'alias_checker_disabled_snapshot_pointer_missing'` (adds to the list in impl plan §5 alongside `learning_warmup_disabled_snapshot_pointer_missing` and `learning_adapter_disabled_snapshot_pointer_missing`).

**Lock**: new regression test `container-learning-alias-checker-snapshot-filter.regression.test.ts`.

### L10.2 `resolveActiveSnapshot` — [src/infrastructure/db/active-snapshot-resolver.ts](../../src/infrastructure/db/active-snapshot-resolver.ts)

**Impact**: NO-OP. Already the canonical seam; every reader uses it. No changes needed.

**Note**: the 2-second TTL cache (line 43) means a rollback takes up to 2 seconds to propagate. Acceptable. Not affected by this migration.

### L10.3 `SilentSkipKind` union — [src/observability/silent-skip-counters.ts:21-30](../../src/observability/silent-skip-counters.ts)

**Current state**: union was extended in bugbash wave 2 with 4 blocker kinds; this migration adds:
- `learning_warmup_disabled_snapshot_pointer_missing` (impl plan §5.1)
- `learning_adapter_disabled_snapshot_pointer_missing` (impl plan §5.2)
- `alias_checker_disabled_snapshot_pointer_missing` (§L10.1, new in this audit)

**Impact**: SHAPE-CHANGE. Union grows by 3 members.

**Lock**: existing `silent-skip-counters.test.ts` covers union exhaustiveness via `SILENT_SKIP_KINDS` array parity.

### L10.4 `CorruptedJsonbError` — [src/infrastructure/adapter/jsonb-schemas.ts:26-38](../../src/infrastructure/adapter/jsonb-schemas.ts#L26-L38)

**Impact**: NO-OP. Error class itself is unchanged; only the `EntityRowSnapshotJsonbSchema` usage goes away under R1.

### L10.5 `NoActiveSnapshotPointerError` — [active-snapshot-resolver.ts:28-36](../../src/infrastructure/db/active-snapshot-resolver.ts#L28-L36)

**Impact**: NO-OP. Already distinguishes "table missing" (42P01, degrade) from "row missing" (throw). Adapters that add new paths must respect this.

---

## L11 — ETL escape hatches (write paths bypassing the publisher)

### L11.1 `scripts/etl/generate-transliteration-aliases.ts`

**Two structural issues** (neither covered by ADR-008 rev 1 or rev 2):

1. **Direct `PgAliasRepository.save()` write path** (line 85, ~line 130+):
   - Bypasses `publish-runtime-substrates.ts`.
   - Under composite PK, `save()` fails at runtime (column list, conflict target).
   - Under R1, the method is deleted — script fails to compile.

2. **Snapshot-unfiltered `SELECT FROM entities`** (line 88):
   ```ts
   let query = `SELECT entity_id, canonical_label, attributes FROM entities`;
   ```
   No `WHERE search_snapshot_id = $1` binding. Script reads across all snapshots — produces aliases derived from stale entity states.

**Impact**: both SEMANTIC-CHANGE.

**Action**: rewrite the script as a **snapshot artifact producer**, not a runtime writer.

Shape of the rewrite:
1. Resolve active snapshot from the target DB pool (or accept `--snapshot-id` CLI arg).
2. `SELECT entity_id, canonical_label, attributes FROM entities WHERE search_snapshot_id = $1`.
3. Generate transliteration variants in memory.
4. Emit NDJSON with `AliasSnapshotRecord` shape (§L3) to `data/transliteration-aliases.ndjson`.
5. The snapshot builder (`build-search-snapshot.ts` or upstream) picks up the NDJSON and merges into the next snapshot's aliases artifact.
6. The next `publish-runtime-substrates.ts` run writes the new aliases into the snapshot-scoped composite PK table, via the canonical path.

**Alternatives**:
- Keep the direct write under R2 and scope it to a specific snapshot ID. Strongly disrecommended — any ETL writer besides `publish-runtime-substrates.ts` breaks the "single writer authority" invariant.
- Delete the script entirely. Possible if operators confirm it's no longer run in production. Verify via runbooks + CI/CD.

**Lock**:
```ts
// test/regression/pg-alias-repository-etl-caller-absent.regression.test.ts
it('no ETL script calls PgAliasRepository mutating methods', () => {
  const etlFiles = globSync('scripts/etl/**/*.ts', { cwd: REPO_ROOT });
  const offenders: string[] = [];
  for (const file of etlFiles) {
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    if (/PgAliasRepository[\s\S]*\.save\s*\(/.test(src)) offenders.push(file);
    if (/aliasRepository\.save\s*\(/.test(src)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
```

### L11.2 Other ETL scripts writing to runtime plane

Grep target: `INSERT INTO (entities|aliases|ambiguity_registry)` in `scripts/etl/**`.

**Known hits**:
- `publish-runtime-substrates.ts` — the canonical writer. Stays.
- `generate-transliteration-aliases.ts` — §L11.1.

**Action**: re-run the grep as part of Phase 3 of impl plan, verify no additional writers landed between ADR merge and implementation. Add a regression test:

```ts
// test/regression/runtime-plane-insert-authority.regression.test.ts
it('only publish-runtime-substrates.ts writes INTO entities/aliases/ambiguity_registry', () => {
  const etlFiles = globSync('scripts/etl/**/*.ts', { cwd: REPO_ROOT });
  const pattern = /INSERT\s+INTO\s+(entities|aliases|ambiguity_registry)/i;
  const offenders: string[] = [];
  for (const file of etlFiles) {
    if (file.endsWith('publish-runtime-substrates.ts')) continue;
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    if (pattern.test(src)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
```

### L11.3 SQL tool scripts (`scripts/ops/t3-runtime-namespace-audit.sql`)

**Impact**: NO-OP — audit-only read script. Verify via grep that it's read-only; no `INSERT/UPDATE/DELETE` against runtime plane.

---

## L12 — Test fixture & replay surfaces

### L12.1 Replay fixtures (`test/replay-fixtures/`)

Fixtures include `entity_id` strings (e.g. `"opus-one-2018"`). They do **not** include `search_snapshot_id` because fixture execution runs against a test snapshot that the harness controls.

**Impact**: NO-OP.

**Risk**: if a fixture hardcodes a snapshot ID that no longer exists after composite PK migration, the fixture breaks. Mitigation: the fixture harness resolves snapshot IDs via the test-snapshot builder, not via hardcoding.

**Lock**: existing `test/unit/replay-fixtures/run-search-replay.test.ts`.

### L12.2 Test mocks (`container-core.test.ts`, `pg-*.test.ts`)

Mocks of `EntityRepository` / `AliasRepository` use partial implementations. Under R1 they must stop referencing the deleted methods.

**Impact**: SHAPE-CHANGE. Test files that reference deleted methods fail to compile.

**Action**: update mock definitions in parallel with the R1 PR. Specifically:
- `src/domain/ingestion/__tests__/entity-matcher.test.ts` — uses the **ingestion** `EntityRepository`, not the runtime port. NO-OP (verified §L6.5).
- Any other mock that references `save`/`update`/`delete`/`createSnapshot`/`rollbackToSnapshot` — grep and update.

**Lock**: `tsc --noEmit` in pre-push catches any dangling mock.

### L12.3 Integration test DBs (`bootstrap-smoke.sh`)

**Impact**: SHAPE-CHANGE. The smoke must run migrations 001–016 (previously 001–015). Verify `bootstrap-smoke.sh` iterates over all SQL files and applies them in order.

**Action**: add the "publish × 2" assertion from impl plan §1 Drill B.

---

## L13 — Summary table (all surfaces, single view)

| Layer | Surface | File:lines | Impact | Action | Lock |
|-------|---------|------------|--------|--------|------|
| L0 | `entities` table PK + `uq_entities_identity_signature` | migration 001, 011 | SHAPE-CHANGE | migration 016 | `db-migrate.test.ts` |
| L0 | `aliases` table PK | migration 001 | SHAPE-CHANGE | migration 016 | `db-migrate.test.ts` |
| L0 | `ambiguity_registry` PK + `idx_ambiguity_normalized` | migration 001 | SHAPE-CHANGE | migration 016 | `db-migrate.test.ts` |
| L0 | `entity_snapshots.entity_id` FK | migration 001 | SHAPE-CHANGE (drop) | migration 016 | `db-migrate.test.ts` |
| L1 | `EntityRow` interface | pg-entity-repository.ts:28-38 | SHAPE-CHANGE | add `search_snapshot_id` | `pg-entity-row-has-snapshot.regression.test.ts` |
| L1 | `AliasRow` interface | pg-alias-repository.ts:32-44 | SHAPE-CHANGE | add `search_snapshot_id` | same pattern |
| L1 | `SnapshotRow` interface | pg-entity-repository.ts:40-45 | DELETE (R1) | delete with method | compile check |
| L1 | `CandidateRow` interface | pg-blocking-adapter.ts:8-10 | NO-OP | — | existing |
| L2 | `DecisionSnapshotJsonbSchema` | jsonb-schemas.ts:60 | NO-OP | — | existing |
| L2 | `EvidenceItemJsonbSchema` | jsonb-schemas.ts:97 | NO-OP | — | existing |
| L2 | `EntityRowSnapshotJsonbSchema` | jsonb-schemas.ts:152 | DELETE (R1) | delete with `rollbackToSnapshot` | `pg-entity-repository-rollback-jsonb-schema-absent.regression.test.ts` |
| L2 | `RelationsJsonbSchema` | jsonb-schemas.ts:175 | NO-OP | — | existing |
| L2 | `EntityAttributesJsonbSchema` | jsonb-schemas.ts:209 | NO-OP | — | existing |
| L3 | `EntitySnapshotRecord` | search-snapshot-schema.ts:24 | NO-OP | — | `etl-snapshot-record-purity.regression.test.ts` |
| L3 | `AliasSnapshotRecord` | search-snapshot-schema.ts:12 | NO-OP | — | same |
| L3 | `AmbiguityRegistrySnapshotRow` | search-snapshot-schema.ts:34 | NO-OP | — | same |
| L3 | `SearchSnapshotManifestSchema` | search-snapshot-schema.ts:108 | NO-OP | — | existing |
| L3 | `SearchSnapshotRuntimeStateSchema` | search-snapshot-schema.ts:141 | NO-OP | — | existing |
| L4 | `Entity` domain model | entity.ts:32-40 | NO-OP | — | `entity-domain-snapshot-agnostic.regression.test.ts` |
| L4 | `Alias` domain model | alias.ts:41-67 | NO-OP | — | same pattern |
| L4 | `AmbiguityState` | ambiguity-state.ts:22 | NO-OP | — | existing |
| L5 | `ResolverCandidate` | resolved-candidate.ts:67 | NO-OP | — | existing |
| L5 | `ResolvedCandidate` | resolved-candidate.ts:11 | NO-OP | — | existing |
| L5 | `MatchSignalSet` | match-signal-set.ts:8 | NO-OP | — | existing |
| L5 | `HybridCandidate` | hybrid-candidate.ts | NO-OP | — | existing |
| L6 | `EntityRepository` port (runtime) | entity-repository.port.ts | SHAPE-CHANGE (R1) | delete 5 mutating methods | `pg-entity-repository-readonly-surface.regression.test.ts` |
| L6 | `AliasRepository` port | alias-repository.port.ts | SHAPE-CHANGE (R1) | delete `save`/`suppress`/`bulkSave` | `alias-repository-port-readonly-surface.regression.test.ts` |
| L6 | `BlockingPort` | blocking.port.ts | NO-OP | — | existing |
| L6 | `AmbiguityDictionary` port | ambiguity-dictionary.port.ts | NO-OP | — | existing |
| L6 | `EntityRepository` port (ingestion) | entity-matcher.ts:44 | NO-OP | — | carve-out in regression test |
| L7 | `PgEntityRepository` | pg-entity-repository.ts | DELETE methods (R1) | impl plan §4 | readonly-surface test |
| L7 | `PgAliasRepository` | pg-alias-repository.ts | DELETE methods (R1) | impl plan §4 extension | `pg-alias-repository-readonly-surface.regression.test.ts` |
| L7 | `PgBlockingAdapter` | pg-blocking-adapter.ts | NO-OP | — | existing |
| L7 | `PgAmbiguityDictionary` | pg-ambiguity-dictionary.ts | NO-OP | — | existing |
| L7 | `PgAliasMatcher` | pg-alias-matcher.ts | NO-OP | — | existing |
| L8 | `TraversalService` | traversal.service.ts | NO-OP | — | tsc |
| L8 | `EntityMatcher` (ingestion) | entity-matcher.ts | NO-OP | — | existing |
| L8 | `AliasProposer` / `PromotionGate` | container-learning.ts | NO-OP | — | existing |
| L9 | `ReadyResponseSchema` | route-contracts.ts:112-127 | SHAPE-CHANGE | add `snapshot_health.optional()` | `ready-route-snapshot-health.test.ts` |
| L9 | `ReadyResponse` TS interface | health.route.ts:101-111 | SHAPE-CHANGE | mirror schema | tsc |
| L9 | `HealthRouteOptions` | health.route.ts:77-87 | SHAPE-CHANGE | add `snapshotHealthReader?` | tsc |
| L9 | `SearchResponseV1` | search-response.ts | NO-OP | — | existing |
| L10 | `buildPgAliasChecker` inline adapter | container-learning.ts:28-40 | SEMANTIC-CHANGE | add snapshot filter + fallback | `container-learning-alias-checker-snapshot-filter.regression.test.ts` |
| L10 | `resolveActiveSnapshot` | active-snapshot-resolver.ts | NO-OP | — | existing |
| L10 | `SilentSkipKind` union | silent-skip-counters.ts:21-30 | SHAPE-CHANGE | +3 kinds | parity test |
| L10 | `CorruptedJsonbError` | jsonb-schemas.ts:26 | NO-OP | — | existing |
| L11 | `generate-transliteration-aliases.ts` | scripts/etl/generate-transliteration-aliases.ts | SEMANTIC-CHANGE | rewrite as NDJSON producer | `pg-alias-repository-etl-caller-absent.regression.test.ts` |
| L11 | Other ETL writers | grep pattern `INSERT INTO entities\|aliases\|ambiguity_registry` | NO-OP (grep currently clean except publisher + transliteration) | verify | `runtime-plane-insert-authority.regression.test.ts` |
| L12 | Replay fixtures | test/replay-fixtures/ | NO-OP | — | existing |
| L12 | Test mocks | various | SHAPE-CHANGE | update under R1 | tsc |

---

## L14 — Scope delta from ADR-008 rev 2

The audit surfaced **three** scope items ADR-008 rev 2 did not cover. Fold them into the next rev (or Phase 3 extension):

1. **`PgAliasRepository` mutating methods** — same treatment as `PgEntityRepository` (§L7.2). ADR-008 rev 2's P1 write-path fix covered `PgEntityRepository` but missed the parallel class.
2. **`buildPgAliasChecker` inline pre-filter leak** — third site to patch in impl plan §5 (alongside `container-core-builders` and `container-learning.ts`'s existing reference). §L10.1.
3. **ETL escape hatch `generate-transliteration-aliases.ts`** — direct runtime-plane writer that bypasses `publish-runtime-substrates.ts`. Must be rewritten to NDJSON-producer shape or deleted. §L11.1.

**Proposed ADR-008 rev 3 changes** (to land this audit):
- §5 (Write-path hazards): append subsection covering `PgAliasRepository` with the same 3-issue breakdown (`save`/`suppress`/`bulkSave`).
- Axis 3 §2 (R1/R2 options): extend the R1 "delete mutating methods" scope to include `PgAliasRepository` alongside `PgEntityRepository`. Note that R2 would be strictly worse here because the existing writer is an ETL script that should flow through the publisher anyway.
- Axis 3 §1 (pre-filter leaks): add `container-learning.ts:28-40 buildPgAliasChecker` as the third leak site. The "2 sites" language becomes "3 sites".
- New Axis 3 §5: "ETL escape hatch elimination". Lists `generate-transliteration-aliases.ts` and defines the rewrite shape.
- Acceptance criteria: add bullets for the new regression tests and for the ETL script rewrite.

---

## L15 — Regression test inventory (new + existing)

### New (from this audit)

| Test file | Purpose | Layer |
|-----------|---------|-------|
| `test/regression/pg-entity-row-has-snapshot.regression.test.ts` | `EntityRow` has `search_snapshot_id` | L1.1 |
| `test/regression/pg-alias-row-has-snapshot.regression.test.ts` | `AliasRow` has `search_snapshot_id` | L1.2 |
| `test/regression/pg-entity-repository-rollback-jsonb-schema-absent.regression.test.ts` | `EntityRowSnapshotJsonbSchema` absent under R1 | L2 |
| `test/regression/etl-snapshot-record-purity.regression.test.ts` | ETL records don't leak `search_snapshot_id` | L3 |
| `test/regression/entity-domain-snapshot-agnostic.regression.test.ts` | `Entity` domain model has no snapshot field | L4.1 |
| `test/regression/pg-entity-repository-readonly-surface.regression.test.ts` | `PgEntityRepository` no mutating methods | L7.1 |
| `test/regression/pg-alias-repository-readonly-surface.regression.test.ts` | `PgAliasRepository` no mutating methods | L7.2 |
| `test/regression/alias-repository-port-readonly-surface.regression.test.ts` | `AliasRepository` port no mutating methods | L6.2 |
| `test/regression/container-learning-alias-checker-snapshot-filter.regression.test.ts` | `buildPgAliasChecker` binds snapshot | L10.1 |
| `test/regression/pg-alias-repository-etl-caller-absent.regression.test.ts` | no ETL script calls `PgAliasRepository.save` | L11.1 |
| `test/regression/runtime-plane-insert-authority.regression.test.ts` | only publisher writes runtime tables | L11.2 |
| `src/interface/http/routes/__tests__/ready-route-snapshot-health.test.ts` | `/ready` snapshot_health serialization | L9.1 |
| `test/regression/runtime-plane-append-only.regression.test.ts` | double-publish contract (impl plan §1 Drill B) | L0, L7 |

### Updated (existing tests that must be touched)

| Test file | Touch type |
|-----------|------------|
| `src/__tests__/db-migrate.test.ts` | Add migration 016 case + re-run idempotency |
| `test/e2e/v2-routes.contract.test.ts` | Update `/ready` golden fixture |
| `test/regression/p1-corrections.regression.test.ts` | Extend Fix 3 block for `snapshot_health` |
| `bootstrap-smoke.sh` | Add double-publish + rollback scenario |

---

## L16 — Acceptance delta

Before declaring this audit complete:

- [ ] Every surface in L13 table has either a confirmed regression test file or a "NO-OP" tag explicitly tied to an existing test file.
- [ ] ADR-008 rev 3 picks up the 3 scope items in L14.
- [ ] Impl plan §5 becomes "3 pre-filter leak sites" instead of 2.
- [ ] Impl plan §4 R1 scope expands to include `PgAliasRepository`.
- [ ] New impl plan section for L11.1 (transliteration ETL rewrite).
- [ ] New impl plan Phase 3d for `container-learning.ts:28-40` leak patch.
- [ ] `tsc --noEmit` green after all shape changes land.
- [ ] `pnpm run verify:http-contracts` green after L9 changes.
- [ ] Grep `INSERT INTO entities|aliases|ambiguity_registry` in `scripts/` returns only `publish-runtime-substrates.ts` after L11.
- [ ] Grep `entityRepository.save|update|delete|createSnapshot|rollbackToSnapshot` in `src/` returns 0 (L7.1 lock test).
- [ ] Grep `aliasRepository.save|suppress|bulkSave` in `src/` returns 0 (L7.2 lock test).

---

## L17 — Open questions (audit-only, deferred to implementation)

1. **`EntityRow` / `AliasRow` export?** Currently these interfaces are module-private. To make §L1 lock tests meaningful via `satisfies`, they should be exported. Exporting slightly widens the public surface; acceptable since the types are pure data shape.
2. **Under R1, do we also remove `PgEntityRepository` / `PgAliasRepository` from the barrel export?** Pro: removes the temptation for downstream consumers to `new PgAliasRepository(...)` with write intent. Con: breaking change to the public `src/infrastructure/index.ts`. Recommend: keep the export, lock behavior via regression test.
3. **What replaces `generate-transliteration-aliases.ts`'s DB write?** Answer determines whether the script becomes an NDJSON producer (preferred) or is deleted entirely (if no longer run). Needs operator runbook audit.
4. **Should `AliasProposer.proposeNew()` include a snapshot hint?** Proposals flow through `proposal_store` → approval gate → next publish. Currently stateless. Adding a snapshot hint could reject proposals against stale snapshots. Out of scope for this migration but worth an ADR-009 follow-up.
5. **Does the R1 port shrink impact RFC-001 §4.5 (entity snapshot rollback)?** RFC-001 describes entity-level rollback; R1 argues it's subsumed by pointer rollback. If ops still depends on per-entity rollback for partial-corruption recovery, we need a new tool that reads `entity_snapshots` archive → replays into a fresh snapshot_id. Surface to RFC owners.

---

## L18 — Revision history

- **rev 1** (2026-04-14 wave 3): initial audit produced from ADR-008 rev 2 + impl plan. Discovered `PgAliasRepository`, `buildPgAliasChecker`, `generate-transliteration-aliases.ts` as missing scope. Proposed ADR-008 rev 3 scope extensions.

---

## References

- [ADR-008 rev 2](../adr/008-runtime-plane-snapshot-scoped-primary-keys.md)
- [Design 008 impl plan](008-runtime-plane-snapshot-pk-impl.md)
- [Migration 010 (pointer)](../../src/infrastructure/db/migrations/010_active_search_snapshot_pointer.sql)
- [Migration 011 (identity authority)](../../src/infrastructure/db/migrations/011_identity_authority_constraints.sql)
- [Migration 012 (canonical projection)](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql)
- [Migration 013 (canonical entity snapshot plane)](../../src/infrastructure/db/migrations/013_canonical_entity_snapshot_plane.sql)
- [RFC-001 Identity Graph & Rollback semantics](../rfc/)
- [ADR-006 Search snapshot publish architecture](../adr/006-search-snapshot-publish-architecture.md)
- [ADR-007 Canonical entity identity cutover](../adr/007-canonical-entity-identity-cutover.md)
