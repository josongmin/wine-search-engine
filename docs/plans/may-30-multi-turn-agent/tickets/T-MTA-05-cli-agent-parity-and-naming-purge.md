# T-MTA-05 CLI Agent Parity And Naming Purge

## 목표

이미 도입된 `agent` command tree를 실제 runtime parity까지 닫고, external naming residue를 `agent` 기준으로 정리한다.

## 현재 근거

- current CLI registry는 `agent run`, `agent session start`, `agent session turn`을 등록한다: [src/interface/cli/command-registry.ts](../../../../src/interface/cli/command-registry.ts)
- 하지만 facade와 DTO naming은 아직 `wine-search`다: [src/application/cli/port/wine-search-facade.port.ts](../../../../src/application/cli/port/wine-search-facade.port.ts), [src/application/cli/dto/wine-search.dto.ts](../../../../src/application/cli/dto/wine-search.dto.ts)
- local session commands는 아직 미구현이다: [src/infrastructure/cli/local/local-wine-search-facade.ts](../../../../src/infrastructure/cli/local/local-wine-search-facade.ts)

## 선행 티켓

- [T-MTA-01](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)
- [T-MTA-02](./T-MTA-02-session-domain-and-history-custody-service.md)
- [T-MTA-03](./T-MTA-03-persistent-session-store-and-container-wiring.md)

## 정확한 산출물

1. agent facade naming
   - `AgentFacadePort`
   - `agent.dto.ts`
2. local/remote parity
   - `run`
   - `session start`
   - `session turn`
3. CLI help/output examples 정리
4. `wine-search` external naming purge

## 예상 수정 파일

```text
src/application/cli/command/agent/agent-command-support.ts
src/application/cli/command/agent/run.command.ts
src/application/cli/command/agent/session-start.command.ts
src/application/cli/command/agent/session-turn.command.ts
src/application/cli/dto/wine-search.dto.ts
src/application/cli/dto/agent.dto.ts
src/application/cli/port/wine-search-facade.port.ts
src/application/cli/port/agent-facade.port.ts

src/infrastructure/cli/local/local-wine-search-facade.ts
src/infrastructure/cli/remote/remote-wine-search-facade.ts
src/infrastructure/cli/__tests__/local-remote-parity.test.ts
src/infrastructure/cli/local/__tests__/local-wine-search-facade.test.ts
src/infrastructure/cli/remote/__tests__/remote-wine-search-facade.test.ts
```

## 구현 범위

1. external naming 정리
2. local session wiring
3. local/remote parity rail 갱신
4. obsolete facade names 제거

## 구현 제외 범위

1. HTTP route contract 자체
2. provider-edge state seam

## 구조 규칙

1. command tree와 facade/DTO naming이 같아야 한다.
2. local CLI가 remote보다 더 낡은 adapter를 가지면 안 된다.
3. internal core 폴더명이 `wine-search`여도 external CLI naming은 `agent`로 맞춘다.

## 구현 순서

1. DTO/facade rename
2. local facade run/session parity 구현
3. registry/help/update
4. parity tests 정리

## 금지사항

1. `agent` command가 내부에서 `wine-search run` semantics를 재포장하는 것 금지
2. local session path를 permanent unsupported로 남기는 것 금지
3. external DTO/facade naming에 `wine-search`를 남기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/infrastructure/cli/__tests__/local-remote-parity.test.ts src/infrastructure/cli/local/__tests__/local-wine-search-facade.test.ts src/infrastructure/cli/remote/__tests__/remote-wine-search-facade.test.ts
```

## DoD

1. CLI surface와 DTO/facade naming이 모두 `agent` 기준으로 정렬된다.
2. local/remote 모두 `run/start/turn`을 지원한다.
3. unsupported local session placeholder가 제거된다.
