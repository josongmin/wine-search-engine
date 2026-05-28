# May 28 CLI RFC

> 목적: 이 repo를 `auth helper script`가 아니라 `범용 product CLI`로 확장하되, 기존 `container -> usecase port -> HTTP route` 구조와 충돌하지 않게 얇고 SOLID한 shell로 설계한다.

---

## 1. 문제 정의

현재 repo에는 아래 문제가 있다.

1. 운영/개발/평가 작업을 위해 HTTP route, ad-hoc script, bench runner, eval script가 분산되어 있다.
2. `Codex login token`을 쓰는 lane도 script별로 접근 방식이 다르다.
3. search/resolve/autocomplete/wine-search/API 호출을 한 shell에서 일관되게 다룰 수 있는 범용 CLI surface가 없다.
4. 단순 script 확장으로 가면 `argv parsing`, `container wiring`, `fetch`, `rendering`, `auth`, `profile`가 한 파일에 뭉친다.
5. local 실행과 remote 실행이 분리되지 않으면 `typed usecase 실행`과 `raw HTTP 호출`이 섞여 contract가 흐려진다.

이번 RFC는 CLI를 product shell로 정의하고, local in-process 실행과 remote HTTP 실행을 같은 명령 모델 아래로 정리한다.

---

## 2. 현재 근거

### 구조 근거

