# Epic 7: Retrieval Mode Contract

**Phase:** 2 (Retrieval Mode & Entity Surface)
**RFC:** RFC-017 §8.3 + RFC-005/012 확장
**의존성:** Phase 1 Epic 3 (baseline eval 필요)
**블록하는 Epic:** 8, 9, 10, 11

---

## 목표

기존 `route` (entity/hybrid/mixed) 3개를 retrieval_mode 10개로 확장.
query router가 intent에서 mode를 결정하고, 각 mode가 다른 retrieval/ranking 전략을 사용.

## 이미 존재하는 것

| 컴포넌트 | 상태 | 비고 |
|---|---|---|
| `route: 'entity' \| 'hybrid' \| 'mixed'` | ✅ | 현재 3개 |
| `query_class` 7종 | ✅ | intent 분류 |
| `query_intent` 8종 | ✅ | entity_exact~mixed_query |
| Mixed solver (anchor similarity) | ✅ | "wines like X" 완전 구현 |
| Anchor profiler | ✅ | region/grapes/body/sweetness 추출 |

**핵심 gap:** `route`는 retrieval 전략만. "browse", "compare", "similar"가 없음.
query_intent에 `comparison_search`가 있지만 retrieval mode로 연결 안 됨.

## 설계

### RetrievalMode 타입

```typescript
type RetrievalMode =
  // === 기존 route와 1:1 매핑 ===
  | 'entity_lookup'          // route='entity' — single entity resolve
  | 'attribute_search'       // route='hybrid' — semantic/constraint search
  | 'similar_items'          // route='mixed' — anchor-based similarity (이미 구현)

  // === 신규 mode ===
  | 'entity_resolution'      // 모호한 entity → ambiguity surface
  | 'constraint_filter'      // hard constraint 중심 필터링
  | 'producer_browse'        // producer entity → wine set
  | 'region_browse'          // region/appellation → wine set
  | 'compare_candidates'     // 복수 entity 비교 테이블
  | 'recommendation'         // occasion/pairing 기반 탐색
  | 'no_match_detection';    // OOV / 존재하지 않는 entity
```

### Route와의 관계

```
retrieval_mode → route 매핑:
  entity_lookup       → entity
  entity_resolution   → entity
  attribute_search    → hybrid
  constraint_filter   → hybrid
  similar_items       → mixed (이미 구현)
  producer_browse     → hybrid (+ producer 필터)
  region_browse       → hybrid (+ region 필터)
  compare_candidates  → hybrid (multi-entity)
  recommendation      → hybrid
  no_match_detection  → entity (fail-fast)
```

### Planner 확장

`src/domain/query/service/planner.ts`의 `QueryPlanV1` 출력에 `retrieval_mode` 추가:

```typescript
interface QueryPlanV1 {
  // ... 기존 필드 유지
  route: QueryRoute;           // 기존: entity/hybrid/mixed
  retrievalMode: RetrievalMode; // 신규: 10개 mode
}
```

결정 로직:
```
query_intent = entity_exact + vintage present → entity_lookup
query_intent = entity_fuzzy + multiple candidates likely → entity_resolution
query_intent = entity_exact + producer name only → producer_browse
query_intent = facet_search + region keyword → region_browse
query_intent = comparison_search → compare_candidates
query_intent = pairing_search → recommendation
query_class = anchored_similarity → similar_items (기존 mixed)
anchor absent + constraints present → constraint_filter or attribute_search
```

### Ranking Weight Override

`scoring-weights.ts`에 mode별 weight preset 추가:

```
producer_browse:   popularity ↑, diversity ↑, entity_integrity ↓
region_browse:     diversity ↑, geographic_alignment ↑
compare_candidates: entity_integrity ↑, attribute_alignment ↑ (comparable)
recommendation:    preference_alignment ↑, pairing_signal ↑
```

## 작업 항목

- [ ] `RetrievalMode` 타입 정의 (`src/domain/shared/types/`)
- [ ] Planner에 mode 결정 로직 추가
- [ ] `QueryPlanV1`에 `retrievalMode` 필드 추가
- [ ] `scoring-weights.ts`에 mode별 preset 추가
- [ ] Golden query set에 `retrieval_mode` tag 추가
- [ ] SearchResponseV1에 `retrieval_mode` 노출

## 완료 기준

- [ ] 모든 golden query가 query_class + retrieval_mode 두 축으로 tag 가능
- [ ] "안티노리" → `producer_browse` mode 동작
- [ ] "오퍼스원 비슷한 거" → `similar_items` mode 동작 (기존)
- [ ] E2E: entity_lookup route 정상, browse route 정상
