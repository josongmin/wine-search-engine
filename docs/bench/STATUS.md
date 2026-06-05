# Bench Status (2026-06-05)

이 폴더의 current SSOT는 이 문서다.

## Current executable lanes

- `pnpm run bench:smoke`
  - deterministic agent-benchmark scorer/unit/regression lane
  - PR workflow `.github/workflows/bench-smoke.yml`가 실제로 호출하는 lane
- `pnpm run bench:agent:export-scenarios-md`
  - `AGENT_SCENARIOS.md` regeneration only
- `pnpm run eval:lookup-v2:authority [-- --output /tmp/entity-resolution-validation.json]`
  - lookup authority full-distribution gate
- `pnpm run eval:lookup-v2:shadow [-- --output /tmp/lookup-v2-shadow-report.json]`
  - lookup hotset smoke gate
  - explicit `lookupAuthorityMode='legacy_core'` baseline vs dedicated V2 비교이며, cutover 이후 public `/v1/lookup/wine` route parity proof와는 다르다
  - exploratory stretch run:
    `pnpm run eval:lookup-v2:shadow:korean-realworld-stretch`
    는 non-gating real-world expansion lane이다. green cutover truth가 아니라, 현재 runtime의 Korean long-tail precision / redirect gap을 드러내는 목적이다
  - stretch owner-split lanes:
    - `pnpm run eval:lookup-v2:shadow:korean-realworld-stretch:entity-only`
    - `pnpm run eval:lookup-v2:shadow:korean-realworld-stretch:entity-no-policy`
    - `pnpm run eval:lookup-v2:shadow:korean-realworld-stretch:policy-conflict`
    - `pnpm run eval:lookup-v2:shadow:korean-realworld-stretch:discovery-only`
- `pnpm run eval:lookup-v2:coverage [-- --output /tmp/lookup-v2-coverage-report.json]`
  - lookup hot-entity coverage / curation signal
  - authority/shadow와 동일하게 live PG pool을 주입한 authoritative substrate에서 실행해야 한다
  - exploratory stretch run:
    `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch`
    는 non-gating real-world expansion lane이다. green cutover truth가 아니라, 현재 runtime이 놓치는 Korean collapsed typo / producer-prefixed / recommendation phrase gap을 드러내는 목적이다
  - stretch entity-owner lanes:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-only`
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy`
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-draft`
      - entity-no-policy coverage artifact를 exact-safe curation draft JSONL로 투영한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-exact-safe-packet`
      - `auto_targetable` draft row만 exact-safe reviewed proposal packet으로 분리한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-exact-safe-family-review-packet`
      - exact-safe row packet을 entity-family review packet으로 압축한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-exact-safe-family-review-packet`
      - entity-family exact-safe packet에 decision overlay를 merge한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-exact-safe-family-review-packet`
      - entity-family reviewed decision을 row-level exact-safe packet으로 deterministic projection한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-policy-review-packet`
      - `policy_review` draft row만 reviewed authority-policy packet으로 분리한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-policy-family-review-packet`
      - reviewed authority-policy row packet을 family-level decision packet으로 압축한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-policy-family-review-packet`
      - family-level authority-policy packet에 decision overlay를 merge한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-policy-family-review-packet`
      - family-level reviewed decision을 row-level policy packet으로 deterministic projection한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-policy-review-packet`
      - authority-policy reviewed packet에 decision overlay를 merge한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-policy-review-packet`
      - reviewed authority-policy packet에서 `approved_exact_safe` row만 approved exact-safe packet으로 투영한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-exact-safe-packet`
      - decision overlay를 reviewed packet으로 merge한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-exact-safe-packet`
      - reviewed packet에서 `proposalStatus=approved` row만 fail-closed exact-safe registry merge candidate로 적용한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-manual-target-batches`
      - `manual_target` draft row를 class-batched operator queue로 분리한다
