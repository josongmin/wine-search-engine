# Bench Status (2026-06-07)

이 폴더의 current SSOT는 이 문서다.

## Current Truth Update (2026-06-07)

- active runtime snapshot:
  - `search-snapshot:v1:ca6596580fb755ef`
- active runtime state:
  - `search_snapshot_runtime_state.v7`
- active manifest schema:
  - `search_snapshot.v5`
- correctness gates:
  - authority:
    - `/tmp/entity-resolution-validation.json`
    - `V2 215/215`, `wrong=0`, `miss=0`, gate **PASS**
  - hotset shadow:
    - `/tmp/lookup-v2-shadow-report.json`
    - `rows=45`, `V2 correct=41`, `wrong+=0`, gate **PASS**
  - Korean-famous coverage:
    - `/tmp/lookup-v2-coverage-korean-famous.json`
    - `hot_entities=67/67`, `non_entity=40/40`, `curation_tasks=0`
  - Korean-famous shadow:
    - `/tmp/lookup-v2-shadow-korean-famous.json`
    - `rows=107`, `V2 correct=107`, `wrong+=0`, gate **PASS**
- latency gate:
  - latest isolated rerun:
    - `/tmp/lookup-v2-latency-korean-famous.json`
  - `cold_boot measured_ms=18054.078` -> **FAIL**
  - `request first_query_ms=17.626`, `warm_p95_ms=110.016` -> **PASS**
  - `runtime_hydration fully_hydrated_runtime_artifact=true`, `lazy_build_detected_during_probe=false` -> **PASS**
- runtime / planner state:
  - direct lookup container boots from
    alias runtime + exact-safe + resolver projection + ambiguity + concept redirect
  - atomic span broad-recall is cut to `surface_only`
    whenever the parent lookup surface is multi-token
  - ambiguity runtime expands only normalization-stable views
    and excludes recall-style `lookupVariants`
  - ambiguity adapters normalize at the boundary, so snapshot/PG lookup
    keyspace is aligned on `normalizeForMatch`
  - write-plane hardening result:
  - `lookup-localized-surface-registry-v1` is reviewed localized recall SoT
  - `lookup-semantic-scope-target-registry-v1` is reviewed scope authority SoT
  - `lookup-family-support-registry-v1` is reviewed catalog-support SoT
  - `lookup-family-collision-registry-v1` is reviewed collision SoT
  - runtime owner evidence / benchmark hints stay display-only and do not promote authority
- publish state:
  - latest artifact-only runtime cutover is active on
    `search-snapshot:v1:ca6596580fb755ef`
  - full `etl:publish-search-snapshot` readiness proof는 이 operator-plane wave에서 재실행하지 않았다
- stretch truth:
  - strict fixture truth is active.
    impossible `resolved` rows were reclassified from live operator buckets:
    `strict_collision_ambiguous -> ambiguous`, `catalog_support_needed -> failed`
  - entity-no-policy shadow:
    - `/tmp/lookup-v2-shadow-korean-realworld-stretch-entity-no-policy.json`
    - `rows=590`, `V2 correct=303`, `wrong+=0`, gate **PASS**
  - entity-no-policy coverage:
    - `/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json`
    - `hot_entities=76/239`, `non_entity=227/351`, `curation_tasks=163`
    - operator buckets:
      `strict_collision_ambiguous=0`, `catalog_support_needed=0`,
      `localized_surface_gap=163`, `scope_target_missing=0`
  - current entity-no-policy draft:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl`
    - `rows=150`, `auto_targetable=7`, `scope_policy_review=1`,
      `localized_surface_review=20`, `catalog_support_review=0`,
      `reviewed_collision=101`, `scope_target_review=0`
  - current write-plane summary:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-write-plane-summary.json`
    - `exact_safe_packet_rows=7`, `reviewed_authority_approved_rows=7`, `reviewed_authority_pending_rows=0`
    - `exact_safe_family_review_rows=7`, `exact_safe_family_pending_rows=0`
    - `catalog_support_family_clusters: rows=0, families=0`
    - `reviewed_collision_family_clusters: rows=101, families=16`
    - `manual_target_family_review_rows=0`
    - `reviewed_collision_family_review_rows=87`
    - `manual_target suggestions: unique=0, collision=0, missing=0`
    - `manual_target owner-evidence families: total=0, collision=0, missing=0`
  - reviewed localized surface registry:
    - `data/lookup-v2/lookup-localized-surface-registry-v1.jsonl`
    - active reviewed localized recall surfaces:
      `silver oak`, `masseto`, `pichon lalande`
  - current exact-safe packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl`
    - `rows=7`
    - reviewed-authority source:
      `semantic_scope_target_registry=7`
  - current policy review packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl`
    - `rows=1`
  - current reviewed family-support registry:
    - `data/lookup-v2/lookup-family-support-registry-v1.jsonl`
    - active-catalog-absent families:
      `armand de brignac`, `henri jayer`, `hill of grace`, `ruinart`, `salon`, `taittinger`, `veuve clicquot`
  - current reviewed family-collision registry:
    - `data/lookup-v2/lookup-family-collision-registry-v1.jsonl`
    - active entity-collision families:
      `angelus`, `beaucastel`, `beychevelle`, `caymus`, `cos destournel`, `dominus`,
      `lynch bages`, `masseto`, `monfortino`, `montrose`, `palmer`, `pichon baron`,
      `pichon lalande`, `pontet canet`, `rayas`, `screaming eagle`, `silver oak`, `talbot`
    - topology outputs:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters.jsonl`
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters-by-topology/topology-index.json`
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters-by-governance/governance-index.json`
    - governance split:
      - `family_recall_collision=8`
      - `reviewed_family_core_collision=4`
      - `native_family_core_collision=2`
      - `producer_surface_secondary_line_collision=3`
      - `producer_surface_region_line_collision=1`
    - reviewed collision family-target lane:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl`
      -> `rows=98`, pending `98`
  - operator truth:
    - remaining long-tail debt is now almost entirely `localized_surface_gap`
    - reviewed collisions and catalog-support absences no longer sit inside active `resolved` coverage debt

