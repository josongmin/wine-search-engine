# 02. Execution Unit Cards

이 문서는 [01-epic-task-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/01-epic-task-backlog.md)의 **unit-level handoff spec**이다.  
순서와 병렬화는 `01`을 따르고, 각 unit의 구체 작업 범위는 이 문서를 따른다.

이번 보강에서 막은 주요 빵꾸는 아래다.

- oversized unit을 실제로 split했다
  - `E1-U6` -> `snapshot / debug / eval` 분리
  - `E2-U5` -> `browse/region` vs `compare/relative/substitute` 분리
  - `E3-U5` -> `feature source`와 `insertion point` 분리
  - `E4-U6` -> `route/provenance` vs `clarification/counterfactual` 분리
  - `E5-U6` -> `shadow path`와 `promotion gate` 분리
- 모든 unit에 `primary touchpoints`, `do / do not`, `acceptance`, `checks`를 붙였다
- `contract`, `adapter`, `wiring`, `activation`, `doc_guard`가 섞여 있던 unit을 분리했다

## 100점 기준

이 문서는 “대충 작업 가능”이 아니라, **다른 LLM이 카드 하나만 받아도 추가 질문 없이 바로 일할 수 있는 상태**를 100점으로 본다.

### 100점 체크리스트

각 unit은 아래 10개 항목을 모두 만족해야 한다.

1. `Lock`이 한 문장으로 다시 말해진다
2. `Primary touchpoints`가 1-3개를 넘지 않는다
3. `Do`가 실제 작업 범위를 닫아준다
4. `Do not`이 scope explosion을 막아준다
5. `Start gate`가 선행 unit closure를 분명히 요구한다
6. `Acceptance`가 “끝났는지”를 한 문장으로 판정 가능하게 만든다
7. `Checks`가 최소 파일/테스트/grep 기준으로 구체적이다
8. `Finish gate`가 다음 unit 침범을 막아준다
9. `Primary unlocks`가 바로 다음 unit 1-3개만 연다
10. `흔한 실패 예시`만 읽어도 어디서 망하는지 감이 온다

### 감점 기준

- 90점 미만:
  작업은 가능하지만, 다른 LLM이 scope를 조금씩 넘길 확률이 크다.
- 80점 미만:
  acceptance나 no-touch boundary가 흐려서 PR이 커질 가능성이 높다.
- 70점 미만:
  실제 구현보다 재해석 비용이 더 크다. 바로 split 또는 rewrite 대상이다.

### 즉시 재작업 신호

아래 중 하나라도 걸리면 100점이 아니다.

- unit 설명을 읽고도 “그래서 어느 파일부터 열지”가 바로 안 나온다
- acceptance가 “잘 정리됐다”처럼 추상적이다
- checks가 테스트 이름이 아니라 “관련 테스트” 수준이다
- finish gate 없이 다음 unit 일까지 같이 하게 된다
- primary unlock이 너무 넓어서 다음 사람이 두세 unit을 한꺼번에 잡게 된다
- same file이더라도 responsibility boundary가 안 적혀 있어 사실상 큰 refactor 카드처럼 읽힌다

## 사용 규칙

- unit 하나를 맡기기 전에 먼저 [01-epic-task-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/01-epic-task-backlog.md)에서 선행 unit이 닫혔는지 확인한다
- 같은 태그여도 `Do not`에 걸리면 새 파일/새 레이어를 열지 않는다
- 이 문서의 `Checks`는 최소 기준이다. 구현 중 blast radius가 커지면 더 넓히되, unit 자체를 다시 쪼개는 쪽을 먼저 본다

## Status 업데이트 규칙

워커는 각 unit 작업 전후에 상태를 아래 3값 중 하나로만 갱신한다.

- `대기`
- `진행중`
- `완료`

상태를 바꿀 때는 항상 `상태변경시각`을 같이 남긴다.

- 형식: `YYYY-MM-DD HH:mm KST`
- 예시: `2026-04-07 19:05 KST`

### 상태 변경 규칙

1. `대기 -> 진행중`
   - `Start gate`가 닫혀 있을 때만 가능
   - 워커 이름/닉네임을 같이 남긴다
2. `진행중 -> 완료`
   - `Acceptance`를 한 문장으로 통과 설명 가능해야 한다
   - `Checks`를 실제로 수행한 최소 근거가 있어야 한다
   - `Next`는 `Primary unlocks` 중 즉시 착수 가능한 1개만 남긴다
3. `진행중 -> 대기`
   - 새로운 blocker가 생겼을 때만 허용
   - `Blocked by`를 직접 선행 unit 기준으로 다시 적는다

### 상태 업데이트 최소 형식

- `Unit:` `E3-U6`
- `Status:` `진행중`
- `상태변경시각:` `2026-04-07 19:05 KST`
- `Worker:` `worker-c`
- `Blocked by:` `-`
- `Next:` `-`

### 완료 업데이트 최소 형식

- `Unit:` `E3-U6`
- `Status:` `완료`
- `상태변경시각:` `2026-04-07 19:42 KST`
- `Worker:` `worker-c`
- `Lock:` calibrator insertion은 ranked-route -> decision path의 단일 hook로만 들어간다
- `Checked:` `search-usecase-ranked-route-resolve.ts`, `search-usecase-decision-input.test.ts`
- `Next:` `E3-U7`

### DAG handoff 규칙

- `Next`는 항상 `Primary unlocks` 중 하나만 고른다
- `Primary unlocks`가 여러 개여도, handoff 순간엔 **가장 바로 집어들 수 있는 1개만** `Next`로 남긴다
- `Secondary unlocks`는 참고용이며, 진행권을 주는 값이 아니다
- `closure` marker는 상태값이 아니라 task 종료 신호다
- 다음 워커는 `Next`를 보기 전에 반드시 `Start gate`를 다시 확인한다

## LLM 작업 프로토콜

LLM이 unit 하나를 맡으면 아래 순서를 고정한다.

1. `선행 unit`이 실제로 닫혔는지 확인
2. `Primary touchpoints` 1-3개만 먼저 읽기
3. `Lock` 문장을 한 줄로 다시 쓰기
4. `Do not`에 걸리는 변경을 먼저 제외
5. 필요한 최소 테스트/체크만 고르기
6. `Acceptance`를 만족하는 가장 작은 변경만 수행
7. 마지막에 상태를 `완료`로 갱신하고 `상태변경시각`을 남기기
8. `Primary unlocks` 중 실제로 바로 착수 가능한 다음 unit 1개만 `Next`로 넘기기

이 순서를 어기면 unit이 다시 커지거나, 옆 lane까지 같이 건드릴 확률이 높다.

## 작업 전 30초 채점

unit에 착수하기 전에 아래를 30초 안에 답할 수 있어야 한다.

- 내가 먼저 열 파일 1-3개는 무엇인가
- 이번 unit에서 잠글 핵심 판단은 무엇인가
- 절대 건드리면 안 되는 옆 lane은 무엇인가
- 끝났는지 확인할 최소 체크는 무엇인가
- 끝나면 바로 누구에게 넘길 것인가

이 다섯 개가 즉시 안 나오면, 그 unit은 아직 덜 닫혔다.

## Unit 종료 산출물

각 unit은 끝날 때 아래 네 줄을 남길 수 있어야 한다.

- 무엇을 잠갔는지 (`Lock`)
- 실제로 건드린 touchpoint
- 안 건드린 위험 구역 (`Do not`)
- 어떤 체크로 acceptance를 확인했는지

이 네 줄이 안 나오면, 그 unit은 아직 handoff 가능한 상태가 아니다.

## PR / Handoff 최소 형식

각 unit은 아래 형식으로 요약할 수 있어야 한다. 이 형식이 안 나오면 scope가 아직 덜 잠긴 것이다.

### PR title shape

- `E1-U2: add single compiled-summary producer in main search path`
- `E2-U3: lock compiled-aware retrieval input contract`
- `E3-U7: document no-copy calibrator decision rule`

제목은 `unit id + 한 문장 lock`만 담고, 다음 unit의 unlock까지 끌어오지 않는다.

### Handoff output template

- `Unit:` `<unit id>`
- `Status:` `완료`
- `상태변경시각:` `YYYY-MM-DD HH:mm KST`
- `Worker:` `<worker id>`
- `Lock:` 무엇을 잠갔는지 한 문장
- `Touched:` 실제로 건드린 primary touchpoint
- `Avoided:` 안 건드린 위험 구역
- `Checked:` acceptance를 확인한 최소 체크
- `Next:` `Primary unlocks` 중 실제로 바로 집어들 다음 1개
- 필요한 경우 `Secondary unlocks:`는 참고용으로만 남기고, 바로 착수 대상은 아니다

### Commit output template

- `done: <unit id>`
- `lock: <핵심 판단>`
- `checks: <테스트/grep/문서 교차검토>`
- `next: <unlock 1개>`

## 첫 착수 Quickstart

처음 붙는 LLM은 아래 3개 unit만 순서대로 본다.

### Quickstart A: `E1-U1`

- 먼저 읽을 것:
  - `src/domain/query/service/execution-compiler.ts`
  - `src/domain/query/model/compiled-wine-query.ts`
  - `src/domain/query/model/engine-execution-contract.ts`
