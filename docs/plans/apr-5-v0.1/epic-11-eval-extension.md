# Epic 11: Eval Extension (Retrieval Mode별)

**Phase:** 3 (LLM Envelope & Set Retrieval)
**RFC:** RFC-017 §3.3 + RFC-009 확장
**의존성:** Epic 7 (mode tag), Epic 9 (envelope), Epic 10 (set retrieval)
**블록하는 Epic:** 없음 (Phase 3 마지막)

---

## 목표

"NDCG 좋음"이 아니라 "어떤 검색 모드가 약한지" 보이는 eval.
retrieval_mode별 / entity_type별 / scenario별 분리 metric.

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| Epic 3 eval pipeline | ✅ (Phase 1에서 구축) |
| 시나리오별 4축 metric | ✅ entity_resolve, ranking_quality, set_retrieval, no_match |
| Decision Utility scoring | ✅ unit test 존재 |
| Selective predictor (AURC) | ✅ unit test 존재 |

## 추가 slice 축

### By Retrieval Mode

```typescript
type ModeSliceMetrics = Record<RetrievalMode, {
  primary: number;    // mode별 primary metric
  wrong_top1: number;
  recall_at_10: number;
  query_count: number;
}>;
```

Mode별 primary metric:
- entity_lookup: MRR@10
- entity_resolution: abstain correctness
- attribute_search: NDCG@10
- constraint_filter: constraint satisfaction rate
- producer_browse: set_coverage
- region_browse: set_coverage + producer_diversity
- similar_items: anchor_preservation + diversity
- compare_candidates: comparable_set_precision
- recommendation: NDCG@10 + diversity
- no_match_detection: abstain_precision

### By Entity Target Type

```typescript
type EntityTargetSlice = Record<QueryTargetType, {
  confusion_rate: number;    // target_type 오인율
  resolve_precision: number;
}>;
```

### Mode-specific Metrics

```typescript
// Browse mode
browseMetrics: {
  setCoverage: number;           // relevant set 중 반환 비율
  intraSetDiversity: number;     // 1 - most_common_producer_ratio
  producerVariety: number;       // unique producers / total results
};

// Similar mode
similarMetrics: {
  anchorPreservation: number;    // style proximity to anchor
  seedExclusion: boolean;        // seed entity 결과에서 제외 여부
  priceConstraintSatisfaction: number;  // "더 저렴한" 충족률
};

// Compare mode
compareMetrics: {
  comparableSetPrecision: number;  // 비교 가능한 후보가 실제 비교 가능한 비율
  attributeCoverage: number;       // 비교 축 중 non-null 비율
};
```

## 작업 항목

- [ ] Golden query set에 `retrieval_mode` tag 추가 (Epic 7과 연동)
- [ ] `run-offline-eval.ts` 확장: mode별 slice 출력
- [ ] Browse/Similar/Compare mode 전용 metric 함수
- [ ] Entity target type confusion rate 측정
- [ ] Release gate에 mode별 하한선 추가
- [ ] Eval dashboard: mode별 weakness 시각화 (JSON 기반)

## Release Gate 확장

```
기존 (Epic 3):
  wrong_top1_rate                > 0.02  → 차단
  entity_resolve.wrong_top1_rate > 0.03  → 차단
  set_retrieval.recall_at_10     < 0.60  → 차단

추가:
  producer_browse.set_coverage   < 0.50  → 차단
  similar_items.anchor_preservation < 0.60 → 차단
  entity_target.confusion_rate   > 0.10  → 경고
  compare.attribute_coverage     < 0.70  → 경고
```

## Deliverables

- [ ] `scripts/eval/run-offline-eval.ts` 확장 (mode slice)
- [ ] `scripts/eval/mode-metrics.ts` (browse/similar/compare 전용)
- [ ] Golden query set mode tag 완료
- [ ] Eval 결과 JSON에 mode breakdown 포함
- [ ] Release gate mode별 하한선 추가

## 완료 기준

- [ ] 모든 retrieval_mode에 대해 primary metric 측정 가능
- [ ] Entity type confusion rate 측정 가능
- [ ] "어떤 mode가 가장 약한지" 1분 내 파악 가능
- [ ] Mode별 release gate 동작 확인
