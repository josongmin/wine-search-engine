# Final Implementation Gaps

> **⚠️ Superseded (2026-06 Entity Lookup V2 cutover).** ResolveUseCase / TA3
> corrective-retry / shared resolve entrypoint tasks below are historical. Live
> entity authority: `EntityLookupV2UseCase` + `POST /v2/entity-lookup`. See
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.

> 작성일: 2026-04-11  
> 상태: 실행 지시서 (historical)  
> 목적: 현재 코드 기준 **실제 남은 빵구만** 남기고, 중복구현 없이 exact wine retrieval 목표를 닫기 위한 최종 작업 기준을 고정한다.

---

## 문서 목적

이 문서는 `EPIC-1 ~ EPIC-8`, `TRACK-A` 문서를 다시 요약하는 문서가 아니다.

이 문서의 목적은 세 가지다.

1. 현재 코드 기준으로 **이미 닫힌 것**과 **진짜 남은 것**을 분리한다.
2. 남은 작업을 **중복구현 없이** 기존 SSOT 위에 얹는 방식으로 고정한다.
3. 에이전트가 맥락을 몰라도 바로 실행할 수 있게 `우선순위 / 파일 / 금지사항 / acceptance / 테스트`를 남긴다.

---

## 최종 판단

현재 기준으로 다시 건드리면 안 되는 영역이 분명히 있다.

- `E5-T2 ~ E5-T6`: 구현됨. `ScoreDriftRecord`는 타입만 있는 상태가 아니라 runtime/audit/response까지 연결돼 있다.
- `E6-T4 ~ E6-T5`: 구현됨. typed abstain / structured clarify는 response/schema까지 연결돼 있다.
- `E7-T1 ~ E7-T5`: 큰 줄기 구현됨. `evaluateBatchPolicy`, `ToolOutcome`, `synthesis_context`, observer/metrics까지 연결돼 있다.
- `E1-T6`: replay / determinism regression suite 존재한다.

따라서 여기서 다시 새 trace envelope, 새 audit object, 새 score drift substrate, 새 agent contract stack을 만들면 **100% 중복구현**이다.

반대로 지금도 남아 있는 핵심 빵구는 이쪽이다.

- `TA2-T5`: `search / resolve / hybrid` entrypoint 간 entity candidate generation contract가 아직 완전히 통일되지 않았다.
- `TA2-T2`: noisy / fuzzy entity evidence가 explicit한 exact-recovery substrate로 충분히 승격되지 않았다.
- `E1-T3`: rank tie-break는 개선됐지만 RFC가 의도한 최종 deterministic ordering 계약으로 완전히 봉인되진 않았다.
- `E1-T5`: determinism fingerprint는 runtime에 있으나 replay-grade drift gate로는 아직 입력 범위가 좁다.
- `E1-T4`: rerank 적용/차단/skip semantics가 typed decision 하나로 완전히 정규화되진 않았다.

정리하면:

- **정확도 코어**: `TA2-T5`, `TA2-T2`
- **결정론 코어**: `E1-T3`, `E1-T5`
- **랭킹 계약 마감**: `E1-T4`

---

## 구조 원칙

### 원칙 1. 새 substrate를 만들기 전에 기존 SSOT를 확장한다

현재 SSOT는 이미 존재한다.

- planner / exact entity surface: `AnchorCandidate`
- resolver candidate input: `EntityCandidateGeneratorInput`
- ranking / rerank output: existing ranker output + `ScoreDriftRecord`
- audit / response surface: existing `meta` + `AuditExtension`

새 public 타입을 추가해 병렬 truth를 만들지 말고, 이 구조를 증설해야 한다.

### 원칙 2. exact retrieval 문제를 migration 프로젝트로 키우지 않는다

`CompiledWineQuery` 중심으로 entity route 전체를 한 번에 이행하는 건 맞는 방향일 수 있다.
하지만 지금 목표는 `개같이 입력해도 특정 와인을 복구`하는 exact retrieval 성능을 닫는 것이다.

