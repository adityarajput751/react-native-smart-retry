import type { FetchAdapter, FetchAdapterResponse } from '../adapters/FetchAdapter';
import { classifyThrownError } from '../errors/ErrorClassifier';
import { RetryError } from '../errors/RetryError';
import type { RetryEngine } from '../retry/RetryEngine';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { RetryInfo, SmartRetryRequestOptions } from '../types';
import { generateRequestId } from '../utils/id';

export interface RequestManagerDependencies {
  fetchAdapter: FetchAdapter;
  retryEngine: RetryEngine;
  onRetry?: (info: RetryInfo) => void;
}

export type RequestExecutionResult<T> =
  { ok: true; response: FetchAdapterResponse<T> } | { ok: false; error: RetryError };

/**
 * Executes a single immediate (non-queued) request, applying in-process
 * retry-with-backoff for transient failures (network blips, timeouts,
 * retryable server errors) via the RetryEngine. Never touches the persistent
 * queue — that decision is made by the caller based on the final result.
 */
export class RequestManager {
  private readonly fetchAdapter: FetchAdapter;
  private readonly retryEngine: RetryEngine;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;

  constructor(deps: RequestManagerDependencies) {
    this.fetchAdapter = deps.fetchAdapter;
    this.retryEngine = deps.retryEngine;
    this.onRetry = deps.onRetry;
  }

  async execute<T = unknown>(
    options: SmartRetryRequestOptions,
    policy: RetryPolicy
  ): Promise<RequestExecutionResult<T>> {
    const requestId = generateRequestId();

    try {
      const response = await this.retryEngine.executeWithRetry<FetchAdapterResponse<T>>(
        () =>
          this.fetchAdapter.execute<T>({
            url: options.url,
            method: options.method,
            headers: options.headers,
            data: options.data,
            timeout: options.timeout,
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
            retryOnStatusCodes: policy.retryOnStatusCodes,
          }),
        {
          requestId,
          method: options.method,
          policy,
          signal: options.signal,
          onRetry: this.onRetry,
          retryConnectivityErrors: false,
        }
      );
      return { ok: true, response };
    } catch (rawError) {
      const error = rawError instanceof RetryError ? rawError : classifyThrownError(rawError);
      return { ok: false, error };
    }
  }
}
