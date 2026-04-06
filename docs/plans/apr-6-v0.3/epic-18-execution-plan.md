# Epic 18 Execution Plan

**Epic:** [Epic 18: Robust Entity Lookup](./epic-18-robust-entity-lookup.md)  
**목적:** Epic 18을 바로 구현 가능한 작업 묶음으로 내린다.  
**우선순위:** `18.1 -> 18.2 -> 18.3 -> 18.4 -> 18.5 -> 18.6 -> 18.7`

---

## Track A — Benchmark and Eval

### Scope

- noisy entity benchmark dataset
- eval runner
- baseline capture
- quality dashboard slice

### Work items

1. `data/noisy-entity-benchmark.jsonl` 초안 작성
2. category taxonomy 고정
3. expected entity id validation 추가
4. `scripts/eval/run-noisy-entity-eval.ts` 추가
5. `Recall@1`, `Recall@3`, `MRR`, `false exact match rate`, `abstain precision` 계산
6. benchmark fixture test 추가
7. baseline report 생성

### Initial dataset slices

- typo
- accent stripped
- whitespace collapse / split
- abbreviation
- transliteration
- vintage partial
- mixed-language
- adversarial near-miss

### Acceptance

- benchmark 파일이 스키마 검증을 통과한다.
- eval script가 현재 엔진 baseline을 산출한다.
- 주요 noisy slice별 성능이 별도 리포트로 나온다.

---

## Track B — Query Normalization

### Scope

- multi-view normalization
- compact / accentless / vintage-stripped variants
- transliteration-ready representation

### Work items

1. `NormalizedQueryViews` 타입 정의
2. `query-normalizer.ts` 구현
3. Unicode / accent / whitespace / punctuation normalization 구현
4. vintage canonicalization 구현
5. compact view와 tokenized view 생성
6. normalization unit tests 추가
7. planner / resolver entry integration

### Acceptance

- 하나의 query에서 여러 normalized view가 생성된다.
- 기존 exact behavior regression 없이 downstream에서 사용 가능하다.
- 한국어/영어 혼합 입력의 normalization snapshot test가 존재한다.

---

## Track C — Candidate Generation

### Scope

- exact alias
- normalized alias
- lexical fuzzy
- edit-distance fallback

### Work items

1. candidate provenance 구조 정의
2. exact alias lookup을 provenance-aware로 감싼다
3. normalized alias lookup 추가
4. char n-gram candidate generator 추가
5. bounded edit-distance fallback 추가
6. trace에서 stage별 후보를 남긴다
7. top-k recall 비교 테스트 추가

### Acceptance

- `opusone`, `romaneconti`, `moetshandon` 류 입력에서 후보 recall이 baseline보다 오른다.
- provenance trace에서 어떤 stage가 후보를 만들었는지 보인다.
- fuzzy stage 추가 후 false exact match가 급증하지 않는다.

---

## Track D — Transliteration and Phonetic

### Scope

- Korean transliteration
- phonetic recall
- abbreviation strengthening

### Work items

1. common producer/wine transliteration rule set 작성
2. phonetic key generator 추가
3. transliteration matcher 추가
4. abbreviation dictionary / heuristics 보강
5. KR/EN/FR variant tests 추가
6. transliteration slice eval 추가

### Acceptance

- `샤또마고`, `모엣샹동`, `오푸스원`류에서 top-k recall이 baseline보다 오른다.
- transliteration/phonetic은 exact resolve가 아니라 candidate recall 강화로 먼저 동작한다.

---

## Track E — Learned Matcher and Gate

### Scope

- noisy candidate rerank
- confidence estimation
- ambiguity / abstain gate

### Work items

1. matcher feature schema 확장
2. alias provenance / generation source feature 추가
3. char n-gram overlap / token coverage / script compatibility feature 추가
4. top1-top2 gap 기반 gate 추가
5. short-query / abbreviation prior 추가
6. false exact match eval 추가
7. calibration report 생성

### Acceptance

- noisy lookup Recall@K가 오르고 false exact match는 baseline 이하를 유지한다.
- ambiguous short noisy query에서 abstain precision 목표를 만족한다.

---

## Track F — Feedback Flywheel

**상태 (저장소 기준): Deferred — 미구현.** Track A–E(벤치·정규화·후보·transliteration·matcher)가 안정된 뒤, 아래를 순차 도입한다. 자동 alias 승격은 하지 않는다는 원칙은 유지한다.

### Scope

- query log mining
- observed alias proposal
- review queue
- benchmark refresh

### Work items

1. failed query / reformulation / clickthrough 로그 스키마 정의
2. alias proposal job 초안 작성
3. reviewable noisy alias suggestion 포맷 정의
4. suppression / rollback-safe promotion 정책 정의
5. benchmark refresh rule 추가
6. human-approved alias 반영 루프 문서화

### Acceptance

- noisy alias 후보가 자동 수집되지만 무검수 자동 승격은 하지 않는다.
- benchmark refresh가 runtime data와 연결된다.

---

## Recommended Parallelization

### Wave 1

- Track A: Benchmark and Eval
- Track B: Query Normalization

### Wave 2

- Track C: Candidate Generation
- Track D: Transliteration and Phonetic

### Wave 3

- Track E: Learned Matcher and Gate
- Track F: Feedback Flywheel

---

## Phase 1 Commit Target

첫 구현 라운드의 현실적 목표는 아래 네 가지다.

1. benchmark 초안이 존재한다.
2. multi-view normalization이 추가된다.
3. char-level fuzzy candidate generation이 붙는다.
4. 대표 noisy query에서 baseline 대비 Recall@3가 오른다.

이 Phase 1이 끝나면 그 다음부터 phonetic/transliteration과 learned matcher를 붙인다.