따라서 당장 해야 하는 건:

- `resolve.usecase`도 blocker seed를 먹게 만들기
- noisy evidence를 existing anchor / candidate substrate 위에 formalize하기

이지, entity route 전체를 새 planner/compiled execution model로 갈아엎는 게 아니다.

### 원칙 3. 새 문서 / 새 타입 / 새 trace는 "기존 구조로 못 담을 때만" 허용

특히 아래는 금지한다.

- 새 `audit envelope`
- 새 `planner graph`
- 새 `score substrate`
- 새 `agent contract stack`
- 기존 `AnchorCandidate`와 병렬인 public `EntityHypothesis` 도입

---

## 절대 하면 안 되는 중복작업

### 금지 1. `ScoreDriftRecord`를 다시 만들지 말 것

이미 runtime 계산, audit wiring, response projection이 존재한다.
추가 작업이 필요하면 기존 `ScoreDriftRecord` 소비 경로를 강화해야지, 새 drift 타입을 만들면 안 된다.

### 금지 2. `ToolOutcome` / batch policy를 다른 이름으로 다시 만들지 말 것

agent contract 쪽 SSOT는 이미 `evaluateBatchPolicy()`와 `ToolOutcome`이다.
여기에 병렬로 또 다른 batch validator / tool result layer를 만들면 이원화된다.

### 금지 3. `StructuredClarifyPayload`를 별도 response object로 분리하지 말 것

이미 search response schema / clarification surface에 wiring 되어 있다.
새 clarify envelope를 만들 이유가 없다.

### 금지 4. `AnchorCandidate`와 병렬 public entity hypothesis 타입을 만들지 말 것

noisy evidence를 formalize하려는 이유는 맞다.
하지만 기존 `AnchorCandidate`가 이미 surface / normalized / candidate ids / lookup strategies / confidence / source를 담고 있다.

따라서 1차 해법은:

- `AnchorCandidate` provenance를 강화
- generator / resolver / eval까지 provenance를 유지

여야 한다.

새 public hypothesis 타입은 정말 기존 계약으로 못 담을 때만 검토한다.

### 금지 5. entity route 전체를 한 번에 compiled-first로 갈아엎지 말 것

그건 별도 migration workstream이다.
지금 exact retrieval 빵구를 닫으려는 작업과 섞으면 scope가 폭발한다.

---

## 최종 우선순위

### P0-1. TA2-T5 entrypoint 통일

가장 먼저 할 일이다.

현재 상태:

- `search.usecase.ts` entity route는 blocker seed를 사용한다.
- `search-usecase-hybrid-ranking-pipeline.ts`도 blocker seed를 사용한다.
- `resolve.usecase.ts`는 아직 anchors-only에 가깝다.

즉, 같은 exact entity recovery contract가 entrypoint마다 갈라져 있다.

해야 할 일:

- `resolve.usecase.ts`에서 blocker를 호출한다.
- `buildResolverCandidatesFromGenerator()`에 `blockerOnlyIds`를 넘긴다.
- 가능하면 `preloadedDocs`까지 같이 넘겨 재조회 중복도 줄인다.
- `buildResolverCandidatesFromPlan()`은 더 이상 메인 경로로 쓰지 않는다.

수정 파일:

- `src/application/search/resolve.usecase.ts`
- `src/application/search/search-usecase-resolver-candidates.ts`

Acceptance:

- `/search`, `/resolve`, hybrid path가 같은 candidate generation contract vocabulary를 사용한다.
- anchor miss + blocker hit query에서 `/resolve`도 candidate 0으로 끝나지 않는다.

필수 테스트:

- 동일 query를 `/search`와 `/resolve`에 넣었을 때 blocker seed consumption이 동일
- anchor miss case에서 `/resolve`가 empty candidate로 종료되지 않음