- `pnpm run eval:lookup-v2:latency:korean-famous [-- --output /tmp/lookup-v2-latency-korean-famous.json]`
  - post-cutover lookup latency / SLO gate
  - dedicated `lookup_direct_container` bootstrap만 잰다; generic search/server monolith bootstrap은 이 lane의 범위가 아니다
  - authority/coverage 같은 heavy live rails와 병렬 실행하면 bootstrap / p95가 쉽게 오염된다; canonical latency truth는 isolated run만 인정한다
  - artifact는 `slo.cold_boot`, `slo.request`, `slo.runtime_hydration`을 분리 출력한다; 운영 판단도 cold-start와 steady-state request를 분리해서 해야 한다
  - current owner-stage artifact는 `planner_total`, `retrieval_total`,
    `candidate_generation`, `blocker`, `resolver`, `ambiguity_lookup`를 함께 출력한다
  - current canonical active truth는
    `/tmp/lookup-v2-latency-structural-final.json`
    기준 `cold_boot measured_ms=670.765`,
    `request first_query_ms=400.941`, `warm_p95_ms=63.767`로 **PASS**다
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
  - `search-snapshot:v1:e38d7c7eb74c15e9`
- active runtime state:
  - `search_snapshot_runtime_state.v7`
- active manifest schema:
  - `search_snapshot.v5`
- readiness:
  - bootstrap verify PASS
  - pointer parity verify PASS
- authority:
  - `/tmp/entity-resolution-validation-stretch-partition-fix.json`
  - `V2 215/215`, `wrong=0`, `miss=0`
- shadow:
  - `/tmp/lookup-v2-shadow-gating-stretch-partition-fix.json`
  - `rows=45`, `V2 correct=41`, `wrong+=0`, `regressions=0`
- Korean-famous coverage:
  - `/tmp/lookup-v2-coverage-korean-famous-stretch-partition-fix.json`
  - `hot_entities=70/70`, `non_entity=37/37`, `curation_tasks=0`
- latency:
  - `/tmp/lookup-v2-latency-structural-final.json`
  - `cold_boot measured_ms=670.765` -> **PASS**
  - `request first_query_ms=400.941`, `warm_p50_ms=29.966`, `warm_p95_ms=63.767` -> **PASS**
  - `runtime_hydration fully_hydrated_runtime_artifact=true`, `lazy_build_detected_during_probe=false`
- canary self-replay:
  - `/tmp/lookup-v2-canary-replay-structural-final.json`
  - `hard_drift=0`, `soft_abstain_drift=0`, sample labeled `3/3`
- benchmark scope:
  - hotset fixture `test/fixtures/lookup-v2-hotset.jsonl` now covers 45 labeled rows
  - Korean-famous corpus `test/fixtures/lookup-v2-korean-famous-expanded.jsonl` now covers 107 labeled rows
  - real-world stretch corpus `test/fixtures/lookup-v2-korean-realworld-stretch.jsonl` now covers 746 labeled rows
  - added pressure includes Korean iconic short-form ambiguity (`마고`, `라투르`, `샹베르탱`), Korean typos (`사시카야`, `페트루스`), Korean recommendation phrases (`까쇼 추천해줘`, `기념일 와인 추천`), and Koreanized adversarial no-match (`샤또 미라쥬 2022`, `도멘 판타지 부르고뉴`)
  - stretch corpus adds harder realistic gaps such as collapsed producer-family spellings (`라피트로쉴드`, `무똥로쉴드`), producer-prefixed forms (`샤또 오브리옹`), French-leaning Korean transliterations (`페트뤼스`), iconic Napa/Burgundy gaps (`도미누스`, `조셉 펠프스 인시그니아`, `코슈뒤리`), and sentence-level recommendation phrases (`샴페인 선물 추천`, `소고기 와인 추천`)
  - external-LLM expanded stretch append:
    `elv2-krx-201 ~ elv2-krx-700` added 500 rows with requested `4:2:2:2`
    split (`resolved=200`, `ambiguous=100`, `redirect_discovery=100`,
    `failed=100`)
  - current stretch corpus total is 746 rows (`46` seed + `700` krx rows)
