# T-E4-01 Entity Route Batch Hydration Hard Requirement

## 목표

entity route에서 `getDocuments()` batch hydration을 기본/필수 경로로 만들고, single-fetch 보완 seam을 제거하거나 explicit degraded seam으로 격리한다.

## 현재 근거

- unresolved hydration은 이미 loud fail이다: [search-usecase-resolver-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts:216>)
- 하지만 batch 후 single-fetch 보완 seam이 남아 있다: [search-usecase-resolver-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts:192>)
- application hydration uses `LookupResolverProjectionPort.getResolverProjections()` as the required batch path: [search-pipeline-deps.port.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts>)

## 선행 티켓

- [T-E2-01 remove-residual-compiled-fallback-reads](./T-E2-01-remove-residual-compiled-fallback-reads.md) 권장

## 정확한 산출물

1. entity route에서 batch hydration failure를 loud failure 또는 explicit degradation으로 처리하는 코드
2. `getDocuments()` hard-requirement를 검증하는 테스트
3. single-fetch seam이 production path가 아니라는 근거

## 구현 범위

1. entity route에서 `resolverProjectionLookup.getResolverProjections()` batch hydration을 hard requirement로 유지한다.
2. adapter가 batch를 제공하지 못하면 production에서는 loud fail, test seam에서만 fallback 허용으로 분리한다.
3. hydration failure taxonomy를 `batch_lookup_failed`, `document_missing`, `partial_resolution_forbidden` 수준으로 정리한다.

## 수정 대상 파일

- [search-usecase-resolver-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts:176>)
- [search-pipeline-deps.port.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts>) (`LookupResolverProjectionPort`)
- 필요 시: [vespa-search-index.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts:590>)
- 테스트: [search-usecase-resolver-candidates.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-resolver-candidates.test.ts:97>)

## 수정 금지 범위

- resolver scoring/calibration 로직 변경
- hybrid broad retrieval hydration semantics 변경
- Vespa adapter 전체 재작성

## 예상 충돌 파일

- [search-usecase-resolver-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts:176>)
- [search-pipeline-deps.port.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts>) (`LookupResolverProjectionPort`)
- [vespa-search-index.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts:590>)

## 착수 전 확인

```bash
rg -n "getDocuments|getDocument" \
  src/application/search src/infrastructure/vespa \
  test/unit/application/search/search-usecase-resolver-candidates.test.ts
```

확인할 것:
- production hot path에서 single-fetch 보완이 어디까지 남아 있는지
- test fixture들이 batch 없는 mock에 의존하는지

## 구현 단계

1. application port에서 batch lookup이 production required임을 타입/주석/contract로 올린다.
2. entity route code에서 single-fetch 보완 seam을 deprecated/test-only path로 분리한다.
3. failure taxonomy를 `DomainError` code 또는 canonical reason string으로 정리한다.
4. 테스트에서 batch available/unavailable/partial miss 케이스를 각각 고정한다.

## 작업 중단 조건

1. entity route 외 다른 consumer가 동일 helper에 강하게 의존하면서 partial hydration을 전제함
2. adapter contract를 바꾸지 않으면 hard-requirement를 구현할 수 없음

## 롤백 기준

- batch hard-requirement 대신 다시 silent per-id skip으로 돌아가야만 테스트가 녹색이 되는 경우
- degradation reason이 생략된 채 empty candidate return으로 우회하게 되는 경우

## 금지사항

- entity route에서 broad fallback retrieval로 도망가지 말 것
- batch failure 후 silent continue 금지

## 수용 예시

- 수용:
  - entity route가 batch lookup 불가 시 즉시 실패
- 비수용:
  - batch 실패 후 single fetch 몇 개 성공하면 계속 진행

## 테스트

- batch lookup unavailable -> production failure
- batch partial miss -> explicit failure
- test seam fallback 허용 시 별도 path 검증

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-resolver-candidates.test.ts
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] single-fetch 보완이 production path에서 제거됨
- [ ] batch unavailable tests가 explicit failure를 확인함
- [ ] failure taxonomy가 canonical code로 남음

## 완료 조건

- entity route hot path에서 single `getDocument()` 보완 fetch가 남아 있지 않다.