- 바로 확인할 것:
  - route / mode / budget / provenance-policy가 이미 어디까지 표현되는지
  - summary shape가 둘 이상인지
- 이번 unit에서 끝낼 것:
  - summary vocabulary 하나 고정
- 넘길 다음 unit:
  - `E1-U2`

### Quickstart B: `E1-U2`

- 먼저 읽을 것:
  - `src/application/search/search.usecase.ts`
  - `src/application/search/search-usecase-pre-route-phase.ts`
- 바로 확인할 것:
  - planner 직후 어디서 compiled summary를 붙이는 게 가장 blast radius가 작은지
  - 이후 경로에서 재생성하는 지점이 있는지
- 이번 unit에서 끝낼 것:
  - main search path의 single producer 고정
- 넘길 다음 unit:
  - `E1-U5`

### Quickstart C: `E1-U5`

- 먼저 읽을 것:
  - `src/application/search/search-usecase-route-resolution.ts`
  - `src/application/search/search.usecase.ts`
- 바로 확인할 것:
  - `plan.route / retrievalMode` 직접참조가 몇 군데 남는지
  - compiled-first, V1 fallback 구조로 helper를 바꾸면 어디까지 영향이 가는지
- 이번 unit에서 끝낼 것:
  - route helper authoritative source 교체
- 넘길 다음 unit:
  - `E1-U6`

## 금지 신호

아래 신호가 보이면 unit을 멈추고 다시 split하는 쪽을 우선한다.

- 파일 4개 이상을 같이 열어야 한다
- 새 타입/새 helper/새 adapter/새 wiring을 한 unit에서 동시에 만들게 된다
- 테스트가 unit test가 아니라 usecase 전체 회귀로만 설명된다
- `Do not`에 적힌 걸 건드려야 acceptance가 성립할 것처럼 보인다
- 다음 unit의 `Primary unlocks` 내용까지 이번 unit에서 같이 끝내고 싶어진다

## 리뷰어용 빠른 판정

리뷰어는 unit 카드 하나를 보고 아래 셋만 먼저 본다.

1. `Acceptance`가 결과를 판정하는가, 아니면 바람만 적었는가
2. `Checks`가 실제 파일/테스트/grep까지 내려왔는가
3. `Finish gate`가 다음 unit 침범을 막는가

셋 중 하나라도 아니면, 구현 시작 전에 문서를 먼저 다시 깎는다.

---

## Epic 1 Cards

근거 축: `appendix-h`의 planner/runtime currency, route resolution, snapshot/eval provenance seam.

### Epic 1 critical review notes

- `E1-U3`는 제일 쉽게 커지는 unit이다. 여기서 response/snapshot/eval까지 같이 건드리기 시작하면 바로 split 실패다.
- `E1-U7`은 테스트 앵커가 약한 편이다. 새 debug formatter를 만들지 말고, existing post-route debug surface naming만 맞추는 선에서 멈춘다.
- `E1-U9`는 구현 unit이 아니라 guard rail이다. 이걸 feature work처럼 잡으면 안 된다.

### Epic 1 흔한 실패 예시

- `E1-U1`에서 planner DTO까지 같이 다시 정의한다:
  runtime-carried summary seam를 잠그는 대신 planner migration을 먼저 열어 blast radius가 커진다.
- `E1-U2`에서 route helper까지 같이 손댄다:
  producer lock unit과 compiled-first route semantics unit이 섞여 acceptance가 흐려진다.
- `E1-U6`에서 snapshot mapping을 핑계로 snapshot ID schema를 갈아엎는다:
  enrichment unit이 reproducibility schema redesign으로 커진다.
- `E1-U8`에서 eval export와 debug export를 다시 한 곳에 합친다:
  runtime debug vocabulary와 eval schema drift를 한 번에 만들 가능성이 커진다.

### `E1-U1` Shared Compiled Payload Seam

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/query/service/execution-compiler.ts`, `src/domain/query/model/compiled-wine-query.ts`, `src/domain/query/model/engine-execution-contract.ts`
- **Lock:** route / mode / budget / provenance-policy를 담는 runtime-carried summary shape를 하나로 고정한다.
- **Do:** summary field set, producer/consumer 명칭, ownership을 문서와 코드에서 같은 단어로 맞춘다.
- **Do not:** `QueryPlannerPort` 반환형을 바꾸거나 planner 전용 DTO를 하나 더 만들지 않는다.
- **Start gate:** planner migration 없이 runtime-carried summary seam만 잠글 수 있을 때 시작한다.
- **Acceptance:** search / hybrid / interpret가 참조할 summary vocabulary가 하나뿐이다.
- **Checks:** `src/domain/query/service/__tests__/execution-compiler.test.ts`에서 route/mode/budget/provenance-policy summary field naming을 확인하고, 중복 summary shape 정의가 없는지 `rg "compiled.*summary|execution summary"`로 확인한다.
- **Finish gate:** summary vocabulary만 잠겼고 producer wiring이나 entrypoint 적용까지 넘어가지 않았으면 끝이다.
- **Primary unlocks:** `E1-U2`, `E1-U4`

### `E1-U2` Search Entry Bridge

- **Tag / Work type:** `promote`, `wiring`
- **Primary touchpoints:** `src/application/search/search.usecase.ts`, `src/application/search/search-usecase-pre-route-phase.ts`
- **Lock:** main search path에서 planner 결과 옆에 compiled summary를 만드는 유일한 producer 위치를 고정한다.
- **Do:** planner 직후 bridge를 만들고, 이후 경로에서 재생성하지 않게 carrier object를 정의한다.
- **Do not:** route resolution, snapshot, response를 이 unit에서 같이 건드리지 않는다.
- **Start gate:** `E1-U1` vocabulary가 잠겨 있고, summary field naming을 더 만들 필요가 없을 때만 시작한다.
- **Acceptance:** search path는 `plan + compiled summary`를 함께 들고 시작한다.
- **Checks:** `test/unit/application/search/search-usecase-pre-route-phase.test.ts`, `test/unit/application/search/search-usecase-execute-phases.test.ts` 기준으로 single producer를 확인한다.
- **Finish gate:** compiled summary를 search path에서 다시 만드는 지점이 추가로 없고, 다음 unit이 route helper만 보면 되면 끝이다.
- **Primary unlocks:** `E1-U3`, `E1-U5`, `E1-U9`

### `E1-U3` Search Shared Context Propagation

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-post-route-phase.ts`, `src/application/search/search-usecase-decision-input.ts`
- **Lock:** downstream shared helper가 compiled summary를 재계산 없이 전달받는 경로를 고정한다.
- **Do:** post-route와 decision-input assembly가 같은 carrier를 읽게 정리한다.
- **Do not:** summary field 자체를 다시 설계하지 않는다.
- **Start gate:** `E1-U2`에서 search entry producer가 하나로 정리되어 있어야 한다.
- **Acceptance:** post-route / decision-input에서 summary 재생성 로직이 없다.
- **Checks:** `test/unit/application/search/search-usecase-decision-input.test.ts`, `test/unit/application/search/search-usecase-post-route-phase.test.ts` 기준으로 carrier propagation만 확인한다.
- **Finish gate:** 다음 unit이 route helper만 보거나 snapshot only mapping만 봐도 되면 끝이다.
- **Primary unlocks:** `E1-T1 closure`

### `E1-U4` Hybrid/Interpret Bridge

- **Tag / Work type:** `promote`, `wiring`
- **Primary touchpoints:** `src/application/search/hybrid.usecase.ts`, `src/application/search/interpret.usecase.ts`
- **Lock:** hybrid / interpret entrypoint도 main search와 같은 compiled summary seam를 재사용한다.
- **Do:** entrypoint별 bridge는 만들되 field set은 `E1-U1`에서 고정한 걸 그대로 쓴다.
- **Do not:** hybrid/interpret 전용 summary shape를 만들지 않는다.
- **Start gate:** `E1-U1` summary vocabulary가 잠겨 있고 main search path producer와 별개 entrypoint 적용만 남았을 때 시작한다.
- **Acceptance:** 세 entrypoint가 하나의 summary vocabulary만 쓴다.
- **Checks:** `test/unit/application/search/hybrid.usecase.test.ts`, `test/unit/application/search/interpret.usecase.test.ts`에서 summary field naming drift만 확인한다.
- **Finish gate:** hybrid/interpret entrypoint 적용만 끝났고 route/snapshot/eval semantics까지 끌고 가지 않았으면 끝이다.
- **Primary unlocks:** `E1-T1 closure`

### `E1-U5` Compiled-First Route Helper