아래 section은 archived historical context다. current 판단은 이 update block만 기준으로 한다.

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
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:refresh-write-plane`
      - entity-no-policy coverage artifact에서 stretch write-plane 전체를 canonical하게 재생성한다
      - output은 draft / exact-safe packet / reviewed-authority approved packet / policy family packet / manual-target family packet / summary까지 한 번에 갱신한다
      - reviewed authority source는 `family_target_registry`, `policy_family_decision_registry`, `fixture_exact`만 허용한다
      - `runtime_identity_safe_alias`, `runtime_unique_surface_owner`, `hint_resolution`은 display-only evidence다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:verify-reviewed-registry-overlay [-- --familyReview <reviewed.jsonl> --policyFamilyReview <reviewed.jsonl>]`
      - reviewed family packets를 registry append한 뒤 next refresh가 triage를 단조 개선하는지 증명한다
      - baseline/overlay 두 refresh를 다 생성하고 invariant를 강제한다:
         `auto_targetable` non-decreasing,
         `catalog_absent` non-decreasing,
         `policy_review` non-increasing,
         `manual_target` non-increasing
      - raw reviewed packet이 아니라 merged reviewed registries를 authority로 사용한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:verify-family-support-overlay`
      - reviewed family-support registry만 baseline에서 비운 뒤 overlay를 다시 돌려
        `catalog_absent` uplift와 `manual_target` drain delta를 canonical하게 증명한다
    - low-level owner-local debug lanes:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-draft`
      - entity-no-policy coverage artifact를 exact-safe curation draft JSONL로 투영한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-exact-safe-packet`
      - `auto_targetable` draft row만 exact-safe reviewed proposal packet으로 분리한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:export-exact-safe-family-review-packet`
      - exact-safe row packet을 deterministic review-scope packet으로 압축한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-exact-safe-family-review-packet`
      - review-scope exact-safe packet에 decision overlay를 merge한다
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-exact-safe-family-review-packet`
      - review-scope reviewed decision을 row-level exact-safe packet으로 deterministic projection한다
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
- `pnpm run eval:lookup-v2:stretch:report`
  - current stretch corpus volume / status mix / class mix / qid prefix distribution report
- `pnpm run eval:lookup-v2:stretch:build-expansion-prompt`
  - external-LLM append용 prompt를 current corpus 기준으로 regenerate한다
  - output:
    `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-expansion-prompt.txt`
- `pnpm run eval:lookup-v2:stretch:merge-candidate -- --candidate <jsonl> [--output <jsonl> | --write] [--qidPrefix kry]`
  - qid-less candidate rows를 deterministic append qid로 merge한다
  - duplicate query / invalid schema / invalid status contract는 fail-closed
  - corpus ops guide:
    `docs/bench/lookup-v2-korean-realworld-stretch-corpus-ops.md`
- `pnpm run eval:lookup-v2:latency:korean-famous [-- --output /tmp/lookup-v2-latency-korean-famous.json]`
  - post-cutover lookup latency / SLO gate
  - dedicated `lookup_direct_container` bootstrap만 잰다; generic search/server monolith bootstrap은 이 lane의 범위가 아니다
  - authority/coverage 같은 heavy live rails와 병렬 실행하면 bootstrap / p95가 쉽게 오염된다; canonical latency truth는 isolated run만 인정한다
  - artifact는 `slo.cold_boot`, `slo.request`, `slo.runtime_hydration`을 분리 출력한다; 운영 판단도 cold-start와 steady-state request를 분리해서 해야 한다
  - current owner-stage artifact는 `planner_total`, `retrieval_total`,
    `candidate_generation`, `blocker`, `resolver`, `ambiguity_lookup`를 함께 출력한다
  - current active truth는
    `/tmp/lookup-v2-latency-korean-famous.json`
    기준 `cold_boot measured_ms=1179.602`,
    `request first_query_ms=15.648`, `warm_p95_ms=17.736`로 **PASS**다
