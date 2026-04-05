# Epic 15: Drinking Window Inference

**Phase:** 5
**의존성:** Phase 4 complete (독립 병렬 가능)
**해소 갭:** Drinking window (6) — 부분 커버 → 완전 해소

---

## 목표

"언제 마시면 좋을까?" / "2015 빈티지 지금 마셔도 돼?" 쿼리에 대해
`drink_from` / `drink_to` 연도를 정확하게 예측한다.

### 기존 코드 상태 확인

Vespa mapping은 이미 `drinking_window_start` / `drinking_window_end` 필드를 지원한다:
```typescript
// src/infrastructure/vespa/mapping.ts
fields['drinking_window_start'] = doc.drinkingWindowStart;
fields['drinking_window_end'] = doc.drinkingWindowEnd;
```

`RetrievalDocument`에 `drinkingWindowStart?: number`, `drinkingWindowEnd?: number` 존재.

**따라서 Vespa 스키마 변경 없이** 기존 필드에 ML 예측값을 채운다.
필드 이름: `drinking_window_start` / `drinking_window_end` (Vespa) = `drinkingWindowStart` / `drinkingWindowEnd` (TypeScript)

---

## Step 15.1 — 훈련 데이터 수집

```typescript
// scripts/etl/collect-drinking-windows.ts

type DrinkingWindowRecord = {
  entity_id: string;
  vintage: number;
  grape_primary: string;       // "Cabernet Sauvignon"
  region: string;              // "Napa Valley"
  body: number;                // 1–5
  tannin: number;              // 1–5
  acidity: number;             // 1–5
  sweetness: number;           // 1–5
  drinking_window_start: number; // year (consistent with Vespa field name)
  drinking_window_end: number;
  source: 'cellartracker' | 'vivino_community' | 'llm_proxy';
};
```

### LLM Bootstrap (CellarTracker miss 시)

```
DRINKING_WINDOW_PROMPT = `
You are a master sommelier estimating when a wine is best to drink.

Wine: {canonicalLabel}
Grape: {grapePrimary}, Region: {region}, Vintage: {vintage}
Body: {body}/5, Tannin: {tannin}/5, Acidity: {acidity}/5

Respond ONLY with JSON:
{ "drinking_window_start": <year>, "drinking_window_end": <year>, "peak_year": <year>, "confidence": "high"|"medium"|"low" }

Rules:
- drinking_window_start >= vintage year
- peak_year must be between drinking_window_start and drinking_window_end
- confidence=low if vintage < 2010 or unusual region
`
```

---

## Step 15.2 — Feature Engineering

```typescript
// scripts/ml/drinking-window-features.ts

type LightGBMFeatureRow = {
  // Categorical (label-encoded + OOV bucket)
  grape_primary_enc: number;      // 훈련 시 저장된 LabelEncoder mapping 사용
  region_enc: number;
  country_enc: number;

  // Numeric
  vintage: number;
  body: number;           // 1–5
  tannin: number;         // 1–5
  acidity: number;        // 1–5
  sweetness: number;      // 1–5
  avg_critic_proxy_score: number;  // Epic 12 Step 12.1에서 채워진 필드

  // Interaction terms
  tannin_x_acidity: number;   // tannin * acidity
  body_x_tannin: number;
};
```

**LabelEncoder 버전 관리:**
- 인코더 매핑을 `scripts/ml/encoders/grape-encoder.json`, `region-encoder.json` 등으로 저장
- 모델 버전에 인코더 버전을 함께 pin (`DRINKING_WINDOW_MODEL_VERSION = 'v1.0-enc20260405'`)
- OOV(unknown) 값 → 별도 bucket (예: 999)

**두 개의 독립 회귀 모델:**
- `model_window_start`: 입력 → `window_start_offset` (drinking_window_start - vintage)
- `model_window_end`: 입력 → `window_end_offset`

LightGBM 설정 (Python):
```python
params = {
    'objective': 'regression_l1',   # MAE loss (outlier-robust)
    'learning_rate': 0.05,
    'num_leaves': 63,
    'min_child_samples': 20,
    'feature_fraction': 0.8,
    'n_estimators': 500,
}
# 목표: MAE(window_start_offset) ≤ 2.0 years
#       MAE(window_end_offset)   ≤ 3.0 years
```

---

## Step 15.3 — 모델 서빙: Node.js ONNX Runtime

