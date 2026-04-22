# Ingestion pipeline (데이터 인입 파이프라인)

> **Audience:** 시스템·아키텍처 **리뷰** 전용. 키트 개요는 [`README.md`](./README.md).  
> **런타임 검색(리트리버)** 는 [`retriever-pipeline.md`](./retriever-pipeline.md).

**한 줄:** PostgreSQL Bronze → NDJSON `silver.ndjson` → `silver-aliases.ndjson` → `silver-ko.ndjson` → `silver-docquery.ndjson` → `silver-trackc.ndjson` → 품질 게이트 → Vespa 피드; 그 외 골든·평가·학습·시딩 스크립트는 **같은 문서에서 표로 끝**낸다.

**Last updated:** 2026-04-14

---

## 목차

1. [데이터 계층](#1-데이터-계층-요약)  
2. [권장 배치 순서](#2-권장-배치-순서-대표-경로)  
3. [`scripts/etl` 전체](#3-scriptsetl-전체-목록-실행--라이브러리)  
4. [타입 SSOT](#4-타입계약-etl-중간-표현)  
5. [품질 게이트](#5-품질-게이트)
6. [Vespa 인덱싱](#6-vespa-인덱싱)
7. [Track C](#7-track-c-오케스트레이션)  
8. [Bronze export](#8-bronze-export-도구-db--파일)  
9. [평가 시딩](#9-평가골든-쿼리-인입)  
10. [도메인 `ingestion`](#10-런타임-도메인-패키지-srcdomainingestion)  
11. [Fine-tune·임베딩](#11-fine-tuning학습-데이터-인덱스-인입과-인접)  
12. [LTR·재색인](#12-임베딩-재색인ltr-보조-scriptsltr)  
13. [시딩·마이그레이션·셸](#13-vespapg-시딩스키마-테스트-레인)  
14. [임계값·ONNX 검증](#14-임계값모델-검증)  
15. [골든·스플릿](#15-골든평가-데이터-생성)  
16. [RFC·플랜](#16-관련-rfc플랜)  
17. [완전성 체크리스트](#17-완전성-체크리스트)

---

## 1. 데이터 계층 (요약)

| 계층 | 저장소 / 형식 | 설명 |
|------|----------------|------|
| **Bronze** | PostgreSQL `wine_pdp_snapshot` | 원천 스냅샷 + JSON `payload` |
| **Silver** | NDJSON `SilverWineRecord` | `scripts/etl/types.ts` |
| **Aliases** | NDJSON `silver-aliases.ndjson` | RFC-003 별칭 번들 |
| **KO aliases** | NDJSON `silver-ko.ndjson` | 한국어 alias (Anthropic Haiku) |
| **Doc2Query** | NDJSON `silver-docquery.ndjson` | typed `syntheticQueries` + `doc2queryFingerprint` (OpenAI gpt-5.x) |
| **Track C** | NDJSON `silver-trackc.ndjson` | critic proxy / certifications / pairings / drinking-window |
| **Index** | Vespa `wine_entity` | `RetrievalDocument` + 임베딩 + `synthetic_queries` BM25 필드 |

```mermaid
flowchart TB
  PG[(PG wine_pdp_snapshot)]
  S[data/silver.ndjson]
  A[data/silver-aliases.ndjson]
  K[data/silver-ko.ndjson]
  D[data/silver-docquery.ndjson]
  T[data/silver-trackc.ndjson]
  V[Vespa]
  PG --> S --> A --> K --> D --> T --> V
```

런타임 정규화 패키지: **§10** (`src/domain/ingestion`).

---

## 2. 권장 배치 순서 (대표 경로)

1. **Bronze 적재** (외부 스크래퍼 등) → `wine_pdp_snapshot`  
2. **`vivino-to-silver.ts`** → 기본 `data/silver.ndjson`  
3. **`generate-aliases.ts`** → 기본 `data/silver-aliases.ndjson`  
4. **`generate-korean-aliases.ts`** → `data/silver-ko.ndjson`  
5. **`generate-doc-queries.ts`** → `data/silver-docquery.ndjson` — Doc2Query (typed `syntheticQueries` 필드 + `doc2queryFingerprint` 멱등성). 기본 입력은 `silver-ko.ndjson`. 자세한 동작은 [§6.1](#61-doc2query-단계-신규-방식)
6. **`run-track-c.ts`** → `data/silver-trackc.ndjson` — `silver-docquery.ndjson`을 seed로 받아 Track C 필드를 여기에 기록
7. **`validate-silver.ts`** → 기본 `silver-trackc.ndjson` 품질 게이트
8. **`index-to-vespa.ts`** → 기본 `silver-trackc.ndjson` → Vespa
9. **`build-search-snapshot.ts` / `publish-search-snapshot.ts`** → 기본 `silver-trackc.ndjson` 스냅샷·컷오버 입력

**추가 도구:** `fetch-vivino-snapshots.ts` (Bronze만 export), `generate-transliteration-aliases.ts` (PG `aliases` 백필, NDJSON 트랙과 별도).

**`package.json` (인입·인접)**

| 스크립트 | 경로 |
|----------|------|
| `pnpm run vivino:bronze` | `tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts` |
| `pnpm run etl:transliteration` | `scripts/etl/generate-transliteration-aliases.ts` |
| `pnpm run bootstrap:smoke` | `scripts/bootstrap-smoke.sh` |

`ingest` / `kill-switch` CLI 스크립트는 현재 레포에 존재하지 않으므로 `package.json`에서 제거되었다. 인입 관련 작업은 개별 `scripts/etl/*.ts`를 직접 사용한다.

---

## 3. `scripts/etl` 전체 목록 (실행 + 라이브러리)

| 파일 | 역할 |
|------|------|
| `types.ts` | Bronze/Silver/Enriched/Golden 타입 SSOT |
| `ndjson.ts` | NDJSON 파싱 |
| `vivino-to-silver.ts` | PG → Silver NDJSON |
| `generate-aliases.ts` | Silver → `silver-aliases.ndjson` |
| `generate-korean-aliases.ts` | `silver-aliases.ndjson` → `silver-ko.ndjson` (`ANTHROPIC_API_KEY`) |
| `generate-doc-queries.ts` | Doc2Query (typed `syntheticQueries` field, OpenAI gpt-5.x via port, fingerprint idempotency) → §6.1 |
| `build-ambiguity-registry.ts` | `silver-ko.ndjson` → ambiguity registry |
| `run-track-c.ts` | `silver-docquery.ndjson` → `silver-trackc.ndjson` 오케스트레이터 |
| `run-track-c-step1.ts` | Track C: critic proxy (`silver-trackc.ndjson`) |
| `run-track-c-step2.ts` | Track C: certifications (`silver-trackc.ndjson`) |
| `run-track-c-step3.ts` | Track C: pairings (`silver-trackc.ndjson`) |
| `drinking-window-backfill.ts` | Track C: drinking window (`silver-trackc.ndjson`) |
| `validate-silver.ts` | `silver-trackc.ndjson` 품질 게이트 |
| `index-to-vespa.ts` | `silver-trackc.ndjson` → Vespa |
| `build-search-snapshot.ts` | `silver-trackc.ndjson` → snapshot manifest |
| `publish-search-snapshot.ts` | `silver-trackc.ndjson` → runtime cutover |
| `generate-critic-proxy.ts` | 모듈 (step1) |
| `enrich-certifications.ts` | 모듈 (step2) |
| `generate-pairings.ts` | 모듈 (step3) |
| `generate-transliteration-aliases.ts` | PG 별칭 upsert |
| `load-eval-cases.ts` | Golden JSONL → `eval_cases` |
| `tag-queries-retrieval-mode.ts` | `retrieval_mode` 태깅 |

`load-eval-cases` / `tag-queries-retrieval-mode`: shebang 없음 → `npx tsx scripts/etl/...`.

---

## 4. 타입·계약 (ETL 중간 표현)

```65:85:scripts/etl/types.ts
/**
 * Silver record: the normalized intermediate between raw Vivino data and the
 * final {@link RetrievalDocument} that gets indexed in Vespa.
 *
 * All numeric sensory scores are in [0, 1].
 * All strings are trimmed and non-empty (or the field is omitted).
 */
export interface SilverWineRecord {
  /** Deterministic ID: hash of "vivino:{external_id}". */
  readonly sourceId: string;
  /** Vivino external_id for provenance. */
  readonly externalId: string;
  /** Normalized canonical label (RFC-002: never raw display_name). */
  readonly canonicalLabel: string;
```

```173:175:scripts/etl/types.ts
export interface EnrichedSilverRecord extends SilverWineRecord {
  readonly aliases: AliasBundle;
}
```

---

## 5. 품질 게이트

`scripts/etl/validate-silver.ts`

```19:33:scripts/etl/validate-silver.ts
const DEFAULT_INPUT = 'data/silver-trackc.ndjson';
const REPORT_OUTPUT = 'data/silver-quality-report.json';

/**
 * Quality gate thresholds (Epic 1).
 * `minRecords`: Current Vivino Bronze connector yields ~7K deduped rows; RFC target remains 8K+ / 10K when the feed grows.
 * Raise `minRecords` toward 8_000 as the snapshot expands (see epic-1-etl-pipeline.md).
 */
const GATES = {
  minRecords: 7_000,
  minTastingNotesCoverage: 0.30,
  minAliasMeanCount: 3,
  bodyMinMean: 0.1,
  bodyMaxMean: 0.9,
} as const;
```

---

## 6. Vespa 인덱싱

`scripts/etl/index-to-vespa.ts` — `silver-trackc.ndjson` → `EnrichedSilverRecord` → `silverToRetrievalDoc` → `toVespaFields` (`src/infrastructure/vespa/mapping.ts`) → `VespaClient.bulkFeed`.

### 6.1 Doc2Query 단계 (신규 방식)

> 통합 결정/근거: [`doc2query-cohere-integration.md`](./doc2query-cohere-integration.md)

`scripts/etl/generate-doc-queries.ts` — Nogueira et al. 2019 Doc2Query를 와인 도메인에 적용. **2026-04-10에 typed-field + 포트 기반으로 재작성됨.**

**예전 방식 (deprecated):** 합성 쿼리를 `searchTextEn`에 ` ||| ` delimiter로 concat → BM25 IDF 오염, Vespa rank profile에서 가중치 조절 불가능.

**현재 방식:**
- 출력은 `EnrichedSilverRecord.syntheticQueries: readonly string[]` (typed) + `doc2queryFingerprint: { modelId, contentHash, generatedAt }`. `searchTextEn`은 **그대로 보존**.
- Vespa로 흘러갈 때 `index-to-vespa.ts`가 typed 필드를 그대로 전달 → `toVespaFields`가 `synthetic_queries` 라는 **별도 BM25 필드** (`array<string>`, `index: enable-bm25`) 에 씀. 가중치는 rank profile `bm25_wine()` 안에서 `bm25(synthetic_queries) * 0.6` 으로 따로 튜닝됨 (원문 1.0보다 약하게, alias 3.0보다 훨씬 약하게 — 합성 콘텐츠가 진짜 콘텐츠를 가리지 못하도록).
- LLM 호출은 `Doc2QueryGeneratorPort` → `OpenAiDoc2QueryGenerator` → `OpenAiChatLlm` (런타임 chat 어댑터와 동일). 따라서 OpenAI **circuit breaker / retry / GenAI telemetry** 를 자동 상속.
- 모델은 `OPENAI_DOC2QUERY_MODEL` env로 분리. 런타임 `OPENAI_CHAT_MODEL` 과 독립적으로 cheaper/different 모델 사용 가능.
- 멱등성: `contentHash = sha256(canonicalLabel + producer + region + grape + style + price + searchTextEn[:240])`. 다음 ETL 실행 시 modelId + contentHash 둘 다 일치하면 자동 skip → 비용 0. `--force` 플래그로 override.
- 빈 결과/에러는 prior record를 보존 (절대 ground 잃지 않음).
- 7개 쿼리/와인 (영어 5 + 한국어 2). 한국어 정책은 시스템 프롬프트에 명시.

**호출 예:**
```bash
# Dry-run sample
npx tsx --env-file=.env.local scripts/etl/generate-doc-queries.ts \
  --input data/silver-ko.ndjson \
  --dry-run --limit 5

# Real backfill (idempotent — safe to re-run)
npx tsx --env-file=.env.local scripts/etl/generate-doc-queries.ts \
  --input data/silver-ko.ndjson \
  --output data/silver-docquery.ndjson

# Force regenerate (e.g. model bump)
npx tsx --env-file=.env.local scripts/etl/generate-doc-queries.ts --force
```

**관련 파일**
- `scripts/etl/generate-doc-queries.ts` — CLI 진입점
- `src/infrastructure/ai/openai-doc2query-generator.ts` — 어댑터 (시스템 프롬프트, JSON parsing, 길이 정규화)
- `src/domain/retrieval/port/doc2query-generator.port.ts` — 포트 계약
- `src/config/container-adapters.ts` (`doc2queryGenerator` 필드) — DI 선택 (OpenAI primary, Stub fallback)
- `vespa/app/schemas/wine_entity.sd` — `synthetic_queries` 필드 + `bm25_wine()` 가중치
- `src/infrastructure/vespa/mapping.ts` — `toVespaFields` / `fromVespaFields` 의 `synthetic_queries` 처리

**범위 밖 (의도적으로 wired 안 됨):** SPLADE 인코더, ColBERT reranker — 스캐폴딩은 repo에 남아 있으나 composition root에서 import 0. [`doc2query-cohere-integration.md`](./doc2query-cohere-integration.md) 의 결정 배경 참조.

### 6.2 RetrievalDocument 변환 코드

```172:208:scripts/etl/index-to-vespa.ts
function silverToRetrievalDoc(
  rec: EnrichedSilverRecord,
  embedding: readonly number[],
): RetrievalDocument {
  const doc: RetrievalDocument = {
    entityId: createCanonicalEntityId(indexable.entityId),
    entityType: 'wine',
    canonicalLabel: rec.canonicalLabel,
    aliasesIdentitySafe: rec.aliases.identitySafeProjection,
    aliasesNoisyRecall: rec.aliases.noisyRecallProjection,
    producer: rec.producer,
    region: rec.region,
    grapes: rec.grapes,
    searchTextKo: buildSearchTextKo(rec),
    searchTextEn: rec.searchTextEn,
    semanticSummary: buildEmbedText(rec),
    ...(indexable.body != null ? { body: indexable.body } : {}),
    ...(indexable.sweetness != null ? { sweetness: indexable.sweetness } : {}),
    style: indexable.style,
    priceBand: rec.priceBand,
    pairing: rec.pairingTags,
    ...(indexable.occasion !== undefined ? { occasion: [...indexable.occasion] } : {}),
    availability: true,
    popularityScore: rec.popularityScore,
    embedding,
    // Optional fields — use conditional spread for exactOptionalPropertyTypes
    ...(rec.vintageYear !== null ? { vintageYear: rec.vintageYear } : {}),
    ...(rec.acidity > 0 ? { acidity: rec.acidity } : {}),
    ...(rec.tannin > 0 ? { tannin: rec.tannin } : {}),
    ...(rec.wineType ? { wineType: rec.wineType } : {}),
    ...(rec.grapePrimary ? { grapePrimary: rec.grapePrimary } : {}),
    ...(rec.country ? { country: rec.country } : {}),
    ...(rec.priceUsd !== null ? { priceUsd: rec.priceUsd } : {}),
    ...(rec.flavorProfiles.length > 0 ? { flavorProfiles: rec.flavorProfiles } : {}),
    ...(rec.ratingAvg !== null ? { criticScoreNormalized: rec.ratingAvg / 5 } : {}),
  };
  return doc;
}
```

---

## 7. Track C 오케스트레이션

`scripts/etl/run-track-c.ts`

```127:153:scripts/etl/run-track-c.ts
  const steps = [
    {
      num: 1,
      script: 'run-track-c-step1.ts',
      desc: 'Generate Critic Proxy Scores',
      field: 'criticProxy',
    },
    {
      num: 2,
      script: 'run-track-c-step2.ts',
      desc: 'Enrich Certifications (Wikidata + LLM)',
      field: 'certifications',
    },
    {
      num: 3,
      script: 'run-track-c-step3.ts',
      desc: 'Generate Food Pairings (Claude)',
      field: 'pairingTags', // This one updates existing field
    },
    {
      num: 4,
      script: 'drinking-window-backfill.ts',
      desc: 'Drinking Window Backfill (LightGBM)',
      field: 'drinkingWindow',
    },
  ];
```

---

## 8. Bronze export 도구 (DB → 파일)

```1:15:tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts
/**
 * Bronze Vivino export — reads `wine_pdp_snapshot` rows with `source_id = 'vivino'`.
 *
 * Connection (pick one):
 *   - DATABASE_URL=postgresql://user:pass@host:port/dbname
 *   - PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *
 * RDS: if host contains `rds.amazonaws.com`, uses TLS with `rejectUnauthorized: false`
 * (same idea as typical internal tooling).
 *
 * Usage:
 *   npx tsx --env-file=.env tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts --limit 20
 *   npx tsx --env-file=.env tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts --count
 *   npx tsx --env-file=.env tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts --external-id 3961941
 */
```

---

## 9. 평가·골든 쿼리 인입

| 스크립트 | 입출력 |
|----------|--------|
| `load-eval-cases.ts` | 기본 `data/golden-queries-bronze.jsonl` → PG `eval_cases` |
| `tag-queries-retrieval-mode.ts` | 동일 파일에 `retrieval_mode` (in-place rename) |

런타임 검색 인입이 아니라 **오프라인 데이터셋·DB 시딩**.

---

## 10. 런타임 도메인 패키지 `src/domain/ingestion`

```29:47:src/domain/ingestion/index.ts
// Ports
export type { SourceReader, SourceReaderBatch } from './port/source-reader.port.js';
export type { LineageStore } from './port/lineage-store.port.js';

// Services
export {
  normalizeField,
  normalizeVolume,
  normalizeYear,
  normalizeKoreanText,
} from './service/field-normalizer.js';

export { stripNoiseTokens, isPromotionalText } from './service/noise-stripper.js';
export type { NoiseStripResult } from './service/noise-stripper.js';

export { detectContamination } from './service/contamination-detector.js';
```

`structured-extractor`, `entity-matcher`, and `abuse-detector` were removed
from the runtime ingestion package on 2026-04-16. The remaining ingestion
surface is normalization, noise stripping, and contamination detection.

---

## 11. Fine-tuning·학습 데이터 (인덱스 인입과 인접)

| 경로 | 비고 |
|------|------|
| `scripts/fine-tune/prepare-finetuning-data.ts` | `pnpm run finetuning:prepare` |
| `scripts/fine-tune/bge-m3-finetune.py` | Python 보조 |
| `scripts/embedding/finetune-bge-m3.ts` | 실험용 엔트리 |

---

## 12. 임베딩 재색인·LTR 보조 (`scripts/ltr/`)

| 파일 | 역할 |
|------|------|
| `generate-triplets.ts` | 골든 → `data/triplets-train.jsonl` |
| `reindex-embeddings.ts` | Vespa 문서 벡터만 갱신 |
| `validate-embedding.ts` | Recall/NDCG 회귀 검증 |
| `finetune_embedding.py` | `python scripts/ltr/finetune_embedding.py` |
| `distill_cross_encoder.py` | `python scripts/ltr/distill_cross_encoder.py` |

배치 `index-to-vespa`와 달리 **이미 채워진 인덱스**를 전제로 한 **운영·실험** 경로.

---

## 13. Vespa·PG 시딩·스키마·테스트 레인

| 파일 | 역할 |
|------|------|
| `seed-wines-real.ts` | 대량 Vespa 시드 (E2E/품질) |
| `seed-vespa-test-data.ts` | 소형 테스트 피드 |
| `migrate-local-docker-pg.ts` / `migrate-from-env.ts` | `pnpm run migrate` (Docker Compose PG), `pnpm run migrate:from-env` (`.env` DB) |
| `prune-feedback-ttl.ts` | `pnpm run feedback:prune-ttl` — RFC-010 TTL |

**배포:** `scripts/deploy-vespa.sh` — 데이터 파이프라인과 별도.

**테스트 셸:** `setup-vespa-test.sh`, `teardown-vespa-test.sh`, `run-vespa-e2e.sh`, `run-vespa-test-lane.sh`, `run-vespa-quality.sh`, `run-vespa-verification.sh`.

---

## 14. 임계값·모델 검증

| 파일 | 역할 |
|------|------|
| `calibrate-confidence-threshold.ts` | 오프라인 eval NDJSON → 임계값 (RFC-016 / Epic 17.3) |
| `verify-drinking-window-model.ts` | `pnpm run verify:drinking-window-model` — ONNX 존재 검증 |

---

## 15. 골든·평가 데이터 생성 (`scripts/eval/`)

| 파일 | 입·출력 요약 |
|------|----------------|
| `generate-golden-queries.ts` | canonical ETL artifacts (`silver.ndjson` / snapshot-linked corpus) → `golden-queries-bronze.jsonl` |
| `mine-hard-negatives.ts` | → `hard-negatives.jsonl` |
| `build-splits.ts` | train/val/gate (RFC-017) |
| `run-eval-and-train-ltr.ts` | PG 평가 + LambdaMART (`createContainer`) |
| `verify-splits.ts` | 스플릿 누설 검증 (exit 1) |
| `split-integrity.ts` | 검증 로직 공유 (`run-offline-eval --verify-splits`) |

`entity-type.ts` — 골든 대상 타입 판별, `metrics.ts` 등에서 import (단독 CLI 아님).

나머지 `scripts/eval/*` (offline eval, baseline, noisy 등)는 **평가 실행** — `package.json` `eval:*`.

---

## 16. 관련 RFC·플랜

- **RFC-002** — Ingestion·canonicalization  
- **RFC-003** — Alias  
- **RFC-017** — IR 품질 플라이휠  
- `docs/plans/apr-5-v0.1/epic-1-etl-pipeline.md`

**RFC 목차:** [`docs/RFC-INDEX.md`](../RFC-INDEX.md).

---

## 17. 완전성 체크리스트

| 영역 | § |
|------|---|
| `scripts/etl` 전 파일 | §3 |
| Bronze·export | §2, §8 |
| Silver/Enriched 타입 | §4 |
| 검증·리포트 | §5 |
| Vespa 배치 피드 | §6 |
| Track C | §7 |
| PG transliteration | §2, §3 |
| Golden → PG / retrieval_mode | §9 |
| `src/domain/ingestion` | §10 |
| Fine-tune·임베딩 | §11 |
| LTR·Python | §12 |
| 시드·마이그레이션·피드백·테스트 셸·deploy | §13 |
| 임계값·ONNX | §14 |
| 골든·스플릿·LTR 학습 | §15 |
| 런타임 리트리버 | **제외** → [`retriever-pipeline.md`](./retriever-pipeline.md) |
| `vivino:bronze` / `etl:transliteration` | §2 |
| bootstrap/ETL 스크립트 현재 상태 (`bootstrap:smoke`, `vivino:bronze`, `etl:transliteration`) | §2 |
| **의도적 제외** | `find-domain-orphans.ts`, `export-http-contract-manifest.ts`, `export-http-openapi-bridge.ts`, `verify-openai-injection-wiring.ts`, `verify-anthropic-wiring.ts`, `dev/test-search-direct.ts` |
