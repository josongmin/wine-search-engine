/**
 * Non-domain failure from Anthropic HTTP transport (DNS, TLS, proxy, etc.).
 * Callers map this to degradation without leaking SDK-specific shapes upstream.
 */
export class AnthropicTransportError extends Error {
  override readonly cause?: Error;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AnthropicTransportError';
    if (options?.cause !== undefined && options.cause instanceof Error) {
      this.cause = options.cause;
    }
  }
}
