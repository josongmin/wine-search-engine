/**
 * Result of injection detection analysis.
 * Discriminates between safe and unsafe queries with contextual information.
 */
export type InjectionResult =
  | { readonly safe: true; readonly sanitizedQuery: string }
  | { readonly safe: false; readonly reason: InjectionReason; readonly borderline?: boolean };

/**
 * Specific reasons for injection rejection.
 * Machine-readable codes for logging and analytics.
 */
export type InjectionReason =
  | 'EMPTY_QUERY'
  | 'COMMAND_INJECTION'
  | 'SYSTEM_PROMPT_INJECTION'
  | 'JAILBREAK_ATTEMPT'
  | 'SQL_INJECTION'
  | 'SCRIPT_INJECTION'
  | 'PII_EXTRACTION'
  | 'UNICODE_ATTACK'
  | 'LENGTH_EXCEEDED'
  | 'LLM_JUDGE_REJECTION';
