# Wave 1–2 작업지시서 (Runbook)

**날짜:** 2026-04-05
**범위:** Epic 1 (ETL) → Epic 2a (Golden Queries) → Epic 3 (Eval) → Epic 5 (Reranker)
**전제:** Vespa + PostgreSQL + Redis 구동 중. `.env` 설정 완료.

---

## 0. 사전 조건 확인

```bash
# 인프라 구동 확인
docker compose up -d postgres redis vespa
docker compose ps                          # 모두 healthy 확인

# 환경변수 확인 (.env에 아래 필수)
cat .env | grep -E '^(DATABASE_URL|PG_|VESPA_URL|EMBEDDING_SERVICE_URL|ANTHROPIC_API_KEY)'
```

| 변수 | 필수 | 용도 |
|---|---|---|
| `DATABASE_URL` 또는 `PG_*` | ✅ | Bronze DB 접근 |
| `VESPA_URL` | ✅ | Vespa feed/query |
| `EMBEDDING_SERVICE_URL` | 선택 | BGE-M3 서비스. 없으면 deterministic fallback |
| `ANTHROPIC_API_KEY` | 선택 | Korean alias + doc2query. 없으면 skip |
| `RERANKER_SERVICE_URL` | 선택 | Cross-encoder. 없으면 rerank skip |

---

## Phase 1: Epic 1 — ETL Pipeline

### Step 1.1: Bronze → Silver 변환

```bash
npx tsx --env-file=.env scripts/etl/vivino-to-silver.ts \
  --output data/silver.ndjson
```

**예상 출력:**
```
Fetching Bronze rows from wine_pdp_snapshot …
  Bronze rows fetched: ~10000
  Transformed: ~9500  (skipped: ~500)
  After dedup: ~8500
  Written to: data/silver.ndjson
  Coverage: tasting=XX/8500 (XX%), price=XX, grape=XX
```

**체크포인트:**
- [ ] `data/silver.ndjson` 생성됨
- [ ] record 수 ≥ 8000
- [ ] tasting coverage 확인 (30% 이상이어야 quality gate 통과)

### Step 1.2: Alias 생성 (규칙 기반)

```bash
npx tsx scripts/etl/generate-aliases.ts \
  --input data/silver.ndjson \
  --output data/silver-enriched.ndjson
```

**예상 출력:**
```
  Total aliases: ~45000  (mean: ~5.3/entity)
  Needs review: ~8000
```

**체크포인트:**
- [ ] mean alias count ≥ 3

### Step 1.3: Korean Alias 생성 (LLM) — ANTHROPIC_API_KEY 필요

```bash
# dry-run 먼저 (API 호출 없이 프롬프트 확인)
npx tsx --env-file=.env scripts/etl/generate-korean-aliases.ts \
  --input data/silver-enriched.ndjson \
  --dry-run --limit 3

# 실행 (비용: ~$0.60)
npx tsx --env-file=.env scripts/etl/generate-korean-aliases.ts \
  --input data/silver-enriched.ndjson \
  --output data/silver-enriched-ko.ndjson
```

> **API 키 없으면:** 이 단계 skip. Step 1.4에서 `--input data/silver-enriched.ndjson` 사용.

**체크포인트:**
- [ ] Korean aliases 생성됨 (collisions 리포트 확인)

### Step 1.4: Document Expansion (LLM) — ANTHROPIC_API_KEY 필요

```bash
# dry-run
npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts \
  --input data/silver-enriched-ko.ndjson \
  --dry-run --limit 2

# 실행 (비용: ~$1-3)
npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts \
  --input data/silver-enriched-ko.ndjson \
  --output data/silver-final.ndjson
```

> **API 키 없으면:** 이 단계 skip. `cp data/silver-enriched.ndjson data/silver-final.ndjson`

### Step 1.5: Silver Quality Gate

```bash
npx tsx scripts/etl/validate-silver.ts \
  --input data/silver-final.ndjson
```

**체크포인트 (자동 검증):**
- [ ] ✅ Quality gate PASSED
- [ ] records ≥ 8000
- [ ] tastingNotesCoverage ≥ 30%
- [ ] aliasMeanCount ≥ 3
- [ ] body mean 0.1–0.9 범위

> **FAILED 시:** `data/silver-quality-report.json`의 `blockers` 확인 → 원인 수정 → Step 1.1부터 재실행.

