# Lookup V2 Korean Realworld Stretch Priority Backlog (2026-06-05)

## Current Truth Update (2026-06-07)

- active runtime snapshot:
  - `search-snapshot:v1:ca6596580fb755ef`
- main gate status on current code:
  - authority:
    - `/tmp/entity-resolution-validation.json`
    - `V2 215/215`, `wrong=0`, `miss=0`, gate **PASS**
  - hotset shadow:
    - `/tmp/lookup-v2-shadow-report.json`
    - `rows=45`, `V2 correct=41`, `wrong+=0`, gate **PASS**
  - Korean-famous coverage:
    - `/tmp/lookup-v2-coverage-korean-famous.json`
    - `hot_entities=67/67`, `non_entity=40/40`, `curation_tasks=0`
  - latency:
    - `/tmp/lookup-v2-latency-korean-famous.json`
    - `cold_boot=18054.078ms`, `first_query=17.626ms`, `warm_p95=110.016ms`
    - request / hydration **PASS**, cold boot **FAIL**
- runtime note:
  - ambiguity runtime은 normalization-stable view만 authority로 싣고
    recall-style `lookupVariants`는 제외한다
  - ambiguity adapters는 `normalizeForMatch` boundary lookup으로 정렬됐다
- strict fixture truth is active.
  impossible `resolved` rows were reclassified from live operator buckets:
  `strict_collision_ambiguous -> ambiguous`, `catalog_support_needed -> failed`
- owner split:
  - policy review lane:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl`
    - `rows=1`
  - entity-no-policy write-plane:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-write-plane-summary.json`
    - `draft rows=150`
    - `auto_targetable=7`
    - `scope_policy_review=1`
    - `localized_surface_review=20`
    - `catalog_support_review=0`
    - `reviewed_collision=101`
    - `scope_target_review=0`
    - `exact_safe_packet_rows=7`
    - `reviewed_authority_approved_rows=7`
    - `reviewed_authority_pending_rows=0`
    - `exact_safe_family_review_rows=7`
    - `exact_safe_family_pending_rows=0`
    - `catalog-support family clusters: rows=0, families=0`
    - `reviewed-collision family clusters: rows=101, families=16`
    - `manual_target_family_review_rows=0`
    - `reviewed_collision_family_review_rows=87`
    - `manual-target suggestions: unique=0, collision=0, missing=0`
    - `manual-target owner-evidence families: total=0, collision=0, missing=0`
- entity-no-policy shadow:
  - `/tmp/lookup-v2-shadow-korean-realworld-stretch-entity-no-policy.json`
  - `rows=590`, `V2 correct=303`, `wrong+=0`, gate **PASS**
- entity-no-policy coverage:
  - `/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json`
  - `hot_entities=76/239`, `non_entity=227/351`, `curation_tasks=163`
  - operator buckets:
    - `localized_surface_gap=163`
    - `strict_collision_ambiguous=0`
    - `catalog_support_needed=0`
    - `scope_target_missing=0`
