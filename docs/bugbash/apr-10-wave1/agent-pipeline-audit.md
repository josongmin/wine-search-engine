# 코드에이전트 파이프라인 버그배시 — 2026-04-10

10라운드 병렬 감사 결과. 에이전트 request → fetch → response 티키타카 전 구간 대상.
실제 코드에서 근거 확인 완료된 항목만 기재 (미확인 가설 제외).

---

## P0 — 즉시 수정 필요 (데이터 손상 / 사일런트 오동작)

### AG-01: `criticScore` NaN/Infinity → JSON silent null 변환

**문제**
`agent-tools.ts`에서 `criticScore`에 `Number.isFinite()` 가드 없이 직접 수치 연산:
```typescript
// line 977
parts.push(`critic: ${(r.entity.criticScore * 100).toFixed(0)}/100`);
// line 1064
critic_score_100: Math.round(r.entity.criticScore * 100)
```
`EntitySummary.criticScore`는 `number | undefined`로 타입되어 있고 Vespa 문서가 `NaN`을 반환할 수 있음.
`Math.round(NaN) = NaN`, `JSON.stringify({critic_score_100: NaN})` → `{critic_score_100: null}` — **값이 소리없이 null로 교체**.
GROUNDING_JSON이 오염되어 Claude가 사실 검증에 틀린 점수를 사용.

**근거**
- `src/application/agent/agent-tools.ts:977, 1010, 1064, 1093`
- `src/domain/response/model/result-item.ts:50` — `readonly criticScore?: number | undefined`
- `JSON.stringify({x: NaN})` → `'{"x":null}'` (ECMAScript 스펙)

**긴급도: P0** — grounding 검증 파이프라인 오염. 모든 검색 결과에 영향.

**수정**
```typescript
// 1064 라인 예시
...(Number.isFinite(r.entity.criticScore)
  ? { critic_score_100: Math.round(r.entity.criticScore * 100) }
  : {}),
```
`977`, `1010`, `1093`도 동일 패턴 적용.

---

### AG-02: 합성(synthesis) 레이어 — 검증은 trimmed, 반환은 untrimmed

**문제**
```typescript
// agent-orchestrator.ts:1020-1023
const candidate = parsedSynth.answer?.trim() ?? '';
const isShell = /^[{[\s]*[}\]]*$/.test(candidate);
return candidate.length > 10 && !isShell
  ? parsedSynth.answer   // ← untrimmed 반환 (candidate가 아님)
  : undefined;
```
`parsedSynth.answer`가 앞뒤에 `\n\n\t`가 붙은 LLM 출력이어도 검증은 `candidate` (trimmed)로 통과한 뒤 원본 untrimmed를 반환.
최종 HTTP 응답 `data.answer`에 whitespace prefix/suffix가 포함되어 나감.

**근거**
- `src/application/agent/agent-orchestrator.ts:1020-1023` — 직접 확인

**긴급도: P0** — 사용자에게 노출되는 최종 답변 오염. 경고: 이미 trim된 응답을 처리하는 클라이언트는 괜찮지만 diff 테스트, 스냅샷 테스트가 깨짐.

**수정**
```typescript
return candidate.length > 10 && !isShell ? candidate : undefined;
//                                          ^^^^^^^^^ parsedSynth.answer 대신
```

---

## P1 — 높은 심각도 (버그지만 방어 레이어 존재)

### AG-03: 병렬 배치 `actions` vs `observations` 배열 길이 불일치

**문제**
```typescript
// agent-orchestrator.ts:766-791
for (let bi = 0; bi < batchResults.length; bi++) {
  const result = batchResults[bi];
  if (result === undefined) continue;  // ← skip
  observations.push(obs);              // observations에 미추가
  // ...
}
steps.push({
  actions: batchCalls,   // ← 전체 N개
  observations,          // ← undefined 결과 제외된 M개 (M < N 가능)
});
```
`agent-prompt.ts:138-141`에서:
```typescript
for (let i = 0; i < step.actions.length; i++) {
  const obs = observations[i] ?? '(no result)'; // ← 인덱스 오정렬시 잘못된 placeholder
```
`actions[k]`가 실제로 수행된 툴 결과인데 `observations[k]`가 다른 툴의 결과나 `'(no result)'`를 가리킬 수 있음.

**현실적 발생 여부**: `Promise.all`은 런타임에 실제로 undefined를 반환하지 않으므로 현재 코드에서 발생 가능성 낮음. 그러나 코드 구조 자체가 취약 — `batchResults[bi]`는 `noUncheckedIndexedAccess`로 `AgentToolResult | undefined` 타입이라 `if (undefined) continue`가 컴파일 통과.

**근거**
- `src/application/agent/agent-orchestrator.ts:766-791`
- `src/application/agent/agent-prompt.ts:138-141`

**긴급도: P1** — 현재 런타임 발생 가능성 낮지만 LLM 컨텍스트 오염 경로 존재. `actionPairs`가 이미 1:1 정렬을 유지하므로 `actions`/`observations` 필드를 deprecated 처리해야 함.

