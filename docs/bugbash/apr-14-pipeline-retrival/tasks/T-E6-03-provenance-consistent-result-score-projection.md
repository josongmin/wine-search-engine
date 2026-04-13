# T-E6-03 Provenance-Consistent Result Score Projection

## 목표

API result item의 `matchType`, `scoreComponents`, score vocabulary를 route/result provenance 기준으로 일관되게 투영한다.

## 현재 근거

- result item projection은 공통 mapper에서 계산된다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:297>)
- route-native entity projection을 별도 승격할 필요가 있다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:331>)

## 선행 티켓

- [T-E4-03 entity-route-native-ranked-projection](./T-E4-03-entity-route-native-ranked-projection.md)
- [T-E6-01 remove-uncertainty-neutral-masking](./T-E6-01-remove-uncertainty-neutral-masking.md)

## 정확한 산출물

1. route/provenance-consistent `matchType` projection
2. lexical/semantic/attribute score component projection 정리
3. entity/hybrid/mixed 비교 snapshot 테스트

## 구현 범위

1. entity/hybrid/mixed별 score projection 규칙을 표로 고정한다.
2. lexical/semantic/attribute/popularity/preferenceAlignment가 실제 provenance와 맞지 않는 경우 omitempty 또는 degradation 처리한다.
3. retrieval-stage fusion score와 final ranking score 명칭 혼용을 없앤다.

## 수정 대상 파일

- [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:297>)
- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:244>)
- 테스트: [search-usecase-map-result-items.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-map-result-items.test.ts:73>), [search-usecase-map-result-items.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-map-result-items.test.ts:98>)

## 수정 금지 범위

- response result item 필드 추가/삭제
- ranking score 계산식 변경
- entity route resolver contract 변경

## 예상 충돌 파일

- [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:214>)
- [search-usecase-entity-ranked-results.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-entity-ranked-results.ts:1>)
- [ranked-result-attribute-projection.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ranked-result-attribute-projection.ts:169>)

## 착수 전 확인

```bash
rg -n "deriveMatchType|deriveLexicalScore|scoreComponents|relevanceScore" \
  src/application/search/search-usecase-map-result-items.ts \
  test/unit/application/search/search-usecase-map-result-items.test.ts
```

## 구현 단계

1. route별 projection matrix를 문서로 먼저 정리한다.
2. derive helper들을 route-aware하게 분리한다.
3. missing provenance인 component는 omit/degrade 처리한다.

## 작업 중단 조건

1. projection 정리를 하려면 result item wire contract 자체를 바꿔야 함
2. route별 provenance metadata가 현재 ranked result에 부족해 E4/E5 선행이 필요함

## 롤백 기준

- `matchType='hybrid'` 같은 고정값을 다른 고정값으로만 바꾸는 경우
- lexical/semantic/component 값이 여전히 provenance와 무관하게 채워지는 경우

## 금지사항

- route를 무시하고 공통 hybrid semantics로 뭉개지 말 것
- retrieval score와 final ranking score를 같은 이름으로 노출하지 말 것

## 수용 예시

- 수용:
  - entity exact result의 lexical score는 identity/alias provenance에서 옴
  - hybrid semantic result의 lexical score는 score decomposition에서 옴
- 비수용:
  - 둘 다 그냥 `lexical: 0` 또는 같은 규칙

## 테스트

- route별 result item snapshot tests
- matchType derivation tests
- score component omission/degradation tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-map-result-items.test.ts \
  test/unit/response/response-builder.test.ts
```

## 머지 전 체크리스트

- [ ] route별 projection matrix 존재
- [ ] retrieval score/final ranking score 명칭 혼용 없음
- [ ] component omission/degradation 기준이 테스트로 고정됨

## 완료 조건

- 동일 결과를 route별로 다른 의미의 score로 해석하는 구멍이 없다.
