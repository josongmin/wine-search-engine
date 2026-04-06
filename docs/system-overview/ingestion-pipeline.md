# Ingestion pipeline (데이터 인입 파이프라인)

> **Audience:** 시스템·아키텍처 **리뷰** 전용. 스코프는 `README.md` 참고.  
> 레포 안 **인입·ETL·인덱싱** 관련 스크립트·도메인 모듈을 빠짐없이 나열한다 (런타임 검색 파이프라인은 `retriever-pipeline.md`).

**Last updated:** 2026-04-06

---

## 1. 데이터 계층 (요약)

| 계층 | 저장소 / 형식 | 설명 |
|------|----------------|------|
| **Bronze** | PostgreSQL `wine_pdp_snapshot` (`source_id = 'vivino'` 등) | 원천 스냅샷 + JSON `payload` |
| **Silver** | NDJSON 파일 (`SilverWineRecord`) | 정규화·디듀프·인기도; `scripts/etl/types.ts` |
| **Silver + alias** | NDJSON (`EnrichedSilverRecord`) | RFC-003 타입 별칭 번들 + 투영 배열 |
| **Silver + 확장** | NDJSON (doc2query, KO 별칭, Track C 필드 등) | 스파스 리콜·다국어·에픽 12 부가 필드 |
| **Index (Gold)** | Vespa `wine` / `wine_entity` | `RetrievalDocument` + 임베딩; `index-to-vespa.ts`가 피드 |

런타임 **도메인 인입**(`src/domain/ingestion`)은 배치 ETL과 별도 — 정규화·추출·매칭 유틸(§10).

---

## 2. 권장 배치 순서 (대표 경로)

아래는 **한 줄로 이어지는 대표 플로우**이고, 선택 단계는 괄호로 표시한다.

1. **Bronze 적재** — 스크래퍼/커넥터가 `wine_pdp_snapshot`에 적재 (본 레포의 읽기 경로는 `vivino-to-silver.ts`가 DB에서 직접 SELECT).
2. **`vivino-to-silver.ts`** → `data/silver.ndjson` (기본값, `--output`으로 변경 가능).
3. **`generate-aliases.ts`** → `data/silver-enriched.ndjson` (기본 입·출력).
4. (선택) **`generate-korean-aliases.ts`** → `data/silver-enriched-ko.ndjson` — 한국어 별칭; Vespa 인덱서는 기본 입력이 `silver-enriched.ndjson`이므로 KO까지 쓰면 **`index-to-vespa.ts --input`** 으로 맞춘다.
5. (선택) **`generate-doc-queries.ts`** → `data/silver-enriched-docquery.ndjson` — doc2query로 `searchTextEn` 확장 (BM25).
6. **Track C** — `run-track-c.ts` 오케스트레이터는 **`data/silver-docquery.ndjson`** 을 전제로 한다 (주석·코드 일치). 즉 **doc-query 단계까지 포함한 파일명**으로 맞추거나, 오케스트레이터/스텝의 `DATA_FILE`을 동일 스키마로 통일해야 한다.
7. **`validate-silver.ts`** — 기본 입력 `data/silver-enriched.ndjson`; 품질 게이트·`data/silver-quality-report.json` (§5). Track C·doc-query까지 반영한 파일을 인덱싱할 경우 **`--input`으로 동일 파일**을 맞춘 뒤 검증하는 것이 안전하다.
8. **`index-to-vespa.ts`** — 기본 `data/silver-enriched.ndjson` → 임베딩 → `toVespaFields` → Vespa bulk feed.

**Bronze 덤프만 파일로 뽑기:** `tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts` — DB → NDJSON/콘솔 export (Silver 변환과는 별도 도구).

**PG `aliases` 테이블 백필:** `generate-transliteration-aliases.ts` — `entities` 기준 규칙 기반 한글 표기를 `aliases`에 upsert (NDJSON Silver 라인과 별 트랙).

**루트 `package.json` 스크립트 (인입과 겹치는 것만):**

| 스크립트 | 가리키는 경로 |
|-----------|----------------|
| `npm run vivino:bronze` | `tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts` |
| `npm run etl:transliteration` | `scripts/etl/generate-transliteration-aliases.ts` |
| `npm run ingest` | `package.json`에는 `src/interface/cli/ingest.command.ts` 로 선언되어 있으나, **해당 경로 파일은 현재 레포 트리에 없음** — 스크립트 정리 전까지 참고용. |
| `npm run kill-switch` | `src/interface/cli/kill-switch.command.ts` 선언과 동일하게 **파일 없음** (인입 문서 범위 밖이나 혼동 방지용). |

