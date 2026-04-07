export interface LLMInjectionClassifierOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

export interface LLMInjectionClassifierPort {
  classify(query: string, options?: LLMInjectionClassifierOptions): Promise<boolean>;
}
