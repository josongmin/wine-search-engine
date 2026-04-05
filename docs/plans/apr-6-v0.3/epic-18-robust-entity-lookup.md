# Epic 18: Robust Entity Lookup

**Phase:** 7  
**의존성:** v0.1 Epic 2, Epic 7 / v0.2 Epic 13, Epic 16  
**해소 갭:** typo robustness, transliteration robustness, abbreviation robustness, noisy entity recall, false exact match control

---

## 목표

사용자가 와인명을 정확히 입력하지 않아도, 시스템이 높은 확률로 올바른 엔티티를 찾는다.

대표 케이스:
- `opusoe`
- `romane conti`
- `Chateau Margaux`
- `모엣샹동`
- `샤또 마고`
- `drc 19`
- `opus one 18`

핵심 원칙:
1. 후보는 넓게 모은다.
2. 최종 선택은 learned match confidence로 한다.
3. 자신 없으면 exact인 척하지 않고 abstain / ambiguity로 빠진다.

이 epic의 SOTA++ 정의:
1. normalization은 single-string canonicalization이 아니라 multi-view query representation이다.
2. recall은 staged retrieval funnel이 책임진다.
3. precision은 confidence calibration과 ambiguity gate에서 지킨다.
4. typo / 붙여쓰기 / 음차 / 악센트 제거는 char-level + phonetic + transliteration 계층으로 대응한다.
5. 품질은 benchmark, offline eval, runtime feedback loop가 함께 굴러야 유지된다.

---

## 실제 베이스라인

현재 코드베이스에는 아래 자산이 이미 있다.

- `Planner`의 `entity_exact` / `entity_fuzzy` intent 분리
- `entity_lookup` / `entity_resolution` retrieval mode
- alias 기반 anchor extraction
- 일부 observed/noisy alias 개념
- learned matcher adapter 훅
- eval / golden query infrastructure

즉 완전 신규 엔진을 만드는 게 아니라, **entity lookup robustness 전용 품질 레이어**를 올리는 epic이다.

---

## North Star Architecture

```text
User Query
  -> Multi-View Normalization
  -> Candidate Funnel
     -> exact alias
     -> normalized alias
     -> char n-gram lexical recall
     -> edit-distance / phonetic / transliteration
     -> semantic fallback
  -> Learned Entity Matcher
  -> Confidence / Ambiguity Gate
  -> Exact Resolve | Ambiguous | Abstain
  -> Feedback Flywheel
```

### Architectural intent

- retrieval은 recall을 책임진다.
- matcher는 top-k ordering과 confidence estimation을 책임진다.
- gate는 false exact match와 overconfident resolve를 막는다.
- feedback loop는 alias growth와 benchmark refresh를 책임진다.

---

## Step 18.1 — Noisy Entity Benchmark

### 목표

일반 검색 eval과 분리된, 엔티티 이름 복원 전용 벤치마크를 만든다.

### 데이터 카테고리

```text
1. typo
2. accent stripped
3. whitespace collapse / split
4. abbreviation
5. transliteration (KR/EN)
6. producer + label partial
7. vintage partial / abbreviated vintage
8. mixed-language query
9. noisy short form
10. adversarial near-miss
```

### 예시 포맷

```json
{
  "query": "romane conti",
  "expected_entity_id": "romanee-conti-2019",
  "category": "typo",
  "language": "en",
  "difficulty": "medium"
}
```

### Metrics

- Recall@1
- Recall@3
- MRR
- Ambiguity false-positive rate
- Abstain precision
- Confidence calibration error
- False exact match rate
- Transliteration slice Recall@3
- Short noisy query slice Recall@3

### Deliverables

- `data/noisy-entity-benchmark.jsonl`
- `scripts/eval/run-noisy-entity-eval.ts`
- CI or nightly report slice

### SOTA++ notes

- benchmark는 general search eval과 분리된 first-class artifact로 관리한다.
- 단순 정답률보다 “잘못된 확신”과 “애매할 때 멈추는 능력”을 같이 측정한다.
- transliteration / abbreviation / near-miss는 별도 slice로 추적한다.

---

## Step 18.2 — Multi-View Normalization Layer

### 목표