### Step 1.6: Vespa 인덱싱

```bash
# dry-run (Vespa 호출 없이 1개 샘플 확인)
npx tsx --env-file=.env scripts/etl/index-to-vespa.ts \
  --input data/silver-final.ndjson \
  --dry-run --limit 1

# 실행 (embedding service 없으면 deterministic fallback)
npx tsx --env-file=.env scripts/etl/index-to-vespa.ts \
  --input data/silver-final.ndjson
```

**예상 출력:**
```
  Records to index: ~8500
  Using real BGE-M3 embeddings  (또는: Using deterministic fallback)
  Progress: 170/170 batches  (8500 indexed, 0 failed)
  Done: 8500 indexed, 0 failed
```

**체크포인트:**
- [ ] 0 failures
- [ ] Vespa에서 count 확인:
```bash
curl -s "http://localhost:8080/search/?yql=select%20*%20from%20wine_entity%20where%20true%20limit%200&hits=0" | jq '.root.fields.totalCount'
```

---

## Phase 1: Epic 2a — Golden Query Set (Epic 1과 병렬 가능)

### Step 2.1: Golden Query 생성

```bash
# Silver-enriched 파일이 필요 (Step 1.2 이후)
npx tsx scripts/eval/generate-golden-queries.ts \
  --input data/silver-enriched.ndjson \
  --output data/golden-queries-bronze.jsonl
```

**예상 출력:**
```
  Scenario A: 75/75 generated
  Scenario B: 60/60 generated
  ...
  Total queries: 500
```

**체크포인트:**
- [ ] Total ≥ 460 queries (일부 scenario는 데이터 부족으로 target 미달 가능)
- [ ] 8개 scenario 모두 생성됨

### Step 2.2: Hard Negative Mining

```bash
npx tsx scripts/eval/mine-hard-negatives.ts \
  --input data/silver-enriched.ndjson \
  --output data/hard-negatives.jsonl
```

**체크포인트:**
- [ ] 3가지 strategy 모두 결과 있음 (same-producer, same-vintage-region, alias collision)

### Step 2.3: Split 생성

```bash
npx tsx scripts/eval/build-splits.ts \
  --input data/golden-queries-bronze.jsonl
```

**예상 출력:**
```
  Clusters: ~XXX
  Train: ~350  Val: ~75  Gate: ~75
```

### Step 2.4: Split 무결성 검증

```bash
npx tsx scripts/eval/verify-splits.ts
```

**체크포인트:**
- [ ] ✅ Split integrity PASSED

---

## Phase 1: Epic 3 — Eval Baseline (Epic 1 + 2a 완료 후)

### Step 3.1: Search API 구동

```bash
# 별도 터미널
npm run dev
```

### Step 3.2: Offline Eval 실행

```bash
npx tsx --env-file=.env scripts/eval/run-offline-eval.ts \
  --input data/golden-queries-bronze.jsonl \
  --tier bronze \
  --output data/eval-baseline-bronze.json
```

**예상 출력:**
```
=== EVAL RESULTS ===
  Queries:          500
  NDCG@10:          0.XXXX
  MRR@10:           0.XXXX
  Recall@100:       0.XXXX
  Decision Utility: 0.XXXX
  WrongTop1 rate:   0.XXXX
  AURC:             0.XXXX
  ECE:              0.XXXX
```

**체크포인트:**
- [ ] 결과 파일 생성됨
- [ ] 모든 metric 값이 0이 아님 (search API 정상 동작 확인)
- [ ] scenario별 breakdown 확인

### Step 3.3: Baseline Commit

```bash
mkdir -p data/eval-baselines
cp data/eval-baseline-bronze.json data/eval-baselines/baseline-v1-bronze.json
```

> 이 baseline이 향후 release gate의 기준점이 된다.

---

## Phase 1: Epic 5 — Cross-Encoder Reranker (Epic 1과 병렬)

### Step 5.1: Reranker 서비스 빌드 & 실행

```bash
# Docker로
docker compose up -d reranker
docker compose logs -f reranker  # "Model loaded." 확인 (최초 ~2-5분)

# 또는 로컬로
cd services/reranker
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8081
```

### Step 5.2: Health Check

```bash
curl http://localhost:8081/health
# {"status":"ok","model":"BAAI/bge-reranker-v2-m3","device":"cpu"}
```

### Step 5.3: Smoke Test

