# EPIC-3 Retrieval Contract Drift Cutoff

## 문제 정의

retrieval layer에는 아직 unknown/unrecognized 입력을 lexical fallback이나 heuristic profile로 위장하는 seam이 있었다. 이건 retrieval SSOT를 흐리고, downstream에 "정상 hybrid execution"처럼 보이는 거짓 상태를 만든다.

## 현재 코드 근거

- unknown channel은 이제 reject가 맞는 방향으로 올라와 있다: [retrieval-channel.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/model/retrieval-channel.ts:101>)
- retrieval profile도 unknown mode를 throw로 올리는 방향이 핵심이다: [retrieval-profile.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts:330>)
- constraint evidence builder는 unknown attribute를 silent unmet이 아니라 loud fail로 다뤄야 한다: [candidate-constraint-evidence.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/service/candidate-constraint-evidence.ts>)
- candidate pool은 anchor/doc miss나 learned sparse failure를 broad-recall success로 위장하면 안 된다: [candidate-pool.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts>)
- hybrid candidate retrieval result는 execution facts와 provenance coverage를 이미 싣는다: [search-usecase-hybrid-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts:90>)
- hybrid ranking pipeline은 retrieval provenance closure를 후단에서 합친다: [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:264>)
- retrieval-facing field 중 일부는 runtime contract는 읽는데 write/provenance authority가 약하다: [nl-mapper.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/attribute/service/nl-mapper.ts:161>), [constraint-to-sparse-filter-tokens.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts:43>)

## 목표 불변식

1. unknown retrieval channel은 reject한다.
2. unknown retrieval mode는 prod에서 throw한다.
3. specialized / generic / mixed path 모두 공통 execution facts vocabulary를 쓴다.
4. zero-result relaxation retry는 constraint-only rebuild이며 retrieval mode/channel mix를 바꾸지 않는다.
5. constraint/evidence attribute vocabulary drift는 silent unmet가 아니라 hard failure다.
6. retrieval contract가 읽는 attribute는 writer/provenance authority가 없으면 absent가 정식 동작이다.

## breaking changes

- raw unknown channel/mode 입력을 허용하던 compat seam 제거
- retrieval profile의 heuristic fallback 제거
- sparse zero hit 판정은 `sparseExecuted === true`인 generic hybrid에만 허용
- retrieval-facing attribute vocabulary가 canonical ontology와 다르면 reject 또는 omit한다.

## 구현 작업 목록

1. retrieval channel/type guard와 trace vocabulary를 한 군데로 고정한다.
2. retrieval profile selection에서 unknown mode를 warning이 아닌 hard failure로 다룬다.
3. specialized browse/compare path와 mixed path까지 `retrievalKind`, `sparseExecuted`, `usedCompiledExecution`를 동일하게 싣는다.
4. relaxation retry는 original compiled execution contract를 유지한 채 retrieval plan만 재생성한다.
5. constraint evidence attribute registry를 하나로 고정하고, unknown attribute는 builder 단계에서 실패시킨다.
6. anchor/doc miss, learned sparse failure, relative filter miss를 broad recall success로 숨기지 않게 한다.
7. `occasion`, `priceBand`, `soilType`, `producerType` 등 retrieval-facing attribute는 canonical vocabulary와 writer provenance를 함께 점검하고, 미지원이면 omit contract로 정리한다.

## 테스트 / 게이트

- unknown channel hard fail
- unknown retrievalMode hard fail
- specialized path sparse-zero-hit 오판 금지
- relaxation retry에서 retrieval mode/channel mix 불변
- unknown constraint attribute hard fail
- retrieval-facing attribute vocabulary mismatch가 silent broad recall로 흐르지 않음

## merge 조건

- retrieval layer에서 unknown/unrecognized 입력을 정상 lexical/hybrid 실행처럼 위장하는 경로가 없다.
- retrieval contract가 읽는 attribute plane에 authority 없는 fabricated vocabulary가 남아 있지 않다.
