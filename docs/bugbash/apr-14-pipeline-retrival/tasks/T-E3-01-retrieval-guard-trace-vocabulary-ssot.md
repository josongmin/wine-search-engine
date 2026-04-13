# T-E3-01 Retrieval Guard Trace Vocabulary SSOT

## 목표

retrieval guard/type check/trace vocabulary를 한 군데로 고정하고, specialized/mixed path까지 동일 execution fact vocabulary를 사용하게 만든다.

## 현재 근거

- EPIC-3은 guard와 trace vocabulary SSOT를 요구한다: [EPIC-3-retrieval-contract-drift.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-3-retrieval-contract-drift.md:33>)
- unknown channel/mode hard fail은 많이 들어갔지만, trace vocabulary SSOT 자체를 닫는 전용 티켓은 없다.

## 선행 티켓

- [T-E2-02 compiled-required-post-route-and-ranking-contract](./T-E2-02-compiled-required-post-route-and-ranking-contract.md)

## 정확한 산출물

1. retrieval guard/trace vocabulary SSOT 정의
2. specialized/generic/mixed 공통 trace field 정리
3. vocabulary consistency tests

## 구현 범위

1. retrieval layer가 쓰는 channel/type/route facts vocabulary를 한 곳으로 모은다.
2. specialized browse/compare, generic hybrid, mixed path가 같은 trace keys를 쓰게 한다.
3. retrieval trace에 남아 있는 자유 문자열 drift를 제거한다.

## 수정 대상 파일

- retrieval model/service files under [src/domain/retrieval](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval>)
- [search-usecase-hybrid-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts:90>)
- [search-usecase-mixed-route.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-mixed-route.ts:1>)

## 수정 금지 범위

- retrieval mode policy 재설계
- candidate ranking semantics 변경
- response top-level wire contract 변경

## 예상 충돌 파일

- [retrieval-channel.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/model/retrieval-channel.ts:1>)
- [search-usecase-hybrid-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts:90>)
- [search-usecase-mixed-route.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-mixed-route.ts:1>)

## 착수 전 확인

```bash
rg -n "retrievalKind|sparseExecuted|usedCompiledExecution|channel|trace" src/domain/retrieval src/application/search
```

## 구현 단계

1. 현재 retrieval trace field set을 path별로 표로 정리한다.
2. canonical vocabulary를 먼저 정한다.
3. specialized/generic/mixed path를 그 vocabulary로 맞춘다.
4. vocabulary drift를 테스트로 고정한다.

## 작업 중단 조건

1. trace vocabulary를 고정하려면 E5 provenance trace surface와 동시 설계가 필요함
2. path별 trace 목적이 달라 하나의 vocabulary로 무리하게 통합되면 의미 손실이 발생함

## 롤백 기준

- specialized path와 generic path가 여전히 다른 키 이름을 쓰는 경우
- guard는 hard fail인데 trace field는 자유 문자열인 상태가 남는 경우

## 금지사항

- path별 임시 alias key 추가 금지
- unknown input을 trace string으로만 남기고 contract에는 반영하지 말 것

## 수용 예시

- 수용:
  - generic/specialized/mixed 모두 `retrievalKind`를 같은 enum으로 노출
- 비수용:
  - 한 path는 `mode='producer_browse'`, 다른 path는 `retrievalKind='specialized_hybrid'`

## 테스트

- retrieval trace vocabulary consistency tests
- specialized/mixed execution fact regression tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <retrieval-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] path별 retrieval trace field set이 동일 vocabulary 사용
- [ ] 자유 문자열 drift 제거
- [ ] tests가 specialized/mixed를 함께 검사

## 완료 조건

- retrieval trace/guard vocabulary가 path별로 갈라지지 않는다.
