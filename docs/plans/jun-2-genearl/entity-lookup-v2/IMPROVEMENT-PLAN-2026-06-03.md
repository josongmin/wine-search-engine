# Entity Lookup V2 — Improvement Plan (Historical Audit Snapshot)

> Historical / audit-only document.
> Current authority truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> This file preserves the pre-parity rollout framing for RCA and owner handoff,
> not for current cutover or executable-lane decisions.

## 목적

V2 품질 gate를 실제로 통과시킨 뒤, lookup authority를 V1에서 V2로 승격한다.

이 문서는 2026-06-03 시점의 truth + ticketized next steps snapshot을 보존한다.
현재 cutover 판단과 executable lane은 더 이상 이 문서를 authority로 쓰지 않는다.

## Current Truth

- Full authority eval (`run-entity-resolution-validation.ts`, 215 rows,
  fingerprint `bd8abea5871dcede17272c3cc0bd1dcebcf93ea658d2d4b2ab930e5ba4f26cae`)
  latest result:
  - `V1`: correct `100/215` (`46.5%`), wrong `0`, miss `115`
  - `V2`: correct `215/215` (`100.0%`), wrong `0`, miss `0`
- Cutover verdict: **PASS**
- `Viña Espectro Maipo Valley Carmenere` wrong-positive closed by the
  resolve-certificate gate.
- `2018 St. Supéry Élu` false-abstain closed at the shared ambiguity seam.
- 45-row hotset smoke is still **PASS** (`V2 wrong+=0`), but
  hotset is not the cutover authority.
- Public `/v1/lookup/wine`, local CLI `lookupWine`, and agent `lookup_wine`
  are now compatibility-backed V2 authority surfaces.
- Earlier `V1 93.5%` numbers are historical only; the current explicit
  `legacy_core` rerun is `V1 46.5%`.
- Korean-famous coverage is now **70/70**, non-entity handling is **37/37**,
  and canonical active runtime is now
  `search-snapshot:v1:7bcd44a5484b2be5`.
- Expanded Korean benchmark surface now includes:
  - iconic short-form ambiguity (`마고`, `라투르`, `샹베르탱`)
  - Korean typo / misspelling pressure (`사시카야`, `사씨카이야`, `페트루스`, `돔페리농`)
  - Korean recommendation / pairing phrasing (`까쇼 추천해줘`, `피노누아 추천`, `기념일 와인 추천`, `샴페인 뭐 마실까`)
  - Koreanized adversarial no-match (`샤또 미라쥬 2022`, `도멘 판타지 부르고뉴`, `실버문 나파 리저브 2021`)
- Current canonical active runtime readiness is green:
  - bootstrap verify PASS
  - pointer parity verify PASS
- Current canonical active latency truth is green on the dedicated lookup
  bootstrap path:
  - `/tmp/lookup-v2-latency-korean-famous-active-2026-06-05-post-bootstrap-fix.json`
  - `bootstrap_ms=963.213`
  - `first_query_ms=182.245`
  - `warm_p95_ms=116.823`
  - verdict: **PASS**
- Current executable self-canary replay is green:
  - `/tmp/lookup-v2-canary-replay-active-2026-06-05-post-bootstrap-fix.json`
  - `hard_drift=0`, `soft_abstain_drift=0`, labeled `75/75`
- Current executable canary corpus build lane is present and verified:
  - `pnpm run eval:lookup-v2:canary:build -- --input <traffic.ndjson> --output <corpus.jsonl> --query-field <dotted.path> [route/method filters]`
  - sample proof: `/tmp/lookup-v2-canary-built-sample.jsonl`
- Current-contract artifact-only publish is executable and verified on this host:
  - `pnpm run etl:publish-runtime-substrates:artifact-only -- --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --runtime-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json`
  - result: PASS
- Remaining closeout residue is operational only:
  - real traffic mirror raw input
  - operator-plane PG publish availability on this host (non-gate for lookup-only artifact/direct runtime)

## 당시 Authority Docs

- Historical / audit only:
  - `cutover-checklist.md`
  - `IMPROVEMENT-PLAN-2026-06-03.md`
  - `entity-resolution-validation-2026-06-02.md`
  - `shadow-results-2026-06-02.md`
  - raw JSON artifacts under this folder

## Structural Invariants

