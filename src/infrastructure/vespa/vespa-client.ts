/**
 * Low-level Vespa HTTP client.
 *
 * Wraps the Vespa HTTP/JSON Search API and Document v1 API.
 * Uses native `fetch` — no external SDK dependency.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single hit returned by the Vespa query API. */
export interface VespaHit {
  readonly id: string;
  readonly relevance: number;
  readonly source: string;
  readonly fields: Record<string, unknown>;
}

/** Top-level response envelope from the Vespa query API. */
export interface VespaQueryResponse {
  readonly root: {
    readonly id: string;
    readonly relevance: number;
    readonly fields?: { readonly totalCount: number };
    readonly children?: readonly VespaHit[];
  };
}

/** Summary of a bulk-feed operation. */
export interface BulkFeedResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that an unknown value is a plain object (i.e. a `Record`).
 */
function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Vespa: expected object for ${label}, got ${typeof value}`);
  }
}

/**
 * Attempts to extract a human-readable error message from an unknown body.
 */
function extractErrorMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b['message'] === 'string') return b['message'];
    if (typeof b['error'] === 'string') return b['error'];
    return JSON.stringify(b);
  }
  return String(body);
}

// ---------------------------------------------------------------------------
// VespaClient
// ---------------------------------------------------------------------------

/**
 * Low-level client for the Vespa search engine.
 *
 * All methods use the native `fetch` API and throw descriptive errors that
 * include the HTTP status code on failure.
 */
export class VespaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly namespace: string,
    private readonly appName: string,
  ) {}

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Wraps `fetch` with an AbortController-based timeout.
   * The request is aborted and an error thrown if it takes longer than
   * `timeoutMs` milliseconds.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Executes a YQL query against the Vespa search API.
   *
   * @param yql - The YQL query string.
   * @param params - Additional query parameters merged into the request body.
   * @returns The parsed Vespa query response.
   * @throws {Error} On non-2xx HTTP status or malformed response.
   */
  async query(
    yql: string,
    params?: Record<string, unknown>,
  ): Promise<VespaQueryResponse> {
    const url = `${this.baseUrl}/search/`;
    const body: Record<string, unknown> = { yql, ...params };

    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      30_000,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Vespa query failed [HTTP ${response.status}]: ${text}`,
      );
    }

    const data: unknown = await response.json();
    assertObject(data, 'query response');

    // Minimal structural validation before casting.
    if (!('root' in data)) {
      throw new Error('Vespa: query response missing "root" field');
    }

    return data as unknown as VespaQueryResponse;
  }

  // -------------------------------------------------------------------------
  // Document v1 API — helpers
  // -------------------------------------------------------------------------

  /**
   * Builds a Document v1 URL for the given document ID.
   * Format: /document/v1/{namespace}/{docType}/docid/{docId}
   */
  private docUrl(docType: string, docId: string): string {
    return `${this.baseUrl}/document/v1/${this.namespace}/${docType}/docid/${encodeURIComponent(docId)}`;
  }

  /**
   * Shared logic for PUT / UPDATE operations.
   */
  private async sendDocumentRequest(
    method: 'PUT' | 'POST',
    url: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(
      url,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: payload }),
      },
      15_000,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Vespa document ${method} failed [HTTP ${response.status}]: ${text}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Document v1 API — public operations
  // -------------------------------------------------------------------------

  /**
   * Inserts or replaces a document in the index.
   *
   * Vespa `/document/v1` uses **POST** for full-document writes and **PUT** for partial
   * updates (`assign` / etc.). See document-v1 API guide.
   *
   * @param docId - The document identifier (used as the docid path segment).
   * @param fields - The document fields to store.
   * @throws {Error} On non-2xx HTTP status.
   */
  async put(docId: string, fields: Record<string, unknown>): Promise<void> {
    const url = this.docUrl(this.appName, docId);
    await this.sendDocumentRequest('POST', url, fields);
  }

  /**
   * Partially updates an existing document.
   *
   * @param docId - The document identifier.
   * @param fields - The fields to update (partial update semantics).
   * @throws {Error} On non-2xx HTTP status.
   */
  async update(docId: string, fields: Record<string, unknown>): Promise<void> {
    // Vespa partial update uses PUT with "update" path or POST with field updates.
    // We use the Document v1 UPDATE endpoint (PUT to the same URL with assign actions).
    const url = `${this.docUrl(this.appName, docId)}`;
    // Build assign update map
    const assignFields: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(fields)) {
      assignFields[key] = { assign: value };
    }
    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: assignFields }),
      },
      15_000,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Vespa document UPDATE failed [HTTP ${response.status}]: ${text}`,
      );
    }
  }

  /**
   * Deletes a document from the index.
   *
   * @param docId - The document identifier.
   * @throws {Error} On non-2xx HTTP status (404 is tolerated as a no-op).
   */
  async delete(docId: string): Promise<void> {
    const url = this.docUrl(this.appName, docId);
    const response = await this.fetchWithTimeout(url, { method: 'DELETE' }, 10_000);

    // 404 is acceptable — the document simply did not exist.
    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Vespa document DELETE failed [HTTP ${response.status}]: ${text}`,
      );
    }
  }

  /**
   * Retrieves a single document by its identifier.
   *
   * @param docId - The document identifier.
   * @returns The document fields, or `null` if the document was not found.
   * @throws {Error} On non-2xx / non-404 HTTP status.
   */
  async get(docId: string): Promise<Record<string, unknown> | null> {
    const url = this.docUrl(this.appName, docId);
    const response = await this.fetchWithTimeout(url, {}, 10_000);

    if (response.status === 404) return null;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Vespa document GET failed [HTTP ${response.status}]: ${text}`,
      );
    }

    const data: unknown = await response.json();
    assertObject(data, 'document GET response');

    const fields = data['fields'];
    if (fields === undefined || fields === null) return {};
    assertObject(fields, 'document fields');
    return fields;
  }

  /**
   * Feeds multiple documents to Vespa in a single batched sequence of PUT
   * requests. Failures are collected and returned rather than thrown, so
   * partial success is possible.
   *
   * @param docs - Array of `{ id, fields }` pairs to feed.
   * @returns A summary of successes, failures, and error messages.
   */
  async bulkFeed(
    docs: Array<{ id: string; fields: Record<string, unknown> }>,
  ): Promise<BulkFeedResult> {
    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];

    const results = await Promise.allSettled(
      docs.map((doc) => this.put(doc.id, doc.fields)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result === undefined) continue;
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failureCount++;
        const docId = docs[i]?.id ?? `index:${i}`;
        errors.push(
          `doc[${docId}]: ${extractErrorMessage(result.reason)}`,
        );
      }
    }

    return { successCount, failureCount, errors };
  }
}
