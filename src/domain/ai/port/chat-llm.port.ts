/**
 * Hexagonal port for chat-style LLM completions (provider-agnostic).
 * Implementations may target OpenAI, Azure OpenAI, LiteLLM, etc.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly messages: readonly ChatMessage[];
  /** Overrides the adapter default when set. */
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Optional abort signal for cooperative cancellation. */
  readonly abortSignal?: AbortSignal | undefined;
}

export interface ChatCompletionResult {
  readonly text: string;
  readonly model: string;
  readonly finishReason: string | null;
}

/**
 * Text chat completion (non-streaming).
 */
export interface ChatLlmPort {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
