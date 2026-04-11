# EPIC-2: Constraint Semantics Engine 재정의

> 상태: 계획  
> 의존: 없음 (기반 EPIC)  
> 후속: EPIC-3, EPIC-4, EPIC-5, EPIC-6 모두 여기서 나온 IR을 소비

---

## 현재 문제

- `ConstraintAtom`이 없음 — `NormalizedConstraint`는 `attribute/operator/value/confidence`까지만 있고 `authority_level`, `conflict_policy`, `semantic_scope`가 없음
- tier 간 precedence가 코드 흐름에 암묵적으로 박혀 있음 (Tier 2 entity resolver가 Tier 1을 덮어쓰는 경우 trace 없음)
- soft constraint 간 충돌("달달한 드라이")이 SAT를 통과해 Ranker까지 올라감. Ranker에 충돌 해석 규칙 없음
- `inferred / implied / observed / authoritative` 구분이 `source_phrase` 문자열 수준에 머무름
- SAT는 hard contradiction만 잡음 — semantic inconsistency는 탐지 불가

---

## 현재 코드 상태 (직접 확인)

| 항목 | 파일 | 현재 상태 |
|------|------|---------|
| `NormalizedConstraint` 타입 | `src/domain/shared/types/constraint-bundle.ts` | `attribute/operator/value/confidence/source_phrase/mapping_version` 6개 필드. **`authority_level`, `conflict_policy`, `semantic_scope` 없음** |
| `ConstraintAtom` 타입 | — | **없음** |
| `ConstraintReasoner` | — | **없음** |
| `ConstraintCompilerResult` | `constraint-compiler.ts` | `bundle`, `constraintExtraction`, `retrievalPlan`, `resolvedEntities`까지 이미 산출 |
| hard/soft 분류 | `constraint-compiler.ts:73–85` | `SOFT_CONSTRAINT_ATTRIBUTES.has()` 기반 분류. 존재하지만 `semantic_scope` 필드가 아닌 코드 흐름으로 구현 |
| tier 간 precedence | `constraint-compiler.ts` | 코드 흐름에 암묵적 — trace 없음 |
| soft-tension 감지 | — | **없음** — "달달한 드라이"는 SAT 통과 후 Ranker 패널티 경로로만 처리됨 |

**핵심 갭:** `NormalizedConstraint`는 있지만 `ConstraintAtom` IR, `source_kind`, `authority_level`, `conflict_policy`가 없음.  
Reasoner 자체는 전무. soft-tension/contradiction 판정이 없으므로 EPIC-6 TypedAbstain의 `semantic_conflict`도 현재 불가능.
다만 extraction/compiler substrate는 이미 있으므로, EPIC-2는 extraction 전면 재작성보다 **기존 ConstraintCompiler 뒤에 typed reasoner를 삽입하는 작업**으로 좁혀야 한다.

---

## 목표

`NormalizedConstraint`를 `ConstraintAtom` IR로 승격하고,  
Tier 6 직후 `ConstraintReasoner`를 삽입하여 Planner에 올라가기 전에 정제된 번들을 생성한다.

단, 기존 `ConstraintCompiler`가 이미 `constraintExtraction`과 `retrievalPlan`을 생성하고 있으므로,
EPIC-2는 이를 폐기하지 않고 **IR 승격 + reasoning layer 추가** 방식으로 간다.

---

## 설계

### ConstraintAtom

```typescript
interface ConstraintAtom {
  // 기존 NormalizedConstraint 필드
  attribute: string
  operator: '=' | '>=' | '<=' | 'range' | 'in'
  value: string | number | [number, number] | string[]
  confidence: number
  source_phrase: string
  mapping_version: string

  // 신규 필드
  source_tier: 'tier1_nl' | 'tier2_entity' | 'tier6_regex' | 'ontology' | 'compositional' | 'llm'
  source_kind:
    | 'explicit_user'
    | 'curated_mapping'
    | 'entity_resolution'
    | 'regex_extracted'
    | 'ontology_implied'
    | 'compositional_inferred'
    | 'llm_suggested'
  authority_level: 'authoritative' | 'inferred' | 'suggested'
  semantic_scope: 'hard' | 'soft'   // 기존 hard/soft 분류를 여기로
  conflict_policy: 'fail' | 'relax' | 'split' | 'clarify' | 'rank_penalty'
}
```