```typescript
// src/infrastructure/ml/drinking-window-predictor.ts

import { InferenceSession, Tensor } from 'onnxruntime-node';

export const DRINKING_WINDOW_MODEL_VERSION = 'v1.0-enc20260405';

export interface DrinkingWindowInput {
  vintage: number;
  grapePrimaryEnc: number;
  regionEnc: number;
  countryEnc: number;
  body: number;
  tannin: number;
  acidity: number;
  sweetness: number;
  avgCriticProxyScore: number;
}

export interface DrinkingWindowPrediction {
  readonly drinkingWindowStart: number;   // aligns with Vespa/RetrievalDocument field name
  readonly drinkingWindowEnd: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion: string;
}

export class DrinkingWindowPredictor {
  private sessionStart!: InferenceSession;
  private sessionEnd!: InferenceSession;
  private initialized = false;

  async load(modelDir: string): Promise<void> {
    this.sessionStart = await InferenceSession.create(`${modelDir}/window_start.onnx`);
    this.sessionEnd = await InferenceSession.create(`${modelDir}/window_end.onnx`);
    this.initialized = true;
  }

  predict(input: DrinkingWindowInput): DrinkingWindowPrediction {
    if (!this.initialized) throw new Error('DrinkingWindowPredictor not loaded');

    const featureArray = this.toFeatureArray(input);
    const tensor = new Tensor('float32', featureArray, [1, featureArray.length]);

    const startOffset = this.runSync(this.sessionStart, tensor);
    const endOffset = this.runSync(this.sessionEnd, tensor);

    return {
      drinkingWindowStart: Math.round(input.vintage + Math.max(0, startOffset)),
      drinkingWindowEnd: Math.round(input.vintage + Math.max(startOffset + 1, endOffset)),
      confidence: input.avgCriticProxyScore > 90 ? 'high' : 'medium',
      modelVersion: DRINKING_WINDOW_MODEL_VERSION,
    };
  }

  private toFeatureArray(input: DrinkingWindowInput): Float32Array {
    return new Float32Array([
      input.grapePrimaryEnc,
      input.regionEnc,
      input.countryEnc,
      input.vintage,
      input.body,
      input.tannin,
      input.acidity,
      input.sweetness,
      input.avgCriticProxyScore,
      input.tannin * input.acidity,
      input.body * input.tannin,
    ]);
  }

  private runSync(session: InferenceSession, tensor: Tensor): number {
    // onnxruntime-node supports sync inference
    const result = session.runSync({ input: tensor });
    return (result['output']!.data as Float32Array)[0]!;
  }
}
```

**DrinkingWindowUseCase — 쿼리 타임 체크용 래퍼:**

```typescript
// src/application/drinking-window/drinking-window.usecase.ts

import type { DrinkingWindowPredictor, DrinkingWindowPrediction } from '../../infrastructure/ml/drinking-window-predictor.js';
import type { VespaClient } from '../../infrastructure/vespa/vespa-client.js';

export interface DrinkingWindowCheckRequest {
  readonly entityId: string;
  readonly targetYear?: number;   // 미지정 시 현재 연도
}

export interface DrinkingWindowCheckResult {
  readonly entityId: string;
  readonly drinkingWindowStart: number;
  readonly drinkingWindowEnd: number;
  readonly targetYear: number;
  readonly currentlyDrinkable: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion: string;
}

export class DrinkingWindowUseCase {
  constructor(
    private readonly vespaClient: VespaClient,
    private readonly predictor: DrinkingWindowPredictor,
  ) {}

  async check(request: DrinkingWindowCheckRequest): Promise<DrinkingWindowCheckResult> {
    const targetYear = request.targetYear ?? new Date().getFullYear();

    // 1. Vespa에서 기존 예측값 조회 (ETL로 미리 채워진 경우)
    const doc = await this.vespaClient.getById(request.entityId);
    if (doc?.drinkingWindowStart !== undefined && doc.drinkingWindowEnd !== undefined) {
      return {
        entityId: request.entityId,
        drinkingWindowStart: doc.drinkingWindowStart,
        drinkingWindowEnd: doc.drinkingWindowEnd,
        targetYear,
        currentlyDrinkable:
          targetYear >= doc.drinkingWindowStart && targetYear <= doc.drinkingWindowEnd,
        confidence: 'high',
        modelVersion: DRINKING_WINDOW_MODEL_VERSION,
      };
    }

    // 2. Fallback: 실시간 예측
    const features = this.extractFeatures(doc);
    const prediction = this.predictor.predict(features);
    return {
      entityId: request.entityId,
      ...prediction,
      targetYear,
      currentlyDrinkable:
        targetYear >= prediction.drinkingWindowStart && targetYear <= prediction.drinkingWindowEnd,
    };
  }

  private extractFeatures(doc: unknown): DrinkingWindowInput { /* ... */ }
}
```

