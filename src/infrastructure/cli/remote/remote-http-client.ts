import { CliError } from '../../../application/cli/command/cli-error.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const HTTP_STATUS_OK_MIN = 200;
const HTTP_STATUS_REDIRECT_MIN = 300;
const ERROR_BODY_PREVIEW_MAX_CHARS = 300;

export interface RemoteHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly rawBody?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface RemoteHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly rawText: string;
}

function toHeaderRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(headers.entries());
}

export class RemoteHttpClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly profile: ResolvedCliProfile,
    options: { readonly fetchImpl?: FetchLike } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async requestJson<T>(
    request: RemoteHttpRequest,
    options: CliFacadeRequestOptions,
  ): Promise<T> {
    const response = await this.request(request, options);
    if (response.status < HTTP_STATUS_OK_MIN || response.status >= HTTP_STATUS_REDIRECT_MIN) {
      throw CliError.execution(
        `Remote request failed with HTTP ${String(response.status)} ${response.statusText}: ${response.rawText.slice(0, ERROR_BODY_PREVIEW_MAX_CHARS)}`,
      );
    }
    return response.body as T;
  }

  async request(
    request: RemoteHttpRequest,
    options: CliFacadeRequestOptions,
  ): Promise<RemoteHttpResponse> {
    const baseUrl = this.profile.baseUrl?.trim();
    if (baseUrl === undefined || baseUrl.length === 0) {
      throw CliError.usage('Remote target requires --base-url or WINE_CLI_BASE_URL');
    }

    const url = new URL(request.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const headers = new Headers();
    headers.set('accept', 'application/json');
    headers.set('x-request-id', options.requestId);

    if (this.profile.authMode === 'bearer') {
      const bearerToken = this.profile.bearerToken?.trim();
      if (bearerToken === undefined || bearerToken.length === 0) {
        throw CliError.usage(
          'auth-mode=bearer requires --bearer-token or WINE_CLI_BEARER_TOKEN',
        );
      }
      headers.set('authorization', `Bearer ${bearerToken}`);
    }

    for (const [name, value] of Object.entries(request.headers ?? {})) {
      headers.set(name, value);
    }

    let body: RequestInit['body'];
    if (request.rawBody !== undefined) {
      body = request.rawBody;
    } else if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }

    const response = await this.fetchImpl(url.toString(), {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(options.abortSignal !== undefined ? { signal: options.abortSignal } : {}),
    });
    const rawText = await response.text();
    let parsedBody: unknown = rawText;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && rawText.length > 0) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch (error) {
        throw CliError.execution(
          `Remote response from ${url.pathname} declared JSON but could not be parsed`,
          { cause: error },
        );
      }
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: toHeaderRecord(response.headers),
      body: parsedBody,
      rawText,
    };
  }
}