- `resolved` must be backed by **identity-grade evidence**, not just a high
  calibrated score. Recall-only evidence must widen recall, not self-certify
  identity.
- `producer_family_collision` must remain fail-closed for real same-producer
  ambiguity, but it must not suppress an exact head whose identity evidence the
  siblings do not share.
- V2 should remain **downgrade-only** over the resolver wherever possible. If a
  false-abstain comes from shared resolver ambiguity logic, fix the shared owner
  seam instead of adding a V2-only silent override.
- `/v1/lookup/wine` cutover must be an adapter-backed authority swap, not a
  caller-by-caller contract fork.
- Bench/docs are allowed to name only **executable** entrypoints and the
  current authority surface.

## Live Design Constraints

- The current stack is running with LTR serving disabled, so `ELV2-C1` and
  `ELV2-C2` must close under the deterministic path first. They cannot assume a
  learned reranker is present.
- A live `noisy_recall` sweep on 2026-06-03 resolved `40/40` correctly, and
  **0/40** correct rows were `fuzzy`-only heads. Top-channel distribution was:
  `compact_exact+exact_alias+jamo_phonetic` (26), `compact_exact` (4),
  `compact_exact+exact_alias` (4), `compact_exact+jamo_phonetic` (3),
  `compact_exact+fuzzy_alias+jamo_phonetic` (2), `compact_exact+fuzzy_alias` (1).
- Therefore the current cutover blocker is not "V2 needs fuzzy-only resolves to
  keep recall". The blocker is specifically that a `fuzzy_alias`-only head can
  still pass trusted calibration and become `resolved`.

## Execution Tracks

- **Track A — fail-closed correctness**: complete.
- **Track B — semantic authority hardening**: complete for the deterministic
  authority path (`resolve certificate` + shared ambiguity fix).
- **Track C — surface cutover**: complete for public/local/agent lookup via the
  compatibility seam.
- **Track D — proof-lane cleanup**: completed for executable lane/doc alignment.
- **Track E — lookup-direct bootstrap split**: completed. lookup eval/debug/CLI
  surfaces now boot through `createLookupDirectContainer`, so generic
  `createContainer` bootstrap tax is no longer charged to lookup proof lanes.
- Remaining residue is operational closeout (live canary + post-release legacy
  resolver deletion), not missing or misleading bench/doc entrypoints.

## Ticket ELV2-C1 — Close the `no_match` wrong-positive

Status: **completed 2026-06-03**

### Goal

Eliminate the single cutover-blocking wrong-positive without degrading the
current `noisy_recall` lift.

### Files To Touch

- `src/domain/resolver/v2/**`
- `src/application/search/entity-lookup-v2/**`
- `scripts/eval/**`
- `test/regression/**`
- `test/unit/entity-lookup-v2/**`

### Files To Create

- one regression rail that locks:
  - `Viña Espectro Maipo Valley Carmenere` must NOT resolve

### Constraints

- No query-specific hardcoding.
- No heuristic fallback unless explicitly approved.
- The fix must land on the owning seam that turns a `fuzzy_alias`-only head
  into a trusted `1.0` resolve.
- Preserve `opu one` fail-close behavior.
- Preserve current `noisy_recall` `40/40`.
- Preserve current `ambiguous_short_form` `0 wrong`.

### Design

- Introduce an explicit **resolve certification** predicate in the V2 decision
  path. Confidence + margin remain necessary, but are no longer sufficient on
  their own.
- Candidate evidence should be typed into `identity_grade`:
  `exact_alias`, `compact_exact`, `transliteration_exact`.
- Candidate evidence should be typed into `supportive_only`:
  `jamo_phonetic`.
- Candidate evidence should be typed into `recall_only`:
  `fuzzy_alias`, `family_graph`, `dense`.
- `recall_only` must never self-certify a `resolved` outcome, even when the
  resolver's trusted calibration outputs `1.0`.
- The first version should be deterministic and fail-closed. Once LTR serving
  is actually wired, the same certificate inputs can feed the reranker, but the
  reranker is not a prerequisite for closing this blocker.
- Do not patch this with a class-local threshold tweak. The owning invariant is:
  **recall evidence may retrieve a candidate, but identity evidence certifies a
  resolve**.

### Verification Rails

