# Wine Data Enrichment Pipeline

7040개 레코드를 Vespa 스키마 전체 필드로 채우는 단계별 설계.

```
data/silver-enriched.ndjson   ← 원본 (Vivino scrape)
        │
        ▼ Phase 1 (완료)
data/silver-phase1.ndjson     grapes 71%, flavorProfiles 100%, searchTextKo 100%
        │
        ▼ Phase 1b (완료)
data/silver-phase1b.ndjson    grapes 78%, searchTextEn short→0
        │
        ├─▶ Phase 2  (LLM: grapes+searchTextEn)    → silver-phase2.ndjson
        ├─▶ Phase 3  (Rule: 구조적 필드 8종)        → silver-phase3.ndjson
        ├─▶ Phase 4  (LLM: drinking window)         → silver-phase4.ndjson
        └─▶ Phase 5  (Track C: criticProxy)         → silver-final-v2.ndjson
                │
                ▼
        index-to-vespa.ts  →  Vespa (18080)
```

---

## Phase 2 — LLM: grapes + searchTextEn
**스크립트**: `tools/wine-search-engine/enrich-llm.py` (기존, 완성)
**대상**: grapes 없는 1557개 + searchTextEn 짧은 1096개 (합산 ~2570개)
**모델**: gpt-4o-mini
**예상 비용**: ~$0.10
**예상 시간**: ~4분 (concurrency 20)

```bash
set -a && source .env && set +a
python3 tools/wine-search-engine/enrich-llm.py \
  --input  data/silver-phase1b.ndjson \
  --output data/silver-phase2.ndjson \
  --model  gpt-4o-mini \
  --concurrency 20
```

**채워지는 필드**: `grapes`, `grapePrimary`, `searchTextEn`

---

## Phase 3 — Rule-based: 구조적 필드 8종
**스크립트**: `tools/wine-search-engine/enrich-rules.py` (신규 작성 필요)
**대상**: 전체 7040개
**비용**: $0
**예상 시간**: ~10초

| 필드 | 커버리지 | 로직 |
|------|---------|------|
| `finish_length` | 100% | body≥0.65 & tannin≥0.55 → `long` / body<0.4 → `short` / else `medium` |
| `occasion` | 100% | priceBand×wineType×rating 매트릭스 |
| `classification` | ~20% (1411개) | label 파싱: Grand Cru, Riserva, Gran Reserva, Kabinett 등 |
| `producer_type` | ~24% (1695개) | producer명: Domaine/Château/Estate/Clos/Mas/Bodega 등 |
| `oak_treatment` | ~whites | region: Meursault/Montrachet→oaked / Chablis/Riesling→unoaked |
| `grape_family` | ~78% | grapes[0] → "Pinot", "Cabernet", "Chardonnay" 등 계열 |
| `region_hierarchy` | ~99% | region string → ["France", "Bourgogne", "Gevrey-Chambertin"] |
| `price_band_numeric` | 100% | value→1 / mid→2 / premium→3 / luxury→4 |

### occasion 매트릭스

```
luxury   + red/white   + rating≥4.3 → ["celebration", "gift", "special_occasion"]
premium  + any         + rating≥4.2 → ["date_night", "dinner_party", "gift"]
mid      + red         + rating≥4.0 → ["dinner_party", "weeknight"]
mid      + white/rose               → ["aperitif", "weeknight"]
value    + any                      → ["everyday", "aperitif"]
sparkling               any         → ["celebration", "aperitif"]
fortified               any         → ["dessert", "after_dinner"]
```

```bash
python3 tools/wine-search-engine/enrich-rules.py \
  --input  data/silver-phase2.ndjson \
  --output data/silver-phase3.ndjson
```

---

## Phase 4 — LLM: Drinking Window
**스크립트**: `tools/wine-search-engine/enrich-drinking-window.py` (신규 작성 필요)
**대상**: vintage 있는 7033개 (단, 이미 docquery에 drinkingWindow 있음 → 병합 가능)
**모델**: gpt-4o-mini
**예상 비용**: ~$1.5 (7040개 전체) / ~$0.35 (grape+region 있는 고품질 대상만)
**예상 시간**: ~20분 (concurrency 30)