```bash
curl -X POST http://localhost:8081/rerank \
  -H "Content-Type: application/json" \
  -d '{
    "query": "opus one 2018",
    "texts": [
      "Opus One 2018. Napa Valley. Cabernet Sauvignon blend.",
      "Chateau Margaux 2015. Bordeaux. First Growth.",
      "Yellow Tail Shiraz. Southeast Australia."
    ]
  }'
```

**예상:** Opus One이 가장 높은 score.

### Step 5.4: .env에 reranker URL 추가

```bash
echo 'RERANKER_SERVICE_URL=http://localhost:8081' >> .env
```

### Step 5.5: Reranker 포함 Eval 재실행

```bash
# search API 재시작 (새 .env 반영)
npm run dev

npx tsx --env-file=.env scripts/eval/run-offline-eval.ts \
  --input data/golden-queries-bronze.jsonl \
  --tier bronze \
  --output data/eval-with-reranker-bronze.json
```

**체크포인트:**
- [ ] NDCG@10이 baseline 대비 ≥ +0.03 개선

---

## 파이프라인 실행 순서 요약

```
Step 1.1 (Silver)
  ↓
Step 1.2 (Aliases)  ───→  Step 2.1 (Golden Queries) → Step 2.2 (Hard Neg) → Step 2.3-2.4 (Splits)
  ↓
Step 1.3 (Korean, optional)
  ↓
Step 1.4 (doc2query, optional)
  ↓
Step 1.5 (Quality Gate)
  ↓
Step 1.6 (Vespa Index)  ───→  Step 3.1-3.3 (Eval Baseline)
                                     ↓
Step 5.1-5.4 (Reranker)  ───→  Step 5.5 (Eval with Reranker)
```

---

## 전체 파이프라인 원커맨드 (LLM 단계 제외)

```bash
# 1. ETL (LLM 없이)
npx tsx --env-file=.env scripts/etl/vivino-to-silver.ts --output data/silver.ndjson && \
npx tsx scripts/etl/generate-aliases.ts --input data/silver.ndjson --output data/silver-enriched.ndjson && \
cp data/silver-enriched.ndjson data/silver-final.ndjson && \
npx tsx scripts/etl/validate-silver.ts --input data/silver-final.ndjson && \
npx tsx --env-file=.env scripts/etl/index-to-vespa.ts --input data/silver-final.ndjson

# 2. Golden Queries
npx tsx scripts/eval/generate-golden-queries.ts --input data/silver-enriched.ndjson && \
npx tsx scripts/eval/mine-hard-negatives.ts --input data/silver-enriched.ndjson && \
npx tsx scripts/eval/build-splits.ts && \
npx tsx scripts/eval/verify-splits.ts

# 3. Eval (search API 구동 상태에서)
npx tsx --env-file=.env scripts/eval/run-offline-eval.ts \
  --tier bronze --output data/eval-baseline-bronze.json
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `DATABASE_URL is not a valid URL` | .env 누락 또는 형식 오류 | `DATABASE_URL=postgresql://user:pass@host:port/db` 확인 |
| Quality gate FAILED: records < 8000 | dedup 후 너무 많이 탈락 | `--limit` 없이 전체 실행 확인, Bronze DB row count 확인 |
| Quality gate FAILED: tasting < 30% | Vivino payload에 style.description 없음 | 정상일 수 있음. threshold 조정 검토 |
| Vespa indexing failures | Schema mismatch | `vespa/app/schemas/wine_entity.sd` 배포 확인: `bash scripts/deploy-vespa.sh` |
| Eval 모든 metric = 0 | Search API 미구동 | `npm run dev` 확인, `curl localhost:3000/health` |
| Reranker OOM | GPU 메모리 부족 | `DEVICE=cpu` 환경변수 설정 (느리지만 안정) |
| Korean alias batch fail | API rate limit | `BATCH_SIZE` 줄이기 (20 → 10), 재시도 |
| Split verify FAILED | Leakage detected | `build-splits.ts` 재실행, entity clustering 확인 |

---

## 다음 단계 (Wave 3)

Wave 1–2 완료 후:
1. **Epic 4 (LTR):** baseline eval 결과 + golden query labels로 LambdaMART 학습
2. **Epic 2c (Gate):** Bronze queries 중 subset을 human review → Gate tier 승격
3. **Epic 6 (Embedding fine-tune):** golden pairs + cross-encoder scores로 contrastive fine-tune
