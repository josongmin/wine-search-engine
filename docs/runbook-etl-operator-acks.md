# ETL Operator Acknowledgments (Runbook)

> **Audience:** ops/SRE operating the wine-search-engine ETL pipeline.
> **Purpose:** document the two explicit risk-ack env vars that disable ETL
> guardrails when an operator deliberately accepts a degraded publish.

The ETL pipeline has two publish paths where the default behavior is **fail
closed**. An operator may override the guard, but only by setting a specific
env var to `YES` — no other value works, and the intent is that this never
happens without human sign-off.

## `ETL_INDEX_PARTIAL_FAILURE_ACK=YES`

**Guard:** `scripts/etl/index-to-vespa.ts` refuses to apply
`maxFailureRate > 0` (accept partial Vespa indexing failures) unless this
ack is set.

**What it enables:** partial Vespa indexing — some documents may fail to
index but the publish still proceeds. The snapshot that is eventually
promoted will be **incomplete**.

**Why the guard exists:**
- An incomplete snapshot silently degrades recall: queries for the missing
  entities return no results.
- Without ack, operators cannot distinguish "CI dev run" from "prod publish
  accepted partial failure".
- The silent-skip counter alone is not enough — once the pointer flips,
  the incomplete state becomes the live read path.

**When to set it:**
- Emergency publish where re-index would block a time-critical rollout AND
  a reviewer has confirmed the dropped documents are non-critical.
- Controlled experiments in a dev environment with a
  `maxFailureRate > 0` option explicitly passed.

**When NOT to set it:**
- As a convenience to silence failure logs.
- In CI/CD without human review.
- Permanently in `.env` or deployment manifests.

**Rollback:** the DB pointer (`active_search_snapshot`) still guarantees
atomic rollback to the previous snapshot if the incomplete publish turns
out to have worse quality. Use the rollback helper:
```bash
pnpm exec tsx scripts/etl/rollback-active-snapshot-pointer.ts
```

## `ETL_PUBLISH_LTR_BYPASS_ACK=YES`

**Guard:** `scripts/etl/publish-search-snapshot.ts` refuses to accept
`--allow-missing-ltr` when `NODE_ENV=production` unless this ack is set.

**What it enables:** publishing a snapshot that has **no trained LTR
model** for any query class. The read path falls back to pure lexical
ranking (BM25 + sparse features) with no learned weights.

**Why the guard exists:**
- LTR absence is a measurable quality regression on the majority of
  specific-entity and anchored queries.
- The fallback path works structurally but produces meaningfully worse
  NDCG than the trained path.
- Without ack, a forgotten `--allow-missing-ltr` in an automation script
  would silently degrade production search for hours.

**When to set it:**
- First bootstrap of a brand-new environment before any LTR model has been
  trained (cold start).
- Explicit dev/test paths where the LTR store is intentionally empty.

**When NOT to set it:**
- To unblock a failed training run in production. Re-train first, then
  publish. LTR bypass is not a substitute for model recovery.

**Verification:** after an LTR-bypass publish, the response meta includes
`degradation_reasons: ['ltr_missing']`. Confirm the reason shows up on a
sample of live queries before declaring the publish successful.

## Audit trail

Both ack env vars are **runtime-only** — they are read inside the script
process and never persisted. Ops scripts must capture the ack decision in
the deploy ticket, not in the shell history:

1. Paste the `--explicit-risk-ack <justification>` comment into the deploy ticket.
2. Record `operator`, `date`, `reason`, and the exact snapshot_id the
   ack was used for.
3. After the publish, cross-check `active_search_snapshot_history` to
   confirm the pointer promoted to the risk-accepted snapshot.

## `scripts/ops/reap-snapshots.ts` — runtime plane snapshot reaper

**Purpose**: delete rows from `entities` / `aliases` / `ambiguity_registry`
whose `search_snapshot_id` is neither the `active_search_snapshot.active_snapshot_id`
nor `active_search_snapshot.previous_snapshot_id`. This is the GC step that
keeps the composite-PK runtime plane from growing unbounded after successive
publishes — see [ADR-008](adr/008-runtime-plane-snapshot-scoped-primary-keys.md).

**Default behavior**: `--dry-run` is the default. Counts candidate rows per
table, issues no `DELETE`, and reports what would have been reaped. Destructive
runs require `--force`.

**Safety guards (all three must pass before any DELETE is issued)**:

1. **Pointer row present**: the `active_search_snapshot` row must exist. A
   first-publish environment with no pointer row is skipped cleanly with
   `skipReason: active_search_snapshot is empty`.
2. **Previous snapshot non-null**: if `previous_snapshot_id IS NULL`, the
   only snapshot currently on disk is the active one — there is nothing
   safe to reap. Skipped cleanly.
3. **Grace period elapsed**: the script refuses to run within
   `--grace-period-hours` (default: 24) of `promoted_at`. Rationale: give
   the new active snapshot time to prove itself against production traffic
   before we drop the previous one's rollback material.

**Usage**:

```bash
# Dry run (default) — reports candidate row counts across the 3 tables
pnpm exec tsx scripts/ops/reap-snapshots.ts

# Destructive run — requires --force AND grace period elapsed
pnpm exec tsx scripts/ops/reap-snapshots.ts --force

# Custom grace window (e.g. 48h for conservative rollout)
pnpm exec tsx scripts/ops/reap-snapshots.ts --grace-period-hours 48 --force
```

**When to run**:
- Nightly cron / weekly cron, after the active snapshot has stabilized.
- **Required pre-condition** for migration 017 (runtime plane PK rollback):
  the rollback SQL needs the composite-PK tables to contain only
  `(active, previous)` snapshot rows, or the rollback PK restoration will
  fail with duplicate-key errors.

**When NOT to run**:
- Immediately after a publish. Wait out the grace period so an unexpected
  regression can still be rolled back by pointing `active_search_snapshot`
  back to `previous_snapshot_id`.
- While an ETL publish is in-flight on the same DB.

**Audit trail**: every run emits a JSON summary (`active_snapshot_id`,
`previous_snapshot_id`, per-table `candidateRowCount` + `deletedRowCount`) to
the bootstrap logger. Capture the log line in the deploy ticket for the
record.

## Related

- [CLAUDE.md](../CLAUDE.md) — project root documentation.
- [docs/design/immutable-runtime-substrate-cutover.md](design/immutable-runtime-substrate-cutover.md) — pointer promote flow.
- [docs/adr/008-runtime-plane-snapshot-scoped-primary-keys.md](adr/008-runtime-plane-snapshot-scoped-primary-keys.md) — composite PK migration rationale.
- `scripts/etl/publish-search-snapshot.ts` — the publish entry point.
- `scripts/etl/index-to-vespa.ts` — the indexing entry point.
- `scripts/ops/reap-snapshots.ts` — the snapshot reaper described above.