---

## 3. `scripts/etl/*` 전체 목록 (실행 스크립트 + 라이브러리)

| 파일 | 역할 |
|------|------|
| `types.ts` | Bronze/Silver/Enriched/Golden 타입 SSOT (`SilverWineRecord`, `EnrichedSilverRecord`, 품질 리포트 등). |
| `ndjson.ts` | NDJSON 파싱 유틸. |
| `vivino-to-silver.ts` | PG `wine_pdp_snapshot` → `SilverWineRecord` NDJSON. |
| `generate-aliases.ts` | Silver → 별칭 번들 부착 → Enriched NDJSON. |
| `generate-korean-aliases.ts` | Enriched → Claude로 KO 별칭 제안 → KO NDJSON (`ANTHROPIC_API_KEY`). |
| `generate-doc-queries.ts` | Enriched → doc2query로 검색 텍스트 확장 (`silver-enriched-docquery.ndjson`). |
| `validate-silver.ts` | Enriched 품질 게이트 + JSON 리포트. |
| `index-to-vespa.ts` | Enriched NDJSON → 임베딩 → `RetrievalDocument` → Vespa (`VESPA_URL`, `EMBEDDING_SERVICE_URL`). |
| `run-track-c.ts` | Track C 순차 실행 (node 오케스트레이터). |
| `run-track-c-step1.ts` | Critic proxy (`generate-critic-proxy` 모듈 사용). |
| `run-track-c-step2.ts` | 인증 라벨 (`enrich-certifications` 모듈). |
| `run-track-c-step3.ts` | 페어링 태그 정규화 (`generate-pairings` 모듈). |
| `drinking-window-backfill.ts` | 음용 시기 필드 백필. |
| `generate-critic-proxy.ts` | 스텝 12.1 — LLM 기반 비평가 점수 프록시 (모듈; step1에서 호출). |
| `enrich-certifications.ts` | 스텝 12.2 — Wikidata + LLM 폴백 (모듈; step2에서 호출). |
| `generate-pairings.ts` | 스텝 12.3 — 페어링 택소노미 정규화 (모듈; step3에서 호출). |
| `generate-transliteration-aliases.ts` | PG 기반 별칭 upsert (규칙 `Transliterator`). |
| `load-eval-cases.ts` | Golden JSONL → `eval_cases` 테이블 적재 (평가 데이터 인입). |
| `tag-queries-retrieval-mode.ts` | `golden-queries-bronze.jsonl`에 `retrieval_mode` 태깅 (데이터셋 가공). |

실행 가능 여부는 파일 상단 `#!/usr/bin/env tsx` 및 `main()` 존재 여부로 구분된다 — 위 표에서 **`load-eval-cases` / `tag-queries-retrieval-mode`** 는 `main`이 있으나 shebang 없음 → `npx tsx scripts/etl/...` 로 실행.

---

## 4. 타입·계약 (ETL 중간 표현)

`SilverWineRecord` / `EnrichedSilverRecord` 정의와 Bronze 행 형태는 한 파일에 모여 있다.

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

## 5. 품질 게이트 (`validate-silver.ts`)

입력 기본값 `data/silver-enriched.ndjson`, 리포트 `data/silver-quality-report.json`. 임계값 예시는 파일 내 `GATES` 상수에 정의됨.

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

## 6. Vespa 인덱싱 (`index-to-vespa.ts`)

- 입력: 기본 `data/silver-enriched.ndjson`.
- `EnrichedSilverRecord` → `silverToRetrievalDoc` → `toVespaFields` → `VespaClient.bulkFeed`.
- 임베딩: HTTP 배치 또는 결정론적 폴백.

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

인프라 매핑: `src/infrastructure/vespa/mapping.ts` (`toVespaFields`). 런타임 검색은 `VespaSearchIndex` 등이 `SearchIndexPort`를 구현.

---

## 7. Track C 오케스트레이션 (`run-track-c.ts`)

단일 파일 `data/silver-docquery.ndjson`에 대해 순서대로: critic proxy → certifications → pairing tags → drinking window.

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

