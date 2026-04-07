# 01. Epic/Task Backlog

이 문서는 `apr-7-v0.4`의 **authoritative execution backlog**다.  
실제 구현 순서와 PR-sized 태스크 경계는 이 문서를 기준으로 본다.

- 목표 아키텍처와 전체 맥락: [00-overview.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/00-overview.md)
- execution unit handoff spec: [02-execution-unit-cards.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/02-execution-unit-cards.md)
- worker status / DAG board: [03-execution-status-board.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/03-execution-status-board.md)
- 현재 상태와 구현 자산 근거: [appendix-a-current-state.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-a-current-state.md)
- 코드 기준 교체 지점과 blast radius 지도: [appendix-h-implementation-map.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-h-implementation-map.md)
- 중복개발 방지 분류 SSOT: [appendix-j-existing-asset-registry.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-j-existing-asset-registry.md)

읽는 순서는 아래로 고정한다.

1. `00-overview`
2. `01-epic-task-backlog`
3. `02-execution-unit-cards`
4. `03-execution-status-board`
5. `appendix-h`
6. `appendix-j`
7. `appendix-i` (성능 레버 우선순위 rationale이 필요할 때만)

---

## 공통 규칙

### 태그 SSOT

모든 태스크와 execution unit은 아래 태그 중 하나를 먼저 가진다.

- `reuse`: existing seam를 그대로 재사용
- `promote`: existing asset을 runtime SSOT / policy table / first-class contract로 승격
- `thin_adapter`: 기존 경계를 migration layer로만 얇게 유지
- `remove_later`: 당장은 남기되 migration 종료 후 제거
- `new_small_module`: 진짜 갭만 작은 coordinator / policy module로 추가

구현 전 체크 순서는 고정한다.

1. [appendix-j-existing-asset-registry.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-j-existing-asset-registry.md)에서 동일 역할 자산 확인
2. 있으면 `reuse / promote / thin_adapter / remove_later`로 처리
3. 없을 때만 `new_small_module`
4. `new_small_module`이어도 storage / eval / observability / response contract는 existing seam 재사용

### 태스크 크기

- 모든 태스크는 **PR-sized**로 자른다
- 한 태스크는 하나의 핵심 판단만 바꾼다
- behavior change가 크면 분리하고, 경계 정의와 wiring은 먼저 뺀다

### LLM-sized execution unit 규칙

- 각 태스크는 더 작은 `execution unit`으로 다시 쪼갠다
- 한 unit은 가능하면 `1-3개 파일`, `1개 핵심 판단`, `1개 acceptance point`만 가진다
- `contract`, `adapter`, `wiring`, `activation`, `doc_guard`를 섞으면 다시 쪼갠다
- 여러 entrypoint에 같은 패턴을 적용할 때는 `shared seam 정의`와 `entrypoint별 적용`을 분리한다
- `new_small_module` unit은 항상 `입력 계약 정의 -> insertion point 고정 -> activation/governance path` 순서로 쪼갠다
- 한 unit이 3개를 넘는 primary touchpoint를 요구하면 구현 전에 다시 split한다

### Unit card SSOT

- 이 문서는 `순서`, `dependency`, `병렬화`, `task grouping`의 SSOT다
- [02-execution-unit-cards.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/02-execution-unit-cards.md)는 `unit별 touchpoint`, `acceptance`, `tests/checks`, `no-touch boundary`, `start/finish gate`, `primary unlocks`의 SSOT다
- 두 문서가 충돌하면 `순서/병렬화`는 `01`, `work boundary`는 `02`를 우선한다

### Unit 품질 기준

- execution unit 품질 평가는 [02-execution-unit-cards.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/02-execution-unit-cards.md)의 `100점 기준`을 따른다
- unit은 `Start gate`, `Acceptance`, `Checks`, `Finish gate`, `Primary unlocks`가 모두 잠기기 전까지 착수 준비 완료로 보지 않는다
- `Primary unlocks`는 바로 이어서 착수할 다음 unit 1-3개만 열어야 하고, 그 외는 `Secondary unlocks`로만 남긴다

### Status SSOT

여러 워커가 동시에 붙을 때 unit 상태 값은 아래 3개만 쓴다.

- `대기`: 아직 착수하지 않았거나, 선행 unit closure를 기다리는 상태
- `진행중`: 현재 단 한 명의 워커만 잡고 있는 상태
- `완료`: `Acceptance`와 `Checks`를 통과했고 handoff 가능한 상태

상태 변경 시각은 반드시 같이 남긴다.

- 필드명: `상태변경시각`
- 형식: `YYYY-MM-DD HH:mm KST`
- 예시: `2026-04-07 17:42 KST`

unit 상태 기록은 아래 형식을 고정한다.

아래 표는 **상태 필드 의미를 설명하기 위한 예시**다. 실제 live execution tracking과 handoff 기록은 항상 [03-execution-status-board.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/03-execution-status-board.md)에서만 관리한다.

