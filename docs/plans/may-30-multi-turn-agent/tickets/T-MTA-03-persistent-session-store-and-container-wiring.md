# T-MTA-03 Persistent Session Store And Container Wiring

## 목표

process-local session store를 production owner에서 제거하고, persistent session store와 container wiring을 닫는다.

## 현재 근거

- current store 구현은 process-local in-memory다: [src/config/agent-session-store.ts](../../../../src/config/agent-session-store.ts)
- port는 이미 idempotency와 optimistic concurrency를 요구한다: [src/application/wine-search/port/agent-session-store.port.ts](../../../../src/application/wine-search/port/agent-session-store.port.ts)

## 선행 티켓

- [T-MTA-02](./T-MTA-02-session-domain-and-history-custody-service.md)

## 정확한 산출물

1. persistent `AgentSessionStorePort` adapter
2. TTL/expiry policy
3. `client_session_id` idempotent create
4. `client_turn_id` idempotent append
5. `expected_session_version` conflict handling
6. container wiring
7. process-local store의 test-only relegation

## 예상 수정 파일

```text
src/application/wine-search/port/agent-session-store.port.ts
src/config/agent-session-store.ts
src/config/container.ts
src/config/container-adapters.ts
src/config/container-core-builders.ts

src/infrastructure/db/agent-session-store.ts
src/infrastructure/db/__tests__/agent-session-store.test.ts

src/config/__tests__/container-agent-defense.test.ts
```

## 구현 범위

1. persistent adapter 구현
2. expiry/sweep 규칙
3. container에서 store 주입
4. store unavailable fail-closed policy

## 구현 제외 범위

1. HTTP route/response wiring
2. CLI UX
3. provider continuation state

## 저장소 결정

1. production 멀티턴은 persistent store가 없으면 disabled가 맞다.
2. process-local store는 unit/integration test seam으로만 허용한다.
3. persistent backend가 아직 미정이면, route를 성공처럼 열지 말고 unavailable로 fail-closed 한다.

## 구현 순서

1. adapter contract 고정
2. persistent adapter 작성
3. container wiring
4. process-local store 격하
5. idempotency/conflict/expiry rail 추가

## 금지사항

1. process-local store를 production closeout으로 간주하는 것 금지
2. version conflict를 last-write-wins로 삼키는 것 금지
3. store unavailable 시 in-memory fallback으로 성공시키는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/infrastructure/db/__tests__/agent-session-store.test.ts src/config/__tests__/container-agent-defense.test.ts
```

## DoD

1. production path에 persistent store owner가 존재한다.
2. create/append idempotency가 테스트로 증명된다.
3. version conflict와 expiry path가 fail-closed 한다.
4. process-local store는 test seam으로만 남는다.
