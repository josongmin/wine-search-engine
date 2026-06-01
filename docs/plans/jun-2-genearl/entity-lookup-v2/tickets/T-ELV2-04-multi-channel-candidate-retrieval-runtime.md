# T-ELV2-04 Multi-Channel Candidate Retrieval Runtime

## 목표

lookup 전용 candidate retrieval runtime을 만들고, exact/transliteration/fuzzy/family/dense recall 채널을 독립적으로 운영한다.

## 정확한 산출물

1. candidate retrieval engine
2. per-channel recall evidence
3. candidate union contract
4. retrieval latency/coverage rail

## 반드시 건드릴 파일

1. `src/infrastructure/adapter/**`
2. `src/domain/resolver/**`
3. `src/application/search/**`
4. `test/**`

## 구현 범위

1. exact/compact/transliteration/jamo/phonetic/fuzzy channels
2. family graph recall channel
3. optional dense/char-aware channel
4. candidate union + dedupe

## 금지사항

1. retrieval을 single fuzzy matcher에 다시 몰아넣는 것
2. reranker 없이 retrieval top1을 바로 resolve하는 것

## DoD

1. candidate recall이 다채널 artifact로 분리된다.
2. top entity + typo + transliteration hotset이 retrieval 단계에서 회수된다.
