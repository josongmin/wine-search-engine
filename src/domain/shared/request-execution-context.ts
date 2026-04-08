/**
 * Request-scoped execution knobs forwarded from HTTP (or batch parent) into
 * application use cases. Extend deliberately — avoid diverging inline option bags.
 */
export interface RequestExecutionContext {
  readonly abortSignal?: AbortSignal | undefined;
}