- write-plane state:
  - reviewed localized surface registry is active:
    - `data/lookup-v2/lookup-localized-surface-registry-v1.jsonl`
    - current reviewed surfaces:
      `silver oak`, `masseto`, `pichon lalande`
  - reviewed policy family registry is active:
    - `data/lookup-v2/lookup-policy-family-decision-registry-v1.jsonl`
    - `라뚜르`, `라피트`, `무통`, `그랜지`, `베가 시실리아`, `자코모 콘테르노`
    - current decision은 전부 `keep_policy_conflict`
  - family target registry is active:
    - `data/lookup-v2/lookup-family-target-registry-v1.jsonl`
    - current approved target hints:
      - `calon segur`
      - `cheval blanc`
      - `cristal`
      - `monte bello`
      - `montelena`
      - `opus one`
      - `petrus`
      - `pol roger`
      - `solaia`
    - current rejected hints include:
      - `ausone`
      - `bollinger`
      - `pavie`
      - scope-level rejects on
        `calon segur::realworld_exact_vintage`,
        `monte bello::realworld_vintage_suffix`,
        `montelena::realworld_vintage_suffix`
  - `reviewed_rejected` is now first-class.
    false-singleton family scopes no longer stay inside blind `manual_target`
  - exact-safe auto-approve is still limited to reviewed authority sources:
    `fixture_exact`, `policy_family_decision_registry`
  - `family_target_registry`는 target SoT다. exact-safe 승격은 family review를 한 번 더 통과해야 한다
  - current exact-safe packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl`
    - `rows=7`
    - reviewed-authority source:
      `semantic_scope_target_registry=7`
  - explicit exact-safe family review decisions:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review.review-decisions.jsonl`
    - current `approved=0`, `rejected=14`, `pending=0`
    - reviewed exact-safe scope SoT:
      `data/lookup-v2/lookup-exact-safe-scope-registry-v1.jsonl`
    - current packet residue is fully reviewed; no exact-safe blind queue remains
  - current manual-target family packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl`
    - `input_rows=119`, `family_rows=98`
  - current manual-target owner-evidence family clusters:
    - `data/lookup-v2/drafts/manual-target-owner-evidence/family-index.json`
    - `collisionCandidateFamilies=18`
    - `missingRuntimeOwnerFamilies=0`
    - family-cluster outputs:
      `collision-candidate-families.jsonl`,
      `missing-runtime-owner-families.jsonl`
  - current family-support registry / catalog-absent cluster:
    - `data/lookup-v2/lookup-family-support-registry-v1.jsonl`
    - `armand de brignac`, `henri jayer`, `hill of grace`, `ruinart`, `salon`, `taittinger`, `veuve clicquot`
    - cluster output:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-catalog-absent-family-clusters.jsonl`
      -> `rows=51`, `families=7`
  - current family-collision registry / reviewed-collision cluster:
    - `data/lookup-v2/lookup-family-collision-registry-v1.jsonl`
    - `angelus`, `beaucastel`, `beychevelle`, `caymus`, `cos destournel`, `dominus`,
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
    - highest-impact families by scope rows:
      `silver oak=14`, `caymus=13`, `masseto=11`, `angelus=8`, `cos destournel=8`,
      `lynch bages=8`, `pichon baron=8`, `pontet canet=8`
    - current family membership:
      - `family_recall_collision`:
        `angelus`, `beychevelle`, `caymus`, `montrose`, `palmer`, `pichon baron`, `rayas`, `talbot`
      - `reviewed_family_core_collision`:
        `beaucastel`, `cos destournel`, `monfortino`, `pichon lalande`
      - `native_family_core_collision`:
        `lynch bages`, `pontet canet`
      - `producer_surface_secondary_line_collision`:
        `dominus`, `masseto`, `silver oak`
      - `producer_surface_region_line_collision`:
        `screaming eagle`
  - reviewed family-core witness overlay:
    - `data/lookup-v2/lookup-family-core-witness-registry-v1.jsonl`
    - evidence-only owner split uplift:
      `beaucastel`, `cos destournel`, `monfortino`, `solaia`, `pichon lalande`
  - current overlay verifier:
    - `data/lookup-v2/drafts/lookup-v2-stretch-reviewed-registry-overlay-summary.json`
    - collision-registry overlay proof:
      `reviewed_collision 0 -> 119`
      `manual_target 119 -> 0`
      `manual_target_family_review_rows 98 -> 0`
      `reviewed_collision_family_review_rows 0 -> 98`
    - invariants green

아래 section은 archived historical RCA다. current owner 판단은 이 update block만 기준으로 본다.

## Archived Historical Notes

