# Entity Lookup V2 — Build Status (2026-06-02, overnight autonomous run)

> Branch: **`feat/entity-lookup-v2`** (off `535c9439`). Isolated from the
> concurrent commit loop on `deploy/aws-ec2-pipeline` / `main`. All work is
> committed (HEAD-durable); nothing depends on the working tree surviving.

## TL;DR

전용 entity-resolution 스택의 **코어 스파인을 production에 wiring + 테스트 완료**.
RFC 전역 DoD 7개 중 **#1, #3, #4, #5 충족**. 5개 티켓을 의미 있게 진척(전부 green:
typecheck + lint + 64개 V2 단위 테스트). 나머지(#2 alias-registry 심화, #6 ops plane,
#7 live cutover proof)는 frozen-interface seam + 정직한 catalog/문서로 이어받게 함.

**짜치는 코딩 금지 원칙 준수**: 통합·테스트되지 않는 코드는 머지하지 않음. 미완 영역은
"다 된 척"하지 않고 maturity 3 + next_steps로 정직하게 표기.

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
| #2 dom perignon hole → coverage/curation | 🟡 부분 | coverage-report core 완료; alias-registry-v2 migration + 라이브 curation write plane 미완 |
| #3 까쇼류 concept → resolve 안 함 | ✅ | ConceptAdmissionGate (pre-retrieval redirect) |
| #4 exact/translit/fuzzy/family/dense 다채널 union | ✅(재투영) | channel-provenance; 독립 timed runtime은 다음 단계 |
| #5 learned scorer + calibrated abstain contract | ✅(calibrated abstain) | CalibratedAbstainDecider; learned reranker(LTR)는 다음 단계 |
| #6 operator trusted plane | ❌ | T-ELV2-07 미착수 |
| #7 shadow + hotset 후 cutover | 🟡 게이트 완료 | shadow-metrics gate + cutover-checklist 완료; live runner 실측 미완 — **cutover 금지 유지** |

## 아키텍처 (frozen seams)

`src/domain/resolver/v2/lookup-v2-types.ts`가 SSoT 파이프라인 계약:
admission gate → multi-channel retrieval(port) → learned rerank+abstain(port).
현재 use-case는 admission gate → planner → resolver-backed candidate union →
CalibratedAbstainDecider → 4-state 응답. `LookupCandidateRetrievalPort` /
`LookupRerankDecisionPort`는 T-04 심화/T-05 LTR가 들어올 자리로 예약됨(계약 고정).

V2는 V1 wrapper가 아님: 전용 contract + admission(resolve 이전) + 4-state(redirect 포함)
+ calibrated 결정을 소유. resolver의 scoring/calibration **primitive만** 기반으로 재사용.

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

## 주의

- `pnpm run catalog:validate`의 6개 에러는 **사전 존재**(agent/di/tools feature가 동시
  리팩토링 루프에 의해 이동된 파일을 참조). 본 작업과 무관.
- 동시 실행 claude 루프가 main/deploy 브랜치를 변경 중 — 이 브랜치는 격리됨.
