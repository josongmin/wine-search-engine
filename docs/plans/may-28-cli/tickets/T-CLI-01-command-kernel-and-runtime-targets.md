# T-CLI-01 Command Kernel And Runtime Targets

## 목표

CLI 전체가 공유할 `command kernel`, `registry`, `context`, `local/remote target abstraction`을 만든다.

이 티켓이 닫히기 전에는 다른 티켓이 자기 parser, 자기 renderer, 자기 target resolver를 만들면 안 된다.

## 현재 근거

- repo 레이어 규칙은 CLI entrypoint를 `src/interface/`에 두도록 가리킨다: [CLAUDE.md](../../../CLAUDE.md#L57-L63)
- container는 search/resolve/autocomplete/hybrid/wine-search 포트를 직접 노출한다: [src/config/container.ts](../../../src/config/container.ts#L68-L113)
- HTTP route도 동일 포트를 의존한다: [src/interface/http/routes/route-deps.ts](../../../src/interface/http/routes/route-deps.ts#L17-L80)

## 선행 티켓

- 없음

## 정확한 산출물

1. root CLI entrypoint
2. command registry
3. `CommandContext`, `CommandResult`, `CliCommand` contract
4. `local|remote` target resolver
5. facade registry seam
6. renderer invocation seam
7. shell-only exit contract

## 예상 추가 파일

```text
src/interface/cli/main.ts
src/interface/cli/command-registry.ts
src/interface/cli/argv/parse-global-args.ts
src/interface/cli/argv/parse-command-path.ts
src/interface/cli/render/render-command-result.ts
src/interface/cli/render/exit-code.ts

src/application/cli/context/command-context.ts
src/application/cli/context/command-result.ts
src/application/cli/command/cli-command.ts
src/application/cli/port/cli-facade-registry.port.ts

src/config/cli-container.ts
```

파일명은 달라질 수 있으나 역할은 유지해야 한다.

## 구현 범위

1. `src/interface/cli/**` shell skeleton
2. `src/application/cli/**` kernel DTO/port
3. `src/config/cli-container.ts` 또는 동등 composition root
4. local/remote facade resolution seam
5. shell이 leaf command를 찾아 실행하는 end-to-end 경로

## 구현 제외 범위

1. 실제 auth command 로직
2. 실제 search/entity command 로직
3. raw API HTTP 구현

이 티켓은 skeleton과 seam만 만든다.

## 인터페이스 초안

```ts
export interface CliCommand<TArgs = unknown> {
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
  readonly facades: CliFacadeRegistry
}

export interface CliFacadeRegistry {
  readonly auth: AuthFacadePort
  readonly search: SearchFacadePort
  readonly entity: EntityFacadePort
  readonly wineSearch: WineSearchFacadePort
  readonly rawApi: RawApiInvokerPort
}
```

`CliFacadeRegistry` 내부 포트가 아직 stub여도 된다. shape만 고정하면 된다.

## 실행 흐름

1. `main.ts`가 argv 수신
2. global args parse
3. command path parse
4. `cli-container`로 target/profile/context 조립
5. registry에서 leaf command resolve
6. leaf parser가 local args parse
7. command 실행
8. renderer 호출
9. shell이 exit code 반환

## 수정 대상 파일

- `src/interface/cli/**`
- `src/application/cli/**`
- `src/config/cli-container.ts`
- `package.json`

## 수정 금지 범위

- search business logic 변경
- HTTP route contract 변경
- auth provider surface 확장
- renderer 포맷 세부 구현

## 예상 충돌 파일

- `package.json`
- 이후 `T-CLI-02`가 추가할 auth command 등록 코드
- 이후 `T-CLI-03`/`04`가 추가할 facade registry 구현

## 구현 순서

1. `CliCommand`, `CommandContext`, `CommandResult` 타입 추가
2. global args / command path parser 추가
3. registry 추가
4. `cli-container` 추가
5. `main.ts`에서 빈/placeholder command 실행까지 연결
6. renderer seam과 exit code seam 추가
7. stub command 하나로 smoke 검증

## 구현 체크포인트

### Checkpoint A

- `main.ts`가 `--help`와 invalid command를 처리한다

### Checkpoint B

- registry가 leaf command를 resolve한다

### Checkpoint C

- `CommandContext` 생성이 shell 밖으로 빠진다

### Checkpoint D

- shell 외 `process.exit()` 없음

## 금지사항

1. route handler import 재사용 금지
2. local mode Fastify self-call 금지
3. entrypoint에서 business branching 직접 구현 금지
4. command가 `console.log()` 직접 호출 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:unit:file -- <new-cli-kernel-tests>
pnpm exec tsx src/interface/cli/main.ts --help
```

## DoD

1. command kernel이 모든 leaf command의 공통 실행 경로가 된다.
2. local/remote target이 command 수정 없이 교체 가능하다.
3. CLI entrypoint가 얇다.
4. 다른 티켓이 이 kernel 위에만 올라가도록 seam이 고정된다.

## Closeout (2026-05-28) — done

구현된 파일:

- 커널 타입: `src/application/cli/command/cli-command.ts`, `context/{command-context,command-result,cli-profile,global-args}.ts`, `command/{exit-code,cli-error}.ts`
- facade seam: `src/application/cli/port/cli-facade-registry.port.ts` + 5개 branded stub 포트(`auth/search/entity/wine-search/raw-api-invoker`) + `output-renderer.port.ts`
- composition root: `src/config/cli-container.ts` (`buildCommandContext` + target별 `buildStubFacadeRegistry` seam)
- shell: `src/interface/cli/main.ts`(thin), `run-cli.ts`(실행 경로), `command-registry.ts`, `io.ts`, `argv/{parse-global-args,parse-command-path}.ts`, `render/{render-command-result,render-help,exit-code}.ts`
- smoke 대상 hidden 커맨드: `src/application/cli/command/system/ping.command.ts`
- 테스트 25개: `src/interface/cli/__tests__/*.test.ts`

검증: `pnpm run typecheck` ✅, `pnpm run build` ✅(`dist/interface/cli/main.js` 방출, `tsconfig.build.json` files에 추가), CLI 유닛 25/25 ✅, smoke `--help`(exit 0)/`system ping --json`(exit 0)/unknown(exit 2) ✅. 금지패턴(route handler/fastify/fetch/fs/child_process/console/process.env/process.exit) grep clean.

Wave-1 의도적 단순화 (다음 티켓이 채움):

1. facade 포트 5개는 `__facade` brand만 가진 stub — T-CLI-02(auth)/T-CLI-03(search·entity·wine-search)/T-CLI-04(raw-api)가 실제 메서드로 봉인. `cli-container`의 `buildStubFacadeRegistry`도 그때 실제 local/remote 어댑터로 교체.
2. exit-code 상수는 `src/application/cli/command/exit-code.ts`(커널 SSoT)에 둠 — `CliError`(application)와 shell mapper(`interface/cli/render/exit-code.ts`)가 같은 상수를 참조. "exit 매핑은 shell" 원칙은 mapper 위치로 충족.
3. renderer는 human + json만 구현. table/yaml/raw는 현재 json으로 렌더 — T-CLI-04가 정식 renderer contract로 대체.
4. help 텍스트는 registry에서 생성하되 global option 목록은 hand-written — T-CLI-05가 drift gate와 함께 최종화. 현재 product 커맨드 미등록이라 트리는 "(none registered yet)".
5. `timeoutMs` 지정 시 `AbortSignal.timeout()`을 context에 연결 — 실제 소비는 facade 구현 시점.

남은 리스크: 없음(seam 격리됨). Wave 2(T-CLI-02) 착수 가능.
