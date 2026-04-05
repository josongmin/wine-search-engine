# Wine Retrieval OS v0.3 — Robust Entity Lookup Plan

**날짜:** 2026-04-06  
**범위:** v0.2 이후 남는 핵심 품질 갭 중, “개떡같이 입력해도 올바른 와인 엔티티를 찾는 능력”을 독립 축으로 끌어올린다.  
**목표 상태:** typo / 음차 / 악센트 제거 / 붙여쓰기 / 약칭 / 빈티지 부분 입력을 포함한 noisy entity lookup에서 Recall@3 ≥ 0.92, 잘못된 강제 exact match는 증가시키지 않는다.

---

## 왜 v0.3인가

v0.1~v0.2는 검색 엔진 뼈대, retrieval modes, security, agentic layer를 구축하는 계획이었다.  
하지만 “사용자가 와인명을 부정확하게 입력해도 robust하게 엔티티를 찾는 문제”는 기능 조각으로만 흩어져 있었고, 독립적인 품질 epic로 관리되지 않았다.

이 v0.3는 그 갭을 별도 epic로 수렴한다.

SOTA++ 기준에서 이 문제는 단순 alias 보강이 아니라 아래 축이 함께 닫혀야 한다.

- multi-view normalization
- multi-stage candidate generation
- phonetic / transliteration robustness
- learned rerank for noisy entity resolution
- calibrated abstain / ambiguity control
- feedback flywheel from observed queries

즉 v0.3는 “검색 기능 추가”가 아니라, **robust entity lookup quality system**을 구축하는 계획이다.

---

## 핵심 갭

| 갭 | 현재 상태 | v0.3 해법 | Epic |
|---|---|---|---|
| Typo robustness | alias / normalized match 위주 | multi-stage fuzzy candidate generation | 18 |
| Transliteration / phonetic robustness | 일부 alias에 의존 | phonetic + transliteration retrieval layer | 18 |
| Noisy entity eval | 일반 검색 eval에 섞여 있음 | dedicated noisy entity benchmark | 18 |
| Candidate rerank for noisy entity | 일부 learned matcher / heuristic | learned entity matcher upgrade | 18 |
| Overconfident false exact match | 일부 ambiguity handling | confidence + ambiguity gate 강화 | 18 |
| Self-improving alias growth | observed alias 개념은 있음 | feedback flywheel + query-log alias mining | 18 |

---

## Phase 구조

### Phase 7 — Robust Entity Lookup

```
Epic 18: Robust Entity Lookup
```

**North Star:**
- 사용자가 `opusoe`, `romane conti`, `샤또마고`, `모엣샹동`, `drc 19`처럼 입력해도 top-k 안에 올바른 엔티티를 안정적으로 올린다.
- 잘못된 overconfident exact match보다 calibrated abstain / ambiguity를 우선한다.
- 실패/성공 로그가 다시 alias growth와 benchmark refresh로 흘러가는 self-improving loop를 만든다.

**완료 기준:**
- noisy entity benchmark Recall@1 ≥ 0.82
- noisy entity benchmark Recall@3 ≥ 0.92
- abbreviation / transliteration subset Recall@3 ≥ 0.90
- false exact match rate baseline 대비 악화 없음
- abstain precision ≥ 0.90 for ambiguous short noisy queries

---

## 의존성 그래프

```
v0.1 Epic 2 (golden queries)
  └─→ noisy entity benchmark bootstrap

v0.1 Epic 7 (retrieval modes)
  └─→ robust entity retrieval fallback integration

v0.2 Epic 13 (query intelligence)
  └─→ typo/phonetic handling 일부 재사용

v0.2 Epic 14 (API surface)
  └─→ retrieval override / decomposition metadata 연동 가능

v0.2 Epic 16 (security)
  └─→ noisy query handling과 별개로 injection-safe normalization guard 유지
```

---

## 기술 원칙

1. 후보 생성은 recall 우선의 funnel로 설계한다.
2. 최종 선택은 heuristic 하나가 아니라 learned confidence + ambiguity gate로 결정한다.
3. normalization은 단일 canonical string이 아니라 여러 query view를 생성해야 한다.
4. typo robustness와 transliteration robustness는 alias 사전 수작업에만 의존하지 않는다.
5. benchmark, offline eval, runtime logs가 같은 품질 루프를 형성해야 한다.

---

## 구현 원칙

### 1. Retrieval funnel 우선

우선 exact alias를 보되, 실패하면 normalized alias, lexical fuzzy, phonetic/transliteration, semantic fallback까지 이어지는 다단계 후보 생성 구조를 가진다.

### 2. Precision은 gate에서 지킨다

noisy recall을 올릴수록 false positive가 증가할 수 있으므로, top1-top2 gap, alias collision, short-query prior, vintage inconsistency를 gate에서 억제한다.

### 3. 품질 향상은 eval로 닫는다

새 matcher를 넣을 때마다 `Recall@K`뿐 아니라 false exact match rate, abstain precision, calibration drift를 함께 추적한다.

### 4. 운영 도입은 단계적으로

한 번에 전부 켜지 않고,

- normalization 강화
- char-level fuzzy recall
- phonetic / transliteration
- learned rerank
- alias mining feedback

순서로 rollout한다.

---

## 파일 구조

```
docs/plans/apr-6-v0.3/
├── 00-overview.md
├── epic-18-robust-entity-lookup.md
└── epic-18-execution-plan.md
```
