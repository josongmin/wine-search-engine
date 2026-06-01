# T-ELV2-06 Family Graph And Ambiguity Graph

## 목표

producer-label family, vintage variants, ambiguous shorthand를 explicit graph substrate로 승격해 clarification과 family-level recall을 지원한다.

## 정확한 산출물

1. family graph
2. ambiguity graph
3. clarification contract
4. family-aware retrieval/rerank features

## 반드시 건드릴 파일

1. `scripts/etl/**`
2. `src/domain/alias/**`
3. `src/infrastructure/adapter/**`
4. `test/**`

## 구현 범위

1. producer/label family graph
2. ambiguous alias clusters
3. clarification option generation
4. family-aware scoring features

## 금지사항

1. ambiguity를 string list 수준으로만 유지하는 것
2. family variant를 duplicate alias row만으로 표현하는 것

## DoD

1. family alias와 ambiguity cluster가 explicit substrate가 된다.
2. clarification이 ad-hoc이 아니라 graph-backed contract가 된다.