| Unit | Status | 상태변경시각 | Worker | Blocked by | Primary unlocks |
| --- | --- | --- | --- | --- | --- |
| `E1-U1` | `완료` | `2026-04-07 17:42 KST` | `worker-a` | `-` | `E1-U2` |
| `E1-U2` | `진행중` | `2026-04-07 18:03 KST` | `worker-b` | `-` | `E1-U5` |
| `E1-U5` | `대기` | `2026-04-07 18:03 KST` | `-` | `E1-U2` | `E1-U6` |

규칙:

1. 한 unit은 동시에 한 워커만 `진행중`으로 잡는다
2. `진행중`으로 바꾸는 순간 `상태변경시각`도 같이 갱신한다
3. `완료`로 바꾸는 순간 `Acceptance`, `Checks`, `Next`가 함께 남아야 한다
4. 선행 unit이 안 닫혔으면 `대기`를 유지하고 억지로 `진행중`으로 바꾸지 않는다
5. `Blocked by`는 현재 막는 직접 선행 unit만 적고, 간접 의존성은 적지 않는다

### DAG 운용 규칙

이 backlog의 DAG는 아래 우선순위로 읽는다.

1. `선행` 열
2. [02-execution-unit-cards.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/02-execution-unit-cards.md)의 `Start gate`
3. 같은 문서의 `Primary unlocks`

규칙:

1. `선행`이나 `Start gate`가 안 닫힌 unit은 `진행중`으로 올릴 수 없다
2. `Primary unlocks`는 DAG 상의 **즉시 다음 후보**일 뿐, 선행조건을 무시하는 특권이 아니다
3. `Secondary unlocks`는 참고용 downstream consumer이며, DAG 착수 근거로 쓰지 않는다
4. `closure` marker는 실제 다음 작업이 아니라 task closure 신호다
5. 워커 handoff 시 `Next`는 `Primary unlocks` 중 **실제로 지금 바로 착수 가능한 1개만** 고른다

### Epic DAG 요약

에픽 간 DAG는 아래 순서로 고정한다.

- `Epic 1 -> Epic 2 -> Epic 3 -> Epic 5 -> Epic 6`
- `Epic 3 -> Epic 4`
- `Epic 4 -> Epic 6`

의미:

- Runtime currency가 닫혀야 retrieval/ranking/eval이 같은 vocabulary를 쓴다
- Ranking no-copy/calibrator prerequisite가 잠기기 전에는 response alignment와 rollout activation을 공격적으로 열지 않는다
- Session/quality는 rollout/promotion semantics와 response obligation map 이후에만 붙는다

### Worker 배치 규칙

병렬 작업은 가능하지만 DAG를 거스르면 안 된다.

1. 같은 task 안에서는 앞 unit이 `완료`되기 전 다음 unit을 `진행중`으로 올리지 않는다
2. 다른 task라도 `Blocked by`가 비어 있고 `Start gate`가 닫힌 unit만 병렬 착수한다
3. `doc_guard`는 병렬 가능하지만, 연결된 구현 unit merge 전에 반드시 `완료`돼 있어야 한다
4. `activation` unit은 연결된 `contract`, `adapter`, `wiring`, `doc_guard`가 모두 `완료`된 뒤에만 연다
5. response / rollout / session처럼 blast radius가 큰 에픽은 **한 번에 하나의 activation unit만** `진행중`으로 둔다

### 착수 순서 규칙

- 한 워커는 한 번에 **unit 하나만 in progress**로 둔다
- 같은 task 안에서도 앞 unit의 `Acceptance`를 닫기 전엔 다음 unit으로 넘어가지 않는다
- `doc_guard` unit은 구현 unit과 병렬 가능하지만, 구현 unit merge 전에는 반드시 닫는다
- `activation` unit은 같은 epic의 `contract`와 `adapter/wiring` unit이 모두 닫힌 뒤에만 착수한다

### 권장 시작 순서

처음부터 병렬로 흩어지지 말고 아래 순서로 붙는다.

1. `E1-U1`
2. `E1-U2`
3. `E1-U5`
4. `E1-U6`
5. `E1-U8`
6. `E2-U1`
7. `E2-U2`
8. `E2-U3`
9. `E2-U4`
10. `E3-U1`

이 10개가 닫히기 전에는 response/session/rollout 쪽으로 건너뛰지 않는다.

### 초반 보류 유닛

아래 unit은 초반 10개가 닫히기 전에는 일부러 보류한다.

- `E4-U2` ~ `E4-U7`
- `E5-U4` ~ `E5-U7`
- `E6-U1` ~ `E6-U5`

이유:

- response 쪽은 runtime currency와 ranking semantics가 먼저 잠겨야 헛수고가 적다
- rollout/calibrator activation은 eval wiring 전엔 문서만 커지고 실익이 적다
- session/quality는 retrieval/ranking/confidence vocabulary가 잠기기 전엔 정책 drift가 심하다

### 전역 금지사항

- `QueryPlanV1`에 새 필드 추가 금지
- 새 retrieval engine / 새 ranker / 새 response builder / 새 offline eval stack 금지
- `decision-engine.ts` 복제 금지
- `human-response-builder-v2.ts`를 초기 메인 runtime contract로 간주 금지
- ranked-route calibrator를 eval wiring 전에 도입 금지