- source artifacts:
  - `/tmp/lookup-v2-shadow-korean-realworld-stretch-post-support-fix.json`
  - `/tmp/lookup-v2-coverage-korean-realworld-stretch-post-support-fix.json`
  - `/tmp/lookup-v2-shadow-korean-realworld-stretch-entity-only.json`
  - `/tmp/lookup-v2-shadow-korean-realworld-stretch-entity-no-policy-post-support-fix.json`
  - `/tmp/lookup-v2-shadow-korean-realworld-stretch-policy-conflict-post-support-fix.json`
  - `/tmp/lookup-v2-shadow-korean-realworld-stretch-discovery-only.json`
  - `/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy-post-support-fix.json`
- corpus:
  - `test/fixtures/lookup-v2-korean-realworld-stretch.jsonl`
- this packet is **entity-lookup only**
  - recommendation / pairing / style / price-band discovery phrases are excluded from the fix lane

## Historical Stretch Truth

- full stretch shadow:
  - `rows=746`
  - `V2 correct=213`
  - `wrong+=6`
  - `concept_redirect_acc=0.100`
  - gate `FAIL`
- full stretch coverage:
  - `hot_entities=42/310`
  - `non_entity=171/436`
  - `curation_tasks=268`
- entity-only shadow:
  - `rows=596`
  - `V2 correct=198`
  - `wrong+=6`
  - gate `FAIL`
- entity-no-policy shadow:
  - `rows=590`
  - `V2 correct=198`
  - `wrong+=0`
  - gate `PASS`
- entity-no-policy coverage:
  - `hot_entities=42/310`
  - `non_entity=156/280`
  - `curation_tasks=268`

## Historical Owner Split

- exact-safe registry owner:
  - `entity-no-policy` 기준 실제 owner
  - `278` stretch shadow mismatches (pre-partition)
  - `entity-no-policy` hot-entity coverage holes `268`
  - dominant classes:
    - `realworld_exact_vintage` `50`
    - `realworld_brand_suffix` `35`
    - `realworld_mixed_script_alias` `35`
    - `realworld_korean_orthography` `34`
    - `realworld_compact_alias` `34`
    - `realworld_vintage_suffix` `29`
    - `realworld_producer_prefixed` `28`
    - `realworld_spaced_alias` `20`

- ambiguity registry owner:
  - `policy-conflict-only` 기준 실제 owner
  - `6` current wrong-positives
  - dominant classes:
    - `realworld_short_form_collision`
    - `realworld_broad_icon_collision`
    - `realworld_family_collision`

- not entity-lookup owner:
  - `discovery-only` shadow `rows=150`, `concept_redirect_acc=0.100`
  - this packet excludes recommendation / pairing / style / generic discovery routing

## Policy Conflict Registry

- reviewed SSOT:
  - `data/lookup-v2/lookup-policy-conflict-registry-v1.jsonl`
- purpose:
  - full stretch red에서 policy-conflict bucket을 hardcoded query set이 아니라
    reviewed registry로 분리한다
  - `entity-no-policy` lane은 이 registry를 뺀 실제 entity alias backlog만 본다

## Priority Lane

## Applied In This Packet

### Exact-safe promotions applied

1. `라피트로쉴드`
2. `무똥로쉴드`
3. `오브리앙`
4. `샤또 오브리옹`
5. `도멘드라로마네콩티`
6. `코슈뒤리`
7. `크루그 그랑뀌베`
8. `크루그 그랑큐베`
9. `사시까야`
10. `할란에스테이트`
11. `조셉 펠프스 인시그니아`

### Ambiguity hardening applied

1. `살롱`
2. `모엣 샹동`
3. `페트루스`

### Reverted from exact-safe after regression

1. `페트뤼스`

- reason:
  - caused green hotset / Korean-famous non-entity regression via `페트루스`
    over-resolution

### Structural fix applied after partition RCA

1. multi-token fragment-only anchor pruning 강화

- owner seam:
  - `src/application/search/entity-lookup-v2/runtime-lookup-planner.ts`
