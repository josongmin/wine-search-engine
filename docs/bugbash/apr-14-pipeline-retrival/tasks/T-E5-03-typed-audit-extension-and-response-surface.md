# T-E5-03 Typed Audit Extension And Response Surface

## 목표

`audit_extension`을 `z.unknown()`에서 벗어나 typed schema로 올리고, stable public surface와 debug sidecar surface의 경계를 명확히 한다.

## 현재 근거

- response schema는 아직 `audit_extension: z.unknown()`이다: [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:382>)
- audit extension domain type는 많이 커졌지만 schema boundary에서 보호받지 못한다: [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)

## 선행 티켓

- [T-E5-01 stable-provenance-trace-domain-contract](./T-E5-01-stable-provenance-trace-domain-contract.md)

## 정확한 산출물

1. typed `AuditExtensionSchema`
2. `audit_extension` stable/debug 경계 정의
3. response builder와 schema가 같은 optionality를 쓰는 테스트

## 구현 범위

1. `AuditExtensionSchema`를 새로 정의한다.
2. `response.meta.executionContract`와 `audit_extension`의 역할 분리를 문서/스키마로 고정한다.
3. public-stable 필드와 debug-only 필드를 구분하는 gating policy를 추가한다.

## 수정 대상 파일

- [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:372>)
- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:124>)

## 수정 금지 범위

- search response top-level envelope 재설계
- web client migration 수행
- audit_extension 전체 삭제

## 예상 충돌 파일

- [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:372>)
- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:124>)

## 착수 전 확인

```bash
rg -n "audit_extension|execution_trace|retrieval_fusion_trace|ranking_delta_trace" \
  src/domain/audit src/interface/http/schemas src/domain/response
```

## 구현 단계

1. `AuditExtension` TS 타입과 Zod schema를 동시 설계한다.
2. debug-only와 stable surface를 구분하는 optionality 규칙을 정의한다.
3. response serialization 경로가 타입과 schema를 모두 통과하도록 맞춘다.

## 작업 중단 조건

1. stable surface를 올리려면 E9 client consumer 변경이 선행돼야 함
2. audit_extension과 meta 간 역할 분리를 이 티켓 범위에서 결정할 수 없음

## 롤백 기준

- schema만 typed이고 builder/domain 타입은 여전히 blob인 경우
- response/meta와 audit_extension에 같은 내용을 중복 복사하는 방향으로 후퇴하는 경우

## 금지사항

- stable public surface를 audit_extension 안으로 다시 숨기지 말 것
- domain type와 schema가 서로 다른 optionality를 갖게 두지 말 것

## 수용 예시

- 수용:
  - audit_extension이 parse 가능한 typed object
- 비수용:
  - domain 타입만 있고 wire schema는 `unknown`

## 테스트

- search response schema parse tests
- audit extension typed serialization tests
- explain/debug opt-in exposure tests

## 검증 명령

```bash
pnpm run verify:http-contracts
pnpm exec vitest run --config config/vitest/dev.config.ts \
  src/interface/http/schemas/__tests__/search-response-v1.schema.test.ts \
  test/unit/response/response-builder.test.ts
```

## 머지 전 체크리스트

- [ ] AuditExtensionSchema 존재
- [ ] OpenAPI/contract export 깨지지 않음
- [ ] optionality drift 없음

## 완료 조건

- `audit_extension`이 unknown blob이 아니라 typed contract가 된다.
