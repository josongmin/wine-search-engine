# Epic 10 — Real LTR: LightGBM LambdaMART + Vespa-Native Serving

**Phase:** B (학습 점화)
**우선순위:** P1
**의존:** Epic-13 (human-gated eval + retrieval ceiling), Epic-04 (feature log), Epic-05 (deterministic ranking contract)
**2026 라벨:** `STRONG_BASELINE`
**학습 필요:** `필수 학습 필요`

---

## 현재 상태의 솔직한 진단

### "LambdaMART"는 LambdaMART가 아니다

`lambdamart-ranker.ts` 코드 감사 결과:

| 측면 | 현재 코드 | 진짜 LambdaMART |
|------|----------|-----------------|
| **모델 클래스** | **Linear model** (weight vector + bias) | Gradient-boosted tree ensemble (100-1000 trees) |
| **Feature 수** | 8 | 50-500 |
| **Loss** | RankNet (pairwise logistic) | Lambda (NDCG-weighted pairwise + **|ΔnDCG| scaling**) |
| **학습** | Mini-batch SGD | Sequential boosting |
| **비선형성** | **없음** | Tree splits → feature interaction 학습 가능 |
| **후처리** | L1 normalize (decision boundary 파괴) | 없음 (tree ensemble은 정규화 불필요) |

**핵심 문제:** Linear model은 feature interaction을 학습 불가. "high BM25 + high semantic = superlinear boost" 같은 패턴을 캡처 못함.

### 3개 weight space가 분리되어 있다

1. `scoring-weights.ts` — 14차원 × 7 class = **100 magic numbers**
2. `mode-weights.ts` — 10차원 × 9 mode = **90 magic numbers**
3. `lambdamart-ranker.ts` — 8차원 linear (미활성)

이 3개가 독립적으로 존재하고 어떤 것도 데이터 기반이 아님.

### Vespa의 SOTA 기능을 충분히 활용하지 않고 있다

Vespa는 **native LightGBM 모델 평가**를 first-class로 지원:
- `rank-profile`에서 직접 LightGBM JSON 모델 로딩
- `second-phase` ranking으로 top-K만 heavy model 적용
- `global-phase`로 cross-document diversity 적용
- **ONNX inference** in rank profile

현재 codebase에는 second-phase / rerank infrastructure가 일부 존재하지만, **real LambdaMART + train/serve parity + milestone 분리**가 안 되어 있다.

---

## Gate

이 epic은 아래 조건을 만족할 때만 시작한다.

1. `Epic-13` 완료
   - `Recall@20/50/100`, `Oracle NDCG@10`, `Oracle MRR` 산출 가능
   - human-reviewed gold split 존재
   - train/serve feature parity 체계 존재
2. `Epic-05` 완료
   - deterministic rank / tie-break contract 확보
3. retrieval ceiling 분석상 **ranking이 병목인 slice가 식별됨**

---

## Task 목록

### T10-1. Offline LightGBM LambdaMART 학습 파이프라인 구축

**현재:** `lambdamart-ranker.ts`의 linear SGD → **삭제 또는 fallback으로 강등**

**변경:**
- Python 학습 스크립트: `scripts/ltr/train-lightgbm-lambdamart.py`
- LightGBM `lambdarank` objective, NDCG@10 metric
- Feature: 현재 8개 → 확장 (아래 T10-5)
- Hyperparameter sweep: `num_leaves ∈ [31,63,127]`, `learning_rate ∈ [0.01,0.05,0.1]`, `num_trees ∈ [100,300,500]`
- 5-fold cross-validation, per-query-class
- 모델 출력: LightGBM JSON format (Vespa 호환)

**학계 근거:**
- Burges (2010) "From RankNet to LambdaRank to LambdaMART" — |ΔnDCG| weighting이 핵심
- LightGBM (Ke et al., 2017) — leaf-wise growth, histogram-based split, state-of-the-art GBDT

**산출물:**
- offline baseline vs candidate model ablation
- per-query-class gain/loss report
- feature importance / SHAP snapshot

---

### T10-2. Serve Parity 검증

offline win이 있어도 train/serve skew가 있으면 production에 올릴 수 없다.