- effect:
  - `entity-no-policy` lane에서 남아 있던
    `realworld_fake_chateau_label` regression 제거
  - `샤또 라 투르 도르 2019 -> ambiguous` residue가 사라지고
    `failed`로 fail-closed 복귀

2. core support-plane policy-conflict bit 승격

- owner seam:
  - `test/support/core-korean-icon-fixtures.ts`
  - `test/regression/core-korean-iconic-alias-runtime.regression.test.ts`
  - `scripts/etl/build-search-snapshot.ts`
- effect:
  - `CORE_KOREAN_ICON_QUERY_CASES`가 `identitySafe=false`를 직접 가진다
  - `베가 시실리아`, `자코모 콘테르노`는 더 이상 exact-positive rail과
    ambiguity rail에서 동시에 singleton-positive처럼 취급되지 않는다
  - support bundle identity projection / alias-runtime regression / ETL
    identity-safe compile이 같은 contract를 본다

## Remaining Priority Lane

### P0 ambiguity containment

1. `라뚜르`
2. `그랜지`
3. `베가 시실리아`
4. `자코모 콘테르노`
5. `라피트`
6. `무통`

- reason:
  - these currently wrong-resolve
  - first fix should be fail-closed ambiguity, not more exact promotion

### P0 exact-safe additions

1. `도미누스`
2. `크리스탈 샴페인`
3. `케이머스 카베르네 2019`
4. `펜폴즈 그랜지 2017`
5. `페트뤼스`

- reason:
  - `도미누스`는 current snapshot에 복수 Dominus label이 있어 bare producer exact-safe가 아님
  - `크리스탈 샴페인`, `케이머스 카베르네 2019`, `펜폴즈 그랜지 2017`는
    category/vintage suffix exact-safe 규칙이 아직 필요
  - `페트뤼스`는 green hotset regression 없이 exact-safe로 올릴 수 있는
    narrower certificate 설계가 먼저 필요

## Draft Files

- exact-safe draft:
  - `data/lookup-v2/drafts/exact-safe-priority-candidates-2026-06-05.jsonl`
- ambiguity draft:
  - `data/lookup-v2/drafts/ambiguity-priority-candidates-2026-06-05.jsonl`
- entity-no-policy curation draft:
  - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl`
  - canonical refresh owner:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:refresh-write-plane`
  - current registry-first contract:
    - reviewed authority source만 `auto_targetable`에 반영된다
    - `runtime_identity_safe_alias`, `runtime_unique_surface_owner`, `hint_resolution`는 evidence-only다
  - triage buckets:
    - `auto_targetable=27`
    - `policy_review=0`
    - `manual_target=222`
  - family-review compression:
    - `exact_safe_family_review=7`
    - `policy_family_review=0`
    - `manual_target_family_review=33`
    - total operator fan-out reduced from `249` row-level decisions to `40` review units
  - operator queue still stays `needs_target`; the carried gold fields are non-authoritative triage evidence only
