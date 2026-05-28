export interface CliFacadeRequestOptions {
  readonly requestId: string;
  readonly abortSignal?: AbortSignal | undefined;
}
