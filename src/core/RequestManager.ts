import type { FetchAdapterResponse, RequestSender } from '../adapters/FetchAdapter';
import { classifyThrownError } from '../errors/ErrorClassifier';
import type { RetryError } from '../errors/RetryError';
import type { RetryEngine } from '../retry/RetryEngine';
import type { RetryPolicy } from '../retry/RetryPolicy';
import type { RetryInfo, SmartRetryRequestOptions } from '../types';
import { generateRequestId } from '../utils/id';

export interface RequestManagerDependencies {
  send: RequestSender;
  retryEngine: RetryEngine;
  getDefaultTimeout: () => number;
  onRetry?: (info: RetryInfo) => void;
}

export type RequestExecutionResult<T> =
  { ok: true; response: FetchAdapterResponse<T> } | { ok: false; error: RetryError };

/**
 * Executes a single immediate (non-queued) request, applying in-process
 * retry-with-backoff for transient failures via the RetryEngine. Never touches
 * the persistent queue — that decision is made by the caller based on the
 * final result.
 */
export class RequestManager {
  private readonly send: RequestSender;
  private readonly retryEngine: RetryEngine;
  private readonly getDefaultTimeout: () => number;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;

  constructor(deps: RequestManagerDependencies) {
    this.send = deps.send;
    this.retryEngine = deps.retryEngine;
    this.getDefaultTimeout = deps.getDefaultTimeout;
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
          this.send<T>({
            url: options.url,
            method: options.method,
            headers: options.headers,
            data: options.data,
            timeout: options.timeout ?? this.getDefaultTimeout(),
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
      return { ok: false, error: classifyThrownError(rawError) };
    }
  }
}