---

## Epic 1. Runtime Currency and Planner Bridge

**목표**

- `QueryPlanV1` 제거가 아니라 `CompiledWineQuery` / `EngineExecutionContract`를 runtime에 병행 진입시킨다
- route / snapshot / debug / eval이 compiled execution summary를 먼저 보게 만든다

**선행조건**

- 없음

**비목표**

- `QueryPlannerPort.plan(): Promise<QueryPlanV1>` 시그니처 변경
- planner stack 전면 교체
- public response contract 변경

**Do Not Rebuild**

- planner 포트 신규 버전
- parallel query DTO stack
- 별도 route compiler stack

| Task | Tag | Work type | 포함 unit | Done when | Do not touch | 선행 태스크 | 병렬 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E1-T1` dual-currency bridge | `promote` | `contract + adapter + wiring` | `E1-U1`, `E1-U2`, `E1-U3`, `E1-U4` | search / hybrid / interpret가 같은 compiled summary seam를 runtime에 함께 들고 다닌다 | `QueryPlannerPort` 시그니처, public response contract | - | 불가 |
| `E1-T2` compiled-first route resolution | `thin_adapter` | `adapter` | `E1-U5` | route resolution이 compiled summary를 우선 읽고 V1은 fallback으로만 쓴다 | route dispatch 재설계, planner 교체 | `E1-T1` | 불가 |
| `E1-T3` snapshot/debug/eval enrichment | `promote` | `adapter + wiring` | `E1-U6`, `E1-U7`, `E1-U8` | snapshot/debug/eval export가 compiled summary vocabulary를 공유한다 | snapshot ID schema 재설계, 새 eval stack | `E1-T2` | 불가 |
| `E1-T4` QueryPlanV1 compatibility guard | `thin_adapter` | `doc_guard` | `E1-U9` | `QueryPlanV1`이 compatibility-only surface로 고정되고 필드 확장 금지 규칙이 문서에 잠긴다 | planner contract migration 자체 | - | `E1-T1`과 병렬 가능 |

### Epic 1 execution unit

| Unit | Tag | Work type | Primary touchpoints | 핵심 판단 | Acceptance | 선행 |
| --- | --- | --- | --- | --- | --- | --- |
| `E1-U1` shared compiled payload seam | `promote` | `contract` | `execution-compiler.ts`, `compiled-wine-query.ts`, `engine-execution-contract.ts` | runtime이 planner 옆에 들고 다닐 compiled summary field set을 하나로 고정한다 | search / hybrid / interpret가 같은 summary vocabulary를 참조한다 | - |
| `E1-U2` search entry bridge | `promote` | `wiring` | `search.usecase.ts`, `search-usecase-pre-route-phase.ts` | main search path에서 compiled summary를 만드는 유일한 producer 위치를 고정한다 | search path가 planner 결과와 compiled summary를 같이 들고 시작한다 | `E1-U1` |
| `E1-U3` search shared context propagation | `promote` | `adapter` | `search-usecase-post-route-phase.ts`, `search-usecase-decision-input.ts` | shared helper가 compiled summary를 재계산 없이 전달받는 경로를 고정한다 | post-route / decision input이 summary를 다시 만들지 않는다 | `E1-U2` |
| `E1-U4` hybrid/interpret bridge | `promote` | `wiring` | `hybrid.usecase.ts`, `interpret.usecase.ts` | hybrid / interpret entrypoint도 같은 compiled summary seam를 재사용한다 | entrypoint별 parallel summary shape가 생기지 않는다 | `E1-U1` |
| `E1-U5` compiled-first route helper | `thin_adapter` | `adapter` | `search-usecase-route-resolution.ts`, `search.usecase.ts` | route helper는 compiled summary first, `QueryPlanV1` fallback only로 읽는다 | `plan.route / retrievalMode` 직접참조가 더 이상 authoritative가 아니다 | `E1-U2` |
| `E1-U6` snapshot field mapping | `promote` | `adapter` | `search-usecase-decision-snapshot.ts` | route / mode / budget / provenance-policy summary가 snapshot vocabulary에 어떻게 들어가는지 고정한다 | snapshot enrichment 범위가 문서와 코드에서 같은 이름으로 설명된다 | `E1-U5` |
| `E1-U7` debug export mapping | `promote` | `adapter` | `search-usecase-post-route-phase.ts`, `search.usecase.ts` | runtime debug surface가 compiled summary vocabulary를 그대로 쓴다 | debug path가 plan-only vocabulary를 추가로 만들지 않는다 | `E1-U5` |
| `E1-U8` eval export mapping | `promote` | `adapter` | `search-usecase-eval-provenance.ts`, `search-pipeline-evaluator.ts` | eval export가 compiled summary와 같은 route/mode vocabulary를 사용한다 | eval 쪽 필드명이 runtime summary vocabulary와 충돌하지 않는다 | `E1-U5` |
| `E1-U9` V1 compatibility rule | `thin_adapter` | `doc_guard` | `query-plan.ts`, `01-epic-task-backlog.md`, `02-execution-unit-cards.md` | `QueryPlanV1`은 확장 대상이 아니라 compatibility surface라고 못 박는다 | 새 V1 field 추가 금지 규칙이 backlog와 unit card에 모두 있다 | `E1-U2` |

**완료 기준**

- runtime route/mode 판단이 compiled contract 기준으로 설명 가능해야 한다
- `QueryPlannerPort`는 초기 에픽에서 그대로 유지된다고 문서에 명시돼야 한다
- `QueryPlanV1`은 확장 대상이 아니라 compatibility surface로 고정돼야 한다

---

## Epic 2. Retrieval Lane Policy and Candidate Assembly

**목표**

- retrieval을 새 엔진으로 갈아엎지 않고 lane policy table 아래로 정렬한다
- compiled execution hint가 retrieval input까지 실제로 내려가게 만든다

**선행조건**

- `E1-T1`
- `E1-T2`

**비목표**

- second retrieval DTO stack 추가
- candidate assembly 재구현
- browse / compare / substitute 별도 engine 신설

**Do Not Rebuild**

- `candidate-pool.ts` 옆 parallel retrieval engine
- route별 hard filter / protected recall 중복 구현

| Task | Tag | Work type | 포함 unit | Done when | Do not touch | 선행 태스크 | 병렬 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E2-T1` lane policy table promotion | `promote` | `contract` | `E2-U1`, `E2-U2` | retrieval profile / channel mix가 lane capability / budget / route semantics 표로 읽힌다 | parallel retrieval policy layer | `E1-T2` | 불가 |
| `E2-T2` compiled-aware retrieval input | `promote` | `contract + wiring` | `E2-U3`, `E2-U4` | `HybridRetrievalInput`이 compiled hint를 받고 hybrid builder가 그 contract를 만든다 | second retrieval DTO stack | `E2-T1` | 불가 |
| `E2-T3` specialized path alignment | `promote` | `adapter` | `E2-U5`, `E2-U6` | browse / compare / relative / substitute path가 lane policy 하위 경로로 정리된다 | route별 standalone engine | `E2-T2` | `E2-T4`와 병렬 가능 |
| `E2-T4` assembly reuse guard | `reuse` | `doc_guard` | `E2-U7` | assembly / protected recall / evidence accumulation이 route-independent reuse seam로 잠긴다 | candidate assembly 재구현 | `E2-T2` | `E2-T3`와 병렬 가능 |

