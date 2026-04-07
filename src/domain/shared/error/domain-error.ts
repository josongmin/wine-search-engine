/**
 * Base error class for all domain-level errors in the Wine Intelligence Engine.
 * Every domain error carries a machine-readable `code` for programmatic handling.
 */
export class DomainError extends Error {
  /** Machine-readable error code (e.g. "WRONG_RESOLVE", "EVIDENCE_OBLIGATION"). */
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    // Restore prototype chain broken by extending built-in Error
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an attempt is made to return a resolved result without
 * the required evidence trail. Every resolution must be explainable.
 */
export class EvidenceObligationError extends DomainError {
  constructor(message: string) {
    super('EVIDENCE_OBLIGATION', message);
    this.name = 'EvidenceObligationError';
  }
}

/**
 * Thrown when a correct entity was identified but dropped during the
 * blocking/candidate-generation stage. Indicates a recall failure
 * in the retrieval layer.
 */
export class BlockingMissError extends DomainError {
  constructor(message: string) {
    super('BLOCKING_MISS', message);
    this.name = 'BlockingMissError';
  }
}
