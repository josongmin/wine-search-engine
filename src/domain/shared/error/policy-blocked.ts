import { DomainError } from './domain-error.js';

export const POLICY_BLOCKED_CODE = 'POLICY_BLOCKED';
export const POLICY_BLOCKED_MESSAGE = 'Query blocked by security policy.';

export class PolicyBlockedError extends DomainError {
  constructor(message: string = POLICY_BLOCKED_MESSAGE) {
    super(POLICY_BLOCKED_CODE, message);
    this.name = 'PolicyBlockedError';
  }
}
