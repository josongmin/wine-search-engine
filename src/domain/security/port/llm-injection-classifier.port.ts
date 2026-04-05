export interface LLMInjectionClassifierPort {
  classify(query: string): Promise<boolean>;
}