> **Note**: `silver-docquery.ndjson`에 이미 `drinkingWindow` 7033개 있음.
> → Phase 4에서 docquery의 drinkingWindow를 phase3 데이터에 **병합**하는 게 먼저.
> 병합 후 남은 공백만 LLM으로 채우면 비용 대폭 절감.

```bash
# Step 4a: docquery drinkingWindow 병합 (무료)
python3 tools/wine-search-engine/merge-fields.py \
  --base   data/silver-phase3.ndjson \
  --donor  data/silver-docquery.ndjson \
  --fields drinkingWindow \
  --output data/silver-phase4.ndjson

# Step 4b: 남은 공백 LLM으로 채우기
python3 tools/wine-search-engine/enrich-drinking-window.py \
  --input  data/silver-phase4.ndjson \
  --output data/silver-phase4.ndjson \
  --model  gpt-4o-mini
```

**채워지는 필드**: `drinkingWindowStart`, `drinkingWindowEnd`
**Vespa rank profile `wine_aware`**에서 drinking window proximity 점수로 사용됨.

---

## Phase 5 — Track C: Critic Proxy (선택)
**스크립트**: `scripts/etl/run-track-c-step1.ts` (기존 존재)
**대상**: 전체 7040개
**모델**: Claude (Anthropic SDK, `.env`의 `ANTHROPIC_API_KEY`)
**예상 비용**: ~$3~8 (Claude 사용)
**우선순위**: Low — ratingAvg로 criticScoreNormalized 이미 근사치 적용 중

```bash
npx tsx --env-file=.env scripts/etl/run-track-c-step1.ts
```

**채워지는 필드**: `criticProxy.proxyScore`, `criticProxy.scoreTier`, `criticProxy.confidence`

---

## 최종 병합 & 인덱싱

```bash
# 최종 파일을 Vespa에 인덱싱
env $(cat .env | grep -v ^# | xargs) \
  npx tsx scripts/etl/index-to-vespa.ts \
  --input data/silver-phase4.ndjson
```

---

## 전체 실행 순서 요약

```
Phase 2  enrich-llm.py          ~4분   ~$0.10   grapes + searchTextEn
Phase 3  enrich-rules.py        ~10초  $0       finish_length, occasion, classification 등
Phase 4a merge-fields.py        ~5초   $0       drinkingWindow (docquery 병합)
Phase 4b enrich-drinking-window ~선택  ~$1.5    LLM drinking window 보완
Phase 5  run-track-c-step1.ts   ~선택  ~$5      critic proxy 점수
         index-to-vespa.ts      ~5분   $0       Vespa 재인덱싱
```

**필수 (Phase 2+3+4a)**: 총 비용 ~$0.10, 시간 ~10분
**풀 파이프라인**: 총 비용 ~$7, 시간 ~30분

---

## Vespa 필드 커버리지 (Phase 2+3+4a 완료 기준)

| 필드 | Before | After |
|------|--------|-------|
| `grapes` | 78% | **~92%** |
| `searchTextEn` | 84% meaningful | **~100%** |
| `classification` | 0% | **~20%** |
| `occasion` | 0% | **100%** |
| `finish_length` | 0% | **100%** |
| `producer_type` | 0% | **~24%** |
| `oak_treatment` | 0% | **~whites** |
| `grape_family` | 0% | **~92%** |
| `region_hierarchy` | 0% | **~99%** |
| `price_band_numeric` | 0% | **100%** |
| `drinking_window_start` | 0% | **~99%** |
| `drinking_window_end` | 0% | **~99%** |

---

## 신규 스크립트 목록

| 파일 | 상태 | 역할 |
|------|------|------|
| `tools/wine-search-engine/enrich-llm.py` | ✅ 완성 | Phase 2 |
| `tools/wine-search-engine/enrich-rules.py` | ⬜ 미작성 | Phase 3 |
| `tools/wine-search-engine/merge-fields.py` | ⬜ 미작성 | Phase 4a |
| `tools/wine-search-engine/enrich-drinking-window.py` | ⬜ 미작성 | Phase 4b |