- Add a regression rail for the exact blocker:
  `Viña Espectro Maipo Valley Carmenere` must not resolve.
- Add a property-style rail that a `fuzzy_alias`-only top candidate cannot
  become `resolved` under trusted calibration.
- Re-run:
  - full authority eval
  - hotset smoke
  - `noisy_recall` sweep to confirm the current `40/40` recall holds

### DoD

- `Viña Espectro Maipo Valley Carmenere` becomes `ambiguous` or `failed`
- full authority eval removes the `no_match` wrong-positive
- hotset smoke stays `wrongPositive=0`

## Ticket ELV2-C2 — Close the exact-head false collision

Status: **completed 2026-06-03**

### Goal

Recover exact-entity recall for a query whose top candidate is identity-grade
exact, while keeping producer-family clarification for real producer-only
queries.

### Files To Touch

- `src/domain/resolver/service/ambiguity-classifier.ts`
- `src/domain/resolver/v2/**`
- `test/unit/resolver/**`
- `test/regression/**`

### Files To Create

- one regression rail that locks:
  - `2018 St. Supéry Élu` must not false-abstain

### Constraints

- Do not globally disable `producer_family_collision`.
- The override must be evidence-based:
  exact head identity that siblings do not share, not a broad threshold tweak.
- Preserve the current `ambiguous_short_form` precision win.

### Design

- Keep the V2 downgrade-only contract intact by fixing the **shared ambiguity
  owner seam** (`AmbiguityClassifier` / resolver path), not by teaching V2 to
  silently "upgrade" a resolver abstain.
- Extend producer-family ambiguity detection so it reasons about **identity
  exclusivity at the head**.
- If the top candidate carries exact/compact/transliteration-grade identity
  evidence, and competitive same-producer siblings do not carry the same
  identity support for distinct entities, then
  `producer_family_collision` must not fire.
- This must use structured evidence already present in candidate signals and/or
  alias evidence, not label-string heuristics.
- Treat this as a resolver correctness fix, not a V2 exception table.

### Verification Rails

- Add the exact regression rail:
  `2018 St. Supéry Élu` must resolve.
- Add counter-rails that real producer-only ambiguous queries still emit
  `producer_family_collision`.
- Re-run the full authority eval and the existing ambiguity-classifier unit rail.

### DoD

- `2018 St. Supéry Élu` resolves correctly
- producer-family clarification tests still pass on genuine same-producer cases
- full authority eval reaches `wrong=0, miss=0` or exposes a new real residue

## Ticket ELV2-C3 — Promote V2 to lookup authority

Status: **completed 2026-06-03**

### Goal

Once `ELV2-C1` and `ELV2-C2` are green, move lookup authority from the V1
surface to the V2 stack without breaking callers.

### Files To Touch

- `src/interface/http/routes/primitive-search.route.ts`
- `src/interface/http/routes/entity-lookup-v2.route.ts`
- `src/application/wine-search/adapters/search-use-case-adapter.ts`
- `src/application/wine-search/wine-agent-loop.ts`
- `src/infrastructure/cli/remote/remote-search-facade.ts`
- `test/integration/http/routes/**`
- `test/e2e/**`

### Files To Create

- compatibility/cutover regression rails for:
  - `/v1/lookup/wine`
  - agent `lookup_wine`
  - remote facade lookup

### Constraints

- Do not cut callers straight to a different wire contract without an adapter.
- Keep observability able to distinguish:
  - V1 legacy path
  - V2 authority path
  - any shadow/compat mode during transition

### Design

- Keep `/v1/lookup/wine` as the public compatibility contract, but back it with
  the V2 authority path once `ELV2-C1/C2` are green.
- Move agent/CLI facades after the HTTP compatibility rail is green; do not let
  three callers fork their own migration logic.
- Emit explicit authority telemetry so a request can be classified as:
  - `route=v1, authority=v2`
  - `route=v2, authority=v2`
  - `route=v1, authority=v1` only during pre-cutover shadow
- Removal of the V1 resolver path is a later purge step, not part of first
  authority promotion.

### DoD

- public lookup authority is V2-backed
- local CLI / agent lookup surfaces stop depending on the V1 resolver path
- remote callers still hit `/v1/lookup/wine`, but that route is now
  compatibility-backed by V2 authority