### Epic 2 execution unit

| Unit | Tag | Work type | Primary touchpoints | 핵심 판단 | Acceptance | 선행 |
| --- | --- | --- | --- | --- | --- | --- |
| `E2-U1` lane capability inventory | `promote` | `contract` | `retrieval-profile.ts`, `channel-mix-policy.ts` | lane capability, budget, route semantics 입력을 현재 자산에서 분리 추출한다 | policy table이 무엇을 받아야 하는지 inventory가 잠긴다 | `E1-U5` |
| `E2-U2` lane policy table skeleton | `promote` | `contract` | `retrieval-profile.ts`, `channel-mix-policy.ts`, `candidate-pool.ts` | policy table의 최소 컬럼과 decision output을 고정한다 | `lane policy -> retrieval input` 설명이 한 문장으로 가능하다 | `E2-U1` |
| `E2-U3` compiled-aware retrieval input contract | `promote` | `contract` | `retrieval-input.ts`, `engine-execution-contract.ts` | retrieval input이 compiled hint를 받되 별도 DTO stack은 만들지 않는다 | compiled hint field가 retrieval input contract에 고정된다 | `E2-U2` |
| `E2-U4` hybrid candidate builder wiring | `promote` | `wiring` | `search-usecase-hybrid-candidates.ts`, `search.usecase.ts`, `search-usecase-hybrid-ranking-pipeline.ts` | hybrid candidate builder가 compiled-aware input을 만드는 유일 경로를 고정한다 | main hybrid path가 compiled-aware retrieval input을 사용한다 | `E2-U3` |
| `E2-U5` browse/region specialized mapping | `promote` | `adapter` | `search-usecase-hybrid-candidates.ts`, `browse-retriever.ts`, `retrieval-profile.ts` | producer/region browse는 lane policy 하위 specialized path로 읽혀야 한다 | browse specialized path가 ad hoc fallback이 아니라 policy child path로 설명된다 | `E2-U4` |
| `E2-U6` compare/relative/substitute mapping | `promote` | `adapter` | `compare-retriever.ts`, `search-usecase-mixed-route.ts`, `mixed-solver.ts` | compare / relative / substitute는 같은 specialized family로 묶되 parallel engine은 만들지 않는다 | compare / relative / substitute가 lane policy 하위 path로 정리된다 | `E2-U4` |
| `E2-U7` assembly reuse lock | `reuse` | `doc_guard` | `candidate-pool.ts`, `candidate-assembly.ts`, `evidence-accumulator.ts` | assembly / protected recall / evidence accumulation은 route-independent reuse seam로 잠근다 | route별 assembly 재구현 금지가 명시된다 | `E2-U4` |

