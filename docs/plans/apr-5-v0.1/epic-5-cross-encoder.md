# Epic 5: Cross-Encoder Reranker

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 5
**의존성:** Epic 1 (search_text_en 채워진 인덱스)
**블록하는 Epic:** 6 (distillation에 cross-encoder score 필요)

---

## 목표

`reranker.ts`의 canonicalLabel 위주 passage를 wine-aware rich text로 확장.
NDCG@5 ≥ +0.03 개선.

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| `src/infrastructure/vespa/reranker.ts` | ✅ HTTP adapter, RerankerPort contract |
| `src/domain/ranking/service/ranker.ts` | ✅ rerank 호출 + 0.6/0.4 blend |
| `src/domain/ranking/port/reranker.port.ts` | ✅ port interface |

**핵심 문제:** reranker는 이미 작동하지만, 입력 passage가 canonicalLabel 위주.
producer/vintage/region/tasting notes 정보 부족 → reranking 품질 제한.

## 작업 항목

### 5.1 모델: `BAAI/bge-reranker-v2-m3`

- BGE-M3 family (embedding space 일관성)
- Multilingual (KO 30% 사용자)
- 568M params, top-20 rerank → CPU ~80ms

### 5.2 Wine-aware Text Assembly

**`src/domain/ranking/service/ranker.ts`에 추가:**

```typescript
function buildWineText(entry: ScoredEntry): string {
  return [
    entry.canonicalLabel,
    entry.producer,
    entry.vintageYear ? String(entry.vintageYear) : '',
    entry.appellation ?? entry.region ?? '',
    entry.country ?? '',
    entry.grapePrimary ?? '',
    entry.searchTextEn ?? '',
  ].filter(Boolean).join('. ');
}
```

### 5.3 Python FastAPI Reranker Service

**디렉토리:** `services/reranker/`

```
services/reranker/
├── main.py           # FastAPI app
├── requirements.txt  # transformers, torch, fastapi, uvicorn
├── Dockerfile
└── README.md
```

Endpoint: `POST /rerank { query, texts[] } → { results: [{ index, score }] }`

### 5.4 Adapter 수정

`src/infrastructure/vespa/reranker.ts`:
- 기존 RerankerPort contract 유지
- HTTP request/response parsing만 실 서비스에 맞춤

### 5.5 Docker Compose 추가

```yaml
reranker:
  build: ./services/reranker
  ports: ["8081:8081"]
  environment:
    - MODEL_NAME=BAAI/bge-reranker-v2-m3
```

## Deliverables

- [ ] `services/reranker/` (Python FastAPI)
- [ ] `services/reranker/Dockerfile`
- [ ] `src/domain/ranking/service/ranker.ts` — `buildWineText()` 추가
- [ ] `src/infrastructure/vespa/reranker.ts` — HTTP contract 실화
- [ ] `docker-compose.yml` reranker 서비스 추가

## 완료 기준

- [ ] Reranker Δ NDCG@5 ≥ +0.03 (gate tier)
- [ ] wrong_top1_rate 악화 없음
- [ ] Reranker latency ≤ 100ms (top-20, CPU)
- [ ] E2E search 정상 동작 확인
