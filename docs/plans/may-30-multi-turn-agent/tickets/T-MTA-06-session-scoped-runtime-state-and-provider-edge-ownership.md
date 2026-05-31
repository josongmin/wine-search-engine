# T-MTA-06 Session-Scoped Runtime State And Provider-Edge Ownership

## 목표

provider-specific conversational state를 orchestrator core 밖으로 밀어내고, session-scoped runtime state seam을 만든다.

## 현재 근거

- current multi-turn 설계에는 session-owned execution state seam이 없다. session/history/store와 runtime/provider state가 아직 분리되지 않았다.
- `quanta` reference에서 유효했던 핵심은 provider-specific continuation state를 core가 아니라 session execution plane이 소유한다는 점이다. 이 ticket은 그 원칙만 가져오고, WS/kernel 전체를 복제하지 않는다.

## 선행 티켓

- [T-MTA-01](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)
- [T-MTA-02](./T-MTA-02-session-domain-and-history-custody-service.md)

## 정확한 산출물

1. `AgentRuntimeSessionState` 또는 동등한 seam
2. owner examples
   - provider continuation state
   - prompt cache / request fingerprint
   - per-session runtime trace context
3. orchestrator core와 provider state 분리
4. no-singleton rule for stateful provider data

## 예상 수정 파일

```text
src/application/wine-search/agent-session-service.ts
src/application/wine-search/wine-search-orchestrator.ts
src/application/wine-search/wine-search-schemas.ts

src/config/container.ts
src/config/container-adapters.ts

src/infrastructure/ai/
src/infrastructure/ai/__tests__/

test/integration/wine-search-anthropic-wire-contract.test.ts
```

## 구현 범위

1. session-scoped runtime state seam 정의
2. orchestrator/service가 이 seam을 optional dependency로 받게 정리
3. provider-specific state를 adapter edge로 한정
4. session 종료 시 state lifecycle 정리

## 구현 제외 범위

1. 현재 없는 provider feature를 억지로 구현하는 것
2. WS/session kernel 도입
3. broad transport abstraction 교체

## 구조 규칙

1. provider-specific continuation optimization은 core architecture가 아니다.
2. stateful provider data는 singleton adapter field에 두지 않는다.
3. 없는 feature를 위해 복잡한 substrate를 먼저 들이지 않는다. seam만 먼저 만든다.

## 구현 순서

1. runtime state seam 정의
2. service/container 주입점 추가
3. provider adapter edge 연결
4. lifecycle/cleanup tests

## 금지사항

1. orchestrator core가 provider-specific field를 직접 소유하는 것 금지
2. process-global mutable state로 continuation/cache를 들고 가는 것 금지
3. `quanta`의 전체 runtime substrate를 복붙하는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/wine-search-anthropic-wire-contract.test.ts
```

## DoD

1. session-scoped runtime state seam이 존재한다.
2. provider-specific conversational state가 core가 아니라 edge/session owner에만 남는다.
3. global singleton mutable state 경로가 제거되거나 금지된다.