**완료 기준**

- retrieval 설명이 `lane policy -> retrieval input -> assembly` 순으로 읽혀야 한다
- `candidate-pool`, `candidate-assembly`, `evidence-accumulator`는 모두 reuse 대상으로 고정돼야 한다
- specialized path는 lane policy의 하위 경로로 설명돼야 한다

---

## Epic 3. Ranking Funnel and Ranked-Route Confidence Prerequisites

**목표**

- ranking을 재개발하지 않고 stage seam를 authoritative outer seam로 고정한다
- future ranked-route calibrator가 들어갈 수 있도록 입력 계약과 insertion point를 정리한다

**선행조건**

- `E2-T1`
- `E2-T2`

**비목표**

- 새 ranker stack 생성
- `decision-engine.ts` 복제
- calibrator production 연결 선행

**Do Not Rebuild**

- `ranker.ts` 안에 새 CE/LTR/late-interaction 책임 계속 누적
- standalone ranked-route decision layer 신설

| Task | Tag | Work type | 포함 unit | Done when | Do not touch | 선행 태스크 | 병렬 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E3-T1` authoritative stage pipeline | `promote` | `contract` | `E3-U1` | `RankingStagePipeline`이 ranking outer seam로 고정된다 | ranking pipeline 재개발 | `E2-T2` | 불가 |
| `E3-T2` ranker responsibility extraction | `thin_adapter` | `adapter` | `E3-U2`, `E3-U3` | `Ranker` 내부 책임이 signal / gate / apply 단위로 분리 설명된다 | new ranker stack | `E3-T1` | 불가 |
| `E3-T3` single LTR path convergence | `reuse` | `adapter` | `E3-U4` | LTR ownership이 한 경로로 수렴한다 | LTR parallel path 유지 | `E3-T2` | 불가 |
| `E3-T4` ranked-route calibrator contract | `new_small_module` | `contract + insertion` | `E3-U5`, `E3-U6` | calibrator 입력 feature와 insertion point가 정의된다 | production activation, `decision-engine` 복제 | `E3-T1` | `E3-T2`와 부분 병렬 가능 |
| `E3-T5` no-duplication decision rule | `new_small_module` | `doc_guard` | `E3-U7` | calibrator가 기존 decision path 안으로만 들어와야 한다는 규칙이 잠긴다 | standalone decision layer | `E3-T4` | 불가 |

### Epic 3 execution unit

| Unit | Tag | Work type | Primary touchpoints | 핵심 판단 | Acceptance | 선행 |
| --- | --- | --- | --- | --- | --- | --- |
| `E3-U1` stage boundary declaration | `promote` | `contract` | `ranking-stage-pipeline.ts`, `search-usecase-hybrid-ranking-pipeline.ts` | `RankingStagePipeline`이 authoritative outer seam라는 규칙과 stage boundary를 고정한다 | ranking 설명이 pipeline outer seam 중심으로 읽힌다 | `E2-U4` |
| `E3-U2` ranker responsibility map | `thin_adapter` | `adapter` | `ranker.ts`, `ranking-stage-pipeline.ts` | `Ranker` 내부 책임을 signal compute / gate / apply / runtime signal로 분리 표기한다 | 이후 gate/LTR extraction 위치가 더 이상 애매하지 않다 | `E3-U1` |
| `E3-U3` rerank gate contract | `promote` | `contract` | `rerank-gate.ts`, `ranker.ts`, `ranking-stage-pipeline.ts` | CE gate가 읽는 입력과 내보내는 decision summary를 별도 contract로 고정한다 | rerank gate semantics가 ranker 내부 암묵 규칙이 아니다 | `E3-U2` |
| `E3-U4` single LTR ownership | `reuse` | `adapter` | `search-usecase-ltr-rerank.ts`, `ranker.ts`, `ltr-ranker.ts` | LTR apply ownership은 한 경로만 가진다 | `search-usecase-ltr-rerank`와 `Ranker`가 동시에 LTR owner로 남지 않는다 | `E3-U2` |
| `E3-U5` calibrator feature source map | `new_small_module` | `contract` | `ranked-result.ts`, `funnel-metrics.ts`, `utility-scorer.ts` | future calibrator가 읽는 최소 feature source set을 고정한다 | feature source가 `Ranker` 내부 비공개 state에 묶이지 않는다 | `E3-U1` |
| `E3-U6` calibrator insertion point | `new_small_module` | `insertion` | `search-usecase-ranked-route-resolve.ts`, `search-usecase-decision-input.ts` | calibrator가 existing ranked-route -> decision path 어디에 끼어드는지 고정한다 | insertion point가 하나의 hook로 설명된다 | `E3-U3`, `E3-U5` |
| `E3-U7` decision-path no-copy rule | `new_small_module` | `doc_guard` | `decision-engine.ts`, `01-epic-task-backlog.md`, `02-execution-unit-cards.md` | calibrator가 들어가도 `decision-engine` 복제는 금지라고 못 박는다 | backlog와 unit cards가 같은 no-copy rule을 가진다 | `E3-U6` |

**완료 기준**

- ranking plan이 “Ranker 안에 더 넣자”가 아니라 “outer seam 유지 + inner extraction”으로 읽혀야 한다
- calibrator는 아직 production 연결 전이며, Epic 5 eval wiring 이후 활성화된다고 문서에 명시돼야 한다

---

## Epic 4. Response and Explanation Contract

**목표**

- 새 response builder를 만들지 않고 explanation obligation과 V1/V2 bridge를 정리한다
- V2 builder는 sidecar/adapter 승격 대상으로 두고, 메인 runtime contract는 당분간 유지한다

**선행조건**

- `E1-T3`
- `E3-T1`

**비목표**

- `human-response-builder-v2`를 초기 메인 response surface로 승격
- parallel explanation stack 신설

**Do Not Rebuild**

- 새 response/explanation builder stack
- front-only grouped semantics 재정의

| Task | Tag | Work type | 포함 unit | Done when | Do not touch | 선행 태스크 | 병렬 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E4-T1` main runtime response contract explicit | `reuse` | `doc_guard` | `E4-U1` | `ResponseBuilder`가 초기/중기 main runtime contract라고 명시된다 | public response contract 재설계 | `E1-T3` | 불가 |
| `E4-T2` V2 builders as sidecar adapters | `promote` | `adapter` | `E4-U2`, `E4-U3` | V2 builders가 sidecar surface로 정리되고 main runtime replacement로 읽히지 않는다 | parallel response builder stack | `E4-T1` | 불가 |
| `E4-T3` explanation policy module | `new_small_module` | `contract` | `E4-U4`, `E4-U5` | explanation policy가 책임 범위와 query-family obligation을 가진 작은 모듈로 정의된다 | new response builder | `E4-T1` | `E4-T4`와 병렬 가능 |
| `E4-T4` calibrated semantics alignment | `thin_adapter` | `adapter` | `E4-U6`, `E4-U7` | route/provenance/clarification/counterfactual meta가 calibrated semantics vocabulary에 맞춰진다 | new explanation stack | `E4-T1` | `E4-T3`와 병렬 가능 |

