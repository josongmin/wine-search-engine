# T-CLI-02 Auth And Profile Plane

## 목표

CLI 공통 `auth`, `profile`, `doctor`, `exit code` plane을 만든다.

이 티켓은 remote target과 auth-backed local lane의 공통 기반이다. search/entity command보다 먼저 닫혀야 한다.

## 현재 근거

- Codex auth read/refresh 로직이 이미 있다: [src/infrastructure/ai/codex-chatgpt-auth.ts](../../../src/infrastructure/ai/codex-chatgpt-auth.ts#L101-L248)
- ChatGPT OAuth model catalog probe 로직이 있다: [src/infrastructure/ai/chatgpt-oauth-chat-llm.ts](../../../src/infrastructure/ai/chatgpt-oauth-chat-llm.ts#L424-L462)
- 현재는 script별로 auth failure 문구와 fallback 조건이 분산되어 있다.

## 선행 티켓

- [T-CLI-01](./T-CLI-01-command-kernel-and-runtime-targets.md)

## 정확한 산출물

1. `auth status/path/refresh/doctor/login/whoami` command
2. profile resolution contract
3. `flags > env > profile > defaults` precedence
4. stable exit code table
5. auth facade port
6. login delegation adapter 또는 명시적 unsupported contract

## 예상 추가 파일

```text
src/application/cli/port/auth-facade.port.ts
src/application/cli/port/profile-store.port.ts
src/application/cli/dto/auth-*.ts
src/application/cli/command/auth/*.ts

src/infrastructure/cli/auth/codex-auth-store.ts
src/infrastructure/cli/auth/codex-login-delegate.ts
src/infrastructure/cli/auth/chatgpt-model-catalog-probe.ts
src/infrastructure/cli/profile/env-profile-resolver.ts
```

## 구현 범위

1. auth facade/adapter
2. Codex login delegation adapter
3. profile store abstraction
4. auth doctor probe
5. exit code mapping 초안

## 구현 제외 범위

1. search/entity/wine-search command
2. generic raw API invoker
3. shell completion

## 인터페이스 초안

```ts
export interface AuthFacadePort {
  status(input: AuthStatusInput): Promise<AuthStatusResult>
  path(input: AuthPathInput): Promise<AuthPathResult>
  refresh(input: AuthRefreshInput): Promise<AuthRefreshResult>
  doctor(input: AuthDoctorInput): Promise<AuthDoctorResult>
  login(input: AuthLoginInput): Promise<AuthLoginResult>
  whoami(input: AuthWhoAmIInput): Promise<AuthWhoAmIResult>
}

export interface ProfileStorePort {
  resolve(input: ResolveProfileInput): Promise<ResolvedCliProfile>
}
```

## doctor 범위

`doctor`는 최소한 아래를 확인해야 한다.

1. auth file 경로
2. `auth_mode=chatgpt` 여부
3. `access_token` 존재 여부
4. `refresh_token` 존재 여부
5. refresh 가능 여부
6. `/codex/models` probe 가능 여부
7. 현재 profile에서 `target=remote`인 경우 base URL/auth mode 일관성

## profile 규칙

우선순위:

1. CLI flag
2. env
3. profile store
4. defaults

최소 지원값:

1. `target`
2. `baseUrl`
3. `timeoutMs`
4. `authMode`
5. `outputFormat`

## 수정 대상 파일

- `src/application/cli/**`
- `src/infrastructure/cli/auth/**`
- `src/infrastructure/cli/profile/**`
- `src/interface/cli/**`
- `src/config/cli-container.ts`

## 수정 금지 범위

- repo가 OAuth owner가 되는 browser/device flow 구현
- runtime app auth policy 변경
- search/entity command 구현

## 구현 순서

1. `ResolvedCliProfile` 타입 추가
2. profile resolver 추가
3. auth facade port + local adapter 추가
4. `status/path/refresh` command 추가
5. `doctor` command 추가
6. `login/whoami` command 추가
7. exit code mapping 고정

## 구현 체크포인트

### Checkpoint A

- `auth status --json`이 deterministic output을 가진다

### Checkpoint B

- `doctor`가 file check와 model probe를 둘 다 한다

### Checkpoint C

- profile precedence 테스트가 있다

### Checkpoint D

- auth failure가 shell exit code로만 표현된다

## 금지사항

1. repo 전용 second token store 생성 금지
2. Codex-owned auth file destructive mutation 금지
3. command가 직접 `process.env`를 읽고 precedence를 계산하는 구조 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:unit:file -- <new-auth-cli-tests>
pnpm exec tsx src/interface/cli/main.ts auth status --json
pnpm exec tsx src/interface/cli/main.ts auth doctor --json
```

## DoD

1. auth status와 doctor가 deterministic output을 가진다.
2. login은 delegation 또는 명시적 unsupported contract를 가진다.
3. profile precedence가 코드와 문서에서 일치한다.
4. 다른 command가 auth/profile plane을 재구현하지 않아도 된다.

## Closeout (2026-05-28) — done

구현된 파일:

- DTO/포트(application): `dto/auth.dto.ts`, `port/auth-facade.port.ts`(6 메서드 봉인), `port/profile-store.port.ts`; `context/cli-profile.ts`에 `outputFormat` 추가
- auth 커맨드 6개(application): `command/auth/{status,path,refresh,doctor,login,whoami}.command.ts`
- auth infra(infrastructure/cli/auth): `codex-auth-ports.ts`(collaborator 포트 3개), `codex-auth-store.ts`, `chatgpt-model-catalog-probe.ts`, `codex-login-delegate.ts`, `codex-auth-facade.ts`, `decode-codex-identity.ts`(CLI 소유 JWT 디코더)
- profile(infrastructure/cli/profile): `env-profile-resolver.ts`(`flags>env>defaults`, `WINE_CLI_*` env 키)
- 공유 probe(infrastructure/ai): `codex-model-catalog.ts`(`/codex/models` read-only 헬스 프로브 SSoT)
- composition root: `config/cli-container.ts` 가 profile resolver + 실제 auth facade(타 facade는 stub 유지)로 갱신, target별 facade seam 유지
- registry: `interface/cli/command-registry.ts` 에 auth 6개 등록
- run-cli: `buildContext` 주입 seam 추가(테스트용 fake facade 주입 가능)
- 테스트: probe / profile-resolver / auth-facade / decode-identity / run-cli auth integration — CLI 단위 53 통과

검증: typecheck ✅, build ✅(dist 방출), lint(신규 파일) clean, 단위 53/53 ✅. 실 Codex 토큰으로 smoke: `auth status/path/whoami/login` exit 0, `auth doctor` healthy + live `/codex/models` probe(`1 models HTTP 200`) exit 0, `auth doctor --target remote`(base-url 없음) exit 5, unknown subcmd exit 2.

핵심 설계 결정:

1. **auth SSOT = Codex.** CLI는 consumer/delegator. `CodexAuthStoreAdapter`가 기존 `codex-chatgpt-auth.ts`(read/refresh/path)에 위임, 별도 token store 없음. `login`은 OAuth flow를 소유하지 않고 `codex login` 위임 contract(`delegated:false`)만 반환.
2. **doctor 비파괴.** `refresh_capable`는 refresh_token 존재만 확인하고 실제 refresh(토큰 회전)는 하지 않음. model probe는 access_token이 있을 때만 네트워크 호출.
3. **exit code:** doctor 비정상 → `EXIT_PROBE(5)`(커맨드가 `result.exitCode` 설정), refresh 실패 → facade가 `CliError.auth`(3) throw.
4. **profile precedence**: `EnvProfileResolver`가 `flags > env(WINE_CLI_*) > defaults`로 단일화. v1은 file store 없음(ADR §9 허용). `outputFormat`은 `--json/--output`이 default('human')일 때만 env 적용.

의도적 비범위/디viation:

- **SSoT path 공유 미완**: `/codex/models` 정식 home은 `codex-model-catalog.ts`지만, 기존 `chatgpt-oauth-chat-llm.ts`는 unrelated **pre-existing lint debt**(JSON.parse-as-T, magic 401/200 등 23건)를 안고 있어 staged 시 pre-commit(`lint-staged`→`lint:file:fix`)이 차단됨. 핫패스 debt를 이 티켓에서 건드리지 않기로 하고 LLM 파일의 private `MODELS_PATH` 사본은 그대로 둠(파일 next-refactor 때 마이그레이션, 코드 주석 명시). JWT decode도 같은 이유로 CLI 소유 `decode-codex-identity.ts`로 분리(기존 private helper 재사용 위해 debt 파일을 stage하지 않기 위함).

남은 리스크: 위 SSoT path 중복 1건(문서화됨, drift 위험 낮음). Wave 3(T-CLI-03/04) 착수 가능.

## Addendum (Wave 3 사전 확장)

T-CLI-03/T-CLI-04에서 remote target 인증을 위해 profile 평면을 확장:

- 전역 플래그 추가: `--auth-mode <codex|bearer|none>`, `--bearer-token <token>`
- env 키 추가: `WINE_CLI_BEARER_TOKEN` (이미 있던 `WINE_CLI_PROFILE/TARGET/BASE_URL/TIMEOUT_MS/AUTH_MODE/OUTPUT`에 합류)
- `ResolvedCliProfile.bearerToken?: string` 추가, `EnvProfileResolver`가 `flags > env > defaults` 동일 precedence로 해석
- remote HTTP 클라이언트는 `authMode === 'bearer'` 일 때만 `authorization: Bearer <token>` 헤더 송출, bearer-token 누락 시 `CliError.usage` (exit 2)
