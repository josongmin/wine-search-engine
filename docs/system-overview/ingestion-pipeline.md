# Ingestion pipeline (데이터 인입 파이프라인)

> **Audience:** 시스템·아키텍처 **리뷰** 전용. 키트 개요는 [`README.md`](./README.md).  
> **런타임 검색(리트리버)** 는 [`retriever-pipeline.md`](./retriever-pipeline.md).

**한 줄:** PostgreSQL Bronze → NDJSON Silver/Enriched → (선택 확장·Track C) → 품질 게이트 → Vespa 피드; 그 외 골든·평가·학습·시딩 스크립트는 **같은 문서에서 표로 끝**낸다.

**Last updated:** 2026-04-06

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
| **Silver + alias** | NDJSON `EnrichedSilverRecord` | RFC-003 별칭 번들 |
| **Silver + 확장** | NDJSON | doc2query, KO, Track C 필드 등 |
| **Index** | Vespa `wine_entity` | `RetrievalDocument` + 임베딩 |

```mermaid
flowchart TB
  PG[(PG wine_pdp_snapshot)]
  S[data/silver.ndjson]
  E[data/silver-enriched.ndjson]
  X[Optional: KO / doc-query / Track C]
  V[Vespa]
  PG --> S --> E --> X --> V
```

런타임 정규화 패키지: **§10** (`src/domain/ingestion`).

---

## 2. 권장 배치 순서 (대표 경로)

1. **Bronze 적재** (외부 스크래퍼 등) → `wine_pdp_snapshot`  
2. **`vivino-to-silver.ts`** → 기본 `data/silver.ndjson`  
3. **`generate-aliases.ts`** → 기본 `data/silver-enriched.ndjson`  
4. (선택) **`generate-korean-aliases.ts`** → `silver-enriched-ko.ndjson` — 인덱서는 **`index-to-vespa --input`** 으로 맞출 것  
5. (선택) **`generate-doc-queries.ts`** → `silver-enriched-docquery.ndjson`  
6. **Track C** — `run-track-c.ts`는 코드상 **`data/silver-docquery.ndjson`** 전제 → 파일명·스키마를 오케스트레이터와 **반드시** 일치  
7. **`validate-silver.ts`** — 인덱싱할 NDJSON과 **`--input` 동일** 권장  
8. **`index-to-vespa.ts`** — 기본 `silver-enriched.ndjson` → Vespa  

**추가 도구:** `fetch-vivino-snapshots.ts` (Bronze만 export), `generate-transliteration-aliases.ts` (PG `aliases` 백필, NDJSON 트랙과 별도).

**`package.json` (인입·인접)**

| 스크립트 | 경로 |
|----------|------|
| `npm run vivino:bronze` | `tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts` |
| `npm run etl:transliteration` | `scripts/etl/generate-transliteration-aliases.ts` |
| `npm run bootstrap:smoke` | `scripts/bootstrap-smoke.sh` |

`ingest` / `kill-switch` CLI 스크립트는 현재 레포에 존재하지 않으므로 `package.json`에서 제거되었다. 인입 관련 작업은 개별 `scripts/etl/*.ts`를 직접 사용한다.

---

## 3. `scripts/etl` 전체 목록 (실행 + 라이브러리)

| 파일 | 역할 |
|------|------|
| `types.ts` | Bronze/Silver/Enriched/Golden 타입 SSOT |
| `ndjson.ts` | NDJSON 파싱 |
| `vivino-to-silver.ts` | PG → Silver NDJSON |
| `generate-aliases.ts` | Silver → Enriched |
| `generate-korean-aliases.ts` | Enriched → KO (`ANTHROPIC_API_KEY`) |
| `generate-doc-queries.ts` | doc2query, BM25 확장 |
| `validate-silver.ts` | 품질 게이트 |
| `index-to-vespa.ts` | Enriched → Vespa |
| `run-track-c.ts` | Track C 오케스트레이터 |
| `run-track-c-step1.ts` | Critic proxy |
| `run-track-c-step2.ts` | Certifications |
| `run-track-c-step3.ts` | Pairings |
| `drinking-window-backfill.ts` | 음용 시기 |
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
const DEFAULT_INPUT = 'data/silver-enriched.ndjson';
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

`scripts/etl/index-to-vespa.ts` — `EnrichedSilverRecord` → `silverToRetrievalDoc` → `toVespaFields` (`src/infrastructure/vespa/mapping.ts`) → `VespaClient.bulkFeed`.

```172:208:scripts/etl/index-to-vespa.ts
function silverToRetrievalDoc(
  rec: EnrichedSilverRecord,
  embedding: readonly number[],
): RetrievalDocument {
  const doc: RetrievalDocument = {
    entityId: createEntityId(rec.sourceId),
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
    body: rec.body,
    sweetness: rec.sweetness,
    style: rec.body >= 0.7 ? 'bold red' : rec.body >= 0.4 ? 'medium body' : 'light',
    priceBand: rec.priceBand,
    pairing: rec.pairingTags,
    occasion: [],
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

export { extract } from './service/structured-extractor.js';

export { EntityMatcher } from './service/entity-matcher.js';
```

---

## 11. Fine-tuning·학습 데이터 (인덱스 인입과 인접)

| 경로 | 비고 |
|------|------|
| `scripts/fine-tune/prepare-finetuning-data.ts` | `npm run finetuning:prepare` |
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
| `migrate.ts` | `npm run migrate` — PG 마이그레이션 |
| `prune-feedback-ttl.ts` | `npm run feedback:prune-ttl` — RFC-010 TTL |

**배포:** `scripts/deploy-vespa.sh` — 데이터 파이프라인과 별도.

**테스트 셸:** `setup-vespa-test.sh`, `teardown-vespa-test.sh`, `run-vespa-e2e.sh`, `run-vespa-test-lane.sh`, `run-vespa-quality.sh`, `run-vespa-verification.sh`.

---

## 14. 임계값·모델 검증

| 파일 | 역할 |
|------|------|
| `calibrate-confidence-threshold.ts` | 오프라인 eval NDJSON → 임계값 (RFC-016 / Epic 17.3) |
| `verify-drinking-window-model.ts` | `npm run verify:drinking-window-model` — ONNX 존재 검증 |

---

## 15. 골든·평가 데이터 생성 (`scripts/eval/`)

| 파일 | 입·출력 요약 |
|------|----------------|
| `generate-golden-queries.ts` | `silver-enriched` → `golden-queries-bronze.jsonl` |
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
| `ingest` / `kill-switch` 선언 vs 파일 없음 | §2 |
| **의도적 제외** | `find-domain-orphans.ts`, `export-http-contract-manifest.ts`, `export-http-openapi-bridge.ts`, `verify-anthropic-wiring.ts`, `dev/test-search-direct.ts` |