- `pnpm run eval:lookup-v2:canary:build -- --input <traffic.ndjson> --output <corpus.jsonl> --query-field <dotted.path> [route/method filters]`
  - explicit real-traffic canary corpus extractor
  - heuristic field guessing 없이 dotted-path 계약으로만 replay corpus를 만든다
  - current sample proof는 `/tmp/lookup-v2-canary-built-sample.jsonl` 이다
- `pnpm run eval:lookup-v2:canary:replay -- --input <jsonl> --baselineUseActiveRuntime --candidateUseActiveRuntime --output /tmp/lookup-v2-canary-replay.json`
  - lookup runtime self-replay / baseline-vs-candidate drift gate
  - explicit runtime binding이 필수다; real traffic mirror raw logs는 외부에서 공급하고, replay corpus는 `canary:build` lane으로 만든다
  - current self-replay truth는 `/tmp/lookup-v2-canary-replay-active-2026-06-05-post-bootstrap-fix.json`
    기준 `hard_drift=0`, `soft_abstain_drift=0`, labeled `75/75`로 **PASS**다

## Archived Historical Notes

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
    - entity-no-policy canonical refresh summary:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-write-plane-summary.json`
      -> `draft rows=268`, `auto_targetable=29`, `policy_review=0`, `manual_target=239`
      -> reviewed registries를 반영하면 `policy_review` lane은 drain된다
      -> runtime hint는 evidence-only이므로 `manual_target` 잔량이 그대로 남는다
    - entity-no-policy reviewed registry overlay summary:
      `data/lookup-v2/drafts/lookup-v2-stretch-reviewed-registry-overlay-summary.json`
      -> current registries are already applied:
         `draftAutoTargetable=0`, `draftPolicyReview=0`, `draftManualTarget=0`
      -> invariant proof stays green:
         `auto_targetable` non-decreasing,
         `policy_review` non-increasing,
         `manual_target` non-increasing
    - entity-no-policy curation draft:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl`
      -> `rows=268`, `triageBucket auto_targetable=29`, `policy_review=0`, `manual_target=239`
      -> reviewed authority source만 `auto_targetable`로 승격된다:
         `fixture_exact`, `family_target_registry`, `policy_family_decision_registry`
      -> `hint_resolution`, `runtime_identity_safe_alias`, `runtime_unique_surface_owner`는 authority source가 아니다
    - entity-no-policy exact-safe packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl`
      -> `rows=1`
      -> source split:
         `family_target_registry=1`
      -> current surviving reviewed-authority exact-safe candidate:
         `페트뤼스`
    - entity-no-policy reviewed-authority approved exact-safe packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-authority-exact-safe-proposals-approved.jsonl`
      -> `approved_rows=1`, `pending_rows=0`
      -> registry-first reviewed authority source만 auto-approve된다
    - entity-no-policy exact-safe family-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl`
      -> `input_rows=1`, `family_rows=1`
    - entity-no-policy policy-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl`
      -> `rows=0`
      -> reviewed policy-family decision registry가 current lane을 이미 drain했다
    - entity-no-policy policy-family-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl`
      -> `family_rows=0`
    - entity-no-policy manual-target batches:
      `data/lookup-v2/drafts/manual-target-batches/index.json`
      -> `totalRows=239`, `batchCount=10`
    - entity-no-policy manual-target family-review packet:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl`
      -> `input_rows=239`, `family_rows=36`
      -> packet은 runtime evidence를 싣지만 authority로 승격하지 않는다:
         `runtimeEvidenceStatus`, `runtimeEvidenceEntityId/Label`,
         `runtimeCollisionEntityIds/Labels`
    - entity-no-policy manual-target family suggestions:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl`
      -> `candidate_unique_owner=4`, `collision_candidates=9`, `missing_runtime_owner=23`
      -> current deterministic auto-assign candidate 없음
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
      `auto_targetable 29` lifts to a reviewed exact-safe proposal packet,
      then compresses to `exact_safe_family_review 1` for operator decision,
      then projects back into the row packet through a deterministic family-apply seam,
      `policy_review 0` is already drained by reviewed `lookup-policy-family-decision-registry-v1`,
      and `manual_target 239` now lifts to `manual_target_family_review 36`,
      which can deterministically project into an exact-safe proposal packet,
      before falling through the same exact-safe family-review/apply seam
    - total operator fan-out on the stretch write plane is now reduced from
      `268 row decisions` (`29 + 0 + 239`) to
      `37 family decisions` (`1 + 0 + 36`)
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