### P0-2. TA2-T2 noisy evidence formalization

현재 exact recovery는 blocker seed 쪽은 많이 닫혔지만,
fuzzy / transliteration / noisy alias evidence를 retrieval core에서 명시적으로 다루는 구조는 아직 약하다.

중요:
이 작업은 새 public `EntityHypothesis` 타입을 만드는 작업이 아니다.
우선은 existing `AnchorCandidate`를 exact recovery substrate로 더 엄격하게 쓰는 게 맞다.

해야 할 일:

- `AnchorCandidate.source`, `lookupStrategies`, `lookupVariants`를 exact recovery provenance로 끝까지 보존한다.
- fuzzy / transliteration / planner-emitted noisy evidence가 generator / resolver / eval에 살아남게 한다.
- downstream에서 최소한 아래 source 구분이 가능해야 한다.
  - `alias`
  - `planner_heuristic`
  - `entity_lookup`
  - `blocker_seed`

수정 파일:

- `src/domain/query/model/anchor-candidate.ts`
- anchor emission site
- `src/domain/resolver/model/entity-candidate-generator-input.ts`
- `src/application/search/search-usecase-resolver-candidates.ts`
- resolver / trace / eval surface

Acceptance:

- noisy entity evidence가 candidate generation 단계에서 유실되지 않는다.
- exact recovery eval에서 candidate provenance source를 구분 가능하다.

필수 테스트:

- 한글 음차 / 오타 / transliteration query에서 source와 strategy가 trace에 남음
- blocker seed / alias anchor / fuzzy planner evidence를 eval에서 분리 가능

### P0-3. E1-T3 deterministic tie-break finalization

현재 rank comparator는 예전보다 좋아졌지만,
RFC 관점에서 완전히 닫으려면 tie-break semantics를 더 명시적으로 고정해야 한다.

중요:
새 ranking substrate를 만들지 말고 existing ranker comparator 위에서 해결한다.

해야 할 일:

- current comparator의 stage 정의를 RFC acceptance와 1:1로 맞춘다.
- 필요하면 existing `ScoredEntry`/`RankedResult` 위에 tie-break용 canonical signal을 최소 추가한다.
- insertion order, channel merge order, map iteration order가 결과를 바꾸지 못하게 고정한다.

수정 파일:

- `src/domain/ranking/service/ranker.ts`
- 필요시 `src/domain/ranking/model/ranked-result.ts`

Acceptance:

- 동일 final score 동률군에서 순서가 완전히 deterministic
- lexical exactness / sparse rank / stable entity id가 comparator semantics로 드러남
- comparator 주석과 실제 구현이 일치

필수 테스트:

- equal score tie군 deterministic ordering
- insertion order shuffle regression
- absent sparse rank / NaN case

### P0-4. E1-T5 fingerprint replay-grade 강화

현재 fingerprint는 존재한다.
문제는 “없다”가 아니라 “입력 범위가 아직 좁다”는 것이다.

해야 할 일:

- fingerprint input을 확장한다.
- 반드시 검토할 대상:
  - `policyRuleVersion`
  - `thresholdProfileId`
  - `responseContractVersion`
  - `rerankApplied`
  - `rerankModelId`
  - canonicalized `modelVersions`
  - canonicalized `indexVersions`
  - retrieval plan / ranking config version

중요:

- query text는 넣지 않는다.
- request id는 넣지 않는다.
- config/index/model drift 감지가 목적이지 per-query uniqueness가 목적이 아니다.

수정 파일:

- `src/application/search/search-usecase-post-route-phase.ts`
- `src/domain/shared/utils/determinism-fingerprint.ts`
- `src/domain/response/service/response-builder.ts`

Acceptance:

- 같은 config/index/model이면 fingerprint 동일
- index/model/policy/rerank config가 바뀌면 fingerprint 변경
- query text만 바뀌었다고 fingerprint가 달라지지 않음