- exploratory stretch truth (non-gating, still red):
  - shadow:
    `/tmp/lookup-v2-shadow-korean-realworld-stretch-post-support-fix.json`
    -> `rows=746`, `V2 correct=213`, `wrong+=6`, `concept_redirect_acc=0.100`, gate **FAIL**
  - coverage:
    `/tmp/lookup-v2-coverage-korean-realworld-stretch-post-support-fix.json`
    -> `hot_entities=42/310`, `non_entity=171/436`, `curation_tasks=268`
  - interpretation:
    this lane is intentionally wider than current curated authority/coverage
    corpora and is used to expose long-tail Korean alias / recommendation /
    producer-prefixed gaps, not to declare current cutover red
  - owner-split truth:
    - reviewed policy-conflict registry:
      `data/lookup-v2/lookup-policy-conflict-registry-v1.jsonl`
    - discovery-only shadow:
      `/tmp/lookup-v2-shadow-korean-realworld-stretch-discovery-only.json`
      -> `rows=150`, `V2 correct=15`, `wrong+=0`, `concept_redirect_acc=0.100`, gate **FAIL**
    - policy-conflict-only shadow:
      `/tmp/lookup-v2-shadow-korean-realworld-stretch-policy-conflict-post-support-fix.json`
      -> `rows=6`, `V2 correct=0`, `wrong+=6`, gate **FAIL**
    - entity-only shadow:
      `/tmp/lookup-v2-shadow-korean-realworld-stretch-entity-only.json`
      -> `rows=596`, `V2 correct=198`, `wrong+=6`, gate **FAIL**
    - entity-no-policy shadow:
      `/tmp/lookup-v2-shadow-korean-realworld-stretch-entity-no-policy-post-support-fix.json`
      -> `rows=590`, `V2 correct=198`, `wrong+=0`, gate **PASS**
    - entity-no-policy coverage:
      `/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json`
      -> `hot_entities=42/310`, `non_entity=156/280`, `curation_tasks=268`
    - entity-no-policy curation draft:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl`
      -> `rows=268`, `benchmarkGoldHint=268`, `benchmarkGoldEntityId=46`
      -> `triageBucket auto_targetable=6`, `policy_review=28`, `manual_target=234`
      -> weak `hint_resolution` no longer auto-promotes to exact-safe authority
      -> `benchmarkGoldEntityIdSuggestion=12` now stays on `manual_target`
    - entity-no-policy exact-safe reviewed packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl`
      -> `rows=6`
      -> current registry exact collision `0`, current registry conflicting owner `0`
      -> source split:
         `runtime_identity_safe_alias=6`
      -> class split:
         `realworld_exact_vintage=2`, `realworld_brand_suffix=2`,
         `realworld_korean_orthography=1`, `realworld_compact_alias=2`,
         `realworld_mixed_script_alias=3`, `realworld_producer_prefixed=1`,
         `realworld_spaced_alias=3`, `realworld_vintage_suffix=3`,
         `realworld_frenchish_korean_gap=1`
    - entity-no-policy exact-safe family-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl`
      -> `input_rows=6`, `family_rows=1`
      -> operator decision fan-out reduced from `6` row decisions to `1` entity decision
    - entity-no-policy exact-safe family suggestions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-suggestions.jsonl`
      -> `suggest_approve=0`, `manual_review=1`
      -> `runtime_identity_safe_alias` only는 target authority일 뿐 exact-safe auto-approve source가 아니다
      -> semantic-expanding class
         (`brand_suffix`, `producer_prefixed`, `mixed_script_alias`, `vintage_suffix`, `exact_vintage`)
         포함 family는 manual review로 강등
    - entity-no-policy exact-safe suggested decisions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family.suggested-decisions.jsonl`
      -> `rows=0`
      -> current deterministic auto-approve candidate 없음
    - entity-no-policy policy-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl`
      -> `rows=28`
      -> `with benchmarkGoldEntityId=28`, `without target=0`
      -> source split:
         `policy_registry_authority=28`
      -> counts by reviewed policy surface:
         `라뚜르=10`, `그랜지=10`, `베가 시실리아=7`, `무통=1`
    - entity-no-policy policy-family-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl`
      -> `input_rows=28`, `family_rows=4`
      -> operator decision fan-out reduced from `28` row decisions to `4` family decisions
    - entity-no-policy policy-family suggestions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-suggestions.jsonl`
      -> `suggest_keep_policy_conflict=4`, `manual_review=0`
      -> fail-closed broad conflict default:
         `라뚜르`, `그랜지`, `베가 시실리아`, `무통`
    - entity-no-policy policy-family suggested decisions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family.suggested-decisions.jsonl`
      -> `rows=4`
    - entity-no-policy policy-review dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed-empty-current.jsonl`
      -> `packet_rows=28`, `decision_rows=0`, `approved_exact_safe=0`, `kept_policy_conflict=0`, `needs_target=0`, `pending=28`
    - entity-no-policy policy-family-review dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed-empty-current.jsonl`
      -> `packet_rows=4`, `decision_rows=0`, `approved_exact_safe=0`, `kept_policy_conflict=0`, `needs_target=0`, `pending=4`
    - entity-no-policy policy-family-apply dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed-from-family-empty-current.jsonl`
      -> `family_rows=4`, `row_packet_rows=28`, `approved_exact_safe_rows=0`, `kept_policy_conflict_rows=0`, `needs_target_rows=0`, `pending_rows=28`
    - entity-no-policy policy-family suggested dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-policy-family-review-reviewed-suggested-current.jsonl`
      -> `packet_rows=4`, `decision_rows=4`, `kept_policy_conflict=4`, `pending=0`
      `/tmp/lookup-v2-korean-realworld-stretch-policy-review-reviewed-from-family-suggested-current.jsonl`
      -> `family_rows=4`, `row_packet_rows=28`, `kept_policy_conflict_rows=28`, `pending_rows=0`
    - entity-no-policy policy-review apply dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-policy-review-approved-exact-safe-packet-from-family-empty-current.jsonl`
      -> `approved_exact_safe_rows=0`, `kept_policy_conflict_rows=0`, `needs_target_rows=0`, `pending_rows=28`, `exact_safe_packet_rows=0`
    - entity-no-policy exact-safe review dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals-reviewed-empty-current.jsonl`
      -> current stale baseline before `hint_resolution` downgrade
    - entity-no-policy exact-safe family-review dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-exact-safe-family-review-reviewed-empty-current3.jsonl`
      -> `packet_rows=1`, `decision_rows=0`, `approved=0`, `rejected=0`, `pending=1`
    - entity-no-policy exact-safe family-apply dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals-reviewed-from-family-empty-current3.jsonl`
      -> `family_rows=1`, `row_packet_rows=6`, `approved_rows=0`, `rejected_rows=0`, `pending_rows=6`
    - entity-no-policy exact-safe apply dry-run:
      `/tmp/korean-exact-safe-registry-merged-from-family-empty-current.jsonl`
      -> `approved_rows=0`, `inserted_rows=0`, `skipped_existing_rows=0`
      -> current packet은 아직 review 전이므로 registry merge candidate만 생성 가능하다
    - entity-no-policy manual-target batches:
      `data/lookup-v2/drafts/manual-target-batches/index.json`
      -> `totalRows=234`, `batchCount=11`
      -> top queue split:
         `realworld_exact_vintage=41`, `realworld_brand_suffix=29`,
         `realworld_compact_alias=29`, `realworld_korean_orthography=30`,
         `realworld_mixed_script_alias=30`, `realworld_producer_prefixed=26`,
         `realworld_vintage_suffix=28`, `realworld_spaced_alias=18`
    - entity-no-policy manual-target family-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl`
      -> `input_rows=234`, `family_rows=36`
      -> operator decision fan-out reduced from `234` row decisions to `36` benchmark-hint decisions
      -> packet now carries runtime owner evidence directly:
         `runtimeEvidenceStatus`, `runtimeEvidenceEntityId/Label`,
         `runtimeCollisionEntityIds/Labels`
      -> current largest families:
         `calon segur=14`, `silver oak=14`, `caymus=13`, `masseto=11`,
         `salon=11`, `veuve clicquot=11`, `armand de brignac=11`
    - entity-no-policy manual-target family suggestions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl`
      -> `candidate_unique_owner=4`, `collision_candidates=9`, `missing_runtime_owner=23`
      -> `runtime_unique_surface_owner`는 weak target hint일 뿐 auto decision source가 아니다
      -> current unique-owner hints:
         `ausone`, `montelena`, `pavie`, `petrus`
    - entity-no-policy manual-target suggested decisions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl`
      -> `rows=0`
      -> current deterministic auto-assign candidate 없음
    - entity-no-policy manual-target family-review dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed-empty-current3.jsonl`
      -> `packet_rows=36`, `decision_rows=0`, `target_assigned=0`, `rejected=0`, `pending=36`
    - entity-no-policy manual-target family-apply dry-run:
      `/tmp/lookup-v2-korean-realworld-stretch-manual-target-approved-exact-safe-packet-empty-current3.jsonl`
      -> `family_rows=36`, `target_assigned_families=0`, `rejected_families=0`, `pending_families=36`, `exact_safe_packet_rows=0`
  - partition RCA:
    - `discovery-only`는 entity lookup owner가 아니다
    - `policy-conflict-only` 6건은 reviewed registry-owned short-form / broad-icon authority policy 충돌이다:
      `라뚜르`, `그랜지`, `베가 시실리아`, `자코모 콘테르노`, `라피트`, `무통`
    - `entity-no-policy` lane에서 남던 `realworld_fake_chateau_label` regression은
      multi-token fragment anchor pruning 강화 후 제거됐다
    - core support plane also now encodes the same boundary:
      `CORE_KOREAN_ICON_QUERY_CASES` gained `identitySafe=false` for
      `베가 시실리아`, `자코모 콘테르노`, and exact-positive rails / alias-runtime
      regressions filter on that bit instead of silently treating them as
      strict singleton positives
    - write-plane backlog is now split structurally:
      `auto_targetable 6` lifts to a reviewed exact-safe proposal packet,
      then compresses to `exact_safe_family_review 1` for operator decision,
      then projects back into the row packet through a deterministic family-apply seam,
      `policy_review 28` lifts to a separate reviewed authority-policy packet,
      then compresses to `policy_family_review 4` for operator decision,
      then projects back into the row packet through a deterministic family-apply seam,
      and `manual_target 234` now lifts to `manual_target_family_review 36`,
      which can deterministically project into an exact-safe proposal packet,
      before falling through the same exact-safe family-review/apply seam
    - total operator fan-out on the stretch write plane is now reduced from
      `268 row decisions` (`6 + 28 + 234`) to
      `41 family decisions` (`1 + 4 + 36`)
  - current applied stretch-specific authority additions improved:
    - collapsed typo / compact Korean exact-safe surfaces:
      `라피트로쉴드`, `무똥로쉴드`, `오브리앙`, `샤또 오브리옹`,
      `도멘드라로마네콩티`, `코슈뒤리`, `크루그 그랑뀌베`,
      `크루그 그랑큐베`, `사시까야`, `할란에스테이트`,
      `조셉 펠프스 인시그니아`
    - ambiguity hardening:
      `살롱`, `모엣 샹동`, `페트루스`
  - current residual red is dominated by:
    - unresolved exact-safe backlog:
      `realworld_exact_vintage=50`, `realworld_brand_suffix=35`,
      `realworld_mixed_script_alias=35`, `realworld_korean_orthography=34`,
      `realworld_compact_alias=34`, `realworld_vintage_suffix=29`,
      `realworld_producer_prefixed=28`, `realworld_spaced_alias=20`
    - policy-conflict ambiguity rows that collide with existing green gates:
      `라뚜르`, `그랜지`, `베가 시실리아`, `자코모 콘테르노`, `라피트`, `무통`
- artifact-only runtime promote:
  - `pnpm run etl:publish-runtime-substrates:artifact-only -- --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:e38d7c7eb74c15e9/manifest.json --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --runtime-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json`
  - result: PASS
  - active runtime file points at
    `/Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:e38d7c7eb74c15e9/manifest.json`
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
