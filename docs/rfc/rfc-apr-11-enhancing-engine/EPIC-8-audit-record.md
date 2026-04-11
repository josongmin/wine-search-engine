# EPIC-8: Response를 판정 기록물로 확장

> 상태: 계획  
> 의존: EPIC-3 (PolicyDecisionRecord), EPIC-4 (CandidateProvenance 확장, RrfFusionTrace), EPIC-5 (ScoreDecomposition, ScoreDriftRecord), EPIC-6 (TypedAbstainDecision), EPIC-7 (ToolOutcome / contract projection)  
> **EPIC 2–7이 실제 trace를 생성해야 이 EPIC이 의미 있음 — 마지막에 조립**

---

## 현재 문제

`SearchResponseSchema`는 `engine_decision`, `decision_snapshot`, `evidence_items`, `counterfactuals`, `retrieval_provenance_slices`, `meta.determinism_fingerprint`까지 있어서 뼈대는 이미 있다:
- 각 필드가 "결과를 사람이 보기 좋게 표현"하는 수준에 머무름
- "엔진이 어떻게 사고했고 어디서 보수적으로 멈췄는지"가 재현 불가능
- `determinism_fingerprint`는 schema와 util은 존재하지만 입력 계약이 좁고 runtime wiring이 불완전해서 drift 감지 신뢰도가 낮음
- Planner, Constraint Reasoner, Ranker, Abstain의 결정이 각각 분리된 필드가 없음

즉 문제는 audit skeleton이 없는 것이 아니라, **기존 schema/meta가 부분적으로만 차 있고 세부 trace가 빠져 있다는 점**이다.

추가로 현재 코드에는 이미 다음 substrate가 존재한다:

- `ResponseBuilder`가 main runtime response surface SSOT
- `decision_snapshot`이 replay / audit 비교의 기준
- `response_hash`가 stable response-level determinism signal 역할을 일부 수행
- `buildDeterminismFingerprint()` 유틸과 `SearchResponseMetaSchema.determinism_fingerprint` 필드가 이미 존재

따라서 EPIC-8은 새로운 audit object를 옆에 두는 방향이 아니라,
**기존 response assembly 경로 위에 audit-grade trace를 증설하는 방향**으로만 가야 한다.

---

## 목표

응답 하나가 **결과 JSON**이 아니라,  
엔진이 어떻게 사고했고 어디서 보수적으로 멈췄는지까지 포함한 **감사 가능한 판정 기록물**이 된다.

단, 별도 audit envelope를 병렬로 도입하지 않는다. 기존 `engine_decision` + `meta` + `decision_snapshot`을 SSOT로 삼아 선택 필드를 증설한다.

---

## 설계

### 신규 trace 필드 (debug / explain 모드)

```typescript
// SearchResponseSchema/meta에 추가될 선택적 필드들
interface AuditExtension {
  // 결정론성 지문 — 동일 입력에서 결과 변동 감지
  determinism_fingerprint?: string
  // hash(decisionSnapshot + fusionConfigHash + rankingConfigHash + rerank contract)

  // EPIC-3: Planner 결정 trace
  planner_policy_trace?: PolicyDecisionRecord[]
  // explain=true 또는 HTTP_DEBUG_SECRET 있을 때만

  // EPIC-2: Constraint 분석 결과
  constraint_resolution_trace?: {
    atoms: ConstraintAtom[]
    relations: ConstraintRelation[]
    policy_outcomes: PolicyOutcome[]
  }

  // EPIC-4: Retrieval 융합 trace
  retrieval_fusion_trace?: RrfFusionTrace

  // EPIC-5: 랭킹 변화 trace
  ranking_delta_trace?: {
    preRerankTop5: string[]           // entityId 순서
    postRerankTop5: string[]
    safetyEnvelopeBlocks: number
    protectedCandidateEvictions?: number
    drift: ScoreDriftRecord
  }

  // EPIC-5: 재랭킹 결정 trace
  rerank_decision_trace?: {
    gateDecision: RerankGateDecision
    appliedModel?: string
    ltrFeatureDimension?: number
    scoreContract?: 'bounded_normalized_0_1'
    blockedReasonCounts?: Record<string, number>
  }

  // EPIC-6: Abstain 결정 trace
  abstain_policy_trace?: {
    evaluated: boolean
    decision: TypedAbstainDecision | false
    topKEntropy?: number
    constraintConflicts?: ConstraintRelation[]
    channelDegradation?: ChannelDegradationSummary
  }

  // EPIC-7: Agent fallback trace
  fallback_trace?: {
    fallbackApplied: 'layer2' | 'layer3' | 'layer4' | null
    reasoningFailure: boolean
    failedSynthesisAttempts: number
    fallbackSearchUsed: boolean
  }
}
```

### determinism_fingerprint 즉시 강화 가능

EPIC 2–7 완료를 기다리지 않고, 기존 util 입력 계약을 바로 강화할 수 있다:

```typescript
function buildDeterminismFingerprint(params: {
  decisionSnapshot: DecisionSnapshot
  fusionConfigHash: string
  rankingConfigHash: string
  rerankApplied: boolean
  rerankModelId?: string
}): string {
  return deterministicHash({
    plannerVersion: params.decisionSnapshot.planner_version,
    policyRuleVersion: params.decisionSnapshot.policy_rule_version,
    thresholdProfileId: params.decisionSnapshot.threshold_profile_id,
    responseContractVersion: params.decisionSnapshot.response_contract_version,
    modelVersions: params.decisionSnapshot.model_versions,
    indexVersions: params.decisionSnapshot.index_versions,
    featureFlags: params.decisionSnapshot.feature_flags,
    fusionConfigHash: params.fusionConfigHash,
    rankingConfigHash: params.rankingConfigHash,
    rerankApplied: params.rerankApplied,
    rerankModelId: params.rerankModelId ?? null,
  }).slice(0, 16)
}
```

