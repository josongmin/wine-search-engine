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
pnpm run sync-data      # copy latest pipeline artifacts into public/data (static fallback)
pnpm run dev            # http://localhost:5311
```

`pnpm run build` / `pnpm run preview` for a static bundle.

### Live mode (backend ops API)

The "검색어 처리" screen searches the **real catalog** and **saves** a decision
when the main wine-search-engine backend is running. Vite proxies `/v2/*` →
the backend (`http://localhost:3000`, override via `VITE_OPS_BACKEND`).

```bash
# repo root, separately:
pnpm run dev            # backend on :3000 (needs PG + Vespa + active snapshot)
```

Uses existing backend endpoints (no new server code):

| action | endpoint |
|---|---|
| catalog search (pick a wine) | `POST /v2/entity-lookup` |
| coverage / queue health | `POST /v2/entity-lookup/ops/coverage-health` (`published_awaiting_materialization` = snapshot backlog) |
| save alias decision | `POST /v2/entity-lookup/ops/proposals/submit` (`kind: alias`) |
| save ambiguity / suppression | same submit route with `kind: ambiguity` \| `suppression` (see `src/lib/api.ts` helpers) |
| list / review / publish | `POST /v2/entity-lookup/ops/proposals[/review|/publish]` — pass proposal `kind` |

After **publish**, run snapshot `etl:build-search-snapshot` + `etl:publish-search-snapshot`
to materialize into runtime (see `docs/runbook-curation-materialization.md`).

> ⚠️ Saving **writes to PostgreSQL** (curation write-plane, migrations
> `030_lookup_v2_curation_write_plane.sql` + `033_lookup_v2_curation_materialization.sql`).
> Against prod RDS that is a production write — get approval and ensure migrations
> through **033** are applied. Catalog **search is read-only**. Backend down → the
> screen says so and only the offline draft composer is available.

## Web consoles (two faces)

| Console | Path | Role |
|---|---|---|
| **Next.js ops** (`web/`) | `/ops/{inspect,curation,coverage}` | Trusted-plane **read + curation write** against the live backend (`X-Debug-Key` / `X-Ops-Write-Key`). Full inspect spine, proposal submit/review/publish, coverage health. |
| **CSR ops** (this app) | static residue / authority workbench | **Offline-first** cutover rail + registry residue queue + evidence composer. Live mode proxies the same `/v2/entity-lookup/ops/*` endpoints when the backend is up. |

Both can submit alias proposals including `abbreviation` type; this app's **ProposalsInbox** supports approve / reject / publish.

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
