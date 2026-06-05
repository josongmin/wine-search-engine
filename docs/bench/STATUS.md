# Bench Status (2026-06-04)

이 폴더의 current SSOT는 이 문서다.

## Current executable lanes

- `pnpm run bench:smoke`
  - deterministic agent-benchmark scorer/unit/regression lane
  - PR workflow `.github/workflows/bench-smoke.yml`가 실제로 호출하는 lane
- `pnpm run bench:agent:export-scenarios-md`
  - `AGENT_SCENARIOS.md` regeneration only
- `pnpm run eval:lookup-v2:authority -- --output /tmp/entity-resolution-validation.json`
  - lookup authority full-distribution gate
- `pnpm run eval:lookup-v2:shadow -- --output /tmp/lookup-v2-shadow-report.json`
  - lookup hotset smoke gate
  - explicit `lookupAuthorityMode='legacy_core'` baseline vs dedicated V2 비교이며, cutover 이후 public `/v1/lookup/wine` route parity proof와는 다르다
- `pnpm run eval:lookup-v2:coverage -- --output /tmp/lookup-v2-coverage-report.json`
  - lookup hot-entity coverage / curation signal
  - authority/shadow와 동일하게 live PG pool을 주입한 authoritative substrate에서 실행해야 한다
- `pnpm run eval:lookup-v2:latency:korean-famous -- --output /tmp/lookup-v2-latency-korean-famous.json`
  - post-cutover lookup latency / SLO gate
  - dedicated `lookup_direct_container` bootstrap만 잰다; generic search/server monolith bootstrap은 이 lane의 범위가 아니다
  - current owner-stage artifact는 `planner_total`, `retrieval_total`,
    `candidate_generation`, `blocker`, `resolver`, `ambiguity_lookup`를 함께 출력한다
  - current canonical active truth는
    `/tmp/lookup-v2-latency-korean-famous-active-v7-postmigrate.json`
    기준 `bootstrap_ms=1165.313`, `first_query_ms=375.211`,
    `warm_p50_ms=31.755`, `warm_p95_ms=154.544`로 **PASS**다
- `pnpm run eval:lookup-v2:canary:replay -- --input <jsonl> --baselineUseActiveRuntime --candidateUseActiveRuntime --output /tmp/lookup-v2-canary-replay.json`
  - lookup runtime self-replay / baseline-vs-candidate drift gate
  - explicit runtime binding이 필수다; real traffic mirror input은 외부에서 공급해야 한다
  - current self-replay truth는 `/tmp/lookup-v2-canary-replay-active-postmigrate.json`
    기준 `hard_drift=0`, `soft_abstain_drift=0`, labeled `75/75`로 **PASS**다

## Current Truth

- active runtime snapshot:
  - `search-snapshot:v1:7bcd44a5484b2be5`
- active runtime state:
  - `search_snapshot_runtime_state.v7`
- active manifest schema:
  - `search_snapshot.v5`
- readiness:
  - bootstrap verify PASS
  - pointer parity verify PASS
- authority:
  - `/tmp/entity-resolution-validation-active-v7-postmigrate.json`
  - `V2 215/215`, `wrong=0`, `miss=0`
- shadow:
  - `/tmp/lookup-v2-shadow-active-v7-postmigrate.json`
  - `rows=31`, `V2 correct=27`, `wrong+=0`, `regressions=0`
- Korean-famous coverage:
  - `/tmp/lookup-v2-coverage-korean-famous-active-v7-postmigrate.json`
  - `hot_entities=53/53`, `non_entity=22/22`, `curation_tasks=0`
- latency:
  - `/tmp/lookup-v2-latency-korean-famous-active-v7-postmigrate.json`
  - `bootstrap_ms=1165.313`, `first_query_ms=375.211`,
    `warm_p50_ms=31.755`, `warm_p95_ms=154.544`
  - verdict: **PASS**
- canary self-replay:
  - `/tmp/lookup-v2-canary-replay-active-postmigrate.json`
  - `hard_drift=0`, `soft_abstain_drift=0`, labeled `75/75`
- active runtime promote:
  - `pnpm run etl:migrate-runtime-state -- --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --active-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json`
  - result: PASS (`explicit_manifest_promote`)
  - active runtime file now points at
    `/Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json`
- operator-plane publish:
  - `publish-runtime-substrates --refresh-active-runtime-substrates` against the new snapshot failed on this host with `getaddrinfo ENOTFOUND wine-engine-pg...`
  - this is environment residue, not lookup-serving residue
- bootstrap RCA:
  - remaining generic monolith bootstrap tax와 lookup-direct bootstrap을 분리했다
  - lookup lanes now boot through `createLookupDirectContainer`
  - lookup-direct bootstrap bottleneck was full `createContainer` reuse였다; current direct bootstrap is green

## Non-current / fail-closed

- `test/benchmark/agent/runner.ts`
  - 현재 checkout에 없다
- `scripts/eval/freeze-agent-baseline.ts`
  - runner 부재를 감지하면 fail-closed 한다
- direct `SearchUseCase.execute({ primitiveRoute: 'lookup_wine' })`
  - removed surface
  - lookup authority는 dedicated `EntityLookupV2UseCase` only다
- runner-based archive / compare / power-analysis docs
  - historical or dormant design notes only until a real runner is restored

## Documentation policy

- current 문서에서 missing command / missing file를 executable lane처럼 적지 않는다
- lookup authority 품질 판단은 `docs/plans/jun-2-genearl/entity-lookup-v2/cutover-checklist.md`와
  `docs/plans/jun-2-genearl/entity-lookup-v2/IMPROVEMENT-PLAN-2026-06-03.md`를 따른다