### Epic 4 execution unit

| Unit | Tag | Work type | Primary touchpoints | 핵심 판단 | Acceptance | 선행 |
| --- | --- | --- | --- | --- | --- | --- |
| `E4-U1` main response contract lock | `reuse` | `doc_guard` | `response-builder.ts`, `search-usecase-map-result-items.ts` | `ResponseBuilder`가 초기/중기 main runtime response surface라고 못 박는다 | main runtime response contract가 더 이상 애매하지 않다 | `E1-U6` |
| `E4-U2` machine V2 sidecar scope | `promote` | `adapter` | `machine-response-builder-v2.ts`, `result-item-v2.ts` | machine V2는 sidecar/adapter surface이지 search route replacement가 아니다 | machine V2의 역할 경계가 명확하다 | `E4-U1` |
| `E4-U3` human V2 sidecar scope | `promote` | `adapter` | `human-response-builder-v2.ts`, `interpret-explain-adapter-v2.ts` | human V2는 human-oriented sidecar surface이지 초기 main contract가 아니다 | human V2 조기 승격 해석이 제거된다 | `E4-U1` |
| `E4-U4` explanation-policy responsibility split | `new_small_module` | `contract` | `response-builder.ts`, `interpret-explain-adapter-v2.ts`, `evidence-gate.ts` | policy module이 evidence minimum / suppress / fallback 중 어디까지 맡는지 고정한다 | policy와 builder 책임이 겹치지 않는다 | `E4-U1` |
| `E4-U5` query-family obligation map | `new_small_module` | `contract` | `response-builder.ts`, `search-usecase-counterfactuals.ts`, `evidence-gate.ts` | query family별 explanation obligation / suppression 기준을 고정한다 | explanation obligation이 query family 기준으로 설명된다 | `E4-U4` |
| `E4-U6` route/provenance metadata alignment | `thin_adapter` | `adapter` | `response-builder.ts`, `specialized-route-observability.ts`, `engine-decision.ts` | route/provenance meta가 calibrated decision semantics vocabulary와 같은 축을 쓴다 | route/provenance meta가 ad hoc field 집합이 아니다 | `E4-U1`, `E3-U7` |
| `E4-U7` clarification/counterfactual alignment | `thin_adapter` | `adapter` | `response-builder.ts`, `search-usecase-counterfactuals.ts`, `interpret-explain-adapter-v2.ts` | clarification / counterfactual surface도 같은 semantics vocabulary를 쓴다 | clarification/counterfactual semantics가 response meta와 충돌하지 않는다 | `E4-U5`, `E4-U6` |

**완료 기준**

- 문서가 더 이상 `human-response-builder-v2`를 초기 메인 계약처럼 읽히지 않아야 한다
- response 영역의 신규 허용은 `explanation-policy` 하나로 제한돼야 한다

---

## Epic 5. Eval, Learning, and Rollout Governance

**목표**

- existing eval / promotion seam를 compiled runtime과 calibrated confidence에 연결한다
- shadow-first promotion과 rollout governance를 하나의 흐름으로 고정한다

