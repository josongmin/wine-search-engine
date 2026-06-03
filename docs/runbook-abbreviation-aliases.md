# Runbook — Abbreviation Aliases ETL

Operator guide for `scripts/etl/generate-abbreviation-aliases.ts` (P1.4 — KIL abbreviation recall lift).

## What this ETL produces

Curated wine-community abbreviation surface forms ("CM 15", "DRC 19",
"Grange 17") emitted as `aliases.alias_type='abbreviation'` rows so the
existing `PgAliasMatcher` exact-match phase resolves sloppy abbreviation
queries against the right entity.

Two generation lanes:

1. **Deterministic** (default; no LLM): pure-function transform of
   `(canonicalLabel, vintageYear)` → set of compound shorthand forms.
   See `src/domain/alias/service/abbreviation-derivation.ts` for the
   audited rules (R1–R7). No fabrication risk — every emitted surface is
   a published wine-community convention.

2. **LLM-assisted** (opt-in via `--llm`): asks an OpenAI chat model for
   additional informal forms (sommelier shorthand, forum-specific
   nicknames like "Bin 95" for Penfolds Grange). Output is parsed
   through a Zod schema (`scripts/etl/abbreviation-llm-parser.ts`)
   that:
   - drops surfaces containing characters outside the canonical wine
     vocabulary (emoji, currency, CJK punctuation);
   - accepts numeric fields emitted as strings (LLMs frequently send
     `"0.85"` instead of `0.85`);
   - tolerates extra fields LLMs add (`explanation`, `proposed_by`).

Both lanes write to `data/abbreviation-aliases-proposals/<timestamp>.jsonl`
for **human review** before any row is upserted into `aliases`.

## Lifecycle

```
   ┌──────────┐    ┌──────────────────────────┐    ┌──────────────────┐
   │ entities │ →  │ generate-abbreviation-   │ →  │ proposals JSONL  │
   │ table    │    │ aliases.ts               │    │ (data/abbrev*)   │
   └──────────┘    └──────────────────────────┘    └──────────────────┘
                                                            │
                                                            │ operator review
                                                            ▼
                            ┌──────────────────┐    ┌──────────────────┐
                            │ aliases table    │ ←  │ approved JSONL   │
                            │ (alias_type=     │    │ (status=         │
                            │ abbreviation)    │    │  'approved')     │
                            └──────────────────┘    └──────────────────┘
```

## Commands

### 1. Generate proposals (deterministic-only, fast)

```sh
pnpm tsx --env-file=.env scripts/etl/generate-abbreviation-aliases.ts \
  --all \
  --limit 100 \
  --auto-approve \
  --out data/abbreviation-aliases-proposals/
```

`--auto-approve` is safe for the deterministic lane only — every
emitted surface follows an audited rule, no LLM in the loop. Writes a
JSONL where every line has `"status": "approved"`.

### 2. Generate proposals (deterministic + LLM augmentation)

```sh
pnpm tsx --env-file=.env scripts/etl/generate-abbreviation-aliases.ts \
  --all \
  --limit 50 \
  --llm \
  --out data/abbreviation-aliases-proposals/
```

LLM lines land with `"status": "pending"` — **do NOT pass
`--auto-approve` when `--llm` is set**. LLM-suggested surfaces require
human review (see § "Reviewing LLM proposals").

Requires `OPENAI_API_KEY` in env. Inter-request delay is 750 ms to
stay under per-minute rate limits.

### 3. Generate for a specific list of entities

```sh
echo '["chateau-margaux-2015","opus-one-2018"]' > /tmp/entity-ids.json
pnpm tsx --env-file=.env scripts/etl/generate-abbreviation-aliases.ts \
  --input /tmp/entity-ids.json \
  --auto-approve
```

### 4. Stage reviewed proposals into `alias_proposals`

```sh
pnpm tsx --env-file=.env scripts/etl/generate-abbreviation-aliases.ts \
  --commit data/abbreviation-aliases-proposals/<file>.jsonl
```

The commit step:
- reads the file, validates each line via `isProposalShape` runtime guard,
- skips any row where `status !== 'approved'`,
- upserts into the **staging** `alias_proposals` table keyed by
  `proposal_id`. Re-running the commit is safe (idempotent).

**Architectural note:** the runtime-plane `aliases` table has a single
authorized writer — `scripts/etl/publish-runtime-substrates.ts`
(migration 016 invariant, gated by
`test/regression/runtime-plane-insert-authority.regression.test.ts`).
This ETL stages into `alias_proposals`; the publisher picks up the
approved staging rows on the next snapshot publish and materializes
them into `aliases` with the correct `search_snapshot_id`.

### 5. Publish to the runtime plane

```sh
pnpm tsx --env-file=.env scripts/etl/publish-runtime-substrates.ts
```

The publisher reads `alias_proposals WHERE status='approved' AND proposed_type='abbreviation'`
and INSERTs the rows into `aliases` against the active search snapshot.
After the publish, the new abbreviation aliases participate in the
`PgAliasMatcher` exact-match phase on the next request.

## Reviewing LLM proposals

LLM lines need review for:

