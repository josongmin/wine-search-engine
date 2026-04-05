# Epic 9: LLM Retrieval Envelope

**Phase:** 3 (LLM Envelope & Set Retrieval)
**RFC:** RFC-017 §8.2 + RFC-008/014 확장
**의존성:** Epic 7 (retrieval mode), Epic 8 (entity surface)
**블록하는 Epic:** 11

---

## 목표

SearchResponseV1을 확장하여 LLM이 안전하게 사용할 수 있는 structured evidence packet 반환.
사람은 검색 결과를 보고 재시도 가능. LLM은 한번 retrieve한 결과를 사실처럼 쓴다.
따라서 ambiguity, confidence, evidence, constraint violation을 명시적으로 전달해야 한다.

## 이미 존재하는 것

SearchResponseV1은 이미 상당히 구조화되어 있다:

| 필드 | 상태 | LLM-safe 여부 |
|---|---|---|
| `engineDecision.decisionStatus` | ✅ resolved/ambiguous/failed | ✅ |
| `engineDecision.nextAction` | ✅ return_result/clarify/fail | ✅ |
| `engineDecision.decisionConfidence` | ✅ calibrated | ✅ |
| `engineDecision.failureReason` | ✅ RFC-016 enum codes | ✅ |
| `results[].evidenceItems` | ✅ type/source/contribution/strength | ⚠️ 구조적이나 human-readable |
| `results[].match` | ✅ MatchDetail | ⚠️ match_reasons 문자열 없음 |
| `results[].constraints` | ✅ ConstraintEvaluation | ⚠️ violated 목록 없음 |
| `clarification` | ✅ ClarificationPayload | ⚠️ wiring 불완전 |
| **`retrievalMode`** | ❌ | 없음 (Epic 7에서 추가) |
| **`resultType`** | ❌ | single_entity/set 구분 없음 |
| **`parsedConstraints`** | ❌ | 요청에서 파싱된 constraint 미노출 |
| **`match_reasons` (string[])** | ❌ | LLM-friendly 설명 없음 |
| **`violated_constraints` (string[])** | ❌ | 어떤 제약 불만족인지 미노출 |
| **`missingInformation`** | ❌ | 파싱 못한 정보 미노출 |

## 설계

### SearchResponseV1 확장 (기존 필드 유지 + 추가)

```typescript
interface SearchResponseV1 {
  // === 기존 (변경 없음) ===
  engineDecision: EngineDecision;
  results: ResultItem[];
  counterfactuals?: CounterfactualReject[];
  clarification?: ClarificationPayload | null;
  meta: ResponseMeta;

  // === 신규 (LLM envelope) ===
  retrievalMode: RetrievalMode;       // Epic 7에서 추가
  resultType: 'single_entity' | 'entity_set' | 'comparison' | 'no_match';
  parsedConstraints: {
    hard: Array<{ field: string; op: string; value: string }>;
    soft: Array<{ field: string; op: string; value: string }>;
    unparsed: string[];               // 파싱 못한 원문 조각
  };
}
```

### ResultItem 확장

```typescript
interface ResultItem {
  // === 기존 유지 ===
  entity: EntitySummary;
  relevanceScore: number;
  match: MatchDetail;
  constraints: ConstraintEvaluation;
  uncertainty: UncertaintyBlock;
  evidenceItems: EvidenceItem[];
  humanReadableEvidenceSummary?: string;

  // === 신규 ===
  matchReasons: string[];             // ["producer exact match", "vintage match", "style inferred from tasting notes"]
  violatedConstraints: string[];      // ["price exceeds budget", "region mismatch"]
}
```

### EngineDecision 확장

```typescript
interface EngineDecision {
  // === 기존 유지 ===
  decisionStatus: 'resolved' | 'ambiguous' | 'failed';
  nextAction: 'return_result' | 'clarify' | 'hybrid_search' | 'fail';
  // ...

  // === 신규 ===
  abstainReason?: string;             // LLM이 "왜 결과 없는지" 전달 가능
  // "multiple equally likely entities"
  // "no entity matches all constraints"
  // "query too vague for confident resolution"
}
```

### matchReasons 생성 로직

evidenceItems에서 자동 생성 (중복 아닌 파생):

```typescript
function buildMatchReasons(evidence: EvidenceItem[]): string[] {
  return evidence
    .filter(e => e.strength !== 'low' && parseFloat(e.contribution) > 0)
    .map(e => {
      if (e.type === 'lexical_match') return `${e.source} lexical match`;
      if (e.type === 'semantic_similarity') return 'semantic style alignment';
      if (e.type === 'constraint_pass') return `constraint satisfied: ${e.provenance}`;
      return e.provenance;
    });
}
```

## 작업 항목

- [ ] `SearchResponseV1`에 `retrievalMode`, `resultType`, `parsedConstraints` 추가
- [ ] `ResultItem`에 `matchReasons`, `violatedConstraints` 추가
- [ ] `EngineDecision`에 `abstainReason` 추가
- [ ] `response-builder.ts`에서 새 필드 조립 로직
- [ ] `matchReasons` 자동 생성 (evidenceItems 파생)
- [ ] `violatedConstraints` 생성 (ConstraintEvaluation에서 파생)
- [ ] `parsedConstraints` 생성 (QueryPlanV1.constraints에서 파생)
- [ ] HTTP schema 업데이트 (`search.schema.ts`)

## 완료 기준

- [ ] LLM에게 SearchResponseV1 전달 시 hallucination risk 감소
- [ ] ambiguous response에서 LLM이 arbitrary top-1 선택 대신 clarification 요청 가능
- [ ] "결과 없음" 시 abstainReason으로 이유 전달
- [ ] 기존 API backward compatible (새 필드는 optional로 시작)
