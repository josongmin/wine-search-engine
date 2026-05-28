# T-CLI-04 Raw API Call And Output Contract

## 목표

typed product command와 별도로 `wine api call` 계층을 만들고, renderer/output contract를 고정한다.

이 티켓은 범용성 때문에 중요하지만, typed command를 잠식하면 안 된다.

## 현재 근거

- typed search command만으로는 신규/비정형 route debugging이 불가능하다.
- 반대로 raw API surface를 typed command와 섞으면 command contract가 무너진다.

## 선행 티켓

- [T-CLI-01](./T-CLI-01-command-kernel-and-runtime-targets.md)
- [T-CLI-02](./T-CLI-02-auth-and-profile-plane.md)

## 정확한 산출물

1. `wine api call`
2. method/path/header/body/file 입력 contract
3. renderer abstraction
4. `json|table|yaml|raw` output contract
5. HTTP error -> exit code mapping

## 예상 추가 파일

```text
src/application/cli/port/raw-api-invoker.port.ts
src/application/cli/dto/raw-api-*.ts
src/application/cli/command/api/*.ts

src/infrastructure/cli/remote/remote-raw-api-invoker.ts
src/infrastructure/cli/render/human-renderer.ts
src/infrastructure/cli/render/json-renderer.ts
src/infrastructure/cli/render/yaml-renderer.ts
```

## 구현 범위

1. raw invoker facade/adapter
2. header/body file parsing
3. stdout renderer
4. HTTP error -> exit code mapping

## 구현 제외 범위

1. typed search/entity command
2. OpenAPI schema generator 수정
3. local raw API in-process router emulation

## command 입력 규칙

예상 예시:

```bash
wine api call GET /health
wine api call POST /v1/search --body @req.json
wine api call POST /v1/entity/resolve --header x-debug-key=abc --json
```

지원해야 하는 입력:

1. method
2. path
3. inline body
4. `@file` body
5. repeatable header
6. optional query param

## 인터페이스 초안

```ts
export interface RawApiInvokerPort {
  call(input: RawApiCallInput): Promise<RawApiCallResult>
}

export interface RawApiCallResult {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
  readonly rawText?: string
}
```

## renderer 규칙

renderer는 최소한 아래를 공통 처리해야 한다.

1. 성공 body 출력
2. status line 출력
3. header optional 출력
4. `--json` deterministic output
5. `--raw`는 body text 우선

## 수정 대상 파일

- `src/application/cli/**`
- `src/infrastructure/cli/remote/**`
- `src/infrastructure/cli/render/**`
- `src/interface/cli/**`

## 수정 금지 범위

- typed search/entity command와 contract 합치기
- OpenAPI schema generator 변경

## 구현 순서

1. raw api DTO/port 추가
2. remote invoker adapter 구현
3. `api call` leaf command 추가
4. renderer 포맷별 출력 추가
5. error -> exit code mapping 추가

## 구현 체크포인트

### Checkpoint A

- `api call GET /health`가 동작한다

### Checkpoint B

- `--body @file.json` 입력이 된다

### Checkpoint C

- `--json` output이 stable하다

### Checkpoint D

- HTTP 4xx/5xx가 exit code와 연결된다

## 금지사항

1. `api call` 결과를 typed DTO로 강제 캐스팅 금지
2. renderer가 transport layer를 직접 호출하는 구조 금지
3. typed command 쪽 renderer 분기와 `api call` 구현을 한 함수에 섞는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:unit:file -- <new-api-cli-tests>
pnpm exec tsx src/interface/cli/main.ts api call GET /health --json
```

## DoD

1. raw API call이 typed command와 별도 계층으로 유지된다.
2. renderer가 human/json/yaml/raw를 공통 contract로 제공한다.
3. HTTP error mapping이 deterministic하다.
4. `api call` 구현이 typed facade 설계를 오염시키지 않는다.

## Closeout (2026-05-28) — done

구현:

- `RawApiInvokerPort.call/openApi` 실계약 추가
- raw DTO 추가: `raw-api.dto.ts`
- leaf command 추가: `api call`, `api openapi`
- remote transport: `remote-http-client.ts`, `remote-raw-api-invoker.ts`
- local raw API 정책 확정: `api call`은 unsupported, `api openapi`만 in-process 지원
- body 입력은 inline + `@file` 둘 다 지원
- repeatable `--header`, `--query-param`, `--content-type`, `--show-headers` 지원
- renderer가 `json|table|yaml|raw|human(raw-api projection)`를 공통 처리
- `api call`은 HTTP 4xx/5xx 응답 본문을 출력한 채 exit code `4`로 종료

검증:

- `pnpm run typecheck`
- `pnpm run test:unit:file -- src/interface/cli/__tests__/run-cli.test.ts`

## Verification rail (2026-05-28 post-cleanup)

- Renderer: `src/interface/cli/render/__tests__/render-command-result.test.ts` (24 케이스) — human/json/yaml/table/raw 5 포맷 + `renderAs: 'raw-api'` 분기 (status line, showHeaders true/false, rawText vs body fallback, malformed-shape JSON fallback).
- Raw-api facade: `src/infrastructure/cli/local/__tests__/local-raw-api-invoker.test.ts` (`call()` → `CliError(usage)`, `openApi()` → OpenAPI 문서), `src/infrastructure/cli/remote/__tests__/remote-raw-api-invoker.test.ts` (method 대문자, rawBody 전달, custom headers + content-type, query params, openApi GET `/openapi.json`).
- Command: `src/application/cli/command/__tests__/api-call-command.test.ts` (parseArgs: METHOD/PATH 필수, `--header`/`--query-param` 반복, `--body` literal + `@file`, `--content-type`, `--show-headers`, 미지원 옵션; run: `@file` 본문 해소, 2xx → exitCode 생략, 4xx/5xx → `EXIT_EXECUTION`), `src/application/cli/command/__tests__/api-openapi-command.test.ts`, `src/application/cli/command/__tests__/command-arg-utils.test.ts` (22 케이스).
- **정책 수정**: `local api call` 경로의 에러를 `CliError.execution`(exit 4)에서 `CliError.usage`(exit 2)로 변경. 사용자 호출 오류(잘못된 target 선택)는 실행 실패와 의미상 다름. `local-raw-api-invoker.ts` + `local-raw-api-invoker.test.ts` 동기화.