- repo 레이어 규칙은 CLI entrypoint를 `src/interface/`에 두라고 가리킨다: [CLAUDE.md](../../../CLAUDE.md#L57-L63)
- container는 search/resolve/autocomplete/hybrid/wine-search slice를 직접 제공한다: [src/config/container.ts](../../../src/config/container.ts#L68-L113)
- HTTP route도 같은 usecase port를 최소 경계로 쓴다: [src/interface/http/routes/route-deps.ts](../../../src/interface/http/routes/route-deps.ts#L17-L80)
- search executor contract는 이미 application port로 고정돼 있다: [src/application/search/port/search-executor.port.ts](../../../src/application/search/port/search-executor.port.ts#L27-L35)
- resolve/autocomplete/hybrid contract도 독립 포트로 있다: [src/application/search/port/search-route-usecases.port.ts](../../../src/application/search/port/search-route-usecases.port.ts#L87-L112)

### auth 근거

- Codex auth read/refresh 로직이 이미 있다: [src/infrastructure/ai/codex-chatgpt-auth.ts](../../../src/infrastructure/ai/codex-chatgpt-auth.ts#L101-L248)
- ChatGPT OAuth model catalog probe는 이미 구현돼 있다: [src/infrastructure/ai/chatgpt-oauth-chat-llm.ts](../../../src/infrastructure/ai/chatgpt-oauth-chat-llm.ts#L424-L462)

### 현재 운영 문제

- eval/diag/bench lane은 각자 별도 script entry를 가진다:
  - [scripts/eval/generate-silver-labels.ts](../../../scripts/eval/generate-silver-labels.ts)
  - [scripts/eval/llm-judge-ndcg.ts](../../../scripts/eval/llm-judge-ndcg.ts)
  - [scripts/diag-constraint-extraction-llm.mts](../../../scripts/diag-constraint-extraction-llm.mts)
  - [test/benchmark/wine-search/runner.ts](../../../test/benchmark/wine-search/runner.ts)

이 구조는 기능은 있으나 shell contract가 없다.

---

## 3. 목표

1. `wine <group> <command>` 형태의 범용 CLI shell을 만든다.
2. local mode에서는 Fastify self-HTTP 없이 usecase port를 직접 호출한다.
3. remote mode에서는 같은 command contract를 HTTP adapter로 실행한다.
4. auth/profile/output/exit-code를 공통 plane으로 분리한다.
5. typed product command와 raw API command를 구분한다.
6. 누구나 티켓만 보고 구현을 이어갈 수 있게 file map, interface, 검증 명령을 문서화한다.

---

## 4. 비범위

1. 별도 OAuth browser/device flow 자체 구현
2. CLI 내부에서 Fastify 서버를 띄우고 self-call하는 구조
3. 기존 HTTP route contract 전면 redesign
4. eval/bench 전체를 한 번에 CLI로 이관
5. shell completion 때문에 parser를 무겁게 바꾸는 일

---

## 5. 아키텍처 결정 요약

상세는 [architecture-decision.md](./architecture-decision.md).

1. CLI entrypoint는 `src/interface/cli/**`에 둔다.
2. command business logic는 `src/application/cli/**`로 내린다.
3. command는 local/remote transport를 직접 알지 않고 facade port만 안다.
4. local adapter는 `createContainer()`가 노출하는 usecase port를 직접 사용한다.
5. remote adapter는 동일 command contract를 HTTP route 호출로 구현한다.
6. auth token SSOT는 계속 Codex가 소유한다. CLI는 consumer/delegator다.
7. typed command(`search`, `entity`, `wine-search`)와 raw command(`api call`)는 분리한다.
8. renderer는 command 밖으로 분리해 `human/json/yaml/raw` 출력을 공통 contract로 만든다.

---

## 6. 명령 트리

### Group 1: auth

- `wine auth status`
- `wine auth doctor`
- `wine auth refresh`
- `wine auth login`
- `wine auth path`
- `wine auth whoami`

### Group 2: typed product command

- `wine search run`
- `wine search hybrid`
- `wine entity resolve`
- `wine entity autocomplete`
- `wine wine-search run`

### Group 3: raw transport command

- `wine api call`
- `wine api openapi`

### 이후 확장

- `wine diag ...`
- `wine eval ...`
- `wine bench ...`

---

## 7. 공통 옵션

전역 옵션:

1. `--target local|remote`
2. `--profile <name>`
3. `--base-url <url>`
4. `--json`
5. `--output json|table|yaml|raw`
6. `--request-id <id>`
7. `--timeout-ms <n>`
8. `--verbose`
9. `--debug`

명령별 옵션은 leaf command에서 추가한다. 공통 옵션은 shell/kernel에서 parse해야 한다.

---

## 8. 실행 모델

### Local

- `loadConfig()` + `createContainer()` 후 usecase port 직접 호출
- 장점:
  - type-safe
  - route/serialization overhead 없음
  - dev/diag/bench에 유리
- 금지:
  - Fastify self-call
  - route handler import 재사용

### Remote

- HTTP route 호출
- 장점:
  - production parity
  - 배포 환경 대상 호출 가능
- 요구:
  - auth/profile/base-url plane
  - HTTP error -> CLI exit code mapping

### 왜 둘 다 필요한가

1. local only면 운영 대상 호출이 안 된다.
2. remote only면 dev/diag에서 typed in-process usecase를 활용하지 못한다.
3. 두 모드를 같은 command contract 아래 두면 사용자는 shell surface를 바꾸지 않아도 된다.

---

## 9. 명령군별 backing

| Command | Local backing | Remote backing |
|---|---|---|
| `auth status/doctor/refresh/...` | auth facade adapter | auth facade adapter 또는 local-only unsupported contract |
| `search run` | `SearchExecutorPort` | `/v1/search` |
| `search hybrid` | `HybridUseCasePort` | `/v1/search/hybrid` |
| `entity resolve` | `ResolveUseCasePort` | `/v1/entity/resolve` |
| `entity autocomplete` | `AutocompleteUseCasePort` | `/v1/entity/autocomplete` |
| `wine-search run` | `WineSearchOrchestrator` | `/v1/wine-search` |
| `api call` | unsupported (`api openapi`만 local 지원) | arbitrary HTTP path |

`api call`은 typed product command와 같은 DTO contract를 공유하지 않는다.

---

## 10. 산출물 구조

초기 파일 골격:

```text
src/interface/cli/
  main.ts
  command-registry.ts
  argv/
    parse-global-args.ts
    parse-command-path.ts
  render/
    render-human.ts
    render-json.ts
    render-yaml.ts

src/application/cli/
  command/
  context/
  dto/
  port/

src/infrastructure/cli/
  local/
  remote/
  auth/
  profile/
  render/

src/config/
  cli-container.ts
```

이 구조를 벗어나는 구현은 예외 없이 architecture-decision 업데이트가 먼저 필요하다.

---

## 11. Wave 순서

### Wave 1

- `T-CLI-01` command kernel / registry / execution context / runtime target

### Wave 2

- `T-CLI-02` auth / profile / doctor plane

### Wave 3

- `T-CLI-03` typed search/entity/wine-search facade
- `T-CLI-04` raw API call / output renderer / exit code contract

### Wave 4

- `T-CLI-05` package/bin/help/completion/proof rails

### 순서 이유

1. kernel 없이 command를 먼저 구현하면 leaf command별 parser/renderer drift가 난다.
2. auth/profile plane이 없으면 remote target이 고정되지 않는다.
3. typed command와 raw command는 같은 kernel 위에 올라가되 구현은 분리돼야 한다.
4. packaging은 command shape가 고정된 뒤에 하는 게 안전하다.

---

## 12. 전역 원칙

1. CLI shell은 얇게 유지한다.
2. `process.env`, `console`, `fetch`, `fs`, `child_process` 직접 호출은 adapter에만 둔다.
3. local command는 HTTP route handler를 재사용하지 않는다.
4. command는 typed result를 반환하고 renderer가 출력 형식을 책임진다.
5. raw API command는 typed product command와 분리한다.
6. profile precedence는 `flags > env > profile store > defaults`다.
7. `--json`은 처음부터 안정 contract로 취급한다.
8. auth failure와 command failure는 다른 exit code를 가진다.

---

## 13. 전역 금지사항

1. `scripts/wine.ts` 단일 파일 monolith
2. local mode에서 Fastify self-call
3. command 내부 direct `fetch`/`fs`/`child_process`
4. route handler import 재사용
5. typed command와 raw API command contract 혼합
6. Codex와 별도 token SSOT 생성

---

## 14. 전역 DoD

1. root CLI entrypoint가 build/typecheck 대상에 포함된다.
2. `auth`, `search/entity`, `api call`이 같은 command kernel을 사용한다.
3. local/remote mode가 동일 command surface를 공유한다.
4. human output과 `--json` output이 command별로 deterministic하다.
5. auth/profile/exit-code contract가 문서와 테스트에 고정된다.
6. 새 작업자는 `architecture-decision + tickets`만 읽고 구현을 이어갈 수 있다.

---

## 15. 검증 전략

### 설계 검증

1. `rg`로 route handler 직접 import가 없는지 확인
2. local facade가 container port만 참조하는지 확인

### 코드 검증

```bash
pnpm run typecheck
pnpm run build
pnpm run test:unit:file -- <cli-unit-tests>
```

### smoke 검증

예시:

```bash
pnpm exec tsx src/interface/cli/main.ts auth status --json
pnpm exec tsx src/interface/cli/main.ts search run --target local --q "opus one 2018" --json
pnpm exec tsx src/interface/cli/main.ts api call POST /health
```

---

## 16. 리스크

1. local/remote DTO drift
2. output renderer가 command별로 분기 폭증
3. auth/profile plane이 늦게 들어오면 remote 명령이 각자 env를 읽기 시작함
4. `api call`이 범용이라는 이유로 typed command를 잠식할 가능성

대응:

1. facade port를 먼저 고정
2. renderer를 command 밖으로 격리
3. profile/auth를 Wave 2에서 먼저 닫기
4. `api call`과 typed command의 문서/패키징 구분 유지

---

## 17. 티켓 목록

- [architecture-decision.md](./architecture-decision.md)
- [tickets/README.md](./tickets/README.md)
- [T-CLI-01 Command Kernel And Runtime Targets](./tickets/T-CLI-01-command-kernel-and-runtime-targets.md)
- [T-CLI-02 Auth And Profile Plane](./tickets/T-CLI-02-auth-and-profile-plane.md)
- [T-CLI-03 Typed Search And Entity Commands](./tickets/T-CLI-03-typed-search-and-entity-commands.md)
- [T-CLI-04 Raw API Call And Output Contract](./tickets/T-CLI-04-raw-api-call-and-output-contract.md)
- [T-CLI-05 Packaging Completion And Proof Rails](./tickets/T-CLI-05-packaging-completion-and-proof-rails.md)
