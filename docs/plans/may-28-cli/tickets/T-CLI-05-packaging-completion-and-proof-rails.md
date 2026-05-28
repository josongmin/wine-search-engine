# T-CLI-05 Packaging Completion And Proof Rails

## 목표

CLI를 실제 도구로 배포 가능한 상태로 묶고, package/bin/help/completion/test rail을 정리한다.

이 티켓은 기능 추가가 아니라 operator-ready closeout이다.

## 선행 티켓

- [T-CLI-03](./T-CLI-03-typed-search-and-entity-commands.md)
- [T-CLI-04](./T-CLI-04-raw-api-call-and-output-contract.md)

## 정확한 산출물

1. `package.json` script/bin wiring
2. help text
3. completion 또는 명시적 후순위 정책
4. smoke proof rail
5. 문서 closeout

## 예상 수정 파일

- `package.json`
- `src/interface/cli/main.ts`
- `docs/plans/may-28-cli/*.md`
- 필요 시 `scripts/` 또는 `test/` 아래 smoke harness

## 구현 범위

1. package entry
2. build/run invocation contract
3. CLI smoke tests
4. operator-facing usage docs
5. completion 지원 여부 결정과 문서화

## 구현 제외 범위

1. completion 때문에 parser 교체
2. 새 command 추가

## packaging 규칙

최소한 아래 둘 중 하나는 있어야 한다.

1. `pnpm exec tsx src/interface/cli/main.ts ...`
2. `package.json` `bin` 또는 동등한 script alias

최종 operator surface는 하나로 정해야 한다.

## help 규칙

help text는 아래와 일치해야 한다.

1. command tree
2. global option
3. command별 최소 예시
4. target/profile 개념

help와 parser가 drift하면 이 티켓은 fail이다.

## proof rail 규칙

최소 smoke:

1. `auth status`
2. `search run --target local`
3. `api call GET /health`

최소 automated:

1. help 출력 snapshot 또는 deterministic assertion
2. command not found assertion
3. smoke lane

## completion 정책

둘 중 하나를 명시적으로 결정한다.

1. v1에서 지원
2. v1에서는 미지원, follow-up ticket로 미룸

애매하게 두지 말 것.

## 수정 금지 범위

- shell completion 때문에 command parser 전면 교체
- proof rail 없이 packaging만 추가

## 구현 순서

1. package entry 확정
2. help text 고정
3. smoke proof rail 추가
4. completion 정책 명시
5. 문서 closeout

## 구현 체크포인트

### Checkpoint A

- 실행 entry가 하나로 정해짐

### Checkpoint B

- help와 실제 parser가 일치함

### Checkpoint C

- smoke rail이 local 환경에서 반복 가능함

## 금지사항

1. local dev 전용 alias를 product CLI contract처럼 문서화 금지
2. help text와 실제 parser drift 허용 금지
3. README와 plan 문서가 서로 다른 호출 예시를 가지는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run build
pnpm run test:unit:file -- <new-cli-proof-tests>
pnpm exec tsx src/interface/cli/main.ts --help
```

## DoD

1. CLI가 repo 밖 operator 시점에서도 실행 진입점이 명확하다.
2. help/package/proof rail이 서로 일치한다.
3. 문서와 실제 command tree drift가 없다.
4. completion 지원 여부가 명시적으로 결정돼 있다.

## Closeout (2026-05-28) — done

구현:

- `package.json`에 `bin.wine=dist/interface/cli/main.js` 추가
- dev entry `pnpm run cli -- ...` 추가
- `src/interface/cli/main.ts`에 node shebang 추가
- help text를 실제 command tree + global option + example로 갱신
- smoke:
  - `pnpm exec tsx src/interface/cli/main.ts --help`
  - `pnpm exec tsx src/interface/cli/main.ts api openapi --json`
- automated proof:
  - `run-cli.test.ts`
  - `command-registry.test.ts`
  - `parse-global-args.test.ts`

completion 정책:

- v1 미지원으로 확정
- parser 교체 없이 follow-up ticket로 미룸

operator entry single-surface 결정:

- 운영자(operator)용 정식 surface = `wine` bin (`package.json:bin.wine → dist/interface/cli/main.js`). 설치 후 `wine <group> <command>` 한 줄.
- `pnpm run cli -- ...` (`tsx src/interface/cli/main.ts`)는 **dev-only 단축경로** — 빌드 전 워킹트리에서 빠른 반복용. 운영 문서/README/외부 안내는 `wine` 만 노출하고 `pnpm cli`는 contributor 문서에만 명시.
- `pnpm exec tsx src/interface/cli/main.ts` 직접 호출은 packaging 우회 경로로 분류, smoke/test 외 사용 금지.

## Proof rail (2026-05-28 post-cleanup)

- `src/interface/cli/__tests__/cli-smoke-rail.test.ts` (8 케이스) — deterministic shell 회귀 게이트:
  1. `--help` 출력 안정 + 등록된 모든 명령 (`auth status/doctor`, `search run/hybrid`, `entity resolve/autocomplete`, `wine-search run`, `api call/openapi`) 노출, hidden `system ping` 숨김
  2. bare invocation → help, exit 0
  3. unknown command → exit 2 + `Unknown command`
  4. incomplete command path → exit 2 + `Incomplete command`
  5. `api call --target local` → exit 2 (usage; 정책 수정 반영)
  6. hidden `system ping --json` end-to-end (`ok:true`, target/requestId 출력)
  7. `auth status --json` + injected fake facade (auth plane 통합)
  8. help 구조 라인 drift gate (`Usage:`, `Commands:`, `Global options:`, `Examples:` 헤더)
- 전체 CLI 단위 lane: **24 파일 / 171 케이스 통과** (`pnpm run test:unit:file -- <CLI test files>`)
- live smoke (실 Codex 토큰): `auth status` / `auth path` / `auth whoami` / `auth doctor`(`1 models HTTP 200`) / `auth login` / `system ping` / `api openapi` 모두 exit 0; `auth doctor --target remote`(no base-url) exit 5; unknown subcommand exit 2; `api call` 로컬 exit 2.