- **Tag / Work type:** `thin_adapter`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-route-resolution.ts`, `src/application/search/search.usecase.ts`
- **Lock:** route resolution helper는 compiled summary를 authoritative source로 보고, `QueryPlanV1`은 fallback only로 둔다.
- **Do:** helper input을 compiled-aware로 바꾸고 기존 `plan.route / retrievalMode` 참조는 fallback branch로만 남긴다.
- **Do not:** route dispatch semantics 자체를 재설계하지 않는다.
- **Start gate:** `E1-U2`에서 compiled summary producer가 하나로 정리돼 있어야 한다.
- **Acceptance:** `plan.route` 직접참조는 fallback 의미로만 남고, compiled-first semantics가 문서화된다.
- **Checks:** `test/unit/application/search/search-usecase-route-resolution.test.ts`, `test/unit/application/search/search-usecase-core-helpers.test.ts` 기준으로 compiled-first와 fallback path를 분리 검증한다.
- **Finish gate:** 다음 unit이 snapshot/debug/eval 셋 중 하나만 골라 붙어도 될 정도로 helper semantics가 잠기면 끝이다.
- **Primary unlocks:** `E1-U6`, `E1-U7`, `E1-U8`
- **Secondary unlocks:** `E2-U1`

### `E1-U6` Snapshot Field Mapping

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-decision-snapshot.ts`
- **Lock:** compiled summary의 route / mode / budget / provenance-policy가 snapshot vocabulary에 어떻게 투영되는지 고정한다.
- **Do:** field mapping과 snapshot ID 영향 범위를 명시하고 nondeterminism note 기준을 그대로 유지한다.
- **Do not:** snapshot ID schema 전체를 다시 설계하지 않는다.
- **Start gate:** `E1-U5`가 닫혀서 compiled-first route/mode vocabulary가 고정돼 있어야 한다.
- **Acceptance:** snapshot enrichment 범위가 코드와 문서에서 같은 명칭으로 설명된다.
- **Checks:** `src/application/search/__tests__/search-usecase-decision-snapshot.test.ts`에서 route/mode/budget/provenance-policy mapping naming과 snapshot enrichment field scope를 확인한다.
- **Finish gate:** snapshot mapping만 잠겼고 debug/eval export naming까지 같이 손대지 않았으면 끝이다.
- **Primary unlocks:** `E4-U1`

### `E1-U7` Debug Export Mapping

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-post-route-phase.ts`, `src/application/search/search.usecase.ts`
- **Lock:** runtime debug surface는 compiled summary vocabulary를 그대로 쓴다.
- **Do:** debug refs, trace/meta export에서 plan-only naming을 summary naming으로 맞춘다.
- **Do not:** eval export까지 이 unit에 같이 넣지 않는다.
- **Start gate:** `E1-U5`가 닫혀서 compiled-first route naming이 고정돼 있어야 한다.
- **Acceptance:** debug surface가 compiled summary vocabulary와 같은 축을 쓴다.
- **Checks:** `test/unit/application/search/search-usecase-post-route-phase.test.ts`, `src/application/search/__tests__/search-usecase-post-route-phase.test.ts`를 먼저 보고, 부족한 부분만 `rg "pipelineDebug|debugRefs|plannerSuggestedMode|retrievalModeSource"`로 확인한다.
- **Finish gate:** debug export naming만 정리됐고 eval/schema까지 손대지 않았으면 끝이다.
- **Primary unlocks:** `E4-U6`

### `E1-U8` Eval Export Mapping

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-eval-provenance.ts`, `src/infrastructure/adapter/search-pipeline-evaluator.ts`
- **Lock:** eval export가 compiled summary와 같은 route/mode vocabulary를 사용한다.
- **Do:** runtime export field와 eval slice field naming을 하나로 맞춘다.
- **Do not:** eval stack을 새로 만들거나 runtime-only debug field를 그대로 eval schema에 누적하지 않는다.
- **Start gate:** `E1-U5` helper semantics가 잠겨 있고 debug export와 분리된 eval field mapping만 남았을 때 시작한다.
- **Acceptance:** eval 쪽 vocabulary drift 없이 compiled summary naming을 따른다.
- **Checks:** `test/unit/application/search/search-usecase-eval-provenance.test.ts`, `src/infrastructure/adapter/__tests__/search-pipeline-evaluator.test.ts`에서 runtime export -> eval field naming과 compiled summary vocabulary alignment를 확인한다.
- **Finish gate:** eval export naming만 닫혔고 promotion/calibration semantics로는 아직 넘어가지 않았으면 끝이다.
- **Primary unlocks:** `E5-U1`

### `E1-U9` V1 Compatibility Rule

- **Tag / Work type:** `thin_adapter`, `doc_guard`
- **Primary touchpoints:** `src/domain/query/model/query-plan.ts`, `docs/plans/apr-7-v0.4/01-epic-task-backlog.md`, `docs/plans/apr-7-v0.4/02-execution-unit-cards.md`
- **Lock:** `QueryPlanV1`은 compatibility-only surface라고 못 박고 field freeze를 건다.
- **Do:** backlog, unit cards, code comments가 같은 메시지를 내게 맞춘다.
- **Do not:** V1 phaseout 계획을 이 unit에서 구현하지 않는다.
- **Start gate:** `E1-U2`가 닫혀서 dual-currency bridge가 실제 문서 기준으로도 존재할 때 시작한다.
- **Acceptance:** 문서 어디를 읽어도 `QueryPlanV1`이 확장 대상처럼 읽히지 않는다.
- **Checks:** `rg "QueryPlanV1"`로 확장 암시 문구를 보고, `src/domain/query/model/query-plan.ts`, `01-epic-task-backlog.md`, `02-execution-unit-cards.md` wording만 교차 점검한다.
- **Finish gate:** field-freeze rule만 잠겼고 planner contract migration roadmap까지는 아직 안 열었으면 끝이다.
- **Primary unlocks:** `E1-T4 closure`

---

## Epic 2 Cards

근거 축: `appendix-h`의 retrieval service seam, mixed solver seam.

### Epic 2 critical review notes

- `E2-U2`와 `E2-U3`를 한 번에 처리하면 거의 항상 retrieval DTO stack을 새로 열게 된다. 둘은 꼭 분리한다.
- `E2-U4`는 wiring unit이지 policy redesign unit이 아니다. `search-usecase-hybrid-candidates.ts`를 크게 재설계하려고 들면 과하다.
- `E2-U6`은 compare/substitute를 묶는 순간 새 engine을 열고 싶은 유혹이 크다. mixed solver / compare retriever reuse boundary를 먼저 본다.

### Epic 2 흔한 실패 예시

- `E2-U1`에서 곧바로 budget 숫자 튜닝을 시작한다:
  inventory unit이 policy tuning unit으로 커지면서 나중에 table skeleton이 다시 흔들린다.
- `E2-U3`에서 retrieval input contract 대신 새 DTO를 만든다:
  compiled-aware 확장이 아니라 parallel retrieval stack이 생긴다.
- `E2-U4`에서 specialized path까지 한 번에 연결한다:
  main hybrid wiring unit이 browse/compare family redesign까지 먹으면서 split 실패가 난다.
- `E2-U6`에서 compare/substitute helper를 공통화한다며 새 engine shell을 만든다:
  reuse boundary를 정리하는 대신 중복 stack을 한 겹 더 쌓게 된다.

### `E2-U1` Lane Capability Inventory

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/retrieval/service/retrieval-profile.ts`, `src/domain/retrieval/service/channel-mix-policy.ts`
- **Lock:** 현재 자산에서 lane capability, budget, route semantics 입력을 분리 추출한다.
- **Do:** existing profile/policy가 이미 들고 있는 decision inputs를 inventory 형태로 정리한다.
- **Do not:** 이 단계에서 숫자 튜닝이나 새 retriever 도입을 하지 않는다.
- **Start gate:** `E1-U5`가 닫혀서 upstream route/mode semantics가 retrieval input으로 내려올 vocabulary가 잠겨 있어야 한다.
- **Acceptance:** lane policy table이 받아야 할 입력이 빠짐없이 정리된다.
- **Checks:** `src/domain/retrieval/service/__tests__/retrieval-profile.test.ts`, `src/domain/retrieval/service/channel-mix-policy.ts`를 기준으로 inventory 대상 input vocabulary만 확인한다.
- **Finish gate:** inventory만 잠겼고 policy table output 설계나 retrieval input wiring으로는 아직 안 넘어갔으면 끝이다.
- **Primary unlocks:** `E2-U2`

### `E2-U2` Lane Policy Table Skeleton

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/retrieval/service/retrieval-profile.ts`, `src/domain/retrieval/service/channel-mix-policy.ts`, `src/domain/retrieval/service/candidate-pool.ts`
- **Lock:** policy table의 최소 컬럼과 output을 고정한다.
- **Do:** lane capability, budget, protected recall, specialized path hint를 한 decision output으로 묶는다.
- **Do not:** `candidate-pool.ts` 옆에 parallel policy engine을 만들지 않는다.
- **Start gate:** `E2-U1` inventory가 잠겨 있어야 한다.
- **Acceptance:** retrieval 설명이 `policy table -> retrieval input -> assembly`로 읽힌다.
- **Checks:** `src/domain/retrieval/service/__tests__/retrieval-profile.test.ts`와 `channel-mix-policy.ts` 호출부를 기준으로 output vocabulary를 맞춘다.
- **Finish gate:** 다음 unit이 retrieval input contract만 보면 policy table을 다시 고민하지 않아도 되면 끝이다.
- **Primary unlocks:** `E2-U3`