## Ticket ELV2-C4 — Benchmark and docs alignment cleanup

Status: **completed 2026-06-03**

### Goal

Remove stale “V2 is live” / missing-runner / missing-entrypoint confusion from
bench and docs so proof lanes match real execution surfaces.

### Files To Touch

- `package.json`
- `scripts/eval/freeze-agent-baseline.ts`
- `test/benchmark/agent/scenarios.ts`
- `docs/plans/jun-2-genearl/entity-lookup-v2/**`

### Files To Create

- only if needed: one canonical benchmark entrypoint doc for lookup authority

### Constraints

- If an entrypoint does not exist, do not document it as current.
- If a benchmark still targets V1 lookup, say so explicitly until `ELV2-C3`
  lands.
- Keep raw historical artifacts; mark them historical instead of silently
  deleting proof.

### Design

- Define one canonical quality authority lane:
  `pnpm run eval:lookup-v2:authority`.
- Define one fast smoke lane:
  `pnpm run eval:lookup-v2:shadow`.
- Anything else is historical, exploratory, or broken until proved executable.
- `freeze-agent-baseline.ts` and agent benchmark docs must either point at a
  real runner or lose their "current" wording.

### DoD

- no “current” doc points at a missing runner/command
- benchmark SSOT is `docs/bench/STATUS.md`
- lookup benchmark/docs clearly state whether they exercise direct legacy core,
  public compatibility route, or dedicated V2
- cutover docs and bench docs agree on the same executable authority surface

## Execution Order

1. `ELV2-C1`
2. `ELV2-C2`
3. rerun full authority eval + hotset smoke
4. `ELV2-C3`
5. `ELV2-C4`

## Stop Conditions

- If `ELV2-C1` removes the wrong-positive but creates any new wrong-positive in
  `ambiguous_short_form` or `no_match`, stop and re-open the owning seam.
- If `ELV2-C2` improves `St. Supéry Élu` by weakening producer-family guards
  globally, stop and replace with head-evidence-aware logic.
- Do not start `ELV2-C3` until the full authority gate is green.

## Phase 2 — Post-Cutover Latency Hardening (2026-06-03)

historical closeout note:

- `search-snapshot:v1:e88a45bedcb8d41f` 기준 older publish-green proof는
  historical only다.

current canonical note (2026-06-05):

- active runtime is now current-contract:
  - runtime state `search_snapshot_runtime_state.v7`
  - manifest `search_snapshot.v5`
  - snapshot `search-snapshot:v1:7bcd44a5484b2be5`
- `etl:migrate-runtime-state -- --manifest ...7bcd44a5484b2be5...` now
  provides a deterministic one-shot offline promote path for current-contract
  runtime cutover when operator-plane PG publish is unavailable.
- remaining owner seam is no longer lookup drift or lookup bootstrap. It is
  **real traffic canary / operator-plane environment**.

### Current Latency Truth

- executable lane:
  - `pnpm run eval:lookup-v2:latency:korean-famous -- --use-active-runtime --output /tmp/lookup-v2-latency-structural-final.json`
- latest result:
  - `bootstrap_ms=670.765`
  - `first_query_ms=400.941`
  - `warm_p50_ms=29.966`
  - `warm_p95_ms=63.767`
  - verdict: **PASS**
- latest coverage truth:
  - `pnpm run eval:lookup-v2:coverage -- --use-active-runtime --corpus test/fixtures/lookup-v2-korean-famous-expanded.jsonl --output /tmp/lookup-v2-coverage-korean-famous-structural-final.json`
  - `hot_entities=53/53`
  - `non_entity=22/22`
  - `curation_tasks=0`
- latest publish truth:
  - `pnpm run etl:migrate-runtime-state -- --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --active-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json`
  - active runtime snapshot `search-snapshot:v1:7bcd44a5484b2be5`
- latest self-canary truth:
  - `pnpm run eval:lookup-v2:canary:replay -- --input /tmp/lookup-v2-canary-built-sample.jsonl --baselineUseActiveRuntime --candidateUseActiveRuntime --output /tmp/lookup-v2-canary-replay-structural-final.json`
  - `hard_drift=0`, `soft_abstain_drift=0`, sample labeled `3/3`