---

## Step 15.4 — ETL: Vespa 기존 필드 채우기

```typescript
// scripts/etl/backfill-drinking-windows.ts
// 10K 문서 배치 처리: predictor.predict() → Vespa partial update
// 기존 필드 drinking_window_start / drinking_window_end 에 값 채움
// 배치 크기: 100, concurrency: 5 (Vespa rate limit 준수)
// 새로 추가되는 Vespa 필드:
//   drinking_window_confidence: string  (high|medium|low)
//   drinking_window_model_version: string
```

---

## Step 15.5 — Query-time 통합

### NLMapper 확장

```typescript
// src/domain/attribute/service/nl-mapper.ts 내 추가

// "지금 마시기 좋은", "now", "ready to drink"
// → NormalizedConstraint { attribute: 'drinking_window_now', operator: '=', value: true }

// "10년 후" → attribute: 'drinking_window_future_years', operator: '=', value: 10

// "2015 빈티지 언제 마셔?" → intent signal: askDrinkingWindow=true
//   (AnchorCandidate vintage=2015 + pairing_search intent 파생)
```

### ResultItem 확장

`ResultItem`에 선택적 `drinkingWindow` 필드 추가:

```typescript
// src/domain/response/model/result-item.ts 에 추가

export interface DrinkingWindowBlock {
  readonly drinkingWindowStart: number;
  readonly drinkingWindowEnd: number;
  readonly currentlyDrinkable: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
}
```

```typescript
export interface ResultItem {
  // ... 기존 fields ...
  /** Drinking window prediction, populated when available in Vespa document. */
  readonly drinkingWindow?: DrinkingWindowBlock | undefined;
}
```

### ResponseBuilder 통합

`mapRankedToResultItems()`에서 `RankedResult` → `ResultItem` 변환 시
`candidate.drinkingWindowStart` / `drinkingWindowEnd` (RetrievalDocument에서 전파)가 있으면
`drinkingWindow` 블록으로 매핑:

```typescript
// search.usecase.ts mapRankedToResultItems() 내

const drinkingWindow: DrinkingWindowBlock | undefined =
  candidate.drinkingWindowStart !== undefined && candidate.drinkingWindowEnd !== undefined
    ? {
        drinkingWindowStart: candidate.drinkingWindowStart,
        drinkingWindowEnd: candidate.drinkingWindowEnd,
        currentlyDrinkable:
          currentYear >= candidate.drinkingWindowStart &&
          currentYear <= candidate.drinkingWindowEnd,
        confidence: 'medium',
      }
    : undefined;

return { ...resultItem, ...(drinkingWindow !== undefined && { drinkingWindow }) };
```

### Vespa 필터링

```
// "지금 마실 수 있는 와인" → Vespa YQL filter:
// drinking_window_start <= {currentYear} AND drinking_window_end >= {currentYear}
```

---

## Completion Criteria

- [ ] 훈련 데이터 ≥ 5,000 레코드 (CellarTracker + LLM bootstrap)
- [ ] `model_window_start`: MAE ≤ 2.0 years on test set
- [ ] `model_window_end`: MAE ≤ 3.0 years on test set
- [ ] 10K Vespa 문서에 `drinking_window_start` / `drinking_window_end` backfill 완료
- [ ] "2015 Latour 지금 마셔도 돼?" → `currently_drinkable: true/false` 정확 반환
- [ ] "지금 마시기 좋은 나파 카베르네" → drinking window 필터 적용된 결과
- [ ] `DrinkingWindowUseCase.check()` DI 컨테이너에 등록
- [ ] `ResultItem.drinkingWindow` 필드 — exactOptionalPropertyTypes 준수 (undefined 대신 omit)
- [ ] ONNX inference latency ≤ 5ms p99 (single prediction)
- [ ] TypeScript strict 통과, lint clean
