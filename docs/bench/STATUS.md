# Bench Status (2026-06-05)

이 폴더의 current SSOT는 이 문서다.

## Current executable lanes

- `pnpm run bench:smoke`
  - deterministic agent-benchmark scorer/unit/regression lane
  - PR workflow `.github/workflows/bench-smoke.yml`가 실제로 호출하는 lane
- `pnpm run bench:agent:export-scenarios-md`
  - `AGENT_SCENARIOS.md` regeneration only
- `pnpm run eval:lookup-v2:authority -- --use-active-runtime --output /tmp/entity-resolution-validation.json`
  - lookup authority full-distribution gate
- `pnpm run eval:lookup-v2:shadow -- --use-active-runtime --output /tmp/lookup-v2-shadow-report.json`
  - lookup hotset smoke gate
  - explicit `lookupAuthorityMode='legacy_core'` baseline vs dedicated V2 비교이며, cutover 이후 public `/v1/lookup/wine` route parity proof와는 다르다
- `pnpm run eval:lookup-v2:coverage -- --use-active-runtime --output /tmp/lookup-v2-coverage-report.json`
  - lookup hot-entity coverage / curation signal
  - authority/shadow와 동일하게 live PG pool을 주입한 authoritative substrate에서 실행해야 한다
- `pnpm run eval:lookup-v2:latency:korean-famous -- --use-active-runtime --output /tmp/lookup-v2-latency-korean-famous.json`
  - post-cutover lookup latency / SLO gate
  - dedicated `lookup_direct_container` bootstrap만 잰다; generic search/server monolith bootstrap은 이 lane의 범위가 아니다
  - authority/coverage 같은 heavy live rails와 병렬 실행하면 bootstrap / p95가 쉽게 오염된다; canonical latency truth는 isolated run만 인정한다
  - artifact는 `slo.cold_boot`, `slo.request`, `slo.runtime_hydration`을 분리 출력한다; 운영 판단도 cold-start와 steady-state request를 분리해서 해야 한다
  - current owner-stage artifact는 `planner_total`, `retrieval_total`,
    `candidate_generation`, `blocker`, `resolver`, `ambiguity_lookup`를 함께 출력한다
  - current canonical active truth는
    `/tmp/lookup-v2-latency-runtime-bundle-manifest-once.json`
    기준 `cold_boot measured_ms=1629.921`,
    `request first_query_ms=329.336`, `warm_p95_ms=195.639`로 **PASS**다
- `pnpm run eval:lookup-v2:canary:build -- --input <traffic.ndjson> --output <corpus.jsonl> --query-field <dotted.path> [route/method filters]`
  - explicit real-traffic canary corpus extractor
  - heuristic field guessing 없이 dotted-path 계약으로만 replay corpus를 만든다
  - current sample proof는 `/tmp/lookup-v2-canary-built-sample.jsonl` 이다
- `pnpm run eval:lookup-v2:canary:replay -- --input <jsonl> --baselineUseActiveRuntime --candidateUseActiveRuntime --output /tmp/lookup-v2-canary-replay.json`
  - lookup runtime self-replay / baseline-vs-candidate drift gate
  - explicit runtime binding이 필수다; real traffic mirror raw logs는 외부에서 공급하고, replay corpus는 `canary:build` lane으로 만든다
  - current self-replay truth는 `/tmp/lookup-v2-canary-replay-active-2026-06-05-post-bootstrap-fix.json`
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
  - `/tmp/entity-resolution-validation-active-2026-06-05-post-bootstrap-fix.json`
  - `V2 215/215`, `wrong=0`, `miss=0`
- shadow:
  - `/tmp/lookup-v2-shadow-active-2026-06-05-post-bootstrap-fix.json`
  - `rows=31`, `V2 correct=27`, `wrong+=0`, `regressions=0`
- Korean-famous coverage:
  - `/tmp/lookup-v2-coverage-korean-famous-active-2026-06-05-post-bootstrap-fix.json`
  - `hot_entities=53/53`, `non_entity=22/22`, `curation_tasks=0`
- latency:
  - `/tmp/lookup-v2-latency-runtime-bundle-manifest-once.json`
  - `cold_boot measured_ms=1629.921` -> **PASS**
  - `request first_query_ms=329.336`, `warm_p50_ms=14.433`, `warm_p95_ms=195.639` -> **PASS**
  - `runtime_hydration fully_hydrated_runtime_artifact=true`, `lazy_build_detected_during_probe=false`
- canary self-replay:
  - `/tmp/lookup-v2-canary-replay-active-2026-06-05-post-bootstrap-fix.json`
  - `hard_drift=0`, `soft_abstain_drift=0`, labeled `75/75`
- artifact-only runtime promote:
  - `pnpm run etl:publish-runtime-substrates:artifact-only -- --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --runtime-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json`
  - result: PASS
  - active runtime file points at
    `/Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json`
- operator-plane PG publish:
  - `publish-runtime-substrates --refresh-active-runtime-substrates` can still be environment-blocked on this host (`getaddrinfo ENOTFOUND wine-engine-pg...`)
  - this is no longer a lookup-direct publish blocker because current-contract artifact-only promote is executable and verified
- bootstrap RCA:
  - remaining generic monolith bootstrap tax와 lookup-direct bootstrap을 분리했다
  - lookup lanes now boot through `createLookupDirectContainer`
  - lookup-direct bootstrap bottleneck was alias runtime deep-parse + eager fanout이었다
  - current direct bootstrap is green after trusted current-runtime alias parse, zero-copy alias hydration, staged bootstrap

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
