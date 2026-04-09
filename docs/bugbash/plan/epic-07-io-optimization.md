# Epic 07 — I/O·알고리즘 최적화 → Retrieval Latency Gate

**Phase:** A (기반, Week 0/Phase A 경계)
**우선순위:** P1
**의존:** Epic-01, Epic-02
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

Reranker든 ColBERT든 heavier ranking stage를 추가하려면 기존 파이프라인에서 latency budget을 **먼저 벌어야** 한다.

현재 `CandidatePool.generate`가 순차 await로 ~600ms+ 소비. 병렬화로 ~240ms 절감 가능 → Reranker 예산 확보.

**업계 SOTA:**
- Google: Scatter-gather retrieval (모든 shard 병렬)
- Elasticsearch: Per-shard parallel query → reduce
- Vespa: Built-in scatter-gather (이미 사용 중이지만 클라이언트 측 순차)

---

## Task 목록

### T07-1. `CandidatePool.generate` 병렬화

**현재:** sparse → learnedSparse → embed → dense → anchor 순차

**변경:**
```typescript
// 독립 작업 병렬
const [sparseResults, embedding] = await Promise.all([
  Promise.all([this.sparseSearch(...), this.learnedSparseSearch(...)]),
  this.embedQuery(...)
]);
// embedding 의존 작업
const denseResults = await this.denseSearch(embedding);
```

**예상:** ~40% latency 절감 → 후속 ranking 실험 예산 확보

### T07-2. Batch Document Retrieval

`getDocument` N회 → `getDocuments(ids[])` 배치.
**SOTA 의미:** N+1 패턴 제거는 DB 최적화 기본.

### T07-3. O(n^2) → Set/Map

`.includes()` → `Set.has()` (4곳).

### T07-4. 핫패스 Allocation 제거

signal-computer per-candidate `new Set()`, transliterator per-word sort → 모듈/쿼리 레벨.

### T07-5. Regex 사전 컴파일

agent-tools O(N*M), claim-extractor per-call regex → 모듈 스코프.

### T07-6. `file-mapping-table` 비동기

`readFileSync` → async + startup 캐싱.

### T07-7. `bulkFeed` 동시성 제한

무제한 concurrent PUT → `pLimit(10)`.

### T07-8. 알고리즘 개선

- `span-parser` O(n*k) → sorted scan
- `query-normalizer` O(n!) permutation → 상한 cap
- `entity-resolver` per-call sort → build-time pre-sort
- `hybrid-candidate-summary` linear scan → `Map<entityId, summary>`
- Double sort → sort once

---

## Latency Budget 계산

| Stage | 현재 (est.) | 목표 | 절감 |
|-------|------------|------|------|
| Sparse search | 80ms | 80ms | — |
| Dense embed | 100ms | 100ms (parallel w/ sparse) | -100ms |
| Dense search | 80ms | 80ms | — |
| Learned sparse | 80ms | 80ms (parallel w/ sparse) | -80ms |
| Anchor | 60ms | 60ms (parallel w/ dense) | -60ms |
| **Subtotal** | ~400ms sequential | ~160ms parallel | **-240ms** |
| Reranker (new) | — | +300ms | +300ms |
| **Net** | ~400ms | ~460ms | +60ms acceptable |

---

## 완료 조건

- `CandidatePool.generate` 독립 I/O가 `Promise.all`로 병렬
- Retrieval latency p99 < 200ms (reranker 제외)
- 후속 reranker / late-interaction stage를 올릴 예산 확보
