# EPIC-6: Abstain / Clarify / Fail 정책 재설계

> 상태: 계획  
> 의존: EPIC-2 (soft_tension → budget_gap 분류), EPIC-5 (normalized ScoreDecomposition + rerank invariants → abstain 판단 개선)  
> 후속: EPIC-8 (abstain_policy_trace)

---

## 현재 문제

- `abstain`이 단일 상태 — entropy 기반 score 분포 균일 → abstain. 왜 abstain했는지 구별 불가
- `no_match`와 `low_confidence`가 혼재 — "검색은 됐지만 constraint 충족 결과 없음"과 "retrieval 자체 실패"가 같은 경로
- `clarify`가 generic question — "어떤 와인을 찾으시나요?" 수준, 구조화된 질문 아님
- soft-tension ("달달한 드라이")이 abstain으로 가지 않고 Ranker까지 올라가 패널티만 줌

---

## 현재 코드 상태 (직접 확인)

| 항목 | 파일 | 현재 상태 |
|------|------|---------|
| `AbstainPolicy` | `src/domain/query/service/abstain-policy.ts` | `shouldAbstain(scores[], context?)` → `AbstainDecision { abstain: boolean, entropy, reason }` 구현됨 |
| `AbstainDecision.reason` | `abstain-policy.ts` | 단일 reason 문자열 — typed 4종 아님 |
| `TypedAbstainDecision` | — | **없음** |
| `AbstractReason` 4종 | — | **없음** |
| `ClarificationPayload` | `src/domain/response/model/clarification.ts` | `reason`, `candidates`, `suggestionType`까지 존재. 다만 `kind`, conflicting atoms, budget gap detail이 없음 |
| `StructuredClarifyPayload` | — | **별도 structured 타입 없음** — clarification이 generic |
| soft-tension → semantic_conflict | — | **없음** — EPIC-2 Reasoner 없으므로 전제 조건 미충족 |
| `budget_gap` 감지 | — | **없음** — price + quality constraint 충돌 감지 안 됨 |

**핵심 갭:** `AbstractReason` 4종 분류 자체가 없음. `no_match` / `low_confidence` / `semantic_conflict` / `insufficient_evidence`가 현재 단일 `reason` 문자열로만 처리됨.  
EPIC-2(`ConstraintReasoner`) 없이는 `semantic_conflict`와 `budget_gap`이 불가능 — EPIC-2 의존.

---

## 목표

`abstain`을 4가지 typed abstain으로 분해하고,  
`clarify`를 4가지 structured question으로 분해한다.  
"모른다"를 잘 말하는 능력을 구조적으로 확보.

이 EPIC은 현재 코드에 이미 있는 강한 substrate 위 확장이 아니라, 실제로 대부분이 비어 있는 영역이다.
즉 중복구현 위험보다 **실구현 누락**이 핵심이다.

단, clarification surface 자체는 이미 있으므로 기존 `ClarificationPayload`를 폐기하지 않고
structured field를 증설하는 방식으로 가야 한다.

---

## 설계

### Typed Abstain

```typescript
type AbstractReason =
  | 'no_match'               // retrieval 결과 없음 또는 hard filter 후 0건
  | 'low_confidence'         // 결과 있지만 entropy 균일 — 확신 없음
  | 'semantic_conflict'      // EPIC-2에서 soft_tension/contradiction 감지 → 결과 신뢰 불가
  | 'insufficient_evidence'  // dense/anchor 채널 degraded 상태에서 sparse만으로 판단 불충분

interface TypedAbstainDecision {
  shouldAbstain: true
  reason: AbstractReason
  detail: string             // 설명 가능한 이유 문자열
  recoverableBy?: 'relax_constraints' | 'clarify' | 'retry_with_dense' | 'split_query'
}
```

**판단 규칙:**

| 조건 | reason |
|------|--------|
| `candidateCount=0` (hard filter 후) | `no_match` |
| `candidateCount>0` + `topKEntropy >= ABSTAIN_THRESHOLD` + 채널 정상 | `low_confidence` |
| `ConstraintRelation.kind === 'soft_tension' || 'contradiction'` 있음 | `semantic_conflict` |
| `denseResult.degraded && anchorResult.degraded` — sparse만 | `insufficient_evidence` |