- latest operator-plane publish note:
  - `pnpm run etl:publish-runtime-substrates -- --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --runtime-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json --refresh-active-runtime-substrates`
  - failed on this host with `getaddrinfo ENOTFOUND wine-engine-pg...`
- conclusion:
  - canonical active correctness / shadow / coverage / latency / self-canary are green
  - lookup bootstrap green came from trusted current-runtime alias parse + zero-copy alias hydration + staged lookup-direct bootstrap, not a threshold relaxation
  - remaining non-code residue is real traffic canary + operator-plane environment

### Phase-2 Invariants

- `eval:lookup-v2:authority` must remain `215/215`.
- `eval:lookup-v2:shadow` must remain `wrong+=0`.
- no heuristic shortcut / query allowlist / hardcoded exceptional path.
- latency optimization must preserve the precision-first ambiguity behavior:
  ambiguous short-form rows must stay ambiguous rather than wrong-resolving.
- artifact-only lookup authority must remain intact; no PG serving dependency is
  reintroduced to chase latency.

## Ticket ELV2-L1 — Candidate Generation Decoupling

Status: **planned**

### Goal

Remove the dominant `candidate_generation` wall time by splitting lookup
resolver hydration from full retrieval-document hydration.

### Evidence

- Worst rows spend `1.3s~2.4s` in `candidate_generation`.
- This stage currently calls `buildResolverCandidatesFromGenerator(...)`, which
  batch-hydrates every anchor/blocker/retrieval seed through `entityLookup`
  before the resolver runs.

### Files To Touch

- `src/application/search/search-usecase-resolver-candidates.ts`
- `src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.ts`
- `src/infrastructure/adapter/search-snapshot-entity-lookup.ts`
- `src/domain/shared/types/search-snapshot-lookup-runtime.ts`
- `scripts/etl/build-lookup-runtime-pack.ts`
- `scripts/etl/search-snapshot-schema.ts`
- `scripts/etl/build-search-snapshot.ts`
- `test/unit/entity-lookup-v2/**`
- `test/unit/etl/**`

### Design

- Introduce a **lookup-resolver candidate projection** that contains only the
  fields the resolver/scorer actually needs pre-decision.
- Stop hydrating full `RetrievalDocument` payloads for every seed during
  `candidate_generation`.
- Fold that projection into the runtime pack so lookup can read it from the
  published artifact rather than synthesizing it on the request path.
- Keep expensive metadata hydration behind the point where the candidate set is
  already narrowed and known to be needed for response projection.

### Constraints

- no partial-resolution / fail-open behavior
- no route-local heuristic cap on “number of candidates to hydrate”
- the new projection must remain an explicit artifact contract, not an ad hoc
  in-memory shape

### Verification Rails

- `pnpm run eval:lookup-v2:authority`
- `pnpm run eval:lookup-v2:shadow`
- `pnpm run eval:lookup-v2:latency:korean-famous`
- add a regression/assertion that `candidate_generation` no longer dominates the
  current top-offender queries

### DoD

- top-offender `candidate_generation` time reduced by at least 50%
- `warm_p95_ms < 2300` without correctness regression

## Ticket ELV2-L2 — Planner Lane Separation For Lookup Authority

Status: **planned**

### Goal

Strip lookup authority off planner branches that are useful for discovery /
interpretation but too expensive for canonical known-item resolution.

### Evidence

- `planner_total` still reaches `700ms~1000ms` on `오푸스원`, `라피트 로쉴드`,
  `샤또 오 브리옹`, `무똥 로쉴드`.
- current planner can still be wired with `LlmNLMapper`,
  `ConstraintTopologyPlanner`, and `AmbiguityIntentCompiler`, all built from
  the generic search container.

### Files To Touch

- `src/config/container-core-builders.ts`
- `src/domain/query/service/planner.ts`
- `src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.ts`
- `src/domain/query/model/**`
- `test/unit/entity-lookup-v2/**`
- `test/unit/application/search/**`

### Design

- Define a **lookup-authority planner profile**:
  - keeps anchor extraction, normalization, and deterministic uncertainty
  - disables LLM-bearing or discovery-oriented planner branches on the
    lookup authority lane
- Wire that profile only for `EntityLookupV2UseCase`; generic search keeps its
  current richer planner surface.
- Treat lookup as an entity-resolution lane, not a generic semantic parse lane.

