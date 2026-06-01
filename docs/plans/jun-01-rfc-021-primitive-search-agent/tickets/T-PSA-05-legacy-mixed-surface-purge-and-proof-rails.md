# T-PSA-05 Legacy Mixed-Surface Purge And Proof Rails

## 목표

public/tool primary surface에서 `mixed`/`similar_items` 의존성을 걷어내고, 같은 drift가 다시 들어오지 못하게 banned-surface guard와 closeout matrix를 추가한다.

## 현재 근거

- `mixed_query`, `similar_items`, legacy compare residue가 여러 레이어에 퍼져 있다.
- 다만 모두를 한 번에 삭제하는 것은 scope overrun 위험이 있다.
- 따라서 이 티켓의 목표는 **internal compatibility residue 전부 삭제**가 아니라, **public/tool primary surface에서의 퇴출 + allowlisted internal residue 관리**다.

## 선행 티켓

- [T-PSA-02](./T-PSA-02-agent-primitive-composition-cutover.md)
- [T-PSA-03](./T-PSA-03-public-search-path-authority-and-planner-scope-reduction.md)
- [T-PSA-04](./T-PSA-04-reference-similarity-eval-golden-queries-and-observability.md)

## 정확한 산출물

1. banned surface 목록 확정
2. allowlisted internal compatibility residue 목록 문서화
3. public/tool/doc/test surface purge
4. proof rail matrix
5. closeout note template

## 예상 수정 파일

```text
src/application/wine-search/**
src/application/search/**
src/interface/http/**
src/interface/claude-tools/**
test/**
docs/**
scripts/**
```

## 구현 범위

1. public/tool/docs/tests에서 legacy surface 삭제
2. grep-based banned surface rail
3. allowlist 문서화
4. final proof matrix 작성

## 구현 제외 범위

1. internal compatibility label을 무조건 0개로 만드는 작업
2. 새 retrieval feature 추가
3. broad eval redesign

## 권장 banned surface 목록

```text
search_wines
compare_wines
mode=hybrid
mode=mixed
retrieval_mode=mixed
similar_items (public/tool/docs surface)
mixed (public/tool/docs surface)
```

false positive 방지를 위해:

- internal compatibility-only allowlist 파일/라인을 문서화한다.
- banned rail은 product-facing path와 allowlist 바깥 영역만 실패시킨다.

## 구조 규칙

1. public/product surface purge와 internal compatibility residue를 구분한다.
2. rail은 grep만이 아니라 실제 registration/contract도 같이 본다.
3. docs만 지우고 runtime residue를 남기면 미완료다.
4. runtime만 지우고 docs/tests/examples에 legacy를 남겨도 미완료다.

## 구현 순서

1. banned surface / allowlist 고정
2. public/tool/docs/tests purge
3. proof rail 추가
4. final matrix 실행

## 금지사항

1. `mixed` 문자열이 internal에도 남아 있으니 티켓 실패라고 단정하는 것 금지
2. 반대로 public surface에 남았는데 internal label이라는 이유로 넘어가는 것 금지
3. grep clean만 만들고 registration/contract drift를 안 보는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/wine-search/__tests__/wine-agent-loop-tool-bundle.test.ts src/application/search/__tests__/search-usecase-pre-route-phase.test.ts
pnpm exec vitest run test/regression/reference-similarity-agent.test.ts test/regression/reference-similarity-public-search.test.ts
rg -n 'search_wines|compare_wines|mode=mixed|retrieval_mode.*mixed|similar_items|\\bmixed\\b' src test docs scripts
```

## DoD

1. public/tool primary surface가 `mixed` dependency 없이 닫힌다.
2. allowlisted internal compatibility residue가 문서화된다.
3. banned-surface rail이 재도입을 막는다.
4. closeout 시 owner-local green / ambient residue를 분리 보고할 수 있다.
