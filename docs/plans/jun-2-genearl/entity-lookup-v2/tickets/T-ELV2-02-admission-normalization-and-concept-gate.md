# T-ELV2-02 Admission Normalization And Concept Gate

## 목표

entity query 여부를 front-door에서 판정하고, normalization artifact와 concept lexicon을 바탕으로 lookup admission을 고정한다.

## 정확한 산출물

1. query normalization pipeline
2. concept/facet lexicon
3. admission classifier
4. `redirect_discovery` / `failed` / `ambiguous` contract

## 반드시 건드릴 파일

1. `src/application/search/**`
2. `src/domain/query/**`
3. `src/domain/alias/**`
4. `test/**`

## 구현 범위

1. unicode/script normalization
2. transliteration-aware query views
3. concept reject / redirect policy
4. under-specified short query reject policy

## 금지사항

1. 특정 문자열 blacklist 하드코딩만으로 끝내는 것
2. resolver 실행 후 concept query를 되돌려 reject하는 것

## DoD

1. `까쇼`류 query가 entity lookup lane에 진입하지 않는다.
2. normalized query views가 explicit artifact로 남는다.
