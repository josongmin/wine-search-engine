# T-E5-01 Stable Provenance Trace Domain Contract

## 목표

`execution_trace`와 별도로 `provenance_trace`를 stable domain contract로 정의하고, `policy / observed / missing`을 모든 explain/debug 경로에서 재사용 가능하게 만든다.

## 현재 근거

- `AuditExtension`에는 `execution_trace`만 typed surface로 있다: [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- decision input에는 provenance contract가 이미 있다: [search-usecase-decision-input.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-decision-input.ts:246>)
- response schema는 아직 `audit_extension: z.unknown()`이다: [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:372>)

## 선행 티켓

- [T-E2-02 compiled-required-post-route-and-ranking-contract](./T-E2-02-compiled-required-post-route-and-ranking-contract.md)

## 정확한 산출물

1. `ProvenanceTrace` domain type
2. `audit_extension.provenance_trace` typed surface
3. HTTP schema 변경
4. trace shape snapshot 테스트

## 구현 범위

1. domain layer에 `ProvenanceTrace` 타입을 정의한다.
2. `AuditExtension`에 `provenance_trace`를 추가한다.
3. post-route에서 decision input provenance contract를 canonical provenance trace로 투영한다.
4. explain/debug gating policy를 문서화한다.

## 수정 대상 파일

- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- [search-usecase-decision-input.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-decision-input.ts:246>)
- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:137>)
- [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:372>)
- 테스트: [search-usecase-post-route-phase.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-post-route-phase.test.ts:991>)

## 수정 금지 범위

- response top-level wire contract 재설계
- execution trace rename
- provenance taxonomy 자체 변경

## 예상 충돌 파일

- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:137>)
- [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:372>)

## 착수 전 확인

```bash
rg -n "execution_trace|provenanceContract|audit_extension|z\\.unknown\\(\\)" \
  src/application/search src/domain/audit src/interface/http/schemas
```

확인할 것:
- typed execution trace는 어디까지 이미 있음
- provenance contract가 현재 어떤 shape인지

## 구현 단계

1. `ExecutionProvenanceClosure`와 `DecisionInput.provenanceContract` 차이를 정리한다.
2. 외부로 노출할 stable trace block shape를 먼저 확정한다.
3. post-route에서 그 shape를 조립한다.
4. audit extension domain type와 HTTP schema를 같이 올린다.

## 작업 중단 조건

1. provenance trace shape를 확정하려면 E5-02 taxonomy가 먼저 필요하다는 결론이 나옴
2. trace를 stable surface로 올리면 response consumer migration이 선행돼야 함

## 롤백 기준

- typed surface를 포기하고 다시 `z.unknown()` blob으로 남기게 되는 경우
- policy/observed/missing 대신 free-form string 설명으로 후퇴하는 경우

## 금지사항

- `audit_extension: z.unknown()` 유지한 채 타입만 추가하는 반쪽 수정 금지
- response/meta와 audit_extension에 같은 필드를 중복 복사하지 말 것

## 수용 예시

- 수용:
  - `provenance_trace.policy.require_constraint_evidence = true`
  - `provenance_trace.observed.constraint_evidence_satisfied = false`
  - `provenance_trace.missing = ['constraint_evidence']`
- 비수용:
  - provenance 정보가 free-form string 한 줄로만 남음

## 테스트

- provenance_trace shape snapshot
- debug/explain gating tests
- response schema compatibility tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts \
  src/interface/http/schemas/__tests__/search-response-v1.schema.test.ts \
  test/unit/response/response-builder.test.ts
pnpm run verify:http-contracts
```

## 머지 전 체크리스트

- [ ] provenance_trace typed domain contract 존재
- [ ] HTTP schema가 unknown blob이 아님
- [ ] explain/debug gating rule이 문서/테스트로 고정됨

## 완료 조건

- explain/debug 응답에서 provenance closure를 typed surface로 읽을 수 있다.
