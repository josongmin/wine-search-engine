import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import type {
  OpenApiDocumentResult,
  RawApiCallInput,
  RawApiCallResult,
} from '../../../application/cli/dto/raw-api.dto.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type { RawApiInvokerPort } from '../../../application/cli/port/raw-api-invoker.port.js';
import { RemoteHttpClient } from './remote-http-client.js';

function toHeaderRecord(
  headers: readonly { readonly name: string; readonly value: string }[] | undefined,
  contentType: string | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers ?? []) {
    record[header.name] = header.value;
  }
  if (contentType !== undefined && record['content-type'] === undefined && record['Content-Type'] === undefined) {
    record['content-type'] = contentType;
  }
  return record;
}

function appendQueryParams(path: string, query: readonly { readonly name: string; readonly value: string }[] | undefined): string {
  if (query === undefined || query.length === 0) {
    return path;
  }
  const url = new URL(path, 'http://local.invalid');
  for (const entry of query) {
    url.searchParams.append(entry.name, entry.value);
  }
  return `${url.pathname}${url.search}`;
}

export class RemoteRawApiInvoker implements RawApiInvokerPort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  async call(input: RawApiCallInput, options: CliFacadeRequestOptions): Promise<RawApiCallResult> {
    const response = await this.http.request(
      {
        method: input.method.toUpperCase(),
        path: appendQueryParams(input.path, input.query),
        rawBody: input.bodyText,
        headers: toHeaderRecord(input.headers, input.contentType),
      },
      options,
    );
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      ...(response.rawText.length > 0 ? { rawText: response.rawText } : {}),
    };
  }

  async openApi(options: CliFacadeRequestOptions): Promise<OpenApiDocumentResult> {
    const response = await this.http.requestJson<unknown>(
      {
        method: 'GET',
        path: '/openapi.json',
      },
      options,
    );
    return {
      path: '/openapi.json',
      document: response,
    };
  }
}
