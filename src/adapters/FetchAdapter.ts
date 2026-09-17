import { classifyStatusError, classifyThrownError, parseRetryAfter } from '../errors/ErrorClassifier';
import type { HttpMethod } from '../types';

export interface FetchAdapterRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  data?: unknown;
  /** Request timeout in milliseconds. Default: 15000. */
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

const DEFAULT_TIMEOUT_MS = 15000;
const BODYLESS_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];

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

    const headers: Record<string, string> = { ...request.headers };
    if (request.idempotencyKey && !this.hasHeader(headers, 'Idempotency-Key')) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }

    let body: string | undefined;
    if (request.data !== undefined && !BODYLESS_METHODS.includes(request.method)) {
      body = typeof request.data === 'string' ? request.data : JSON.stringify(request.data);
      if (!this.hasHeader(headers, 'Content-Type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw classifyThrownError(error, { wasTimeout: timedOut });
    } finally {
      clearTimeout(timeoutHandle);
      if (onExternalAbort) {
        request.signal?.removeEventListener('abort', onExternalAbort);
      }
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      throw classifyStatusError(response.status, {
        retryOnStatusCodes: request.retryOnStatusCodes,
        retryAfterMs: retryAfterMs ?? undefined,
        statusText: response.statusText,
      });
    }

    const data = await this.parseBody<T>(response);

    return {
      status: response.status,
      headers: responseHeaders,
      data,
    };
  }

  private hasHeader(headers: Record<string, string>, name: string): boolean {
    const lower = name.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === lower);
  }

  private async parseBody<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }

    const text = await response.text();
    return text as unknown as T;
  }
}
