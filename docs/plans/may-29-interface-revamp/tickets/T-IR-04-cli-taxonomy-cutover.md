# T-IR-04 CLI Taxonomy Cutover

## 목표

CLI surface를 HTTP taxonomy와 1:1로 맞추고, mode-driven monolith command를 제거한다.

## 현재 근거

- registry는 `search run`, `wine-search run`만 production command로 등록한다: [src/interface/cli/command-registry.ts](../../../../src/interface/cli/command-registry.ts#L40-L51)
- `search run`이 `--mode`, `--retrieval-mode`, `--session-id`, `--previous-entity`를 받는다: [src/application/cli/command/search/run.command.ts](../../../../src/application/cli/command/search/run.command.ts#L12-L230)
- agent CLI는 아직 `wine-search run` 하나다: [src/application/cli/command/wine-search/run.command.ts](../../../../src/application/cli/command/wine-search/run.command.ts#L43-L109)
- remote search facade도 `/v1/search` monolith 하나만 친다: [src/infrastructure/cli/remote/remote-search-facade.ts](../../../../src/infrastructure/cli/remote/remote-search-facade.ts#L10-L43)

## 선행 티켓

- [T-IR-01](./T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02](./T-IR-02-agent-run-and-turn-contract-split.md)
- [T-IR-03](./T-IR-03-agent-session-store-and-history-custody.md)

## 정확한 산출물

1. `agent run`
2. `agent session start`
3. `agent session turn`
4. `search hybrid`
5. `search semantic`
6. `search lexical`
7. `lookup wine`
8. local/remote facade parity tests
9. `search run`, `wine-search run` 제거

## 예상 수정 파일

```text
src/interface/cli/command-registry.ts
src/interface/cli/render/render-help.ts

src/application/cli/command/agent/**
src/application/cli/command/search/**
src/application/cli/command/lookup/**
src/application/cli/dto/agent.dto.ts
src/application/cli/dto/search-*.dto.ts
src/application/cli/dto/lookup.dto.ts
src/application/cli/port/agent-facade.port.ts
src/application/cli/port/search-facade.port.ts
src/application/cli/port/lookup-facade.port.ts

src/infrastructure/cli/local/local-agent-facade.ts
src/infrastructure/cli/local/local-search-facade.ts
src/infrastructure/cli/local/local-lookup-facade.ts
src/infrastructure/cli/remote/remote-agent-facade.ts
src/infrastructure/cli/remote/remote-search-facade.ts
src/infrastructure/cli/remote/remote-lookup-facade.ts

src/interface/cli/__tests__/command-registry.test.ts
src/interface/cli/__tests__/run-cli.test.ts
src/interface/cli/__tests__/cli-smoke-rail.test.ts
src/infrastructure/cli/__tests__/local-remote-parity.test.ts
```

## 구현 범위

1. command registry 갱신
2. leaf command 분리
3. DTO/facade port 분리
4. local/remote adapter 갱신
5. help/output smoke 갱신

## 구현 제외 범위

1. web client
2. OpenAPI catalog
3. internal agent tool bundle 분해

## 구조 규칙

1. command name이 primitive 또는 agent mode를 직접 말해야 한다.
2. CLI flag가 hidden mode selector 역할을 하면 안 된다.
3. primitive search command는 history/session flag를 받지 않는다.
4. agent session command만 session 식별자를 다룬다.

## 구현 순서

1. new DTO와 facade port 설계
2. remote/local adapter 갱신
3. command 추가
4. help/registry/test 갱신
5. old command 제거

## 금지사항

1. `search hybrid --mode hybrid` 같은 중복 selector 유지 금지
2. `wine-search` group 유지 금지
3. primitive search command에 `--session-id` 유지 금지
4. remote adapter가 old monolith path를 치는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/interface/cli/__tests__/command-registry.test.ts src/interface/cli/__tests__/run-cli.test.ts src/interface/cli/__tests__/cli-smoke-rail.test.ts
pnpm exec vitest run src/infrastructure/cli/__tests__/local-remote-parity.test.ts src/infrastructure/cli/remote/__tests__/remote-search-facade.test.ts src/infrastructure/cli/remote/__tests__/remote-wine-search-facade.test.ts
pnpm exec vitest run test/e2e/cli-process.test.ts
```

## DoD

1. CLI taxonomy가 HTTP taxonomy와 1:1이다.
2. primitive search command는 mode/session/history knob가 없다.
3. `agent session` 명령군이 독립적으로 존재한다.
4. `search run`, `wine-search run`이 제거된다.