**수정**
```typescript
// result가 undefined인 경우를 절대 skip하지 않거나,
// 아예 actions/observations 필드 제거하고 actionPairs만 사용
for (let bi = 0; bi < batchResults.length; bi++) {
  const result = batchResults[bi]!; // Promise.all 보장
  const call = batchCalls[bi]!;
  const obs = truncateObservation(result.observation, this.config.maxContextChars);
  observations.push(obs);
  batchPairs.push({ action: call, observation: obs });
}
```

---

### AG-04: `isChatCompletionsResponse` — 빈 `choices` 배열 미검사

**문제**
```typescript
// openai-chat-llm.ts:84-89
function isChatCompletionsResponse(v: unknown): v is ChatCompletionsResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['model'] === 'string' && Array.isArray(o['choices']);
  //                                                     ↑ 길이 0 허용
}
// line 194
const choice = data.choices[0]; // choices=[] → choice = undefined
const content = choice?.message?.content; // undefined?.message = undefined
const text = ... content == null ? '' : ...; // → '' 빈 문자열 반환
```
`choices: []`인 응답을 OpenAI가 반환할 경우 (API 장애, empty completion) 오케스트레이터가 빈 텍스트를 유효한 응답으로 처리. `parseLlmOutput('')`은 `{ thought: '', answer: '' }`를 반환하고 합성 로직이 "answer 없음"으로 처리함. 사일런트 실패.

**근거**
- `src/infrastructure/ai/openai-chat-llm.ts:84-89, 194-202`

**긴급도: P1** — API 이상 상황에서 에러를 삼키고 빈 답변을 생성. 모니터링에서 장애가 안 잡힘.

**수정**
```typescript
return (
  typeof o['model'] === 'string' &&
  Array.isArray(o['choices']) &&
  (o['choices'] as unknown[]).length > 0  // 추가
);
```

---

### AG-05: 병렬 배치 catch — `AbortError` 미처리 → 에러 분류 오염

**문제**
```typescript
// agent-orchestrator.ts:733-757
} catch (batchErr) {
  if ((batchErr as TimeoutErrorLike).code === 'TIMEOUT') { ... terminationReason = 'timeout'; }
  if (batchErr instanceof DomainError && batchErr.code === POLICY_BLOCKED_CODE) { ... }
  else {
    if (terminationReason !== 'timeout') {
      terminationReason = 'error';  // ← AbortError도 여기 들어옴
    }
  }
  break;
}
```
`isAbortError`가 임포트되어 있지 않음. HTTP 클라이언트가 연결을 끊어 `AbortError`가 발생하면 `terminationReason = 'error'`로 잘못 분류됨. 에러 메트릭과 알람이 오염.

**근거**
- `src/application/agent/agent-orchestrator.ts:14-41` — `import` 목록에 `isAbortError` 없음
- `src/application/agent/agent-orchestrator.ts:733-757` — catch 블록

**긴급도: P1** — 정상적인 클라이언트 연결 해제가 에러로 카운트됨. SLO 거짓 경보 유발.

**수정**
```typescript
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
// ...
} catch (batchErr) {
  if (isAbortError(batchErr)) {
    terminationReason = 'aborted';
    break;
  }
  if ((batchErr as TimeoutErrorLike).code === 'TIMEOUT') { ... }
  // 나머지 동일
```

---

## P2 — 중간 심각도 (방어 레이어 있으나 구조적 취약)

### AG-06: `tool_result: z.unknown()` — 응답 스키마에 검증 없음

**문제**
```typescript
// route-contracts.ts:149
tool_result: z.unknown(),
```
툴이 반환하는 raw 결과에 대해 타입, 크기, 유한성 검증 없음. Vespa가 10만 개 결과를 반환하거나 `Infinity`가 포함된 객체를 반환해도 HTTP 응답으로 직렬화됨.
현재 툴들이 내부적으로 결과를 제한하고 있어 실질적 발생 가능성 낮음.

**근거**
- `src/interface/http/routes/route-contracts.ts:149`

**긴급도: P2** — 방어 심층화 부족. 새 툴 추가 시 버그 경로 열림.

---

### AG-07: 병렬 배치 총 observation 예산 미설정

**문제**
```typescript
// agent-orchestrator.ts:769
const obs = truncateObservation(result.observation, this.config.maxContextChars);
// maxContextChars = 8000 (기본값)
// MAX_TOOLS_PER_BATCH = 4
// 최대 4 × 8000 = 32,000 chars = ~8,000 tokens per step (observation만)
```
단일 툴 결과는 `maxContextChars`(8000)로 캡핑되지만 배치 내 전체 합산 예산이 없음.
4개 툴 병렬 실행 시 step당 최대 32,000자의 관찰이 LLM 컨텍스트에 삽입됨.
`maxTotalTokens`가 20K인 경우 단일 step이 예산 대부분 소비 가능.

