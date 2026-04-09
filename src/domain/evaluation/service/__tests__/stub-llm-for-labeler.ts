/**
 * Test-only stub ChatLlmPort for LLM relevance labeler tests.
 *
 * Returns predetermined LabelingResult JSON based on which candidate is
 * described in the user prompt. Never makes real API calls — safe to use
 * in unit/integration tests without network access.
 *
 * NOTE: This file lives under `__tests__/` and must NOT be imported by
 * production code. It exists solely to exercise labelRelevance end-to-end
 * without depending on Anthropic/OpenAI adapters.
 */

import type {
  ChatLlmPort,
  ChatCompletionRequest,
  ChatCompletionResult,
} from '../../../ai/port/chat-llm.port.js';
import type { LabelingResult } from '../llm-relevance-labeler.js';

/** Deterministic "neutral" fallback returned when no entity matches. */
const STUB_DEFAULT_RESPONSE: LabelingResult = {
  grade: 1,
  confidence: 0.5,
  rationale: 'stub default',
};

export class StubLabelerLlm implements ChatLlmPort {
  public calls = 0;

  constructor(
    private readonly responseByCanonicalLabel: ReadonlyMap<string, LabelingResult>,
  ) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls++;
    const userMessage =
      request.messages.find((m) => m.role === 'user')?.content ?? '';

    // buildUserPrompt emits lines like `  Name: Château Margaux 2015`. Matching
    // on the canonical label gives us a stable key per candidate.
    for (const [canonicalLabel, result] of this.responseByCanonicalLabel) {
      if (userMessage.includes(canonicalLabel)) {
        return {
          text: JSON.stringify(result),
          model: 'stub-labeler',
          finishReason: 'stop',
        };
      }
    }

    return {
      text: JSON.stringify(STUB_DEFAULT_RESPONSE),
      model: 'stub-labeler',
      finishReason: 'stop',
    };
  }
}

/**
 * ChatLlmPort that always returns malformed (non-JSON) text, exercising the
 * parse-fallback branch in parseLabelingResponse.
 */
export class MalformedResponseLlm implements ChatLlmPort {
  public calls = 0;

  async complete(_request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls++;
    return {
      text: 'this is not json at all — the model ignored instructions',
      model: 'stub-malformed',
      finishReason: 'stop',
    };
  }
}

/**
 * ChatLlmPort that throws on every call, exercising the retry + error
 * fallback branch in labelRelevance.
 */
export class ThrowingLlm implements ChatLlmPort {
  public calls = 0;

  constructor(private readonly errorMessage = 'simulated upstream failure') {}

  async complete(_request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls++;
    throw new Error(this.errorMessage);
  }
}
