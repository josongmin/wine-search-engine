# T-E7-01 JSONB And Entity Row Loud Failure

## 목표

corrupted JSONB와 invalid entity row를 empty/sentinel/default normal value로 위장하지 않는다.

## 현재 근거

- decision snapshot JSONB sentinel fallback: [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:63>)
- empty evidence fallback: [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:98>)
- empty relations fallback: [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:167>)
- invalid entity_type coercion: [pg-entity-repository.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts:92>)

## 선행 티켓

- 없음. 독립 착수 가능

## 정확한 산출물

1. corrupted JSONB read loud failure 코드
2. invalid `entity_type` hard fail 코드
3. corrupted read path unit tests

## 구현 범위

1. JSONB parsers를 tagged result 또는 exception semantics로 재설계한다.
2. entity repository는 invalid `entity_type`를 hard fail한다.
3. caller가 corrupted data를 읽으면 `corrupted_runtime_row` 수준의 loud failure를 surface 한다.

## 수정 대상 파일

- [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:63>)
- [pg-entity-repository.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts:88>)
- callers of JSONB parse helpers in infra adapters
- 테스트: readiness/PG adapter tests, plus new unit tests for corrupted JSONB parsing

## 수정 금지 범위

- DB schema migration
- readiness policy 전체 재설계
- threshold store 정책 변경

## 예상 충돌 파일

- [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:63>)
- [pg-entity-repository.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts:88>)
- 관련 infra adapter tests

## 착수 전 확인

```bash
rg -n "EMPTY_EVIDENCE|EMPTY_RELATIONS|EMPTY_ENTITY_ATTRIBUTES|CORRUPTED_SNAPSHOT_SENTINEL|entity_type.*wine" \
  src/infrastructure/adapter src/config test
```

## 구현 단계

1. parser 반환 전략을 하나 고른다. 권장: `Result<T, CorruptionError>` 또는 hard throw.
2. entity repository가 corrupted parser result를 loud failure로 올리게 바꾼다.
3. empty fallback을 기대하던 tests를 explicit failure expectation으로 교체한다.
4. caller impact가 큰 순서로 decision snapshot -> evidence -> relations -> attributes -> entity_type coercion 순으로 바꾼다.

## 작업 중단 조건

1. corrupted read를 loud fail로 바꾸면 snapshot substrate 전체 migration이 먼저 필요함
2. callers가 empty fallback shape에 강하게 의존해 연쇄 수정 범위가 과도하게 커짐

## 롤백 기준

- empty/sentinel fallback을 일부라도 남기는 경우
- invalid `entity_type`를 또 다른 default type으로 coercion하는 경우

## 금지사항

- empty object/array sentinel을 유지한 채 로그만 강화하는 반쪽 수정 금지
- invalid `entity_type`를 다른 default type으로 다시 coercion 금지

## 수용 예시

- 수용:
  - malformed evidence_items -> loud failure
- 비수용:
  - malformed evidence_items -> `[]`

## 테스트

- corrupted decision snapshot read failure
- malformed evidence items read failure
- invalid entity_type failure

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  src/config/__tests__/readiness.test.ts \
  test/unit/config/search-snapshot-runtime-readiness.test.ts
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] empty/sentinel fallback 제거
- [ ] entity_type coercion 제거
- [ ] corrupted read path가 explicit failure로 보임

## 완료 조건

- corrupted row가 empty evidence/relations/attributes나 `wine` coercion으로 위장되지 않는다.
