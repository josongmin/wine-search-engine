# Epic 10: Similar / Compare / Browse Retrieval

**Phase:** 3 (LLM Envelope & Set Retrieval)
**RFC:** RFC-017 §8.3 + RFC-011/012 확장
**의존성:** Epic 7 (retrieval mode), Epic 8 (entity surface)
**블록하는 Epic:** 11

---

## 목표

단일 entity resolve 외의 set retrieval을 first-class mode로 구현.
similar / compare / browse가 top-k 재활용이 아니라 명시적 mode로 동작.

## 이미 존재하는 것

| 컴포넌트 | 상태 | 비고 |
|---|---|---|
| Mixed solver (similar_items) | ✅ 완전 구현 | anchor profiling → similar retrieval → constraint overlay |
| Anchor profiler | ��� | region/grapes/body/sweetness/embedding 추출 |
| `vespa-similar-retrieval.ts` | ✅ | Dense ANN for anchor-based search |
| `comparison_search` intent | ✅ 인식됨 | 하지만 전용 retrieval strategy 없음 |
| Producer browse | ❌ | BM25 producer match → grouping 필요 |
| Region browse | ❌ | BM25 region match → grouping + diversity 필요 |
| Compare candidates | ❌ | multi-entity attribute comparison 없음 |

## 작업 항목

### 10.1 Producer Browse

```
쿼리: "안티노리 대표 와인들"
  1. target_type = producer (Epic 8)
  2. retrieval_mode = producer_browse (Epic 7)
  3. BM25(producer="Antinori", weight=3.0)
  4. 결과를 popularity 내림차순 정렬
  5. Diversity: 같은 wine line 최근 vintage만
  6. 반환: result_type = "entity_set"
```

**파일:** `src/domain/retrieval/service/browse-retriever.ts`

### 10.2 Region Browse

```
쿼���: "보르도 1등급 대표작"
  1. target_type = region
  2. retrieval_mode = region_browse
  3. BM25(appellation="Bordeaux") + structured filter(classification="Premier Cru")
  4. Producer diversity 우선 (같은 region 다른 producer)
  5. 반환: result_type = "entity_set"
```

### 10.3 Compare Candidates

```
쿼리: "안티노리 vs 사시카이아"
또는: "나파 cabernet 후보 5개 비교"
  1. retrieval_mode = compare_candidates
  2. 복수 entity resolve 또는 attribute search
  3. Comparable fields 추출: body, tannin, price, region, grape
  4. 비교 테이블 format 반환
```

**반환 구조:**

```typescript
interface ComparisonResult {
  resultType: 'comparison';
  candidates: Array<{
    entity: EntitySummary;
    attributes: Record<string, string | number>;  // body, tannin, price, ...
  }>;
  comparisonAxes: string[];  // ["body", "tannin", "price_usd", "region"]
}
```

### 10.4 Similar Items 개선

기존 mixed-solver 위에:
- seed entity가 결과에서 제외되는 것 보장
- diversity constraint: 같은 producer 최대 2개
- price constraint: "더 저렴한 것" → price < anchor.price

### 10.5 Set Retrieval Quality Signals

`signal-computer.ts` 확장:

```typescript
// set retrieval mode에서만 활성화되는 signal
intraSetDiversity: number;    // 1 - (most common producer ratio)
setCoverage: number;          // relevant set 중 반환 비율
anchorPreservation: number;   // similar mode: style proximity to anchor
```

## Deliverables

- [ ] `src/domain/retrieval/service/browse-retriever.ts`
- [ ] `src/domain/retrieval/service/compare-retriever.ts`
- [ ] Mixed solver 개선 (diversity, price constraint)
- [ ] Set retrieval signals in signal-computer
- [ ] search.usecase.ts에 mode 분기 추가

## 완료 기준

- [ ] "안티노리 대표 와인" → 3+ distinct wines 반환 (단일 wine 아님)
- [ ] "보르도 1등급" → 3+ different producers 반환
- [ ] "opus one 비슷한 거" → Opus One 제외, diverse alternatives
- [ ] "나파 cabernet 비교" → comparison table 반환
- [ ] set_retrieval.recall_at_10 ≥ 0.60 (golden query subset)
