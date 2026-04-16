import { DomainError } from './domain-error.js';

export const POLICY_BLOCKED_CODE = 'POLICY_BLOCKED';
export const POLICY_BLOCKED_MESSAGE = 'Query blocked by security policy.';

interface PolicyBlockedRejectionMeta {
  readonly layer?: string | undefined;
  readonly reason?: string | undefined;
}

export class PolicyBlockedError extends DomainError {
  readonly rejection?: PolicyBlockedRejectionMeta | undefined;

  constructor(
    message: string = POLICY_BLOCKED_MESSAGE,
    rejection?: PolicyBlockedRejectionMeta,
  ) {
    super(POLICY_BLOCKED_CODE, message);
    this.name = 'PolicyBlockedError';
    Object.defineProperty(this, 'rejection', {
      value: rejection,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  toJSON(): {
    readonly code: typeof POLICY_BLOCKED_CODE;
    readonly name: 'PolicyBlockedError';
    readonly message: typeof POLICY_BLOCKED_MESSAGE;
  } {
    return {
      code: POLICY_BLOCKED_CODE,
      name: 'PolicyBlockedError',
      message: POLICY_BLOCKED_MESSAGE,
    };
  }
}