- exact-safe reviewed proposal packet:
  - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-auto-targetable-exact-safe-proposals.jsonl`
  - generated only from `triageBucket=auto_targetable`
  - current packet truth:
    - `rows=7`
    - current registry exact collision `0`
    - current registry conflicting owner `0`
    - source split:
      - `family_target_registry=7`
  - packet is review-plane only:
    - reviewed-authority append candidate:
      - `reviewed authority approved rows=0`
      - `pending rows=7`
    - `reviewTarget=lookup_exact_safe_registry_v1`
    - no runtime-plane write / no registry auto-append
  - family review compression:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-review-packet.jsonl`
    - `input_rows=7`
    - `family_rows=7`
    - grouping key:
      - `reviewScopeKey = entityId::suggestedAliasType::holeClass`
  - deterministic suggestion packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family-suggestions.jsonl`
    - `suggest_approve=0`
    - `manual_review=7`
    - `family_target_registry`, `policy_family_decision_registry`, `fixture_exact`만
      exact-safe reviewed-authority auto-approve source다
    - current decision scaffold:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-exact-safe-family.suggested-decisions.jsonl`
      - `rows=0`
  - family review/apply lane:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-exact-safe-family-review-packet`
      - decision row contract:
        - `reviewScopeKey`
        - `decision=approve|reject`
        - `reviewedBy`
        - `decisionReason`
        - `reviewedAt`
      - current reviewed truth:
        - `packet_rows=7`
        - `decision_rows=7`
        - `approved=0`
        - `rejected=7`
        - `pending=0`
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-exact-safe-family-review-packet`
      - review-scope reviewed decision을 row-level exact-safe packet으로 deterministic projection
      - current reviewed truth:
        - `family_rows=7`
        - `row_packet_rows=7`
        - `approved_rows=0`
        - `rejected_rows=7`
        - `pending_rows=0`
  - review overlay lane:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-exact-safe-packet`
    - decision row contract:
      - `surface`
      - `entityId`
      - `decision=approve|reject`
      - `reviewedBy`
      - `decisionReason`
      - `reviewedAt`
    - fail-closed:
      - duplicate decision rows -> fail
      - unknown packet row -> fail
      - re-review terminal row -> fail
    - current dry-run truth:
      - `packet_rows=7`
      - `decision_rows=7`
      - `approved=0`
      - `rejected=7`
      - `pending=0`
  - apply lane:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-exact-safe-packet`
    - contract:
      - family-apply 또는 row-level review 결과에서 `proposalStatus=approved` rows만 적용
      - `reviewedAt`, `reviewedBy`, `decisionReason` are mandatory for approved rows
      - current registry owner conflict -> fail-closed
      - same-owner normalized duplicate -> skip
    - current dry-run truth:
      - `approved_rows=0`
      - `inserted_rows=0`
      - `skipped_existing_rows=0`
  - effect of reviewed-registry split:
    - `policy_review` lane는 current reviewed policy-family decision registry에서 drain된다
    - runtime hint/evidence는 exact-safe packet으로 직접 승격되지 않는다
