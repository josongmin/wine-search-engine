# RFC-022 — Learned-Sparse (SPLADE) Doc-Side Encoder

**상태**: Draft
**작성일**: 2026-06-02
**상위·연관 문서**
- `RFC-000` — Master Architecture
- `RFC-018` — Scope & Field Ownership (Vespa `wine_entity` schema ownership)
- `RFC-017` — Offline Eval Flywheel (NDCG gate for any ranking change)
- SSoT: `scripts/etl/learned-sparse-spec.ts` (artifact format), `src/domain/shared/utils/rrf.ts`

**충돌 시 RFC-018이 우선한다 (schema ownership).**

---

## 0. 한 줄 방향

> **운영 기본 rank-profile(`wine_aware`)이 광고하는 learned-sparse 채널을 "광고만 하고 0 기여"에서 "실제 SPLADE 신호"로 전환한다.**

---

## 1. Problem Statement

`wine_aware`(운영 기본)는 first-phase에 learned-sparse 항을 갖는다:

```
+ query(weight_learned_sparse) * learned_sparse_score
  where learned_sparse_score = sum(query(sparse_query_embedding) * attribute(learned_sparse_weights))
```

그러나 감사(2026-06-02) 결과 이 채널은 **구조적으로 0을 기여**한다:

1. **Doc-side가 비어 있다.** `learned_sparse_weights` attribute를 채우는 ETL producer가 레포 전체에 0개다. `index-to-vespa.ts`는 `rec.learnedSparseWeights`를 조건부로 *읽기만* 하고 어떤 단계도 그것을 *생성*하지 않는다. `docs/system-overview/ingestion-pipeline.md`는 "SPLADE 인코더 — composition root import 0"이라고 명시한다.
2. **Query-side는 SPLADE가 아니다.** `buildLearnedSparseQueryWeights`는 이름과 달리 **term-frequency + boost-count 휴리스틱**이다(쿼리 토큰화 → 등장 횟수 → `1+(count-1)*0.25`). MLM 기반 학습 토큰 확장이 없다.
3. **설령 진짜 doc encoder만 붙여도 채널은 여전히 0에 가깝다.** 아래 §2의 토큰-공간 불일치 때문.

결과: `wine_aware` ≈ `hybrid`. `weight_learned_sparse` 튜닝·운영 capacity가 통째로 dead다.

---

## 2. 핵심 제약 — 토큰 공간 정합 (Train/Serve Token-Space Alignment)

SPLADE 점수는 `sum_t q_t · d_t` 로, **q와 d가 동일한 vocab(토큰 ID 공간)을 공유할 때만** 의미가 있다.

| 측면 | 현재 query-side | 진짜 SPLADE doc encoder |
|---|---|---|
| 토큰 단위 | raw word (`cabernet`, `napa`) | wordpiece / vocab-ID (`##net`) + MLM 확장어 |
| 확장 | 없음 | 학습된 term expansion (동의어·형태 변형) |
| 공간 | 임의 surface string | 모델 vocab (예: BERT 30522) |

→ **doc-side만 SOTA 모델로 바꾸면 두 공간이 안 맞아 내적이 거의 0.** 따라서 본 RFC의 범위는 "doc encoder 추가"가 아니라 **"doc + query 양쪽을 동일 SPLADE 모델로 교체하고 vocab을 SSoT로 고정"** 이다. 이것이 비-타협 요구사항(non-negotiable invariant)이다.

---

## 3. 모델 & 런타임 결정

### 3.1 모델
- **후보**: `naver/splade-v3` (또는 `splade-cocondenser-ensembledistil`). MS MARCO 학습, BEIR에서 dense+sparse RRF 대비 강건.
- **출력**: vocab 차원 sparse logits → ReLU·log-saturation 후 비-0 토큰만 보존 (`LearnedSparseVector`).
- **다국어 주의**: 한국어 쿼리(`오푸스원`)는 영어 SPLADE vocab에 약하다. **doc-side는 영어 `search_text_en` 기반**으로 인코딩하고, 한국어 recall은 기존 alias/BM25(`search_text_ko`)·dense 채널에 맡긴다(SPLADE를 한국어로 무리하게 확장하지 않음 — 별도 후속).

### 3.2 런타임 — **in-process onnxruntime-node** (권장)
- 레포에 이미 `onnxruntime-node ^1.22.0`가 있고, `src/infrastructure/ml/drinking-window-predictor.ts`가 동일 패턴(InferenceSession 지연 로드 → `session.run`)으로 ONNX LightGBM을 서빙한다. **새 모델-서빙 의존성 0.**
- 대안(기각): (a) EC2 sidecar — 운영 표면·네트워크 추가, (b) HF Inference API — 외부 의존·비용·헤드리스/cron에서 불안정.
- 토크나이저: SPLADE는 WordPiece가 필요. ONNX export 시 tokenizer를 동봉하거나 `@huggingface/transformers`(Xenova) WASM 토크나이저를 ETL 단계에서만 사용(런타임 src/ 의존 아님, scripts/etl 한정).

