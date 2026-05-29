# T-IR-03 Agent Session Store And History Custody

## 목표

turnful agent surface에 필요한 session persistence, history custody, idempotency, concurrency policy를 구조적으로 닫는다.

## 현재 근거

- orchestrator input에는 session/history 개념이 없다: [src/application/wine-search/wine-search-orchestrator.ts](../../../../src/application/wine-search/wine-search-orchestrator.ts#L204-L243)
- current HTTP agent schema도 session/version/idempotency field가 없다: [src/interface/http/schemas/wine-search.schema.ts](../../../../src/interface/http/schemas/wine-search.schema.ts#L196-L243)

## 선행 티켓

- [T-IR-02](./T-IR-02-agent-run-and-turn-contract-split.md)

## 정확한 산출물

1. `AgentSessionStorePort`
2. session record model
   - `session_id`
   - `session_version`
   - `turn_index`
   - `client_turn_id`
   - `messages`
   - `history_applied`
   - `tool_trace_summary`
   - `expires_at`
3. create session / append turn service
4. optimistic concurrency
5. idempotent turn append
6. unavailable store fail-closed policy

## 예상 수정 파일

```text
src/application/wine-search/port/agent-session-store.port.ts
src/application/wine-search/agent-session-service.ts
src/application/wine-search/wine-search-orchestrator.ts
src/application/wine-search/wine-search-schemas.ts

src/config/container.ts
src/config/container-adapters.ts
src/config/container-core-builders.ts

src/infrastructure/db/agent-session-store.ts
src/infrastructure/db/__tests__/agent-session-store.test.ts

test/integration/http/routes/wine-search.route.test.ts
test/e2e/wine-search-api.test.ts
test/e2e/user-journeys.test.ts
```

## 구현 범위

1. session persistence port와 adapter
2. session create/turn append orchestration service
3. idempotency key 처리
4. session version conflict 처리
5. applied history trace 반환

## 구현 제외 범위

1. CLI UX
2. primitive search route split
3. web client cutover

## 저장소 결정

1. production adapter는 persistent store를 사용한다.
2. test용 in-memory adapter는 허용한다.
3. store unavailable이면 success-like fallback 금지다.

## 구현 순서

1. session domain model과 port 정의
2. create/append service 작성
3. persistent adapter 작성
4. route layer와 orchestration 연결
5. version/idempotency tests 추가

## 금지사항

1. session endpoint가 in-memory only 구현으로 production까지 닫혔다고 주장하는 것 금지
2. `client_turn_id` 없이 append 하는 것 금지
3. version conflict를 last-write-wins로 묵살하는 것 금지
4. token budget 초과 시 hidden summarization으로 history를 임의 절단하는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/infrastructure/db/__tests__/agent-session-store.test.ts src/application/wine-search/__tests__/wine-search-orchestrator.test.ts
pnpm run test:integration:file -- test/integration/http/routes/wine-search.route.test.ts
pnpm exec vitest run test/e2e/user-journeys.test.ts test/e2e/wine-search-api.test.ts
```

## DoD

1. turnful session이 persistent session store를 사용한다.
2. `client_turn_id` idempotency와 `session_version` concurrency가 enforce된다.
3. applied history가 trace로 surfaced 된다.
4. store unavailable path가 fail-closed 한다.