한 query를 단일 normalized string으로 끝내지 않고, 여러 normalization view를 생성한다.

### Required views

```typescript
interface NormalizedQueryViews {
  readonly raw: string;
  readonly strict: string;
  readonly accentless: string;
  readonly collapsedWhitespace: string;
  readonly punctuationStripped: string;
  readonly compact: string;           // e.g. "opusone"
  readonly vintageStripped: string;   // e.g. "opus one"
  readonly transliterated?: string;
}
```

### 포함할 규칙

- Unicode normalization
- case folding
- accent stripping
- punctuation removal
- whitespace collapse
- whitespace removal variant
- vintage token canonicalization (`18` ↔ `2018`)
- Korean/Latin mixed normalization
- producer/label token reordering variant
- abbreviation expansion hints
- punctuation-heavy noisy input cleanup

### Deliverables

- `src/domain/query/service/query-normalizer.ts`
- normalization unit tests
- planner / matcher integration

### Design constraints

- normalization은 destructive transform 하나로 끝내지 않는다.
- 각 normalized view는 provenance와 함께 downstream matcher에 전달된다.
- security guard 이후에 적용되어 injection-safe contract를 보존한다.

---

## Step 18.3 — Multi-Stage Candidate Generation

### 목표

entity candidate generation을 한 단계가 아니라 recall funnel로 설계한다.

### Candidate funnel

```text
Stage A: exact alias lookup
Stage B: normalized alias lookup
Stage C: prefix / subsequence token lookup
Stage D: char n-gram lexical fuzzy retrieval
Stage E: edit-distance fallback
Stage F: semantic fallback for noisy entity names
```

### 원칙

- 앞 단계가 실패해도 다음 단계가 이어받아야 함
- 각 stage는 provenance를 남겨야 함
- noisy stage는 precision보다 recall 우선
- candidate source별 score와 explanation이 trace에 남아야 함
- semantic fallback은 lexical / phonetic 후보를 대체하는 게 아니라 마지막 보조 단계여야 함

### Deliverables

- `src/domain/alias/service/noisy-entity-candidate-generator.ts`
- char n-gram index or equivalent lexical fuzzy adapter
- candidate provenance in resolver trace

### SOTA++ notes

- 첫 구현의 핵심은 char n-gram lexical recall이다.
- BK-tree 또는 bounded edit-distance retrieval은 후속 최적화로 두되, 초기 ROI는 char-level recall이 더 크다.
- semantic fallback은 entity name lookup에서는 gated mode로 운영한다.

---

## Step 18.4 — Transliteration and Phonetic Matching

### 목표

음차 / 약식 발음 / 악센트 제거 표기에 robust하게 대응한다.

### 범위

- Korean phonetic approximations for common wine names
- English/French accentless forms
- abbreviation handling (`drc`, `opus`, `moet`)
- phonetic key generation for candidate recall
- curated transliteration exception list + human-approved expansions

### Examples

```text
모엣샹동  -> Moet Chandon
샤또마고  -> Chateau Margaux
romane conti -> Romanee-Conti
```

### Deliverables

- `src/domain/alias/service/phonetic-normalizer.ts`
- `src/domain/alias/service/transliteration-matcher.ts`
- tests for KR/EN/FR variants

### SOTA++ notes

- phonetic/transliteration layer는 “정답 생성”보다 “후보 recall 강화” 역할로 먼저 도입한다.
- deterministic rules + curated exceptions 조합으로 시작하고, feedback loop로 보강한다.
- 한국어 음차는 와인/생산자 고유명사 recall에 큰 기여를 하는 독립 축으로 본다.

---

## Step 18.5 — Learned Entity Matcher Upgrade

### 목표

넓게 모은 noisy candidates를 learned matcher가 최종적으로 정렬하게 한다.

### 추가 feature 예시

- exact / normalized / fuzzy / phonetic score
- token coverage
- char n-gram overlap
- producer overlap
- vintage consistency
- alias provenance quality
- popularity prior
- language/script compatibility

### Deliverables

- learned matcher feature schema update
- candidate ranking integration
- offline eval improvements vs heuristic-only baseline

### Modeling intent