### `E2-U3` Compiled-Aware Retrieval Input Contract

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/retrieval/model/retrieval-input.ts`, `src/domain/query/model/engine-execution-contract.ts`
- **Lock:** `HybridRetrievalInput`은 compiled hint를 받되 second DTO stack은 만들지 않는다.
- **Do:** route hint, lane hint, budget hint, specialized path hint 중 retrieval input이 실제로 받아야 할 최소 집합을 고정한다.
- **Do not:** `QueryPlanV1` 전체를 대체하는 새 public input contract를 만들지 않는다.
- **Start gate:** `E2-U2` decision output vocabulary가 잠겨 있어야 한다.
- **Acceptance:** compiled hint field가 retrieval input contract에 명시된다.
- **Checks:** `test/integration/helpers/build-hybrid-retrieval-input.ts`와 `src/domain/retrieval/model/retrieval-input.ts`를 기준으로 input contract drift를 본다.
- **Finish gate:** 다음 unit이 wiring만 해도 되는 수준으로 input contract가 작게 고정되면 끝이다.
- **Primary unlocks:** `E2-U4`

### `E2-U4` Hybrid Candidate Builder Wiring

- **Tag / Work type:** `promote`, `wiring`
- **Primary touchpoints:** `src/application/search/search-usecase-hybrid-candidates.ts`, `src/application/search/search.usecase.ts`, `src/application/search/search-usecase-hybrid-ranking-pipeline.ts`
- **Lock:** compiled-aware retrieval input을 만드는 유일한 hybrid wiring 경로를 고정한다.
- **Do:** main search/hybrid ranking pipeline 모두 같은 input builder를 쓰게 정리한다.
- **Do not:** route별 별도 retrieval builder를 만들지 않는다.
- **Start gate:** `E2-U3` field set이 잠겨 있어야 한다.
- **Acceptance:** hybrid candidate builder는 compiled-aware retrieval input만 만든다.
- **Checks:** `test/unit/application/search/search-usecase-execute-phases.test.ts`, `test/unit/application/search/hybrid.usecase.test.ts`, `test/integration/helpers/build-hybrid-retrieval-input.ts`를 우선 본다.
- **Finish gate:** main hybrid path wiring만 끝났고 specialized path semantics는 아직 안 건드렸으면 끝이다.
- **Primary unlocks:** `E2-U5`, `E2-U6`, `E2-U7`
- **Secondary unlocks:** `E3-U1`

### `E2-U5` Browse/Region Specialized Mapping

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-hybrid-candidates.ts`, `src/domain/retrieval/service/browse-retriever.ts`, `src/domain/retrieval/service/retrieval-profile.ts`
- **Lock:** producer/region browse는 lane policy 하위 specialized path다.
- **Do:** browse seed 추출과 browse retriever fallback을 policy child path 관점으로 설명되게 바꾼다.
- **Do not:** browse 전용 engine이나 browse 전용 policy stack을 열지 않는다.
- **Start gate:** `E2-U4`가 닫혀서 hybrid builder wiring이 안정되어 있어야 한다.
- **Acceptance:** browse/region path가 ad hoc exception이 아니라 specialized child path로 읽힌다.
- **Checks:** `test/unit/domain/retrieval/browse-retriever.test.ts`, `test/unit/domain/retrieval/browse-diversity.test.ts`, `test/unit/application/search/hybrid.usecase.test.ts` 기준으로 wording drift를 본다.
- **Finish gate:** browse/region만 정리됐고 compare/substitute family를 안 건드렸으면 끝이다.
- **Primary unlocks:** `E2-T3 partial closure`

### `E2-U6` Compare/Relative/Substitute Mapping

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/domain/retrieval/service/compare-retriever.ts`, `src/application/search/search-usecase-mixed-route.ts`, `src/domain/mixed/service/mixed-solver.ts`
- **Lock:** compare / relative / substitute는 같은 specialized family 안에서 정리한다.
- **Do:** anchor-based compare와 mixed/substitute 흐름이 lane policy 하위 path로 읽히게 연결한다.
- **Do not:** compare engine, substitute engine, relative engine을 각각 새로 만들지 않는다.
- **Start gate:** `E2-U4`가 닫혀 있고, browse/region 정리가 끝났거나 최소한 분리돼 있어야 한다.
- **Acceptance:** compare/relative/substitute가 specialized route family로 설명된다.
- **Checks:** `test/unit/domain/retrieval/compare-retriever.test.ts`, `test/unit/application/search/search-usecase-mixed-route-map.test.ts`, `test/unit/application/search/decomposed-search.usecase.test.ts`, `src/application/search/decomposed-search.usecase.ts`를 기준으로 specialized family wording만 확인한다.
- **Finish gate:** specialized family mapping만 끝났고 새 engine/helper stack을 추가하지 않았으면 끝이다.
- **Primary unlocks:** `E2-T3 closure`

### `E2-U7` Assembly Reuse Lock

- **Tag / Work type:** `reuse`, `doc_guard`
- **Primary touchpoints:** `src/domain/retrieval/service/candidate-pool.ts`, `src/domain/retrieval/service/candidate-assembly.ts`, `src/domain/retrieval/service/evidence-accumulator.ts`
- **Lock:** assembly / protected recall / evidence accumulation은 route-independent reuse seam로 잠근다.
- **Do:** route별 재구현 금지 문구와 reuse 대상 자산을 명시한다.
- **Do not:** assembly 내부를 route별로 fork하지 않는다.
- **Start gate:** `E2-U4`가 닫혀서 compiled-aware retrieval wiring과 specialized path 분기가 이미 separate unit으로 잠겨 있어야 한다.
- **Acceptance:** 어떤 specialized path도 자체 assembly를 만들지 않는다.
- **Checks:** `src/domain/retrieval/service/__tests__/candidate-assembly.test.ts`, `src/domain/retrieval/service/__tests__/evidence-accumulator.test.ts`, `test/unit/domain/retrieval/candidate-pool-sparse-filters.test.ts`, `appendix-j` 태그를 같이 보고 reuse wording만 교차 검토한다.
- **Finish gate:** reuse 금지선만 잠겼고 assembly internals refactor나 specialized path tuning으로는 안 넘어갔으면 끝이다.
- **Primary unlocks:** `E2-T4 closure`

---

## Epic 3 Cards

근거 축: `appendix-h`의 ranking pipeline seam, ranked-route resolve seam.

### Epic 3 critical review notes

- `E3-U2`는 문서화 unit이지 refactor unit이 아니다. 여기서 `Ranker`를 바로 쪼개기 시작하면 unit이 바로 터진다.
- `E3-U4`는 ownership lock이다. 성능 개선 unit이 아니다. 두 LTR path를 동시에 살린 채 “나중에 정리”로 미루면 거의 반드시 중복이 남는다.
- `E3-U6`은 제일 위험하다. insertion point를 고정하는 순간 decision layer를 하나 더 만들고 싶은 유혹이 강하다. 반드시 `search-usecase-ranked-route-resolve.ts`와 `search-usecase-decision-input.ts` 사이 hook로만 본다.
- `E3-U7`은 코드 추가 unit이 아니라 금지선 unit이다. 작게 보여도 사실상 전체 ranking/decision blast radius를 잠그는 역할이다.
- `E3-U6`은 direct unit test 앵커가 약하다. 테스트가 약하다고 scope를 넓히지 말고, hook assumption만 확인하고 끝내야 한다.

### Epic 3 흔한 실패 예시

- `E3-U2`에서 `Ranker`를 새 class들로 바로 쪼갠다:
  responsibility map unit이 refactor unit으로 변해서 outer seam 고정 전에 blast radius가 커진다.
- `E3-U4`에서 LTR ownership lock 대신 두 경로 feature parity를 맞추려 든다:
  중복 소유권 문제가 계속 남고 다음 unit acceptance가 흐려진다.
- `E3-U5`에서 calibrator feature source를 정리하다 activation flag/store까지 추가한다:
  contract unit이 activation unit을 삼켜 순서가 무너진다.
- `E3-U6`에서 ranked-route resolve 옆에 별도 confidence coordinator를 만든다:
  insertion point를 잠그는 대신 parallel decision layer를 사실상 열게 된다.

### `E3-U1` Stage Boundary Declaration

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/ranking/service/ranking-stage-pipeline.ts`, `src/application/search/search-usecase-hybrid-ranking-pipeline.ts`
- **Lock:** `RankingStagePipeline`이 authoritative outer seam다.
- **Do:** stage별 responsibility와 in/out contract를 outer seam 기준으로 정리한다.
- **Do not:** 이 단계에서 `Ranker` 내부를 동시에 뜯지 않는다.
- **Start gate:** `E2-U4`가 닫혀서 retrieval input wiring이 안정되어 있어야 한다.
- **Acceptance:** ranking 설명이 pipeline 기준으로 먼저 읽히고 `Ranker`는 내부 구현으로 내려간다.
- **Checks:** `test/unit/ranking/ranking-stage-pipeline.test.ts`, `src/application/search/search-usecase-hybrid-ranking-pipeline.ts` 호출부를 기준으로 stage ownership이 `RankingStagePipeline` 경계에서 먼저 설명되고, `Ranker`는 outer seam 바깥의 내부 구현으로만 남는지 확인한다.
- **Finish gate:** 다음 unit이 `Ranker` 내부 책임만 보거나 calibrator feature source만 봐도 되는 수준이면 끝이다.
- **Primary unlocks:** `E3-U2`, `E3-U5`

