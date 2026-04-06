export interface HttpRequestIdCarrier {
  readonly id: string;
  readonly requestId?: string;
}

export function getRequestId(request: HttpRequestIdCarrier): string {
  return request.requestId ?? request.id;
}

export function resolveRequestId(
  request: HttpRequestIdCarrier,
  explicitRequestId?: string | null,
): string {
  const trimmed = explicitRequestId?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : getRequestId(request);
}