즉 신규 필드를 더하는 것이 아니라, 이미 있는 util과 schema field를 **`decision_snapshot` 중심 계약으로 승격**해야 한다.
응답에 항상 포함 (`meta.determinism_fingerprint`). 동일 입력에서 fingerprint가 달라지면 config drift, index drift, 또는 비결정 로직이 있다는 신호.

### 기존 response hash / snapshot과의 관계

- `response_hash`는 **response payload determinism**을 보는 값으로 유지한다
- `determinism_fingerprint`는 **engine configuration / model / index snapshot / planner contract determinism**을 보는 값으로 유지/강화한다
- 두 값은 중복이 아니라 계층이 다르다
- `decision_snapshot`은 fingerprint 계산의 입력 source 중 하나로 취급해야 하며, 별도 버전 truth를 다시 만들면 안 된다

즉 권장 조합은:

- `decision_snapshot` = 버전/구성 truth
- `determinism_fingerprint` = 실행 contract 지문
- `response_hash` = 실제 응답 결과 지문

### EPIC-5 연동 계약

EPIC-5가 완료되면 audit trace는 raw heuristic ratio를 기록하지 않는다.
대신 다음을 기록한다:

- `ScoreDecomposition.heuristicScoreNormalized`
- `ScoreDecomposition.ltrScoreNormalized`
- `ScoreDecomposition.rerankDeltaNormalized`
- `ranking_delta_trace.preRerankTop5 / postRerankTop5`
- `rerank_decision_trace.scoreContract = 'bounded_normalized_0_1'`

즉 audit record도 EPIC-5와 같은 **bounded normalized score contract**를 따른다.

### 게이팅 정책

| 필드 | 포함 조건 |
|------|---------|
| `determinism_fingerprint` | 항상 (meta에 포함) |
| `planner_policy_trace` | `explain=true` 또는 debug 헤더 |
| `constraint_resolution_trace` | `explain=true` 또는 debug 헤더 |
| `retrieval_fusion_trace` | `explain=true` 또는 debug 헤더 |
| `ranking_delta_trace` | LTR 적용됐을 때 + `explain=true` |
| `rerank_decision_trace` | LTR 적용됐을 때 + `explain=true` |
| `abstain_policy_trace` | abstain 발생 시 항상 (typed reason 포함) |
| `fallback_trace` | agent 경로 + fallback 발생 시 항상 |

---

## 구현 계획

### Phase 1 (즉시 — EPIC 2–7 무관)
- 기존 `determinism_fingerprint` util 입력 계약을 `decision_snapshot` / `index_versions` / `response_contract_version` 중심으로 확장
- `ResponseBuilder` runtime path에서 `meta.determinism_fingerprint`를 항상 populate
- `abstain_reason` 타입을 `TypedAbstainDecision.reason` 4종으로 확장 (EPIC-6 선행 없이 partial 가능)
- 기존 `fallback_applied` boolean을 유지하면서 `fallback_trace`로 세분화
- `response_hash` / `decision_snapshot` / `authority_trace_ref`와 fingerprint 관계를 schema 설명에 명시

### Phase 2 (EPIC-3, 4 완료 후)
- `planner_policy_trace` 조립
- `retrieval_fusion_trace` 조립

### Phase 3 (EPIC-5 완료 후)
- `ranking_delta_trace`, `rerank_decision_trace` 조립
- `protectedCandidateEvictions`, `blockedReasonCounts`, `scoreContract` 추가

### Phase 4 (EPIC-2 완료 후)
- `constraint_resolution_trace` 조립

### Phase 5 (전체 완료 후)
- `AuditExtension` 전체 필드 통합 테스트
- 감사 재현 시나리오 E2E 테스트

---

## 완료 조건

- 임의 요청 1개에서 "엔진이 왜 이 결과를 냈는지" 응답 하나만으로 재현 가능
- `determinism_fingerprint`가 동일 입력에서 항상 같은 값 (LTR 모델 non-determinism 있으면 fingerprint 변동 → 감지)
- `response_hash`와 `determinism_fingerprint`의 역할이 중복되지 않고 문서/스키마에서 구분됨
- abstain 발생 시 `abstain_policy_trace.decision.reason`으로 4종 구별
- agent fallback 발생 시 `fallback_trace.reasoningFailure`로 "reasoning 실패 후 fallback"과 "정상 경로 fallback" 구별
- explain=true 모드에서 trace 전체 포함, production에서는 fingerprint + abstain_trace + fallback_trace만 포함
- EPIC-5 trace는 raw heuristic ratio가 아니라 normalized score/rank delta 기준으로만 기록

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/interface/http/schemas/search-response.schema.ts` | AuditExtension 필드 추가 |
| `src/application/search/search-usecase-post-route-phase.ts` | trace 조립 로직 |
| `src/domain/response/service/response-builder.ts` | AuditExtension projection / 게이팅 |
| `src/application/agent/agent-orchestrator.ts` | fallback_trace 생성 |
| `src/domain/shared/utils/determinism-fingerprint.ts` | 기존 fingerprint 빌더 입력 계약 확장 |
