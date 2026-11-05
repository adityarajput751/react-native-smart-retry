import { classifyStatusError, classifyThrownError, parseRetryAfter } from '../errors/ErrorClassifier';
import type { HttpMethod } from '../types';
import { isBinaryBody } from '../utils/body';

export interface FetchAdapterRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  data?: unknown;
  /** Request timeout in milliseconds, covering the response body too. Default: 15000. */
  timeout?: number;
  /** Sent as an `Idempotency-Key` header when provided and not already set in `headers`. */
  idempotencyKey?: string;
  /** External abort signal (e.g. caller cancellation) composed with the internal timeout controller. */
  signal?: AbortSignal;
  retryOnStatusCodes?: number[];
}

export interface FetchAdapterResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

/** Sends one HTTP attempt. Implemented by {@link FetchAdapter} and wrapped by the client for auth hooks. */
export type RequestSender = <T = unknown>(request: FetchAdapterRequest) => Promise<FetchAdapterResponse<T>>;

const DEFAULT_TIMEOUT_MS = 15000;
const BODYLESS_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];
const SAFE_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Executes HTTP requests using the platform's global `fetch`. Kept as a thin,
 * swappable adapter so the core request/queue/retry logic never depends on
 * fetch directly.
 */
export class FetchAdapter {
  async execute<T = unknown>(request: FetchAdapterRequest): Promise<FetchAdapterResponse<T>> {
    const controller = new AbortController();
    const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let onExternalAbort: (() => void) | undefined;
    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        onExternalAbort = () => controller.abort();
        request.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      const { body, headers } = this.buildBody(request);
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body,
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        const data = await this.parseBody(response).catch(() => undefined);
        throw classifyStatusError(response.status, {
          retryOnStatusCodes: request.retryOnStatusCodes,
          retryAfterMs: retryAfterMs ?? undefined,
          statusText: response.statusText,
          data,
        });
      }

      return {
        status: response.status,
        headers: responseHeaders,
        data: await this.parseSuccessBody<T>(response, request.method),
      };
    } catch (error) {
      throw classifyThrownError(error, { wasTimeout: timedOut });
    } finally {
      clearTimeout(timeoutHandle);
      if (onExternalAbort) {
        request.signal?.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  private buildBody(request: FetchAdapterRequest): {
    body: BodyInit | undefined;
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = { ...request.headers };
    if (request.idempotencyKey && !this.hasHeader(headers, 'Idempotency-Key')) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }

    if (request.data === undefined || BODYLESS_METHODS.includes(request.method)) {
      return { body: undefined, headers };
    }

    // `fetch` sets the right Content-Type (including the multipart boundary) itself.
    if (isBinaryBody(request.data)) {
      return { body: request.data, headers };
    }

    if (!this.hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    const body = typeof request.data === 'string' ? request.data : JSON.stringify(request.data);
    return { body, headers };
  }

  private hasHeader(headers: Record<string, string>, name: string): boolean {
    const lower = name.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === lower);
  }

  /**
   * The server has already accepted a 2xx, so a body problem must never turn it
   * into a failure that gets replayed. The exception is a safe method whose
   * body was lost in transit: the caller needs that data and retrying is harmless.
   */
  private async parseSuccessBody<T>(response: Response, method: HttpMethod): Promise<T> {
    try {
      return (await this.parseBody(response)) as T;
    } catch (error) {
      if (SAFE_METHODS.includes(method)) {
        throw error;
      }
      return undefined as T;
    }
  }

  /** Returns the parsed body: JSON when it parses as such, else text, or undefined when empty. */
  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === '') {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (/[/+]json\b/i.test(contentType)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }
}
