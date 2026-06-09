# Entity Lookup · Ops Console

Standalone **CSR** (client-side, no backend) ops console for the lookup-v2
entity-resolution **curation pipeline**. It is an **authority decision system +
residue workflow + publish-gate console** — deliberately *not* a wine-CRUD /
alias editor.

The system's operational reality is 3 layers:

1. **Resolver code** (exact-safe / scope / family-vintage selection)
2. **Reviewed authority registries** (the SSoT this tool manages)
3. **publish / verify rails**

The first-class objects here are **authority rows** (per registry class), the
**coverage residue queue**, and the **cutover rails** — not entities.

## Run

```bash
cd app/entity-lookup-ops-web
pnpm install            # independent workspace (own pnpm-workspace.yaml)
pnpm run sync-data      # copy latest pipeline artifacts into public/data
pnpm run dev            # http://localhost:5311
```

`pnpm run build` / `pnpm run preview` for a static bundle (deploy anywhere — it's
pure static + `public/data/*.json`).

## Faces

| Face | What it does |
|---|---|
| **Cutover Rail** | coverage % · residue by bucket · remaining structural work (write-plane) · the real publish/verify rail commands |
| **Residue Queue** | every coverage hole → gap bucket → the **authority class** that closes it + whether evidence is sufficient |
| **Authority Workbench** | the 7 reviewed authority classes as first-class rows: `exact_safe / scope_target / policy / collision / scope_support / localized_surface / family_core_witness` |
| **Evidence · Decision** | per residue item: runtime descriptor (available vintages / line / region), family-core witness, exact-safe certs, current reviewed rows — side by side → **Decision Composer** drafts an *evidence-cited* registry row (raw row when constructible, else the review→apply command) |
| **Drift Intake** | paste new query-log surfaces → auto-triage into `covered / new_alias / runtime_backfill / genuine_ambiguity` |

## Design principles (encoded, learned from the pipeline)

- **Authority-row-class centric**, not wine-centric. Adding a wine is *not* a
  universal 5-part recipe — that bundle is specific to the Korean hot-entity lane.
- **Evidence-based, never heuristic.** No "latest vintage = flagship". Decisions
  cite unique runtime owner / reviewed family-core witness / line·region·appellation
  descriptor / explicit reviewed scope target.
- **Localized surface auto-syncs** from approved scope targets (not a manual-only
  artifact).
- **exact-safe already matches `vintageCanonicalized`** before family selection —
  the open work is certificate coverage / calibration, not "introduce ordering".
- **required-target gate** is a benchmark/hot-entity-lane property, not a universal
  onboarding checklist.

## Data

`public/data/` is populated by `scripts/sync-data.sh` (gitignored). Sources:

| file | from |
|---|---|
| `coverage.json` | `/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json` |
| `write-plane-summary.json` | `/tmp/lookup-v2-drafts/…-write-plane-summary.json` |
| `owner-evidence.jsonl` | `…/manual-target-owner-evidence/missing-runtime-owner-families.jsonl` |
| `gold-catalog.jsonl` | `data/gold-wine-catalog.jsonl` |
| `*-registry / scope-target / policy / collision / scope-support / localized-surface / family-core-witness` | `data/lookup-v2/*.jsonl` |

Override coverage/write-plane/owner paths via env: `ELV2_COVERAGE_JSON`,
`ELV2_WRITEPLANE_JSON`, `ELV2_OWNER_EVIDENCE`.

> The console **reads** artifacts and **drafts** decisions. It never mutates the
> repo — apply drafts via the registry's review→apply scripts, then run the rails.