`vivino-to-silver`와 별도로, 스냅샷만 내보낼 때 사용.

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

## 9. 평가·골든 쿼리 인입 (검색 인덱스와 인접)

| 스크립트 | 입출력 |
|----------|--------|
| `load-eval-cases.ts` | 기본 `data/golden-queries-bronze.jsonl` → PG `eval_cases` |
| `tag-queries-retrieval-mode.ts` | 동일 파일에 `retrieval_mode` 필드 추가 (in-place rename 패턴) |

검색 **런타임** 인입이 아니라 **오프라인 데이터셋·DB 시딩**이다.

---

## 10. 런타임 도메인 패키지 `src/domain/ingestion`

배치 NDJSON과 별도로, 코드베이스에 **인입·정규화·추출**용 순수 로직이 패키지화되어 있다 (`RFC-002` 계열 개념과 정합).

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

HTTP 서버 기동 경로에서 반드시 전부 쓰이는 것은 아니며, **소스 정규화·매칭·리니지** 확장 지점이다.

---

## 11. Fine-tuning·학습 데이터 (인덱스 인입과 인접)

| 경로 | 비고 |
|------|------|
| `scripts/fine-tune/prepare-finetuning-data.ts` | `npm run finetuning:prepare` — 임베딩/LTR 등 학습용 데이터 준비 (Silver/Vespa 파이프와 별도). |
| `scripts/fine-tune/bge-m3-finetune.py` | Python 측 파인튜닝 보조 스크립트(레포 내 동반 파일). |
| `scripts/embedding/finetune-bge-m3.ts` | 골든 쿼리·도메인 로직으로 BGE-M3 파인튜닝 실험용 엔트리 (GPU/프로덕션은 주석에 HF 절차). |

---

## 12. 임베딩 재색인·LTR 보조 (`scripts/ltr/`)

| 파일 | 역할 |
|------|------|
| `generate-triplets.ts` | `golden-queries-bronze.jsonl` → `data/triplets-train.jsonl` (트리플 학습 샘플). |
| `reindex-embeddings.ts` | Vespa에 있는 문서를 읽어 새 임베딩 서비스로 벡터만 갱신 후 upsert. |
| `validate-embedding.ts` | 스파스 베이스라인 대비 Recall/NDCG 비교 (회귀 검증). |
| `finetune_embedding.py` | `triplets-train.jsonl`로 BGE-M3 와인 도메인 파인튜닝 (SentenceTransformers; `python scripts/ltr/finetune_embedding.py`). |
| `distill_cross_encoder.py` | 크로스 인코더 지식 증류로 바이인코더 재학습 (`python scripts/ltr/distill_cross_encoder.py`). |

배치 ETL `index-to-vespa.ts`와 달리 **이미 인덱스된 Vespa**를 전제로 한 **운영·실험** 경로다.

---

## 13. Vespa·PG 시딩·스키마 (`scripts/` 루트)

| 파일 | 역할 |
|------|------|
| `seed-wines-real.ts` | E2E/품질 레인용 **대량** 와인 문서를 Vespa에 시드 (`VESPA_URL`, 선택적 실제 임베딩). |
| `seed-vespa-test-data.ts` | **소형**(약 20문서) Vespa 테스트 피드. |
| `migrate.ts` | `npm run migrate` — `src/infrastructure/db/migrate.js` 기반 PG 마이그레이션 실행. |
| `prune-feedback-ttl.ts` | `npm run feedback:prune-ttl` — RFC-010 피드백 TTL 정리(PG). **인입이 아니라 학습 데이터 수명 주기**. |

**배포(데이터 아님):** `scripts/deploy-vespa.sh` — Vespa 애플리케이션 배포·인프라; NDJSON 파이프라인과 별도.

**테스트 레인 셸 (데이터 파일 생성 아님):** `setup-vespa-test.sh`, `teardown-vespa-test.sh`, `run-vespa-e2e.sh`, `run-vespa-test-lane.sh`, `run-vespa-quality.sh`, `run-vespa-verification.sh` — 로컬/CI에서 Vespa 기동·e2e·품질 검증을 묶어 실행.

---

## 13A. 임계값·모델 검증 (`scripts/` 루트, 인입과 인접)

