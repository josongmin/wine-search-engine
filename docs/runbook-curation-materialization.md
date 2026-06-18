# Runbook — Curation proposal materialization (T-ELV2-03)

Ops publish (`status=published`) is **staging only**. Runtime lookup consumes proposals during
`snapshot build → publish`. Migration **033** records which snapshot build materialized each
published row (`materialized_snapshot_id`, `materialized_at`).

## Deploy order

1. Apply DB migrations through **`033_lookup_v2_curation_materialization.sql`** before
   deploying application/ETL code that reads `published_awaiting_materialization` or calls
   `markPublishedCurationProposalsMaterialized`.
2. Deploy API + ETL together (same release). Older API without 033 columns degrades gracefully:
   `coverage-health` counts all `published` rows as awaiting materialization.
3. Run snapshot build + publish after ops publish (`mark` runs only after **publish** promotes runtime):

```bash
pnpm run etl:build-search-snapshot   # project-specific entry; see package.json
pnpm run etl:publish-search-snapshot # promote active pointer + mark materialized rows
```

`etl:build-search-snapshot` alone does **not** clear `published_awaiting_materialization` — that is intentional fail-closed backlog semantics.

## Operator signals

| Signal | Meaning |
|--------|---------|
| `published_awaiting_materialization > 0` | Published proposals not yet in a snapshot build |
| `legacy_approved_abbreviation_backlog > 0` | Transitional `approved` abbreviation rows — route through ops publish, then snapshot republish |
| `lookup_runtime.family_graph_edge_count = 0` | Scope graph family edges absent; `family_graph` channel dormant |
| `lookup_runtime.unwired_substrate_ids` | Recall substrates not wired in lookup lane (e.g. `lookup_ltr_rerank`) |
| `materialized_snapshot_id` set | Last snapshot id that consumed the row (published only) |
| Legacy `approved` abbreviation rows | May appear in ETL overlays; **not** materialization-tracked until ops publish |

## Pin semantics (`target_snapshot_version`)

- **Unpinned** (`NULL`): included on every snapshot build.
- **Pinned** (`search-snapshot:v1:…`): included only when the build's snapshot id matches.
- ETL runs up to **4** convergence passes; if pinned proposals still do not fit, build **fails loud**
  (`Curation pin convergence failed…`).

## Evidence contract (ops submit)

HTTP submit accepts legacy `{ source, note }` and RFC-014 snake_case
(`operator_note`, `source_trust`, `alias_scope`, `ambiguity_types`).
Application layer canonicalizes to `{ source?, operatorNote?, … }` (camelCase
domain) before PG write. Unknown keys are dropped (not 400). Responses are
snake_cased (`operator_note`).

## Related

- Loader: `scripts/etl/load-published-curation-proposals.ts`
- Phonetic recall column (separate migration): `034_aliases_phonetic_keys.sql` — see [double-metaphone-notes.md](double-metaphone-notes.md)
- HTTP ops surface: [http-contract-surface.md](http-contract-surface.md)
- Migration: `src/infrastructure/db/migrations/033_lookup_v2_curation_materialization.sql`
- Rollback (manual): `src/infrastructure/db/migrations/rollback/033_lookup_v2_curation_materialization_rollback.sql`
- Ops health: `POST /v2/entity-lookup/ops/coverage-health`