### `E3-U2` Ranker Responsibility Map

- **Tag / Work type:** `thin_adapter`, `adapter`
- **Primary touchpoints:** `src/domain/ranking/service/ranker.ts`, `src/domain/ranking/service/ranking-stage-pipeline.ts`
- **Lock:** `Ranker` 내부 책임을 signal compute / gate / apply / runtime signal로 분리 표기한다.
- **Do:** extraction order를 고정하고 subsequent units가 어느 seam를 먹고 들어갈지 명시한다.
- **Do not:** 새로운 ranker class를 도입하지 않는다.
- **Start gate:** `E3-U1`에서 outer seam가 authoritative라고 잠겨 있어야 한다.
- **Acceptance:** 이후 unit이 `Ranker` 전체가 아니라 특정 책임만 건드릴 수 있다.
- **Checks:** `test/unit/ranking/ranker.test.ts`, `test/unit/ranking/ranking-stage-pipeline.test.ts` 기준으로 responsibility naming만 본다.
- **Finish gate:** gate/LTR/calibrator 각각이 어디를 먹고 들어갈지 선이 그어졌으면 끝이다. 실제 extraction 구현은 여기서 안 한다.
- **Primary unlocks:** `E3-U3`, `E3-U4`

### `E3-U3` Rerank Gate Contract

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/ranking/service/rerank-gate.ts`, `src/domain/ranking/service/ranker.ts`, `src/domain/ranking/service/ranking-stage-pipeline.ts`
- **Lock:** CE gate input과 decision summary를 별도 contract로 고정한다.
- **Do:** gate가 읽는 runtime signal과 내보내는 decision summary 필드를 분리한다.
- **Do not:** gate logic과 CE apply logic을 같은 unit에 묶지 않는다.
- **Start gate:** `E3-U2` responsibility map이 잠겨 있어야 한다.
- **Acceptance:** rerank gate는 독립된 contract로 설명되고 `Ranker`에 암묵적으로 숨어 있지 않다.
- **Checks:** `src/domain/ranking/__tests__/rerank-gate.test.ts`, `test/unit/ranking/ranker.test.ts` 기준으로 gate input/output vocabulary를 본다.
- **Finish gate:** 다음 unit이 calibrator insertion point만 보면 되고, CE apply는 아직 untouched면 끝이다.
- **Primary unlocks:** `E3-U6`

### `E3-U4` Single LTR Ownership

- **Tag / Work type:** `reuse`, `adapter`
- **Primary touchpoints:** `src/application/search/search-usecase-ltr-rerank.ts`, `src/domain/ranking/service/ranker.ts`, `src/domain/ranking/service/ltr-ranker.ts`
- **Lock:** LTR apply ownership은 하나만 남긴다.
- **Do:** 어느 경로가 authoritative owner인지 고정하고 다른 쪽은 thin adapter 또는 제거 후보로 분류한다.
- **Do not:** 두 경로를 동시에 살려두고 feature parity를 맞추려 하지 않는다.
- **Start gate:** `E3-U2`에서 LTR responsibility 위치가 분리돼 있어야 한다.
- **Acceptance:** LTR가 한 번만 적용된다고 설명 가능하다.
- **Checks:** `test/unit/application/search/search-usecase-ltr-rerank.test.ts`, `test/unit/ranking/ranker.test.ts` 기준으로 double-apply 위험만 본다.
- **Finish gate:** LTR owner가 하나로 고정됐고, 나머지는 thin adapter/remove candidate로 밀려났으면 끝이다.
- **Primary unlocks:** `E3-T3 closure`

### `E3-U5` Calibrator Feature Source Map

- **Tag / Work type:** `new_small_module`, `contract`
- **Primary touchpoints:** `src/domain/ranking/model/ranked-result.ts`, `src/domain/ranking/service/funnel-metrics.ts`, `src/domain/evaluation/service/utility-scorer.ts`
- **Lock:** future calibrator가 읽는 최소 feature source 집합을 고정한다.
- **Do:** ranked result, funnel metrics, utility signals 중 calibrator input에 들어갈 항목만 명시한다.
- **Do not:** calibrator model activation이나 storage를 이 unit에서 열지 않는다.
- **Start gate:** `E3-U1` outer seam가 닫혀 있어야 한다.
- **Acceptance:** calibrator feature source가 `Ranker` 내부 비공개 state에 의존하지 않는다.
- **Checks:** `src/domain/ranking/__tests__/funnel-metrics.test.ts`, `src/domain/evaluation/__tests__/utility-scorer.test.ts`, `src/domain/ranking/model/ranked-result.ts`를 기준으로 calibrator input이 ranked result / funnel metrics / utility signals에만 기대고 `Ranker` 내부 비공개 state나 새 feature builder surface를 끌어오지 않는지 확인한다.
- **Finish gate:** feature source 목록만 잠겼고 insertion/activation은 아직 untouched면 끝이다.
- **Primary unlocks:** `E3-U6`
- **Secondary unlocks:** `E5-U1`

### `E3-U6` Calibrator Insertion Point

- **Tag / Work type:** `new_small_module`, `insertion`
- **Primary touchpoints:** `src/application/search/search-usecase-ranked-route-resolve.ts`, `src/application/search/search-usecase-decision-input.ts`
- **Lock:** calibrator는 ranked-route -> decision path의 한 hook로만 들어간다.
- **Do:** insertion point를 하나로 고정하고 upstream/downstream contract를 명시한다.
- **Do not:** ranked-route resolve 옆에 별도 decision layer를 만들지 않는다.
- **Start gate:** `E3-U3` gate contract와 `E3-U5` feature source가 모두 잠겨 있어야 한다.
- **Acceptance:** calibrator insertion point를 한 문장으로 설명할 수 있다.
- **Checks:** `src/application/search/search-usecase-ranked-route-resolve.ts`, `test/unit/application/search/search-usecase-decision-input.test.ts`를 기준으로 insertion이 existing ranked-route -> decision path 안에만 남는지, 그리고 새 coordinator/service surface가 추가되지 않는지 확인한다.
- **Checks fallback:** direct test가 부족하면 `src/application/search/search-usecase-hybrid-route.ts`, `src/application/search/search-usecase-mixed-route.ts` 호출부까지만 보고, hook 외 별도 decision/confidence layer가 안 생겼는지만 확인하고 멈춘다.
- **Finish gate:** insertion point 하나만 정해졌고 activation/promotion path까지 넘어가지 않았으면 끝이다.
- **Primary unlocks:** `E3-U7`, `E5-U5`

### `E3-U7` Decision-Path No-Copy Rule

- **Tag / Work type:** `new_small_module`, `doc_guard`
- **Primary touchpoints:** `src/domain/decision/service/decision-engine.ts`, `docs/plans/apr-7-v0.4/01-epic-task-backlog.md`, `docs/plans/apr-7-v0.4/02-execution-unit-cards.md`
- **Lock:** calibrator는 existing decision path 안에만 들어오고 `decision-engine` 복제는 금지다.
- **Do:** no-copy rule을 task와 unit 양쪽에 명시한다.
- **Do not:** “작은 decision coordinator”라는 이름으로 사실상 parallel decision layer를 허용하지 않는다.
- **Start gate:** `E3-U6` insertion point가 하나로 정리돼 있어야 한다.
- **Acceptance:** 문서 어디를 봐도 calibrator가 decision-engine clone을 정당화하지 않는다.
- **Checks:** `rg "decision layer|parallel decision|decision-engine copy|confidence coordinator|decision coordinator"` 수준의 문구 drift를 점검하고, `decision-engine.ts`, `01-epic-task-backlog.md`, `02-execution-unit-cards.md`를 기준으로 existing ranked-route -> decision path 밖의 새 coordinator/service surface를 허용하지 않는지 교차 확인한다.
- **Finish gate:** 다음 epic이 response semantics를 붙일 때 이 규칙을 다시 해석할 필요가 없으면 끝이다.
- **Primary unlocks:** `E4-U6`, `E5-U5`

---

## Epic 4 Cards

근거 축: `appendix-h`의 external contract / response / transparency seam.

### Epic 4 critical review notes

- `E4-U1`은 의외로 중요하다. 이게 안 잠기면 `human-response-builder-v2`를 main contract처럼 읽고 바로 옆 stack을 열기 쉽다.
- `E4-U4`와 `E4-U5`는 policy unit이지 builder rewrite unit이 아니다. explanation-policy를 핑계로 response-builder를 뜯기 시작하면 과하다.
- `E4-U6`과 `E4-U7`은 가장 쉽게 섞인다. route/provenance와 clarification/counterfactual를 꼭 분리해서 본다.
- response 영역은 wording drift가 특히 위험하다. field를 늘리기보다 naming을 맞추는 쪽을 우선한다.
- `E4-U6` / `E4-U7`은 대부분 naming/alignment unit이다. “테스트가 약하니 새 field를 더 넣자”로 가면 scope가 바로 커진다.

### Epic 4 흔한 실패 예시

- `E4-U1`을 문서 unit으로만 보고 넘어간다:
  main runtime contract가 안 잠겨서 `human-response-builder-v2` 조기 승격 해석이 다시 살아난다.
- `E4-U4`에서 explanation-policy 대신 새 explain builder를 만든다:
  작은 policy module이 아니라 response stack 재구성으로 번진다.
- `E4-U5`에서 query-family obligation map에 copy text/format 템플릿까지 넣는다:
  policy unit이 presentation unit까지 먹어 acceptance가 흐려진다.
- `E4-U6`과 `E4-U7`을 한 번에 처리한다:
  route/provenance naming alignment와 clarification/counterfactual semantics가 섞여 다시 split해야 한다.

### `E4-U1` Main Response Contract Lock

- **Tag / Work type:** `reuse`, `doc_guard`
- **Primary touchpoints:** `src/domain/response/service/response-builder.ts`, `src/application/search/search-usecase-map-result-items.ts`
- **Lock:** 초기/중기 main runtime response surface는 `ResponseBuilder`다.
- **Do:** response assembly 중심이 어디인지 못 박고 V2 builder는 sidecar로 내려놓는다.
- **Do not:** public response contract을 여기서 갈아끼우지 않는다.
- **Start gate:** `E1-U6` snapshot vocabulary가 잠겨 있어야 한다.
- **Acceptance:** runtime response surface가 더 이상 `V1 vs V2`로 애매하지 않다.
- **Checks:** `test/unit/response/response-builder.test.ts`, `src/application/search/search-usecase-map-result-items.ts` 설명/naming을 같이 본다.
- **Finish gate:** 다음 unit이 V2 sidecar scope만 보면 되고, main runtime contract 논쟁이 더 없으면 끝이다.
- **Primary unlocks:** `E4-U2`, `E4-U3`, `E4-U4`
- **Secondary unlocks:** `E4-U6`

### `E4-U2` Machine V2 Sidecar Scope

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/domain/response/service/machine-response-builder-v2.ts`, `src/domain/response/model/result-item-v2.ts`
- **Lock:** machine V2는 sidecar / adapter surface다.
- **Do:** machine response V2가 어떤 consumer를 위한 보조 surface인지 범위를 명시한다.
- **Do not:** machine V2를 main route response로 직접 승격하지 않는다.
- **Start gate:** `E4-U1`이 닫혀 있어야 한다.
- **Acceptance:** machine V2 역할이 main runtime contract와 겹치지 않는다.
- **Checks:** `src/domain/response/__tests__/machine-response-builder-v2.test.ts`, `src/domain/response/service/machine-response-builder-v2.ts`를 기준으로 machine V2가 existing main route response surface ownership을 가져가지 않고 sidecar/adapter consumer에만 남는지 확인한다.
- **Finish gate:** machine V2 scope만 잠겼고 human V2나 explanation-policy까지 안 넘어갔으면 끝이다.
- **Primary unlocks:** `E4-U2 closure`