- heuristic은 후보를 넓게 만들고, learned matcher는 ordering과 confidence를 안정화한다.
- feature에는 alias provenance tier, generation source, script/language compatibility를 포함한다.
- 목표는 “억지로 하나를 맞춘다”가 아니라 “맞을 때 confidently choose, 아니면 abstain”이다.

---

## Step 18.6 — Confidence and Ambiguity Gate

### 목표

애매한 short noisy query에서 틀린 exact match를 내지 않도록 한다.

### Rule examples

- top1-top2 gap below threshold → abstain
- alias collision with weak confidence → ambiguity
- producer-only short query → no forced exact resolve
- noisy abbreviation with many candidates → ask for clarification

### Deliverables

- ambiguity gate policy update
- benchmark slices for false exact match
- calibration report

### SOTA++ notes

- short query, abbreviation, producer-only query는 별도 prior와 threshold를 둔다.
- top1 confidence가 높아도 top2 gap이 작으면 overconfident exact resolve를 피한다.
- 이 단계는 recall을 해치지 않고 precision을 지키는 핵심 안전장치다.

---

## Step 18.7 — Feedback Flywheel

### 목표

시간이 갈수록 entity lookup이 더 강해지도록 query-log 기반 alias learning loop를 만든다.

### 수집할 것

- failed entity queries
- reformulated queries
- clicked entity after noisy query
- human-approved aliases
- suppressed bad aliases

### 적용할 것

- observed_query_alias proposal
- noisy_recall alias promotion
- bad alias suppression
- benchmark refresh
- active review queue for high-impact aliases

### Deliverables

- alias proposal pipeline extension
- reviewable noisy alias suggestions
- feedback-to-benchmark sync rule

### SOTA++ notes

- query reformulation과 clickthrough는 noisy alias 후보를 만들기 위한 가장 중요한 weak supervision 신호다.
- alias promotion은 precision tier를 유지한 staged rollout이어야 한다.
- feedback loop가 없으면 noisy entity lookup 성능은 초반 이후 쉽게 정체된다.

---

## 구현 순서

1. Noisy benchmark
2. Multi-view normalization
3. Multi-stage candidate generation
4. Transliteration + phonetic layer
5. Learned matcher upgrade
6. Confidence / ambiguity gate
7. Feedback flywheel

### Rollout policy

각 단계는 아래 조건을 만족할 때만 다음 단계로 넘어간다.

1. noisy benchmark 핵심 slice가 baseline 이상이다.
2. false exact match rate가 악화되지 않는다.
3. short noisy query abstain precision이 baseline 아래로 떨어지지 않는다.
4. resolver trace에서 candidate provenance가 확인 가능하다.

---

## 완료 기준

### Quality

- noisy entity Recall@1 ≥ 0.82
- noisy entity Recall@3 ≥ 0.92
- transliteration subset Recall@3 ≥ 0.90
- abbreviation subset Recall@3 ≥ 0.90

### Safety

- false exact match rate baseline 대비 증가 없음
- ambiguous short noisy query abstain precision ≥ 0.90

### Engineering

- benchmark + eval script 존재
- retrieval trace에 candidate provenance 기록
- 기존 exact alias behavior regression 없음
- typecheck / focused tests / eval slices 통과
- offline eval report와 runtime trace가 같은 실패 패턴을 설명할 수 있음
- 새 normalization / alias / matcher feature가 provenance 기준으로 디버깅 가능함

---

## 비목표

아래는 이 epic의 범위 밖이다.

- general recommendation quality 전체 재설계
- watchlist / async infrastructure
- OpenAPI / transport docs 전면 정리
- LTR 전체 재학습 시스템 개편

이 epic은 오직 **robust entity lookup quality**에 집중한다.

---

## 연구 질문

1. char n-gram lexical recall과 phonetic recall의 조합이 현재 catalog에서 가장 큰 이득을 주는가?
2. transliteration candidate expansion이 false positive를 얼마나 증가시키는가?
3. short noisy query에서 popularity prior를 어느 정도까지 허용해야 하는가?
4. semantic fallback을 entity lookup에 허용할 때 precision 손실 없이 쓸 수 있는 안전한 gate는 무엇인가?
5. runtime query logs에서 alias를 자동 승격할 때 어느 tier까지 human review가 필요한가?
