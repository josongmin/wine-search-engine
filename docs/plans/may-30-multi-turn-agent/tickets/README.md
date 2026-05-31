# May 30 Multi-Turn Agent Tickets

> 목적: `agent` 멀티턴을 `same runtime + different history custody` 원칙으로 구조적으로 닫는다. `search`와 `lookup`은 이번 계획의 의존 surface일 뿐, 멀티턴 ticket의 직접 목표가 아니다.

## 필수 읽기

1. [../../may-29-interface-revamp/rfc.md](../../may-29-interface-revamp/rfc.md)
2. [../../may-29-interface-revamp/architecture-decision.md](../../may-29-interface-revamp/architecture-decision.md)
3. [../../../../CLAUDE.md](../../../../CLAUDE.md)
4. [../../../../AGENTS.md](../../../../AGENTS.md)

## 상태 표

| Ticket | 주제 | 상태 | 선행 | 핵심 출력 |
|---|---|---|---|---|
| `T-MTA-01` | messages-native agent core | planned | 없음 | `messages[]`-native orchestrator + `history_applied` |
| `T-MTA-02` | session domain and custody service | planned | `T-MTA-01` | `AgentSessionService` |
| `T-MTA-03` | persistent session store | planned | `T-MTA-02` | real persistent store + container wiring |
| `T-MTA-04` | HTTP session surface cutover | planned | `T-MTA-01`, `T-MTA-02`, `T-MTA-03` | `/v1/agent/run`, `/v1/agent/sessions*`, legacy `/v1/agent` 제거 |
| `T-MTA-05` | CLI parity and naming purge | planned | `T-MTA-01`, `T-MTA-02`, `T-MTA-03` | `agent run/session *` parity, facade rename |
| `T-MTA-06` | session-scoped runtime state | planned | `T-MTA-01`, `T-MTA-02` | provider-edge state seam |
| `T-MTA-07` | proof rails and legacy ban | planned | `T-MTA-01`~`T-MTA-06` | openapi/client/test parity + banned surfaces |

## Wave

### Wave 1

- [T-MTA-01](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)
- [T-MTA-02](./T-MTA-02-session-domain-and-history-custody-service.md)

### Wave 2

- [T-MTA-03](./T-MTA-03-persistent-session-store-and-container-wiring.md)
- [T-MTA-04](./T-MTA-04-http-agent-session-surface-cutover.md)

### Wave 3

- [T-MTA-05](./T-MTA-05-cli-agent-parity-and-naming-purge.md)
- [T-MTA-06](./T-MTA-06-session-scoped-runtime-state-and-provider-edge-ownership.md)

### Wave 4

- [T-MTA-07](./T-MTA-07-proof-rails-openapi-and-legacy-ban.md)

## 병렬성 규칙

1. `T-MTA-01` 없이는 나머지가 전부 가짜 구현이 된다. 가장 먼저 닫는다.
2. `T-MTA-02`와 `T-MTA-03`은 순차다. service 없이 store부터 붙이면 route가 persistence detail을 직접 먹게 된다.
3. `T-MTA-04`와 `T-MTA-05`는 `T-MTA-03` 이후 병렬 가능하다.
4. `T-MTA-06`은 `T-MTA-01` 이후 별도 owner가 병렬로 진행 가능하다.
5. `T-MTA-07`은 마지막 closeout 전용이다.

## 공통 금지사항

1. `quanta`의 WS transport, kernel event log, low-level command protocol을 그대로 복제하는 것 금지
2. `/v1/agent`와 `/v1/agent/run` 이중 front door 유지 금지
3. route나 CLI facade가 마지막 user message만 뽑아 legacy `query`로 내리는 adapter를 canonical path에 남기는 것 금지
4. production 멀티턴을 process-local/in-memory store로 닫았다고 주장하는 것 금지
5. hidden history stitching, hidden truncation, hidden summarization 금지
6. provider-specific continuation state를 orchestrator core singleton에 두는 것 금지
7. `wine-search` external naming을 `agent` surface 위에 계속 남기는 것 금지

## 작업자 체크리스트

착수 전:

1. `single-shot`과 `turnful`이 같은 runtime이라는 원칙을 다시 확인
2. 자신이 만지는 layer가 `history custody`, `persistence`, `transport`, `CLI`, `proof rail` 중 어디 owner인지 고정
3. legacy `/v1/agent`와 `query` adapter 잔재를 먼저 grep

구현 중:

1. `history_applied`가 실제 planner input과 같은지 확인
2. `client_turn_id`와 `expected_session_version`이 route가 아니라 service/store에서 enforce되는지 확인
3. provider-specific state가 edge/session runtime에만 남는지 확인

완료 전:

1. local/remote CLI parity 확인
2. openapi/client parity 확인
3. banned legacy surface grep 확인

## 티켓 목록

- [T-MTA-01 Messages-Native Agent Core And History-Applied Trace](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)
- [T-MTA-02 Session Domain And History Custody Service](./T-MTA-02-session-domain-and-history-custody-service.md)
- [T-MTA-03 Persistent Session Store And Container Wiring](./T-MTA-03-persistent-session-store-and-container-wiring.md)
- [T-MTA-04 HTTP Agent Session Surface Cutover](./T-MTA-04-http-agent-session-surface-cutover.md)
- [T-MTA-05 CLI Agent Parity And Naming Purge](./T-MTA-05-cli-agent-parity-and-naming-purge.md)
- [T-MTA-06 Session-Scoped Runtime State And Provider-Edge Ownership](./T-MTA-06-session-scoped-runtime-state-and-provider-edge-ownership.md)
- [T-MTA-07 Proof Rails OpenAPI And Legacy Ban](./T-MTA-07-proof-rails-openapi-and-legacy-ban.md)