**근거**
- `src/application/agent/agent-tools.ts:41` — `MAX_OBSERVATION_CHARS = 2_000` (개별 캡)
- `src/application/agent/agent-prompt.ts:179` — `truncateObservation(text, maxChars)` (파라미터로 8000 받음)
- `src/domain/agent/model/agent-config.ts:42` — `maxContextChars: 8_000`
- `MAX_TOOLS_PER_BATCH = 4` (line 408)

**긴급도: P2** — 현재 기본 설정에선 4×8000=32K char가 컨텍스트에 들어갈 수 있음. `maxTotalTokens`가 이를 간접 제한하지만 명시적 per-step budget 없음.

---

### AG-08: fallback 검색 실패 — 상태 변경 없이 다음 레이어로 진행

**문제**
```typescript
// agent-orchestrator.ts:1148-1152 (추정 위치, synthesis fallback 구간)
} catch (err) {
  log.error({ err, requestId }, 'agent fallback search failed');
  // re-throw 없음, fallbackApplied 플래그 미변경
}
```
fallback 경로(Layer 2)에서 검색 실패 시 에러를 로깅만 하고 Layer 3 (synthesis)로 진행. `fallbackApplied`가 여전히 `false`이므로 응답에 "fallback 적용됨" 표시가 안 나감.

**근거**
- `src/application/agent/agent-orchestrator.ts` fallback 구간 (exact line은 파일 크기로 정확히 지목 어려움 — 검색어: `'agent fallback search failed'`)

**긴급도: P2** — 인프라 장애 중 fallback 실패가 관측 불가. `fallback_applied` 메타데이터가 오염됨.

---

## P3 — 낮은 심각도 (코드 품질, 미래 버그 씨앗)

### AG-09: `parseLlmOutput` JSON 파싱 실패 → "thought-only" 응답으로 오분류

**문제**
```typescript
// agent-orchestrator.ts catch 블록
return { thought: '[unparseable LLM output]', answer: text.trim() };
```
LLM이 파싱 불가능한 JSON을 반환할 때 `answer`를 함께 반환 (파싱 실패임에도). 오케스트레이터는 이것을 "LLM이 `thought`만 내고 기다림"으로 해석하여 다음 스텝으로 진행. 실제로는 "파싱 에러"이므로 별도 `terminationReason = 'parse_error'`로 처리해야 함.

**근거**
- `src/application/agent/agent-orchestrator.ts:283-288`

**긴급도: P3** — 현재 루프 제한이 있어 무한 루프 없음. 하지만 에러 분류가 불투명.

---

### AG-10: `tool_input` 값에 `z.unknown()` — 중첩 객체 DoS 경로

**문제**
```typescript
// route-contracts.ts:139-142
tool_input: z.record(z.unknown()).refine(
  (rec) => Object.keys(rec).length <= MAX_TOOL_INPUT_RECORD_KEYS,
```
키 개수는 제한(50개)되었지만 값이 `z.unknown()` — `{query: {nested: {deeply: {...100KB...}}}}` 형태로 서버에 전달 가능. 개별 툴 핸들러의 스키마 파싱 전에 깊은 중첩 객체가 메모리에 로드됨.

**근거**
- `src/interface/http/routes/route-contracts.ts:139-142`

**긴급도: P3** — 개별 툴 핸들러에서 재검증하므로 직접적 피해는 제한적. 입력 크기 제한 미들웨어(`bodyLimit`)가 1차 방어.

---

## 요약 테이블

| ID | 파일:라인 | 문제 | 긴급도 |
|----|-----------|------|--------|
| AG-01 | agent-tools.ts:977,1010,1064,1093 | criticScore NaN→null JSON 오염 | **P0** |
| AG-02 | agent-orchestrator.ts:1020-1023 | 합성 답변 untrimmed 반환 | **P0** |
| AG-03 | agent-orchestrator.ts:766-791 | actions/observations 배열 불일치 | P1 |
| AG-04 | openai-chat-llm.ts:84-89 | choices=[] 무검증 → 빈 답변 사일런트 | P1 |
| AG-05 | agent-orchestrator.ts:733-757 | AbortError → error 오분류 | P1 |
| AG-06 | route-contracts.ts:149 | tool_result z.unknown() 무검증 | P2 |
| AG-07 | agent-orchestrator.ts:769 | 배치 총 observation 예산 없음 | P2 |
| AG-08 | agent-orchestrator.ts fallback | fallback 실패 상태 미전파 | P2 |
| AG-09 | agent-orchestrator.ts:283-288 | JSON 파싱 실패 오분류 | P3 |
| AG-10 | route-contracts.ts:139-142 | tool_input 값 중첩 무제한 | P3 |

---

## 즉시 수정 대상 (P0)

**AG-01** (criticScore NaN guard) + **AG-02** (synthesis untrimmed) — 두 개 모두 단순 1~2줄 수정.
나머지 P1은 에러 분류/관측 품질 이슈로 다음 스프린트 처리 가능.
