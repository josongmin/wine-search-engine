# Epic 8: Entity Index Surface (Producer/Region First-class)

**Phase:** 2 (Retrieval Mode & Entity Surface)
**RFC:** RFC-017 §8.1 + RFC-001 확장
**의존성:** Epic 7 (retrieval mode contract)
**블록하는 Epic:** 9, 10

---

## 목표

Producer/Region이 wine entity를 통해서만 간접 검색되는 현재 구조를 확장.
"안티노리", "마고", "나파" 같은 쿼리에서 entity type confusion 없이 정확한 결과 반환.

## 이미 존재하는 것

| 컴포넌트 | 상태 | 비고 |
|---|---|---|
| Entity types 5종 | ✅ `wine/vintage/producer/region/grape` 도메인 모델 |
| `EntitySummary.type` | ✅ 결과에 entity type 포함 |
| Vespa `wine_entity` schema | ✅ producer, region, appellation 필드 있음 |
| Producer/Region as **indexed documents** | ❌ wine_entity만 존재 |

**핵심 gap:** 도메인 모델에 5개 entity type이 있지만 Vespa에는 wine_entity 인덱스만 있음.
"안티노리" 검색 시 producer document가 아니라 Tignanello 하나만 반환됨.

## 설계 옵션

### Option A — wine_entity 인덱스 유지 + aggregation layer (권장)

물리 인덱스를 쪼개지 않고, retrieval 결과를 application layer에서 grouping.

```
"안티노리" 검색:
1. BM25(producer="Antinori") → wine_entity 후보 N개
2. Application layer: group by producer
3. 반환: { result_type: "producer_set", wines: [...], producer_summary: {...} }
```

장점:
- Vespa schema 변경 없음
- 인덱스 하나로 관리
- Silver ETL 파이프라인 변경 최소

단점:
- Producer/Region에 대한 rich metadata (설립 연도, 소유주 등)를 wine entity에 담기 어려움

### Option B — Producer/Region 별도 인덱��

```
vespa/app/schemas/producer_entity.sd
vespa/app/schemas/region_entity.sd
```

장점: entity type별 dedicated search
단점: 인덱스 관리 복잡, federated retrieval 필요

### 결정: Phase 2에서는 Option A. Option B는 Phase 4 이후 검토.

## 작업 항목 (Option A 기준)

### 8.1 Query Target Type Inference

Planner에서 query가 어떤 entity type을 찾는지 추론:

```typescript
type QueryTargetType = 'wine' | 'producer' | 'region' | 'style' | 'unknown';

// 추론 규칙:
// "안티노리" + no vintage + no wine-specific term → producer
// "마고 2015" + vintage → wine
// "나파 까쇼" + region + grape → region (browse)
// "묵직한 레드" + style only → style (attribute search)
```

### 8.2 Result Grouping Service

**파일:** `src/domain/response/service/result-grouper.ts`

```typescript
interface GroupedResult {
  resultType: 'single_entity' | 'producer_set' | 'region_set' | 'style_set';
  groupKey?: string;      // producer name, region name
  items: ResultItem[];
  summary?: {
    totalInGroup: number;
    displayedCount: number;
    commonAttributes: Record<string, string>;  // 공통 속성 (region, style 등)
  };
}
```

### 8.3 Browse Retrieval Strategy

```
producer_browse mode:
  1. BM25 producer field exact match
  2. popularity 내림차순 정렬
  3. diversity: 같은 wine line 중복 제거 (e.g., Tignanello 2017, 2018 → 가장 최근만)
  4. result_type = "producer_set"

region_browse mode:
  1. BM25 appellation/region field match
  2. producer diversity 우선 (같은 region 다른 producer)
  3. result_type = "region_set"
```

## Deliverables

- [ ] `QueryTargetType` 타입 + planner 추론 로직
- [ ] `src/domain/response/service/result-grouper.ts`
- [ ] Browse retrieval strategy (producer/region)
- [ ] "안티노리" → producer_set, "마고" → disambiguation, "나파 까쇼" → region_set

## 완료 기���

- [ ] "안티���리" → producer wine set 반환 (single wine이 아님)
- [ ] "마고" → entity type disambiguation 또는 appellation browse
- [ ] Entity type confusion false resolve rate < 5% (golden query subset)
