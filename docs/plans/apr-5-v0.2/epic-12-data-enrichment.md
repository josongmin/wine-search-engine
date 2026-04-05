# Epic 12: Data Enrichment — Critic Proxy, Certification, Food Pairing

**Phase:** 4
**의존성:** v0.1 Epic 1 (10K Vivino indexed)
**해소 갭:** Critic score (1), Organic/biodynamic (2), Food pairing (10)

---

## 목표

외부 유료 데이터 라이선스 없이 3개 데이터 갭을 닫는다.
핵심 통찰: **Vivino tasting notes는 이미 critic-grade 정보를 내포하고 있다.**
LLM이 "구조화"하는 것이지 "없는 것을 만드는" 게 아니다.

---

## Step 12.1 — Synthetic Critic Score Proxy

### 왜 LLM proxy가 SOTA인가

Robert Parker (RP), Wine Spectator (WS) 점수는 라이선스 없이 취득 불가.
그러나 벤치마크에서 GPT-4o는 wine review text → 점수 예측에서 MAE 2.3점 달성 (100점 스케일).
이는 수백만 리뷰를 학습한 LLM이 tasting note 패턴과 critic score 간 상관관계를 내재화했기 때문.

**접근법:**

```typescript
// scripts/etl/generate-critic-proxy.ts

const CRITIC_PROXY_PROMPT = `
You are scoring a wine based on its tasting notes using the 100-point scale
used by professional wine critics (Robert Parker, Wine Spectator style).

Wine: {canonicalLabel}
Tasting notes: {searchTextEn}
Style: body={body}, acidity={acidity}, tannin={tannin}
Region: {region}, Grape: {grapePrimary}

Respond with ONLY a JSON object:
{
  "proxy_score": <integer 80-100>,
  "score_tier": "exceptional|outstanding|very_good|good",
  "confidence": "high|medium|low",
  "reasoning_signals": ["signal1", "signal2"]  // max 3
}

Rules:
- 95-100: "exceptional complexity, profound depth, age-worthy" signals
- 90-94: "complex, concentrated, excellent balance" signals
- 85-89: "very good, well-made, varietal character" signals
- 80-84: "good, pleasant, straightforward" signals
- confidence=low if tasting_notes is < 30 chars
`;

type CriticProxyResult = {
  proxy_score: number;       // 80–100
  score_tier: 'exceptional' | 'outstanding' | 'very_good' | 'good';
  confidence: 'high' | 'medium' | 'low';
  reasoning_signals: string[];
  is_synthetic: true;        // 항상 true — transparency 필수
};
```

**Vespa 스키마 추가:**
```
field critic_proxy_score type float {}    // 80–100, synthetic
field critic_proxy_tier  type string {}   // exceptional|outstanding|...
field critic_proxy_confidence type string {} // high|medium|low
```

**필터링 동작:**
- `critic_score >= 90` 쿼리 → `critic_proxy_score >= 90` 필터
- `is_synthetic = true` 항상 포함 → response에 `data_source: "synthetic_proxy"` 노출
- confidence=low인 결과는 soft constraint으로만 사용 (hard constraint 금지)

**검증:** CellarTracker public scores (라이선스 불필요) 샘플 100개와 MAE 측정.
목표: MAE ≤ 3.5점.

---

## Step 12.2 — Organic/Biodynamic Certification Enrichment

### Wikidata SPARQL 접근

Wikidata는 주요 생산자(샤토, 도멘)의 인증 정보를 구조화된 형태로 보유.
무료, 오픈 라이선스(CC0).

```sparql
# 생산자명으로 organic/biodynamic 인증 조회
SELECT ?producer ?certLabel WHERE {
  ?producer wdt:P31 wd:Q156362 .   # winery instance
  ?producer rdfs:label "{producer_name}"@en .
  ?producer wdt:P6868 ?cert .      # certified by
  ?cert rdfs:label ?certLabel .
  FILTER(LANG(?certLabel) = "en")
}
```

**스크립트:** `scripts/etl/enrich-certifications.ts`

```typescript
type CertificationEnrichment = {
  entity_id: string;
  organic: boolean;
  biodynamic: boolean;           // Demeter/Biodyvin
  vegan: boolean;
  natural_wine: boolean;         // no formal cert, inferred from notes
  certification_source: 'wikidata' | 'llm_inferred' | 'none';
  certification_confidence: 'verified' | 'probable' | 'low';
};
```

**LLM fallback (Wikidata miss 시):**
```
Vivino tasting notes에 "organic", "biodynamique", "natural", "no sulfites",
"sustainable", "certified" 등 키워드 있으면 → llm_inferred, probable
```

**Vespa 필드:**
```
field organic     type bool {}
field biodynamic  type bool {}
field certification_source type string {}
```

---

## Step 12.3 — Food Pairing Data

### 두 단계 전략

**Stage 1 — Index time (doc2pairing):**
Vivino의 `food_pairings` 배열이 이미 있다 (`["beef", "lamb", "hard-cheese"]`).
여기에 LLM으로 "표준화 + 확장"한다.

```typescript
// 입력: Vivino food_pairings + tasting notes
// 출력: 정규화된 pairing 태그 세트

const PAIRING_TAXONOMY = [
  // Protein
  'beef', 'lamb', 'pork', 'chicken', 'duck', 'game',
  'salmon', 'tuna', 'shellfish', 'white_fish',
  // Vegetarian
  'mushroom', 'truffle', 'hard_cheese', 'soft_cheese',
  'pasta', 'risotto', 'grilled_vegetables',
  // Context
  'aperitif', 'dessert', 'solo_drinking',
] as const;

type PairingTag = typeof PAIRING_TAXONOMY[number];

// scripts/etl/generate-pairings.ts
// prompt: "Given this wine's tasting notes and food_pairings list,
//          classify into standard pairing tags. Output: { tags: string[] }"
```

**Stage 2 — Query time (pairing extractor):**

```typescript
// src/domain/query/service/pairing-extractor.ts

const PAIRING_PATTERNS: Record<PairingTag, RegExp[]> = {
  beef: [/스테이크/i, /소고기/i, /beef/i, /steak/i, /ribeye/i],
  salmon: [/연어/i, /salmon/i],
  truffle: [/트러플/i, /truffle/i],
  // ...
};

export function extractPairingConstraint(query: string): PairingTag | null {
  for (const [tag, patterns] of Object.entries(PAIRING_PATTERNS)) {
    if (patterns.some((p) => p.test(query))) return tag as PairingTag;
  }
  return null;
}
```

**Vespa 필드:**
```
field pairing_tags type array<string> {}   // ["beef", "truffle", ...]
```

**Vespa 필터링:**
```
pairing_tags contains "beef"
```

---

## Completion Criteria

- [ ] `critic_proxy_score` 필드 10K 문서에 채워짐, CellarTracker MAE ≤ 3.5
- [ ] organic/biodynamic 필드: Wikidata 커버 ≥ 500 생산자, LLM fallback 나머지
- [ ] pairing_tags 10K 문서에 채워짐, taxonomy 커버리지 ≥ 80%
- [ ] "organic bourgogne under 50000" 쿼리 → organic=true 필터 정확 동작
- [ ] "salmon pairing white wine" 쿼리 → pairing_tags recall ≥ 0.75