### `E4-U3` Human V2 Sidecar Scope

- **Tag / Work type:** `promote`, `adapter`
- **Primary touchpoints:** `src/domain/response/service/human-response-builder-v2.ts`, `src/application/search/interpret-explain-adapter-v2.ts`
- **Lock:** human V2는 human-oriented sidecar surface다.
- **Do:** human-facing explanation/formatting surface의 역할을 분명히 한다.
- **Do not:** human V2를 초기 main runtime contract처럼 읽히게 두지 않는다.
- **Start gate:** `E4-U1`이 닫혀 있어야 한다.
- **Acceptance:** human V2 조기 승격 해석이 문서와 코드 설명에서 사라진다.
- **Checks:** `src/domain/response/__tests__/human-response-builder-v2.test.ts`, `src/application/search/__tests__/interpret-explain-adapter-v2.test.ts`를 기준으로 human V2가 existing runtime response contract ownership을 가져가지 않고 human-oriented sidecar surface로만 남는지 확인한다.
- **Finish gate:** human V2가 sidecar로만 설명되고 main contract 논쟁이 끝나면 끝이다.
- **Primary unlocks:** `E4-U3 closure`

### `E4-U4` Explanation-Policy Responsibility Split

- **Tag / Work type:** `new_small_module`, `contract`
- **Primary touchpoints:** `src/domain/response/service/response-builder.ts`, `src/application/search/interpret-explain-adapter-v2.ts`, `src/domain/decision/service/evidence-gate.ts`
- **Lock:** explanation-policy가 맡을 책임과 builder/adaptor가 맡을 책임을 나눈다.
- **Do:** evidence minimum, suppress, fallback 경계만 작게 정의한다.
- **Do not:** 새 explanation builder stack을 열지 않는다.
- **Start gate:** `E4-U1`이 닫혀서 main runtime contract가 잠겨 있어야 한다.
- **Acceptance:** policy module 책임이 builder와 겹치지 않는다.
- **Checks:** `test/unit/response/response-builder.test.ts`, `src/application/search/__tests__/interpret-explain-adapter-v2.test.ts`, `test/unit/decision/evidence-gate.test.ts`를 기준으로 파라미터 폭발/책임 겹침만 점검한다.
- **Finish gate:** 다음 unit이 query-family obligation만 정의하면 될 정도로 역할 분리가 끝나면 끝이다.
- **Primary unlocks:** `E4-U5`

### `E4-U5` Query-Family Obligation Map

- **Tag / Work type:** `new_small_module`, `contract`
- **Primary touchpoints:** `src/domain/response/service/response-builder.ts`, `src/application/search/search-usecase-counterfactuals.ts`, `src/domain/decision/service/evidence-gate.ts`
- **Lock:** query family별 explanation obligation / suppression 기준을 고정한다.
- **Do:** exact / browse / compare / substitute / mixed family별 최소 설명 의무를 적는다.
- **Do not:** copywriting 수준의 설명 템플릿까지 이 unit에 넣지 않는다.
- **Start gate:** `E4-U4` 책임 분리가 잠겨 있어야 한다.
- **Acceptance:** query family만 보면 explanation obligation을 추론할 수 있다.
- **Checks:** `test/unit/response/response-builder.test.ts`, `src/application/search/search-usecase-counterfactuals.ts`, `src/domain/response/model/counterfactual.ts` naming과 obligation map이 충돌하지 않는지 본다.
- **Finish gate:** obligation map만 잠겼고 meta field alignment는 아직 안 건드렸으면 끝이다.
- **Primary unlocks:** `E4-U7`
- **Secondary unlocks:** `E6-U2`

### `E4-U6` Route/Provenance Metadata Alignment

- **Tag / Work type:** `thin_adapter`, `adapter`
- **Primary touchpoints:** `src/domain/response/service/response-builder.ts`, `src/application/search/specialized-route-observability.ts`, `src/domain/response/model/engine-decision.ts`
- **Lock:** route/provenance meta는 calibrated decision semantics와 같은 vocabulary 축을 쓴다.
- **Do:** route, plannerSuggestedMode, provenance/meta naming을 calibrated semantics와 충돌 없게 맞춘다.
- **Do not:** clarification/counterfactual까지 한 번에 건드리지 않는다.
- **Start gate:** `E4-U1`과 `E3-U7`이 닫혀 있어야 한다.
- **Acceptance:** route/provenance meta가 ad hoc field 묶음처럼 보이지 않는다.
- **Checks:** `test/unit/response/response-builder.test.ts`, `src/domain/response/model/engine-decision.ts`, `src/application/search/specialized-route-observability.ts`를 기준으로 alignment가 existing response-builder/observability surface 안에서만 이뤄지고 새 builder/formatter/route-meta transport layer가 추가되지 않는지 확인한다.
- **Finish gate:** route/provenance만 정렬됐고 clarification/counterfactual vocabulary는 아직 untouched면 끝이다.
- **Primary unlocks:** `E4-U7`

### `E4-U7` Clarification/Counterfactual Alignment

- **Tag / Work type:** `thin_adapter`, `adapter`
- **Primary touchpoints:** `src/domain/response/service/response-builder.ts`, `src/application/search/search-usecase-counterfactuals.ts`, `src/application/search/interpret-explain-adapter-v2.ts`
- **Lock:** clarification / counterfactual surface도 calibrated semantics vocabulary를 따른다.
- **Do:** abstain, clarify, counterfactual 관련 meta naming과 explanation path를 맞춘다.
- **Do not:** response format 자체를 다시 설계하지 않는다.
- **Start gate:** `E4-U5` obligation map과 `E4-U6` route/provenance meta가 둘 다 잠겨 있어야 한다.
- **Acceptance:** clarification/counterfactual semantics가 route/provenance/meta와 같은 축에서 읽힌다.
- **Checks:** `test/unit/response/response-builder.test.ts`, `src/application/search/search-usecase-counterfactuals.ts`, `src/application/search/__tests__/interpret-explain-adapter-v2.test.ts`를 기준으로 clarification/counterfactual alignment가 existing response/adaptor surfaces 안에만 머무르고 새 response format/builder layer를 열지 않는지 확인한다.
- **Finish gate:** response meta와 clarification/counterfactual vocabulary가 같은 축으로 읽히고, 새 builder/format은 안 열었으면 끝이다.
- **Primary unlocks:** `E4-T4 closure`

---

## Epic 5 Cards