- manual-target operator queue:
  - `data/lookup-v2/drafts/manual-target-batches/index.json`
  - current batch truth:
    - `totalRows=239`
    - `batchCount=10`
  - top queues:
    - `realworld_exact_vintage=41`
    - `realworld_brand_suffix=30`
    - `realworld_compact_alias=30`
    - `realworld_korean_orthography=30`
    - `realworld_mixed_script_alias=31`
    - `realworld_producer_prefixed=27`
    - `realworld_vintage_suffix=29`
    - `realworld_spaced_alias=19`
  - purpose:
    - blind 222-row queue를 class-batched operator work packets으로 분해
    - next target-resolution packet은 이 batch index와 family packet을 source로 잡는다
  - family review compression:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl`
    - `input_rows=239`
    - `family_rows=36`
    - operator decision fan-out reduced from `239` row-level decisions to `36` benchmark-hint decisions
    - packet carries runtime owner evidence directly:
      - `runtimeEvidenceStatus`
      - `runtimeEvidenceEntityId` / `runtimeEvidenceEntityLabel`
      - `runtimeCollisionEntityIds` / `runtimeCollisionEntityLabels`
    - current largest families:
      - `calon segur=14`
      - `silver oak=14`
      - `caymus=13`
      - `masseto=11`
      - `salon=11`
      - `veuve clicquot=11`
      - `armand de brignac=11`
  - deterministic suggestion packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-suggestions.jsonl`
    - `candidate_unique_owner=4`
    - `collision_candidates=9`
    - `missing_runtime_owner=23`
    - `runtime_unique_surface_owner`는 non-authoritative target hint
    - current unique-owner hints:
      - `ausone`
      - `montelena`
      - `pavie`
      - `petrus`
    - current decision scaffold:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family.suggested-decisions.jsonl`
      - `rows=0`
  - family review/apply lane:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-manual-target-family-review-packet`
      - decision row contract:
        - `benchmarkGoldHint`
        - `decision=assign_target|reject`
        - `entityId` required only for `assign_target`
        - `reviewedBy`
        - `decisionReason`
        - `reviewedAt`
      - current empty dry-run:
        - `packet_rows=36`
        - `decision_rows=0`
        - `target_assigned=0`
        - `rejected=0`
        - `pending=36`
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-manual-target-family-review-packet`
      - family-level reviewed target assignment을 exact-safe proposal packet으로 deterministic projection
      - current empty dry-run:
        - `family_rows=36`
        - `target_assigned_families=0`
        - `rejected_families=0`
        - `pending_families=36`
        - `exact_safe_packet_rows=0`
      - reviewed `lookup-family-target-registry-v1` append가 있어야만
        `benchmarkGoldEntityIdSource=family_target_registry`로 exact-safe review plane에 진입한다

- policy-review packet:
  - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-review-packet.jsonl`
  - generated only from `triageBucket=policy_review`
  - current packet truth:
    - `rows=0`
    - reviewed `lookup-policy-family-decision-registry-v1.jsonl`가 current lane을 drain한다
  - purpose:
    - exact-safe reviewed packet과 operator queue 사이에 authority policy decision plane을 분리
    - short-form / broad-icon family를 registry write backlog와 섞지 않음
  - family review compression:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-review-packet.jsonl`
    - `input_rows=0`
    - `family_rows=0`
    - current reviewed policy registry가 family lane도 drain한다
  - deterministic suggestion packet:
    - `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family-suggestions.jsonl`
    - `suggest_keep_policy_conflict=0`
    - `manual_review=0`
    - suggested decision scaffold:
      `data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-policy-family.suggested-decisions.jsonl`
      - `rows=0`
  - family review/apply lane:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-policy-family-review-packet`
      - decision row contract:
        - `policyConflictSurface`
        - `benchmarkGoldEntityId`
        - `decision=promote_exact_safe|keep_policy_conflict|needs_target`
        - `reviewedBy`
        - `decisionReason`
        - `reviewedAt`
      - current empty dry-run:
        - `packet_rows=0`
        - `decision_rows=0`
        - `approved_exact_safe=0`
        - `kept_policy_conflict=0`
        - `needs_target=0`
        - `pending=0`
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-policy-family-review-packet`
      - family-level reviewed decision을 row-level policy-review packet으로 deterministic projection
      - current empty dry-run:
        - `family_rows=0`
        - `row_packet_rows=0`
        - `approved_exact_safe_rows=0`
        - `kept_policy_conflict_rows=0`
        - `needs_target_rows=0`
        - `pending_rows=0`
  - review/apply lane:
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:review-policy-review-packet`
      - decision row contract:
        - `surface`
        - `benchmarkGoldHint`
        - `decision=promote_exact_safe|keep_policy_conflict|needs_target`
        - `reviewedBy`
        - `decisionReason`
        - `reviewedAt`
      - current empty dry-run:
        - `packet_rows=0`
        - `decision_rows=0`
        - `approved_exact_safe=0`
        - `kept_policy_conflict=0`
        - `needs_target=0`
        - `pending=0`
    - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-policy-review-packet`
      - family-apply 또는 row-level review 결과에서 `approved_exact_safe` row만 approved exact-safe packet으로 변환
      - current empty dry-run:
        - `approved_exact_safe_rows=0`
        - `kept_policy_conflict_rows=0`
        - `needs_target_rows=0`
        - `pending_rows=0`
        - `exact_safe_packet_rows=0`

## Not Included

- concept redirect rows:
  - pairing / gift / price-band / style / generic discovery phrases
- reason:
  - they are not entity-lookup fix owner
  - they belong to concept/discovery routing, not this packet