1. **Fabrication.** The LLM may invent a "common" abbreviation that
   nobody actually uses ("DCM" for Domaine Carteron Margaux). Drop
   anything you can't confirm against CellarTracker, Wine Berserkers,
   K&L Wine Merchants forum, or a sommelier corpus.

2. **Cross-entity collisions.** "CM" maps to Château Margaux,
   Conte Marc, Cantine Margaridi… If the LLM proposes a 2-letter
   initialism for a producer that already has a registered collision
   in `ambiguity_registry`, **route the proposal to the ambiguity
   registry** instead of `aliases` — see § "Ambiguous abbreviations".

3. **Vocabulary contamination.** The parser drops obvious junk
   (emoji, currency), but watch for less-obvious noise like
   non-breaking spaces, zero-width joiners, or trailing whitespace.

To approve a line: edit the JSONL in place, change `"status": "pending"`
to `"status": "approved"`. Lines you decide against: leave `"pending"`
or set `"status": "rejected"` (filter out before commit either way).

## Ambiguous abbreviations

When the same surface form ("CM") is a valid abbreviation for multiple
entities, the system records the conflict in `ambiguity_registry`
instead of registering competing `aliases` rows.

Workflow:

1. **Detect.** Before commit, grep the proposals file for duplicate
   `normalizedSurface` rows pointing at different `entityId`s:

   ```sh
   jq -r 'select(.normalizedSurface=="cm")' data/abbreviation-aliases-proposals/*.jsonl
   ```

2. **Resolve.** For each collision:
   - if one entity has dominant traffic (>80% of historical queries
     for the surface form), keep its alias and drop the others;
   - otherwise, **drop ALL ambiguous rows for that surface** and add
     an `ambiguity_registry` entry listing every claimant. The
     resolver will return a clarification page instead of guessing.

3. **Commit.** Re-run `--commit` with the cleaned file.

Adding an ambiguity registry entry is operator-only — there's no
automatic emission today. See `src/infrastructure/db/migrations/001_initial_schema.sql`
for the `ambiguity_registry` table shape; insert via psql.

## Operational guardrails

- **Concurrency.** The CLI does not coordinate across instances. Run
  one at a time. The acquire-lock helper in `scripts/etl/etl-utils.ts`
  is available if you need to run from cron — wrap the run with
  `acquireLock('data/abbreviation-aliases-proposals/.lock')`.

- **Cost (LLM).** ~1 request per entity at the default settings
  (gpt-4.1-mini, max_tokens=800, temperature=0.2). 100 entities ≈ $0.05.
  Budget accordingly; the `--limit` flag enforces a default cap of 100.

- **Re-generation.** Safe to re-run. The deterministic lane is purely
  a function of the entity row; identical inputs produce identical
  proposals. The LLM lane is non-deterministic at temperature > 0, but
  every surface still passes the same Zod gate so output drift cannot
  introduce malformed rows.

- **Cleanup.** Old proposals files accumulate in
  `data/abbreviation-aliases-proposals/`. Safe to delete after commit —
  the `aliases` table is the source of truth.

## When to re-generate

- **New entity added** (`entities` table INSERT): run the ETL with
  `--input` and the new entity id.
- **Entity renamed** (canonical_label change): re-run for that entity
  and SUPPRESS the old surfaces by issuing an UPDATE setting
  `is_suppressed = TRUE` on the obsolete rows. The matcher already
  filters by `is_suppressed = FALSE`.
- **Quarterly audit**: re-run with `--llm` on the top-1000 traffic
  entities to discover new community shorthand. Diff against existing
  abbreviation rows; review additions.

## Verification

After commit, confirm the new rows participate in the matcher path:

```sql
SELECT entity_id, surface_form, normalized_value, alias_type, source
  FROM aliases
 WHERE alias_type = 'abbreviation'
   AND entity_id = 'chateau-margaux-2015';
```

```sh
# Should resolve to chateau-margaux-2015 with high confidence.
curl -sX POST http://localhost:3001/v2/entity-lookup \
  -H 'Content-Type: application/json' \
  -d '{"query":"CM 15"}' | jq .
```

The KIL noisy-benchmark regression (`test/regression/kil-noisy-benchmark.regression.test.ts`)
also gates on `abbreviation` category recall@3 ≥ 0.55. A backslide
there means an alias row got dropped, renamed, or its `is_suppressed`
flipped.

## Related modules

- Domain rules: `src/domain/alias/service/abbreviation-derivation.ts`
- LLM output parser: `scripts/etl/abbreviation-llm-parser.ts`
- ETL CLI: `scripts/etl/generate-abbreviation-aliases.ts`
- Migration: `src/infrastructure/db/migrations/021_alias_type_abbreviation_check.sql`
- Resolver scorer cap: `src/domain/resolver/service/candidate-scorer.ts` (`ABBREVIATION_CAP`)
- Conflict resolver weight: `src/domain/alias/service/conflict-resolver.ts` (`ALIAS_TYPE_PRIORITY_WEIGHTS.abbreviation`)
- Source-trust gate: `src/domain/alias/service/adversarial-guard.ts` (`SOURCE_TRUST_GATES.abbreviation`)
- ETL regression: `test/regression/abbreviation-alias-etl.regression.test.ts`
- KIL benchmark: `test/regression/kil-noisy-benchmark.regression.test.ts`
