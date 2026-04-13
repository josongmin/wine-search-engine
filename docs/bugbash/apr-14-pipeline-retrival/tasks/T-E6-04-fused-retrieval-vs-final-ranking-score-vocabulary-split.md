# T-E6-04 Fused Retrieval Vs Final Ranking Score Vocabulary Split

## 목표

fused retrieval score와 final ranking score의 용어/필드/trace를 명확히 분리해, 같은 수치가 route별로 다른 의미로 해석되지 않게 한다.

## 현재 근거

- EPIC-6은 fused retrieval score와 final ranking score의 용어 분리를 요구한다: [EPIC-6-ranking-score-contract-closure.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-6-ranking-score-contract-closure.md:31>)
- 현재 tasks는 rerank failure, uncertainty masking, result projection은 있지만 score vocabulary split 전용 티켓은 없다.

## 선행 티켓

- [T-E6-03 provenance-consistent-result-score-projection](./T-E6-03-provenance-consistent-result-score-projection.md) 권장

## 정확한 산출물

1. score vocabulary 표
2. fused retrieval vs final ranking score field 분리 코드
3. score semantics regression tests

## 구현 범위

1. retrieval fusion score, rerank score, final ranking score의 canonical names를 고정한다.
2. response/meta/audit/test에서 같은 필드명이 다른 의미를 갖지 않게 정리한다.
3. legacy ambiguous score field가 있으면 deprecated seam으로 격리한다.

## 수정 대상 파일

- ranking/retrieval score projection files
- response builder / audit extension / tests

## 수정 금지 범위

- ranking algorithm 재튜닝
- retrieval fusion algorithm 변경
- UI score visualization 추가

## 예상 충돌 파일

- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:124>)
- ranking metadata / retrieval metadata projection files
- response contract tests

## 착수 전 확인

```bash
rg -n "fusion.*score|finalScore|rerank.*score|retrievalFusionScore" src test
```

## 구현 단계

1. score field inventory를 만든다.
2. 의미가 겹치는 필드를 분류한다.
3. canonical names를 정하고 projection을 정리한다.
4. deprecated seam이 남으면 explicit 문서와 tests를 남긴다.

## 작업 중단 조건

1. field split을 하려면 public wire contract migration이 먼저 필요함
2. 같은 필드가 analytics 외부 consumer에 직접 쓰이고 있어 migration plan이 필요함

## 롤백 기준

- 같은 field 이름이 여전히 fused/final score를 혼용하는 경우
- deprecated seam이 explicit 표시 없이 남는 경우

## 금지사항

- 의미가 다른 score를 이름만 바꾸지 않고 그대로 재사용하지 말 것
- response layer에서 score semantics를 다시 추론하지 말 것

## 수용 예시

- 수용:
  - `retrieval_fusion_score`와 `final_ranking_score`가 별도 필드/설명 사용
- 비수용:
  - `score` 하나로 둘 다 설명

## 테스트

- score vocabulary regression tests
- response/audit score semantics tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <ranking-score-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] fused vs final score vocabulary 분리
- [ ] ambiguous legacy field explicit 처리
- [ ] tests가 score semantics를 검사

## 완료 조건

- fused retrieval score와 final ranking score가 동일 필드/이름으로 혼용되지 않는다.