### 3.3 모델 아티팩트 배치
- `src/infrastructure/ml/`의 ONNX 로딩 규약을 따른다(모델 디렉터리 경로 주입). 아티팩트는 git 비포함 — `/Users/<user>/.wine-search-engine/` 외부 아티팩트 링크 패턴(`scripts/build/link-external-artifacts.sh`) 재사용.

---

## 4. 아키텍처

```
                         ┌──────────────────────────────────────────┐
                         │ SpladeEncoder (포트)                       │
                         │  encode(text): LearnedSparseVector         │
                         │  modelId / vocabVersion                    │
                         └──────────────────────────────────────────┘
              doc-side ▲                                   ▲ query-side
   ┌────────────────────────────┐               ┌──────────────────────────────┐
   │ ETL: encode search_text_en │               │ buildLearnedSparseQueryWeights│
   │ → learnedSparseWeights     │               │ (휴리스틱 제거 → 동일 encoder) │
   │   (index-to-vespa 신규 단계)│               │                              │
   └────────────────────────────┘               └──────────────────────────────┘
              │ 동일 modelId/vocabVersion (SSoT) — train/serve skew guard       │
              ▼                                                                 ▼
        Vespa learned_sparse_weights (mapped tensor)  ◄── sum ───  query(sparse_query_embedding)
```

- **SSoT 불변식**: doc 아티팩트와 query 인코딩은 `modelId` + `vocabVersion`이 **반드시 일치**. 불일치 시 query-side는 sparse 항을 통째 비활성(0 기여)으로 폴백하고 `silent-skip-counters`에 계측 — 절대 잘못된 vocab로 내적하지 않는다.
- `LearnedSparseVector.modelId`(이미 spec에 존재)를 train/serve skew 감지에 사용.

---

## 5. 단계별 구현 (phased, 각 단계 독립 머지 가능)

| Phase | 산출물 | 검증 게이트 |
|---|---|---|
| **P0 (이 RFC)** | ✅ 설계 합의, 토큰-공간 불변식 명문화 | 리뷰 |
| **P1** | ✅ `SpladeEncoder` 포트(`scripts/etl/splade-encoder.ts`) + ETL DI 배선(`silverToIndexable`/`silverToRetrievalDoc`에 옵셔널 `spladeEncoder`). stub은 테스트 한정. 인코더 미주입 시 byte-identical. | ✅ 5 단위테스트 green: stub로 doc→artifact→Vespa cells roundtrip, modelId stamp, 결정성, 미주입 시 현행 동일 |
| **P2** | ONNX SPLADE 인코더 실제 구현(onnxruntime-node) + 모델 아티팩트 링크 + 토크나이저 | 골든 텍스트 N개 인코딩이 레퍼런스 sparse vector와 일치(±tol) |
| **P3** | query-side 휴리스틱 제거 → 동일 encoder로 교체 + vocab SSoT guard | train/serve skew 단위테스트(modelId 불일치 → 0 폴백 + 카운터) |
| **P4** | 전 코퍼스 재인덱싱 + **RFC-017 오프라인 NDCG 게이트** (sparse ON vs OFF) | NDCG@10 비-회귀 + `weight_learned_sparse` 재calibration |
| **P5** | `weight_learned_sparse` 튜닝(현 0.10 → eval 기반) + 문서/카탈로그 동기화 | gate-set PASS |

**롤백 안전**: P1~P3 동안 `weight_learned_sparse`를 사실상 0으로 두거나 doc 아티팩트 부재 시 자연 0 기여이므로 운영 영향 없음. P4의 NDCG 게이트 PASS 전까지 production weight를 올리지 않는다.

---

## 6. 리스크 & 비-목표

- **비-목표**: 한국어 SPLADE(별도 후속), ColBERT late-interaction(범위 밖), query-side 다중패스 RRF(앱 레이어 관심사).
- **리스크 R1 (vocab skew)**: §4 guard로 차단 — 불일치 시 0 폴백 + 계측.
- **리스크 R2 (인덱싱 비용)**: ~11K doc × ONNX 인코딩. 배치·`contentHash` 멱등(embedding 재사용 패턴 재활용)으로 증분화.
- **리스크 R3 (텐서 폭증)**: `MAX_SPARSE_TENSOR_CELLS` 캡 이미 read/write 양쪽에 존재(mapping.ts) — P2에서 상위-weight 보존 로직 재확인.
- **리스크 R4 (BM25 중복)**: SPLADE가 BM25와 겹치면 lift가 작다. P4 게이트가 ROI를 실증 — lift 미달이면 채널을 정직하게 제거(F3 대안 C로 회귀)하고 본 RFC를 `Rejected-by-eval`로 기록.

---

## 7. 결정 로그
- **2026-06-02**: 런타임 = in-process onnxruntime-node(기존 패턴 재사용, 새 서비스 0). doc-side = `search_text_en` 영어 한정. query-side 휴리스틱은 P3에서 제거.