**선행조건**

- `E1-T3`
- `E3-T4`
- `E4-T4`

**비목표**

- 새 offline eval stack
- 새 feedback/proposal persistence
- 새 snapshot/kill-switch 체계

**Do Not Rebuild**

- eval-only search stack
- parallel rollout governor / threshold store / snapshot store

| Task | Tag | Work type | 포함 unit | Done when | Do not touch | 선행 태스크 | 병렬 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E5-T1` eval feature enrichment | `promote` | `contract + wiring` | `E5-U1`, `E5-U2` | runtime export와 eval field가 compiled/calibrated vocabulary로 연결된다 | eval-only runtime path | `E1-T3` | 불가 |
| `E5-T2` promotion spine reuse | `reuse` | `doc_guard` | `E5-U3` | promotion / threshold / proposal / feedback spine가 existing seam reuse로 고정된다 | new persistence stack | `E5-T1` | `E5-T3`와 병렬 가능 |
| `E5-T3` rollout governance coordinator | `new_small_module` | `contract` | `E5-U4` | rollout governance coordinator의 입력과 비목표가 고정된다 | parallel rollout governor | `E5-T1` | `E5-T2`와 병렬 가능 |
| `E5-T4` ranked-route calibrator activation path | `new_small_module` | `activation` | `E5-U5`, `E5-U6`, `E5-U7` | calibrator/lane/rerank 변화가 shadow-first promotion path로만 활성화된다 | direct production activation | `E5-T2`, `E5-T3`, `E3-T4`, `E3-T5` | 불가 |

### Epic 5 execution unit

| Unit | Tag | Work type | Primary touchpoints | 핵심 판단 | Acceptance | 선행 |
| --- | --- | --- | --- | --- | --- | --- |
| `E5-U1` eval feature delta list | `promote` | `contract` | `eval-runner.ts`, `search-pipeline-evaluator.ts`, `search-usecase-eval-provenance.ts` | eval slice에 추가할 compiled / calibrated feature 집합을 고정한다 | eval이 어떤 새 runtime signal을 받는지 목록이 잠긴다 | `E1-U8`, `E3-U5` |
| `E5-U2` eval export wiring map | `promote` | `wiring` | `search-usecase-eval-provenance.ts`, `search-pipeline-evaluator.ts`, `search-usecase-decision-snapshot.ts` | runtime export가 eval field로 어떻게 매핑되는지 고정한다 | eval export naming drift가 사라진다 | `E5-U1` |
| `E5-U3` promotion spine reuse contract | `reuse` | `doc_guard` | `promotion-gate.ts`, `threshold-optimizer.ts`, `container-learning.ts` | promotion / threshold / feedback / proposal은 reuse-only spine라고 못 박는다 | 신규 persistence나 parallel learning plane이 열리지 않는다 | `E5-U2` |
| `E5-U4` rollout-governor scope | `new_small_module` | `contract` | `eval-runner.ts`, `promotion-gate.ts`, `runtime-handles.ts` | rollout governance coordinator가 읽는 입력과 하지 말아야 할 일을 고정한다 | coordinator가 snapshot/drift/promotion orchestration만 담당한다 | `E5-U3` |
| `E5-U5` calibrator activation prerequisites | `new_small_module` | `doc_guard` | `search-usecase-ranked-route-resolve.ts`, `calibration-evaluator.ts`, `utility-scorer.ts` | calibrator activation은 `E3-U5` / `E3-U7` / eval enrichment 이후에만 열린다 | calibrator가 eval/governance보다 먼저 켜지지 않는다 | `E5-U2`, `E3-U7` |
| `E5-U6` shadow-first path definition | `new_small_module` | `activation` | `eval-runner.ts`, `search-pipeline-evaluator.ts`, `promotion-gate.ts` | calibrator/lane/rerank 변화는 shadow-first path를 통해서만 관찰된다 | direct production cutover 경로가 남지 않는다 | `E5-U3`, `E5-U4`, `E5-U5` |
| `E5-U7` promotion acceptance gate | `new_small_module` | `activation` | `promotion-gate.ts`, `threshold-optimizer.ts`, `pg-threshold-store.ts` | shadow 결과가 언제 production promotion을 열 수 있는지 gate 기준을 고정한다 | acceptance path가 shadow-only 설명에서 끝나지 않는다 | `E5-U3`, `E5-U6` |

**완료 기준**

- eval stack 신규 구축 금지와 promotion spine reuse 원칙이 문서에 명확해야 한다
- ranked-route calibrator는 Epic 5에서 처음 acceptance path를 가진다고 문서에 명시돼야 한다
- rollout과 calibration이 같은 governance 흐름 안에 배치돼야 한다

---

## Epic 6. Session, Quality, and Decomposition Policy

**목표**

- session / reformulation / quality gating을 마지막에 붙여 serving policy를 완성한다
- decomposition / substitute / grouped fallback / transparency를 reuse 중심으로 정리한다

**선행조건**

- `E2-T3`
- `E4-T3`
- `E5-T4`

**비목표**

- 새 session stack
- decomposition 전용 parallel runtime
- watchlist/runtime-handle 재설계

**Do Not Rebuild**

- substitute / decomposition / grouped fallback 새 stack
- watchlist / side-effect runtime parallel path

| Task | Tag | Work type | 포함 unit | Done when | Do not touch | 선행 태스크 | 병렬 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `E6-T1` session signal promotion | `promote` | `contract` | `E6-U1` | session/reformulation 신호가 planner-only metadata가 아니라 serving policy input으로 정의된다 | new session stack | `E5-T4` | 불가 |
| `E6-T2` quality-aware gate | `promote` | `contract` | `E6-U2` | evidence quality / metadata risk / rerank suppression이 quality gate 입력으로 연결된다 | quality parallel runtime | `E6-T1` | 불가 |
| `E6-T3` decomposition/substitute reuse path | `reuse` | `adapter` | `E6-U3`, `E6-U4` | decomposition / substitute / grouped fallback이 existing seam reuse 기준으로만 정리된다 | new decomposition/substitute stack | `E6-T1` | `E6-T4`와 병렬 가능 |
| `E6-T4` operational seam reuse guard | `reuse` | `doc_guard` | `E6-U5` | watchlist / side-effect / runtime-handle seam는 재사용만 허용된다 | watchlist/runtime-handle 재설계 | `E6-T1` | `E6-T3`와 병렬 가능 |

### Epic 6 execution unit

| Unit | Tag | Work type | Primary touchpoints | 핵심 판단 | Acceptance | 선행 |
| --- | --- | --- | --- | --- | --- | --- |
| `E6-U1` session signal scope | `promote` | `contract` | `reformulation-detector.ts`, `session-context.ts`, `search-usecase-pre-route-phase.ts` | serving policy input으로 승격할 최소 session/reformulation signal 집합을 고정한다 | session signal이 planner-only metadata로만 남지 않는다 | `E5-U7` |
| `E6-U2` quality gate input contract | `promote` | `contract` | `evidence-gate.ts`, `search-usecase-decision-input.ts`, `search-usecase-post-route-phase.ts` | evidence quality / metadata risk / rerank suppression이 quality gate 입력으로 어떤 필드로 들어가는지 고정한다 | quality-aware gate의 입력 vocabulary가 잠긴다 | `E6-U1` |
| `E6-U3` decomposition reuse map | `reuse` | `adapter` | `decomposition-detector.ts`, `query-decomposition.ts`, `decomposed-search-adapter.ts` | decomposition은 새 runtime이 아니라 existing seam reuse로만 설명된다 | decomposition branch가 parallel runtime처럼 읽히지 않는다 | `E6-U1` |
| `E6-U4` substitute/grouped fallback reuse map | `reuse` | `adapter` | `mixed-solver.ts`, `search-usecase-mixed-route.ts`, `result-grouper.ts` | substitute / grouped fallback은 새 stack이 아니라 reuse path로 정리한다 | substitute/grouped fallback parallel stack 해석이 제거된다 | `E6-U1` |
| `E6-U5` operational seam lock | `reuse` | `doc_guard` | `watchlist-policy.ts`, `runtime-handles.ts`, `container-watchlist.ts` | watchlist / side-effect / runtime-handle seam는 재사용만 허용한다고 못 박는다 | operational seam를 핑계로 parallel runtime이 열리지 않는다 | `E6-U1` |

**완료 기준**

- session/quality 정책은 retrieval/ranking/confidence 이후 에픽으로만 배치돼야 한다
- decomposition과 substitute는 새 stack이 아니라 reuse로만 설명돼야 한다

---

## 병렬화 규칙

- `Epic 1`은 `E1-T4`만 부분 병렬 가능하고, 나머지는 직렬
- `Epic 2`는 `E2-T3` / `E2-T4`만 병렬 허용
- `Epic 3`은 `E3-T4`가 `E3-T1` 이후 부분 병렬 가능
- `Epic 4`는 `E4-T3` / `E4-T4` 병렬 허용
- `Epic 5`는 `E5-T2` / `E5-T3` 병렬 허용, `E5-T4`는 직렬
- `Epic 6`는 `E6-T3` / `E6-T4` 병렬 허용

이 문서의 병렬화 표시는 **문서 작업 기준 병렬화 허용**이지, 임의로 dependency를 건너뛰라는 뜻이 아니다.

---

## 완료 체크

문서 재편이 끝났다고 볼 조건은 아래다.

- `00-overview -> 01-epic-task-backlog -> 02-execution-unit-cards -> appendix-h -> appendix-j` 흐름이 자연스럽다
- 에픽 순서가 dependency order와 충돌하지 않는다
- 각 태스크가 하나의 PR로 바로 착수 가능한 크기다
- 각 execution unit이 LLM이 단독으로 진행 가능한 좁은 범위다
- `human-response-builder-v2`, `QueryPlannerPort`, ranked-route calibrator 관련 판단이 문서 전체에서 일관된다
- 각 epic에 최소 하나의 “do not rebuild” 규칙이 있다
