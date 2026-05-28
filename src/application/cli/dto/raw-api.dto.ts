export interface RawApiHeaderInput {
  readonly name: string;
  readonly value: string;
}

export interface RawApiQueryParamInput {
  readonly name: string;
  readonly value: string;
}

export interface RawApiCallInput {
  readonly method: string;
  readonly path: string;
  readonly headers?: readonly RawApiHeaderInput[] | undefined;
  readonly query?: readonly RawApiQueryParamInput[] | undefined;
  readonly bodyText?: string | undefined;
  readonly contentType?: string | undefined;
}

export interface RawApiCallResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly rawText?: string | undefined;
}

export interface OpenApiDocumentResult {
  readonly path: '/openapi.json';
  readonly document: unknown;
}
