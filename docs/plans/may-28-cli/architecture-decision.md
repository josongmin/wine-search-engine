# May 28 CLI Architecture Decision

## 1. 결정

CLI는 `thin shell + application command + facade port + local/remote adapter` 구조로 간다.

의존성 방향:

`interface/cli -> application/cli -> facade ports <- infrastructure/cli`

`config/cli-container.ts`는 composition root 역할만 한다.

---

## 2. 이유

현재 repo는 이미 composition root가 usecase port를 잘라서 노출한다.

- container는 search/resolve/autocomplete/hybrid/wine-search slice를 직접 제공한다: [src/config/container.ts](../../../src/config/container.ts#L68-L113)
- HTTP route도 같은 usecase port를 최소 경계로 쓴다: [src/interface/http/routes/route-deps.ts](../../../src/interface/http/routes/route-deps.ts#L17-L80)
- search executor contract는 이미 application port로 고정돼 있다: [src/application/search/port/search-executor.port.ts](../../../src/application/search/port/search-executor.port.ts#L27-L35)
- resolve/autocomplete/hybrid contract도 분리돼 있다: [src/application/search/port/search-route-usecases.port.ts](../../../src/application/search/port/search-route-usecases.port.ts#L87-L112)
- repo 레이어 규칙도 CLI entrypoint를 `src/interface/`에 두라고 가리킨다: [CLAUDE.md](../../../CLAUDE.md#L57-L63)

따라서 CLI가 route handler를 재사용할 이유가 없다. route 대신 usecase port를 직접 쓰는 것이 더 얇고 더 안정적이다.

---

## 3. 비결정

이번 결정이 의미하지 않는 것:

1. domain layer에 CLI 개념을 넣지 않는다.
2. HTTP route를 지우지 않는다.
3. repo가 OAuth owner가 되지 않는다.
4. 모든 기존 script를 즉시 CLI로 이관하지 않는다.

---

## 4. 계층

### 4.1 Interface

위치:

- `src/interface/cli/**`

책임:

1. argv 파싱
2. command path resolution
3. renderer 선택
4. error -> exit code 매핑
5. command 실행 진입점

금지:

1. 비즈니스 로직
2. 직접 fetch
3. 직접 fs/auth parsing
4. container 직접 생성 후 usecase 직접 호출

### 4.2 Application

위치:

- `src/application/cli/**`

책임:

1. command use-case orchestration
2. typed input validation 후 facade 호출
3. command result normalization
4. command-local warning/metric 결합

예상 핵심 타입:

```ts
export interface CliCommand<TArgs = ParsedLeafArgs> {
  readonly group: string
  readonly name: string
  run(ctx: CommandContext, args: TArgs): Promise<CommandResult>
}

export interface CommandContext {
  readonly target: CliTarget
  readonly profile: ResolvedCliProfile
  readonly requestId: string
  readonly timeoutMs: number | null
  readonly abortSignal: AbortSignal | undefined
  readonly renderer: OutputRenderer
  readonly facades: CliFacadeRegistry
}

export interface CommandResult {
  readonly data: unknown
  readonly warnings?: readonly string[]
  readonly metrics?: Record<string, unknown>
  readonly exitCode?: number
}
```

### 4.3 Infrastructure

위치:

- `src/infrastructure/cli/**`

책임:

1. local facade adapter
2. remote HTTP facade adapter
3. auth file / refresh / delegation adapter
4. profile store adapter
5. renderer helper

---

## 5. Command Lifecycle

하나의 leaf command는 아래 단계를 고정 순서로 따른다.

1. shell이 global args parse
2. shell이 command path parse
3. `cli-container`가 target/profile/facade 조립
4. command registry가 leaf command resolve
5. leaf parser가 command-local args parse
6. command가 facade 호출
7. renderer가 `CommandResult.data` 출력
8. shell이 exit code 반환

이 순서를 깨는 구현은 shell thinning 원칙을 위반한다.

---

## 6. Local vs Remote

### 6.1 Local Target

정의:

- `loadConfig()` + `createContainer()` 후 usecase port 직접 호출

장점:

1. type-safe
2. self-HTTP 없음
3. dev/diag/bench 친화적

금지:

1. Fastify bootstrap
2. localhost self-call
3. snake_case wire shape 왕복

### 6.2 Remote Target

정의:

- base URL로 HTTP route 호출

장점:

1. deployed behavior parity
2. staging/prod operator workflow 지원

리스크:

1. local typed DTO와 wire DTO drift
2. auth header/profile precedence 복잡성

대응:

1. remote adapter가 wire-specific parsing을 캡슐화
2. command는 local/remote 공통 typed result만 본다

---

## 7. Facade 모델

typed command와 raw command를 분리한다.

### 7.1 Typed facade

예상 포트:

```ts
export interface AuthFacadePort {
  status(input: AuthStatusInput): Promise<AuthStatusResult>
  doctor(input: AuthDoctorInput): Promise<AuthDoctorResult>
  refresh(input: AuthRefreshInput): Promise<AuthRefreshResult>
  login(input: AuthLoginInput): Promise<AuthLoginResult>
  path(input: AuthPathInput): Promise<AuthPathResult>
  whoami(input: AuthWhoAmIInput): Promise<AuthWhoAmIResult>
}

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

typed facade는 domain/application DTO를 사용한다.

### 7.2 Raw facade

```ts
export interface RawApiInvokerPort {
  call(input: RawApiCallInput): Promise<RawApiCallResult>
  openApi(): Promise<OpenApiDocumentResult>
}
```

raw facade는 method/path/body/header를 받아 wire result를 반환한다.

이 분리를 안 하면 `search run`과 `api call`이 같은 저수준 호출 모델에 묶여 command ergonomics가 망가진다.

---

## 8. Auth 결정

1. token SSOT는 Codex다
2. CLI는 token consumer/delegator다
3. `login`은 Codex CLI delegation으로 처리한다
4. repo 자체 OAuth owner가 되지 않는다

이유:

1. repo가 자체 OAuth flow를 들고 오면 Codex와 토큰 ownership이 갈라진다
2. refresh/write만으로도 현재 목적에는 충분하다
3. `~/.codex/auth.json`을 consumer가 재정의하면 split-brain이 난다

예상 adapter:

- `CodexAuthStoreAdapter`
- `CodexLoginDelegateAdapter`
- `ChatGptModelCatalogProbeAdapter`

---

## 9. Profile 결정

profile plane은 v1부터 추상화한다.

우선순위:

1. CLI flag
2. env
3. profile store
4. defaults

예상 타입:

```ts
export interface ResolvedCliProfile {
  readonly name: string
  readonly target: 'local' | 'remote'
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly authMode: 'codex' | 'bearer' | 'none'
}
```

초기 구현은 file store 없이 env + flags만 지원해도 되지만, command는 `ResolvedCliProfile`만 보게 해야 한다.

---

## 10. Output 결정

모든 command는 아래 둘을 지원해야 한다.

1. human-readable output
2. stable `--json` output
3. `table|yaml|raw`

renderer가 담당할 것:

1. table
2. json
3. yaml
4. raw text
5. raw API human status projection

command가 직접 `console.log()` shape를 결정하면 scripting contract를 유지할 수 없다.

예상 포트:

```ts
export interface OutputRenderer {
  render(result: CommandResult, format: OutputFormat): Promise<void>
}
```

---

## 11. Exit Code 결정

초기 표준:

1. `0` success
2. `2` usage/config/auth file invalid
3. `3` refresh/login failed
4. `4` remote/local execution failed
5. `5` probe/doctor failed

세부 확장은 가능하지만, 최소한 auth failure와 business failure는 분리한다.

이 표는 shell에만 있고 leaf command가 제멋대로 process exit를 호출하면 안 된다.

---

## 12. 루트 명령 트리

1. `wine auth ...`
2. `wine search ...`
3. `wine entity ...`
4. `wine wine-search ...`
5. `wine api ...`

추후:

1. `wine diag ...`
2. `wine eval ...`
3. `wine bench ...`

원칙:

1. group는 capability 단위
2. leaf는 실제 operator task 단위
3. `api`는 예외적 raw surface로 유지

---

## 13. Composition Root

`src/config/cli-container.ts`는 아래 역할만 수행한다.

1. global args -> resolved profile
2. resolved profile -> target adapter
3. target adapter -> facade registry
4. renderer 조립
5. command context 생성

하면 안 되는 것:

1. leaf command parsing
2. leaf command business logic
3. renderer 출력 직접 실행

---

## 14. 스켈레톤 제안

```text
src/interface/cli/
  main.ts
  command-registry.ts
  argv/
    parse-global-args.ts
    parse-command-path.ts
    parse-output-args.ts
  render/
    exit-code.ts
    render-command-result.ts

src/application/cli/
  command/
    auth/
    search/
    entity/
    wine-search/
    api/
  context/
    command-context.ts
  dto/
  port/
    auth-facade.port.ts
    search-facade.port.ts
    entity-facade.port.ts
    wine-search-facade.port.ts
    raw-api-invoker.port.ts
    output-renderer.port.ts
    profile-store.port.ts

src/infrastructure/cli/
  local/
    local-search-facade.ts
    local-entity-facade.ts
    local-wine-search-facade.ts
  remote/
    remote-search-facade.ts
    remote-entity-facade.ts
    remote-wine-search-facade.ts
    remote-raw-api-invoker.ts
  auth/
    codex-auth-store.ts
    codex-login-delegate.ts
    chatgpt-model-catalog-probe.ts
  profile/
    env-profile-resolver.ts
  render/
    human-renderer.ts
    json-renderer.ts
    yaml-renderer.ts

src/config/
  cli-container.ts
```

---

## 15. 금지사항

1. `scripts/wine.ts` 단일 파일 monolith
2. local mode에서 Fastify self-call
3. command 내부에서 `process.env`/`fetch`/`readFile` 직접 사용
4. route handler 재사용
5. typed command와 raw API command 혼합
6. renderer가 transport 호출
7. facade가 stdout 직접 출력

---

## 16. 테스트 전략

### Unit

1. argv parse
2. command registry resolution
3. facade adapter mocking
4. renderer snapshot
5. exit code mapping

### Integration-light

1. local target에서 container-backed facade 호출
2. remote target에서 mocked HTTP 호출

### Smoke

1. `auth status`
2. `search run --target local`
3. `api call GET /health`

---

## 17. Closeout 기준

1. root shell이 얇다
2. local/remote adapter 교체가 command 수정 없이 가능하다
3. auth/profile/output plane이 별도 책임으로 분리된다
4. search/entity/api call이 같은 kernel 위에서 동작한다
5. 새 작업자가 이 문서와 티켓만으로 파일 추가 위치와 검증 명령을 알 수 있다