| 파일 | 역할 |
|------|------|
| `calibrate-confidence-threshold.ts` | 오프라인 eval NDJSON으로 신뢰도 임계값 보정 (RFC-016/Epic 17.3; `run-offline-eval` 출력과 연계). |
| `verify-drinking-window-model.ts` | `npm run verify:drinking-window-model` — 음용창 ONNX(`window_start.onnx` / `window_end.onnx`) 존재 검증. |

---

## 14. 골든·평가 데이터 생성 (`scripts/eval/` 중 인입과 맞닿는 것)

| 파일 | 입·출력 요약 |
|------|----------------|
| `generate-golden-queries.ts` | 기본 `data/silver-enriched.ndjson` → `data/golden-queries-bronze.jsonl` (시나리오별 골든 쿼리 NDJSON). |
| `mine-hard-negatives.ts` | `silver-enriched` → `data/hard-negatives.jsonl` (혼동 엔티티 쌍). |
| `build-splits.ts` | `golden-queries-bronze.jsonl`에 train/val/gate 스플릿 (RFC-017 누설 방지 클러스터 규칙). |
| `run-eval-and-train-ltr.ts` | PG 골드셋·평가·LambdaMART 학습; 엔트리에서 `createContainer`로 `SearchUseCase` 조립 후 실행 (`npx tsx scripts/eval/run-eval-and-train-ltr.ts`, PG 환경 필요). |
| `verify-splits.ts` | `build-splits` 산출물(`data/splits/*.jsonl`)이 RFC-017 누설 규칙을 만족하는지 **검증**(exit 1 on violation). |
| `split-integrity.ts` | 위 검증 로직 본체; `run-offline-eval.ts`의 `--verify-splits`에서도 공유. |

`entity-type.ts` — 골든 쿼리의 엔티티 대상 타입 판별 로직; `metrics.ts` 등 **평가 런타임**에서 import (단독 CLI 아님).

나머지 `scripts/eval/*` (오프라인 메트릭, 베이스라인, noisy eval, significance 등)는 **평가 실행**이지 카탈로그 **인입**은 아니다 — 필요 시 `package.json`의 `eval:*` 스크립트를 본다.

---

## 15. 관련 RFC·플랜

- **RFC-002** — Ingestion·canonicalization  
- **RFC-003** — Alias 타입·투영  
- **RFC-017** — IR 품질 플라이휠 (Vivino ETL·골든 쿼리 등)  
- `docs/plans/apr-5-v0.1/epic-1-etl-pipeline.md` — ETL 에픽 상세 (체크박스는 운영 데이터와 별도 검증)  

인덱스: `docs/RFC-INDEX.md`.

---

## 16. 빠진 항목 체크 (이 문서 스코프)

| 영역 | 포함 여부 |
|------|-----------|
| `scripts/etl` 내 모든 `.ts` | §3 표 |
| Bronze PG + export 도구 | §2, §8 |
| Silver/Enriched 타입 | §4 |
| 검증·리포트 | §5 |
| Vespa 피드 (배치 NDJSON) | §6 |
| Track C 4단계 | §7 |
| PG 별칭 transliteration | §2, §3 |
| Golden → PG / retrieval_mode 태깅 | §9 |
| `src/domain/ingestion` | §10 |
| Fine-tune·임베딩 스크립트 | §11 |
| LTR·재색인·트리플·**Python LTR** | §12 |
| Vespa/PG 시드·마이그레이션·피드백 TTL·**Vespa 테스트 셸** | §13 |
| 임계값 보정·음용창 ONNX 검증 | §13A |
| 골든 생성·하드 네거티브·스플릿·스플릿 검증 | §14 |
| 런타임 검색·리트리버 | **제외** (`retriever-pipeline.md`) |
| `package.json`의 `vivino:bronze` / `etl:transliteration` | §2 표 |
| `npm run ingest` / `kill-switch` 선언 vs 실제 파일 | §2 (불일치 명시) |
| `deploy-vespa.sh` (인프라 배포) | §13 한 줄 |
| 레포·계약·디버그 전용 스크립트 | **의도적 제외** — `find-domain-orphans.ts`, `export-http-contract-manifest.ts`, `export-http-openapi-bridge.ts`, `verify-anthropic-wiring.ts`, `dev/test-search-direct.ts` (인입 파이프라인 아님) |