**변경:**
- offline feature extractor와 online Vespa matchfeatures 간 schema parity 검증
- feature hash mismatch 시 배포 reject
- sample query set에서 offline score와 online score 상관 검증

---

### T10-3. Vespa-Native LTR Serving

**현재:** Application-side ranking (network round-trip + Python→JS 미스매치)

**변경:**
```
# Vespa rank-profile에 LightGBM 모델 직접 배포
rank-profile ltr-lambdamart {
    first-phase {
        expression: 0.5 * bm25(search_text_en) + 0.5 * closeness(field, embedding)
    }
    second-phase {
        expression: lightgbm("wine_ranker_v1.json")
        rerank-count: 50
    }
}
```

**장점:**
- Network round-trip 제거 → latency 감소
- Vespa가 feature extraction + model evaluation 한번에 처리
- Train-serve skew 감소 (동일한 feature를 Vespa가 계산)

**학계/업계 근거:**
- Vespa 공식 문서: "Using machine-learned models in ranking"
- Airbnb (2019) "Applying Deep Learning To Airbnb Search" — Vespa에서 직접 모델 서빙

---

### T10-4. 3개 Weight Space → Unified LTR

**현재:** scoring-weights(14D) + mode-weights(10D) + linear-LTR(8D)

**변경:**
1. hand-tuned signals를 LightGBM feature로 통합
2. `mode`는 categorical / routed feature로 편입
3. `score-aggregator.ts`의 선형 합산은 fallback path로 강등

**주의:** fallback weight는 유지하되 **primary ranking authority는 model**로 전환한다.

---

### T10-5. Feature Engineering 확장

**현재 8 features → 목표 30+ features**

| Category | Features | 비고 |
|----------|----------|------|
| Retrieval | bm25Score, semanticScore, sparseRank, denseRank | Vespa / retrieval outputs |
| Constraint | constraintSatisfactionRatio, hardConstraintCount, softConstraintCount | existing |
| Entity | anchorSimilarity, entityIntegrity, producerPrestige | existing |
| Quality | criticScore, recency, vintageOptimality | existing |
| Query | queryLength, constraintCount, anchorConfidence, queryClass | planner-derived |
| Cross | queryTermOverlap, fieldMatchScore | matchfeatures |
| Multilingual | multilingualScore, hasKoreanQuery | existing |
| Degradation | degradation mask/vector | Epic-12 연계 |

---

### T10-6. Dead Feature 정리

| Feature | 현재 | 변경 |
|---------|------|------|
| `preferenceAlignment` | 항상 0.5 | weight=0, Epic-18에서 복원 |
| `availability` | 항상 1.0 | weight=0, 재고 데이터 시 복원 |
| `diversityPenalty` | primary ranking 미사용 | LTR feature로 포함 |

---

### T10-7. `clamp01()` 남용 정리

18곳 중간 signal clamp → 제거. LTR feature는 raw 값 그대로 (모델이 비선형성 학습).
최종 출력만 clamp.

---

### T10-8. Optional Reranker는 별도 Milestone으로 분리

이전 문서의 `Cohere Rerank`는 같은 epic 안에 있었지만, **LTR win과 vendor reranker win은 분리해야 한다.**

**원칙:**
- M1: offline model win
- M2: Vespa-native serving parity
- M3: optional external reranker / ColBERT / cross-encoder

**변경:**
- `RerankPort`는 유지
- external reranker는 `Epic-16` late-interaction / reranker 실험과 함께 별도 ablation으로 평가
- LightGBM 품질이 검증되기 전에는 reranker를 이 epic의 성공 조건에 포함하지 않음

---

### T10-9. Model Quality Gate

- Model NDCG@10 < hand-tuned baseline → auto-reject
- Oracle gap 개선 없는 model → reject
- human gold split에서 regression 발생 시 reject
- Model age > 14d → `degraded` mode
- Model age > 30d → fallback to hand-tuned weights

---

## 완료 조건

- M1: offline LightGBM가 human gold split에서 hand-tuned baseline 초과
- M2: Vespa-native serving parity 검증 완료
- fallback weights는 남기되 primary scorer는 model
- feature 수 20+ 및 parity 체크 가능
- reranker는 **별도 milestone**으로만 승인
