# T-MTA-02 Session Domain And History Custody Service

## 목표

turnful agent를 route-driven ad hoc 구현이 아니라 `AgentSessionService` 중심 구조로 재편하고, history custody를 service owner로 고정한다.

## 현재 근거

- session request schema는 이미 존재한다: [src/interface/http/schemas/agent.schema.ts](../../../../src/interface/http/schemas/agent.schema.ts)
- session store port도 이미 존재한다: [src/application/wine-search/port/agent-session-store.port.ts](../../../../src/application/wine-search/port/agent-session-store.port.ts)
- 하지만 session route/service owner는 아직 없다: [src/interface/http/routes/agent.route.ts](../../../../src/interface/http/routes/agent.route.ts)

## 선행 티켓

- [T-MTA-01](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)

## 정확한 산출물

1. `AgentSessionService`
2. service operations
   - `createSession`
   - `runTurn`
   - `getSession`
3. explicit history custody rules
   - `run` = caller-managed
   - `turn` = server-managed
4. persisted turn transcript rule
   - caller messages
   - synthesized assistant answer
   - same turn metadata
5. `history_applied` builder

## 예상 수정 파일

```text
src/application/wine-search/agent-session-service.ts
src/application/wine-search/port/agent-session-store.port.ts
src/application/wine-search/wine-search-orchestrator.ts
src/application/wine-search/wine-search-result-schemas.ts
src/application/wine-search/wine-search-schemas.ts

src/application/wine-search/__tests__/wine-search-orchestrator.test.ts
src/application/wine-search/__tests__/wine-agent-loop.test.ts
test/integration/http/routes/agent.route.test.ts
```

## 구현 범위

1. session domain flow 정의
2. history stitch owner를 service로 고정
3. assistant answer를 persisted transcript에 포함
4. idempotent replay가 같은 result를 돌려줄 수 있는 service contract 정리

## 구현 제외 범위

1. persistent store adapter 자체
2. HTTP route registration
3. CLI cutover

## 구조 규칙

1. route는 session logic owner가 아니다.
2. orchestrator는 persistence를 모른다.
3. service가 `history_applied`와 persisted transcript를 모두 결정한다.
4. user-only history 저장 금지다. assistant answer를 같이 남겨야 후속 turn이 실제 대화를 replay한다.

## 구현 순서

1. session domain model 정리
2. `AgentSessionService` 도입
3. history stitch/transcript append 규칙 구현
4. turn result와 store input 연결

## 금지사항

1. route handler가 직접 store + orchestrator를 둘 다 조립하는 것 금지
2. session turn 저장 시 assistant answer를 버리는 것 금지
3. turnful path만 별도 planner를 두는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/wine-search/__tests__/wine-search-orchestrator.test.ts src/application/wine-search/__tests__/wine-agent-loop.test.ts
```

## DoD

1. `AgentSessionService`가 history custody owner가 된다.
2. turnful session transcript가 user/assistant 대화를 모두 보존한다.
3. orchestrator는 persistence detail을 모르고 service만 호출된다.
