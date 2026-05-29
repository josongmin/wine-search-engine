# May 29 Interface Revamp RFC

> 목적: public surface를 `agent`, `search`, `lookup`의 세 계약으로 재정렬하고, agent의 `single-shot`과 `turnful` 차이를 `history context custody`로 명시한다. 이번 작업은 브레이킹 체인지를 허용한다.

## 1. 문제 정의

현재 surface는 사용 목적과 계약 책임이 섞여 있다.

1. `POST /v1/agent`는 실제로는 단발 실행 endpoint다.
   - 요청 스키마가 `query`와 timeout/budget만 받고 turn history 계약이 없다: [src/interface/http/schemas/wine-search.schema.ts](../../../src/interface/http/schemas/wine-search.schema.ts#L196-L243)
   - route도 단일 endpoint 하나만 등록한다: [src/interface/http/routes/wine-search.route.ts](../../../src/interface/http/routes/wine-search.route.ts#L59-L77)
2. `search`는 primitive retrieval API가 아니라 mode-driven monolith다.
   - `SearchRequestSchema`가 `retrieval_mode`를 받는다: [src/interface/http/schemas/search-request.schema.ts](../../../src/interface/http/schemas/search-request.schema.ts#L114-L139)
   - `SearchModeSchema` 값이 `auto | entity | hybrid | mixed`다: [src/interface/http/schemas/search-shared.schema.ts](../../../src/interface/http/schemas/search-shared.schema.ts#L27-L57)
3. primitive search surface에 agent-like 문맥 knob가 섞여 있다.
   - `SearchRequestSchema`는 `sessionContext`, `queryBudget` alias, `options.mode`, `retrieval_mode`를 동시에 품는다: [src/interface/http/schemas/search-request.schema.ts](../../../src/interface/http/schemas/search-request.schema.ts#L20-L119)
4. CLI도 같은 shape 문제를 복제한다.
   - `search run`이 `--mode`, `--retrieval-mode`, `--session-id`, `--previous-entity`를 받는다: [src/application/cli/command/search/run.command.ts](../../../src/application/cli/command/search/run.command.ts#L12-L230)
   - agent CLI는 아직 `wine-search run` 하나다: [src/application/cli/command/wine-search/run.command.ts](../../../src/application/cli/command/wine-search/run.command.ts#L12-L109)
   - registry도 `search run`, `wine-search run`만 등록한다: [src/interface/cli/command-registry.ts](../../../src/interface/cli/command-registry.ts#L40-L51)
5. 내부 tool taxonomy도 primitive 분해와 맞지 않는다.
   - active agent tool bundle이 `search_wines(mode=...)`에 의존한다: [src/application/wine-search/wine-agent-loop-tool-bundle.ts](../../../src/application/wine-search/wine-agent-loop-tool-bundle.ts#L88-L152)
   - tool executor도 같은 분해를 강제한다: [src/interface/claude-tools/tool-executor.ts](../../../src/interface/claude-tools/tool-executor.ts#L182-L214)

## 2. 목표

1. `search`는 끝까지 intent-free primitive retrieval surface만 제공한다.
2. `lookup`는 canonical wine resolution surface로 분리한다.
3. `agent`는 planning/tool orchestration/history usage만 담당한다.
4. `single-shot`과 `turnful`은 다른 planner가 아니라 같은 runtime의 다른 history custody 모드가 된다.
5. HTTP와 CLI는 같은 taxonomy를 쓴다.
6. `mode`, `retrieval_mode`, `sessionContext` 같은 혼합 제어면은 제거한다.
7. internal tool taxonomy도 external primitive taxonomy와 맞춘다.

## 3. 비목표

1. retrieval/ranking 알고리즘 자체를 이번 RFC에서 새로 설계하지 않는다.
2. backward compatibility alias를 길게 유지하지 않는다.
3. hidden summarization, heuristic history compression, heuristic routing을 추가하지 않는다.
4. eval 전체를 새 프레임워크로 교체하지 않는다.

## 4. 목표 public surface

### HTTP

- `POST /v1/agent/run`
- `POST /v1/agent/sessions`
- `POST /v1/agent/sessions/:sessionId/turns`
- `POST /v1/search/hybrid`
- `POST /v1/search/semantic`
- `POST /v1/search/lexical`
- `POST /v1/lookup/wine`

### CLI

- `agent run`
- `agent session start`
- `agent session turn`
- `search hybrid`
- `search semantic`
- `search lexical`
- `lookup wine`

## 5. 핵심 계약 원칙

### 5.1 Agent

- `agent run`은 caller-managed history다.
- `agent sessions/:id/turns`는 server-managed history다.
- 둘 다 동일한 orchestrator/toolchain을 사용한다.
- 차이는 planner가 아니라 history sourcing과 persistence다.

### 5.2 Search

- primitive는 path가 authority다.
- body에서 `mode`, `retrieval_mode`, `sessionContext`, `clarification`을 받지 않는다.
- query/history 해석은 하지 않는다.

### 5.3 Lookup

- `lookup`는 canonical wine entity resolution이다.
- discovery search의 얕은 alias가 아니다.
- ambiguous comparison query는 fail-closed 해야 한다.

## 6. 마이그레이션 원칙

1. 새 surface를 추가한 뒤 오래된 surface를 병행 유지하지 않는다.
2. alias route나 alias command로 숨겨진 이행기간을 만들지 않는다.
3. OpenAPI, CLI help, web client, eval fixture를 같은 cut에서 같이 옮긴다.
4. regression rail은 legacy 문자열 부재까지 검증한다.

## 7. 실행 wave

### Wave 1

- `T-IR-01` primitive search/lookup contract split
- `T-IR-02` agent run/turn contract split

### Wave 2

- `T-IR-03` agent session store and history custody

### Wave 3

- `T-IR-04` CLI taxonomy cutover
- `T-IR-05` agent runtime tool taxonomy realignment

### Wave 4

- `T-IR-06` client/openapi/eval/fixture cutover

### Wave 5

- `T-IR-07` legacy purge and proof rails

## 8. 티켓 목록

- [tickets/README.md](./tickets/README.md)
- [T-IR-01 Primitive Search And Lookup Contract Split](./tickets/T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02 Agent Run And Turn Contract Split](./tickets/T-IR-02-agent-run-and-turn-contract-split.md)
- [T-IR-03 Agent Session Store And History Custody](./tickets/T-IR-03-agent-session-store-and-history-custody.md)
- [T-IR-04 CLI Taxonomy Cutover](./tickets/T-IR-04-cli-taxonomy-cutover.md)
- [T-IR-05 Agent Runtime Tool Taxonomy Realignment](./tickets/T-IR-05-agent-runtime-tool-taxonomy-realignment.md)
- [T-IR-06 Client OpenAPI Eval And Fixture Cutover](./tickets/T-IR-06-client-openapi-eval-and-fixture-cutover.md)
- [T-IR-07 Legacy Purge And Proof Rails](./tickets/T-IR-07-legacy-purge-and-proof-rails.md)