필수 테스트:

- same config, different query -> same fingerprint
- same query, different indexVersions -> different fingerprint
- same query, different rerank model -> different fingerprint

### P0-5. E1-T4 rerank decision normalization

이 작업은 중요하지만 retrieval core보다 한 단계 뒤다.

중요:
이건 새 대형 rerank subsystem을 만드는 작업이 아니다.
existing ranker output을 정규화하는 작업이다.

해야 할 일:

- `skipReason` / safety block / drift observability를 하나의 typed decision surface로 수렴시킨다.
- 새로운 SSOT는 existing ranker result에 붙어야 한다.
- 문자열 reason이 여러 군데 흩어지지 않게 정리한다.

수정 파일:

- `src/domain/ranking/service/ranker.ts`
- `src/domain/ranking/port/ranker.port.ts`
- 필요시 `src/domain/audit/model/audit-extension.ts`

Acceptance:

- rerank apply / skip / safety block이 하나의 typed decision contract로 표현된다.
- runtime / audit / response에서 같은 decision을 소비한다.

필수 테스트:

- no model
- empty candidates
- feature mismatch
- safety block
- rerank applied

---

## 후순위 작업

### P1-1. entity route의 selective compiled-field threading

이건 필요할 수 있다.
하지만 **정확도 코어 P0를 닫고 나서** 진행해야 한다.

현재 entity route는 여전히 일부 plan-first semantics에 묶여 있다.
다만 이걸 한 번에 `CompiledWineQuery` 중심으로 전체 이행하면 scope가 폭발한다.

따라서 후순위 원칙은 이렇다.

- 필요한 compiled field만 선택적으로 thread
- exact retrieval 문제를 migration 문제로 확대하지 말 것

### P1-2. legacy anchors-only helper 퇴역

`buildResolverCandidatesFromPlan()`은 남겨두더라도 메인 경로가 아니어야 한다.
P0-1 완료 후 실제 call site가 없다면 제거 후보로 본다.

---

## 실행 순서

1. `P0-1 TA2-T5 entrypoint 통일`
2. `P0-2 TA2-T2 noisy evidence formalization`
3. `P0-3 E1-T3 deterministic tie-break finalization`
4. `P0-4 E1-T5 fingerprint replay-grade 강화`
5. `P0-5 E1-T4 rerank decision normalization`
6. `P1-1 entity route selective compiled-field threading`
7. `P1-2 legacy anchors-only helper 퇴역`

이 순서를 바꾸면 안 되는 이유:

- `P0-1`, `P0-2`가 exact recovery 성능을 직접 올린다.
- `P0-3`, `P0-4`는 그 성능을 deterministic / replayable하게 만든다.
- `P0-5`는 ranking contract를 정리하는 마감층이다.
- `P1`은 구조 정리이지만 정확도 코어보다 뒤다.

---

## 작업 종료 체크리스트

아래 질문에 모두 `yes`여야 한다.

- `/search`, `/resolve`, hybrid path가 같은 candidate generation contract를 쓰는가
- anchor miss + blocker hit query에서 세 경로 모두 exact recovery path가 열리는가
- noisy entity evidence가 provenance와 함께 살아남는가
- rank tie-break가 insertion order / merge order에 영향받지 않는가
- fingerprint가 index/model/policy drift를 실제로 감지하는가
- rerank apply/skip/block semantics가 하나의 typed decision으로 수렴했는가
- 기존 `ScoreDriftRecord`, `ToolOutcome`, `StructuredClarifyPayload`, `AuditExtension`과 병렬 truth를 만들지 않았는가

---

## 최종 한 줄

지금부터의 작업 원칙은 단순하다.

**새 시스템을 또 만들지 말고, existing `AnchorCandidate / shared generator / ranker output / audit extension`을 SSOT로 유지한 채 exact recovery와 determinism의 마지막 빵구만 닫는다.**
