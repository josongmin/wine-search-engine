# T-CLI-03 Typed Search And Entity Commands

## 목표

typed product command로 `search`, `entity resolve`, `entity autocomplete`, `wine-search`를 local/remote 공통 facade 위에 올린다.

이 티켓의 핵심은 `HTTP route 재사용`이 아니라 `application/container 포트 재사용`이다.

## 현재 근거

- search executor port가 이미 있다: [src/application/search/port/search-executor.port.ts](../../../src/application/search/port/search-executor.port.ts#L27-L35)
- resolve/autocomplete/hybrid 포트도 분리돼 있다: [src/application/search/port/search-route-usecases.port.ts](../../../src/application/search/port/search-route-usecases.port.ts#L87-L112)
- wine-search orchestrator는 container slice로 분리돼 있다: [src/config/container.ts](../../../src/config/container.ts#L97-L113)

## 선행 티켓

- [T-CLI-01](./T-CLI-01-command-kernel-and-runtime-targets.md)
- [T-CLI-02](./T-CLI-02-auth-and-profile-plane.md)

## 정확한 산출물

1. `wine search run`
2. `wine search hybrid`
3. `wine entity resolve`
4. `wine entity autocomplete`
5. `wine wine-search run`
6. local/remote facade parity tests

## 예상 추가 파일

```text
src/application/cli/port/search-facade.port.ts
src/application/cli/port/entity-facade.port.ts
src/application/cli/port/wine-search-facade.port.ts
src/application/cli/dto/search-*.ts
src/application/cli/command/search/*.ts
src/application/cli/command/entity/*.ts
src/application/cli/command/wine-search/*.ts

src/infrastructure/cli/local/local-search-facade.ts
src/infrastructure/cli/local/local-entity-facade.ts
src/infrastructure/cli/local/local-wine-search-facade.ts
src/infrastructure/cli/remote/remote-search-facade.ts
src/infrastructure/cli/remote/remote-entity-facade.ts
src/infrastructure/cli/remote/remote-wine-search-facade.ts
```

## 구현 범위

1. typed request DTO parsing
2. local facade adapter
3. remote facade adapter
4. human/json renderer shape
5. 최소한 한 개 local smoke path와 한 개 remote mocked path

## 구현 제외 범위

1. raw API call
2. auth/profile plane 자체 구현
3. route contract 변경

## local backing 규칙

### search run

- `SearchExecutorPort`

### search hybrid

- `HybridUseCasePort`

### entity resolve

- `ResolveUseCasePort`

### entity autocomplete

- `AutocompleteUseCasePort`

### wine-search run

- `WineSearchOrchestrator`

## remote backing 규칙

### search run

- `POST /v1/search`

### search hybrid

- `POST /v1/search/hybrid`

### entity resolve

- `POST /v1/entity/resolve`

### entity autocomplete

- `POST /v1/entity/autocomplete`

### wine-search run

- `POST /v1/wine-search`

## 인터페이스 초안

```ts
export interface SearchFacadePort {
  run(input: SearchRunInput): Promise<SearchRunResult>
  hybrid(input: SearchHybridInput): Promise<SearchHybridResult>
}

export interface EntityFacadePort {
  resolve(input: EntityResolveInput): Promise<EntityResolveResult>
  autocomplete(input: EntityAutocompleteInput): Promise<EntityAutocompleteResult>
}

export interface WineSearchFacadePort {
  run(input: WineSearchRunInput): Promise<WineSearchRunResult>
}
```

## DTO 원칙

1. leaf parser가 CLI flags를 typed DTO로 바꾼다
2. facade는 DTO만 받는다
3. local facade는 DTO -> usecase input mapping
4. remote facade는 DTO -> wire request mapping

## 수정 대상 파일

- `src/application/cli/**`
- `src/infrastructure/cli/local/**`
- `src/infrastructure/cli/remote/**`
- `src/interface/cli/**`
- `src/config/cli-container.ts`

## 수정 금지 범위

- search route business logic 변경
- route schema 변경
- renderer core redesign

## 구현 순서

1. search/entity/wine-search facade port 추가
2. local facade 구현
3. remote facade 구현
4. leaf command 추가
5. renderer에 필요한 typed projection 정리
6. local/remote parity test 추가

## 구현 체크포인트

### Checkpoint A

- `search run --target local`이 컨테이너 포트를 직접 탄다

### Checkpoint B

- `entity resolve --target remote`가 mocked HTTP를 통해 동작한다

### Checkpoint C

- command는 local/remote 분기를 직접 가지지 않는다

## 금지사항

1. typed command가 raw HTTP payload 문자열을 직접 조립하는 구조 금지
2. local mode에서 wire snake_case response를 다시 파싱하는 구조 금지
3. route handler import 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:unit:file -- <new-search-cli-tests>
pnpm exec tsx src/interface/cli/main.ts search run --target local --q "opus one 2018" --json
```

## DoD

1. 같은 CLI surface가 local/remote target에서 동작한다.
2. typed command는 application/container 포트를 직접 쓴다.
3. JSON output이 scripting-friendly contract를 가진다.
4. route handler 재사용 없이 command가 닫힌다.

## Closeout (2026-05-28) — done

구현:

- facade port를 실계약으로 확장: `SearchFacadePort.run/hybrid`, `EntityFacadePort.resolve/autocomplete`, `WineSearchFacadePort.run`
- typed DTO 추가: `search.dto.ts`, `entity.dto.ts`, `wine-search.dto.ts`
- leaf command 추가: `search run`, `search hybrid`, `entity resolve`, `entity autocomplete`, `wine-search run`
- local adapter: `local-search-facade.ts`, `local-entity-facade.ts`, `local-wine-search-facade.ts`
- remote adapter: `remote-search-facade.ts`, `remote-entity-facade.ts`, `remote-wine-search-facade.ts`
- local은 `createContainer()` 포트를 직접 호출하고 search/hybrid 결과만 `deepKeysToSnake()`로 wire parity를 맞춤
- wine-search result recase는 route handler 재사용 대신 `wine-search-response-mapper.ts`로 추출

검증:

- `pnpm run typecheck`
- `pnpm run test:unit:file -- src/interface/cli/__tests__/run-cli.test.ts src/infrastructure/cli/local/__tests__/local-search-facade.test.ts src/infrastructure/cli/remote/__tests__/remote-search-facade.test.ts`

남은 정책:

- local `search run` live smoke는 repo runtime/env 의존성이 커서 이번 closeout에서는 unit/entry smoke로 고정

## Verification rail (2026-05-28 post-cleanup)

- **Parity gate**: `src/infrastructure/cli/__tests__/local-remote-parity.test.ts` — 5 ops × (local domain via fake container → `deepKeysToSnake` projection; remote wire via fake fetch); asserts `localOut === expectedWire === remoteOut` for `search.run` (`POST /v1/search`), `search.hybrid` (`POST /v1/search/hybrid`), `entity.resolve` (`POST /v1/entity/resolve`), `entity.autocomplete` (`POST /v1/entity/autocomplete`), `wine-search.run` (`POST /v1/wine-search`).
- Local facade unit tests: `local-search-facade.test.ts`, `local-entity-facade.test.ts`, `local-wine-search-facade.test.ts` (wineSearch wiring absent → `CliError.execution`).
- Remote facade unit tests: `remote-search-facade.test.ts`, `remote-entity-facade.test.ts`, `remote-wine-search-facade.test.ts` (snake_case `options` body), `remote-http-client.test.ts` (auth header, baseUrl validation, JSON parse error path, abortSignal forwarding).
- `local-search-facade.ts`의 `deepKeysToSnake` interface→infra 의존성은 의도된 일방향 projection임을 import 위에 명시 (ADR §6.1).
