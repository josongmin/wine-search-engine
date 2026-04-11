# EPIC-4: Retrieval as Evidence System

> 상태: 계획  
> 의존: EPIC-2 (ConstraintAtom으로 filter_trace가 의미 있어짐)  
> 후속: EPIC-5 (retrieval evidence detail → Score DAG input), EPIC-8 (retrieval_fusion_trace)

---

## 현재 문제

Retrieval은 multi-channel 검색 + RRF + hard filter + assembly 구조로 잘 되어 있으나:
- Response의 `evidence_items`와 `score_components`는 "사람이 보기 좋은 이유" 수준에 머무름
- **탈락 후보 trace가 없음** — hard filter에서 떨어진 후보가 아예 사라짐
- "왜 1등인지"는 부분적으로 역추적 가능하지만, "왜 이 후보가 탈락했는지"는 재현 불가
- dense 실패, anchor 실패, sparse-only 상황에서 provenance가 끊김

---

## 현재 코드 상태 (직접 확인)

| 항목 | 파일 | 현재 상태 |
|------|------|---------|
| `CandidateProvenance` | `candidate-envelope.ts` | `channels`, `channelScores`, `queryViewMatches` 등 포함. **`ChannelScoreEvidence`(channel/rawScore/rank/rrfContribution) 완전 구현** |
| `CandidateEnvelope` | `candidate-envelope.ts` | provenance 래핑 구조 완전 구현 |
| `DegradationReport` | `candidate-pool.ts:259–279` | `component/severity/reason/fallbackApplied` 4 필드 완전 구현 |
| detail helper type | — | **없음** — `ChannelScoreEvidence`가 부분 대응하지만 `matchedTerms`, `filterTrace`, `missingConstraints` 없음 |
| Hard filter drop trace | — | **없음** — 탈락 후보는 흔적 없이 사라짐 |
| `RrfFusionTrace` | — | **없음** — `candidateCount before/after` 기록 없음 |

**이미 있는 것:** `ChannelScoreEvidence`(rawScore, rank, rrfContribution)가 retrieval evidence detail의 약 50%를 커버.  
**핵심 갭:** `matchedTerms`, `filterTrace`, 탈락 후보 `DropLog`, `RrfFusionTrace`가 없음.

---

## 목표

기존 `CandidateProvenance` / `CandidateEnvelope` / `EvidenceAccumulator`를 SSOT로 유지한 채,
부족한 retrieval evidence만 증설한다.

- 채널별 matched term / filter detail 추가
- hard filter / coarse prune / assembly drop log 추가
- request-level `RrfFusionTrace` 추가

즉 EPIC-4의 목적은 **새 evidence substrate를 병렬 도입하는 것**이 아니라,
이미 있는 provenance contract를 audit-grade로 확장하는 것이다.

---

## 설계

### CandidateProvenance detail 확장

```typescript
interface CandidateProvenanceDetail {
  channel: 'sparse_bm25' | 'dense_semantic' | 'anchor_similarity' | 'learned_sparse'
  rawScore: number
  normalizedScore: number
  rrfContribution: number          // 1 / (k + rank) 이 후보의 기여값
  rank: number                     // 해당 채널 내 순위

  // 매칭 상세
  matchedTerms?: string[]          // sparse 채널 — 매칭된 BM25 토큰
  matchedConstraints?: string[]    // 충족된 제약 attribute 목록
  missingConstraints?: string[]    // 미충족 제약 attribute 목록

  // 채널 메타
  retrievalProfile: string         // vespa rank profile
  filterTrace?: FilterTrace        // hard filter 통과/탈락 여부

  // 상태 플래그
  degraded: boolean
  degradationReason?: string
}

interface FilterTrace {
  applied: string[]    // 통과한 필터 (attribute=value 형태)
  rejected?: string    // 탈락 원인 (탈락 후보에만)
}
```

### DropLog (탈락 후보 기록)

```typescript
interface CandidateDropRecord {
  entityId: string
  dropStage: 'hard_filter' | 'coarse_prune' | 'assembly_dedup'
  dropReason: string
  lastKnownScore: number
  channels: Pick<CandidateProvenanceDetail, 'channel' | 'rawScore' | 'rank'>[]
}
```

**샘플링 정책:**
- `explain=false` (production): 탈락 후보 중 상위 점수 기준 **top-5만** 보존
- `explain=true` (debug): 전체 탈락 후보 보존
- `HTTP_DEBUG_SECRET` 헤더 있을 때: full drop log

### RRF 융합 trace

```typescript
interface RrfFusionTrace {
  queryClass: string
  fusionClass: string
  rrfK: number
  channelWeights: {
    sparse: number
    dense: number
    anchor: number
    learnedSparse: number
  }
  candidateCount: {
    beforeFusion: { sparse: number; dense: number; anchor: number }
    afterFusion: number
    afterHardFilter: number
    afterAssembly: number
  }
}
```

### 기존 substrate와의 관계

- `CandidateProvenance`는 유지한다
- 별도 helper 타입이 필요하더라도 `CandidateProvenance`의 상세 필드로 붙이고, 별도 provenance truth를 만들지 않는다
- `CandidateEnvelope.legacyCandidate`와 병렬로 또 다른 candidate container를 만들지 않는다
- `RrfFusionTrace`는 candidate-level이 아니라 request-level trace다

### 삽입 위치

```
CandidatePoolService.execute() / evidence-accumulator 내부

  Promise.allSettled 채널 실행 (기존)
  ↓
  채널별 CandidateProvenance 상세 필드 생성 (신규)
  ↓
  RRF 융합 (기존) + RrfFusionTrace 생성 (신규)
  ↓
  Hard filter — FilterTrace 기록 (신규)
    → 탈락 후보 → DropLog 샘플 추가 (신규)
    → 통과 후보 → CandidateProvenance.filterTrace 상세 업데이트 (신규)
  ↓
  Assembly (기존)
  ↓
  CandidateEnvelope.provenance에 상세 evidence 첨부
```

---

## 완료 조건

- 임의 결과 1개를 뽑아서 "왜 1등인지" 채널별 기여(`rrfContribution`) 기준 재현 가능
- 임의 탈락 후보 1개를 뽑아서 "왜 떨어졌는지" (`dropReason`) 재현 가능
- dense 실패 시: provenance detail의 `degraded=true` + sparse만으로 RRF 재계산, provenance 유지
- anchor 실패 시: anchor 채널 `degraded=true` + 2채널 RRF로 폴백, 기록 유지
- `RrfFusionTrace`가 response meta explain/debug trace에 포함됨
- 기존 `CandidateProvenance`와 새 evidence detail 간에 중복 truth가 생기지 않음

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/domain/retrieval/service/candidate-pool.ts` | evidence detail 생성, DropLog 샘플링 |
| `src/domain/retrieval/model/candidate-envelope.ts` | `CandidateProvenance` 상세 필드 확장 |
| `src/domain/retrieval/service/evidence-accumulator.ts` | 누적 evidence merge 규칙 확장 |
| `src/domain/retrieval/model/evidence-packet.ts` | **신규 가능** — 단, internal helper 타입일 뿐 SSOT가 아니어야 함 |
| `src/domain/shared/utils/rrf.ts` | `rrfContribution` 반환 지원 |
| `src/domain/retrieval/service/candidate-assembler.ts` | 탈락 후보 DropLog 생성 |
| `src/interface/http/schemas/search-response.schema.ts` | `retrieval_fusion_trace` 필드 추가 |
