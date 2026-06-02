# Entity Lookup V2 — Build Status (2026-06-02, overnight autonomous run)

> Branch: **`feat/entity-lookup-v2`** (off `535c9439`). Isolated from the
> concurrent commit loop on `deploy/aws-ec2-pipeline` / `main`. All work is
> committed (HEAD-durable); nothing depends on the working tree surviving.
>
> Historical build log. Current cutover truth lives in
> `cutover-checklist.md` and `IMPROVEMENT-PLAN-2026-06-03.md`.

## TL;DR

전용 entity-resolution 스택의 **코어 스파인을 production에 wiring + 테스트 완료**.
RFC 전역 DoD 7개 중 **#1, #3, #4, #5 충족**. 5개 티켓을 의미 있게 진척(전부 green:
typecheck + lint + 64개 V2 단위 테스트). 나머지(#2 alias-registry 심화, #6 ops plane,
#7 live cutover proof)는 frozen-interface seam + 정직한 catalog/문서로 이어받게 함.

**짜치는 코딩 금지 원칙 준수**: 통합·테스트되지 않는 코드는 머지하지 않음. 미완 영역은
"다 된 척"하지 않고 maturity 3 + next_steps로 정직하게 표기.

## Current Truth (2026-06-03)

- Full authority eval (`run-entity-resolution-validation.ts`, 215 rows,
  fingerprint `bd8abea5871dcede17272c3cc0bd1dcebcf93ea658d2d4b2ab930e5ba4f26cae`)
  result: `V1 46.5%, wrong=0, miss=115` vs `V2 100.0%, wrong=0, miss=0`.
- Cutover verdict is now **PASS**.
- 15-row hotset smoke still passes (`V2 wrong+=0`), but it is **not** the
  cutover authority.
- Public `/v1/lookup/wine`, local CLI `lookupWine`, and agent `lookup_wine`
  are now compatibility-backed V2 authority surfaces.
- Public `/v1/lookup/wine` and local CLI `lookupWine` no longer carry a
  generic `SearchUseCase` fallback; a regression rail locks that authority
  seam and requires explicit `legacy_core` opt-in for compare lanes.
- Bench/doc SSOT for executable lanes moved to `docs/bench/STATUS.md`.
- Older `V1 93.5%` comparison numbers are historical only; the current explicit
  `legacy_core` rerun is `V1 46.5%`.

## 커밋 (feat/entity-lookup-v2)

| commit | 티켓 | 내용 |
|---|---|---|
| `250f4e38` | docs | RFC + 8-ticket board |
| `91e9af7d` | T-01 | `/v2/entity-lookup` 전용 contract + use-case spine + DI + catalog v7.1.0 + 17 tests |
| `5fa2abb5` | T-02 | ConceptAdmissionGate + concept-lexicon (SSoT 재사용) — 까쇼→redirect (DoD #3) |
| `ccfbffe3` | T-05 | CalibratedAbstainDecider (downgrade-only + calibration-trust gate) — opu one→failed (DoD #1/#5) |
| `1c48cf7c` | T-04 | channel-provenance — anchor strategies→7 채널 + coverage rail (DoD #4) |
| `715b4875` | T-08 | shadow-compare gate core + hotset corpus + cutover-checklist + feature-catalog YAML |
| (this) | T-03 | hot-entity coverage report core — dom perignon holes→curation (DoD #2 부분) |

## DoD 매핑

| DoD | 상태 | 근거 |
|---|---|---|
| #1 opu one wrong-positive → ambiguous/failed | ✅ | CalibratedAbstainDecider (downgrade-only) |
| #2 dom perignon hole → coverage/curation | 🟡 부분 | coverage-report core(도메인 SSoT) + curation write plane(migration 030 staging: proposal→review→publish) 완료; dedicated alias-registry-v2 심층 schema + published proposal 소비 ETL은 미완 |
| #3 까쇼류 concept → resolve 안 함 | ✅ | ConceptAdmissionGate (pre-retrieval redirect) |
| #4 exact/translit/fuzzy/family/dense 다채널 union | ✅(재투영) | channel-provenance; 독립 timed runtime은 다음 단계 |
| #5 learned scorer + calibrated abstain contract | ✅(calibrated abstain) | CalibratedAbstainDecider; learned reranker(LTR)는 다음 단계 |
| #6 operator trusted plane | ✅ | read: `ops/inspect`(X-Debug-Key) decision spine. WRITE: `ops/{alias-audit,coverage-health,proposals[/submit\|/review\|/publish]}` — read=X-Debug-Key, write=**별도 X-Ops-Write-Key**; proposal 전이그래프 SSoT + optimistic guard + migration 030 staging 테이블. web `/ops/{inspect,curation,coverage}` 콘솔 |
| #7 shadow + hotset 후 cutover | 🟡 rail 완료 | shadow-metrics gate + **live runner**(run-lookup-v2-shadow-compare.ts) + package/gate script 완료(infra-gated 실행); 실측 canary 미완 — **cutover 금지 유지** |

## 아키텍처 (frozen seams)

`src/domain/resolver/v2/lookup-v2-types.ts`가 SSoT 파이프라인 계약:
admission gate → multi-channel retrieval(port) → learned rerank+abstain(port).
현재 use-case는 admission gate → planner → resolver-backed candidate union →
CalibratedAbstainDecider → 4-state 응답. `LookupCandidateRetrievalPort` /
`LookupRerankDecisionPort`는 T-04 심화/T-05 LTR가 들어올 자리로 예약됨(계약 고정).

V2는 V1 wrapper가 아님: 전용 contract + admission(resolve 이전) + 4-state(redirect 포함)
+ calibrated 결정을 소유. resolver의 scoring/calibration **primitive만** 기반으로 재사용.

## 2026-06-02 후속 라운드 (review-driven)

전문 리뷰(rr/codex) 피드백을 코드로 반영:
- **admission front-door 수정 (P1)**: 이전엔 gate 전에 `queryPlanner.plan()`(alias-refresh 포함)을 돌려 concept 쿼리가 planner를 거쳤음. 이제 standalone `buildNormalizedQueryViews`로 gate를 **planner 이전**에 실행 — 비-admit 쿼리는 planner 미호출(회귀로 잠금: 까쇼 → queryPlanner.plan NOT called).
- **T-ELV2-07 ops plane 코드로 ship (P1)**: `/v2/entity-lookup/ops/inspect`(X-Debug-Key gated, diagnostic) + catalog v7.2.0 + server 등록 + integration test.
- **T-ELV2-08 live runner ship (P1)**: `run-lookup-v2-shadow-compare.ts`(V1+V2 실행→gate, 실패 시 exit≠0) + `eval:lookup-v2:shadow` / `lookup-v2:cutover-gate` scripts.
- **route-level HTTP rail (P2)**: `test/integration/http/routes/entity-lookup-v2.route.test.ts` — Fastify wiring/snake_case/400/403/diagnostic.
- **mode 제거 (P3)**: public schema에서 inert `mode` 제거; ops plane 전용.
- **T-ELV2-06 clarification**: 후보 클러스터 label-diff 기반 distinguishing feature + kind(deterministic, heuristic-approx 아님).

### 아직 남은 deep infra phase (정직)

리뷰 P2 중 아래는 **라이브 인프라 빌드**라 별도 phase 필요(이번 세션 미완, seam은 고정됨):
- **T-ELV2-04 real**: 독립 timed multi-channel retrieval runtime(`LookupCandidateRetrievalPort` 구현). 현재는 anchor recall 재투영 + `latencyMs:0`. 필요: `AliasRepository`(현재 container 미노출, live는 `adapters.aliasMatcher`) 또는 Vespa 채널을 V2에 노출 → per-channel 실측 score/latency.
- **T-ELV2-05 real**: learned reranker(LTR) — `LookupRerankDecisionPort` + feature pipeline + 모델. 현재는 calibrated-abstain만.
- **T-ELV2-03 deepen**: curation WRITE plane은 완료(migration 030: `alias_proposals` lifecycle 확장 + `ambiguity_proposals`/`suppression_proposals` staging; proposal→review→publish; X-Ops-Write-Key). 남은 것은 **dedicated alias-registry-v2 심층 schema**와 `published` proposal을 runtime으로 반영하는 **ETL publish 소비 경로**.
- **T-ELV2-06 deepen**: ✅ persisted **family graph** 빌드 완료 — migration 031 `entity_family` + `PgFamilyGraph` + 엔진 `family_graph` 채널(reserved sibling budget) + REAL-producer-only builder/publisher(`pnpm run etl:family-graph:publish`, 휴리스틱 0) + `familyGraphProximity` real read-through. ambiguity cluster-membership feature도 un-hardcode(Half A). entity_family population만 operator 실행(live-PG, infra-gated). (커밋 3efd51dc·b0a2a7e3)
  
  추가 보완(2026-06-02): T-05 LTR 구조적 언게이팅(flag OFF, OOD 차단), T-04 honest provenance, T-08 non-degeneracy gate + vintage-mismatch 가드, T-03 alias-registry-v2 version-identity stamp(meta.alias_registry). 자세히는 feature-catalog YAML known_limitations 참조.

## 남은 작업 (이어받기)

1. **T-04 심화**: `LookupCandidateRetrievalPort` 구현 — 독립 timed 채널 retriever
   (per-channel native score). 현재는 anchor recall 재투영.
2. **T-05 심화**: learned reranker(LTR) — `LookupRerankDecisionPort` + feature 추출
   (`LookupCandidateFeatures` 이미 정의됨). 현재는 calibrated-abstain만.
3. **T-03 심화**: dedicated alias registry v2 schema/migration (다음 migration 030) +
   staged curation write plane(proposal→review→publish, 기존 `alias_proposals` 확장).
4. **T-06**: family graph + ambiguity graph (기존 `canonical_ambiguity_registry` 재사용) →
   graph-backed clarification.
5. **T-07**: trusted operator read API (X-Debug-Key 게이트; `request-pipeline-debug` 패턴) +
   web ops console (`web/src/app/ops/...`) + curation write plane.
6. **T-08 live**: `scripts/eval/run-lookup-v2-shadow-compare.ts` — 컨테이너 로드 후 V1+V2를
   hotset corpus로 실행, `buildShadowReport`로 게이트 평가. infra 필요(PG/Vespa/임베딩).

## 검증 명령

```
pnpm run typecheck
pnpm run test:file -- test/unit/entity-lookup-v2/      # 64 tests
pnpm run test:file -- test/regression/http-contract-catalog-properties.regression.test.ts
pnpm run catalog:validate   # retrieval.entity-lookup-v2 통과 (기타 6건은 사전 존재 에러)
```

## 적대적 감사 (4 라운드, 수렴)

병렬 multi-dim adversarial audit workflow를 4회 돌려 매 라운드 verified findings를 수정·회귀잠금:

| 라운드 | confirmed | 적용 커밋 | 핵심 |
|---|---|---|---|
| R1 `w06v3pg9i` | 103 | 59351652 | untrusted raw-score wrong-resolve → exact-evidence 게이트 외 |
| R2 `w9x8ofhm8` | 27 | f4360ddd | exact-identity substring-map 위조 → strict allowlist; 교착어 한국어 회귀 → soft boundary |
| R3 `w8a4z0uhl` | 22 | 12bd38ce | planner fuzzy-fallback 'exact' 위조 → fuzzy-marker 제외; SSoT 카베르네; josa/숫자 |
| R4 `wwrvk4yz3` | 7 (**0 HIGH**) | fcab3f0b | 추천해줘 strip 순서; bare-count residual |
| R5 `wqacyi00a` | 12 (**0 HIGH**) | (this) | empty-form wire-500 guard; mode/clarification 계약 정직성 |

**R4·R5 연속 HIGH 0건 → wrong-resolve bypass 수렴 확정.** 핵심 정밀도 경로(untrusted 시 exact-identity 위조)는 2겹(fuzzy-marker 제외 + strict 전략 allowlist)으로 차단됨. 5라운드 적대적 감사 종료.

### 미수정(문서화된 한계)

- **[MED] containment-exact** (`src/infrastructure/adapter/search-index-alias-matcher.ts`): 쿼리가 후보의 2-토큰 canonical을 sub-phrase로 *포함*하면 strategy `exact` 라벨 → untrusted 시 resolve 인증. 단 (a) 포함된 엔티티는 보통 intent-aligned(틀린 엔티티 아님), (b) margin gate 적용. **공유 infra matcher라 blast radius가 커 야간 변경 보류** — 후속에서 containment를 recall 라벨(`phrase_contained`)로 분리 권장.
- **[LOW] 어휘 커버리지**: 단일어 region/appellation 중 attribute vocab 미포함(예: 'Rhône' 단독)은 redirect 안 됨(admit→abstain, wrong-positive 아님). 어휘 확장(T-03 registry)에서 해소.
- **[LOW] fuzzy-marker over-rejection**: genuine exact가 같은 anchor에서 다른 recall 전략과 공존하면 untrusted 시 abstain(recall 손실). precision-first 의도적 선택(wrong-positive보다 abstain 우선).

## 주의

- `pnpm run catalog:validate`의 6개 에러는 **사전 존재**(agent/di/tools feature가 동시
  리팩토링 루프에 의해 이동된 파일을 참조). 본 작업과 무관.
- 동시 실행 claude 루프가 main/deploy 브랜치를 변경 중 — 이 브랜치는 격리됨.