근거 축: `appendix-h`의 eval provenance, learning ingest, lifecycle seam.

### Epic 5 critical review notes

- `E5-U1`과 `E5-U2`는 자주 섞인다. feature list를 잠그기 전에 wiring부터 건드리면 eval field drift가 다시 생긴다.
- `E5-U3`는 reuse lock이지 learning redesign unit이 아니다. proposal/feedback/threshold를 하나의 coordinator로 다시 묶으려 들면 과하다.
- `E5-U4`는 특히 위험하다. rollout governor를 정의하다가 kill-switch/store/write plane까지 끌어안으면 `new_small_module` 범위를 넘는다.
- `E5-U6` / `E5-U7`은 activation unit이지 model-quality 개선 unit이 아니다. shadow-first path를 정의하는 순간 threshold 튜닝까지 같이 하려 들면 unit이 커진다.
- `E5-U5`는 문서상 prerequisite lock이다. 여기서 calibrator를 켜는 얘기로 넘어가면 순서를 어긴다.

### Epic 5 흔한 실패 예시

- `E5-U1`에서 바로 evaluator schema를 바꾸기 시작한다:
  feature list가 안 잠겨서 나중에 field가 다시 흔들린다.
- `E5-U3`에서 proposal/feedback/threshold를 한 coordinator에 다시 묶는다:
  existing spine reuse가 아니라 learning stack 재발명으로 번진다.
- `E5-U4`에서 rollout governor가 threshold write나 kill-switch까지 직접 소유한다:
  작은 coordinator가 아니라 새 control plane이 된다.
- `E5-U6`에서 shadow path 정의 중에 promotion criterion까지 같이 넣는다:
  activation unit과 gate unit이 섞여 다시 split해야 한다.

### `E5-U1` Eval Feature Delta List

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/evaluation/service/eval-runner.ts`, `src/infrastructure/adapter/search-pipeline-evaluator.ts`, `src/application/search/search-usecase-eval-provenance.ts`
- **Lock:** eval slice에 들어갈 compiled / calibrated feature 목록을 고정한다.
- **Do:** route, mode, budget, calibration-related signals 중 eval이 실제로 받아야 할 최소 집합을 적는다.
- **Do not:** eval 전용 runtime output을 따로 만들지 않는다.
- **Start gate:** `E1-U8` eval export vocabulary와 `E3-U5` feature source map이 둘 다 잠겨 있어야 한다.
- **Acceptance:** eval이 새 runtime signal을 무엇으로 보는지 목록이 잠긴다.
- **Checks:** `src/domain/evaluation/service/eval-runner.ts`, `src/infrastructure/adapter/__tests__/search-pipeline-evaluator.test.ts`, `test/unit/application/search/search-usecase-eval-provenance.test.ts`에서 feature naming만 맞춘다.
- **Finish gate:** feature 목록만 잠겼고 아직 export wiring은 untouched면 끝이다.
- **Primary unlocks:** `E5-U2`

### `E5-U2` Eval Export Wiring Map

- **Tag / Work type:** `promote`, `wiring`
- **Primary touchpoints:** `src/application/search/search-usecase-eval-provenance.ts`, `src/infrastructure/adapter/search-pipeline-evaluator.ts`, `src/application/search/search-usecase-decision-snapshot.ts`
- **Lock:** runtime export -> eval field mapping을 고정한다.
- **Do:** 어떤 runtime export가 어떤 eval field로 들어가는지 mapping 표를 만든다.
- **Do not:** runtime debug용 필드를 eval schema에 무분별하게 복사하지 않는다.
- **Start gate:** `E5-U1` feature 목록이 잠겨 있어야 한다.
- **Acceptance:** eval export naming drift가 사라진다.
- **Checks:** `src/infrastructure/adapter/__tests__/search-pipeline-evaluator.test.ts`, `test/unit/application/search/search-usecase-eval-provenance.test.ts` 기준으로 runtime export -> eval field mapping만 본다.
- **Finish gate:** eval wiring만 닫혔고 promotion/activation semantics는 아직 untouched면 끝이다.
- **Primary unlocks:** `E5-U3`, `E5-U5`

### `E5-U3` Promotion Spine Reuse Contract

- **Tag / Work type:** `reuse`, `doc_guard`
- **Primary touchpoints:** `src/domain/learning/service/promotion-gate.ts`, `src/domain/learning/service/threshold-optimizer.ts`, `src/config/container-learning.ts`
- **Lock:** promotion / threshold / proposal / feedback는 existing spine를 reuse한다.
- **Do:** 어떤 store/optimizer/gate를 그대로 쓰는지 명시한다.
- **Do not:** new proposal store, new threshold store, new feedback persistence를 열지 않는다.
- **Start gate:** `E5-U2` eval wiring이 닫혀 있어야 한다.
- **Acceptance:** learning/promotion spine이 reuse-only라고 명확히 읽힌다.
- **Checks:** `src/config/container-learning.ts`, `src/domain/learning/service/promotion-gate.ts`, `src/domain/learning/service/threshold-optimizer.ts`, `appendix-j` 분류를 같이 보고 reuse-only wording만 점검한다.
- **Finish gate:** reuse 대상이 잠겼고 coordinator scope/activation path는 아직 안 건드렸으면 끝이다.
- **Primary unlocks:** `E5-U4`
- **Secondary unlocks:** `E5-U6`, `E5-U7`

### `E5-U4` Rollout-Governor Scope

- **Tag / Work type:** `new_small_module`, `contract`
- **Primary touchpoints:** `src/domain/evaluation/service/eval-runner.ts`, `src/domain/learning/service/promotion-gate.ts`, `src/config/runtime-handles.ts`
- **Lock:** rollout governance coordinator가 읽는 입력과 하지 말아야 할 일을 고정한다.
- **Do:** snapshot-aware / drift-aware orchestration만 맡기고 write plane 재발명은 막는다.
- **Do not:** threshold optimization, persistence, kill-switch를 coordinator가 직접 소유하게 하지 않는다.
- **Start gate:** `E5-U3` reuse spine가 잠겨 있어야 한다.
- **Acceptance:** coordinator는 orchestration만 하고 기존 stores/gates를 재사용한다.
- **Checks:** `src/domain/evaluation/service/eval-runner.ts`, `src/domain/learning/service/promotion-gate.ts`, `src/config/__tests__/runtime-handles.test.ts`를 기준으로 orchestration이 existing gates/stores 위에만 얹히는지, 그리고 새 write/persistence/kill-switch surface가 추가되지 않는지 확인한다.
- **Finish gate:** coordinator가 읽는 입력과 하지 말아야 할 일만 잠겼고, 직접 쓰기/저장/차단 권한은 안 가져갔으면 끝이다.
- **Primary unlocks:** `E5-U6`

### `E5-U5` Calibrator Activation Prerequisites

- **Tag / Work type:** `new_small_module`, `doc_guard`
- **Primary touchpoints:** `src/application/search/search-usecase-ranked-route-resolve.ts`, `src/domain/evaluation/service/calibration-evaluator.ts`, `src/domain/evaluation/service/utility-scorer.ts`
- **Lock:** calibrator activation은 feature contract, insertion point, eval enrichment, no-copy rule 이후에만 열린다.
- **Do:** activation prerequisite checklist를 명시한다.
- **Do not:** calibrator를 실험 flag만 있다고 바로 켜지게 두지 않는다.
- **Start gate:** `E5-U2`, `E3-U7`이 닫혀 있어야 한다.
- **Acceptance:** Epic 5 이전 activation path가 문서상으로도 열리지 않는다.
- **Checks:** `01-epic-task-backlog.md`, `src/application/search/search-usecase-ranked-route-resolve.ts`, `src/domain/evaluation/service/calibration-evaluator.ts`를 같이 보고 activation이 existing ranked-route/eval path 위의 prerequisite checklist로만 남는지, 그리고 별도 rollout/coordinator surface를 미리 열지 않는지 확인한다.
- **Finish gate:** prerequisite checklist만 잠겼고 shadow path 정의로는 아직 안 넘어갔으면 끝이다.
- **Primary unlocks:** `E5-U6`

### `E5-U6` Shadow-First Path Definition

- **Tag / Work type:** `new_small_module`, `activation`
- **Primary touchpoints:** `src/domain/evaluation/service/eval-runner.ts`, `src/infrastructure/adapter/search-pipeline-evaluator.ts`, `src/domain/learning/service/promotion-gate.ts`
- **Lock:** calibrator/lane/rerank 변화는 shadow-first path를 통해서만 관찰된다.
- **Do:** shadow path에서 어떤 slice와 gate를 보는지 정의한다.
- **Do not:** direct production cutover나 silent rollout을 허용하지 않는다.
- **Start gate:** `E5-U3`, `E5-U4`, `E5-U5`가 모두 닫혀 있어야 한다.
- **Acceptance:** acceptance path는 언제나 shadow run을 먼저 탄다.
- **Checks:** `src/domain/evaluation/service/eval-runner.ts`, `src/infrastructure/adapter/search-pipeline-evaluator.ts`, `src/domain/learning/service/promotion-gate.ts`를 기준으로 shadow path가 existing eval/gate 연결 위에서만 정의되는지, direct-cutover path나 별도 rollout write surface가 추가되지 않는지 확인한다.
- **Finish gate:** shadow path만 정의됐고 promotion criterion/threshold 자체는 아직 안 건드렸으면 끝이다.
- **Primary unlocks:** `E5-U7`
- **Secondary unlocks:** `E6-U1`

### `E5-U7` Promotion Acceptance Gate

- **Tag / Work type:** `new_small_module`, `activation`
- **Primary touchpoints:** `src/domain/learning/service/promotion-gate.ts`, `src/domain/learning/service/threshold-optimizer.ts`, `src/infrastructure/adapter/pg-threshold-store.ts`
- **Lock:** shadow 결과가 언제 production promotion을 열 수 있는지 gate 기준을 고정한다.
- **Do:** 최소 acceptance 기준과 threshold/promotion 연계를 적는다.
- **Do not:** acceptance를 human judgment only로 남기거나 gate 없는 rollout을 허용하지 않는다.
- **Start gate:** `E5-U6` shadow-first path가 먼저 잠겨 있어야 한다.
- **Acceptance:** shadow-first path가 실제 promotion criterion까지 이어진다.
- **Checks:** `src/domain/learning/service/promotion-gate.ts`, `src/domain/learning/service/threshold-optimizer.ts`, `src/infrastructure/adapter/pg-threshold-store.ts`를 기준으로 promotion 기준이 existing gate/threshold/store 위에만 얹히는지, 그리고 새 persistence path나 direct promotion surface가 추가되지 않는지 확인한다.
- **Finish gate:** promotion criterion만 잠겼고 session/quality policy input으로 넘어갈 수 있으면 끝이다.
- **Primary unlocks:** `E5-T4 closure`, `E6-U1`

---

## Epic 6 Cards

근거 축: `appendix-h`의 decomposition / evidence / grouped exploration / operational seam.

### Epic 6 critical review notes

- `E6-U1`은 session stack 구현 unit이 아니다. serving policy input으로 쓸 신호 최소 집합만 잠그고 끝내야 한다.
- `E6-U2`는 quality gate input contract unit이지 policy compiler unit이 아니다. 여기서 scoring policy까지 밀어 넣으면 과하다.
- `E6-U3` / `E6-U4`는 reuse map unit이다. decomposition/substitute 품질 개선 욕심으로 새 orchestrator를 열면 바로 실패다.
- `E6-U5`는 운영 경계 잠금 장치다. watchlist/runtime-handle을 재정비하는 순간 scope가 폭발한다.

### Epic 6 흔한 실패 예시

- `E6-U1`에서 reformulation detector를 손보다가 session persistence 설계로 넘어간다:
  signal scope unit이 session stack 구현으로 커진다.
- `E6-U2`에서 quality gate input을 정하다가 score threshold policy까지 넣는다:
  input contract unit이 policy compiler unit으로 변한다.
- `E6-U3`에서 decomposition adapter를 새 orchestrator로 바꾼다:
  reuse map이 아니라 parallel runtime을 여는 셈이 된다.
- `E6-U5`에서 runtime-handles를 정리한다며 lifecycle refactor를 시작한다:
  운영 경계 잠금 unit이 infra refactor로 폭발한다.

### `E6-U1` Session Signal Scope

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/query/service/reformulation-detector.ts`, `src/domain/query/model/session-context.ts`, `src/application/search/search-usecase-pre-route-phase.ts`
- **Lock:** serving policy input으로 승격할 최소 session/reformulation signal 집합을 고정한다.
- **Do:** reformulation type, prior context carry, ambiguity carry-forward 같은 high-value signals만 남긴다.
- **Do not:** full session stack redesign으로 번지지 않는다.
- **Start gate:** `E5-U7`이 닫혀서 rollout/activation semantics가 먼저 잠겨 있어야 한다.
- **Acceptance:** session signal이 planner-only metadata가 아니라 serving policy input으로 설명된다.
- **Checks:** `src/domain/query/service/reformulation-detector.ts`, `src/domain/query/model/session-context.ts`, `test/unit/application/search/search-usecase-pre-route-phase.test.ts`를 기준으로 signal scope naming만 맞춘다.
- **Finish gate:** 최소 signal set만 잠겼고 session persistence/UX policy까지 안 넘어갔으면 끝이다.
- **Primary unlocks:** `E6-U2`, `E6-U3`, `E6-U4`
- **Secondary unlocks:** `E6-U5`

