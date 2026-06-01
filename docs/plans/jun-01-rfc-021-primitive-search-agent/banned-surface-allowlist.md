# RFC-021 T-PSA-05 — Banned Surface List & Allowlist

Closeout artifact for the legacy mixed-surface purge. The **product/tool
primary surface** must be free of the legacy mixed/convenience taxonomy; a
bounded set of **internal compatibility residue** is intentionally retained and
listed here so the proof rail can distinguish "drift re-introduced on a
product surface" from "known internal residue".

Proof rail: `test/regression/banned-surface-guard.regression.test.ts`.

## Banned on the product / tool primary surface

These MUST NOT appear as an active agent tool name, a public route/tool
contract, an OpenAPI operation, or live agent system-prompt / tool-description
copy:

| Banned token | Why | Replacement |
|---|---|---|
| `search_wines` | legacy single search tool with in-body lane selector | `search_hybrid` / `search_semantic` / `search_lexical` |
| `compare_wines` | convenience comparison tool | `lookup_wine` → `lookup_wine` → synthesis |
| `get_food_pairings` | convenience pairing tool | `search_*` + synthesis |
| `check_drinking_window` | convenience drinkability tool | `lookup_wine` + synthesis |
| `mode=mixed` / `retrieval_mode=mixed` (as a public/tool input) | lane override smuggled through the body | route/lane is path-authoritative; agent uses `similar_to_entity` |
| `mixed` / `similar_items` as a **public/tool/agent-copy** surface name | exposes an internal retrieval mode as a product concept | `similar_to_entity` primitive (agent) / hybrid discovery (public) |

## Allowlisted internal compatibility residue

These retain the strings above but are NOT product surface. The rail explicitly
excludes them.

### Runtime / internal (intentionally kept)

- `src/domain/agent/model/agent-tool-attempt-schema.ts` —
  `CompareWinesAttemptInputSchema`: a permissive parse shape kept only so a
  legacy attempt is structurally classified (the tool is NOT in
  `KNOWN_AGENT_TOOL_NAMES`, so it can never be dispatched).
- `src/domain/response/service/comparison-contrast.ts` — a doc comment
  explaining the historical `compare_wines` two-leg synthesis behavior.
- `src/domain/query/model/retrieval-mode.ts` — `similar_items` is a legitimate
  INTERNAL retrieval mode (the deterministic anchor-similarity lane that
  `similar_to_entity` compiles to). Banned only as a *public/tool* name, not as
  an internal mode.
- `src/domain/mixed/**`, `src/application/search/search-usecase-mixed-route.ts`
  — the locked mixed/anchor-similarity solver (REUSE-family lock). Internal
  execution engine reused by `similar_to_entity`; never a product surface.
- `src/domain/query/model/query-observability-vocab.ts` — `reference_similarity`
  family + the `similar_items` mode mapping (telemetry, internal).

### Tests (intentionally kept)

- `src/application/wine-search/__tests__/wine-agent-loop.test.ts` — the
  `compare_wines` **unsupported-branch** guard: proves a legacy tool name hits
  the default "not supported" path. This is a regression guard, not a surface.
- `src/application/wine-search/__tests__/wine-agent-loop-tool-bundle.test.ts`,
  `test/integration/wine-search-prompt-injection-structural-boundary.test.ts` —
  comments naming removed tools to document the taxonomy boundary.
- `test/regression/banned-surface-guard.regression.test.ts` — the rail itself
  names the banned tokens.
- `test/regression/reference-similarity-*.test.ts` — name `mixed`/`similar_items`
  in assertions proving the public/agent surfaces do NOT use them.

### Docs (historical record — preserved, not product surface)

- `docs/rfc/**`, `docs/adr/**`, `docs/rfc/rfc-apr-11-enhancing-engine/**` —
  historical RFC/ADR/EPIC records describing superseded designs. Preserved as
  "what was", like a deprecated catalog YAML.
- `docs/system-overview/agentic-process.md`,
  `docs/system-overview/retriever-pipeline.md`,
  `docs/system-overview/doc2query-cohere-integration.md` — describe historical
  agentic batching; flagged for a future system-overview refresh (tracked, not
  blocking this closeout).

## Closeout matrix

| Surface | Banned tokens present? | Status |
|---|---|---|
| Active agent tool taxonomy (`KNOWN_AGENT_TOOL_NAMES`) | no | clean (rail-enforced) |
| Agent tool bundle names + descriptions | no | clean (rail-enforced) |
| Agent system prompt copy | no | clean (rail-enforced) |
| Public HTTP primitive routes | no | clean (rail-enforced) |
| Internal retrieval mode / mixed solver | yes (`similar_items`/`mixed`) | allowlisted (internal engine) |
| Internal attempt schema | yes (`compare_wines`) | allowlisted (unreachable) |
| Historical docs (rfc/adr) | yes | allowlisted (historical record) |
| `system-overview/*` | yes (`search_wines`) | follow-up refresh (non-blocking) |
