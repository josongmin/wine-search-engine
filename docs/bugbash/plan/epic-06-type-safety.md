# Epic 06 — 타입 안전 → 안전한 Feature Pipeline

**Phase:** A (기반 정리)
**우선순위:** P1 (production data path)
**Breaking:** Minimal
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

`as unknown as` cast는 **feature pipeline의 silent corruption** 원인이다.
- Vespa 응답 shape이 바뀌면 `as VespaQueryResponse`가 garbage를 통과시킴
- LTR feature extractor가 이 garbage를 학습 → 모델 오염
- JSONB cast가 migration 후 broken data를 통과시킴 → calibration data 오염

**SOTA:** External data boundary에서 **반드시** schema validation.
- Google: Protocol Buffers (schema 강제)
- 학계: Feature store with schema registry (Feast, Tecton)

---

## Task 목록

### T06-1. Vespa 응답 Zod 검증

`vespa-client.ts:392`, `vespa-candidate-attributes.ts` → Zod parse.
**SOTA 얼라인:** Vespa schema 변경 시 즉시 감지 → 학습 데이터 오염 방지.

### T06-2. Agent Orchestrator `as` cast 제거

`agent-orchestrator.ts:244,756` → runtime guard + Zod.
**SOTA 얼라인:** LLM output validation — LLM은 schema를 위반할 수 있음.

### T06-3. LLM/SDK 어댑터 `as` cast 제거

`anthropic-llm-injection-classifier.ts:162,43`, `nl-mapper.ts:502-508` → runtime check.

### T06-4. `file-mapping-table.ts` JSON.parse 검증

`as NLMapping[]` → Zod array schema.

### T06-5. JSONB 읽기 `as` → Zod

PG 어댑터 JSONB → Zod `.parse()`. Migration/ETL 버그 즉시 감지.

### T06-6. Truthy 가드 수정

| 위치 | 변경 |
|------|------|
| `getOrEmbedBatch` `if (embedding)` | `embedding.length > 0` |
| `FutureDateTimeSchema` `getTime()` | `Number.isFinite()` |
| `redis-*-cache.ts` `parseInt` | `Number.isFinite()` |

### T06-7. `z.number()` `.finite()` 누락

`RERANK_BLEND_SCALE`, `CONFIDENCE_REFUSAL_THRESHOLD` 등.

### T06-8. ETL `JSON.parse` 검증

4곳 (generate-critic-proxy, load-eval-cases, etl-utils, run-track-c) → `unknown` + validate.

---

## 완료 조건

- Production `as unknown as` → Zod/guard (테스트 코드 제외)
- External data boundary에서 schema validation 100%