### Structured Clarify

```typescript
type ClarifyKind =
  | 'anchor_disambiguation'    // 앵커가 여러 엔티티 후보 → "마르고 말씀하신 게 Château Margaux인가요?"
  | 'constraint_conflict'      // soft_tension 감지 → "드라이하면서 달달한 와인을 원하시나요?"
  | 'preference_gap'           // constraint는 있는데 결과 품질 낮음 → 우선순위 질문
  | 'budget_gap'               // price constraint + quality constraint 현실 충족 불가 → 범위 조정 제안

interface StructuredClarifyPayload {
  kind: ClarifyKind
  question: string             // 자연어 질문
  options?: string[]           // 선택지 (anchor_disambiguation, budget_gap)
  conflictingAtoms?: [string, string]  // constraint_conflict — 어떤 제약이 충돌하는지
  gapDescription?: string      // budget_gap — 왜 충족 불가인지
}
```

이 payload는 기존 `ClarificationPayload`의 상위 호환 확장으로 다룬다:

- `reason`은 유지
- `candidates`는 anchor disambiguation에서 그대로 재사용
- `suggestionType`은 migration 기간 동안 유지
- 신규 `kind`, `conflictingAtoms`, `gapDescription`을 추가

**`budget_gap` 예시:**
- 입력: "5만원 이하 그랑크뤼 보르도"
- EPIC-2 reasoner가 price constraint(≤50,000원)와 quality constraint(Grand Cru class)를 `soft_tension`으로 분류
- clarify: "그랑크뤼 보르도는 일반적으로 20만원 이상입니다. 예산을 늘리시겠어요, 아니면 준그랑크뤼를 보여드릴까요?"

### AbstractPolicy 수정

```typescript
// 기존: AbstainPolicy.shouldAbstain(topKScores) → boolean
// 변경: shouldAbstain(topKScores, constraintRelations, retrievalDegradation) → TypedAbstainDecision | false

class AbstainPolicy {
  evaluate(
    topKScores: number[],
    constraintRelations: ConstraintRelation[],   // EPIC-2
    channelDegradation: ChannelDegradationSummary,  // EPIC-4
  ): TypedAbstainDecision | false
}
```

### 응답 변화

**기존 abstain response:**
```json
{ "abstain_reason": "low_confidence" }
```

**신규:**
```json
{
  "abstain_reason": "semantic_conflict",
  "abstain_detail": "입력 제약 '달달한'과 '드라이'가 semantic conflict로 감지되었습니다.",
  "recoverable_by": "clarify",
  "clarification": {
    "kind": "constraint_conflict",
    "question": "드라이한 와인과 달달한 와인 중 어떤 것을 원하시나요?",
    "conflicting_atoms": ["sweetness<=0.2(드라이)", "sweetness>=0.5(달달한)"]
  }
}
```

---

## 완료 조건

- "왜 abstain했는지"가 `TypedAbstainDecision.reason`으로 구별 가능
- `no_result` / `no_confidence` / `no_evidence`가 다른 경로로 처리됨
- `clarify`가 generic question이 아닌 `kind`별 structured question
- "달달한 드라이" → `semantic_conflict` abstain + `constraint_conflict` clarify
- "5만원 이하 그랑크뤼" → `budget_gap` clarify
- "마르고" (앵커 다수 후보) → `anchor_disambiguation` clarify
- `AbstractReason` 4가지 모두 회귀 테스트 보유

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/domain/query/service/abstain-policy.ts` | `evaluate()` 시그니처 확장, TypedAbstainDecision 반환 |
| `src/domain/query/model/abstain-decision.ts` | **신규** TypedAbstainDecision 타입 |
| `src/application/search/search-usecase-post-route-phase.ts` | TypedAbstainDecision 기반 분기 |
| `src/domain/query/service/clarification-builder.ts` | **신규** StructuredClarifyPayload 생성 |
| `src/domain/response/model/clarification.ts` | 기존 ClarificationPayload 확장 |
| `src/interface/http/schemas/search-response.schema.ts` | `abstain_reason` 타입 확장, `abstain_detail`, `clarification.kind` 추가 |