### Constraints

- no change to public `/v2/entity-lookup` contract
- no regression on concept redirect / under-specified gate behavior
- no silent change to generic search planner behavior

### Verification Rails

- exact regression rows:
  - `오푸스원`
  - `라피트 로쉴드`
  - `샤또 오 브리옹`
- full authority + shadow + latency reruns

### DoD

- worst-row `planner_total` reduced below `400ms`
- `오푸스원` no longer spends ~`1s` in planner

## Ticket ELV2-L3 — Short Ambiguity / Blocker Pressure Relief

Status: **planned**

### Goal

Reduce blocker and broad recall blow-up on short ambiguous iconic surfaces
without weakening fail-closed ambiguity behavior.

### Evidence

- `샤또`: `blocker=442ms`, `retrieval_total=408ms`
- `샤토`: `blocker=362ms`, `retrieval_total=350ms`
- `크룩`, `이켐` also show blocker-heavy profiles

### Files To Touch

- `src/domain/resolver/service/blocker.ts`
- `src/application/search/entity-lookup-v2/multi-channel-retrieval-engine.ts`
- `src/domain/query/service/planner.ts`
- `src/domain/query/model/**`
- `test/unit/entity-lookup-v2/**`
- `test/regression/**`

### Design

- Add a deterministic **short-ambiguity lane** for iconic short forms:
  - preserve ambiguity as the terminal behavior
  - avoid needlessly broad blocker expansion when retrieval/family-graph already
    establishes an ambiguity cluster
- Audit `family_graph` recall on short ambiguous terms and keep only the
  structural work needed to surface clarification options.
- The target is not “resolve more”; the target is “be ambiguous faster”.

### Constraints

- no degradation of `ambiguous_short_form` precision
- no producer-family false resolve
- no per-query heuristic exception list

### DoD

- `샤또` / `샤토` blocker + retrieval combined cost materially reduced
- ambiguous output preserved on the same rows

## Ticket ELV2-L4 — Ambiguity Graph Read Path Compression

Status: **planned**

### Goal

Lower the `ambiguity_lookup` read cost on ambiguous rows once larger owners are
handled.

### Evidence

- current `ambiguity_lookup` is usually `28ms~43ms`
- not the main bottleneck, but it is always on the ambiguous path

### Files To Touch

- `src/domain/query/port/ambiguity-dictionary.port.ts`
- `src/infrastructure/adapter/pg-ambiguity-dictionary.ts`
- `src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.ts`
- `test/unit/**`

### Design

- keep the persisted ambiguity substrate, but compress the read path:
  cache/materialize by normalized query key inside the snapshot/runtime plane
  instead of paying the full lookup on every ambiguous request

### DoD

- ambiguous rows keep the same types/severity
- `ambiguity_lookup` drops into single-digit ms on warm path

## Ticket ELV2-L5 — Bench / SLO Governance

Status: **planned**

### Goal

Make latency a first-class release gate the same way correctness already is.

### Files To Touch

- `docs/bench/STATUS.md`
- `docs/plans/jun-2-genearl/entity-lookup-v2/cutover-checklist.md`
- `scripts/eval/run-lookup-v2-latency-korean-famous.ts`
- `test/regression/**`

### Design

- keep the instrumented latency lane as SSOT for post-cutover performance
- track stage owners explicitly:
  - `planner_total`
  - `retrieval_total`
  - `candidate_generation`
  - `blocker`
  - `resolver`
  - `ambiguity_lookup`
- fail when a new latency regression lands even if correctness stays green

### DoD

- latency lane documented as current executable lane
- stage-owner artifact is stable enough for PR regression use

## Phase-2 Execution Order

1. `ELV2-L1`
2. `ELV2-L2`
3. rerun full latency lane
4. `ELV2-L3`
5. rerun full latency lane + authority + shadow
6. `ELV2-L4`
7. `ELV2-L5`

## Phase-2 Stop Conditions

- If `ELV2-L1` improves latency by caching or omitting fields in a way that
  changes resolver semantics, stop and move the projection boundary later.
- If `ELV2-L2` improves latency by weakening concept admission or ambiguity
  behavior, stop and restore the shared planner invariants.
- If `ELV2-L3` improves short-form latency by converting ambiguity into resolve,
  stop immediately.
