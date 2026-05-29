# May 29 Interface Revamp Tickets

> 목적: [../rfc.md](../rfc.md)와 [../architecture-decision.md](../architecture-decision.md)을 실행 티켓으로 분해한다.

## 필수 읽기

1. [../rfc.md](../rfc.md)
2. [../architecture-decision.md](../architecture-decision.md)
3. [../../../../CLAUDE.md](../../../../CLAUDE.md)
4. [../../../../AGENTS.md](../../../../AGENTS.md)

## 상태 표

| Ticket | 주제 | 상태 | 선행 | 핵심 출력 |
|---|---|---|---|---|
| `T-IR-01` | primitive search/lookup contract split | planned | 없음 | `/v1/search/{hybrid,semantic,lexical}`, `/v1/lookup/wine` |
| `T-IR-02` | agent run/turn contract split | planned | 없음 | `/v1/agent/run`, `/v1/agent/sessions`, `/v1/agent/sessions/:id/turns` |
| `T-IR-03` | agent session store and history custody | planned | `T-IR-02` | session persistence, idempotency, versioning |
| `T-IR-04` | CLI taxonomy cutover | planned | `T-IR-01`, `T-IR-02`, `T-IR-03` | `agent`, `search`, `lookup` command tree |
| `T-IR-05` | agent runtime tool taxonomy realignment | planned | `T-IR-01`, `T-IR-02`, `T-IR-03` | 4 primitive tools only |
| `T-IR-06` | client/openapi/eval/fixture cutover | planned | `T-IR-01`, `T-IR-02`, `T-IR-03`, `T-IR-04`, `T-IR-05` | web, scripts, fixtures, docs parity |
| `T-IR-07` | legacy purge and proof rails | planned | `T-IR-01`, `T-IR-02`, `T-IR-03`, `T-IR-04`, `T-IR-05`, `T-IR-06` | banned-surface guards, final closeout |

## Wave

### Wave 1

- [T-IR-01](./T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02](./T-IR-02-agent-run-and-turn-contract-split.md)

### Wave 2

- [T-IR-03](./T-IR-03-agent-session-store-and-history-custody.md)

### Wave 3

- [T-IR-04](./T-IR-04-cli-taxonomy-cutover.md)
- [T-IR-05](./T-IR-05-agent-runtime-tool-taxonomy-realignment.md)

### Wave 4

- [T-IR-06](./T-IR-06-client-openapi-eval-and-fixture-cutover.md)

### Wave 5

- [T-IR-07](./T-IR-07-legacy-purge-and-proof-rails.md)

## 병렬성 규칙

1. `T-IR-01`과 `T-IR-02`는 병렬 가능하다.
2. `T-IR-03`은 `T-IR-02` 계약이 먼저 고정돼야 한다.
3. `T-IR-04`와 `T-IR-05`는 각각 병렬 가능하지만, 둘 다 `T-IR-01`~`T-IR-03` 위에서만 구현한다.
4. `T-IR-06`은 public contracts와 CLI/tool taxonomy가 닫힌 뒤 진행한다.
5. `T-IR-07`은 마지막 closeout 전용이다.

## 공통 금지사항

1. heuristic fallback 추가 금지
2. legacy route/command alias 유지 금지
3. `mode`와 `retrieval_mode` 동시 지원 금지
4. primitive search에 `sessionContext`나 hidden history stitching 추가 금지
5. hidden summarization으로 token budget 초과를 덮는 구현 금지
6. `search_wines(mode=...)` 류의 내부 우회 taxonomy 유지 금지
7. route handler 재사용으로 local CLI를 구현하는 구조 금지

## 작업자 체크리스트

착수 전:

1. 선행 티켓 상태 확인
2. 자신이 건드릴 surface의 canonical path와 DTO를 확인
3. legacy 삭제 범위가 겹치면 ownership을 먼저 조정

구현 중:

1. primitive selector가 path인지 확인
2. history custody가 `agent`에만 있는지 확인
3. local/remote/HTTP/tool surface 이름이 같은 taxonomy를 쓰는지 확인

완료 전:

1. 티켓 문서의 검증 명령 실행
2. banned surface grep 확인
3. OpenAPI, CLI help, fixtures, web client drift 여부 확인

## 작업 분배 가이드

### 작업자 A

- `T-IR-01`
- `T-IR-07`

### 작업자 B

- `T-IR-02`
- `T-IR-03`

### 작업자 C

- `T-IR-04`

### 작업자 D

- `T-IR-05`

### 작업자 E

- `T-IR-06`

## 티켓 목록

- [T-IR-01 Primitive Search And Lookup Contract Split](./T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02 Agent Run And Turn Contract Split](./T-IR-02-agent-run-and-turn-contract-split.md)
- [T-IR-03 Agent Session Store And History Custody](./T-IR-03-agent-session-store-and-history-custody.md)
- [T-IR-04 CLI Taxonomy Cutover](./T-IR-04-cli-taxonomy-cutover.md)
- [T-IR-05 Agent Runtime Tool Taxonomy Realignment](./T-IR-05-agent-runtime-tool-taxonomy-realignment.md)
- [T-IR-06 Client OpenAPI Eval And Fixture Cutover](./T-IR-06-client-openapi-eval-and-fixture-cutover.md)
- [T-IR-07 Legacy Purge And Proof Rails](./T-IR-07-legacy-purge-and-proof-rails.md)
