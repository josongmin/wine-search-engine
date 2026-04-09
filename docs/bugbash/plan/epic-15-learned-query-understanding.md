# Epic 15 — Learned Query Understanding: HyDE + SetFit + Authority Handoff

**Phase:** B/C (단계적)
**우선순위:** P1
**의존:** Epic-13 (gold split + labeled data), Epic-11 (Wine KG), Epic-04 (query log)
**2026 라벨:** `STILL_SOTA` + `BRIDGE`
**학습 필요:** `부분 필요`

---

## 현재 상태의 솔직한 진단

### Intent Detection = Regex 9분기 if/else

`planner-intent-detection.ts`: 9개 branch, 2개 threshold (0.5, 0.85), ~20 regex 패턴.
- **확률 출력 없음** → downstream confidence 계산 불가
- **Paraphrase 불가** ("show me something like Opus One" → fallback semantic_discovery)
- **Branch 순서가 policy를 encode** — 코드 순서 변경 = 동작 변경

### 하지만 Query Normalizer는 강하다

Multi-view normalization (NFKC, accent, phonetic, Korean transliteration, reorder variants)는 진짜 잘 만들어져 있음. 이건 유지.

---

## 방법론 변경: Full BERT 대신 단계적 접근

이전 plan의 문제: T15-2에서 바로 XLM-RoBERTa fine-tune를 제안했지만, **training data가 없다** (T15-1에서 인정).

**bridge 원칙:** HyDE와 SetFit는 도입 가치가 크지만 장기 종착점으로 고정하지 않는다.
다음 단계(더 강한 multilingual router / joint intent+entity model)로 넘어갈 명시적 승격 조건이 있어야 한다.

### 수정된 순서 (감사 결과 기반)

1. **Wine KG 먼저** (Epic-11) — zero training data로 compositional inference 해결
2. **HyDE** — zero training data로 semantic retrieval 개선
3. **SetFit** (few-shot) — 500 examples로 intent classification
4. **Authority handoff** — learned model이 primary authority가 되는 단계
5. **Full fine-tune** — 2000+ examples 축적 후

---

## Task 목록

### T15-1. Intent Classification 학습 데이터 수집

**현재:** 없음

**변경:**
1. 기존 query log에서 regex cascade의 **불확실한 case** 수집 (여러 branch가 거의 fire할 뻔한 경우)
2. LLM-judged annotation: (query, correct_intent) — 500-1000 examples
3. Active learning: regex cascade와 모델 disagreement → human review

**저장:** `data/training/intent-classification/`

---

### T15-2. HyDE (Hypothetical Document Embeddings) — Phase B

**이유:** Semantic retrieval의 가장 큰 문제는 query-document vocabulary gap. "elegant wine for dinner" 같은 abstract query를 dense retrieval이 잘 못 잡음.

**방법 (Gao et al., 2022):**
```
Query: "elegant wine for dinner party"
  → LLM generates hypothetical wine description:
    "A refined Pinot Noir from Burgundy with silky tannins,
     bright cherry notes, and a long mineral finish..."
  → Embed this description (not the query)
  → Dense retrieval with this embedding
```

**구현:**
- `HyDEPort` 인터페이스 (domain)
- `LLMHyDEAdapter` (infra) — Anthropic/OpenAI로 hypothetical doc 생성
- Cache: query → hypothetical doc (common queries 사전 생성)
- Fallback: LLM unavailable → 기존 query embedding 사용
- 킬스위치: `KILL_SWITCH_HYDE`

**주의:** HyDE는 retrieval-side uplift이지 intent authority 해결책이 아니다.
이 단계의 승인은 `semantic_discovery` slice에서 **Recall@K / Oracle@K 개선**으로 측정한다.

---

### T15-3. SetFit Intent Classifier (Few-Shot) — Phase B

**이유:** SetFit (Tunstall et al., 2022)은 **8-64 examples per class**로 BERT-level 성능.

**방법:**
1. T15-1에서 수집한 500 examples 사용
2. SetFit: sentence-transformer + contrastive learning + logistic head
3. Python 학습 → ONNX export → Node.js inference

**출력:**
```typescript
interface IntentPrediction {
  intent: IntentType;
  confidence: number;        // calibrated probability
  distribution: Map<IntentType, number>;  // all class probabilities
}
```

**통합:**
- `IntentClassifierPort` 인터페이스
- `OnnxIntentClassifier` 어댑터
- Phase B에서는 regex를 **high-precision prior**로만 유지
- 모델은 confidence와 full distribution을 제공
- disagreement는 logging + hedge retrieval 후보로 보존

**학계 근거:** SetFit (Tunstall et al., 2022) — few-shot fine-tuning, 업계에서도 production 사용 (Hugging Face)

---

### T15-4. Query Reformulation Pipeline

**방법:**
1. HyDE (T15-2) — hypothetical document embedding
2. Acronym/alias expansion: "DRC" → "Domaine de la Romanée-Conti" (KG 기반, Epic-11)
3. Contextual expansion: "비슷한 와인" + session context → anchor wine으로부터 attribute 확장

---

### T15-5. 확률 기반 Intent → Hedge Routing

**현재:** Binary intent → deterministic routing

**변경:**
```typescript
// 70% entity_exact, 20% mixed_query, 10% semantic_discovery
// → parallel retrieve: entity + mixed + semantic (weighted by probability)
// → merge results
```

또는 simpler version:
```typescript
// Top-1 intent + confidence
if (prediction.confidence > 0.85) → single route (current behavior)
if (prediction.confidence < 0.85) → hedge: run top-2 intents, merge
```

---

### T15-6. Authority Handoff — Phase C 핵심

이전 문서의 가장 큰 문제는 learned QU가 영구적으로 regex 보조기기로 남는 것이었다.

**최종 목표:**
- regex = high-precision prior / guardrail
- learned model = primary intent authority
- route 결정은 learned probability + hedge policy 기반
- regex-only path는 model unavailable 시 fallback으로만 허용

**승인 조건:**
- human gold split에서 regex baseline보다 우수
- catastrophic slice regression 없음
- disagreement audit 결과 허용 범위 내

---

### T15-7. Query Suggestion / Autocomplete

learned QU를 UX에 연결하는 얇은 layer.

**변경:**
- zero-result / ambiguous query에서 suggestion 생성
- KG alias / popular reformulation / typo-corrected variant 제공
- query log 기반 auto-complete 후보 학습

---

### T15-8. Full XLM-RoBERTa (장기, 2000+ examples 후)

- Joint intent + NER (DIET-style)
- Korean + English unified model
- 이건 SetFit가 한계를 보이거나 2000+ examples 축적 후에만 진행

---

## 완료 조건

- HyDE: `semantic_discovery` slice에서 recall/oracle 개선 확인
- SetFit: calibrated probability 출력
- Phase B: learned model + regex prior + hedge routing 동작
- Phase C: regex-only 단독 권한 제거, learned model이 primary authority
- Intent prediction에 calibrated probability 출력
- model unavailable 시에만 regex-only fallback 허용