### ConstraintRelation (Reasoner 출력)

```typescript
type ConstraintRelationKind =
  | 'contradiction'    // 논리적으로 동시 충족 불가 — "레드 AND 화이트"
  | 'redundancy'       // 동일 조건 중복 — "body>=0.7 AND body>=0.8"
  | 'overshadow'       // 높은 authority가 낮은 authority를 무효화
  | 'subsumption'      // A가 B를 포함 — "보르도" ⊃ "메독"
  | 'implication'      // A가 있으면 B도 성립 — "Pinot Noir" → country candidate 확장
  | 'soft_tension'     // 소프트 충돌 — "달달한 드라이", "가벼운 풀바디"

interface ConstraintRelation {
  kind: ConstraintRelationKind
  atoms: [ConstraintAtom, ConstraintAtom]
  resolved_policy: ConstraintAtom['conflict_policy']
  resolution_note: string
}
```

### ConstraintReasoner 삽입 위치

```
Constraint Compiler 내부

  Tier 1 → Tier 2 → Tier 6 (기존)
  ↓
  [신규] ConstraintReasoner.analyze(atoms[])
    → relations: ConstraintRelation[]
    → resolved: ConstraintAtom[]    // 충돌 처리 후 남은 것
    → policy_outcomes: PolicyOutcome[]  // fail / relax / split / clarify / rank_penalty
  ↓
  온톨로지 확장 & 합성 추론 (기존, resolved 기반으로 실행)
  ↓
  Planner에 ConstraintBundle 전달 (기존)
```

SAT 검사(`constraintSAT`)는 이후에도 남지만, **hard contradiction만 재확인**하는 역할로 좁혀짐.

### 재활용 원칙

- 기존 `ConstraintCompilerResult.bundle`는 유지한다
- `constraintExtraction` trace는 reasoner 전/후를 모두 설명하는 상위 trace로 확장한다
- `retrievalPlan`은 reasoner 결과를 입력으로 다시 계산하되, 별도 retrieval planning truth를 만들지 않는다
- `resolvedEntities`는 Tier 2 evidence로 재활용한다

---

## 완료 조건

| 케이스 | 기대 policy |
|--------|------------|
| "달달한 드라이" | `soft_tension` → `rank_penalty` (둘 다 살리되 교집합 후보 패널티 감소) |
| "가벼운 풀바디" | `soft_tension` → `rank_penalty` |
| "보르도인데 나파 느낌" | `soft_tension` → `relax` (region hard 제약 유지, 스타일은 rank_penalty) |
| "레드/화이트 동시 요청" | `contradiction` → `split` (sub-query로 분기) 또는 `clarify` |
| "wine_type='red' AND wine_type='white'" | `contradiction` → `fail` (SAT도 동일하게 잡음) |

- SAT를 넘어 semantic consistency까지 검사
- `parsed_constraints` response 필드가 `ConstraintAtom[]` 형태로 설명 가능한 논리 구조가 됨
- `ConstraintRelation[]`이 `QueryPlanV2.constraintExtraction` 또는 신규 `constraintReasoningTrace` 필드에 포함됨

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/domain/query/service/constraint-compiler.ts` | Reasoner 삽입, IR 타입 교체 |
| `src/domain/shared/types/constraint-bundle.ts` 또는 신규 model | `ConstraintAtom` 타입 정의 |
| `src/domain/query/service/constraint-reasoner.ts` | **신규** |
| `src/domain/query/service/constraint-sat.ts` | hard contradiction만 남기도록 범위 축소 |
| `src/interface/http/schemas/search-response.schema.ts` | `parsed_constraints` 타입 확장 |