### `E6-U2` Quality Gate Input Contract

- **Tag / Work type:** `promote`, `contract`
- **Primary touchpoints:** `src/domain/decision/service/evidence-gate.ts`, `src/application/search/search-usecase-decision-input.ts`, `src/application/search/search-usecase-post-route-phase.ts`
- **Lock:** evidence quality / metadata risk / rerank suppression이 quality-aware gate 입력으로 어떤 필드로 들어가는지 고정한다.
- **Do:** quality gate가 읽는 필드와 source를 명시한다.
- **Do not:** explanation policy와 quality gate를 한 모듈로 합치지 않는다.
- **Start gate:** `E6-U1` signal set과 `E4-U5` obligation map이 잠겨 있어야 한다.
- **Acceptance:** quality gate vocabulary가 잠기고 route/ranking/response와 충돌하지 않는다.
- **Checks:** `test/unit/decision/evidence-gate.test.ts`, `test/unit/application/search/search-usecase-decision-input.test.ts`, `test/unit/application/search/search-usecase-post-route-phase.test.ts` naming만 본다.
- **Finish gate:** input contract만 잠겼고 scoring/threshold policy로 번지지 않았으면 끝이다.
- **Primary unlocks:** `E6-T2 closure`

### `E6-U3` Decomposition Reuse Map

- **Tag / Work type:** `reuse`, `adapter`
- **Primary touchpoints:** `src/domain/query/service/decomposition-detector.ts`, `src/domain/query/model/query-decomposition.ts`, `src/application/search/decomposed-search-adapter.ts`
- **Lock:** decomposition은 new runtime이 아니라 existing seam reuse다.
- **Do:** decomposition detection, decomposition model, adapter seam를 reuse path로 설명되게 정리한다.
- **Do not:** decomposition 전용 orchestrator stack을 새로 만들지 않는다.
- **Start gate:** `E6-U1`이 닫혀 있어야 한다.
- **Acceptance:** decomposition branch가 parallel runtime처럼 읽히지 않는다.
- **Checks:** `src/domain/query/service/__tests__/decomposition-detector.test.ts`, `src/application/search/decomposed-search-adapter.ts`, `src/domain/query/service/decomposition-detector.ts`를 보고 reuse path wording만 맞춘다.
- **Finish gate:** decomposition reuse path만 정리됐고 substitute/grouped fallback은 아직 untouched면 끝이다.
- **Primary unlocks:** `E6-T3 partial closure`

### `E6-U4` Substitute/Grouped Fallback Reuse Map

- **Tag / Work type:** `reuse`, `adapter`
- **Primary touchpoints:** `src/domain/mixed/service/mixed-solver.ts`, `src/application/search/search-usecase-mixed-route.ts`, `src/domain/response/service/result-grouper.ts`
- **Lock:** substitute / grouped fallback은 새 stack이 아니라 existing seam reuse path다.
- **Do:** mixed solver, grouped result, fallback transparency를 하나의 reuse family로 정리한다.
- **Do not:** substitute engine이나 grouped-fallback engine을 새로 만들지 않는다.
- **Start gate:** `E6-U1`이 닫혀 있고 decomposition reuse와도 별도 unit으로 유지돼 있어야 한다.
- **Acceptance:** substitute/grouped fallback 경로가 reuse path로만 읽힌다.
- **Checks:** `test/unit/application/search/search-usecase-mixed-route-map.test.ts`, `src/domain/response/service/result-grouper.ts`, `src/application/search/search-usecase-mixed-route.ts` wording만 본다.
- **Finish gate:** substitute/grouped fallback reuse만 정리됐고 quality/session policy까지 안 넘어갔으면 끝이다.
- **Primary unlocks:** `E6-T3 closure`

### `E6-U5` Operational Seam Lock

- **Tag / Work type:** `reuse`, `doc_guard`
- **Primary touchpoints:** `src/domain/watchlist/service/watchlist-policy.ts`, `src/config/runtime-handles.ts`, `src/config/container-watchlist.ts`
- **Lock:** watchlist / side-effect / runtime-handle seam는 재사용만 허용한다.
- **Do:** operational seam를 핑계로 parallel runtime을 열지 못하게 금지선을 분명히 적는다.
- **Do not:** runtime-handle lifecycle, watchlist runtime, side-effect plane을 재설계하지 않는다.
- **Start gate:** `E6-U1`이 닫혀 있어야 한다.
- **Acceptance:** 운영성 seam는 reuse boundary로만 읽힌다.
- **Checks:** `src/__tests__/watchlist-policy.test.ts`, `src/__tests__/container-watchlist.test.ts`, `src/config/__tests__/runtime-handles.test.ts` 기준으로 reuse boundary wording만 본다.
- **Finish gate:** operational seam 금지선만 잠겼고 infra/runtime refactor로 넘어가지 않았으면 끝이다.
- **Primary unlocks:** `E6-T4 closure`
